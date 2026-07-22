const path = require('path');

const DEFAULT_ACTION_TIMEOUT_MINUTES = 25;
const MAX_ACTION_TIMEOUT_MINUTES = 30;
const DEFAULT_GRACEFUL_TERMINATION_MS = 12_000;
const FINAL_SETTLEMENT_MS = 2_000;
const EXIT_CODE_PRIORITY = [1, 42, 5, 43, 3, 4, 0];

const CHROME_ARGS = [
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--window-size=1280,720',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled',
    '--lang=en-US',
    '--accept-lang=en-US,en'
];

function buildBrowserLaunchOptions(proxyConfig) {
    const options = {
        headless: false,
        args: [...CHROME_ARGS]
    };

    if (proxyConfig) {
        options.proxy = { server: proxyConfig.server };
        if (proxyConfig.username) options.proxy.username = proxyConfig.username;
        if (proxyConfig.password) options.proxy.password = proxyConfig.password;
    }

    return options;
}

function classifyProxyResponse(status) {
    const numericStatus = Number(status);
    const result = {
        ok: false,
        reachable: true,
        status: numericStatus,
        category: 'unknown_response',
        error: null
    };

    if (numericStatus >= 200 && numericStatus <= 399) {
        return { ...result, ok: true, category: 'target_reachable' };
    }
    if (numericStatus === 407) {
        return { ...result, category: 'proxy_auth_failed', error: 'Proxy authentication required (407)' };
    }
    if ([502, 503, 504].includes(numericStatus)) {
        return { ...result, category: 'upstream_gateway_error', error: `Upstream HTTP ${numericStatus}` };
    }
    if (numericStatus >= 500 && numericStatus <= 599) {
        return { ...result, ok: true, category: 'target_server_error' };
    }
    if (numericStatus >= 400 && numericStatus <= 499) {
        return { ...result, ok: true, category: 'target_reachable' };
    }

    return { ...result, reachable: false, error: `Unknown HTTP status ${status}` };
}

function classifyProxyError(error) {
    return {
        ok: false,
        reachable: false,
        status: error && error.response ? Number(error.response.status) : null,
        category: 'transport_error',
        error: error && error.message ? error.message : String(error || 'Unknown proxy error')
    };
}

function mergeExitCode(current, next) {
    const currentIndex = EXIT_CODE_PRIORITY.indexOf(current);
    const nextIndex = EXIT_CODE_PRIORITY.indexOf(next);
    if (currentIndex < 0 || nextIndex < 0) return current;
    return nextIndex < currentIndex ? next : current;
}

function validateUsersConfig(raw) {
    if (typeof raw !== 'string' || !raw.trim()) {
        return { valid: false, fatal: true, reason: 'missing_users', users: [] };
    }

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return { valid: false, fatal: true, reason: 'invalid_json', users: [] };
    }

    const users = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.users) ? parsed.users : null;
    if (!users) return { valid: false, fatal: true, reason: 'invalid_root', users: [] };
    if (users.length === 0) return { valid: false, fatal: true, reason: 'empty_users', users: [] };

    const normalized = users.map((user, index) => {
        if (!user || typeof user !== 'object' || Array.isArray(user)) {
            return {
                valid: false,
                index,
                reason: 'not_object',
                user: { username: '', password: '', __invalidConfig: true, __invalidReason: 'not_object' }
            };
        }
        if (typeof user.username !== 'string' || !user.username.trim()) {
            return {
                valid: false,
                index,
                reason: 'invalid_username',
                user: { username: '', password: '', __invalidConfig: true, __invalidReason: 'invalid_username' }
            };
        }
        if (typeof user.password !== 'string' || !user.password) {
            return {
                valid: false,
                index,
                reason: 'invalid_password',
                user: { username: user.username.trim(), password: '', __invalidConfig: true, __invalidReason: 'invalid_password' }
            };
        }
        return { valid: true, index, user: { ...user, username: user.username.trim(), __invalidConfig: false } };
    });

    return {
        valid: true,
        fatal: false,
        users: normalized.map(item => item.user)
    };
}

function safeAccountLabel(user, index) {
    const username = user && typeof user.username === 'string' ? user.username : '';
    const label = username.replace(/[^a-z0-9]/gi, '_').replace(/^_+|_+$/g, '');
    return label || `user_${Number(index) + 1}`;
}

async function finalizeAccountResources({ page, context, ensureDir, screenshotName, closeContext = true, logger = () => {} }) {
    const result = {
        screenshotPath: null,
        screenshotError: null,
        pageCloseError: null,
        contextCloseError: null
    };

    if (page) {
        try {
            const photoDir = await ensureDir();
            result.screenshotPath = path.resolve(photoDir, screenshotName);
            await page.screenshot({ path: result.screenshotPath, fullPage: true });
        } catch (error) {
            result.screenshotPath = null;
            result.screenshotError = error;
            logger(`[cleanup] screenshot failed: ${error.message}`);
        }
    }

    if (page) {
        try {
            await page.close();
        } catch (error) {
            result.pageCloseError = error;
            logger(`[cleanup] page.close failed: ${error.message}`);
        }
    }

    if (context && closeContext) {
        try {
            await context.close();
        } catch (error) {
            result.contextCloseError = error;
            logger(`[cleanup] context.close failed: ${error.message}`);
        }
    }

    return result;
}

function normalizeTimeoutMinutes(value) {
    const minutes = typeof value === 'string' && value.trim() ? Number(value) : Number(value);
    if (!Number.isFinite(minutes) || minutes < 1 || minutes >= MAX_ACTION_TIMEOUT_MINUTES) {
        return DEFAULT_ACTION_TIMEOUT_MINUTES;
    }
    return minutes;
}

function terminateProcessTree(proc, signal, killGroup = null) {
    if (!proc || (proc.exitCode !== null && proc.exitCode !== undefined)) return false;

    const killPg = killGroup || ((pid, sig) => {
        try { process.kill(-pid, sig); return true; } catch { return false; }
    });

    try {
        if (proc.pid && killPg(proc.pid, signal)) return true;
    } catch (error) {
        // Fall back to the child PID when the process group is unavailable.
    }

    try {
        if (typeof proc.kill === 'function') {
            return proc.kill(signal);
        }
    } catch (error) {
        return false;
    }
    return false;
}

function runChildWithTimeout(proc, {
    timeoutMs,
    gracefulMs = DEFAULT_GRACEFUL_TERMINATION_MS,
    finalSettlementMs = FINAL_SETTLEMENT_MS,
    logger = console.error,
    killGroup = null
} = {}) {
    return new Promise((resolve) => {
        let settled = false;
        let timedOut = false;
        let timeout = null;
        let gracefulTimeout = null;
        let finalSettlementTimeout = null;

        const finish = (result) => {
            if (settled) return;
            settled = true;
            if (timeout) clearTimeout(timeout);
            if (gracefulTimeout) clearTimeout(gracefulTimeout);
            if (finalSettlementTimeout) clearTimeout(finalSettlementTimeout);
            resolve(result);
        };

        if (!proc || typeof proc.on !== 'function') {
            finish({ code: 1, timedOut: false, error: new Error('Child process was not created') });
            return;
        }

        timeout = setTimeout(() => {
            if (settled) return;
            timedOut = true;
            logger(`[proxy-runner] action_renew.js 运行超时，先发送 SIGTERM，宽限 ${Math.round(gracefulMs / 1000)} 秒`);
            terminateProcessTree(proc, 'SIGTERM', killGroup);
            gracefulTimeout = setTimeout(() => {
                if (settled) return;
                logger('[proxy-runner] action_renew.js 未在宽限期退出，发送 SIGKILL 终止进程树');
                terminateProcessTree(proc, 'SIGKILL', killGroup);
                finalSettlementTimeout = setTimeout(() => {
                    if (settled) return;
                    finish({ code: 1, timedOut: true, forced: true });
                }, finalSettlementMs);
            }, gracefulMs);
        }, timeoutMs);

        proc.on('exit', (code) => {
            finish({
                code: timedOut ? 1 : (code === null || code === undefined ? 1 : code),
                timedOut
            });
        });
        proc.on('error', (error) => {
            finish({ code: 1, timedOut, error });
        });
    });
}

module.exports = {
    buildBrowserLaunchOptions,
    classifyProxyResponse,
    classifyProxyError,
    mergeExitCode,
    validateUsersConfig,
    safeAccountLabel,
    finalizeAccountResources,
    normalizeTimeoutMinutes,
    terminateProcessTree,
    runChildWithTimeout,
    DEFAULT_ACTION_TIMEOUT_MINUTES,
    DEFAULT_GRACEFUL_TERMINATION_MS,
    FINAL_SETTLEMENT_MS
};
