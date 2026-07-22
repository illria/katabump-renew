const assert = require('assert');
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

function runCheck() {
    execFileSync(process.execPath, ['--check', '../proxy_runner.js'], { cwd: __dirname, stdio: 'pipe' });
    execFileSync(process.execPath, ['--check', '../action_renew.js'], { cwd: __dirname, stdio: 'pipe' });
}

function safeRequire() {
    const proxyPath = path.join(__dirname, '..', 'proxy_runner.js');
    delete require.cache[require.resolve(proxyPath)];
    return require(proxyPath);
}

function tests() {
    const mod = safeRequire();
    assert.strictEqual(typeof mod.parseProxyLine, 'function');
    assert.strictEqual(typeof mod.buildHttpProxy, 'function');
    assert.strictEqual(typeof mod.maskProxyUrl, 'function');
    assert.strictEqual(typeof mod.emitGithubMask, 'function');
    assert.strictEqual(typeof mod.loadProxies, 'function');
    assert.strictEqual(typeof mod.selectRandomProxy, 'function');
    assert.strictEqual(typeof mod.proxyKey, 'function');
    assert.strictEqual(typeof mod.safeProxyId, 'function');

    const samples = [
        {
            line: '1.2.3.4:8080:user:password',
            expect: { ip: '1.2.3.4', port: '8080', username: 'user', password: 'password', valid: true }
        },
        {
            line: 'http://user:pass@1.2.3.4:8080',
            expect: { ip: '1.2.3.4', port: '8080', username: 'user', password: 'pass', valid: true }
        },
        {
            line: 'http://user:pass@host:8080:garbage',
            expect: { valid: false, reason: 'invalid_url_format' }
        },
        {
            line: 'http://user:pa%40ss@host:8080',
            expect: { ip: 'host', port: '8080', username: 'user', password: 'pa@ss', valid: true }
        },
        {
            line: '1.2.3.4:8080',
            expect: { ip: '1.2.3.4', port: '8080', username: '', password: '', valid: true }
        },
        {
            line: 'host:80',
            expect: { ip: 'host', port: '80', username: '', password: '', valid: true }
        },
        {
            line: 'Proxy.EXAMPLE.com:8080:user:pass',
            expect: { ip: 'proxy.example.com', port: '8080', username: 'user', password: 'pass', valid: true }
        },
        {
            line: '1.2.3.4:0',
            expect: { valid: false, reason: 'invalid_port:0' }
        },
        {
            line: '1.2.3.4:65536',
            expect: { valid: false, reason: 'invalid_port:65536' }
        },
        {
            line: '1.2.3.4:1e3',
            expect: { valid: false, reason: 'invalid_port:1e3' }
        },
        {
            line: '1.2.3.4:0x50',
            expect: { valid: false, reason: 'invalid_port:0x50' }
        },
        {
            line: '1.2.3.4:+8080',
            expect: { valid: false, reason: 'invalid_port:+8080' }
        },
        {
            line: 'abc:def',
            expect: { valid: false, reason: 'invalid_port:def' }
        },
        {
            line: '1.2.3.4:8080:user',
            expect: { valid: false, reason: 'invalid_field_count:3' }
        },
        {
            line: '1.2.3.4:8080:user:pa@ss',
            expect: { ip: '1.2.3.4', port: '8080', username: 'user', password: 'pa@ss', valid: true }
        },
        {
            line: '',
            expect: { valid: false, reason: 'empty_or_comment' }
        },
        {
            line: '# comment',
            expect: { valid: false, reason: 'empty_or_comment' }
        },
        {
            line: '1.2.3.4:8080::password',
            expect: { valid: false, reason: 'invalid_credentials' }
        },
        {
            line: '1.2.3.4:8080:username:',
            expect: { valid: false, reason: 'invalid_credentials' }
        },
        {
            line: '1.2.3.4:8080::',
            expect: { valid: false, reason: 'invalid_credentials' }
        },
        {
            line: 'user1:8080:pass@host:3128',
            expect: { ip: 'user1', port: '8080', username: 'pass@host', password: '3128', valid: true }
        },
        {
            line: 'user:pass@host:8080',
            expect: { valid: false, reason: 'invalid_field_count:3' }
        },
        {
            line: 'proxy:8080:user:pa@ss',
            expect: { ip: 'proxy', port: '8080', username: 'user', password: 'pa@ss', valid: true }
        },
        {
            line: 'bad host:8080',
            expect: { valid: false, reason: 'invalid_host' }
        },
        {
            line: 'foo@bar:8080',
            expect: { valid: false, reason: 'invalid_host' }
        },
        {
            line: 'bad%host:8080',
            expect: { ip: 'bad%host', port: '8080', username: '', password: '', valid: true, builds: false }
        },
        {
            line: '1.2.3.4:8080:user:pa@ss:one:two',
            expect: { ip: '1.2.3.4', port: '8080', username: 'user', password: 'pa@ss:one:two', valid: true }
        },
    ];

    for (const sample of samples) {
        const parsed = mod.parseProxyLine(sample.line);
        assert.strictEqual(parsed.valid, sample.expect.valid, `valid mismatch: ${sample.line}`);
        assert.strictEqual(parsed.reason, sample.expect.reason, `reason mismatch: ${sample.line}`);
        assert.strictEqual(parsed.ip, sample.expect.ip, `ip mismatch: ${sample.line}`);
        assert.strictEqual(parsed.port, sample.expect.port, `port mismatch: ${sample.line}`);
        assert.strictEqual(parsed.username, sample.expect.username, `username mismatch: ${sample.line}`);
        assert.strictEqual(parsed.password, sample.expect.password, `password mismatch: ${sample.line}`);
        if (parsed.valid) {
            const built = mod.buildHttpProxy(parsed);
            if (sample.expect.builds === false) {
                assert.strictEqual(built, null, `build should reject: ${sample.line}`);
                continue;
            }
            assert.strictEqual(built, `http://${parsed.username ? `${encodeURIComponent(parsed.username)}:${encodeURIComponent(parsed.password)}@` : ''}${parsed.ip}:${parsed.port}`);
            assert.strictEqual(mod.proxyKey(parsed), `${parsed.ip}:${parsed.port}`);
            assert.strictEqual(mod.safeProxyId(parsed), `${parsed.ip}:${parsed.port}`);
        }
    }

    const masked = mod.maskProxyUrl('http://myuser:mypass@1.2.3.4:8080');
    assert.ok(!masked.includes('myuser'), 'masked url must not include username');
    assert.ok(!masked.includes('mypass'), 'masked url must not include password');

    const maskedDefaultPort = mod.maskProxyUrl('http://myuser:mypass@host:80');
    assert.strictEqual(maskedDefaultPort, 'http://***:***@host:80');

    assert.strictEqual(
        mod.buildHttpProxy({ valid: true, ip: 'foo@bar', port: '8080', username: '', password: '' }),
        null,
        'host containing @ must not be reinterpreted as URL credentials'
    );

    const retryAttempt = {
        attempt: 1,
        code: 42,
        status: 'login_captcha_required',
        message: 'Turnstile adapter error',
        screenshotPath: 'screenshots/retry.png',
        htmlPath: 'screenshots/retry.html',
        accounts: [{ status: 'login_captcha_required' }]
    };
    const notReadyAttempt = {
        attempt: 2,
        code: 3,
        status: 'not_ready',
        message: "You can't renew your server yet",
        screenshotPath: 'screenshots/not_ready_after_2.png',
        htmlPath: 'screenshots/not_ready_after_2.html',
        accounts: [{ status: 'not_ready' }]
    };
    const notReadySummary = mod.buildFinalSummary(0, notReadyAttempt, [retryAttempt, notReadyAttempt]);
    assert.strictEqual(notReadySummary.status, 'not_ready');
    assert.strictEqual(notReadySummary.screenshotPath, 'screenshots/not_ready_after_2.png');
    assert.ok(mod.formatFinalNotification(notReadySummary).includes('最终状态：not_ready'));
    assert.ok(!mod.formatFinalNotification(notReadySummary).includes('retry.png'));

    const successAttempt = {
        ...notReadyAttempt,
        code: 0,
        status: 'success',
        screenshotPath: 'screenshots/success_after_2.png',
        accounts: [{ status: 'success' }]
    };
    const successSummary = mod.buildFinalSummary(0, successAttempt, [retryAttempt, successAttempt]);
    assert.strictEqual(successSummary.status, 'success');
    assert.strictEqual(successSummary.screenshotPath, 'screenshots/success_after_2.png');

    const exhaustedAttempts = [
        retryAttempt,
        { ...retryAttempt, attempt: 2, screenshotPath: 'screenshots/retry-2.png' },
        { ...retryAttempt, attempt: 3, screenshotPath: 'screenshots/retry-3.png' },
        { ...retryAttempt, attempt: 4, screenshotPath: 'screenshots/retry-4.png' },
        { ...retryAttempt, attempt: 5, screenshotPath: 'screenshots/retry-5.png' }
    ];
    const exhaustedSummary = mod.buildFinalSummary(1, exhaustedAttempts[exhaustedAttempts.length - 1], exhaustedAttempts);
    assert.strictEqual(exhaustedSummary.status, 'proxy_exhausted');
    assert.strictEqual(exhaustedSummary.screenshotPath, 'screenshots/retry-5.png');

    const fatalSummary = mod.buildFinalSummary(1, {
        code: 1,
        status: 'error',
        message: 'fatal error',
        screenshotPath: null,
        accounts: []
    }, []);
    assert.strictEqual(fatalSummary.screenshotPath, null);
    assert.ok(mod.formatFinalNotification(fatalSummary).includes('最终状态：error'));

    const localMaskOutput = [];
    mod.emitGithubMask('http://user:pass@host:8080', { GITHUB_ACTIONS: 'false' }, line => localMaskOutput.push(line));
    assert.deepStrictEqual(localMaskOutput, [], 'local runs must not print GitHub mask commands');
    mod.emitGithubMask('http://user:pass@host:8080', { GITHUB_ACTIONS: 'true' }, line => localMaskOutput.push(line));
    assert.deepStrictEqual(localMaskOutput, ['::add-mask::http://user:pass@host:8080']);

    const selected = mod.selectRandomProxy([mod.parseProxyLine('1.2.3.4:8080:user:pass')], {});
    assert.ok(selected, 'selectRandomProxy should return parsed object');
    assert.strictEqual(selected.username, 'user', 'selected parsed should preserve username');

    // loadProxies: no file → configured=false
    {
        const origExistsSync = fs.existsSync;
        fs.existsSync = () => false;
        try {
            const noFile = mod.loadProxies();
            assert.strictEqual(noFile.configured, false);
            assert.deepStrictEqual(noFile.valid, []);
            assert.strictEqual(noFile.invalidCount, 0);
        } finally {
            fs.existsSync = origExistsSync;
        }
    }

    // loadProxies: file with all invalid → configured=true, valid=[]
    {
        const origExistsSync = fs.existsSync;
        const origReadFileSync = fs.readFileSync;
        fs.existsSync = () => true;
        fs.readFileSync = () => '1.2.3.4:99999:user:pass\nbadline\nbad%host:8080\n';
        try {
            const allInvalid = mod.loadProxies();
            assert.strictEqual(allInvalid.configured, true);
            assert.deepStrictEqual(allInvalid.valid, []);
            assert.strictEqual(allInvalid.invalidCount, 3);
        } finally {
            fs.existsSync = origExistsSync;
            fs.readFileSync = origReadFileSync;
        }
    }

    // loadProxies: file with mix → configured=true, valid has good lines
    {
        const origExistsSync = fs.existsSync;
        const origReadFileSync = fs.readFileSync;
        fs.existsSync = () => true;
        fs.readFileSync = () => '1.2.3.4:8080:user:pass\nbadline\nbad%host:8080\n5.6.7.8:3128:u2:p2\n';
        try {
            const mixed = mod.loadProxies();
            assert.strictEqual(mixed.configured, true);
            assert.strictEqual(mixed.valid.length, 2);
            assert.strictEqual(mixed.invalidCount, 2);
        } finally {
            fs.existsSync = origExistsSync;
            fs.readFileSync = origReadFileSync;
        }
    }

    // loadProxies: preserves original line numbers (skipping blank/comment lines)
    {
        const origExistsSync = fs.existsSync;
        const origReadFileSync = fs.readFileSync;
        fs.existsSync = () => true;
        fs.readFileSync = () => '# header\n\n1.2.3.4:99999:u:p\n5.6.7.8:8080:u2:p2\n';
        try {
            const withHeader = mod.loadProxies();
            assert.strictEqual(withHeader.configured, true);
            assert.strictEqual(withHeader.valid.length, 1);
            assert.strictEqual(withHeader.invalidCount, 1);
            // The valid line is on original line 4 (after 2 header/blank lines)
            assert.strictEqual(withHeader.valid[0].lineNumber, 4);
        } finally {
            fs.existsSync = origExistsSync;
            fs.readFileSync = origReadFileSync;
        }
    }

    // buildChildEnv: null parsed clears all proxy env vars
    {
        const base = { ...process.env };
        base.HTTP_PROXY = 'http://old:proxy';
        base.HTTPS_PROXY = 'http://old:proxy';
        base.http_proxy = 'http://old:proxy';
        base.https_proxy = 'http://old:proxy';
        const cleaned = mod.buildChildEnv(null, base);
        assert.strictEqual(cleaned.HTTP_PROXY, undefined);
        assert.strictEqual(cleaned.HTTPS_PROXY, undefined);
        assert.strictEqual(cleaned.http_proxy, undefined);
        assert.strictEqual(cleaned.https_proxy, undefined);
    }

    // buildChildEnv: valid parsed sets all four proxy env vars and clears old lowercase
    {
        const base = { ...process.env };
        base.http_proxy = 'http://old:lower';
        base.https_proxy = 'http://old:lower';
        const cleaned = mod.buildChildEnv(mod.parseProxyLine('1.2.3.4:8080:user:pass'), base);
        assert.ok(cleaned.HTTP_PROXY.includes('1.2.3.4:8080'));
        assert.ok(cleaned.HTTPS_PROXY.includes('1.2.3.4:8080'));
        assert.ok(cleaned.http_proxy.includes('1.2.3.4:8080'));
        assert.ok(cleaned.https_proxy.includes('1.2.3.4:8080'));
    }

    console.log('[proxy-runner tests] all tests passed');
}

try {
    runCheck();
    tests();
} catch (e) {
    console.error('[proxy-runner tests] failed:', e.message);
    process.exit(1);
}
