const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const crypto = require('crypto');

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

const CHROME_PORT = 9222;

const CONFIG = {
    MAX_PROXY_SWITCHES: 5,
    COOLDOWN_FILE: path.join(process.cwd(), 'proxy-cooldown.json'),
    COOLDOWN_HOURS: 4,
    PROXIES_FILE: path.join(process.cwd(), 'proxies.txt')
};

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
    const isValidHost = (s) => s && !s.includes(' ') && !s.includes('/') && !s.includes('?') && !s.includes('#');

    // Reject bare USER:PASS@HOST:PORT to avoid ambiguity with Webshare format.
    // Only http://USER:PASSWORD@HOST:PORT is accepted as URL format.
    // However, allow HOST:PORT:USER:PASSWORD when the first segment looks like a host.
    if (!trimmed.startsWith('http://') && trimmed.includes('@')) {
        const firstColon = trimmed.indexOf(':');
        const firstSegment = firstColon > 0 ? trimmed.substring(0, firstColon) : '';
        const looksLikeHost = firstColon > 0 && /[.\d-]/.test(firstSegment);
        if (!looksLikeHost) {
            return { valid: false, reason: 'ambiguous_format_use_webshare_or_http_url', lineNumber };
        }
    }

    // Format 1: http://USER:PASSWORD@HOST:PORT
    if (trimmed.startsWith('http://')) {
        const withoutScheme = trimmed.substring(7);
        const atIdx = withoutScheme.indexOf('@');
        if (atIdx > 0 && withoutScheme.lastIndexOf('@') === atIdx) {
            const auth = withoutScheme.substring(0, atIdx);
            const hostPort = withoutScheme.substring(atIdx + 1);
            const credParts = auth.split(':');
            const hpParts = hostPort.split(':');
            if (credParts.length >= 2 && hpParts.length >= 2) {
                const username = credParts[0];
                const password = credParts.slice(1).join(':');
                const host = hpParts[0];
                const port = hpParts[1];
                if (username && password && isValidHost(host) && isValidPort(port)) {
                    return { valid: true, ip: host, port, username, password, lineNumber };
                }
                return { valid: false, reason: 'invalid_credentials', lineNumber };
            }
        }
        return { valid: false, reason: 'invalid_url_format', lineNumber };
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
        return { valid: true, ip, port, username: '', password: '', lineNumber };
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
        return { valid: true, ip, port, username, password, lineNumber };
    }

    return { valid: false, reason: `invalid_field_count:${colonParts.length}`, lineNumber };
}

function buildHttpProxy(parsed) {
    if (!parsed || !parsed.valid || !parsed.ip || !parsed.port) return null;
    const encodedUser = parsed.username ? encodeURIComponent(parsed.username) : '';
    const encodedPass = parsed.password ? encodeURIComponent(parsed.password) : '';
    const auth = [encodedUser, encodedPass].filter(Boolean).join(':');
    const urlStr = auth
        ? `http://${auth}@${parsed.ip}:${parsed.port}`
        : `http://${parsed.ip}:${parsed.port}`;
    try {
        const u = new URL(urlStr);
        if (!u.hostname || u.hostname.includes(' ') || u.pathname !== '/' && u.pathname !== '') {
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
        if (u.username || u.password) {
            return `${u.protocol}//***:***@${u.hostname}:${u.port}`;
        }
        return proxyUrl;
    } catch {
        return '***';
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
        if (parsed.valid) {
            valid.push(parsed);
        } else {
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
//  Chrome 彻底清理（每次代理切换前必须执行）
// ============================================================
function killChromeProcesses() {
    try {
        execSync('pkill -f "chrome.*remote-debugging-port=9222" 2>/dev/null || true', { stdio: 'ignore' });
        console.log('[proxy-runner] 已发送 SIGTERM 给所有 Chrome 进程');
    } catch (e) {
        // pkill 可能找不到进程，不报错
    }
    // 补一刀 SIGKILL
    try {
        execSync('pkill -9 -f "chrome.*remote-debugging-port=9222" 2>/dev/null || true', { stdio: 'ignore' });
    } catch (e) { }
}

function isPortOpen(port) {
    try {
        execSync(`lsof -i :${port} 2>/dev/null || ss -tlnp sport = :${port} 2>/dev/null | grep -q LISTEN || ! nc -z localhost ${port} 2>/dev/null`, { stdio: 'ignore' });
        return false;
    } catch (e) {
        return true;
    }
}

function waitForPortClosed(port, timeoutMs = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            execSync(`! nc -z localhost ${port} 2>/dev/null`, { stdio: 'ignore' });
            console.log(`[proxy-runner] ${port} 端口已关闭`);
            return true;
        } catch (e) {
            // 端口仍开着
            try {
                execSync('pkill -9 -f "chrome.*remote-debugging-port=' + port + '" 2>/dev/null || true', { stdio: 'ignore' });
            } catch (e2) { }
        }
        const wait = require('child_process');
        execSync('sleep 0.5');
    }
    // 最后检查一次
    try {
        execSync(`! nc -z localhost ${port} 2>/dev/null`, { stdio: 'ignore' });
        return true;
    } catch (e) {
        console.error(`[proxy-runner] ${port} 端口未能关闭`);
        return false;
    }
}

function cleanChromeData() {
    const dir = '/tmp/chrome_user_data';
    try {
        if (fs.existsSync(dir)) {
            fs.rmSync(dir, { recursive: true, force: true });
            console.log('[proxy-runner] 已删除旧 Chrome 临时目录');
        }
    } catch (e) {
        console.log(`[proxy-runner] 删除 Chrome 目录失败: ${e.message}`);
    }
}

function ensureChromeKilled() {
    killChromeProcesses();
    const closed = waitForPortClosed(CHROME_PORT, 10000);
    if (!closed) {
        console.error(`[proxy-runner] ${CHROME_PORT} 端口未能关闭，不继续启动新 Chrome`);
        process.exit(EXIT_CODE.FATAL);
    }
    cleanChromeData();
}

// ============================================================
//  运行子进程
// ============================================================
function runActionRenew(parsed) {
    return new Promise((resolve) => {
        const env = buildChildEnv(parsed, process.env);
        if (!env) {
            console.error('[proxy-runner] 当前代理格式无效，不静默直连');
            process.exit(EXIT_CODE.FATAL);
        }

        if (parsed === null) {
            console.log('[proxy-runner] 无代理模式，已清除 HTTP_PROXY / HTTPS_PROXY');
        } else {
            console.log(`[proxy-runner] 设置 HTTP_PROXY=${safeProxyId(parsed)}`);
            const proxyUrl = buildHttpProxy(parsed);
            console.log(`[proxy-runner] 代理地址: ${maskProxyUrl(proxyUrl)}`);
            console.log(`::add-mask::${proxyUrl}`);
        }

        const scriptPath = path.join(process.cwd(), 'action_renew.js');
        console.log(`[proxy-runner] 启动 action_renew.js...`);

        const proc = spawn('node', [scriptPath], { env, stdio: 'inherit', shell: false });

        let timedOut = false;
        const timeout = setTimeout(() => {
            timedOut = true;
            console.error('[proxy-runner] action_renew.js 运行超时 (10min)，强制终止');
            proc.kill('SIGKILL');
        }, 10 * 60 * 1000);

        proc.on('exit', (code) => {
            clearTimeout(timeout);
            if (timedOut) {
                resolve({ code: EXIT_CODE.FATAL, timedOut: true });
                return;
            }
            const safeCode = (code !== null && code !== undefined) ? code : EXIT_CODE.FATAL;
            console.log(`[proxy-runner] action_renew.js 退出码: ${safeCode}`);
            resolve({ code: safeCode });
        });

        proc.on('error', (err) => {
            clearTimeout(timeout);
            console.error('[proxy-runner] 启动子进程失败:', err.message);
            resolve({ code: EXIT_CODE.FATAL });
        });
    });
}

// ============================================================
//  主流程
// ============================================================
async function main() {
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
                process.exit(EXIT_CODE.NO_PROXY_AVAILABLE);
            }
        } else if (proxyResult.configured) {
            console.log('[proxy-runner] proxies.txt 存在但无有效代理，禁止静默直连');
            process.exit(EXIT_CODE.NO_PROXY_AVAILABLE);
        } else {
            console.log('[proxy-runner] 未配置 proxies.txt，无代理直连');
        }

        // 2) 彻底杀死旧 Chrome，清理数据
        console.log('[proxy-runner] 正在关闭旧 Chrome');
        ensureChromeKilled();

        // 3) 跑业务脚本
        const result = await runActionRenew(selection || null);
        const code = result.code;

        // 4) 子进程结束后再杀一次 Chrome（action_renew.js 可能在 finally 中关，但双重保险）
        console.log('[proxy-runner] 确保子进程 Chrome 已关闭');
        killChromeProcesses();

        // 5) 按退出码决定
        if (NON_RETRYABLE.has(code)) {
            // NOT_READY(3) 和 ALREADY_RENEWED(4) 是正常业务状态，归一为 0 避免 GitHub Actions 显示失败
            const normalizedCode = (code === EXIT_CODE.NOT_READY || code === EXIT_CODE.ALREADY_RENEWED) ? EXIT_CODE.SUCCESS : code;
            if (code !== normalizedCode) {
                console.log(`[proxy-runner] 业务状态码 ${code} 归一为 ${normalizedCode}（正常业务，非失败）`);
            }
            console.log(`[proxy-runner] 不可重试退出码 ${normalizedCode}，结束本轮`);
            process.exit(normalizedCode);
        }

        if (code === EXIT_CODE.PROXY_RETRY && selection) {
            const parsed = selection;
            const key = proxyKey(parsed);
            console.log(`[proxy-runner] action_renew.js 退出码: 42`);
            console.log(`[proxy-runner] 代理 ${safeProxyId(parsed)} 加入冷却，时长 4h`);
            addCooldown(cooldowns, key, 'proxy_retry_from_action_renew');
            cooldowns = loadCooldowns();
            console.log(`[proxy-runner] 选择下一个代理`);
            continue;
        }

        if (code === EXIT_CODE.FATAL) {
            console.log(`[proxy-runner] 退出码 1 (FATAL)，非代理问题，停止`);
            process.exit(EXIT_CODE.FATAL);
        }

        // 未知退出码也停止（不是 PROXY_RETRY）
        console.log(`[proxy-runner] 未知退出码 ${code}，不换代理，停止`);
        process.exit(code);
    }

    console.log(`[proxy-runner] 已尝试 ${CONFIG.MAX_PROXY_SWITCHES} 个代理，均未成功`);
    process.exit(EXIT_CODE.FATAL);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
    main().catch((e) => {
        console.error(e);
        process.exit(EXIT_CODE.FATAL);
    });
}

module.exports = {
    parseProxyLine,
    buildHttpProxy,
    buildChildEnv,
    maskProxyUrl,
    loadProxies,
    selectRandomProxy,
    proxyKey,
    safeProxyId
};
