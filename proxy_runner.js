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
//  代理选择
// ============================================================
function loadProxies() {
    if (!fs.existsSync(CONFIG.PROXIES_FILE)) {
        console.log('[proxy-runner] proxies.txt 不存在，直接运行（无代理）');
        return [];
    }
    const raw = fs.readFileSync(CONFIG.PROXIES_FILE, 'utf-8');
    const lines = raw.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    console.log(`[proxy-runner] proxies.txt 共 ${lines.length} 条有效代理`);
    return lines;
}

function selectRandomProxy(proxies, cooldowns) {
    const now = Math.floor(Date.now() / 1000);
    const available = proxies.filter(line => {
        const ip = line.split(':')[0];
        const port = line.split(':')[1];
        const key = `${ip}:${port}`;
        return !cooldowns[key] || cooldowns[key].until <= now;
    });

    if (available.length === 0) {
        console.log('[proxy-runner] 无可选代理（全部冷却中），本轮停止，不清空冷却名单');
        return null;
    }

    const line = available[crypto.randomInt(available.length)];
    const ip = line.split(':')[0];
    const port = line.split(':')[1];
    console.log(`[proxy-runner] 选择代理: ${ip}:${port}`);
    return { line, source: 'selected' };
}

function buildHttpProxy(line) {
    if (!line) return null;
    const parts = line.split(':');
    if (parts.length < 4) return null;
    return `http://${parts[2]}:${parts[3]}@${parts[0]}:${parts[1]}`;
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
function runActionRenew(proxyLine) {
    return new Promise((resolve) => {
        const env = { ...process.env };

        if (proxyLine) {
            const proxyUrl = buildHttpProxy(proxyLine);
            if (proxyUrl) {
                env.HTTP_PROXY = proxyUrl;
                env.HTTPS_PROXY = proxyUrl;
                const ip = proxyLine.split(':')[0];
                const port = proxyLine.split(':')[1];
                console.log(`[proxy-runner] 设置 HTTP_PROXY=${ip}:${port}`);
                // 屏蔽代理日志中的敏感信息
                console.log(`::add-mask::${proxyUrl}`);
                const parts = proxyLine.split(':');
                console.log(`::add-mask::${parts[2]}`);
                console.log(`::add-mask::${parts[3]}`);
            } else {
                delete env.HTTP_PROXY;
                delete env.HTTPS_PROXY;
            }
        } else {
            delete env.HTTP_PROXY;
            delete env.HTTPS_PROXY;
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
(async () => {
    console.log(`[proxy-runner] 启动代理轮换控制器`);
    console.log(`[proxy-runner] 最多尝试 ${CONFIG.MAX_PROXY_SWITCHES} 个代理，冷却 ${CONFIG.COOLDOWN_HOURS}h`);
    console.log(`[proxy-runner] 退出码映射: SUCCESS=0 FATAL=1 PROXY_RETRY=42 NOT_READY=3 ALREADY_RENEWED=4 LOGIN_FAILED=5 NO_PROXY_AVAILABLE=6 RENEW_CAPTCHA_FAILED=43`);

    const proxies = loadProxies();
    let cooldowns = loadCooldowns();
    removeExpiredCooldowns(cooldowns);

    for (let attempt = 1; attempt <= CONFIG.MAX_PROXY_SWITCHES; attempt++) {
        console.log(`\n[proxy-runner] ===== 代理尝试 ${attempt}/${CONFIG.MAX_PROXY_SWITCHES} =====`);

        // 1) 选代理
        let proxyLine = null;
        let selection = null;

        if (proxies.length > 0) {
            selection = selectRandomProxy(proxies, cooldowns);
            if (selection) {
                proxyLine = selection.line;
            } else {
                console.log('[proxy-runner] 无可选代理（全部冷却中），等待冷却过期');
                process.exit(EXIT_CODE.NO_PROXY_AVAILABLE);
            }
        } else {
            console.log('[proxy-runner] 无代理列表，直接运行');
        }

        // 2) 彻底杀死旧 Chrome，清理数据
        console.log('[proxy-runner] 正在关闭旧 Chrome');
        ensureChromeKilled();

        // 3) 跑业务脚本
        const result = await runActionRenew(proxyLine);
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

        if (code === EXIT_CODE.PROXY_RETRY && proxyLine && selection) {
            const ip = proxyLine.split(':')[0];
            const port = proxyLine.split(':')[1];
            const key = `${ip}:${port}`;
            // 立即冷却
            console.log(`[proxy-runner] action_renew.js 退出码: 42`);
            console.log(`[proxy-runner] 代理 ${ip}:${port} 加入冷却，时长 4h`);
            addCooldown(cooldowns, key, 'turnstile_failed_3_attempts');
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
})();