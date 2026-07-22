const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');
const {
    buildBrowserLaunchOptions,
    classifyProxyResponse,
    classifyProxyError,
    mergeExitCode,
    validateUsersConfig,
    safeAccountLabel,
    finalizeAccountResources
} = require('./lib/runtime_helpers');
const { sendTelegramNotification } = require('./lib/telegram');

const MANAGED_BY_PROXY_RUNNER = process.env.KATABUMP_MANAGED_BY_PROXY_RUNNER === '1';
const RESULT_FILE = process.env.KATABUMP_RESULT_FILE || '';

// --- 退出码（供外层 proxy_runner.js 使用） ---
const EXIT_CODE = {
    SUCCESS: 0,
    FATAL: 1,
    PROXY_RETRY: 42,      // Turnstile 3次仍失败 → 外层换代理，不与其他退出码冲突
    RENEW_CAPTCHA_FAILED: 43, // Renew ALTCHA 失败，不换代理但也不返回成功
    NOT_READY: 3,         // 还没到续期窗口
    ALREADY_RENEWED: 4,   // Expiry 未变化，本轮已是最新
    LOGIN_FAILED: 5       // 账号或密码错误
};

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
let latestActionResult = null;
let latestDebugSnapshot = { screenshotPath: null, htmlPath: null };

// --- 辅助函数：发送 Telegram ---
async function sendTelegramMessage(message, imagePath = null) {
    return sendTelegramNotification({
        axios,
        FormData,
        fs,
        token: TG_BOT_TOKEN,
        chatId: TG_CHAT_ID,
        message,
        imagePath,
        logger: console
    });
}

function setLatestActionResult({ exitCode, status, message = '', screenshotPath = null, htmlPath = null, accounts = [] }) {
    latestActionResult = {
        exitCode,
        status,
        message,
        screenshotPath,
        htmlPath,
        accounts,
        timestamp: new Date().toISOString()
    };
}

function writeActionResult(exitCode) {
    if (!RESULT_FILE) return;
    const result = latestActionResult || {
        exitCode,
        status: exitCode === EXIT_CODE.PROXY_RETRY ? 'proxy_retry' : 'error',
        message: 'action_renew.js finished without a structured result',
        screenshotPath: null,
        htmlPath: null,
        accounts: [],
        timestamp: new Date().toISOString()
    };
    result.exitCode = exitCode;
    result.timestamp = new Date().toISOString();
    try {
        fs.mkdirSync(path.dirname(RESULT_FILE), { recursive: true });
        fs.writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2), 'utf-8');
        console.log(`[结果] 本次代理尝试结果已写入: ${RESULT_FILE}`);
    } catch (error) {
        console.error('[结果] 结构化结果写入失败:', error.message);
    }
}

chromium.use(stealth);

const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome';
process.env.NO_PROXY = 'localhost,127.0.0.1';

const HTTP_PROXY = process.env.HTTP_PROXY;
const TARGET_LOGIN_URL = 'https://dashboard.katabump.com/auth/login';
const CHROME_BOOT_TIMEOUT_MS = 20_000;
const CDP_CONNECT_ATTEMPTS = 5;
const CDP_CONNECT_DELAY_MS = 2_000;
let PROXY_CONFIG = null;
let PROXY_CONFIG_ERROR = null;
let DEBUG_PORT = null;
let activeBrowserConnection = null;
let activeCdpAnchorPage = null;
let activeChromeChild = null;
let activeChromeUserDataDir = null;
let shutdownRequested = false;
let shutdownPromise = null;

if (HTTP_PROXY) {
    try {
        const proxyUrl = new URL(HTTP_PROXY);
        const proxyPort = proxyUrl.port || (proxyUrl.protocol === 'http:' ? '80' : '');
        PROXY_CONFIG = {
            server: `${proxyUrl.protocol}//${proxyUrl.hostname}:${proxyPort}`,
            host: proxyUrl.hostname,
            port: proxyPort,
            username: proxyUrl.username ? decodeURIComponent(proxyUrl.username) : undefined,
            password: proxyUrl.password ? decodeURIComponent(proxyUrl.password) : undefined
        };
        console.log(`[代理] 检测到配置: 服务器=${PROXY_CONFIG.server}, 认证=${PROXY_CONFIG.username ? '是' : '否'}`);
    } catch (e) {
        console.error('[代理] HTTP_PROXY 格式无效。');
        PROXY_CONFIG_ERROR = e;
    }
}

// --- 注入脚本：Hook Shadow DOM 获取 Turnstile/ALTCHA checkbox 坐标 ---
const INJECTED_SCRIPT = `
(function() {
    if (window.self === window.top) return;
    try {
        function getRandomInt(min, max) {
            return Math.floor(Math.random() * (max - min + 1)) + min;
        }
        let screenX = getRandomInt(800, 1200);
        let screenY = getRandomInt(400, 600);
        Object.defineProperty(MouseEvent.prototype, 'screenX', { value: screenX });
        Object.defineProperty(MouseEvent.prototype, 'screenY', { value: screenY });
    } catch (e) { }

    try {
        const originalAttachShadow = Element.prototype.attachShadow;
        Element.prototype.attachShadow = function(init) {
            const shadowRoot = originalAttachShadow.call(this, init);
            if (shadowRoot) {
                const checkAndReport = () => {
                    const checkbox = shadowRoot.querySelector('input[type="checkbox"]');
                    if (checkbox) {
                        const rect = checkbox.getBoundingClientRect();
                        if (rect.width > 0 && rect.height > 0 && window.innerWidth > 0 && window.innerHeight > 0) {
                            const xRatio = (rect.left + rect.width / 2) / window.innerWidth;
                            const yRatio = (rect.top + rect.height / 2) / window.innerHeight;
                            window.__turnstile_data = { xRatio, yRatio };
                            return true;
                        }
                    }
                    return false;
                };
                if (!checkAndReport()) {
                    const observer = new MutationObserver(() => {
                        if (checkAndReport()) observer.disconnect();
                    });
                    observer.observe(shadowRoot, { childList: true, subtree: true });
                }
            }
            return shadowRoot;
        };
    } catch (e) {
        console.error('[注入] Hook attachShadow 失败:', e);
    }
})();
`;

async function checkProxy() {
    if (!PROXY_CONFIG) return { ok: true, reachable: true, status: null, category: 'no_proxy', error: null };
    console.log('[代理] 正在验证代理连接...');
    try {
        const axiosConfig = {
            proxy: {
                protocol: 'http',
                host: PROXY_CONFIG.host,
                port: Number(PROXY_CONFIG.port),
            },
            timeout: 10000
        };
        if (PROXY_CONFIG.username && PROXY_CONFIG.password) {
            axiosConfig.proxy.auth = {
                username: PROXY_CONFIG.username,
                password: PROXY_CONFIG.password
            };
        }
        const response = await axios.get(TARGET_LOGIN_URL, axiosConfig);
        const result = classifyProxyResponse(response.status);
        console.log(`[代理] 目标页面响应：HTTP ${response.status}，分类=${result.category}`);
        return result;
    } catch (error) {
        const result = error.response && error.response.status
            ? classifyProxyResponse(error.response.status)
            : classifyProxyError(error);
        console.error(`[代理] 预检失败：分类=${result.category}，错误=${result.error || 'none'}`);
        return result;
    }
}

function getAvailableDebugPort() {
    return new Promise((resolve, reject) => {
        const server = require('net').createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            const port = address && typeof address === 'object' ? address.port : null;
            server.close((error) => error ? reject(error) : resolve(port));
        });
    });
}

function checkPort(port) {
    return new Promise((resolve) => {
        const request = http.get(`http://127.0.0.1:${port}/json/version`, (response) => {
            response.resume();
            resolve(Boolean(response.statusCode));
        });
        request.setTimeout(1000, () => {
            request.destroy();
            resolve(false);
        });
        request.on('error', () => resolve(false));
    });
}

function waitForChromePort(port, timeoutMs = CHROME_BOOT_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    return (async () => {
        while (Date.now() < deadline) {
            if (await checkPort(port)) return true;
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        return false;
    })();
}

async function launchChrome() {
    DEBUG_PORT = await getAvailableDebugPort();
    activeChromeUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `katabump-chrome-${process.pid}-`));
    console.log(`检查 Chrome 调试端口 ${DEBUG_PORT}...`);

    const launchOptions = buildBrowserLaunchOptions(PROXY_CONFIG);
    const args = [
        ...launchOptions.args,
        `--remote-debugging-port=${DEBUG_PORT}`,
        `--user-data-dir=${activeChromeUserDataDir}`
    ];
    if (PROXY_CONFIG) {
        args.push(`--proxy-server=${PROXY_CONFIG.server}`);
        args.push('--proxy-bypass-list=<-loopback>');
    }

    console.log(`正在启动 Chrome (路径: ${CHROME_PATH})...`);
    activeChromeChild = spawn(CHROME_PATH, args, {
        detached: false,
        stdio: 'ignore'
    });

    try {
        await new Promise((resolve, reject) => {
            activeChromeChild.once('error', reject);
            if (activeChromeChild.exitCode !== null) {
                reject(new Error(`Chrome exited with code ${activeChromeChild.exitCode}`));
            } else {
                resolve();
            }
        });
    } catch (error) {
        await closeActiveChrome();
        throw new Error(`Chrome 启动失败: ${error.message}`);
    }

    console.log('正在等待 Chrome 初始化...');
    if (!await waitForChromePort(DEBUG_PORT)) {
        await closeActiveChrome();
        throw new Error(`Chrome 调试端口 ${DEBUG_PORT} 未在 ${CHROME_BOOT_TIMEOUT_MS}ms 内就绪`);
    }
}

async function connectToChrome() {
    if (!DEBUG_PORT) throw new Error('Chrome 调试端口未初始化');
    console.log('正在连接 Chrome...');
    let lastError = null;
    for (let attempt = 1; attempt <= CDP_CONNECT_ATTEMPTS; attempt++) {
        try {
            activeBrowserConnection = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`);
            console.log('连接成功！');
            return activeBrowserConnection;
        } catch (error) {
            lastError = error;
            console.error(`连接尝试 ${attempt}/${CDP_CONNECT_ATTEMPTS} 失败`);
            if (attempt < CDP_CONNECT_ATTEMPTS) {
                await new Promise(resolve => setTimeout(resolve, CDP_CONNECT_DELAY_MS));
            }
        }
    }
    throw new Error(`CDP 连接失败: ${lastError ? lastError.message : 'unknown error'}`);
}

async function ensureCdpAnchorPage(browser) {
    const contexts = browser.contexts();
    const context = contexts[0];
    if (!context) throw new Error('CDP 浏览器没有可用的默认 BrowserContext');

    if (!activeCdpAnchorPage || activeCdpAnchorPage.isClosed()) {
        const existingPages = context.pages();
        activeCdpAnchorPage = existingPages[0] || await context.newPage();
        await activeCdpAnchorPage.goto('about:blank').catch(() => {});
    }

    return { context, page: activeCdpAnchorPage };
}

async function prepareCdpAccountPage(browser) {
    const { context } = await ensureCdpAnchorPage(browser);
    await context.clearCookies();

    // 先创建账号页，确保 Chrome 始终保留 anchor page，不关闭最后一个窗口。
    const page = await context.newPage();

    // 清理上一个账号或异常流程遗留的页面，但保留 anchor 和当前账号页。
    for (const existingPage of context.pages()) {
        if (existingPage !== activeCdpAnchorPage && existingPage !== page) {
            await existingPage.close().catch(() => {});
        }
    }

    if (PROXY_CONFIG && PROXY_CONFIG.username && PROXY_CONFIG.password && typeof context.setHTTPCredentials === 'function') {
        await context.setHTTPCredentials({
            username: PROXY_CONFIG.username,
            password: PROXY_CONFIG.password
        });
    }
    page.setDefaultTimeout(60000);
    await page.addInitScript(INJECTED_SCRIPT);
    return { context, page };
}

async function closeActiveChrome() {
    const chrome = activeChromeChild;
    const userDataDir = activeChromeUserDataDir;
    activeChromeChild = null;
    activeChromeUserDataDir = null;

    if (chrome && chrome.exitCode === null) {
        try { chrome.kill('SIGTERM'); } catch (error) { }
        await new Promise(resolve => {
            let settled = false;
            const finish = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve();
            };
            const timer = setTimeout(finish, 3000);
            chrome.once('exit', finish);
            chrome.once('error', finish);
        });
        if (chrome.exitCode === null) {
            try { chrome.kill('SIGKILL'); } catch (error) { }
        }
    }

    if (userDataDir) {
        try {
            fs.rmSync(userDataDir, { recursive: true, force: true });
        } catch (error) {
            console.error('[cleanup] Chrome user-data-dir 清理失败:', error.message);
        }
    }
}

// --- 找到 Cloudflare Turnstile challenge frames（每次调用都重新扫描 page.frames，不缓存旧 frame） ---
function findChallengeFrames(page) {
    return page.frames().filter((f) => {
        try {
            const u = f.url() || '';
            return /challenges\.cloudflare\.com|turnstile/i.test(u);
        } catch (e) {
            return false;
        }
    });
}

// --- 校验 box 是否真实可点：非 null、非 1x1、在视口内、有足够尺寸 ---
function isValidClickBox(box, viewport) {
    if (!box) return false;
    if (!(box.width >= 20 && box.height >= 15)) return false;
    // 排除 1x1 / 极小
    if (box.width <= 5 || box.height <= 5) return false;
    // 在视口内（允许少量溢出）
    if (viewport) {
        if (box.x + box.width < 0 || box.y + box.height < 0) return false;
        if (box.x > viewport.width || box.y > viewport.height) return false;
    }
    return true;
}

// --- 获取 challenge frame 的页面坐标 bounding box ---
// 必须：await frame.frameElement() → boundingBox()；frame 本身没有页面坐标
// 每次调用重新 findChallengeFrames，不复用旧 frame
async function getChallengeFrameBox(page) {
    const frames = findChallengeFrames(page); // 每次刷新后必须重新获取
    console.log(`[登录阶段] challenge frame 扫描: 找到 ${frames.length} 个`);

    let viewport = null;
    try {
        viewport = page.viewportSize() || await page.evaluate(() => ({
            width: window.innerWidth,
            height: window.innerHeight
        }));
    } catch (e) {
        viewport = { width: 1280, height: 720 };
    }

    for (const frame of frames) {
        try {
            const el = await frame.frameElement(); // 关键：通过 frameElement 取页面坐标
            if (!el) continue;
            const box = await el.boundingBox();
            if (isValidClickBox(box, viewport)) {
                console.log(`[登录阶段] challenge frame 已找到 url=${(frame.url() || '').substring(0, 90)}`);
                return { frame, box, url: frame.url(), source: 'frameElement' };
            }
            if (box) {
                console.log(`[登录阶段] challenge frame box 无效: w=${box.width} h=${box.height} x=${box.x} y=${box.y}`);
            }
        } catch (e) {
            console.log(`[登录阶段] frame.frameElement/boundingBox 失败: ${e.message}`);
        }
    }

    // fallback: .cf-turnstile 容器（仅当 frame box 不可用时）
    try {
        const widget = page.locator('.cf-turnstile, [data-sitekey], #cf-turnstile').first();
        if (await widget.isVisible({ timeout: 1000 }).catch(() => false)) {
            const box = await widget.boundingBox();
            if (isValidClickBox(box, viewport)) {
                console.log('[登录阶段] 使用 .cf-turnstile 容器 box 作为点击目标');
                return {
                    frame: frames[0] || null,
                    box,
                    url: frames[0] ? frames[0].url() : 'widget-container',
                    source: 'widget-container'
                };
            }
        }
    } catch (e) { }

    console.log('[登录阶段] challenge box 未取到有效目标（null / 1x1 / 超出视口）');
    return null;
}

// --- CDP 在指定坐标点击；成功返回 true ---
async function cdpClickAt(page, x, y, label = '') {
    console.log(`>> CDP 点击 ${label} 坐标=(${x.toFixed(1)}, ${y.toFixed(1)})`);
    const client = await page.context().newCDPSession(page);
    try {
        await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
        await new Promise(r => setTimeout(r, 60 + Math.random() * 100));
        await client.send('Input.dispatchMouseEvent', {
            type: 'mousePressed', x, y, button: 'left', clickCount: 1
        });
        await new Promise(r => setTimeout(r, 40 + Math.random() * 80));
        await client.send('Input.dispatchMouseEvent', {
            type: 'mouseReleased', x, y, button: 'left', clickCount: 1
        });
        return true;
    } catch (e) {
        console.log(`>> CDP 点击失败 ${label}: ${e.message}`);
        return false;
    } finally {
        await client.detach().catch(() => { });
    }
}

// --- 单次点击 challenge checkbox（一轮只点一次，不轮询多点/多策略） ---
// 返回 { sent: boolean, x, y, urlBefore }
async function attemptTurnstileSingleClick(page) {
    const target = await getChallengeFrameBox(page);
    if (!target || !target.box) {
        console.log('[登录阶段] challenge frame box 未找到，无法点击');
        return { sent: false, x: null, y: null, urlBefore: null };
    }
    const { box, url } = target;
    // 固定左侧 checkbox 区域（已验证过的点）
    const x = box.x + 28;
    const y = box.y + box.height / 2;
    console.log(`[登录阶段] challenge frame 已找到`);
    console.log(`[登录阶段] challenge box: x=${box.x.toFixed(1)} y=${box.y.toFixed(1)} w=${box.width.toFixed(1)} h=${box.height.toFixed(1)}`);
    console.log(`[登录阶段] 本轮只点击一次 checkbox: (${x.toFixed(1)}, ${y.toFixed(1)}) url=${(url || '').substring(0, 90)}`);

    try {
        await page.mouse.move(x - 25, y - 12, { steps: 6 });
        await page.waitForTimeout(100 + Math.random() * 100);
        const ok = await cdpClickAt(page, x, y, 'checkbox-left-28');
        console.log(`[登录阶段] 点击事件实际发送=${ok}`);
        return { sent: ok, x, y, urlBefore: url || '' };
    } catch (e) {
        console.log(`[登录阶段] 单次点击失败: ${e.message}`);
        return { sent: false, x, y, urlBefore: url || '' };
    }
}

// --- 兼容旧名：Renew 阶段仍可能调用 ---
async function attemptTurnstileChallengeFrameClick(page) {
    const r = await attemptTurnstileSingleClick(page);
    return { sent: !!r.sent };
}
async function attemptTurnstileCdp(page) {
    const r = await attemptTurnstileSingleClick(page);
    return { sent: !!r.sent };
}
async function attemptTurnstilePlaywrightMouse(page) {
    // 停用多策略，避免干扰；返回未发送
    console.log('[登录阶段] PlaywrightMouse 已停用（一轮只允许一次 ChallengeFrameCDP 点击）');
    return { sent: false };
}
async function attemptTurnstileIframeClick(page) {
    console.log('[登录阶段] IframeClick 已停用（一轮只允许一次 ChallengeFrameCDP 点击）');
    return { sent: false };
}

// --- 点击后独立等待 + 诊断 ---
// 状态切换：click_sent → [click_no_effect | challenge_progress_no_token | turnstile_verification_failed | turnstile_token_ready]
// 检测到 progress 后自动延长等待窗口
// 每次轮询重新查询 DOM（不缓存旧 ElementHandle），记录字段数量、name、value length
// frame 消失时立即检查父页面状态
async function waitAfterTurnstileClick(page, urlBefore, initialTimeoutMs = 15000, progressExtraMs = 12000) {
    const overallStart = Date.now();
    let sawProgress = false;
    let lastFrameUrl = urlBefore || '';
    let progressAt = 0;
    const maxTotal = initialTimeoutMs + progressExtraMs;
    console.log(`[登录阶段] state=click_sent，进入 challenge 处理等待 (初始观察 ${initialTimeoutMs}ms，检测到 progress 额外 ${progressExtraMs}ms)...`);

    // 记录网络错误和 frame 生命周期
    let pageErrors = [];
    let consoleErrors = [];
    let turnstileErrorCode = null;
    const errorHandler = (msg) => {
        if (msg.type() === 'error' || msg.type() === 'warning') {
            consoleErrors.push(msg.text());
            const m = msg.text().match(/\b(600\d{3})\b/);
            if (m) turnstileErrorCode = Number(m[1]);
        }
    };
    const pageErrorHandler = (err) => {
        pageErrors.push(err.message);
        const m = err.message.match(/\b(600\d{3})\b/);
        if (m) turnstileErrorCode = Number(m[1]);
    };
    try {
        page.on('pageerror', pageErrorHandler);
        page.on('console', errorHandler);
    } catch (e) {}

    try {
        while (Date.now() - overallStart < maxTotal) {
            // 超时判断：15s 内无 progress 则退出；有 progress 则允许最多再等 12s
            const elapsedSinceProgress = sawProgress ? (Date.now() - progressAt) : (Date.now() - overallStart - initialTimeoutMs);
            if ((!sawProgress && Date.now() - overallStart > initialTimeoutMs)
                || (sawProgress && elapsedSinceProgress > progressExtraMs)) {
                const reason = sawProgress ? 'progress 后额外等待超时' : '初始等待超时无 progress';
                console.log(`[登录阶段] 等待结束 reason=${reason} sawProgress=${sawProgress}`);
                break;
            }

            // 每次轮询重新 getTurnstileTokenInfo（不缓存旧字段引用）
            const info = await getTurnstileTokenInfo(page);

            if (info.found && info.length > 0) {
                console.log(`[登录阶段] state=turnstile_token_ready，token length=${info.length}`);
                return { state: 'turnstile_token_ready', length: info.length, sawProgress };
            }
            if (info.verificationFailed) {
                console.log('[登录阶段] state=turnstile_verification_failed（点击后明确失败）');
                return { state: 'turnstile_verification_failed', length: 0, sawProgress };
            }

            // 记录 token 字段实时状态（每次重新查询 DOM，不缓存旧 ElementReference）
            // alive 仅当字段仍有 DOM 引用且 length>0 时才为有效
            const fieldSummary = info.fields.map(f => ({ name: f.name, len: f.length }));
            const fieldsWithValue = info.fields.filter(f => f.length > 0).length;

            // frame 状态诊断
            const currentFrames = findChallengeFrames(page);
            const curUrl = currentFrames.length > 0 ? (currentFrames[0].url() || '') : '';
            let detectedProgress = false;

            // URL 变化 → progress
            if (curUrl && lastFrameUrl && curUrl !== lastFrameUrl) {
                const prevTail = lastFrameUrl.split('/').pop() || lastFrameUrl.substring(0, 30);
                const curTail = curUrl.split('/').pop() || curUrl.substring(0, 30);
                const prevHash = lastFrameUrl.split('').reduce((h,c)=>(((h<<5)-h)+c.charCodeAt(0))|0,0).toString(36).substring(0,6);
                const curHash = curUrl.split('').reduce((h,c)=>(((h<<5)-h)+c.charCodeAt(0))|0,0).toString(36).substring(0,6);
                if (!sawProgress) {
                    console.log(`[登录阶段] challenge frame 状态已变化，验证可能正在处理中，继续等待 token。`);
                    console.log(`[登录阶段] prevTail=${prevTail} curTail=${curTail} hash=${prevHash}→${curHash}`);
                }
                detectedProgress = true;
                lastFrameUrl = curUrl;
            }

            // frame 消失 → 立即检查父页面状态
            if (!curUrl && lastFrameUrl) {
                if (!sawProgress) {
                    console.log(`[登录阶段] challenge frame 已消失，检查父页面状态...`);
                    // 父页面检查
                    const parentCheck = await getTurnstileTokenInfo(page);
                    if (parentCheck.found && parentCheck.length > 0) {
                        console.log(`[登录阶段] frame 消失后，父页面 token 已就绪， length=${parentCheck.length}`);
                        return { state: 'turnstile_token_ready', length: parentCheck.length, sawProgress: true };
                    }
                    if (parentCheck.verificationFailed) {
                        console.log('[登录阶段] frame 消失后父页面检测到 Verification failed');
                        return { state: 'turnstile_verification_failed', length: 0, sawProgress: true };
                    }
                    // 检查是否有新的 challenge frame 重建
                    const newFrames = findChallengeFrames(page);
                    if (newFrames.length > 0) {
                        const newUrl = newFrames[0].url() || '';
                        console.log(`[登录阶段] frame 消失后又出现新 challenge frame, url=${newUrl.substring(0, 90)}`);
                        detectedProgress = true;
                        lastFrameUrl = newUrl;
                    } else {
                        // widget DOM 状态
                        console.log(`[登录阶段] frame 消失后父页面状态: tokenFields=${JSON.stringify(parentCheck.fields.map(f => ({ name: f.name, len: f.length })))} widgetVisible=${parentCheck.cfWidgetVisible} verificationFailed=${parentCheck.verificationFailed}`);
                    }
                }
                if (!detectedProgress) {
                    lastFrameUrl = '';
                    detectedProgress = true;
                }
            }

            if (detectedProgress && !sawProgress) {
                sawProgress = true;
                progressAt = Date.now();
                console.log(`[登录阶段] 检测到 progress，延长等待窗口 (+${progressExtraMs}ms)`);
            } else if (detectedProgress && sawProgress) {
                // 同一 progress 窗口内不再反复延长（只在首次设 progressAt）
            }

            if (curUrl) lastFrameUrl = curUrl;

            if (turnstileErrorCode && String(turnstileErrorCode).startsWith('600')) {
                console.log(`[登录阶段] 检测到 Turnstile 错误码 ${turnstileErrorCode}，立即结束等待`);
                break;
            }

            await page.waitForTimeout(500);
        }
    } finally {
        try {
            page.removeListener('pageerror', pageErrorHandler);
            page.removeListener('console', errorHandler);
        } catch (e) {}
    }

    // 终局检查
    const finalInfo = await getTurnstileTokenInfo(page);
    if (finalInfo.found && finalInfo.length > 0) {
        console.log(`[登录阶段] state=turnstile_token_ready，token length=${finalInfo.length}`);
        return { state: 'turnstile_token_ready', length: finalInfo.length, sawProgress };
    }
    if (finalInfo.verificationFailed) {
        console.log('[登录阶段] state=turnstile_verification_failed');
        return { state: 'turnstile_verification_failed', length: 0, sawProgress };
    }
    if (turnstileErrorCode && String(turnstileErrorCode).startsWith('600')) {
        console.log(`[Turnstile FatalError] Error: ${turnstileErrorCode}.`);
        if (pageErrors.length) console.log(`[Turnstile PageError] ${pageErrors.slice(0, 3).join(' | ')}`);
        if (consoleErrors.length) console.log(`[Turnstile Console] ${consoleErrors.slice(0, 3).join(' | ')}`);
        return { state: 'turnstile_adapter_error', length: 0, sawProgress, errorCode: turnstileErrorCode };
    }
    if (pageErrors.length > 0) {
        console.log(`[Turnstile PageError] ${pageErrors.slice(0, 3).join(' | ')}`);
    }
    if (consoleErrors.length > 0) {
        console.log(`[Turnstile Console] ${consoleErrors.slice(0, 3).join(' | ')}`);
    }
    console.log(`[登录阶段] 点击后等待结束。sawProgress=${sawProgress} token length=${finalInfo.length || 0}`);
    // 不再只标 token_missing，区分有无 progress
    const resultState = sawProgress ? 'challenge_progress_no_token' : 'click_no_effect';
    console.log(`[登录阶段] state=${resultState}（progress=${sawProgress} token=${finalInfo.length || 0}）`);
    return { state: resultState, length: 0, sawProgress };
}

// --- 前置观察 auto token（短观察，不是成功条件） ---
// --- 前置观察 auto token（短观察，不是成功条件） ---
async function waitForAutoTurnstileToken(page, timeoutMs = 5000) {
    const startedAt = Date.now();
    console.log(`[登录阶段] auto token 前置观察 (最长 ${timeoutMs}ms)...`);
    while (Date.now() - startedAt < timeoutMs) {
        const info = await getTurnstileTokenInfo(page);
        if (info.found && info.length > 0) {
            console.log(`[登录阶段] auto token 观察结束，token length=${info.length}`);
            return true;
        }
        if (info.verificationFailed) return false;
        await page.waitForTimeout(500);
    }
    const finalInfo = await getTurnstileTokenInfo(page);
    console.log(`[登录阶段] auto token 等待结束，token length=${finalInfo.length || 0}`);
    return !!(finalInfo.found && finalInfo.length > 0);
}

// --- 读取 token / widget 状态（严格健康判断 + 诊断） ---
async function getTurnstileTokenInfo(page) {
    // Playwright 侧：所有 frame URL（比 DOM iframe.src 更可靠）
    let challengeFrameUrls = [];
    try {
        challengeFrameUrls = page.frames()
            .map((f) => f.url())
            .filter((u) => u && u !== 'about:blank' && /challenges\.cloudflare|turnstile|cloudflare\.com\/cdn-cgi/i.test(u));
    } catch (e) { }

    const domInfo = await page.evaluate(() => {
        const selectors = [
            'input[name="cf-turnstile-response"]',
            'textarea[name="cf-turnstile-response"]',
            'input[name="g-recaptcha-response"]',
            'textarea[name="g-recaptcha-response"]',
            '[name="cf-turnstile-response"]',
            '[name="g-recaptcha-response"]'
        ];

        const found = [];
        for (const selector of selectors) {
            document.querySelectorAll(selector).forEach((el) => {
                const value = (el.value || el.getAttribute('value') || '').trim();
                found.push({
                    selector,
                    tag: el.tagName,
                    name: el.getAttribute('name') || '',
                    length: value.length,
                    hasValue: value.length > 0
                });
            });
        }

        // 递归收集 iframe（含 shadowRoot）
        const iframes = [];
        const walk = (root) => {
            if (!root) return;
            try {
                root.querySelectorAll('iframe').forEach((el) => {
                    const rect = el.getBoundingClientRect();
                    iframes.push({
                        src: (el.src || el.getAttribute('src') || '').substring(0, 160),
                        title: el.title || '',
                        w: Math.round(rect.width || el.offsetWidth || 0),
                        h: Math.round(rect.height || el.offsetHeight || 0)
                    });
                });
                root.querySelectorAll('*').forEach((el) => {
                    if (el.shadowRoot) walk(el.shadowRoot);
                });
            } catch (e) { }
        };
        walk(document);

        const widgets = Array.from(document.querySelectorAll('[data-sitekey], .cf-turnstile, #cf-turnstile, [class*="turnstile"]'));
        const widgetInfo = widgets.map((el) => {
            const rect = el.getBoundingClientRect();
            return {
                tag: el.tagName,
                className: String(el.className || ''),
                sitekey: el.getAttribute('data-sitekey') || '',
                hasShadow: !!el.shadowRoot,
                visible: !!(rect.width > 0 && rect.height > 0),
                w: Math.round(rect.width),
                h: Math.round(rect.height),
                childIframes: el.querySelectorAll('iframe').length
            };
        });

        const bodyText = (document.body && document.body.innerText) ? document.body.innerText : '';
        const verificationFailed = /Verification failed/i.test(bodyText)
            || (/Troubleshoot/i.test(bodyText) && /CLOUDFLARE|cloudflare/i.test(bodyText));

        // Turnstile 脚本是否已加载
        const scripts = Array.from(document.querySelectorAll('script[src]')).map((s) => s.src);
        const turnstileScriptLoaded = scripts.some((s) => /challenges\.cloudflare\.com|turnstile/i.test(s));
        const turnstileApi = typeof window.turnstile !== 'undefined';

        const hasResponseField = found.length > 0;
        const cfWidgetVisible = widgetInfo.some((w) =>
            w.visible && (/cf-turnstile/i.test(w.className) || w.sitekey)
        );

        // 健康 iframe：真实尺寸 + 有效 src
        const healthyIframe = iframes.find((f) =>
            f.w >= 50 && f.h >= 20
            && f.src
            && /challenges\.cloudflare|turnstile|cloudflare/i.test(f.src + ' ' + f.title)
        );

        // 死 iframe：1x1 / 空 src 小框
        const deadIframe = !healthyIframe && iframes.some((f) =>
            (f.w <= 5 && f.h <= 5) || (!f.src && f.w <= 30 && f.h <= 30)
        );

        // challenge 未 hydrate：容器在、字段在，但没有健康 iframe
        const challengeNotHydrated = cfWidgetVisible && hasResponseField && !healthyIframe && !verificationFailed;

        const strictlyHealthy = !verificationFailed
            && cfWidgetVisible
            && hasResponseField
            && !!healthyIframe;

        const tokenHit = found.find((f) => f.hasValue);
        return {
            found: !!tokenHit,
            selector: tokenHit ? tokenHit.selector : null,
            length: tokenHit ? tokenHit.length : 0,
            fields: found,
            widgets: widgetInfo,
            iframes,
            verificationFailed,
            hasResponseField,
            cfWidgetVisible,
            healthyIframe: !!healthyIframe,
            deadIframe,
            strictlyHealthy,
            challengeNotHydrated,
            turnstileScriptLoaded,
            turnstileApi,
            scriptCount: scripts.filter((s) => /cloudflare|turnstile/i.test(s)).length
        };
    }).catch(() => ({
        found: false, selector: null, length: 0, fields: [], widgets: [], iframes: [],
        verificationFailed: false, hasResponseField: false, cfWidgetVisible: false,
        healthyIframe: false, deadIframe: false, strictlyHealthy: false,
        challengeNotHydrated: false, turnstileScriptLoaded: false, turnstileApi: false, scriptCount: 0
    }));

    // 若 Playwright 看到真实 challenge frame，也算健康（即使 DOM src 为空）
    if (challengeFrameUrls.length > 0 && !domInfo.healthyIframe) {
        domInfo.healthyIframe = true;
        domInfo.challengeFrameUrls = challengeFrameUrls.map((u) => u.substring(0, 120));
        // 有真实 challenge frame + 可见 widget + 字段 → 可点击
        if (!domInfo.verificationFailed && domInfo.cfWidgetVisible && domInfo.hasResponseField) {
            domInfo.strictlyHealthy = true;
            domInfo.challengeNotHydrated = false;
            domInfo.deadIframe = false;
        }
    } else {
        domInfo.challengeFrameUrls = challengeFrameUrls.map((u) => u.substring(0, 120));
    }

    return domInfo;
}

// --- 清除旧 challenge 点击数据（刷新后必须调用） ---
async function clearStaleTurnstileData(page) {
    try {
        // 主 frame
        await page.evaluate(() => {
            try { delete window.__turnstile_data; } catch (e) {
                try { window.__turnstile_data = undefined; } catch (e2) { }
            }
        }).catch(() => { });
        // 所有子 frame
        for (const frame of page.frames()) {
            if (frame === page.mainFrame()) continue;
            await frame.evaluate(() => {
                try { delete window.__turnstile_data; } catch (e) {
                    try { window.__turnstile_data = undefined; } catch (e2) { }
                }
            }).catch(() => { });
        }
        console.log('[登录阶段] 已清除旧 __turnstile_data。');
    } catch (e) {
        console.log(`[登录阶段] 清除旧 turnstile 数据失败: ${e.message}`);
    }
}

// --- 检测页面是否出现 Cloudflare Verification failed ---
async function isTurnstileVerificationFailed(page) {
    try {
        const text = await page.evaluate(() => (document.body && document.body.innerText) || '');
        if (/Verification failed/i.test(text)) return true;
        if (/Troubleshoot/i.test(text) && /CLOUDFLARE|cloudflare/i.test(text)) return true;
        const info = await getTurnstileTokenInfo(page);
        return !!info.verificationFailed;
    } catch (e) {
        return false;
    }
}

// --- 统一状态：turnstile_token_ready | turnstile_verification_failed | turnstile_widget_not_ready | turnstile_token_missing ---
function classifyTurnstileState(info, { afterClick = false } = {}) {
    if (info && info.found) return 'turnstile_token_ready';
    if (info && info.verificationFailed) return 'turnstile_verification_failed';
    if (info && info.strictlyHealthy) {
        return afterClick ? 'turnstile_token_missing' : 'turnstile_widget_ready';
    }
    if (info && (info.deadIframe || !info.cfWidgetVisible || !info.hasResponseField || !info.healthyIframe)) {
        return 'turnstile_widget_not_ready';
    }
    return afterClick ? 'turnstile_token_missing' : 'turnstile_widget_not_ready';
}

// --- 刷新登录页并完整重走等待流程（清旧数据一次 → DOMContentLoaded → 初始化 → 健康检查） ---
async function reloadLoginChallenge(page, reason = 'refresh') {
    console.log(`[登录阶段] 刷新登录页 challenge，原因: ${reason}`);
    await page.goto('https://dashboard.katabump.com/auth/login', {
        waitUntil: 'domcontentloaded',
        timeout: 60000
    });
    // goto 后清一次旧数据即可（不要前后各清一次）
    await clearStaleTurnstileData(page);
    // 等 DOM 稳定 + Turnstile 脚本初始化，不要立刻点击
    await page.waitForTimeout(2500 + Math.random() * 1000);
    try {
        await page.mouse.move(120 + Math.random() * 80, 140 + Math.random() * 60, { steps: 6 });
        await page.waitForTimeout(200);
        await page.mouse.move(380 + Math.random() * 100, 320 + Math.random() * 80, { steps: 8 });
        await page.waitForTimeout(300);
    } catch (e) { }
    await page.waitForTimeout(1500);
    console.log('[登录阶段] 刷新完成，进入完整 widget 等待流程。');
}

// --- 等待 Turnstile widget 真正就绪（严格条件） ---
// 返回: { state, ready, autoSolved, failed, info }
async function waitForHealthyTurnstile(page, timeoutMs = 20000) {
    const startedAt = Date.now();
    console.log(`[登录阶段] 等待 Turnstile widget 就绪 (最长 ${timeoutMs}ms)...`);
    let lastLogAt = 0;

    while (Date.now() - startedAt < timeoutMs) {
        const info = await getTurnstileTokenInfo(page);
        const state = classifyTurnstileState(info);

        if (state === 'turnstile_token_ready') {
            console.log(`[登录阶段] state=turnstile_token_ready，token 已自动生成，长度=${info.length}`);
            return { state, ready: true, autoSolved: true, failed: false, info };
        }
        if (state === 'turnstile_verification_failed') {
            console.log('[登录阶段] state=turnstile_verification_failed（widget 已失败）。');
            return { state, ready: false, autoSolved: false, failed: true, info };
        }
        if (info.strictlyHealthy) {
            console.log(`[登录阶段] state=turnstile_widget_ready（严格健康）。challengeFrames=${JSON.stringify(info.challengeFrameUrls || [])}`);
            return { state: 'turnstile_widget_ready', ready: true, autoSolved: false, failed: false, info };
        }

        // 诊断心跳
        if (Date.now() - lastLogAt >= 4000) {
            lastLogAt = Date.now();
            console.log(
                `[登录阶段] 等待中 state=${state}` +
                ` cfVisible=${info.cfWidgetVisible}` +
                ` field=${info.hasResponseField}` +
                ` healthyIframe=${info.healthyIframe}` +
                ` dead=${info.deadIframe}` +
                ` notHydrated=${!!info.challengeNotHydrated}` +
                ` script=${!!info.turnstileScriptLoaded}` +
                ` api=${!!info.turnstileApi}` +
                ` frames=${JSON.stringify(info.challengeFrameUrls || [])}` +
                ` iframes=${JSON.stringify(info.iframes)}`
            );
        }
        await page.waitForTimeout(1000);
    }

    const finalInfo = await getTurnstileTokenInfo(page);
    const state = classifyTurnstileState(finalInfo);
    console.log(
        `[登录阶段] widget 等待超时。state=${state}` +
        ` healthy=${finalInfo.healthyIframe} dead=${finalInfo.deadIframe}` +
        ` notHydrated=${!!finalInfo.challengeNotHydrated}` +
        ` script=${!!finalInfo.turnstileScriptLoaded} api=${!!finalInfo.turnstileApi}` +
        ` challengeFrames=${JSON.stringify(finalInfo.challengeFrameUrls || [])}` +
        ` iframes=${JSON.stringify(finalInfo.iframes)}` +
        ` widgets=${JSON.stringify(finalInfo.widgets)}`
    );
    return {
        state,
        ready: false,
        autoSolved: false,
        failed: state === 'turnstile_verification_failed',
        info: finalInfo
    };
}

// --- 通用过盾循环（保留原逻辑，供 Renew 等阶段使用） ---
async function solveTurnstileIfPresent(page, stageName = "通用", maxAttempts = 10, waitAfterClick = 5000) {
    console.log(`[${stageName}] 开始检测 Cloudflare Turnstile...`);
    for (let i = 0; i < maxAttempts; i++) {
        const clickResult = await attemptTurnstileCdp(page);
        const clicked = !!(clickResult && (clickResult.sent === true || clickResult === true));
        if (clicked) {
            console.log(`[${stageName}] ✅ 成功点击 Turnstile，等待验证通过 (${waitAfterClick}ms)...`);
            await page.waitForTimeout(waitAfterClick);
            return true;
        }
        if (i < maxAttempts - 1) await page.waitForTimeout(1000);
    }
    console.log(`[${stageName}] 未检测到 Turnstile 或无需点击。`);
    return false;
}

// --- 登录专用：减法状态机 + 结果细分 ---
// 一轮 = 等就绪 → 单次点击 → 充分等待 → 成功/失败/超时刷新
// state 输出：
//   turnstile_token_ready
//   turnstile_verification_failed
//   turnstile_widget_not_ready
//   turnstile_click_target_missing
//   click_no_effect            // 点击发出但 frame/URL 无变化，token=0
//   challenge_progress_no_token // 点击后 frame 有变化/消失，但最终 token=0
async function solveLoginTurnstile(page, totalTimeoutMs = 180000) {
    const maxAttempts = 3;
    let attempt = 0;
    let lastState = 'turnstile_widget_not_ready';
    const overallStart = Date.now();
    console.log(`[登录阶段] 开始解决 Turnstile（一轮一次点击 + 充分等待，最多 ${maxAttempts} 次完整尝试）...`);

    while (attempt < maxAttempts) {
        if (Date.now() - overallStart > totalTimeoutMs) {
            console.log('[登录阶段] 全局时间耗尽。');
            break;
        }
        attempt++;
        console.log(`\n[登录阶段] ===== 完整尝试 ${attempt}/${maxAttempts} =====`);

        const health = await waitForHealthyTurnstile(page, 20000);
        lastState = health.state || lastState;
        const info = health.info || {};

        if (health.autoSolved || health.state === 'turnstile_token_ready') {
            console.log('[登录阶段] state=turnstile_token_ready（自动）');
            return { ok: true, state: 'turnstile_token_ready', message: 'Turnstile token ready' };
        }

        if (health.failed || health.state === 'turnstile_verification_failed') {
            lastState = 'turnstile_verification_failed';
            if (attempt >= maxAttempts) {
                return { ok: false, state: 'turnstile_verification_failed', message: `Cloudflare Verification failed after ${maxAttempts} full attempts` };
            }
            console.log(`[登录阶段] Verification failed → 刷新进入下一完整尝试`);
            try { await reloadLoginChallenge(page, 'verification_failed'); } catch (e) {}
            continue;
        }

        if (!health.ready) {
            lastState = 'turnstile_widget_not_ready';
            if (attempt >= maxAttempts) {
                return { ok: false, state: 'turnstile_widget_not_ready', message: info.challengeNotHydrated ? 'Turnstile challenge iframe never hydrated after full attempts' : `Turnstile widget not ready after ${maxAttempts} full attempts` };
            }
            console.log(`[登录阶段] widget 未就绪 → 刷新进入下一完整尝试`);
            try { await reloadLoginChallenge(page, 'widget_not_ready'); } catch (e) {}
            continue;
        }

        console.log('[登录阶段] state=turnstile_widget_ready');

        const autoOk = await waitForAutoTurnstileToken(page, 5000);
        if (autoOk) {
            return { ok: true, state: 'turnstile_token_ready', message: 'Turnstile token ready (auto)' };
        }

        const clickResult = await attemptTurnstileSingleClick(page);
        if (!clickResult.sent) {
            lastState = 'turnstile_click_target_missing';
            if (attempt >= maxAttempts) {
                return { ok: false, state: 'turnstile_click_target_missing', message: `Could not send single checkbox click after ${maxAttempts} full attempts` };
            }
            console.log('[登录阶段] 点击未发出 → 刷新进入下一完整尝试');
            try { await reloadLoginChallenge(page, 'click_target_missing'); } catch (e) {}
            continue;
        }

        console.log('[登录阶段] state=click_sent，停止本轮其他点击，只等待处理结果。');
        const after = await waitAfterTurnstileClick(page, clickResult.urlBefore, 15000, 12000);

        if (after.state === 'turnstile_token_ready') {
            return { ok: true, state: 'turnstile_token_ready', message: `Turnstile token ready (length=${after.length})` };
        }
        if (after.state === 'turnstile_verification_failed') {
            lastState = 'turnstile_verification_failed';
            if (attempt >= maxAttempts) {
                return { ok: false, state: 'turnstile_verification_failed', message: 'Verification failed after click' };
            }
            console.log('[登录阶段] 点击后 Verification failed → 刷新进入下一完整尝试');
            try { await reloadLoginChallenge(page, 'verification_failed_after_click'); } catch (e) {}
            continue;
        }

        // click_no_effect 或 challenge_progress_no_token 或 turnstile_adapter_error
        lastState = after.state;
        if (after.state === 'turnstile_adapter_error') {
            if (attempt >= maxAttempts) {
                return { ok: false, state: 'turnstile_adapter_error', message: `Turnstile adapter error ${after.errorCode}` };
            }
            console.log(`[登录阶段] Turnstile 适配器错误 (${after.errorCode}) → 刷新进入下一完整尝试`);
            try { await reloadLoginChallenge(page, 'adapter_error'); } catch (e) {}
            continue;
        }
        if (attempt >= maxAttempts) {
            return { ok: false, state: lastState, message: `after.click sent, state=${after.state}, sawProgress=${after.sawProgress}` };
        }
        console.log(`[登录阶段] click sent → state=${after.state} (sawProgress=${after.sawProgress}) → 刷新进入下一完整尝试`);
        try { await reloadLoginChallenge(page, after.state); } catch (e) {}
    }

    const finalInfo = await getTurnstileTokenInfo(page);
    if (finalInfo.found && finalInfo.length > 0) {
        return { ok: true, state: 'turnstile_token_ready', message: 'Turnstile token ready' };
    }
    console.log(`[登录阶段] 结束。state=${lastState} token length=${finalInfo.length || 0}`);
    return { ok: false, state: lastState || 'turnstile_token_missing', message: `Turnstile finished without token (state=${lastState})` };
}

// --- 等待 Turnstile token 真正生成（点击成功 ≠ token 有效） ---
async function waitForTurnstileToken(page, timeoutMs = 30000) {
    const startedAt = Date.now();
    console.log(`[登录阶段] 等待 Turnstile token 生成 (最长 ${timeoutMs}ms)...`);

    while (Date.now() - startedAt < timeoutMs) {
        const tokenInfo = await getTurnstileTokenInfo(page);

        if (tokenInfo.found) {
            console.log(
                `[登录阶段] Turnstile token 已生成，字段=${tokenInfo.selector}，长度=${tokenInfo.length}`
            );
            return true;
        }

        await page.waitForTimeout(1000);
    }

    const finalInfo = await getTurnstileTokenInfo(page);
    console.log(`[登录阶段] Turnstile token 等待超时，未提交登录表单。fields=${JSON.stringify(finalInfo.fields)} iframes=${JSON.stringify(finalInfo.iframes)}`);
    return false;
}

// ============================================================
//  新增辅助函数
// ============================================================

/** 获取全页面压缩文本 */
async function getPageText(page) {
    try {
        return await page.evaluate(() => {
            const walk = (node) => {
                if (node.nodeType === Node.TEXT_NODE) return node.textContent || '';
                if (node.nodeType !== Node.ELEMENT_NODE) return '';
                const parts = [];
                for (const child of node.childNodes) {
                    parts.push(walk(child));
                }
                return parts.join(' ');
            };
            return walk(document.body).replace(/\s+/g, ' ').trim();
        });
    } catch (e) {
        return '';
    }
}

/** 获取单个 locator 的文本 */
async function getLocatorText(locator) {
    try {
        const text = await locator.innerText();
        return text.replace(/\s+/g, ' ').trim();
    } catch (e) {
        return '';
    }
}

/** 保存截图 + HTML 快照 */
async function dumpDebugSnapshot(page, name) {
    const photoDir = await ensureScreenshotsDir();
    const screenshotPath = path.join(photoDir, `${name}.png`);
    const htmlPath = path.join(photoDir, `${name}.html`);
    latestDebugSnapshot = { screenshotPath: null, htmlPath: null };
    try {
        await page.screenshot({ path: screenshotPath, fullPage: true });
        latestDebugSnapshot.screenshotPath = screenshotPath;
        console.log(`[Debug] 截图已保存: ${name}.png`);
    } catch (e) { }
    try {
        const html = await page.content();
        fs.writeFileSync(htmlPath, html, 'utf-8');
        latestDebugSnapshot.htmlPath = htmlPath;
        console.log(`[Debug] HTML 已保存: ${name}.html`);
    } catch (e) { }
}

/** 检测"还未到续期窗口" */
function detectNotReady(text) {
    if (/You can't renew your server yet/i.test(text) || /You will be able to as of/i.test(text)) {
        const match = text.match(/You can't renew your server yet[\s\S]{0,120}?day\(s\)\.?/i);
        if (match) return match[0].replace(/\s+/g, ' ').trim();
        const lines = text.split('\n').map(s => s.trim()).filter(s =>
            s.includes("You can't renew your server yet") || s.includes("You will be able to as of")
        );
        if (lines.length > 0) {
            const m = lines[0].match(/(\d{1,2}\s+(January|February|March|April|May|June|July|August|September|October|November|December))/i);
            return { raw: lines[0], nextDate: m ? m[0] : null };
        }
        return { raw: "You can't renew your server yet", nextDate: null };
    }
    return null;
}

/** 检测验证码/checkbox 阻断
 *  只检测动态的浏览器原生校验消息，不把静态 ALTCHA 标签当阻断 */
function detectCaptchaRequired(text) {
    if (/Please check this box if you want to proceed/i.test(text)) {
        return 'Please check this box if you want to proceed';
    }
    if (/Please complete the captcha to continue/i.test(text)) {
        return 'Please complete the captcha to continue';
    }
    return null;
}

/** 检测 ALTCHA checkbox 实际是否已勾选
 *  返回 true = 已勾选/已解决，false = 未勾选/未解决 */
async function isAltchaCheckboxChecked(page, modal) {
    // 策略 1: 查 modal 内是否有 checked 的 checkbox
    try {
        const checked = await modal.locator('input[type="checkbox"]:checked').count();
        if (checked > 0) return true;
    } catch (e) { }

    // 策略 2: 查全页面 checked checkbox
    try {
        const allChecked = await page.locator('input[type="checkbox"]:checked').all();
        const modalBox = await modal.boundingBox();
        for (const cb of allChecked) {
            try {
                const box = await cb.boundingBox();
                if (box && modalBox &&
                    box.x >= modalBox.x - 30 && box.x <= modalBox.x + modalBox.width + 30 &&
                    box.y >= modalBox.y - 30 && box.y <= modalBox.y + modalBox.height + 30) {
                    return true;
                }
            } catch (e) { }
        }
    } catch (e) { }

    // 策略 3: 查 iframe 内
    try {
        const frames = page.frames();
        for (const frame of frames) {
            if (frame === page.mainFrame()) continue;
            try {
                const count = await frame.locator('input[type="checkbox"]:checked').count();
                if (count > 0) return true;
            } catch (e) { }
        }
    } catch (e) { }

    return false;
}

/** 检测续期成功文本 */
function detectRenewSuccess(text) {
    const patterns = [
        /Renew successful/i,
        /Server renewed/i,
        /Server has been renewed/i,
        /renewal successful/i,
        /Renewal completed/i
    ];
    for (const p of patterns) {
        if (p.test(text)) return true;
    }
    return false;
}

// ============================================================
//  Renew 弹窗定位（多策略 fallback）
// ============================================================
async function findRenewModal(page) {
    const candidates = [
        page.locator('#renew-modal'),
        page.locator('[role="dialog"]').filter({ hasText: /Renew/i }).last(),
        page.locator('.modal').filter({ hasText: /Renew/i }).last(),
        page.locator('div').filter({ hasText: 'This will extend the life of your server.' }).last(),
        page.locator('div').filter({ hasText: 'Protected by ALTCHA' }).last()
    ];

    for (const modal of candidates) {
        try {
            await modal.waitFor({ state: 'visible', timeout: 1500 });
            if (await modal.isVisible()) {
                console.log(`[Modal] 通过策略定位到弹窗 (候选长度: ${candidates.length})`);
                return modal;
            }
        } catch (e) { }
    }
    return null;
}

// ============================================================
//  读取 Expiry 日期
// ============================================================
async function readExpiryDate(page) {
    try {
        const html = await page.content();
        // 尝试从页面 HTML 中找 Expiry 附近的日期
        const expiryMatch = html.match(/Expiry[^<]{0,60}?(\d{4}-\d{2}-\d{2}|[A-Z][a-z]+ \d{1,2},? \d{4})/i);
        if (expiryMatch) {
            console.log(`[Expiry] 从 HTML 读取: ${expiryMatch[1]}`);
            return expiryMatch[1].trim();
        }
        // 从页面文本中找
        const text = await getPageText(page);
        const lines = text.split('\n');
        for (const line of lines) {
            if (/expiry/i.test(line) || /expires/i.test(line)) {
                const dateMatch = line.match(/(\d{4}-\d{2}-\d{2}|[A-Z][a-z]+ \d{1,2},? \d{4})/);
                if (dateMatch) {
                    console.log(`[Expiry] 从文本读取: ${dateMatch[1]}`);
                    return dateMatch[1].trim();
                }
            }
        }
    } catch (e) {
        console.error(`[Expiry] 读取失败: ${e.message}`);
    }
    return null;
}

// ============================================================
//  尝试点击 ALTCHA / Turnstile checkbox（弹窗内）
// ============================================================
async function tryClickCaptchaCheckbox(page, modal) {
    // 策略1: 利用 INJECTED_SCRIPT 注入的 __turnstile_data + CDP 点击
    const cdpRes = await attemptTurnstileCdp(page);
    const clickedCdp = !!(cdpRes && (cdpRes.sent === true || cdpRes === true));
    if (clickedCdp) {
        console.log('[Captcha] CDP 点击成功，等待验证...');
        await page.waitForTimeout(3000);
        return true;
    }

    // 策略2: 在 modal 范围内查找可见的 checkbox 并点击
    try {
        const modalBox = await modal.boundingBox();
        const checkboxes = await page.locator('input[type="checkbox"]').all();
        for (const cb of checkboxes) {
            try {
                const box = await cb.boundingBox();
                if (!box || !modalBox) continue;
                // 只点击 modal 范围内的 checkbox
                if (box.x >= modalBox.x - 20 && box.x <= modalBox.x + modalBox.width + 20 &&
                    box.y >= modalBox.y - 20 && box.y <= modalBox.y + modalBox.height + 20) {
                    if (await cb.isVisible()) {
                        await cb.click({ force: true });
                        console.log('[Captcha] Playwright 点击 checkbox 成功。');
                        await page.waitForTimeout(2000);
                        return true;
                    }
                }
            } catch (e) { }
        }
    } catch (e) { }

    // 策略3: 尝试在 iframe 中查找并点击 checkbox
    try {
        const frames = page.frames();
        for (const frame of frames) {
            if (frame === page.mainFrame()) continue;
            try {
                const cb = frame.locator('input[type="checkbox"]').first();
                if (await cb.isVisible({ timeout: 1000 })) {
                    await cb.click({ force: true });
                    console.log('[Captcha] iframe 内点击 checkbox 成功。');
                    await page.waitForTimeout(2000);
                    return true;
                }
            } catch (e) { }
        }
    } catch (e) { }

    return false;
}

// ============================================================
//  辅助：截图 + 通知
// ============================================================
async function ensureScreenshotsDir() {
    const photoDir = path.join(process.cwd(), 'screenshots');
    if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });
    return photoDir;
}

// ============================================================
//  多账号退出码聚合
// ============================================================
function getUserExitCode(runStatus) {
    switch (runStatus) {
        case 'success':
            return EXIT_CODE.SUCCESS;
        case 'not_ready':
            return EXIT_CODE.NOT_READY;
        case 'already_renewed':
            return EXIT_CODE.ALREADY_RENEWED;
        case 'login_failed':
            return EXIT_CODE.LOGIN_FAILED;
        case 'login_captcha_required':
            return EXIT_CODE.PROXY_RETRY;
        case 'captcha_required':
            return EXIT_CODE.RENEW_CAPTCHA_FAILED;
        case 'error':
            return EXIT_CODE.FATAL;
        default:
            return EXIT_CODE.FATAL;
    }
}

function selectDecisionAccount(accounts, exitCode) {
    const statusByCode = {
        [EXIT_CODE.SUCCESS]: 'success',
        [EXIT_CODE.NOT_READY]: 'not_ready',
        [EXIT_CODE.ALREADY_RENEWED]: 'already_renewed',
        [EXIT_CODE.LOGIN_FAILED]: 'login_failed',
        [EXIT_CODE.RENEW_CAPTCHA_FAILED]: 'captcha_required',
        [EXIT_CODE.PROXY_RETRY]: 'login_captcha_required',
        [EXIT_CODE.FATAL]: 'error'
    };
    const preferredStatus = statusByCode[exitCode];
    if (preferredStatus) {
        for (let i = accounts.length - 1; i >= 0; i--) {
            if (accounts[i].status === preferredStatus) return accounts[i];
        }
    }
    return accounts.length > 0 ? accounts[accounts.length - 1] : null;
}

async function handleAllInvalidUsers(users) {
    let overallExitCode = EXIT_CODE.SUCCESS;
    const accounts = [];
    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        const accountLabel = safeAccountLabel(user, i);
        const displayAccount = user.username || accountLabel;
        const blockMessage = `Invalid account configuration: ${user.__invalidReason}`;
        console.error(`[配置] ${accountLabel} 标记为 login_failed：${user.__invalidReason}`);
        const notificationMessage = `❌ KataBump 登录失败\n用户: ${displayAccount}\n原因: ${blockMessage}`;
        if (!MANAGED_BY_PROXY_RUNNER) {
            await sendTelegramMessage(notificationMessage);
        }
        accounts.push({
            account: displayAccount,
            status: 'login_failed',
            message: blockMessage,
            screenshotPath: null,
            htmlPath: null
        });
        overallExitCode = mergeExitCode(overallExitCode, EXIT_CODE.LOGIN_FAILED);
    }
    setLatestActionResult({
        exitCode: overallExitCode,
        status: 'login_failed',
        message: 'All accounts have invalid configuration',
        accounts
    });
    return overallExitCode;
}

// ============================================================
//  主流程
// ============================================================
async function runMain() {
    latestActionResult = null;
    const usersConfig = validateUsersConfig(process.env.USERS_JSON);
    if (!usersConfig.valid) {
        console.error(`[配置] USERS_JSON 无效：${usersConfig.reason}`);
        setLatestActionResult({
            exitCode: EXIT_CODE.FATAL,
            status: 'error',
            message: `Invalid USERS_JSON: ${usersConfig.reason}`
        });
        return EXIT_CODE.FATAL;
    }
    const users = usersConfig.users;

    if (users.every(user => user.__invalidConfig)) {
        return handleAllInvalidUsers(users);
    }

    if (PROXY_CONFIG_ERROR) {
        setLatestActionResult({
            exitCode: EXIT_CODE.FATAL,
            status: 'error',
            message: 'Invalid proxy configuration'
        });
        return EXIT_CODE.FATAL;
    }

    if (PROXY_CONFIG) {
        const checkResult = await checkProxy();
        const retryableProxyCategories = new Set([
            'proxy_auth_failed',
            'upstream_gateway_error',
            'transport_error'
        ]);
        if (retryableProxyCategories.has(checkResult.category)) {
            console.error(`[代理] 连接失败，分类=${checkResult.category}，标记 PROXY_RETRY`);
            setLatestActionResult({
                exitCode: EXIT_CODE.PROXY_RETRY,
                status: 'proxy_retry',
                message: checkResult.error || checkResult.category
            });
            return EXIT_CODE.PROXY_RETRY;
        }
        if (checkResult.category === 'target_server_error') {
            console.warn(`[代理] 目标服务器返回 HTTP ${checkResult.status}，分类=target_server_error，继续业务流程`);
        } else if (!checkResult.ok) {
            console.error(`[代理] 预检结果不可判定，分类=${checkResult.category}，停止本轮`);
            setLatestActionResult({
                exitCode: EXIT_CODE.FATAL,
                status: 'error',
                message: checkResult.error || checkResult.category
            });
            return EXIT_CODE.FATAL;
        }
    }

    let browser;
    try {
        await launchChrome();
        browser = await connectToChrome();
        await ensureCdpAnchorPage(browser);
    } catch (error) {
        console.error('[主流程] Chrome/CDP 启动失败:', error.message);
        setLatestActionResult({
            exitCode: EXIT_CODE.FATAL,
            status: 'error',
            message: `Chrome/CDP startup failed: ${error.message}`
        });
        return EXIT_CODE.FATAL;
    }
    let context = null;
    let page = null;

    let overallExitCode = EXIT_CODE.SUCCESS;
    const accountResults = [];
    let shouldStopAllUsers = false;
    let stopCurrentUser = false;

    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        const accountLabel = safeAccountLabel(user, i);
        const displayAccount = user.username || accountLabel;
        console.log(`\n=== 正在处理用户 ${i + 1}/${users.length} ===`);

        let renewSuccess = false;
        let runStatus = 'unknown';
        stopCurrentUser = false;
        let blockMessage = '';

        let finalScreenshotPath = null;
        latestDebugSnapshot = { screenshotPath: null, htmlPath: null };

        try {
            if (user.__invalidConfig) {
                runStatus = 'login_failed';
                blockMessage = `Invalid account configuration: ${user.__invalidReason}`;
            } else {
            // CDP 模式使用历史成功链路的默认 Context；每个账号关闭 page、清 Cookie，避免会话串联。
            const preparedPage = await prepareCdpAccountPage(browser);
            context = preparedPage.context;
            page = preparedPage.page;

            // 1. 访问登录页
            console.log('访问登录页面...');
            await page.goto(TARGET_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await page.evaluate(() => {
                try { localStorage.clear(); } catch (e) { }
                try { sessionStorage.clear(); } catch (e) { }
            }).catch(() => {});
            await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });

            // 登录页 Turnstile 严格状态机：
            // widget 健康 → 点击 → 等 token → token 有值才提交
            // Verification failed → 不点 → 清旧数据 → 刷新 → 完整等待 → 最多 3 次
            // --disable-blink-features 只是环境差异项，不是过盾保证
            await page.waitForTimeout(3000);

            // 先做一次轻微人工鼠标活动
            try {
                await page.mouse.move(100, 100, { steps: 5 });
                await page.waitForTimeout(300);
                await page.mouse.move(400, 300, { steps: 8 });
                await page.waitForTimeout(200);
            } catch (e) { }

            // 3 轮完整尝试（就绪+单次点击+15s等待），全局 180s
            const turnstileResult = await solveLoginTurnstile(page, 180000);
            if (!turnstileResult.ok) {
                const state = turnstileResult.state || 'turnstile_token_missing';
                console.error(`   >> ⚠️ Turnstile 未通过。state=${state} message=${turnstileResult.message}`);
                runStatus = 'login_captcha_required';
                blockMessage = turnstileResult.message || state;
                renewSuccess = false;
                const snapName = state === 'turnstile_verification_failed'
                    ? `login_turnstile_verification_failed_${accountLabel}`
                    : state === 'turnstile_widget_not_ready'
                        ? `login_turnstile_widget_not_ready_${accountLabel}`
                        : state === 'turnstile_click_target_missing'
                            ? `login_turnstile_click_target_missing_${accountLabel}`
                            : state === 'turnstile_adapter_error'
                                ? `login_turnstile_adapter_error_${accountLabel}`
                                : `login_turnstile_token_missing_${accountLabel}`;
                await dumpDebugSnapshot(page, snapName);
                shouldStopAllUsers = true;
                // break removed - let unified finalize handle
            }
            if (!stopCurrentUser && !shouldStopAllUsers) {
                console.log(`[登录阶段] state=${turnstileResult.state}，可以填写凭据并提交。`);

                console.log('正在输入凭据...');
                try {
                    const emailInput = page.getByRole('textbox', { name: 'Email' });
                    await emailInput.waitFor({ state: 'visible', timeout: 5000 });
                    await emailInput.fill(user.username);

                    const pwdInput = page.getByRole('textbox', { name: 'Password' });
                    await pwdInput.fill(user.password);

                    await page.waitForTimeout(500);

                    // 提交前再确认 token 仍在（防止 fill 过程中失效）
                    const tokenStillValid = await getTurnstileTokenInfo(page);

                    if (!tokenStillValid.found) {
                        console.error('   >> ⚠️ 提交前 Turnstile token 已丢失，不提交登录表单。');
                        runStatus = 'login_captcha_required';
                        blockMessage = 'Turnstile token disappeared before login submit';
                        renewSuccess = false;
                        await dumpDebugSnapshot(
                            page,
                            `login_turnstile_token_lost_${accountLabel}`
                        );
                        stopCurrentUser = true;
                    }
                    if (!stopCurrentUser && !shouldStopAllUsers) {
                        console.log(`[登录阶段] 提交前 token 仍有效，字段=${tokenStillValid.selector}，长度=${tokenStillValid.length}，提交 Login...`);

                        await page.getByRole('button', { name: 'Login', exact: true }).click();

                        // 登录后诊断：保存截图 + HTML，输出 URL / 标题 / body 片段
                        await page.waitForTimeout(2000);
                        const photoDir = await ensureScreenshotsDir();
                        await page.screenshot({ path: path.join(photoDir, `login_after_submit_${accountLabel}.png`), fullPage: true });
                        try {
                            const html = await page.content();
                            fs.writeFileSync(path.join(photoDir, `login_after_submit_${accountLabel}.html`), html, 'utf-8');
                        } catch (e) { }
                        const loginUrl = page.url();
                        const loginTitle = await page.title();
                        const loginBody = await getPageText(page);
                        console.log(`[登录诊断] 当前 URL: ${loginUrl}`);
                        console.log(`[登录诊断] 页面标题: ${loginTitle}`);
                        console.log(`[登录诊断] body 前500字符: ${loginBody.substring(0, 500)}`);

                        // 检查登录错误
                        try {
                            const errorMsg = page.getByText('Incorrect password or no account');
                            if (await errorMsg.isVisible({ timeout: 3000 })) {
                                console.error(`   >> ❌ 登录失败: 账号或密码错误`);
                                runStatus = 'login_failed';
                                blockMessage = 'Incorrect password or no account';
                                const photoDir = await ensureScreenshotsDir();
                                await page.screenshot({ path: path.join(photoDir, `login_failed_${accountLabel}.png`), fullPage: true });
                                stopCurrentUser = true;
                            }
                        } catch (e) { }

                        if (!stopCurrentUser && !shouldStopAllUsers) {
                            // 检查验证码是否被服务端接受（error=captcha / Please complete captcha）
                            const captchaUrlHit = /error=captcha/i.test(loginUrl);
                            const captchaTextHit = /Please complete captcha/i.test(loginBody)
                                || /captcha required/i.test(loginBody)
                                || /complete captcha/i.test(loginBody);
                            if (captchaUrlHit || captchaTextHit) {
                                console.error(`   >> ⚠️ 登录验证码未被服务端接受 (URL: ${loginUrl})`);
                                runStatus = 'login_captcha_required';
                                blockMessage = 'Login captcha was not accepted';
                                renewSuccess = false;
                                const photoDir2 = await ensureScreenshotsDir();
                                await page.screenshot({ path: path.join(photoDir2, `login_captcha_required_${accountLabel}.png`), fullPage: true });
                                try {
                                    const html2 = await page.content();
                                    fs.writeFileSync(path.join(photoDir2, `login_captcha_required_${accountLabel}.html`), html2, 'utf-8');
                                } catch (e) { }
                                shouldStopAllUsers = true;
                            }
                        }
                    }
                } catch (e) {
                    console.log('登录操作遇到异常 (可能是已登录或超时):', e.message);
                }
            }

            // 2. 登录后进入 dashboard（多策略 fallback）
            if (!stopCurrentUser && !shouldStopAllUsers) {
                // 再次确认当前 URL 不含 error=captcha（防止 try 块外漏检）
                if (/error=captcha/i.test(page.url())) {
                    console.error(`   >> ⚠️ 登录验证码未被服务端接受 (URL: ${page.url()})`);
                    runStatus = 'login_captcha_required';
                    blockMessage = 'Login captcha was not accepted';
                    renewSuccess = false;
                    const photoDir = await ensureScreenshotsDir();
                    await page.screenshot({ path: path.join(photoDir, `login_captcha_required_${accountLabel}.png`), fullPage: true });
                    try {
                        const html = await page.content();
                        fs.writeFileSync(path.join(photoDir, `login_captcha_required_${accountLabel}.html`), html, 'utf-8');
                    } catch (e) { }
                    shouldStopAllUsers = true;
                }
            }

            if (!stopCurrentUser && !shouldStopAllUsers) {
                console.log('正在寻找 dashboard / server 入口...');

                let dashboardReady = false;

                // 策略 1: URL 已包含 dashboard（排除仍在 /auth/login 的情况）
                try {
                    await page.waitForURL(url => /dashboard/i.test(url) && !/auth\/login/i.test(url), { timeout: 5000 });
                    console.log('[登录] URL 已跳转到 dashboard。');
                    dashboardReady = true;
                } catch (e) { }

                // 策略 2: 页面文本包含 dashboard / server identifier / 服务器列表
                if (!dashboardReady) {
                    const bodyText = await getPageText(page);
                    if (/dashboard/i.test(bodyText) && /server/i.test(bodyText) && !/Please complete captcha/i.test(bodyText)) {
                        console.log('[登录] 页面文本检测到 dashboard + server，判定登录成功。');
                        dashboardReady = true;
                    }
                }

                // 策略 3: 查找 "See" 按钮
                if (!dashboardReady) {
                    try {
                        const seeBtn = page.getByRole('link', { name: 'See' }).first();
                        await seeBtn.waitFor({ timeout: 5000 });
                        console.log('[登录] 找到 "See" 按钮。');
                        dashboardReady = true;
                    } catch (e) { }
                }

                // 策略 4: 查找 "Access server" / "View" 按钮
                if (!dashboardReady) {
                    const altBtns = ['Access server', 'View', 'Manage', 'Servers', 'My Servers'];
                    for (const btnName of altBtns) {
                        try {
                            const btn = page.getByRole('link', { name: btnName }).first();
                            await btn.waitFor({ timeout: 2000 });
                            console.log(`[登录] 找到 "${btnName}" 按钮。`);
                            dashboardReady = true;
                            break;
                        } catch (e) { }
                    }
                }

                if (!dashboardReady) {
                    // 最后再检查一次 captcha 错误，避免误标为 login_failed
                    const finalUrl = page.url();
                    const finalBody = await getPageText(page);
                    if (/error=captcha/i.test(finalUrl) || /Please complete captcha/i.test(finalBody) || /complete captcha/i.test(finalBody)) {
                        console.error(`   >> ⚠️ 登录验证码未被服务端接受 (URL: ${finalUrl})`);
                        runStatus = 'login_captcha_required';
                        blockMessage = 'Login captcha was not accepted';
                        renewSuccess = false;
                        const photoDir = await ensureScreenshotsDir();
                        await page.screenshot({ path: path.join(photoDir, `login_captcha_required_${accountLabel}.png`), fullPage: true });
                        try {
                            const html = await page.content();
                            fs.writeFileSync(path.join(photoDir, `login_captcha_required_${accountLabel}.html`), html, 'utf-8');
                        } catch (e) { }
                        shouldStopAllUsers = true;
                    }

                    if (!stopCurrentUser && !shouldStopAllUsers) {
                        console.log('login_failed: 未找到 dashboard 入口 (See / Access server / View / dashboard URL)。');
                        runStatus = 'login_failed';
                        blockMessage = 'Dashboard entry not found after login';
                        const photoDir = await ensureScreenshotsDir();
                        await page.screenshot({ path: path.join(photoDir, `login_failed_no_dashboard_${accountLabel}.png`), fullPage: true });
                        stopCurrentUser = true;
                    }
                }

                // 如果有 See 按钮，点击它；否则认为已在 dashboard 页面
                try {
                    const seeBtn = page.getByRole('link', { name: 'See' }).first();
                    if (await seeBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
                        await seeBtn.click();
                        console.log('[登录] 已点击 See 按钮。');
                    }
                } catch (e) { }
            }

            // 3. Renew 主循环
            if (!stopCurrentUser && !shouldStopAllUsers) {
                for (let attempt = 1; attempt <= 20; attempt++) {
                    const renewBtn = page.getByRole('button', { name: 'Renew', exact: true }).first();

                    try { await renewBtn.waitFor({ state: 'visible', timeout: 5000 }); } catch (e) { }

                    if (!(await renewBtn.isVisible().catch(() => false))) {
                        console.log('未找到 Renew 按钮 (可能已结束)。');
                        break;
                    }

                    // 【保留】外层 Renew 点击
                    await renewBtn.click();
                    console.log('Renew 按钮已点击。等待模态框...');

                    const modal = await findRenewModal(page);
                    if (!modal) {
                        console.log('模态框未出现？重试中...');
                        const photoDir = await ensureScreenshotsDir();
                        await page.screenshot({ path: path.join(photoDir, `renew_modal_not_found_${attempt}.png`), fullPage: true });
                        continue;
                    }
                    console.log('Renew 模态框已识别。');

                    // 鼠标晃动模拟
                    try {
                        const box = await modal.boundingBox();
                        if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
                    } catch (e) { }

                    // 读取弹窗文本用于诊断
                    const modalText = await getLocatorText(modal);
                    console.log(`[Modal] 弹窗文本预览: ${modalText.substring(0, 200)}`);

                    // 识别弹窗验证类型：ALTCHA / CF Turnstile / 无，非 CF 时跳过
                    // 只用强特征，限定当前弹窗
                    const hasCfInModal = await modal.locator('.cf-turnstile, iframe[src*="challenges.cloudflare.com"]').count().catch(() => 0) > 0;
                    const hasAltchaInModal2 = /Protected by ALTCHA/i.test(modalText)
                        || await modal.locator('altcha-widget, [data-altcha], .altcha').count().catch(() => 0) > 0;
                    console.log(`[Renew阶段] 弹窗验证类型: ${hasAltchaInModal2 ? 'ALTCHA' : hasCfInModal ? 'CF Turnstile' : '无'}`);

                    if (hasCfInModal && !hasAltchaInModal2) {
                        const turnstileResult = await solveTurnstileIfPresent(page, "Renew阶段", 15, 6000);
                        console.log(`[Renew阶段] Turnstile 检测结果: ${turnstileResult ? '已处理' : '未检测到或无需点击'}`);
                    } else if (hasAltchaInModal2) {
                        console.log('[Renew阶段] ALTCHA 验证，由下方 ALTCHA 逻辑处理，跳过 CF Turnstile 检测。');
                    } else {
                        console.log('[Renew阶段] 未检测到验证码类型，跳过。');
                    }
                    // 点击确认 Renew 前，读取旧 Expiry
                    const oldExpiry = await readExpiryDate(page);
                    console.log(`[Expiry] 续期前 Expiry: ${oldExpiry || '未读取到'}`);

                    // 点击确认按钮前先检查 not_ready（页面级别）
                    const notReadyBefore = detectNotReady(await getPageText(page));
                    // 同时检查 modal 文本中的 not_ready（可能只在 modal 内出现）
                    const notReadyInModal = modalText.includes("You can't renew your server yet") || modalText.includes("You will be able to as of")
                        ? modalText.substring(0, 200)
                        : null;

                    if (notReadyBefore || notReadyInModal) {
                        const reason = (notReadyBefore && typeof notReadyBefore === 'string') ? notReadyBefore
                            : (notReadyBefore && notReadyBefore.raw) ? notReadyBefore.raw
                            : notReadyInModal;
                        console.log('   >> ⏳ 暂无法续期 (before click)。停止重试。');
                        console.log('   >> 页面提示:', reason);
                        runStatus = 'not_ready';
                        blockMessage = reason;
                        renewSuccess = false;
                        const photoDir = await ensureScreenshotsDir();
                        await dumpDebugSnapshot(page, `not_ready_${attempt}`);
                        break;
                    }

                    // 【ALTCHA 前置检测】modal text 含 ALTCHA 关键词时，必须先完成 checkbox 才能点 confirm
                    const hasAltchaInModal = /Protected by ALTCHA/i.test(modalText)
                        || await modal.locator('altcha-widget, [data-altcha], .altcha').count().catch(() => 0) > 0;
                    if (hasAltchaInModal) {
                        console.log('[ALTCHA] Modal 检测到 ALTCHA/checkbox 验证，先完成验证再点 confirm。');
                        const cbCheckedBefore = await isAltchaCheckboxChecked(page, modal);
                        console.log(`[ALTCHA] checkbox checked before click: ${cbCheckedBefore}`);

                        if (!cbCheckedBefore) {
                            console.log('[ALTCHA] trying click strategy: auto');
                            const cbClicked = await tryClickCaptchaCheckbox(page, modal);
                            if (cbClicked) {
                                console.log('[ALTCHA] 自动点击完成，等待 3 秒验证...');
                                await page.waitForTimeout(3000);
                                const cbCheckedAfter = await isAltchaCheckboxChecked(page, modal);
                                console.log(`[ALTCHA] checkbox checked after click: ${cbCheckedAfter}`);
                                if (!cbCheckedAfter) {
                                    console.log('[ALTCHA] 点击后 checkbox 仍未勾选，标记 captcha_required。');
                                    runStatus = 'captcha_required';
                                    blockMessage = 'ALTCHA checkbox click did not result in checked state';
                                    renewSuccess = false;
                                    const photoDir = await ensureScreenshotsDir();
                                    await dumpDebugSnapshot(page, `captcha_required_${attempt}`);
                                    break;
                                }
                                console.log('[ALTCHA] ✅ Checkbox 已勾选，可以点击 confirm。');
                            } else {
                                console.log('[ALTCHA] 所有点击策略均失败，标记 captcha_required。');
                                runStatus = 'captcha_required';
                                blockMessage = 'ALTCHA checkbox could not be auto-clicked';
                                renewSuccess = false;
                                const photoDir = await ensureScreenshotsDir();
                                await dumpDebugSnapshot(page, `captcha_required_${attempt}`);
                                break;
                            }
                        } else {
                            console.log('[ALTCHA] checkbox 已经勾选，直接点击 confirm。');
                        }
                    }

                    // 点击确认 Renew 按钮
                    const confirmBtn = modal.getByRole('button', { name: 'Renew' });
                    if (!(await confirmBtn.isVisible().catch(() => false))) {
                        console.log('确认 Renew 按钮不可见，刷新重试。');
                        continue;
                    }

                    console.log('   >> 点击确认 Renew 按钮...');
                    await confirmBtn.click();
                    console.log('Confirm Renew clicked.');

                    // 点击后等待响应
                    await page.waitForTimeout(2000);

                    // --- 点击后诊断序列 ---
                    const pageTextAfterClick = await getPageText(page);
                    const modalTextAfterClick = await modal.innerText().catch(() => '');
                    const modalVisibleAfterClick = await modal.isVisible().catch(() => false);
                    const currentUrlAfterClick = page.url();
                    console.log(`[诊断] 点击后 URL: ${currentUrlAfterClick}`);
                    console.log(`[诊断] 点击后 modal visible: ${modalVisibleAfterClick}`);
                    console.log(`[诊断] 点击后页面文本片段: ${pageTextAfterClick.substring(0, 300)}`);

                    // 检查 1: not_ready
                    const notReadyAfter = detectNotReady(pageTextAfterClick);
                    if (notReadyAfter) {
                        console.log('   >> ⏳ 暂无法续期 (after click)。停止重试。');
                        console.log('   >> 页面提示:', typeof notReadyAfter === 'string' ? notReadyAfter : notReadyAfter.raw);
                        runStatus = 'not_ready';
                        blockMessage = typeof notReadyAfter === 'string' ? notReadyAfter : notReadyAfter.raw;
                        renewSuccess = false;
                        const photoDir = await ensureScreenshotsDir();
                        await dumpDebugSnapshot(page, `not_ready_after_${attempt}`);
                        break;
                    }

                    // 检查 2: 验证码/checkbox 未完成
                    const captchaIssue = detectCaptchaRequired(pageTextAfterClick);
                    if (captchaIssue) {
                        console.log(`   >> ⚠️ 检测到验证码阻断: ${captchaIssue}`);
                        console.log('   >> 尝试自动点击 checkbox...');
                        const cbClicked = await tryClickCaptchaCheckbox(page, modal);
                        if (cbClicked) {
                            console.log('   >> Checkbox 点击完成，等待 3 秒后检查结果...');
                            await page.waitForTimeout(3000);
                            const pageTextAfterCb = await getPageText(page);
                            const modalTextAfterCb = await getLocatorText(modal);

                            // [Advisor 缺口 #2] 检查 checkbox 勾选后 modal 内是否出现 not_ready
                            const notReadyInModalAfterCb = modalTextAfterCb.includes("You can't renew your server yet")
                                || modalTextAfterCb.includes("You will be able to as of");
                            if (notReadyInModalAfterCb) {
                                console.log('   >> ⏳ Checkbox 点击后 modal 显示还未到续期时间。');
                                runStatus = 'not_ready';
                                blockMessage = modalTextAfterCb.substring(0, 200);
                                renewSuccess = false;
                                await dumpDebugSnapshot(page, `not_ready_after_cb_${attempt}`);
                                break;
                            }

                            // 重新读取 Expiry（确认按钮还没再点一次，但记录基线）
                            const newExpiryAfterCb = await readExpiryDate(page);
                            console.log(`[Expiry] checkbox 点击后 Expiry: ${newExpiryAfterCb || '未读取到'}`);

                            const stillBlocked = detectCaptchaRequired(pageTextAfterCb);
                            if (stillBlocked) {
                                console.log('   >> Checkbox 点击后验证仍未通过。标记 captcha_required。');
                                runStatus = 'captcha_required';
                                blockMessage = stillBlocked;
                                renewSuccess = false;
                                await dumpDebugSnapshot(page, `captcha_required_${attempt}`);
                                break;
                            }

                            // Checkbox 已勾选且无原生错误 → 尝试再次点击 confirm
                            console.log('   >> ✅ Checkbox 验证通过，再次点击确认 Renew...');
                            const confirmBtnAfterCb = modal.getByRole('button', { name: 'Renew' });
                            if (await confirmBtnAfterCb.isVisible().catch(() => false)) {
                                await confirmBtnAfterCb.click();
                                console.log('Confirm Renew clicked (after captcha).');
                                await page.waitForTimeout(3000);

                                // 再次读取状态
                                const pageTextFinal = await getPageText(page);
                                const successFinal = detectRenewSuccess(pageTextFinal);
                                if (successFinal) {
                                    console.log('   >> ✅ 续期成功（confirm after captcha）！');
                                    runStatus = 'success';
                                    renewSuccess = true;
                                    await page.screenshot({ path: path.join(await ensureScreenshotsDir(), `renew_success_${attempt}.png`), fullPage: true });
                                    break;
                                }

                                // 检查 modal 是否关闭 + Expiry 是否变化
                                const stillVisibleFinal = await modal.isVisible({ timeout: 2000 }).catch(() => false);
                                if (!stillVisibleFinal) {
                                    await page.waitForTimeout(2000);
                                    const newExpiryFinal = await readExpiryDate(page);
                                    console.log(`[Expiry] 二次确认后 Expiry: ${newExpiryFinal || '未读取到'}`);
                                    if (newExpiryFinal && oldExpiry && newExpiryFinal !== oldExpiry) {
                                        console.log(`   >> ✅ Expiry 已变化: ${oldExpiry} → ${newExpiryFinal}，续期成功！`);
                                        runStatus = 'success';
                                        renewSuccess = true;
                                        await page.screenshot({ path: path.join(await ensureScreenshotsDir(), `renew_success_${attempt}.png`), fullPage: true });
                                        break;
                                    } else if (newExpiryFinal && oldExpiry && newExpiryFinal === oldExpiry) {
                                        console.log('   >> Modal 已关闭，Expiry 未变，可能已是最新的。');
                                        runStatus = 'already_renewed';
                                        renewSuccess = false;
                                        break;
                                    } else {
                                        console.log('   >> Modal 已关闭，但无法读取 Expiry，标记 unknown。');
                                        renewSuccess = false;
                                        runStatus = 'unknown';
                                        break;
                                    }
                                }
                            }
                            // 二次 confirm 按钮不可见 → 重试
                            console.log('   >> Confirm 按钮在 checkbox 点击后不可见，刷新重试。');
                            await page.reload();
                            await page.waitForTimeout(3000);
                            continue;
                        } else {
                            console.log('   >> 无法自动完成验证码，标记 captcha_required。');
                            runStatus = 'captcha_required';
                            blockMessage = captchaIssue;
                            renewSuccess = false;
                            const photoDir = await ensureScreenshotsDir();
                            await dumpDebugSnapshot(page, `captcha_required_${attempt}`);
                            break;
                        }
                    }

                    // 检查 3: 成功文本
                    const successText = detectRenewSuccess(pageTextAfterClick);
                    if (successText) {
                        console.log('   >> ✅ 页面出现成功提示！');
                        runStatus = 'success';
                        renewSuccess = true;
                        const photoDir = await ensureScreenshotsDir();
                        await page.screenshot({ path: path.join(photoDir, `renew_success_${attempt}.png`), fullPage: true });
                        break;
                    }

                    // 检查 4: modal 是否关闭
                    const stillVisible = await modal.isVisible({ timeout: 2000 }).catch(() => false);
                    if (!stillVisible) {
                        console.log('   >> 模态框已关闭，等待页面稳定后读取新 Expiry...');
                        await page.waitForTimeout(2000);
                        const newExpiry = await readExpiryDate(page);
                        console.log(`[Expiry] 续期后 Expiry: ${newExpiry || '未读取到'}`);

                        if (newExpiry && oldExpiry && newExpiry !== oldExpiry) {
                            console.log(`   >> ✅ Expiry 已变化: ${oldExpiry} → ${newExpiry}，续期成功！`);
                            renewSuccess = true;
                            runStatus = 'success';
                            const photoDir = await ensureScreenshotsDir();
                            await page.screenshot({ path: path.join(photoDir, `renew_success_${attempt}.png`), fullPage: true });
                            break;
                        } else if (newExpiry === oldExpiry && newExpiry !== null) {
                            console.log('   >> ⚠️ Modal 已关闭但 Expiry 未变，可能已是最新的。');
                            renewSuccess = false;
                            runStatus = 'already_renewed';
                            const photoDir = await ensureScreenshotsDir();
                            await dumpDebugSnapshot(page, `expiry_unchanged_${attempt}`);
                            break;
                        } else {
                            console.log('   >> Modal 已关闭，但无法读取新 Expiry，标记 unknown。');
                            renewSuccess = false;
                            runStatus = 'unknown';
                            break;
                        }
                    }

                    // 检查 5: modal 仍开着，诊断原因
                    console.log('   >> 模态框仍开着，诊断阻断原因...');
                    const blockingState = detectCaptchaRequired(pageTextAfterClick);
                    if (blockingState) {
                        console.log(`   >> ⚠️ 已知阻断状态: ${blockingState}`);
                        runStatus = blockingState.includes('ALTCHA') || blockingState.includes('checkbox') ? 'captcha_required' : 'unknown_blocked';
                        blockMessage = blockingState;
                        renewSuccess = false;
                        const photoDir = await ensureScreenshotsDir();
                        await dumpDebugSnapshot(page, `modal_blocked_${attempt}`);
                        break;
                    }

                    // 检查 6: 是否出现 "You can't renew your server yet" 在 modal 内
                    if (/You can't renew your server yet/i.test(modalTextAfterClick)) {
                        console.log('   >> ⏳ Modal 内提示还未到续期时间。');
                        runStatus = 'not_ready';
                        blockMessage = modalTextAfterClick.substring(0, 200);
                        renewSuccess = false;
                        const photoDir = await ensureScreenshotsDir();
                        await dumpDebugSnapshot(page, `not_ready_in_modal_${attempt}`);
                        break;
                    }

                    // 未知状态 — 记录详细诊断信息，不盲目刷新
                    console.log(`   >> Modal still open after confirm.`);
                    console.log(`   >> Modal text: ${modalTextAfterClick.substring(0, 300)}`);
                    console.log(`   >> 当前 URL: ${currentUrlAfterClick}`);
                    const photoDir = await ensureScreenshotsDir();
                    await dumpDebugSnapshot(page, `modal_unknown_state_${attempt}`);

                    // 详细 DOM dump
                    try {
                        const domDiag = await page.evaluate((modalSelector) => {
                            const results = {};

                            // 找到 modal 元素
                            const modalEl = document.querySelector(modalSelector);
                            results.modalFound = !!modalEl;

                            if (modalEl) {
                                // 所有 input 的 outerHTML
                                const inputs = modalEl.querySelectorAll('input');
                                results.inputs = Array.from(inputs).map(el => ({
                                    tag: el.tagName,
                                    type: el.type,
                                    name: el.name,
                                    checked: el.checked,
                                    required: el.required,
                                    disabled: el.disabled,
                                    validationMessage: el.validationMessage || '',
                                    outerHTML: el.outerHTML.substring(0, 200)
                                }));

                                // checkbox 详细信息
                                const checkboxes = modalEl.querySelectorAll('input[type="checkbox"]');
                                results.checkboxes = Array.from(checkboxes).map(el => ({
                                    checked: el.checked,
                                    required: el.required,
                                    disabled: el.disabled,
                                    validationMessage: el.validationMessage || '',
                                    id: el.id,
                                    className: el.className
                                }));

                                // 所有 iframe 的 URL
                                const iframes = modalEl.querySelectorAll('iframe');
                                results.iframes = Array.from(iframes).map(el => ({
                                    src: el.src,
                                    id: el.id,
                                    name: el.name
                                }));

                                // shadowRoot 检测
                                results.hasShadowRoot = modalEl.shadowRoot !== null;
                                if (modalEl.shadowRoot) {
                                    results.shadowRootHTML = modalEl.shadowRoot.innerHTML.substring(0, 500);
                                }
                            }

                            // activeElement
                            const active = document.activeElement;
                            results.activeElement = active ? active.outerHTML.substring(0, 300) : 'null';

                            return results;
                        }, '#renew-modal, [role="dialog"], .modal');

                        console.log('[诊断] DOM 详情:', JSON.stringify(domDiag, null, 2));

                        // 写入文件
                        const diagPath = path.join(photoDir, `dom_diag_${attempt}.json`);
                        fs.writeFileSync(diagPath, JSON.stringify(domDiag, null, 2), 'utf-8');
                        console.log(`[诊断] DOM 诊断已保存: dom_diag_${attempt}.json`);
                    } catch (e) {
                        console.log(`[诊断] DOM dump 失败: ${e.message}`);
                    }

                    // 刷新页面重试（这是已知可重试的情况）
                    console.log('   >> 未知状态，刷新重试...');
                    await page.reload();
                    await page.waitForTimeout(3000);
                }

            }
            }
        } catch (err) {
            console.error(`Error processing user:`, err);
            runStatus = 'error';
            blockMessage = err.message;
        } finally {
            const cleanupResult = await finalizeAccountResources({
                page,
                context,
                ensureDir: ensureScreenshotsDir,
                screenshotName: `${accountLabel}.png`,
                closeContext: false,
                logger: console.error
            });
            finalScreenshotPath = cleanupResult.screenshotPath;
            page = null;
            context = null;
        }

        if (stopCurrentUser) {
            console.log('[主流程] 当前账号结束，继续下一个账号');
        }

        // Telegram 通知
        // Renew 循环出口守卫：unknown / unknown_blocked → FATAL
        if (runStatus === 'unknown' || runStatus === 'unknown_blocked') {
            console.error('   >> ⚠️ Renew 循环未得到明确结果 (runStatus=' + runStatus + ')，标记 FATAL');
            runStatus = 'error';
            if (!blockMessage) blockMessage = 'Renew loop exhausted without clear result';
        }

        let notificationMessage = null;
        if (runStatus === 'success') {
            notificationMessage = `✅ KataBump 续期完成\n用户: ${displayAccount}\n状态: 续期成功`;
        } else if (runStatus === 'not_ready') {
            notificationMessage = `⏳ KataBump 本轮未续期\n用户: ${displayAccount}\n原因: ${blockMessage}\nCron 将在下次继续检查。`;
        } else if (runStatus === 'captcha_required') {
            notificationMessage = `⚠️ KataBump 验证码阻断\n用户: ${displayAccount}\n原因: ${blockMessage}\n请检查验证码状态。`;
        } else if (runStatus === 'login_captcha_required') {
            notificationMessage = `⚠️ KataBump 登录验证码阻断\n用户: ${displayAccount}\n原因: ${blockMessage}\n请解决验证码后重试。`;
        } else if (runStatus === 'login_failed') {
            notificationMessage = `❌ KataBump 登录失败\n用户: ${displayAccount}\n原因: ${blockMessage}`;
        } else if (runStatus === 'already_renewed') {
            notificationMessage = `ℹ️ KataBump 可能已续期\n用户: ${displayAccount}\nExpiry 未变化，可能本轮已是最新。`;
        } else if (runStatus === 'error') {
            notificationMessage = `❌ KataBump 错误\n用户: ${displayAccount}\n原因: ${blockMessage}`;
        }
        if (notificationMessage) {
            if (!MANAGED_BY_PROXY_RUNNER) {
                await sendTelegramMessage(notificationMessage, finalScreenshotPath);
            }
        }

        accountResults.push({
            account: displayAccount,
            status: runStatus,
            message: blockMessage,
            screenshotPath: latestDebugSnapshot.screenshotPath || finalScreenshotPath,
            htmlPath: latestDebugSnapshot.htmlPath
        });

        // 账号级退出码归并
        const userExitCode = getUserExitCode(runStatus);
        overallExitCode = mergeExitCode(overallExitCode, userExitCode);

        if (runStatus === 'error') {
            shouldStopAllUsers = true;
        }

        console.log(`用户处理完成 | 状态: ${runStatus}`);

        if (shouldStopAllUsers) {
            console.log('[主流程] 检测到不可继续的状态，停止后续用户');
            break;
        }
    }

    console.log('\n全部账号处理完成。');

    const decisionAccount = selectDecisionAccount(accountResults, overallExitCode);
    setLatestActionResult({
        exitCode: overallExitCode,
        status: decisionAccount ? decisionAccount.status : 'error',
        message: decisionAccount ? decisionAccount.message : 'No account result was produced',
        screenshotPath: decisionAccount ? decisionAccount.screenshotPath : null,
        htmlPath: decisionAccount ? decisionAccount.htmlPath : null,
        accounts: accountResults
    });

    return overallExitCode;
}

async function closeActiveBrowser() {
    const browser = activeBrowserConnection;
    const anchorPage = activeCdpAnchorPage;
    activeBrowserConnection = null;
    activeCdpAnchorPage = null;

    if (!browser) {
        if (anchorPage) {
            try {
                if (!anchorPage.isClosed()) await anchorPage.close();
            } catch (error) {
                console.error('[cleanup] anchor page 关闭失败:', error.message);
            }
        }
        return;
    }

    let contexts = [];
    try {
        contexts = browser.contexts();
    } catch (error) {
        console.error('[cleanup] 无法读取浏览器 Context:', error.message);
    }
    for (const context of contexts) {
        let pages = [];
        try {
            pages = context.pages();
        } catch (error) {
            console.error('[cleanup] 无法读取 Context 页面:', error.message);
        }
        for (const page of pages) {
            if (page === anchorPage) continue;
            try {
                await page.close();
            } catch (error) {
                console.error('[cleanup] 残留 page 关闭失败:', error.message);
            }
        }
    }

    // 所有账号页关闭后，最后关闭整个任务期间保留的 anchor page。
    if (anchorPage) {
        try {
            if (!anchorPage.isClosed()) await anchorPage.close();
        } catch (error) {
            console.error('[cleanup] anchor page 关闭失败:', error.message);
        }
    }

    for (const context of contexts) {
        try {
            await context.close();
        } catch (error) {
            console.error('[cleanup] 残留 Context 关闭失败:', error.message);
        }
    }
    try {
        await browser.close();
    } catch (error) {
        console.error('[cleanup] browser.close 失败:', error.message);
    }
}

async function closeRuntimeResources() {
    await closeActiveBrowser();
    await closeActiveChrome();
}

function installSignalHandlers() {
    const handleShutdownSignal = (signal) => {
        if (shutdownRequested) return;
        shutdownRequested = true;
        console.error(`[主流程] 收到 ${signal}，开始清理 BrowserContext、page 和 browser`);

        const fallbackTimeout = setTimeout(() => {
            console.error('[主流程] 信号清理超过 8 秒，返回 FATAL');
            process.exit(EXIT_CODE.FATAL);
        }, 8000);

        shutdownPromise = closeRuntimeResources()
            .catch((error) => {
                console.error('[主流程] 信号清理失败:', error.message);
            })
            .finally(() => {
                clearTimeout(fallbackTimeout);
                process.exit(EXIT_CODE.FATAL);
            });
    };

    process.once('SIGTERM', () => handleShutdownSignal('SIGTERM'));
    process.once('SIGINT', () => handleShutdownSignal('SIGINT'));
}

(async () => {
    installSignalHandlers();
    let finalExitCode = EXIT_CODE.FATAL;
    try {
        finalExitCode = await runMain();
    } catch (error) {
        console.error('[主流程] 未处理异常:', error.message);
        finalExitCode = EXIT_CODE.FATAL;
        setLatestActionResult({
            exitCode: finalExitCode,
            status: 'error',
            message: error.message
        });
    } finally {
        await closeRuntimeResources();
    }
    writeActionResult(finalExitCode);
    process.exit(finalExitCode);
})();
