const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const http = require('http');

// --- 退出码（供外层 proxy_runner.js 使用） ---
const EXIT_CODE = {
    SUCCESS: 0,
    FATAL: 1,
    PROXY_RETRY: 42,      // Turnstile 3次仍失败 / 登录验证码阻断 → 外层换代理
    RENEW_CAPTCHA_FAILED: 43, // Renew ALTCHA 失败，不换代理但也不返回成功
    NOT_READY: 3,         // 还没到续期窗口
    ALREADY_RENEWED: 4,   // Expiry 未变化，本轮已是最新
    LOGIN_FAILED: 5       // 账号或密码错误
};

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;

// --- 辅助函数：发送 Telegram ---
async function sendTelegramMessage(message, imagePath = null) {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
    try {
        const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
        await axios.post(url, {
            chat_id: TG_CHAT_ID,
            text: message,
            parse_mode: 'Markdown'
        });
        console.log('[Telegram] Message sent.');
    } catch (e) {
        console.error('[Telegram] Failed to send message:', e.message);
    }
    if (imagePath && fs.existsSync(imagePath)) {
        console.log('[Telegram] Sending photo...');
        const cmd = `curl -s -X POST "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto" -F chat_id="${TG_CHAT_ID}" -F photo="@${imagePath}"`;
        await new Promise(resolve => {
            exec(cmd, (err) => {
                if (err) console.error('[Telegram] Failed to send photo via curl:', err.message);
                else console.log('[Telegram] Photo sent.');
                resolve();
            });
        });
    }
}

chromium.use(stealth);

const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const DEBUG_PORT = 9222;
process.env.NO_PROXY = 'localhost,127.0.0.1';

const HTTP_PROXY = process.env.HTTP_PROXY;
let PROXY_CONFIG = null;

if (HTTP_PROXY) {
    try {
        const proxyUrl = new URL(HTTP_PROXY);
        PROXY_CONFIG = {
            server: `${proxyUrl.protocol}//${proxyUrl.hostname}:${proxyUrl.port}`,
            username: proxyUrl.username ? decodeURIComponent(proxyUrl.username) : undefined,
            password: proxyUrl.password ? decodeURIComponent(proxyUrl.password) : undefined
        };
        console.log(`[代理] 检测到配置: 服务器=${PROXY_CONFIG.server}, 认证=${PROXY_CONFIG.username ? '是' : '否'}`);
    } catch (e) {
        console.error('[代理] HTTP_PROXY 格式无效。');
        process.exit(1);
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
    if (!PROXY_CONFIG) return { ok: true, error: null };
    console.log('[代理] 正在验证代理连接...');
    try {
        const axiosConfig = {
            proxy: {
                protocol: 'http',
                host: new URL(PROXY_CONFIG.server).hostname,
                port: new URL(PROXY_CONFIG.server).port,
            },
            timeout: 10000
        };
        if (PROXY_CONFIG.username && PROXY_CONFIG.password) {
            axiosConfig.proxy.auth = {
                username: PROXY_CONFIG.username,
                password: PROXY_CONFIG.password
            };
        }
        await axios.get('https://www.google.com', axiosConfig);
        console.log('[代理] 连接成功！');
        return { ok: true };
    } catch (error) {
        console.error(`[代理] 连接失败: ${error.message}`);
        return { ok: false, error: error.message };
    }
}

function checkPort(port) {
    return new Promise((resolve) => {
        const req = http.get(`http://localhost:${port}/json/version`, (res) => {
            resolve(true);
        });
        req.on('error', () => resolve(false));
        req.end();
    });
}

async function launchChrome() {
    console.log('检查 Chrome 是否已在端口 ' + DEBUG_PORT + ' 上运行...');
    if (await checkPort(DEBUG_PORT)) {
        console.log('Chrome 已开启。');
        return;
    }
    console.log(`正在启动 Chrome (路径: ${CHROME_PATH})...`);
    const args = [
        `--remote-debugging-port=${DEBUG_PORT}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        '--window-size=1280,720',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--user-data-dir=/tmp/chrome_user_data',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--lang=en-US',
        '--accept-lang=en-US,en'
    ];
    if (PROXY_CONFIG) {
        args.push(`--proxy-server=${PROXY_CONFIG.server}`);
        args.push('--proxy-bypass-list=<-loopback>');
    }
    const chrome = spawn(CHROME_PATH, args, {
        detached: true,
        stdio: 'ignore'
    });
    chrome.unref();
    console.log('正在等待 Chrome 初始化...');
    for (let i = 0; i < 20; i++) {
        if (await checkPort(DEBUG_PORT)) break;
        await new Promise(r => setTimeout(r, 1000));
    }
    if (!await checkPort(DEBUG_PORT)) {
        throw new Error('Chrome 启动失败');
    }
}

function getUsers() {
    try {
        if (process.env.USERS_JSON) {
            const parsed = JSON.parse(process.env.USERS_JSON);
            return Array.isArray(parsed) ? parsed : (parsed.users || []);
        }
    } catch (e) {
        console.error('解析 USERS_JSON 环境变量错误:', e);
    }
    return [];
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
    if (box.width <= 5 || box.height <= 5) return false;
    if (viewport) {
        if (box.x + box.width < 0 || box.y + box.height < 0) return false;
        if (box.x > viewport.width || box.y > viewport.height) return false;
    }
    return true;
}

// --- 获取 challenge frame 的页面坐标 bounding box ---
async function getChallengeFrameBox(page) {
    const frames = findChallengeFrames(page);
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
            const el = await frame.frameElement();
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
async function attemptTurnstileSingleClick(page) {
    const target = await getChallengeFrameBox(page);
    if (!target || !target.box) {
        console.log('[登录阶段] challenge frame box 未找到，无法点击');
        return { sent: false, x: null, y: null, urlBefore: null };
    }
    const { box, url } = target;
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
    console.log('[登录阶段] PlaywrightMouse 已停用（一轮只允许一次 ChallengeFrameCDP 点击）');
    return { sent: false };
}
async function attemptTurnstileIframeClick(page) {
    console.log('[登录阶段] IframeClick 已停用（一轮只允许一次 ChallengeFrameCDP 点击）');
    return { sent: false };
}

// --- 点击后独立等待 + 诊断 ---
async function waitAfterTurnstileClick(page, urlBefore, initialTimeoutMs = 15000, progressExtraMs = 12000) {
    const overallStart = Date.now();
    let sawProgress = false;
    let lastFrameUrl = urlBefore || '';
    let progressAt = 0;
    const maxTotal = initialTimeoutMs + progressExtraMs;
    console.log(`[登录阶段] state=click_sent，进入 challenge 处理等待 (初始观察 ${initialTimeoutMs}ms，检测到 progress 额外 ${progressExtraMs}ms)...`);

    let pageErrors = [];
    let consoleErrors = [];
    const errorHandler = (msg) => { if (msg.type() === 'error' || msg.type() === 'warning') consoleErrors.push(msg.text()); };
    const pageErrorHandler = (err) => { pageErrors.push(err.message); };
    try {
        page.on('pageerror', pageErrorHandler);
        page.on('console', errorHandler);
    } catch (e) {}

    try {
        while (Date.now() - overallStart < maxTotal) {
            const elapsedSinceProgress = sawProgress ? (Date.now() - progressAt) : (Date.now() - overallStart - initialTimeoutMs);
            if ((!sawProgress && Date.now() - overallStart > initialTimeoutMs)
                || (sawProgress && elapsedSinceProgress > progressExtraMs)) {
                const reason = sawProgress ? 'progress 后额外等待超时' : '初始等待超时无 progress';
                console.log(`[登录阶段] 等待结束 reason=${reason} sawProgress=${sawProgress}`);
                break;
            }

            const info = await getTurnstileTokenInfo(page);

            if (info.found && info.length > 0) {
                console.log(`[登录阶段] state=turnstile_token_ready，token length=${info.length}`);
                return { state: 'turnstile_token_ready', length: info.length, sawProgress };
            }
            if (info.verificationFailed) {
                console.log('[登录阶段] state=turnstile_verification_failed（点击后明确失败）');
                return { state: 'turnstile_verification_failed', length: 0, sawProgress };
            }

            const currentFrames = findChallengeFrames(page);
            const curUrl = currentFrames.length > 0 ? (currentFrames[0].url() || '') : '';
            let detectedProgress = false;

            if (curUrl && lastFrameUrl && curUrl !== lastFrameUrl) {
                const prevTail = lastFrameUrl.split('/').pop() || lastFrameUrl.substring(0, 30);
                const curTail = curUrl.split('/').pop() || curUrl.substring(0, 30);
                const prevHash = lastFrameUrl.split('').reduce((h,c)=>(((h<<5)-h)+c.charCodeAt(0))|0,0).toString(36).substring(0,6);
                const curHash = curUrl.split('').reduce((h,c)=>(((h<<5)-h)+c.charCodeAt(0))|0,0).toString(36).substring(0,6);
                if (!sawProgress) {
                    console.log(`[登录阶段] challenge frame 状态已变化，验证可能正在处理中，继续等待 token。`);
                    console.log(`[登录阶段] prevTail=${prevTail} curTail=${curTail} hash=${prevHash}->${curHash}`);
                }
                detectedProgress = true;
                lastFrameUrl = curUrl;
            }

            if (!curUrl && lastFrameUrl) {
                if (!sawProgress) {
                    console.log(`[登录阶段] challenge frame 已消失，检查父页面状态...`);
                    const parentCheck = await getTurnstileTokenInfo(page);
                    if (parentCheck.found && parentCheck.length > 0) {
                        console.log(`[登录阶段] frame 消失后，父页面 token 已就绪， length=${parentCheck.length}`);
                        return { state: 'turnstile_token_ready', length: parentCheck.length, sawProgress: true };
                    }
                    if (parentCheck.verificationFailed) {
                        console.log('[登录阶段] frame 消失后父页面检测到 Verification failed');
                        return { state: 'turnstile_verification_failed', length: 0, sawProgress: true };
                    }
                    const newFrames = findChallengeFrames(page);
                    if (newFrames.length > 0) {
                        const newUrl = newFrames[0].url() || '';
                        console.log(`[登录阶段] frame 消失后又出现新 challenge frame, url=${newUrl.substring(0, 90)}`);
                        detectedProgress = true;
                        lastFrameUrl = newUrl;
                    } else {
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
            }

            if (curUrl) lastFrameUrl = curUrl;

            await page.waitForTimeout(500);
        }
    } finally {
        try {
            page.removeListener('pageerror', pageErrorHandler);
            page.removeListener('console', errorHandler);
        } catch (e) {}
    }

    const finalInfo = await getTurnstileTokenInfo(page);
    if (finalInfo.found && finalInfo.length > 0) {
        console.log(`[登录阶段] state=turnstile_token_ready，token length=${finalInfo.length}`);
        return { state: 'turnstile_token_ready', length: finalInfo.length, sawProgress };
    }
    if (finalInfo.verificationFailed) {
        console.log('[登录阶段] state=turnstile_verification_failed');
        return { state: 'turnstile_verification_failed', length: 0, sawProgress };
    }
    if (pageErrors.length > 0) {
        console.log(`[Turnstile PageError] ${pageErrors.slice(0, 3).join(' | ')}`);
    }
    if (consoleErrors.length > 0) {
        console.log(`[Turnstile Console] ${consoleErrors.slice(0, 3).join(' | ')}`);
    }
    console.log(`[登录阶段] 点击后等待结束。sawProgress=${sawProgress} token length=${finalInfo.length || 0}`);
    const resultState = sawProgress ? 'challenge_progress_no_token' : 'click_no_effect';
    console.log(`[登录阶段] state=${resultState}（progress=${sawProgress} token=${finalInfo.length || 0}）`);
    return { state: resultState, length: 0, sawProgress };
}

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

// --- 读取 token / widget 状态 ---
async function getTurnstileTokenInfo(page) {
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

        const scripts = Array.from(document.querySelectorAll('script[src]')).map((s) => s.src);
        const turnstileScriptLoaded = scripts.some((s) => /challenges\.cloudflare\.com|turnstile/i.test(s));
        const turnstileApi = typeof window.turnstile !== 'undefined';

        const hasResponseField = found.length > 0;
        const cfWidgetVisible = widgetInfo.some((w) =>
            w.visible && (/cf-turnstile/i.test(w.className) || w.sitekey)
        );

        const healthyIframe = iframes.find((f) =>
            f.w >= 50 && f.h >= 20
            && f.src
            && /challenges\.cloudflare|turnstile|cloudflare/i.test(f.src + ' ' + f.title)
        );

        const deadIframe = !healthyIframe && iframes.some((f) =>
            (f.w <= 5 && f.h <= 5) || (!f.src && f.w <= 30 && f.h <= 30)
        );

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

    if (challengeFrameUrls.length > 0 && !domInfo.healthyIframe) {
        domInfo.healthyIframe = true;
        domInfo.challengeFrameUrls = challengeFrameUrls.map((u) => u.substring(0, 120));
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

// --- 清除旧 challenge 点击数据 ---
async function clearStaleTurnstileData(page) {
    try {
        await page.evaluate(() => {
            try { delete window.__turnstile_data; } catch (e) {
                try { window.__turnstile_data = undefined; } catch (e2) { }
            }
        }).catch(() => { });
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

// --- 统一状态分类 ---
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

// --- 刷新登录页并完整重走等待流程 ---
async function reloadLoginChallenge(page, reason = 'refresh') {
    console.log(`[登录阶段] 刷新登录页 challenge，原因: ${reason}`);
    await page.goto('https://dashboard.katabump.com/auth/login', {
        waitUntil: 'domcontentloaded',
        timeout: 60000
    });
    await clearStaleTurnstileData(page);
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

// --- 等待 Turnstile widget 真正就绪 ---
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

// --- 通用过盾循环（供 Renew 等阶段使用） ---
async function solveTurnstileIfPresent(page, stageName = "通用", maxAttempts = 10, waitAfterClick = 5000) {
    console.log(`[${stageName}] 开始检测 Cloudflare Turnstile...`);
    for (let i = 0; i < maxAttempts; i++) {
        const clickResult = await attemptTurnstileCdp(page);
        const clicked = !!(clickResult && (clickResult.sent === true || clickResult === true));
        if (clicked) {
            console.log(`[${stageName}] 成功点击 Turnstile，等待验证通过 (${waitAfterClick}ms)...`);
            await page.waitForTimeout(waitAfterClick);
            return true;
        }
        if (i < maxAttempts - 1) await page.waitForTimeout(1000);
    }
    console.log(`[${stageName}] 未检测到 Turnstile 或无需点击。`);
    return false;
}

// --- 登录专用：减法状态机 + 结果细分 ---
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
            console.log(`[登录阶段] Verification failed -> 刷新进入下一完整尝试`);
            try { await reloadLoginChallenge(page, 'verification_failed'); } catch (e) {}
            continue;
        }

        if (!health.ready) {
            lastState = 'turnstile_widget_not_ready';
            if (attempt >= maxAttempts) {
                return { ok: false, state: 'turnstile_widget_not_ready', message: info.challengeNotHydrated ? 'Turnstile challenge iframe never hydrated after full attempts' : `Turnstile widget not ready after ${maxAttempts} full attempts` };
            }
            console.log(`[登录阶段] widget 未就绪 -> 刷新进入下一完整尝试`);
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
            console.log('[登录阶段] 点击未发出 -> 刷新进入下一完整尝试');
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
            console.log('[登录阶段] 点击后 Verification failed -> 刷新进入下一完整尝试');
            try { await reloadLoginChallenge(page, 'verification_failed_after_click'); } catch (e) {}
            continue;
        }

        lastState = after.state;
        if (attempt >= maxAttempts) {
            return { ok: false, state: lastState, message: `after.click sent, state=${after.state}, sawProgress=${after.sawProgress}` };
        }
        console.log(`[登录阶段] click sent -> state=${after.state} (sawProgress=${after.sawProgress}) -> 刷新进入下一完整尝试`);
        try { await reloadLoginChallenge(page, after.state); } catch (e) {}
    }

    const finalInfo = await getTurnstileTokenInfo(page);
    if (finalInfo.found && finalInfo.length > 0) {
        return { ok: true, state: 'turnstile_token_ready', message: 'Turnstile token ready' };
    }
    console.log(`[登录阶段] 结束。state=${lastState} token length=${finalInfo.length || 0}`);
    return { ok: false, state: lastState || 'turnstile_token_missing', message: `Turnstile finished without token (state=${lastState})` };
}

// --- 等待 Turnstile token 真正生成 ---
async function waitForTurnstileToken(page, timeoutMs = 30000) {
    const startedAt = Date.now();
    console.log(`[登录阶段] 等待 Turnstile token 生成 (最长 ${timeoutMs}ms)...`);

    while (Date.now() - startedAt < timeoutMs) {
        const tokenInfo = await getTurnstileTokenInfo(page);

        if (tokenInfo.found) {
            console.log(`[登录阶段] Turnstile token 已生成，字段=${tokenInfo.selector}，长度=${tokenInfo.length}`);
            return true;
        }

        await page.waitForTimeout(1000);
    }

    const finalInfo = await getTurnstileTokenInfo(page);
    console.log(`[登录阶段] Turnstile token 等待超时，未提交登录表单。fields=${JSON.stringify(finalInfo.fields)} iframes=${JSON.stringify(finalInfo.iframes)}`);
    return false;
}

// ============================================================
//  辅助函数
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
    try {
        await page.screenshot({ path: path.join(photoDir, `${name}.png`), fullPage: true });
        console.log(`[Debug] 截图已保存: ${name}.png`);
    } catch (e) { }
    try {
        const html = await page.content();
        fs.writeFileSync(path.join(photoDir, `${name}.html`), html, 'utf-8');
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

/** 检测验证码/checkbox 阻断 */
function detectCaptchaRequired(text) {
    if (/Please check this box if you want to proceed/i.test(text)) {
        return 'Please check this box if you want to proceed';
    }
    if (/Please complete the captcha to continue/i.test(text)) {
        return 'Please complete the captcha to continue';
    }
    return null;
}

/** 检测 ALTCHA checkbox 实际是否已勾选 */
async function isAltchaCheckboxChecked(page, modal) {
    try {
        const checked = await modal.locator('input[type="checkbox"]:checked').count();
        if (checked > 0) return true;
    } catch (e) { }

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
        const expiryMatch = html.match(/Expiry[^<]{0,60}?(\d{4}-\d{2}-\d{2}|[A-Z][a-z]+ \d{1,2},? \d{4})/i);
        if (expiryMatch) {
            console.log(`[Expiry] 从 HTML 读取: ${expiryMatch[1]}`);
            return expiryMatch[1].trim();
        }
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
    const cdpRes = await attemptTurnstileCdp(page);
    const clickedCdp = !!(cdpRes && (cdpRes.sent === true || cdpRes === true));
    if (clickedCdp) {
        console.log('[Captcha] CDP 点击成功，等待验证...');
        await page.waitForTimeout(3000);
        return true;
    }

    try {
        const modalBox = await modal.boundingBox();
        const checkboxes = await page.locator('input[type="checkbox"]').all();
        for (const cb of checkboxes) {
            try {
                const box = await cb.boundingBox();
                if (!box || !modalBox) continue;
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
//  主流程
// ============================================================
(async () => {
    const users = getUsers();
    if (users.length === 0) {
        console.log('未在 process.env.USERS_JSON 中找到用户');
        process.exit(1);
    }

    if (PROXY_CONFIG) {
        const checkResult = await checkProxy();
        if (checkResult.ok === false) {
            console.error('[代理] 连接失败，标记 PROXY_RETRY:', checkResult.error || 'unknown');
            process.exit(EXIT_CODE.PROXY_RETRY);
        }
    }

    await launchChrome();

    console.log('正在连接 Chrome...');
    let browser;
    for (let k = 0; k < 5; k++) {
        try {
            browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`);
            console.log('连接成功！');
            break;
        } catch (e) {
            console.log(`连接尝试 ${k + 1} 失败。2秒后重试...`);
            await new Promise(r => setTimeout(r, 2000));
        }
    }
    if (!browser) process.exit(1);

    const context = browser.contexts()[0];
    let page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
    page.setDefaultTimeout(60000);

    if (PROXY_CONFIG && PROXY_CONFIG.username) {
        await context.setHTTPCredentials({
            username: PROXY_CONFIG.username,
            password: PROXY_CONFIG.password
        });
    } else {
        await context.setHTTPCredentials(null);
    }

    await page.addInitScript(INJECTED_SCRIPT);

    let overallExitCode = EXIT_CODE.SUCCESS;
    let loginCaptchaFailed = false;
    let shouldStopAllUsers = false;

    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        console.log(`\n=== 正在处理用户 ${i + 1}/${users.length} ===`);

        let renewSuccess = false;
        let runStatus = 'unknown';
        let blockMessage = '';

        try {
            // 每个账号独立会话，清除上一账号的 Cookie 和存储
            try { await context.clearCookies(); } catch(e) {}
            try { await page.evaluate(() => { try { localStorage.clear(); } catch(e){} try { sessionStorage.clear(); } catch(e){} }).catch(() => {}); } catch(e) {}

            const oldPage = page;
            page = await context.newPage();
            await page.addInitScript(INJECTED_SCRIPT);

            // 1. Access login page
            console.log('Accessing login page...');
            await page.goto('https://dashboard.katabump.com/auth/login', { waitUntil: 'domcontentloaded', timeout: 60000 });

            await page.waitForTimeout(3000);

            try {
                await page.mouse.move(100, 100, { steps: 5 });
                await page.waitForTimeout(300);
                await page.mouse.move(400, 300, { steps: 8 });
                await page.waitForTimeout(200);
            } catch (e) { }

            const turnstileResult = await solveLoginTurnstile(page, 180000);
            if (!turnstileResult.ok) {
                const state = turnstileResult.state || 'turnstile_token_missing';
                console.error(`   >> Warning: Turnstile failed. state=${state} message=${turnstileResult.message}`);
                runStatus = 'login_captcha_required';
                blockMessage = turnstileResult.message || state;
                renewSuccess = false;
                const snapName = state === 'turnstile_verification_failed'
                    ? `login_turnstile_verification_failed_${user.username.replace(/[^a-z0-9]/gi, '_')}`
                    : state === 'turnstile_widget_not_ready'
                        ? `login_turnstile_widget_not_ready_${user.username.replace(/[^a-z0-9]/gi, '_')}`
                        : state === 'turnstile_click_target_missing'
                            ? `login_turnstile_click_target_missing_${user.username.replace(/[^a-z0-9]/gi, '_')}`
                            : `login_turnstile_token_missing_${user.username.replace(/[^a-z0-9]/gi, '_')}`;
                await dumpDebugSnapshot(page, snapName);
                overallExitCode = EXIT_CODE.PROXY_RETRY;
                loginCaptchaFailed = true;
                shouldStopAllUsers = true;
            }

            // FIX #3: Wrap post-login steps in shouldStopAllUsers guard
            if (!shouldStopAllUsers) {
                console.log('Entering credentials...');
                try {
                    const emailInput = page.getByRole('textbox', { name: 'Email' });
                    await emailInput.waitFor({ state: 'visible', timeout: 5000 });
                    await emailInput.fill(user.username);

                    const pwdInput = page.getByRole('textbox', { name: 'Password' });
                    await pwdInput.fill(user.password);

                    await page.waitForTimeout(500);

                    const tokenStillValid = await getTurnstileTokenInfo(page);

                    if (!tokenStillValid.found) {
                        console.error('   >> Warning: Token lost before submit.');
                        runStatus = 'login_captcha_required';
                        blockMessage = 'Turnstile token disappeared before login submit';
                        renewSuccess = false;
                        await dumpDebugSnapshot(
                            page,
                            `login_turnstile_token_lost_${user.username.replace(/[^a-z0-9]/gi, '_')}`
                        );
                        overallExitCode = EXIT_CODE.PROXY_RETRY;
                        shouldStopAllUsers = true;
                    }
                    if (!shouldStopAllUsers) {
                        console.log(`[Login] Token valid, submitting...`);

                        await page.getByRole('button', { name: 'Login', exact: true }).click();

                        await page.waitForTimeout(2000);
                        const pd = await ensureScreenshotsDir();
                        await page.screenshot({ path: path.join(pd, `login_after_submit_${user.username.replace(/[^a-z0-9]/gi, '_')}.png`), fullPage: true });
                        try {
                            const html = await page.content();
                            fs.writeFileSync(path.join(pd, `login_after_submit_${user.username.replace(/[^a-z0-9]/gi, '_')}.html`), html, 'utf-8');
                        } catch (e) { }
                        const loginUrl = page.url();
                        const loginBody = await getPageText(page);
                        console.log(`[Login] URL: ${loginUrl}`);

                        try {
                            const errorMsg = page.getByText('Incorrect password or no account');
                            if (await errorMsg.isVisible({ timeout: 3000 })) {
                                console.error('   >> Error: Incorrect password or no account');
                                runStatus = 'login_failed';
                                blockMessage = 'Incorrect password or no account';
                                const pd2 = await ensureScreenshotsDir();
                                await page.screenshot({ path: path.join(pd2, `login_failed_${user.username.replace(/[^a-z0-9]/gi, '_')}.png`), fullPage: true });
                                overallExitCode = EXIT_CODE.LOGIN_FAILED;
                                shouldStopAllUsers = true;
                            }
                        } catch (e) { }

                        if (!shouldStopAllUsers) {
                            const captchaUrlHit = /error=captcha/i.test(loginUrl);
                            const captchaTextHit = /Please complete captcha/i.test(loginBody)
                                || /captcha required/i.test(loginBody)
                                || /complete captcha/i.test(loginBody);
                            if (captchaUrlHit || captchaTextHit) {
                                console.error(`   >> Warning: Login captcha not accepted`);
                                runStatus = 'login_captcha_required';
                                blockMessage = 'Login captcha was not accepted';
                                renewSuccess = false;
                                const pd3 = await ensureScreenshotsDir();
                                await page.screenshot({ path: path.join(pd3, `login_captcha_required_${user.username.replace(/[^a-z0-9]/gi, '_')}.png`), fullPage: true });
                                try {
                                    const h3 = await page.content();
                                    fs.writeFileSync(path.join(pd3, `login_captcha_required_${user.username.replace(/[^a-z0-9]/gi, '_')}.html`), h3, 'utf-8');
                                } catch (e) { }
                                overallExitCode = EXIT_CODE.PROXY_RETRY;
                                shouldStopAllUsers = true;
                            }
                        }
                    }
                } catch (e) {
                    console.log('Login exception:', e.message);
                }
            }

            if (!shouldStopAllUsers) {
                if (/error=captcha/i.test(page.url())) {
                    console.error(`   >> Warning: Login captcha not accepted (URL check)`);
                    runStatus = 'login_captcha_required';
                    blockMessage = 'Login captcha was not accepted';
                    renewSuccess = false;
                    const pd = await ensureScreenshotsDir();
                    await page.screenshot({ path: path.join(pd, `login_captcha_required_${user.username.replace(/[^a-z0-9]/gi, '_')}.png`), fullPage: true });
                    try {
                        const ht = await page.content();
                        fs.writeFileSync(path.join(pd, `login_captcha_required_${user.username.replace(/[^a-z0-9]/gi, '_')}.html`), ht, 'utf-8');
                    } catch (e) { }
                    overallExitCode = EXIT_CODE.PROXY_RETRY;
                    shouldStopAllUsers = true;
                }

                if (!shouldStopAllUsers) {
                    console.log('Looking for dashboard...');
                    let dashboardReady = false;

                    try {
                        await page.waitForURL(url => /dashboard/i.test(url) && !/auth\/login/i.test(url), { timeout: 5000 });
                        console.log('[Login] URL is dashboard.');
                        dashboardReady = true;
                    } catch (e) { }

                    if (!dashboardReady) {
                        const bodyText = await getPageText(page);
                        if (/dashboard/i.test(bodyText) && /server/i.test(bodyText) && !/Please complete captcha/i.test(bodyText)) {
                            console.log('[Login] Text detected dashboard + server.');
                            dashboardReady = true;
                        }
                    }

                    if (!dashboardReady) {
                        try {
                            const seeBtn = page.getByRole('link', { name: 'See' }).first();
                            await seeBtn.waitFor({ timeout: 5000 });
                            console.log('[Login] Found See button.');
                            dashboardReady = true;
                        } catch (e) { }
                    }

                    if (!dashboardReady) {
                        const altBtns = ['Access server', 'View', 'Manage', 'Servers', 'My Servers'];
                        for (const btnName of altBtns) {
                            try {
                                const btn = page.getByRole('link', { name: btnName }).first();
                                await btn.waitFor({ timeout: 2000 });
                                console.log(`[Login] Found "${btnName}" button.`);
                                dashboardReady = true;
                                break;
                            } catch (e) { }
                        }
                    }

                    if (!dashboardReady) {
                        const finalUrl = page.url();
                        const finalBody = await getPageText(page);
                        if (/error=captcha/i.test(finalUrl) || /Please complete captcha/i.test(finalBody) || /complete captcha/i.test(finalBody)) {
                            console.error(`   >> Warning: Login captcha not accepted (final check)`);
                            runStatus = 'login_captcha_required';
                            blockMessage = 'Login captcha was not accepted';
                            renewSuccess = false;
                            const pd = await ensureScreenshotsDir();
                            await page.screenshot({ path: path.join(pd, `login_captcha_required_${user.username.replace(/[^a-z0-9]/gi, '_')}.png`), fullPage: true });
                            try {
                                const ht = await page.content();
                                fs.writeFileSync(path.join(pd, `login_captcha_required_${user.username.replace(/[^a-z0-9]/gi, '_')}.html`), ht, 'utf-8');
                            } catch (e) { }
                            overallExitCode = EXIT_CODE.PROXY_RETRY;
                            shouldStopAllUsers = true;
                        }

                        if (!shouldStopAllUsers) {
                            console.log('login_failed: Dashboard entry not found.');
                            runStatus = 'login_failed';
                            blockMessage = 'Dashboard entry not found after login';
                            const pd = await ensureScreenshotsDir();
                            await page.screenshot({ path: path.join(pd, `login_failed_no_dashboard_${user.username.replace(/[^a-z0-9]/gi, '_')}.png`), fullPage: true });
                            overallExitCode = EXIT_CODE.LOGIN_FAILED;
                            shouldStopAllUsers = true;
                        }
                    }

                    if (!shouldStopAllUsers && dashboardReady) {
                        try {
                            const seeBtn = page.getByRole('link', { name: 'See' }).first();
                            if (await seeBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
                                await seeBtn.click();
                                console.log('[Login] Clicked See button.');
                            }
                        } catch (e) { }
                    }
                }
            }

            // 3. Renew main loop
            if (!shouldStopAllUsers) {
                for (let attempt = 1; attempt <= 20; attempt++) {
                    console.log(`\n[Attempt ${attempt}/20] Looking for Renew button...`);
                    const renewBtn = page.getByRole('button', { name: 'Renew', exact: true }).first();

                    try { await renewBtn.waitFor({ state: 'visible', timeout: 5000 }); } catch (e) { }

                    if (!(await renewBtn.isVisible().catch(() => false))) {
                        console.log('Renew button not found.');
                        break;
                    }

                    await renewBtn.click();
                    console.log('Renew clicked. Waiting for modal...');

                    const modal = await findRenewModal(page);
                    if (!modal) {
                        console.log('Modal not found, retrying...');
                        const pd = await ensureScreenshotsDir();
                        await page.screenshot({ path: path.join(pd, `renew_modal_not_found_${attempt}.png`), fullPage: true });
                        continue;
                    }
                    console.log('Renew modal detected.');

                    try {
                        const box = await modal.boundingBox();
                        if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
                    } catch (e) { }

                    const modalText = await getLocatorText(modal);
                    console.log(`[Modal] Text: ${modalText.substring(0, 200)}`);

                    const hasCfInModal = await modal.locator('.cf-turnstile, iframe[src*="challenges.cloudflare.com"]').count().catch(() => 0) > 0;
                    const hasAltchaInModal2 = /Protected by ALTCHA/i.test(modalText)
                        || await modal.locator('altcha-widget, [data-altcha], .altcha').count().catch(() => 0) > 0;
                    console.log(`[Renew] Type: ${hasAltchaInModal2 ? 'ALTCHA' : hasCfInModal ? 'CF Turnstile' : 'None'}`);

                    if (hasCfInModal && !hasAltchaInModal2) {
                        const tsResult = await solveTurnstileIfPresent(page, "Renew", 15, 6000);
                        console.log(`[Renew] Turnstile: ${tsResult ? 'handled' : 'not detected'}`);
                    } else if (hasAltchaInModal2) {
                        console.log('[Renew] ALTCHA, handled below.');
                    }

                    const oldExpiry = await readExpiryDate(page);
                    console.log(`[Expiry] Before: ${oldExpiry || 'not found'}`);

                    const notReadyBefore = detectNotReady(await getPageText(page));
                    const notReadyInModal = modalText.includes("You can't renew your server yet") || modalText.includes("You will be able to as of")
                        ? modalText.substring(0, 200) : null;

                    if (notReadyBefore || notReadyInModal) {
                        const reason = (notReadyBefore && typeof notReadyBefore === "string") ? notReadyBefore
                            : (notReadyBefore && notReadyBefore.raw) ? notReadyBefore.raw : notReadyInModal;
                        console.log('   >> Not ready (before click).');
                        runStatus = 'not_ready';
                        blockMessage = reason;
                        renewSuccess = false;
                        const pd = await ensureScreenshotsDir();
                        await dumpDebugSnapshot(page, `not_ready_${attempt}`);
                        break;
                    }

                    const hasAltchaInModal = /Protected by ALTCHA/i.test(modalText)
                        || await modal.locator('altcha-widget, [data-altcha], .altcha').count().catch(() => 0) > 0;
                    if (hasAltchaInModal) {
                        console.log('[ALTCHA] Detected, completing checkbox...');
                        const cbCheckedBefore = await isAltchaCheckboxChecked(page, modal);
                        if (!cbCheckedBefore) {
                            const cbClicked = await tryClickCaptchaCheckbox(page, modal);
                            if (cbClicked) {
                                await page.waitForTimeout(3000);
                                const cbCheckedAfter = await isAltchaCheckboxChecked(page, modal);
                                if (!cbCheckedAfter) {
                                    runStatus = 'captcha_required';
                                    blockMessage = 'ALTCHA checkbox click did not result in checked state';
                                    renewSuccess = false;
                                    const pd = await ensureScreenshotsDir();
                                    await dumpDebugSnapshot(page, `captcha_required_${attempt}`);
                                    break;
                                }
                                console.log('[ALTCHA] Checkbox checked.');
                            } else {
                                runStatus = 'captcha_required';
                                blockMessage = 'ALTCHA checkbox could not be auto-clicked';
                                renewSuccess = false;
                                const pd = await ensureScreenshotsDir();
                                await dumpDebugSnapshot(page, `captcha_required_${attempt}`);
                                break;
                            }
                        } else {
                            console.log('[ALTCHA] Already checked.');
                        }
                    }

                    const confirmBtn = modal.getByRole('button', { name: 'Renew' });
                    if (!(await confirmBtn.isVisible().catch(() => false))) {
                        console.log('Confirm not visible, refreshing...');
                        continue;
                    }

                    console.log('   >> Clicking confirm Renew...');
                    await confirmBtn.click();
                    await page.waitForTimeout(2000);

                    const pageTextAfterClick = await getPageText(page);
                    const modalTextAfterClick = await modal.innerText().catch(() => '');
                    const modalVisibleAfterClick = await modal.isVisible().catch(() => false);
                    const currentUrlAfterClick = page.url();
                    console.log(`[Diag] URL: ${currentUrlAfterClick}`);
                    console.log(`[Diag] Modal visible: ${modalVisibleAfterClick}`);
                    console.log(`[Diag] Text: ${pageTextAfterClick.substring(0, 300)}`);

                    const notReadyAfter = detectNotReady(pageTextAfterClick);
                    if (notReadyAfter) {
                        console.log('   >> Not ready (after click).');
                        runStatus = 'not_ready';
                        blockMessage = typeof notReadyAfter === 'string' ? notReadyAfter : notReadyAfter['raw'];
                        renewSuccess = false;
                        const pd = await ensureScreenshotsDir();
                        await dumpDebugSnapshot(page, `not_ready_after_${attempt}`);
                        break;
                    }

                    const captchaIssue = detectCaptchaRequired(pageTextAfterClick);
                    if (captchaIssue) {
                        console.log(`   >> Captcha block: ${captchaIssue}`);
                        const cbClicked = await tryClickCaptchaCheckbox(page, modal);
                        if (cbClicked) {
                            await page.waitForTimeout(3000);
                            const pageTextAfterCb = await getPageText(page);
                            const modalTextAfterCb = await getLocatorText(modal);

                            const notReadyInModalAfterCb = modalTextAfterCb.includes("You can't renew your server yet")
                                || modalTextAfterCb.includes("You will be able to as of");
                            if (notReadyInModalAfterCb) {
                                runStatus = 'not_ready';
                                blockMessage = modalTextAfterCb.substring(0, 200);
                                renewSuccess = false;
                                await dumpDebugSnapshot(page, `not_ready_after_cb_${attempt}`);
                                break;
                            }

                            const newExpiryAfterCb = await readExpiryDate(page);
                            console.log(`[Expiry] After checkbox: ${newExpiryAfterCb || 'not found'}`);

                            const stillBlocked = detectCaptchaRequired(pageTextAfterCb);
                            if (stillBlocked) {
                                runStatus = 'captcha_required';
                                blockMessage = stillBlocked;
                                renewSuccess = false;
                                await dumpDebugSnapshot(page, `captcha_required_${attempt}`);
                                break;
                            }

                            console.log('   >> Checkbox verified, clicking confirm again...');
                            const confirmBtnAfterCb = modal.getByRole('button', { name: 'Renew' });
                            if (await confirmBtnAfterCb.isVisible().catch(() => false)) {
                                await confirmBtnAfterCb.click();
                                await page.waitForTimeout(3000);

                                const pageTextFinal = await getPageText(page);
                                const successFinal = detectRenewSuccess(pageTextFinal);
                                if (successFinal) {
                                    runStatus = 'success';
                                    renewSuccess = true;
                                    const pd = await ensureScreenshotsDir();
                                    await page.screenshot({ path: path.join(pd, `renew_success_${attempt}.png`), fullPage: true });
                                    break;
                                }

                                const stillVisibleFinal = await modal.isVisible({ timeout: 2000 }).catch(() => false);
                                if (!stillVisibleFinal) {
                                    await page.waitForTimeout(2000);
                                    const newExpiryFinal = await readExpiryDate(page);
                                    console.log(`[Expiry] After second confirm: ${newExpiryFinal || 'not found'}`);
                                    if (newExpiryFinal && oldExpiry && newExpiryFinal !== oldExpiry) {
                                        runStatus = 'success';
                                        renewSuccess = true;
                                        const pd = await ensureScreenshotsDir();
                                        await page.screenshot({ path: path.join(pd, `renew_success_${attempt}.png`), fullPage: true });
                                        break;
                                    }
                                    runStatus = 'already_renewed';
                                    break;
                                }
                            }
                            await page.reload();
                            await page.waitForTimeout(3000);
                            continue;
                        } else {
                            runStatus = 'captcha_required';
                            blockMessage = captchaIssue;
                            renewSuccess = false;
                            const pd = await ensureScreenshotsDir();
                            await dumpDebugSnapshot(page, `captcha_required_${attempt}`);
                            break;
                        }
                    }

                    const successText = detectRenewSuccess(pageTextAfterClick);
                    if (successText) {
                        runStatus = 'success';
                        renewSuccess = true;
                        const pd = await ensureScreenshotsDir();
                        await page.screenshot({ path: path.join(pd, `renew_success_${attempt}.png`), fullPage: true });
                        break;
                    }

                    const stillVisible = await modal.isVisible({ timeout: 2000 }).catch(() => false);
                    if (!stillVisible) {
                        console.log('   >> Modal closed, reading Expiry...');
                        await page.waitForTimeout(2000);
                        const newExpiry = await readExpiryDate(page);
                        console.log(`[Expiry] After: ${newExpiry || 'not found'}`);

                        if (newExpiry && oldExpiry && newExpiry !== oldExpiry) {
                            runStatus = 'success';
                            renewSuccess = true;
                            const pd = await ensureScreenshotsDir();
                            await page.screenshot({ path: path.join(pd, `renew_success_${attempt}.png`), fullPage: true });
                            break;
                        } else if (newExpiry === oldExpiry && newExpiry !== null) {
                            runStatus = 'already_renewed';
                            renewSuccess = false;
                            const pd = await ensureScreenshotsDir();
                            await dumpDebugSnapshot(page, `expiry_unchanged_${attempt}`);
                            break;
                        } else {
                            // FIX #1: was true/'success', now correctly false/'unknown'
                            console.log('   >> Modal closed, cannot read Expiry, marking unknown.');
                            renewSuccess = false;
                            runStatus = 'unknown';
                            break;
                        }
                    }

                    console.log('   >> Modal still open, diagnosing...');
                    const blockingState = detectCaptchaRequired(pageTextAfterClick);
                    if (blockingState) {
                        runStatus = 'captcha_required';
                        blockMessage = blockingState;
                        renewSuccess = false;
                        const pd = await ensureScreenshotsDir();
                        await dumpDebugSnapshot(page, `modal_blocked_${attempt}`);
                        break;
                    }

                    if (/You can't renew your server yet/i.test(modalTextAfterClick)) {
                        runStatus = 'not_ready';
                        blockMessage = modalTextAfterClick.substring(0, 200);
                        renewSuccess = false;
                        const pd = await ensureScreenshotsDir();
                        await dumpDebugSnapshot(page, `not_ready_in_modal_${attempt}`);
                        break;
                    }

                    console.log(`   >> Modal still open after confirm.`);
                    console.log(`   >> Text: ${modalTextAfterClick.substring(0, 300)}`);
                    console.log(`   >> URL: ${currentUrlAfterClick}`);
                    const pd = await ensureScreenshotsDir();
                    await dumpDebugSnapshot(page, `modal_unknown_state_${attempt}`);

                    try {
                        const domDiag = await page.evaluate((sel) => {
                            const results = {};
                            const modalEl = document.querySelector(sel);
                            results.modalFound = !!modalEl;
                            if (modalEl) {
                                results.inputs = Array.from(modalEl.querySelectorAll('input')).map(el => ({
                                    tag: el.tagName, type: el.type, name: el.name,
                                    checked: el.checked
                                }));
                                results.checkboxes = Array.from(modalEl.querySelectorAll('input[type="checkbox"]')).map(el => ({
                                    checked: el.checked, id: el.id
                                }));
                                results.iframes = Array.from(modalEl.querySelectorAll('iframe')).map(el => ({
                                    src: el.src, id: el.id
                                }));
                                results.hasShadowRoot = !!modalEl.shadowRoot;
                            }
                            return results;
                        }, '#renew-modal, [role="dialog"], .modal');
                        console.log('[Diag] DOM:', JSON.stringify(domDiag, null, 2));
                        const dp = path.join(pd, `dom_diag_${attempt}.json`);
                        fs.writeFileSync(dp, JSON.stringify(domDiag, null, 2), 'utf-8');
                    } catch (e) { }

                    await page.reload();
                    await page.waitForTimeout(3000);
                }
            }

        } catch (err) {
            console.error('Error processing user:', err);
            runStatus = 'error';
            blockMessage = err.message;
            const pd = await ensureScreenshotsDir();
            try {
                await page.screenshot({ path: path.join(pd, `error_${user.username.replace(/[^a-z0-9]/gi, '_')}.png`), fullPage: true });
            } catch (e) { }
        }

        const safeUsername = user.username.replace(/[^a-z0-9]/gi, '_');
        const photoDir = await ensureScreenshotsDir();
        try {
            await page.screenshot({ path: path.join(photoDir, `${safeUsername}.png`), fullPage: true });
        } catch (e) { }

        if (runStatus === 'unknown' || runStatus === 'unknown_blocked') {
            runStatus = 'error';
            blockMessage = 'Renew loop exhausted without clear result';
        }

        // FIX #4: Added login_captcha_required Telegram branch
        if (runStatus === 'success') {
            await sendTelegramMessage(`KataBump Renew Complete\nUser: ${user.username}\nStatus: Success`);
        } else if (runStatus === 'not_ready') {
            await sendTelegramMessage(`KataBump Not Ready\nUser: ${user.username}\nReason: ${blockMessage}`);
        } else if (runStatus === 'captcha_required') {
            await sendTelegramMessage(`KataBump Captcha Blocked\nUser: ${user.username}\nReason: ${blockMessage}`);
        } else if (runStatus === 'login_captcha_required') {
            await sendTelegramMessage(`KataBump Login Captcha Blocked\nUser: ${user.username}\nReason: ${blockMessage}\nPlease resolve captcha and retry.`);
        } else if (runStatus === 'login_failed') {
            await sendTelegramMessage(`KataBump Login Failed\nUser: ${user.username}\nReason: ${blockMessage}`);
        } else if (runStatus === 'already_renewed') {
            await sendTelegramMessage(`KataBump Already Renewed\nUser: ${user.username}\nExpiry unchanged.`);
        }

        if (runStatus === 'login_captcha_required') {
            loginCaptchaFailed = true;
        }
        if (runStatus === 'captcha_required') {
            if (overallExitCode === EXIT_CODE.SUCCESS ||
                overallExitCode === EXIT_CODE.NOT_READY ||
                overallExitCode === EXIT_CODE.ALREADY_RENEWED) {
                overallExitCode = EXIT_CODE.RENEW_CAPTCHA_FAILED;
            }
        }
        if (runStatus === 'error') { overallExitCode = EXIT_CODE.FATAL; shouldStopAllUsers = true; }
        if (runStatus === 'login_failed') { overallExitCode = EXIT_CODE.LOGIN_FAILED; shouldStopAllUsers = true; }
        if (runStatus === 'success' && overallExitCode === EXIT_CODE.SUCCESS) overallExitCode = EXIT_CODE.SUCCESS;
        if (runStatus === 'not_ready' && overallExitCode === EXIT_CODE.SUCCESS) overallExitCode = EXIT_CODE.NOT_READY;
        if (runStatus === 'already_renewed' && overallExitCode === EXIT_CODE.SUCCESS) overallExitCode = EXIT_CODE.ALREADY_RENEWED;

        console.log(`User done | Status: ${runStatus}`);

        if (shouldStopAllUsers) {
            console.log('[Main] Stopping further users');
            break;
        }
    }

    console.log('\nAll users processed.');

    try {
        const contexts = browser.contexts();
        for (const ctx of contexts) {
            for (const p of ctx.pages()) await p.close().catch(() => {});
            await ctx.close().catch(() => {});
        }
        await browser.close().catch(() => {});
    } catch (e) {
        console.log('[cleanup] browser close error:', e.message);
    }

    if (overallExitCode === EXIT_CODE.FATAL)
        process.exit(EXIT_CODE.FATAL);
    if (overallExitCode === EXIT_CODE.LOGIN_FAILED)
        process.exit(EXIT_CODE.LOGIN_FAILED);
    if (loginCaptchaFailed)
        process.exit(EXIT_CODE.PROXY_RETRY);
    if (overallExitCode === EXIT_CODE.RENEW_CAPTCHA_FAILED)
        process.exit(EXIT_CODE.RENEW_CAPTCHA_FAILED);
    process.exit(overallExitCode);
})();
