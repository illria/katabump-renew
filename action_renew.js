const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const http = require('http');

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
    if (!PROXY_CONFIG) return true;
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
        return true;
    } catch (error) {
        console.error(`[代理] 连接失败: ${error.message}`);
        return false;
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

// 策略返回值统一：{ sent: boolean } 表示是否实际发出至少一次点击
// --- 核心：基于 challenge frame 点击（每次重新 getChallengeFrameBox） ---
async function attemptTurnstileChallengeFrameClick(page) {
    const target = await getChallengeFrameBox(page); // 每次重新获取，不复用旧 frame
    if (!target || !target.box) {
        console.log('>> challenge frame box 未找到');
        return { sent: false };
    }
    const { box, url } = target;
    console.log(`[登录阶段] challenge box: x=${box.x.toFixed(1)} y=${box.y.toFixed(1)} w=${box.width.toFixed(1)} h=${box.height.toFixed(1)} source=${target.source} url=${(url || '').substring(0, 80)}`);

    const points = [
        { x: box.x + Math.min(28, box.width * 0.15), y: box.y + box.height / 2, label: 'left-28' },
        { x: box.x + Math.min(35, box.width * 0.2), y: box.y + box.height / 2, label: 'left-35' },
        { x: box.x + box.width * 0.12, y: box.y + box.height * 0.5, label: '12%' },
        { x: box.x + box.width * 0.5, y: box.y + box.height * 0.5, label: 'center' }
    ];

    try {
        // 仅用当前 challenge frame 的 __turnstile_data（若有）
        if (target.frame) {
            const data = await target.frame.evaluate(() => window.__turnstile_data).catch(() => null);
            if (data && typeof data.xRatio === 'number') {
                points.unshift({
                    x: box.x + box.width * data.xRatio,
                    y: box.y + box.height * data.yRatio,
                    label: 'injected-ratio'
                });
            }
        }
    } catch (e) { }

    let anySent = false;
    for (const pt of points) {
        try {
            await page.mouse.move(pt.x - 30, pt.y - 15, { steps: 6 });
            await page.waitForTimeout(80 + Math.random() * 100);
            const ok = await cdpClickAt(page, pt.x, pt.y, pt.label);
            if (ok) anySent = true;
            console.log(`[登录阶段] 点击事件实际发送=${ok} strategy=ChallengeFrameCDP point=${pt.label}`);
            await page.waitForTimeout(400 + Math.random() * 300);
        } catch (e) {
            console.log(`>> 点击 ${pt.label} 失败: ${e.message}`);
        }
    }
    return { sent: anySent };
}

// --- 旧 CDP fallback ---
async function attemptTurnstileCdp(page) {
    // 避免重复整套 ChallengeFrame 点击：只做 legacy __turnstile_data
    const frames = findChallengeFrames(page);
    for (const frame of frames) {
        try {
            const data = await frame.evaluate(() => window.__turnstile_data).catch(() => null);
            if (!data) continue;
            const iframeElement = await frame.frameElement();
            if (!iframeElement) continue;
            const box = await iframeElement.boundingBox();
            if (!isValidClickBox(box, page.viewportSize())) continue;
            const clickX = box.x + (box.width * data.xRatio);
            const clickY = box.y + (box.height * data.yRatio);
            const ok = await cdpClickAt(page, clickX, clickY, 'legacy-ratio');
            console.log(`[登录阶段] 点击事件实际发送=${ok} strategy=CDP`);
            return { sent: ok };
        } catch (e) { }
    }
    return { sent: false };
}

// --- Playwright 鼠标：每次重新 getChallengeFrameBox ---
async function attemptTurnstilePlaywrightMouse(page) {
    const target = await getChallengeFrameBox(page);
    if (!target || !target.box) {
        console.log('>> PlaywrightMouse: 无有效 challenge frame box');
        return { sent: false };
    }
    const { box } = target;
    const candidates = [
        { x: box.x + 28, y: box.y + box.height / 2, label: 'left-checkbox' },
        { x: box.x + 35, y: box.y + box.height * 0.5, label: 'left-35' },
        { x: box.x + box.width * 0.5, y: box.y + box.height * 0.5, label: 'center' }
    ];

    let anySent = false;
    for (const pt of candidates) {
        try {
            console.log(`>> Playwright mouse 策略=${pt.label} 坐标=(${pt.x.toFixed(1)}, ${pt.y.toFixed(1)})`);
            await page.mouse.move(pt.x - 40, pt.y - 20, { steps: 8 });
            await page.waitForTimeout(100 + Math.random() * 150);
            await page.mouse.move(pt.x, pt.y, { steps: 6 });
            await page.waitForTimeout(80 + Math.random() * 120);
            await page.mouse.down();
            await page.waitForTimeout(40 + Math.random() * 80);
            await page.mouse.up();
            anySent = true;
            console.log(`[登录阶段] 点击事件实际发送=true strategy=PlaywrightMouse point=${pt.label}`);
            await page.waitForTimeout(500);
        } catch (e) {
            console.log(`[登录阶段] 点击事件实际发送=false strategy=PlaywrightMouse point=${pt.label} err=${e.message}`);
        }
    }
    return { sent: anySent };
}

// --- frameElement / 容器点击：每次重新扫描 frames ---
async function attemptTurnstileIframeClick(page) {
    const challengeFrames = findChallengeFrames(page);
    console.log(`>> 找到 challenge frames 数量: ${challengeFrames.length}`);
    for (const frame of challengeFrames) {
        try {
            const el = await frame.frameElement();
            if (!el) continue;
            const box = await el.boundingBox();
            if (!isValidClickBox(box, page.viewportSize())) continue;
            const x = box.x + Math.min(30, Math.max(10, box.width * 0.15));
            const y = box.y + box.height / 2;
            console.log(`>> frameElement.click 坐标=(${x.toFixed(1)}, ${y.toFixed(1)}) w=${box.width.toFixed(1)} h=${box.height.toFixed(1)}`);
            await page.mouse.move(x, y, { steps: 5 });
            await page.waitForTimeout(100);
            await page.mouse.click(x, y);
            console.log('[登录阶段] 点击事件实际发送=true strategy=IframeClick');
            await page.waitForTimeout(500);
            try {
                await frame.click('body', { position: { x: 20, y: Math.floor(box.height / 2) }, timeout: 2000 }).catch(() => { });
            } catch (e) { }
            return { sent: true };
        } catch (e) {
            console.log(`>> frameElement 点击失败: ${e.message}`);
        }
    }

    try {
        const widget = page.locator('.cf-turnstile').first();
        if (await widget.isVisible({ timeout: 1000 }).catch(() => false)) {
            const box = await widget.boundingBox();
            if (isValidClickBox(box, page.viewportSize())) {
                const x = box.x + 30;
                const y = box.y + box.height / 2;
                console.log(`>> .cf-turnstile 容器点击坐标=(${x.toFixed(1)}, ${y.toFixed(1)})`);
                await page.mouse.click(x, y);
                console.log('[登录阶段] 点击事件实际发送=true strategy=IframeClick-widget');
                return { sent: true };
            }
        }
    } catch (e) { }

    console.log('[登录阶段] 点击事件实际发送=false strategy=IframeClick');
    return { sent: false };
}

// --- 前置观察：等 managed/auto 是否自动出 token（不是成功条件，只是观察） ---
async function waitForAutoTurnstileToken(page, timeoutMs = 8000) {
    const startedAt = Date.now();
    console.log(`[登录阶段] auto token 前置观察 (最长 ${timeoutMs}ms，/auto 不保证自动通过)...`);
    while (Date.now() - startedAt < timeoutMs) {
        const info = await getTurnstileTokenInfo(page);
        if (info.found && info.length > 0) {
            console.log(`[登录阶段] auto token 观察结束，token length=${info.length}`);
            return true;
        }
        if (info.verificationFailed) {
            console.log('[登录阶段] auto token 观察结束，出现 Verification failed');
            return false;
        }
        await page.waitForTimeout(1000);
    }
    const finalInfo = await getTurnstileTokenInfo(page);
    console.log(`[登录阶段] auto token 等待结束，token length=${finalInfo.length || 0}`);
    return false;
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

// --- 刷新登录页并完整重走等待流程（清旧数据 → DOMContentLoaded → 初始化 → 健康检查） ---
async function reloadLoginChallenge(page, reason = 'refresh') {
    console.log(`[登录阶段] 刷新登录页 challenge，原因: ${reason}`);
    await clearStaleTurnstileData(page);
    await page.goto('https://dashboard.katabump.com/auth/login', {
        waitUntil: 'domcontentloaded',
        timeout: 60000
    });
    // 等 DOM 稳定 + Turnstile 脚本初始化，不要立刻点击
    await page.waitForTimeout(2500 + Math.random() * 1000);
    await clearStaleTurnstileData(page);
    try {
        await page.mouse.move(120 + Math.random() * 80, 140 + Math.random() * 60, { steps: 6 });
        await page.waitForTimeout(200);
        await page.mouse.move(380 + Math.random() * 100, 320 + Math.random() * 80, { steps: 8 });
        await page.waitForTimeout(300);
    } catch (e) { }
    // 再等一小段让 widget 挂载
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

// --- 登录专用：严格状态机 ---
// 返回 { ok: boolean, state: string, message: string }
// state:
//   turnstile_token_ready
//   turnstile_verification_failed
//   turnstile_widget_not_ready
//   turnstile_token_missing          // 实际发出过点击，但 token 仍 length=0
//   turnstile_click_target_missing   // 所有点击策略都未能发出点击
async function solveLoginTurnstile(page, totalTimeoutMs = 90000) {
    const startedAt = Date.now();
    const maxReloads = 3;
    let reloads = 0;
    let lastState = 'turnstile_widget_not_ready';
    let consecutiveNotHydrated = 0;
    console.log(`[登录阶段] 开始解决 Turnstile（失败识别 + 新 challenge 重载 + token 验证，最长 ${totalTimeoutMs}ms，最多刷新 ${maxReloads} 次）...`);

    // 策略返回 { sent: boolean }
    const strategies = [
        { name: 'ChallengeFrameCDP', fn: attemptTurnstileChallengeFrameClick },
        { name: 'PlaywrightMouse', fn: attemptTurnstilePlaywrightMouse },
        { name: 'IframeClick', fn: attemptTurnstileIframeClick },
        { name: 'CDP', fn: attemptTurnstileCdp }
    ];

    while (Date.now() - startedAt < totalTimeoutMs) {
        const health = await waitForHealthyTurnstile(page, 15000);
        lastState = health.state || lastState;
        const info = health.info || {};

        if (health.autoSolved || health.state === 'turnstile_token_ready') {
            console.log('[登录阶段] state=turnstile_token_ready');
            return { ok: true, state: 'turnstile_token_ready', message: 'Turnstile token ready' };
        }

        if (health.failed || health.state === 'turnstile_verification_failed') {
            consecutiveNotHydrated = 0;
            reloads++;
            if (reloads > maxReloads) {
                return {
                    ok: false,
                    state: 'turnstile_verification_failed',
                    message: `Cloudflare Verification failed after ${maxReloads} reloads`
                };
            }
            console.log(`[登录阶段] state=turnstile_verification_failed → 刷新 (${reloads}/${maxReloads})`);
            try { await reloadLoginChallenge(page, 'verification_failed'); } catch (e) {
                console.log(`[登录阶段] 刷新失败: ${e.message}`);
            }
            continue;
        }

        if (info.challengeNotHydrated || (info.cfWidgetVisible && info.hasResponseField && !info.healthyIframe && !info.verificationFailed)) {
            consecutiveNotHydrated++;
            reloads++;
            console.log(`[登录阶段] state=turnstile_widget_not_ready (challenge_not_hydrated) consecutive=${consecutiveNotHydrated} challengeFrames=${JSON.stringify(info.challengeFrameUrls || [])}`);
            if (reloads > maxReloads || consecutiveNotHydrated >= 2) {
                return {
                    ok: false,
                    state: 'turnstile_widget_not_ready',
                    message: 'Turnstile challenge iframe never hydrated (1x1/empty src). Environment likely blocked by Cloudflare.'
                };
            }
            try { await reloadLoginChallenge(page, 'challenge_not_hydrated'); } catch (e) { }
            continue;
        }

        if (!health.ready || health.state === 'turnstile_widget_not_ready') {
            consecutiveNotHydrated = 0;
            reloads++;
            if (reloads > maxReloads) {
                return {
                    ok: false,
                    state: 'turnstile_widget_not_ready',
                    message: `Turnstile widget not ready after ${maxReloads} reloads`
                };
            }
            try { await reloadLoginChallenge(page, 'widget_not_ready'); } catch (e) { }
            continue;
        }

        // widget 健康：前置观察 auto token（不是成功条件），再点击
        consecutiveNotHydrated = 0;
        console.log('[登录阶段] state=turnstile_widget_ready');

        // 每次重新 getChallengeFrameBox（不复用旧 frame）
        const boxInfo = await getChallengeFrameBox(page);
        if (boxInfo && boxInfo.box) {
            console.log(`[登录阶段] challenge box: x=${boxInfo.box.x.toFixed(1)} y=${boxInfo.box.y.toFixed(1)} w=${boxInfo.box.width.toFixed(1)} h=${boxInfo.box.height.toFixed(1)}`);
        } else {
            console.log('[登录阶段] challenge box: 无效/未取到');
        }

        const autoOk = await waitForAutoTurnstileToken(page, 8000);
        if (autoOk) {
            return { ok: true, state: 'turnstile_token_ready', message: 'Turnstile token ready (auto)' };
        }

        console.log('[登录阶段] 开始点击策略（每次策略内部重新获取 challenge frame）');
        let gotToken = false;
        let anyClickSent = false;
        const strategyResults = [];

        for (const strategy of strategies) {
            if (Date.now() - startedAt >= totalTimeoutMs) break;

            if (await isTurnstileVerificationFailed(page)) {
                lastState = 'turnstile_verification_failed';
                console.log('[登录阶段] 点击前变成 Verification failed，停止点击。');
                break;
            }

            // token 已有则立即停止其他点击
            const preCheck = await getTurnstileTokenInfo(page);
            if (preCheck.found && preCheck.length > 0) {
                console.log(`[登录阶段] token length=${preCheck.length}，立即停止其他点击`);
                gotToken = true;
                lastState = 'turnstile_token_ready';
                break;
            }

            console.log(`[登录阶段] 策略=${strategy.name}`);
            let result = { sent: false };
            try {
                const raw = await strategy.fn(page);
                result = (raw && typeof raw === 'object' && 'sent' in raw) ? raw : { sent: !!raw };
            } catch (e) {
                console.log(`[登录阶段] 策略 ${strategy.name} 异常: ${e.message}`);
                result = { sent: false };
            }
            console.log(`[登录阶段] 策略=${strategy.name} 点击事件实际发送=${result.sent}`);
            strategyResults.push({ name: strategy.name, sent: result.sent });
            if (result.sent) anyClickSent = true;

            // 没发出点击：不空等，换下一策略
            if (!result.sent) continue;

            // 点击后等 token；length>0 立即停止
            const waitUntil = Math.min(Date.now() + 12000, startedAt + totalTimeoutMs);
            while (Date.now() < waitUntil) {
                const after = await getTurnstileTokenInfo(page);
                if (after.found && after.length > 0) {
                    console.log(`[登录阶段] state=turnstile_token_ready，token length=${after.length}`);
                    gotToken = true;
                    lastState = 'turnstile_token_ready';
                    break;
                }
                if (after.verificationFailed) {
                    lastState = 'turnstile_verification_failed';
                    console.log('[登录阶段] 点击后 state=turnstile_verification_failed');
                    break;
                }
                await page.waitForTimeout(1000);
            }
            if (gotToken) break;
            if (lastState === 'turnstile_verification_failed') break;

            const diag = await getTurnstileTokenInfo(page);
            lastState = (diag.found && diag.length > 0) ? 'turnstile_token_ready' : 'turnstile_token_missing';
            console.log(`[登录阶段] 点击后 token length=${diag.length || 0} state=${lastState}`);
        }

        if (gotToken) {
            return { ok: true, state: 'turnstile_token_ready', message: 'Turnstile token ready after click' };
        }

        // 所有策略都没发出点击
        if (!anyClickSent) {
            console.log(`[登录阶段] 所有策略均未发出点击。results=${JSON.stringify(strategyResults)}`);
            lastState = 'turnstile_click_target_missing';
            reloads++;
            if (reloads > maxReloads) {
                return {
                    ok: false,
                    state: 'turnstile_click_target_missing',
                    message: `All click strategies failed to send click after ${maxReloads} reloads`
                };
            }
            console.log(`[登录阶段] state=turnstile_click_target_missing → 刷新 (${reloads}/${maxReloads})`);
            try { await reloadLoginChallenge(page, 'click_target_missing'); } catch (e) { }
            continue;
        }

        // 发出过点击但 token 仍为空 → 只有实际点过才能标 token_missing
        lastState = 'turnstile_token_missing';
        reloads++;
        if (reloads > maxReloads) {
            console.log(`[登录阶段] 已刷新 ${maxReloads} 次，点击已发送但 token length=0。结束本轮。`);
            return {
                ok: false,
                state: 'turnstile_token_missing',
                message: `Click sent but token length=0 after ${maxReloads} reloads (click target issue likely excluded)`
            };
        }
        console.log(`[登录阶段] state=turnstile_token_missing（点击已发送，token 仍为 0）→ 刷新 (${reloads}/${maxReloads})`);
        try { await reloadLoginChallenge(page, 'token_missing_after_click'); } catch (e) { }
    }

    const finalInfo = await getTurnstileTokenInfo(page);
    if (finalInfo.found && finalInfo.length > 0) {
        return { ok: true, state: 'turnstile_token_ready', message: 'Turnstile token ready' };
    }
    console.log(`[登录阶段] 超时结束。state=${lastState} token length=${finalInfo.length || 0}`);
    return {
        ok: false,
        state: lastState || 'turnstile_token_missing',
        message: `Turnstile timeout (state=${lastState})`
    };
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
//  主流程
// ============================================================
(async () => {
    const users = getUsers();
    if (users.length === 0) {
        console.log('未在 process.env.USERS_JSON 中找到用户');
        process.exit(1);
    }

    if (PROXY_CONFIG) {
        if (!await checkProxy()) process.exit(1);
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

    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        console.log(`\n=== 正在处理用户 ${i + 1}/${users.length} ===`);

        let renewSuccess = false;
        let runStatus = 'unknown'; // 'success' | 'not_ready' | 'captcha_required' | 'login_failed' | 'error'
        let blockMessage = '';

        try {
            if (page.isClosed()) {
                page = await context.newPage();
                await page.addInitScript(INJECTED_SCRIPT);
            }

            // 1. 访问登录页
            console.log('访问登录页面...');
            await page.goto('https://dashboard.katabump.com/auth/login', { waitUntil: 'domcontentloaded', timeout: 60000 });

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

            const turnstileResult = await solveLoginTurnstile(page, 90000);
            if (!turnstileResult.ok) {
                const state = turnstileResult.state || 'turnstile_token_missing';
                console.error(`   >> ⚠️ Turnstile 未通过。state=${state} message=${turnstileResult.message}`);
                runStatus = 'captcha_required';
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
                continue;
            }
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
                    runStatus = 'captcha_required';
                    blockMessage = 'Turnstile token disappeared before login submit';
                    renewSuccess = false;
                    await dumpDebugSnapshot(
                        page,
                        `login_turnstile_token_lost_${user.username.replace(/[^a-z0-9]/gi, '_')}`
                    );
                    continue;
                }
                console.log(`[登录阶段] 提交前 token 仍有效，字段=${tokenStillValid.selector}，长度=${tokenStillValid.length}，提交 Login...`);

                await page.getByRole('button', { name: 'Login', exact: true }).click();

                // 登录后诊断：保存截图 + HTML，输出 URL / 标题 / body 片段
                await page.waitForTimeout(2000);
                const photoDir = await ensureScreenshotsDir();
                await page.screenshot({ path: path.join(photoDir, `login_after_submit_${user.username.replace(/[^a-z0-9]/gi, '_')}.png`), fullPage: true });
                try {
                    const html = await page.content();
                    fs.writeFileSync(path.join(photoDir, `login_after_submit_${user.username.replace(/[^a-z0-9]/gi, '_')}.html`), html, 'utf-8');
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
                        await page.screenshot({ path: path.join(photoDir, `login_failed_${user.username.replace(/[^a-z0-9]/gi, '_')}.png`), fullPage: true });
                        continue;
                    }
                } catch (e) { }

                // 检查验证码是否被服务端接受（error=captcha / Please complete captcha）
                {
                    const captchaUrlHit = /error=captcha/i.test(loginUrl);
                    const captchaTextHit = /Please complete captcha/i.test(loginBody)
                        || /captcha required/i.test(loginBody)
                        || /complete captcha/i.test(loginBody);
                    if (captchaUrlHit || captchaTextHit) {
                        console.error(`   >> ⚠️ 登录验证码未被服务端接受 (URL: ${loginUrl})`);
                        runStatus = 'captcha_required';
                        blockMessage = 'Login captcha was not accepted';
                        renewSuccess = false;
                        const photoDir2 = await ensureScreenshotsDir();
                        await page.screenshot({ path: path.join(photoDir2, `login_captcha_required_${user.username.replace(/[^a-z0-9]/gi, '_')}.png`), fullPage: true });
                        try {
                            const html2 = await page.content();
                            fs.writeFileSync(path.join(photoDir2, `login_captcha_required_${user.username.replace(/[^a-z0-9]/gi, '_')}.html`), html2, 'utf-8');
                        } catch (e) { }
                        continue;
                    }
                }

            } catch (e) {
                console.log('登录操作遇到异常 (可能是已登录或超时):', e.message);
            }

            // 2. 登录后进入 dashboard（多策略 fallback）
            // 再次确认当前 URL 不含 error=captcha（防止 try 块外漏检）
            if (/error=captcha/i.test(page.url())) {
                console.error(`   >> ⚠️ 登录验证码未被服务端接受 (URL: ${page.url()})`);
                runStatus = 'captcha_required';
                blockMessage = 'Login captcha was not accepted';
                renewSuccess = false;
                const photoDir = await ensureScreenshotsDir();
                await page.screenshot({ path: path.join(photoDir, `login_captcha_required_${user.username.replace(/[^a-z0-9]/gi, '_')}.png`), fullPage: true });
                try {
                    const html = await page.content();
                    fs.writeFileSync(path.join(photoDir, `login_captcha_required_${user.username.replace(/[^a-z0-9]/gi, '_')}.html`), html, 'utf-8');
                } catch (e) { }
                continue;
            }

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
                    runStatus = 'captcha_required';
                    blockMessage = 'Login captcha was not accepted';
                    renewSuccess = false;
                    const photoDir = await ensureScreenshotsDir();
                    await page.screenshot({ path: path.join(photoDir, `login_captcha_required_${user.username.replace(/[^a-z0-9]/gi, '_')}.png`), fullPage: true });
                    try {
                        const html = await page.content();
                        fs.writeFileSync(path.join(photoDir, `login_captcha_required_${user.username.replace(/[^a-z0-9]/gi, '_')}.html`), html, 'utf-8');
                    } catch (e) { }
                    continue;
                }

                console.log('login_failed: 未找到 dashboard 入口 (See / Access server / View / dashboard URL)。');
                runStatus = 'login_failed';
                blockMessage = 'Dashboard entry not found after login';
                const photoDir = await ensureScreenshotsDir();
                await page.screenshot({ path: path.join(photoDir, `login_failed_no_dashboard_${user.username.replace(/[^a-z0-9]/gi, '_')}.png`), fullPage: true });
                continue;
            }

            // 如果有 See 按钮，点击它；否则认为已在 dashboard 页面
            try {
                const seeBtn = page.getByRole('link', { name: 'See' }).first();
                if (await seeBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
                    await seeBtn.click();
                    console.log('[登录] 已点击 See 按钮。');
                }
            } catch (e) { }

            // 3. Renew 主循环
            for (let attempt = 1; attempt <= 20; attempt++) {
                console.log(`\n[尝试 ${attempt}/20] 正在寻找 Renew 按钮...`);
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

                // 【保留】解决弹窗内 Turnstile（Cloudflare 专用，ALTCHA 另处理）
                const turnstileResult = await solveTurnstileIfPresent(page, "Renew阶段", 30, 8000);
                console.log(`[Renew阶段] Turnstile 检测结果: ${turnstileResult ? '已处理' : '未检测到或无需点击'}`);

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
                    || /I'm not a robot/i.test(modalText);
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
                                }
                                console.log('   >> Modal 已关闭，Expiry 未变，可能已是最新的。');
                                runStatus = 'already_renewed';
                                break;
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
                        console.log('   >> Modal 已关闭，无法读取 Expiry，假设成功。');
                        renewSuccess = true;
                        runStatus = 'success';
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

        } catch (err) {
            console.error(`Error processing user:`, err);
            runStatus = 'error';
            blockMessage = err.message;
            const photoDir = await ensureScreenshotsDir();
            try {
                await page.screenshot({ path: path.join(photoDir, `error_${user.username.replace(/[^a-z0-9]/gi, '_')}.png`), fullPage: true });
            } catch (e) { }
        }

        // 用户处理完成，发送最终状态通知
        const safeUsername = user.username.replace(/[^a-z0-9]/gi, '_');
        const photoDir = await ensureScreenshotsDir();
        try {
            await page.screenshot({ path: path.join(photoDir, `${safeUsername}.png`), fullPage: true });
        } catch (e) { }

        // Telegram 通知
        if (runStatus === 'success') {
            await sendTelegramMessage(`✅ KataBump 续期完成\n用户: ${user.username}\n状态: 续期成功`);
        } else if (runStatus === 'not_ready') {
            await sendTelegramMessage(`⏳ KataBump 本轮未续期\n用户: ${user.username}\n原因: ${blockMessage}\nCron 将在下次继续检查。`);
        } else if (runStatus === 'captcha_required') {
            await sendTelegramMessage(`⚠️ KataBump 验证码阻断\n用户: ${user.username}\n原因: ${blockMessage}\n请检查验证码状态。`);
        } else if (runStatus === 'login_failed') {
            await sendTelegramMessage(`❌ KataBump 登录失败\n用户: ${user.username}\n原因: ${blockMessage}`);
        } else if (runStatus === 'already_renewed') {
            await sendTelegramMessage(`ℹ️ KataBump 可能已续期\n用户: ${user.username}\nExpiry 未变化，可能本轮已是最新。`);
        }

        console.log(`用户处理完成 | 状态: ${runStatus}`);
    }

    console.log('\n全部账号处理完成。');
    await browser.close();
    process.exit(0);
})();
