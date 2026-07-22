const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const crypto = require('crypto');
const axios = require('axios');
const FormData = require('form-data');
const {
    normalizeTimeoutMinutes,
    runChildWithTimeout,
    DEFAULT_GRACEFUL_TERMINATION_MS
} = require('./lib/runtime_helpers');
const { sendTelegramNotification } = require('./lib/telegram');

const ACTION_TIMEOUT_MINUTES = normalizeTimeoutMinutes(process.env.ACTION_TIMEOUT_MINUTES);
const ACTION_TIMEOUT_MS = ACTION_TIMEOUT_MINUTES * 60 * 1000;
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;

// --- 退出码（与 action_renew.js 完全一致） ---
const EXIT_CODE = {
    SUCCESS: 0,
    FATAL: 1,
    PROXY_RETRY: 42,       // 只有这个码才触发代理轮换
    RENEW_CAPTCHA_FAILED: 43, // Renew ALTCHA 失败，不换代理
    NOT_READY: 3,
    ALREADY_RENEWED: 4,
    LOGIN_FAILED: 5,
    NO_PROXY_AVAILABLE: 6 // 全部代理冷却，暂无可用代理
};

// --- 只有明确成功/不可重试状态才停止轮换 ---
const NON_RETRYABLE = new Set([
    EXIT_CODE.SUCCESS,
    EXIT_CODE.NOT_READY,
    EXIT_CODE.ALREADY_RENEWED,
    EXIT_CODE.LOGIN_FAILED,
    EXIT_CODE.RENEW_CAPTCHA_FAILED
]);

const CONFIG = {
    MAX_PROXY_SWITCHES: 5,
    COOLDOWN_FILE: path.join(process.cwd(), 'proxy-cooldown.json'),
    COOLDOWN_HOURS: 4,
    PROXIES_FILE: path.join(process.cwd(), 'proxies.txt')
};

function createAttemptResultFile(attempt) {
    const nonce = crypto.randomBytes(8).toString('hex');
    return path.join(os.tmpdir(), `katabump-action-result-${process.pid}-${attempt}-${nonce}.json`);
}

function readActionResult(resultFile) {
    if (!resultFile) return null;
    try {
        if (!fs.existsSync(resultFile)) return null;
        const parsed = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (error) {
        console.error('[proxy-runner] 本次代理结果文件读取失败:', error.message);
        return null;
    } finally {
        try { fs.unlinkSync(resultFile); } catch (error) { }
    }
}

function actionStatusFromCode(code) {
    switch (code) {
        case EXIT_CODE.SUCCESS: return 'success';
        case EXIT_CODE.NOT_READY: return 'not_ready';
        case EXIT_CODE.ALREADY_RENEWED: return 'already_renewed';
        case EXIT_CODE.LOGIN_FAILED: return 'login_failed';
        case EXIT_CODE.RENEW_CAPTCHA_FAILED: return 'captcha_required';
        case EXIT_CODE.PROXY_RETRY: return 'proxy_retry';
        default: return 'error';
    }
}

function makeAttemptRecord(attempt, parsed, childResult) {
    const actionResult = childResult.actionResult || {};
    const code = Number.isInteger(actionResult.exitCode) ? actionResult.exitCode : childResult.code;
    return {
        attempt,
        proxy: parsed ? safeProxyId(parsed) : 'direct',
        code,
        status: actionResult.status || actionStatusFromCode(code),
        message: actionResult.message || childResult.error?.message || (childResult.timedOut ? 'action_renew.js timed out' : ''),
        screenshotPath: actionResult.screenshotPath || null,
        htmlPath: actionResult.htmlPath || null,
        accounts: Array.isArray(actionResult.accounts) ? actionResult.accounts : [],
        timedOut: childResult.timedOut === true
    };
}

function buildFinalSummary(finalCode, finalResult, attempts) {
    const lastAttempt = attempts.length > 0 ? attempts[attempts.length - 1] : null;
    const actionResult = finalResult || lastAttempt || {};
    let status = actionResult.status || actionStatusFromCode(finalCode);
    if (finalCode === EXIT_CODE.NO_PROXY_AVAILABLE) status = 'no_proxy_available';
    if (finalCode === EXIT_CODE.FATAL && attempts.length > 0 && attempts.every(item => item.code === EXIT_CODE.PROXY_RETRY)) {
        status = 'proxy_exhausted';
    }

    const accounts = Array.isArray(actionResult.accounts) ? actionResult.accounts : [];
    const counts = {
        success: accounts.filter(account => ['success', 'already_renewed'].includes(account.status)).length,
        notReady: accounts.filter(account => account.status === 'not_ready').length,
        failed: accounts.filter(account => !['success', 'not_ready', 'already_renewed'].includes(account.status)).length
    };
    if (counts.success === 0 && counts.notReady === 0 && counts.failed === 0 && accounts.length === 0) {
        counts.failed = 0;
    }

    return {
        exitCode: finalCode,
        status,
        message: actionResult.message || '',
        screenshotPath: actionResult.screenshotPath || (lastAttempt && lastAttempt.screenshotPath) || null,
        htmlPath: actionResult.htmlPath || (lastAttempt && lastAttempt.htmlPath) || null,
        attempts,
        accounts,
        counts
    };
}

function formatFinalNotification(summary) {
    const titles = {
        success: '✅ KataBump 自动续期完成',
        not_ready: '⏳ KataBump 本轮暂不可续期',
        already_renewed: 'ℹ️ KataBump 已续期或无需重复续期',
        captcha_required: '⚠️ KataBump 续期验证码阻断',
        login_failed: '❌ KataBump 登录失败',
        no_proxy_available: '❌ KataBump 无可用代理',
        proxy_exhausted: '❌ KataBump 代理已耗尽',
        proxy_retry: '❌ KataBump 代理重试失败',
        error: '❌ KataBump 自动续期失败'
    };
    const lines = [
        titles[summary.status] || titles.error,
        '',
        `代理尝试：${summary.attempts.length}/${CONFIG.MAX_PROXY_SWITCHES}`
    ];
    if (summary.accounts.length > 0) {
        lines.push(`账号总数：${summary.accounts.length}`);
        lines.push(`成功：${summary.counts.success}`);
        lines.push(`暂不可续期：${summary.counts.notReady}`);
        lines.push(`失败：${summary.counts.failed}`);
    }
    lines.push(`最终状态：${summary.status}`);
    if (summary.message) lines.push(`原因：${summary.message}`);
    return lines.join('\n');
}

async function sendFinalTelegram(summary) {
    const message = formatFinalNotification(summary);
    console.log('[proxy-runner] 发送最终 Telegram 通知');
    try {
        const result = await sendTelegramNotification({
            axios,
            FormData,
            fs,
            token: TG_BOT_TOKEN,
            chatId: TG_CHAT_ID,
            message,
            imagePath: summary.screenshotPath,
            logger: console
        });
        if (result.skipped) console.log('[proxy-runner] Telegram 未配置，跳过最终通知');
        return result;
    } catch (error) {
        console.error('[proxy-runner] 最终 Telegram 通知失败:', error.message);
        return { skipped: false, textSent: false, imageSent: false };
    }
}

async function finalizeWorkflow(finalCode, finalResult, attempts) {
    const summary = buildFinalSummary(finalCode, finalResult, attempts);
    await sendFinalTelegram(summary);
    return finalCode;
}

// ============================================================
//  冷却管理
// ============================================================
function loadCooldowns() {
    try {
        if (!fs.existsSync(CONFIG.COOLDOWN_FILE)) return {};
        const raw = fs.readFileSync(CONFIG.COOLDOWN_FILE, 'utf-8');
        return JSON.parse(raw);
    } catch (e) {
        console.log('[proxy-runner] 冷却文件读取失败，视为无冷却:', e.message);
        return {};
    }
}

function saveCooldowns(cooldowns) {
    try {
        fs.writeFileSync(CONFIG.COOLDOWN_FILE, JSON.stringify(cooldowns, null, 2), 'utf-8');
    } catch (e) {
        console.error('[proxy-runner] 保存冷却文件失败:', e.message);
    }
}

function addCooldown(cooldowns, proxyKey, reason) {
    const until = Math.floor(Date.now() / 1000) + CONFIG.COOLDOWN_HOURS * 3600;
    cooldowns[proxyKey] = { until, reason };
    saveCooldowns(cooldowns);
    console.log(`[proxy-runner] 代理 ${proxyKey} 加入冷却，持续 ${CONFIG.COOLDOWN_HOURS}h，原因: ${reason}`);
}

function removeExpiredCooldowns(cooldowns) {
    const now = Math.floor(Date.now() / 1000);
    let removed = 0;
    for (const key of Object.keys(cooldowns)) {
        if (cooldowns[key].until <= now) {
            delete cooldowns[key];
            removed++;
        }
    }
    if (removed > 0) {
        saveCooldowns(cooldowns);
        console.log(`[proxy-runner] 已清理 ${removed} 条过期冷却`);
    }
}

// ============================================================
//  代理解析（唯一真相源）
// ============================================================
function parseProxyLine(line, lineNumber) {
    const trimmed = (line || '').trim();
    if (!trimmed || trimmed.startsWith('#')) return { valid: false, reason: 'empty_or_comment', lineNumber };

    const isValidPort = (s) => /^[0-9]+$/.test(s) && s.length > 0 && s.length <= 5 && Number(s) >= 1 && Number(s) <= 65535;
    const isValidHost = (s) => (
        typeof s === 'string' &&
        s.length > 0 &&
        !/[\s/\\?#@\u0000-\u001f\u007f]/.test(s)
    );

    // Format 1: http://USER:PASSWORD@HOST:PORT
    if (trimmed.startsWith('http://')) {
        let parsedUrl;
        try {
            parsedUrl = new URL(trimmed);
        } catch {
            return { valid: false, reason: 'invalid_url_format', lineNumber };
        }

        // URL format is exactly http://USERNAME:PASSWORD@HOST:PORT.
        // URL accepts paths, queries, and fragments, but none are part of the
        // frozen proxy input format. A trailing extra host field is rejected by
        // URL itself as an invalid port.
        const explicitPortMatch = trimmed.match(/:(\d+)\/?$/);
        const port = (explicitPortMatch && explicitPortMatch[1]) || parsedUrl.port;

        if (
            parsedUrl.protocol !== 'http:' ||
            !parsedUrl.hostname ||
            !port ||
            parsedUrl.pathname !== '/' ||
            parsedUrl.search ||
            parsedUrl.hash ||
            !parsedUrl.username ||
            !parsedUrl.password
        ) {
            return { valid: false, reason: 'invalid_url_format', lineNumber };
        }

        let username;
        let password;
        try {
            username = decodeURIComponent(parsedUrl.username);
            password = decodeURIComponent(parsedUrl.password);
        } catch {
            return { valid: false, reason: 'invalid_url_encoding', lineNumber };
        }

        if (!username || !password) {
            return { valid: false, reason: 'invalid_credentials', lineNumber };
        }
        if (!isValidHost(parsedUrl.hostname) || !isValidPort(port)) {
            return { valid: false, reason: 'invalid_url_format', lineNumber };
        }
        return { valid: true, ip: parsedUrl.hostname, port, username, password, lineNumber };
    }

    // Format 2: HOST:PORT or HOST:PORT:USER:PASSWORD (Webshare standard)
    const colonParts = trimmed.split(':');

    if (colonParts.length === 2) {
        const ip = colonParts[0];
        const port = colonParts[1];
        if (!ip) return { valid: false, reason: 'empty_ip', lineNumber };
        if (!isValidHost(ip)) return { valid: false, reason: 'invalid_host', lineNumber };
        if (!port) return { valid: false, reason: 'empty_port', lineNumber };
        if (!isValidPort(port)) return { valid: false, reason: `invalid_port:${port}`, lineNumber };
        return { valid: true, ip: ip.toLowerCase(), port, username: '', password: '', lineNumber };
    }

    if (colonParts.length >= 4) {
        const ip = colonParts[0];
        const port = colonParts[1];
        const username = colonParts[2] || '';
        const password = colonParts.slice(3).join(':') || '';
        if (!ip) return { valid: false, reason: 'empty_ip', lineNumber };
        if (!isValidHost(ip)) return { valid: false, reason: 'invalid_host', lineNumber };
        if (!port) return { valid: false, reason: 'empty_port', lineNumber };
        if (!isValidPort(port)) return { valid: false, reason: `invalid_port:${port}`, lineNumber };
        if (!username || !password) return { valid: false, reason: 'invalid_credentials', lineNumber };
        return { valid: true, ip: ip.toLowerCase(), port, username, password, lineNumber };
    }

    return { valid: false, reason: `invalid_field_count:${colonParts.length}`, lineNumber };
}

function buildHttpProxy(parsed) {
    if (!parsed || !parsed.valid || !parsed.ip || !parsed.port) return null;
    if ((parsed.username && !parsed.password) || (!parsed.username && parsed.password)) return null;
    if (/[\s/\\?#@\u0000-\u001f\u007f]/.test(parsed.ip)) return null;
    const encodedUser = parsed.username ? encodeURIComponent(parsed.username) : '';
    const encodedPass = parsed.password ? encodeURIComponent(parsed.password) : '';
    const auth = [encodedUser, encodedPass].filter(Boolean).join(':');
    const urlStr = auth
        ? `http://${auth}@${parsed.ip}:${parsed.port}`
        : `http://${parsed.ip}:${parsed.port}`;
    try {
        const u = new URL(urlStr);
        let decodedUser = '';
        let decodedPass = '';
        try {
            decodedUser = u.username ? decodeURIComponent(u.username) : '';
            decodedPass = u.password ? decodeURIComponent(u.password) : '';
        } catch {
            return null;
        }
        const effectivePort = u.port || (u.protocol === 'http:' ? '80' : '');
        if (
            u.protocol !== 'http:' ||
            u.hostname !== parsed.ip ||
            effectivePort !== String(parsed.port) ||
            Boolean(u.username) !== Boolean(parsed.username) ||
            Boolean(u.password) !== Boolean(parsed.password) ||
            decodedUser !== (parsed.username || '') ||
            decodedPass !== (parsed.password || '') ||
            u.pathname !== '/' && u.pathname !== ''
        ) {
            return null;
        }
    } catch {
        return null;
    }
    return urlStr;
}

function proxyKey(parsed) {
    return `${parsed.ip}:${parsed.port}`;
}

function buildChildEnv(parsed, baseEnv) {
    const env = { ...(baseEnv || process.env) };
    if (parsed === null) {
        delete env.HTTP_PROXY;
        delete env.HTTPS_PROXY;
        delete env.http_proxy;
        delete env.https_proxy;
        return env;
    }
    const proxyUrl = buildHttpProxy(parsed);
    if (!proxyUrl) {
        return null;
    }
    env.HTTP_PROXY = proxyUrl;
    env.HTTPS_PROXY = proxyUrl;
    env.http_proxy = proxyUrl;
    env.https_proxy = proxyUrl;
    return env;
}

function maskProxyUrl(proxyUrl) {
    try {
        const u = new URL(proxyUrl);
        const port = u.port || (u.protocol === 'http:' ? '80' : '');
        if (u.username || u.password) {
            return `${u.protocol}//***:***@${u.hostname}:${port}`;
        }
        return proxyUrl;
    } catch {
        return '***';
    }
}

function emitGithubMask(proxyUrl, env = process.env, logger = console.log) {
    if (env.GITHUB_ACTIONS === 'true') {
        logger(`::add-mask::${proxyUrl}`);
    }
}

function safeProxyId(parsed) {
    if (!parsed || !parsed.valid) return 'invalid';
    return `${parsed.ip}:${parsed.port}`;
}

// ============================================================
//  代理选择
// ============================================================
function loadProxies() {
    if (!fs.existsSync(CONFIG.PROXIES_FILE)) {
        console.log('[proxy-runner] proxies.txt 不存在，直接运行（无代理）');
        return { configured: false, valid: [], invalidCount: 0 };
    }
    const raw = fs.readFileSync(CONFIG.PROXIES_FILE, 'utf-8');
    const lines = raw.split('\n');
    const nonEmptyLines = [];
    for (let origIdx = 0; origIdx < lines.length; origIdx++) {
        const trimmed = lines[origIdx].trim();
        if (trimmed && !trimmed.startsWith('#')) {
            nonEmptyLines.push({ trimmed, lineNumber: origIdx + 1 });
        }
    }
    const valid = [];
    const invalid = [];
    for (const { trimmed, lineNumber } of nonEmptyLines) {
        const parsed = parseProxyLine(trimmed, lineNumber);
        if (parsed.valid && buildHttpProxy(parsed)) {
            valid.push(parsed);
        } else {
            if (parsed.valid) parsed.reason = 'invalid_proxy_url';
            invalid.push(parsed);
        }
    }
    for (const p of invalid) {
        console.log(`[proxy-runner] 第 ${p.lineNumber} 行无效：${p.reason}`);
    }
    console.log(`[proxy-runner] proxies.txt 共 ${valid.length} 条有效代理`);
    return { configured: true, valid, invalidCount: invalid.length };
}

function selectRandomProxy(proxies, cooldowns) {
    const now = Math.floor(Date.now() / 1000);
    const available = [];
    for (const parsed of proxies) {
        const key = proxyKey(parsed);
        if (!cooldowns[key] || cooldowns[key].until <= now) {
            available.push(parsed);
        }
    }

    if (available.length === 0) {
        console.log('[proxy-runner] 无可选代理（全部冷却中），本轮停止，不清空冷却名单');
        return null;
    }

    const parsed = available[crypto.randomInt(available.length)];
    console.log(`[proxy-runner] 选择代理: ${safeProxyId(parsed)}`);
    return parsed;
}

// ============================================================
//  运行子进程
// ============================================================
async function runActionRenew(parsed, attempt = 1) {
    const env = buildChildEnv(parsed, process.env);
    if (!env) {
        console.error('[proxy-runner] 当前代理格式无效，不静默直连');
        return { code: EXIT_CODE.FATAL, timedOut: false, actionResult: null };
    }

    if (parsed === null) {
        console.log('[proxy-runner] 无代理模式，已清除 HTTP_PROXY / HTTPS_PROXY');
    } else {
        console.log(`[proxy-runner] 设置 HTTP_PROXY=${safeProxyId(parsed)}`);
        const proxyUrl = buildHttpProxy(parsed);
        console.log(`[proxy-runner] 代理地址: ${maskProxyUrl(proxyUrl)}`);
        emitGithubMask(proxyUrl);
    }

    const scriptPath = path.join(process.cwd(), 'action_renew.js');
    const resultFile = createAttemptResultFile(attempt);
    env.KATABUMP_MANAGED_BY_PROXY_RUNNER = '1';
    env.KATABUMP_RESULT_FILE = resultFile;
    console.log(`[proxy-runner] 启动 action_renew.js，超时=${ACTION_TIMEOUT_MINUTES} 分钟，SIGTERM 宽限=${Math.round(DEFAULT_GRACEFUL_TERMINATION_MS / 1000)} 秒...`);

    try {
        const proc = spawn('node', [scriptPath], {
            env,
            stdio: 'inherit',
            shell: false,
            detached: true
        });

        const result = await runChildWithTimeout(proc, {
            timeoutMs: ACTION_TIMEOUT_MS,
            gracefulMs: DEFAULT_GRACEFUL_TERMINATION_MS,
            logger: console.error
        });
        if (result.error) console.error('[proxy-runner] 启动或运行子进程失败:', result.error.message);
        return {
            code: result.code,
            timedOut: result.timedOut,
            actionResult: readActionResult(resultFile)
        };
    } catch (error) {
        try { fs.unlinkSync(resultFile); } catch (cleanupError) { }
        return { code: EXIT_CODE.FATAL, timedOut: false, actionResult: null, error };
    }
}

// ============================================================
//  主流程
// ============================================================
async function runProxyWorkflow(attempts) {
    console.log(`[proxy-runner] 启动代理轮换控制器`);
    console.log(`[proxy-runner] 最多尝试 ${CONFIG.MAX_PROXY_SWITCHES} 个代理，冷却 ${CONFIG.COOLDOWN_HOURS}h`);
    console.log(`[proxy-runner] 退出码映射: SUCCESS=0 FATAL=1 PROXY_RETRY=42 NOT_READY=3 ALREADY_RENEWED=4 LOGIN_FAILED=5 NO_PROXY_AVAILABLE=6 RENEW_CAPTCHA_FAILED=43`);

    const proxyResult = loadProxies();
    const proxies = proxyResult.valid;
    let cooldowns = loadCooldowns();
    removeExpiredCooldowns(cooldowns);

    for (let attempt = 1; attempt <= CONFIG.MAX_PROXY_SWITCHES; attempt++) {
        console.log(`\n[proxy-runner] ===== 代理尝试 ${attempt}/${CONFIG.MAX_PROXY_SWITCHES} =====`);

        // 1) 选代理
        let selection = null;

        if (proxies.length > 0) {
            selection = selectRandomProxy(proxies, cooldowns);
            if (!selection) {
                console.log('[proxy-runner] 无可选代理（全部冷却中），本轮停止，不清空冷却名单');
                return finalizeWorkflow(EXIT_CODE.NO_PROXY_AVAILABLE, {
                    status: 'no_proxy_available',
                    message: 'No proxy is currently available',
                    accounts: []
                }, attempts);
            }
        } else if (proxyResult.configured) {
            console.log('[proxy-runner] proxies.txt 存在但无有效代理，禁止静默直连');
            return finalizeWorkflow(EXIT_CODE.NO_PROXY_AVAILABLE, {
                status: 'no_proxy_available',
                message: 'No valid proxy is configured',
                accounts: []
            }, attempts);
        } else {
            console.log('[proxy-runner] 未配置 proxies.txt，无代理直连');
        }

        // 2) 跑业务脚本；子进程由 action_renew.js 自己管理 BrowserContext/Browser 生命周期。
        const result = await runActionRenew(selection || null, attempt);
        const code = result.code;
        const attemptRecord = makeAttemptRecord(attempt, selection, result);
        attempts.push(attemptRecord);

        // 3) 按退出码决定
        if (NON_RETRYABLE.has(code)) {
            // NOT_READY(3) 和 ALREADY_RENEWED(4) 是正常业务状态，归一为 0 避免 GitHub Actions 显示失败
            const normalizedCode = (code === EXIT_CODE.NOT_READY || code === EXIT_CODE.ALREADY_RENEWED) ? EXIT_CODE.SUCCESS : code;
            if (code !== normalizedCode) {
                console.log(`[proxy-runner] 业务状态码 ${code} 归一为 ${normalizedCode}（正常业务，非失败）`);
            }
            console.log(`[proxy-runner] 不可重试退出码 ${normalizedCode}，结束本轮`);
            return finalizeWorkflow(normalizedCode, result.actionResult || attemptRecord, attempts);
        }

        if (code === EXIT_CODE.PROXY_RETRY && selection) {
            const parsed = selection;
            const key = proxyKey(parsed);
            addCooldown(cooldowns, key, 'proxy_retry_from_action_renew');
            cooldowns = loadCooldowns();
            console.log(`[proxy-runner] 选择下一个代理`);
            continue;
        }

        if (code === EXIT_CODE.FATAL) {
            console.log(`[proxy-runner] 退出码 1 (FATAL)，非代理问题，停止`);
            return finalizeWorkflow(EXIT_CODE.FATAL, result.actionResult || attemptRecord, attempts);
        }

        // 未知退出码也停止（不是 PROXY_RETRY）
        console.log(`[proxy-runner] 未知退出码 ${code}，不换代理，停止`);
        return finalizeWorkflow(code, result.actionResult || attemptRecord, attempts);
    }

    console.log(`[proxy-runner] 已尝试 ${CONFIG.MAX_PROXY_SWITCHES} 个代理，均未成功`);
    return finalizeWorkflow(EXIT_CODE.FATAL, attempts[attempts.length - 1] || {
        status: 'proxy_exhausted',
        message: 'All proxy attempts returned PROXY_RETRY',
        accounts: []
    }, attempts);
}

async function main() {
    const attempts = [];
    try {
        return await runProxyWorkflow(attempts);
    } catch (error) {
        console.error('[proxy-runner] 主流程异常:', error.message);
        return finalizeWorkflow(EXIT_CODE.FATAL, {
            status: 'error',
            message: error.message,
            accounts: []
        }, attempts);
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
    main()
        .then((code) => process.exit(code))
        .catch((e) => {
            console.error(e);
            process.exit(EXIT_CODE.FATAL);
        });
}

module.exports = {
    parseProxyLine,
    buildHttpProxy,
    buildChildEnv,
    maskProxyUrl,
    emitGithubMask,
    loadProxies,
    selectRandomProxy,
    proxyKey,
    safeProxyId,
    runActionRenew,
    readActionResult,
    makeAttemptRecord,
    buildFinalSummary,
    formatFinalNotification,
    normalizeTimeoutMinutes,
    runChildWithTimeout,
    ACTION_TIMEOUT_MINUTES,
    ACTION_TIMEOUT_MS,
    DEFAULT_GRACEFUL_TERMINATION_MS
};
