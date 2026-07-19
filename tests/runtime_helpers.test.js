const assert = require('assert');
const { EventEmitter } = require('events');
const {
    buildBrowserLaunchOptions,
    classifyProxyResponse,
    classifyProxyError,
    mergeExitCode,
    validateUsersConfig,
    safeAccountLabel,
    finalizeAccountResources,
    normalizeTimeoutMinutes,
    terminateProcessTree,
    runChildWithTimeout
} = require('../lib/runtime_helpers');
const { sendTelegramNotification } = require('../lib/telegram');

async function tests() {
    const noProxy = buildBrowserLaunchOptions(null);
    assert.strictEqual(noProxy.headless, false);
    assert.strictEqual(noProxy.proxy, undefined);
    assert.ok(Array.isArray(noProxy.args));

    const proxy = buildBrowserLaunchOptions({
        server: 'http://proxy.example.com:80',
        username: 'user',
        password: 'pa@ss:word'
    });
    assert.deepStrictEqual(proxy.proxy, {
        server: 'http://proxy.example.com:80',
        username: 'user',
        password: 'pa@ss:word'
    });
    assert.strictEqual(proxy.httpCredentials, undefined);

    for (const status of [200, 204, 302, 399, 401, 403, 404, 429]) {
        const result = classifyProxyResponse(status);
        assert.strictEqual(result.ok, true, `HTTP ${status} should prove target reachability`);
        assert.strictEqual(result.reachable, true);
    }
    assert.strictEqual(classifyProxyResponse(407).ok, false);
    assert.strictEqual(classifyProxyResponse(407).category, 'proxy_auth_failed');
    for (const status of [500, 501, 505, 599]) {
        const result = classifyProxyResponse(status);
        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.reachable, true);
        assert.strictEqual(result.category, 'target_server_error');
    }
    for (const status of [502, 503, 504]) {
        const result = classifyProxyResponse(status);
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.category, 'upstream_gateway_error');
    }
    assert.strictEqual(classifyProxyResponse(0).reachable, false);
    assert.strictEqual(mergeExitCode(5, 42), 42);
    assert.strictEqual(mergeExitCode(42, 5), 42);
    assert.strictEqual(mergeExitCode(43, 3), 43);
    assert.strictEqual(mergeExitCode(3, 4), 3);
    for (const error of [
        { code: 'ETIMEDOUT', message: 'timeout' },
        { code: 'ENOTFOUND', message: 'dns failure' },
        { code: 'ECONNRESET', message: 'connection reset' },
        { code: 'ECONNREFUSED', message: 'connection refused' }
    ]) {
        assert.strictEqual(classifyProxyError(error).category, 'transport_error');
    }

    assert.strictEqual(validateUsersConfig(undefined).fatal, true);
    assert.strictEqual(validateUsersConfig('not-json').fatal, true);
    assert.strictEqual(validateUsersConfig('{}').reason, 'invalid_root');
    assert.strictEqual(validateUsersConfig('[]').reason, 'empty_users');
    const mixedUsers = validateUsersConfig(JSON.stringify([
        { username: 'good@example.com', password: 'secret' },
        { username: '', password: 'p' },
        { username: 'second@example.com', password: 'secret2' }
    ]));
    assert.strictEqual(mixedUsers.valid, true);
    assert.strictEqual(mixedUsers.fatal, false);
    assert.strictEqual(mixedUsers.users.length, 3);
    assert.strictEqual(mixedUsers.users[0].__invalidConfig, false);
    assert.deepStrictEqual(
        { username: mixedUsers.users[1].username, password: mixedUsers.users[1].password, reason: mixedUsers.users[1].__invalidReason },
        { username: '', password: '', reason: 'invalid_username' }
    );
    assert.strictEqual(mixedUsers.users[2].username, 'second@example.com');
    const badFirst = validateUsersConfig(JSON.stringify([
        { username: '', password: 'p' },
        { username: 'later@example.com', password: 'p2' }
    ]));
    assert.strictEqual(badFirst.users[0].__invalidConfig, true);
    assert.strictEqual(badFirst.users[1].__invalidConfig, false);
    const badLast = validateUsersConfig(JSON.stringify([
        { username: 'first@example.com', password: 'p1' },
        { username: 'later@example.com', password: '' }
    ]));
    assert.strictEqual(badLast.users[0].__invalidConfig, false);
    assert.strictEqual(badLast.users[1].__invalidConfig, true);
    for (const invalidUser of [
        null,
        {},
        { username: 123, password: 'p' },
        { username: 'u' },
        { username: 'u', password: 123 }
    ]) {
        const result = validateUsersConfig(JSON.stringify([{ username: 'good', password: 'p' }, invalidUser, { username: 'later', password: 'p2' }]));
        assert.strictEqual(result.valid, true);
        assert.strictEqual(result.users.length, 3);
        assert.strictEqual(result.users[1].__invalidConfig, true);
        assert.strictEqual(result.users[2].username, 'later');
    }
    const validUsers = validateUsersConfig('{"users":[{"username":" u@example.com ","password":"p"}]}');
    assert.strictEqual(validUsers.valid, true);
    assert.strictEqual(validUsers.users[0].username, 'u@example.com');
    assert.strictEqual(safeAccountLabel({ username: 'a/b@c' }, 0), 'a_b_c');
    assert.strictEqual(safeAccountLabel({}, 2), 'user_3');

    let pageClosed = 0;
    let contextClosed = 0;
    const cleanupResult = await finalizeAccountResources({
        page: {
            screenshot: async () => { throw new Error('read-only screenshots'); },
            close: async () => { pageClosed++; }
        },
        context: { close: async () => { contextClosed++; } },
        ensureDir: async () => { throw new Error('disk full'); },
        screenshotName: 'account.png',
        logger: () => {}
    });
    assert.strictEqual(pageClosed, 1);
    assert.strictEqual(contextClosed, 1);
    assert.ok(cleanupResult.screenshotError);
    assert.strictEqual(cleanupResult.screenshotPath, null);
    assert.strictEqual(cleanupResult.pageCloseError, null);

    let screenshotPath = null;
    const successfulCleanup = await finalizeAccountResources({
        page: {
            screenshot: async options => { screenshotPath = options.path; },
            close: async () => {}
        },
        context: { close: async () => {} },
        ensureDir: async () => '/tmp/screenshots',
        screenshotName: 'account.png',
        logger: () => {}
    });
    assert.strictEqual(successfulCleanup.screenshotPath, '/tmp/screenshots/account.png');
    assert.strictEqual(screenshotPath, '/tmp/screenshots/account.png');

    let closeAfterScreenshot = 0;
    let contextCloseAfterPageError = 0;
    const secondCleanup = await finalizeAccountResources({
        page: {
            screenshot: async () => {},
            close: async () => { closeAfterScreenshot++; throw new Error('page close failed'); }
        },
        context: { close: async () => { contextCloseAfterPageError++; throw new Error('context close failed'); } },
        ensureDir: async () => '/tmp',
        screenshotName: 'account.png',
        logger: () => {}
    });
    assert.strictEqual(closeAfterScreenshot, 1);
    assert.strictEqual(contextCloseAfterPageError, 1);
    assert.ok(secondCleanup.pageCloseError);
    assert.ok(secondCleanup.contextCloseError);

    assert.strictEqual(normalizeTimeoutMinutes('25'), 25);
    assert.strictEqual(normalizeTimeoutMinutes('0'), 25);
    assert.strictEqual(normalizeTimeoutMinutes('-1'), 25);
    assert.strictEqual(normalizeTimeoutMinutes('30'), 25);
    assert.strictEqual(normalizeTimeoutMinutes('not-a-number'), 25);

    class FakeProcess extends EventEmitter {
        constructor(onKill) {
            super();
            this.pid = 9876;
            this.exitCode = null;
            this.signals = [];
            this.onKill = onKill;
        }
        kill(signal) {
            this.signals.push(signal);
            if (this.onKill) this.onKill(signal, this);
            return true;
        }
    }

    const normalProcess = new FakeProcess((signal, proc) => {
        if (signal === 'SIGTERM') setTimeout(() => proc.emit('exit', 0), 1);
    });
    const normalResultPromise = runChildWithTimeout(normalProcess, { timeoutMs: 30, gracefulMs: 10, logger: () => {}, killGroup: () => false });
    setTimeout(() => normalProcess.emit('exit', 0), 1);
    const normalResult = await normalResultPromise;
    assert.deepStrictEqual(normalResult, { code: 0, timedOut: false });
    assert.deepStrictEqual(normalProcess.signals, []);

    const gracefulProcess = new FakeProcess((signal, proc) => {
        if (signal === 'SIGTERM') setTimeout(() => proc.emit('exit', 0), 1);
    });
    const gracefulResult = await runChildWithTimeout(gracefulProcess, { timeoutMs: 5, gracefulMs: 20, logger: () => {}, killGroup: () => false });
    assert.strictEqual(gracefulResult.code, 1);
    assert.strictEqual(gracefulResult.timedOut, true);
    assert.deepStrictEqual(gracefulProcess.signals, ['SIGTERM']);

    const forcedProcess = new FakeProcess();
    const forcedResult = await runChildWithTimeout(forcedProcess, {
        timeoutMs: 5,
        gracefulMs: 5,
        finalSettlementMs: 5,
        logger: () => {},
        killGroup: () => false
    });
    assert.strictEqual(forcedResult.code, 1);
    assert.strictEqual(forcedResult.timedOut, true);
    assert.strictEqual(forcedResult.forced, true);
    assert.deepStrictEqual(forcedProcess.signals, ['SIGTERM', 'SIGKILL']);

    const raceProcess = new FakeProcess();
    const raceResultPromise = runChildWithTimeout(raceProcess, { timeoutMs: 30, logger: () => {}, killGroup: () => false });
    raceProcess.emit('exit', 0);
    raceProcess.emit('error', new Error('late error'));
    const raceResult = await raceResultPromise;
    assert.deepStrictEqual(raceResult, { code: 0, timedOut: false });
    assert.strictEqual(terminateProcessTree({ exitCode: 0 }, 'SIGTERM'), false);

    const axiosCalls = [];
    const axios = {
        post: async (...args) => {
            axiosCalls.push(args);
            if (axiosCalls.length === 1) throw new Error('telegram timeout');
        }
    };
    const errors = [];
    const fs = {
        existsSync: () => true,
        createReadStream: file => ({ file })
    };
    class FakeFormData {
        constructor() { this.fields = []; }
        append(name, value) { this.fields.push([name, value]); }
        getHeaders() { return { 'content-type': 'multipart/form-data; boundary=test' }; }
    }
    const telegramResult = await sendTelegramNotification({
        axios,
        FormData: FakeFormData,
        fs,
        token: 'token-for-test',
        chatId: 'chat-for-test',
        message: 'status',
        imagePath: '/tmp/account.png',
        logger: { error: (...args) => errors.push(args.join(' ')) }
    });
    assert.strictEqual(telegramResult.textSent, false);
    assert.strictEqual(telegramResult.imageSent, true);
    assert.strictEqual(axiosCalls.length, 2);
    assert.strictEqual(errors.length, 1);
    assert.strictEqual((await sendTelegramNotification({
        axios: { post: async () => {} },
        FormData: FakeFormData,
        fs: { existsSync: () => false },
        token: 'token-for-test',
        chatId: 'chat-for-test',
        message: 'text-only',
        imagePath: '/tmp/missing.png'
    })).imageSent, false);
    assert.strictEqual((await sendTelegramNotification({ axios, FormData: FakeFormData, fs, token: '', chatId: 'chat', message: 'x' })).skipped, true);

    console.log('[runtime helper tests] all tests passed');
}

tests().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
