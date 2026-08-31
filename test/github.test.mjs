// Unit tests for the GitHub client's pure logic and request shaping.
// fetch is stubbed, so nothing here touches the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    GitHubError,
    buildTree,
    decodeBase64,
    describeFailure,
    encodeBase64,
    getFile,
    languageForPath,
    parseRepo,
    putFile,
} from '../frontend/src/github.js';

const realFetch = globalThis.fetch;

/** Queue up responses and record the requests made against them. */
function stubFetch(responses) {
    const calls = [];
    globalThis.fetch = async (url, init = {}) => {
        calls.push({
            url,
            method: init.method ?? 'GET',
            body: init.body ? JSON.parse(init.body) : null,
            headers: init.headers ?? {},
        });
        const next = responses.shift();
        if (!next) throw new Error(`unexpected request: ${url}`);
        return {
            ok: next.status >= 200 && next.status < 300,
            status: next.status,
            headers: { get: (key) => next.headers?.[key.toLowerCase()] ?? null },
            json: async () => next.body,
        };
    };
    return calls;
}

test.afterEach(() => { globalThis.fetch = realFetch; });

test('parseRepo accepts the forms people actually paste', () => {
    assert.deepEqual(parseRepo('owner/repo'), { owner: 'owner', repo: 'repo' });
    assert.deepEqual(parseRepo('  owner/repo  '), { owner: 'owner', repo: 'repo' });
    assert.deepEqual(parseRepo('https://github.com/owner/repo'), { owner: 'owner', repo: 'repo' });
    assert.deepEqual(parseRepo('https://github.com/owner/repo.git'), { owner: 'owner', repo: 'repo' });
    assert.deepEqual(parseRepo('git@github.com:owner/repo.git'), { owner: 'owner', repo: 'repo' });

    assert.equal(parseRepo('owner'), null);
    assert.equal(parseRepo('owner/repo/extra'), null);
    assert.equal(parseRepo(''), null);
    assert.equal(parseRepo(undefined), null);
});

test('languageForPath maps only runnable extensions', () => {
    assert.equal(languageForPath('src/app.js'), 'javascript');
    assert.equal(languageForPath('src/App.jsx'), 'javascript');
    assert.equal(languageForPath('main.PY'), 'python');
    assert.equal(languageForPath('Main.java'), 'java');
    assert.equal(languageForPath('a/b/c.hpp'), 'cpp');

    assert.equal(languageForPath('README.md'), null);
    assert.equal(languageForPath('logo.png'), null);
    assert.equal(languageForPath('Dockerfile'), null);
});

test('base64 survives a UTF-8 round trip', () => {
    // btoa/atob are Latin-1, so this is the case that silently corrupts if the
    // encoder skips TextEncoder/TextDecoder.
    const samples = [
        'plain ascii',
        'emoji 🚀 and accents éüñ',
        'CJK 日本語のコード',
        'System.out.println("héllo — wörld");',
        '',
    ];
    for (const sample of samples) {
        assert.equal(decodeBase64(encodeBase64(sample)), sample, `round trip failed: ${sample}`);
    }
});

test('base64 handles a payload large enough to break naive spreading', () => {
    const big = 'x'.repeat(200_000);
    assert.equal(decodeBase64(encodeBase64(big)), big);
});

test('decodeBase64 tolerates the newlines GitHub inserts', () => {
    const encoded = encodeBase64('hello world');
    const wrapped = encoded.replace(/(.{4})/g, '$1\n');
    assert.equal(decodeBase64(wrapped), 'hello world');
});

test('buildTree nests flat paths, folders first then alphabetical', () => {
    const nodes = buildTree([
        { path: 'README.md', type: 'blob', size: 10 },
        { path: 'src/main.jsx', type: 'blob', size: 20 },
        { path: 'src', type: 'tree' },
        { path: 'src/components/App.jsx', type: 'blob', size: 30 },
        { path: 'src/components', type: 'tree' },
        { path: 'backend/index.js', type: 'blob', size: 40 },
    ]);

    assert.deepEqual(nodes.map((n) => n.name), ['backend', 'src', 'README.md']);

    const src = nodes.find((n) => n.name === 'src');
    assert.deepEqual(src.children.map((n) => n.name), ['components', 'main.jsx']);

    const components = src.children[0];
    assert.equal(components.children[0].path, 'src/components/App.jsx');
    assert.equal(components.children[0].size, 30);
});

test('buildTree infers folders that were never listed', () => {
    // A truncated tree can reference a directory without an entry for it.
    const nodes = buildTree([{ path: 'deep/a/b/file.js', type: 'blob', size: 1 }]);
    assert.equal(nodes[0].name, 'deep');
    assert.equal(nodes[0].children[0].children[0].children[0].name, 'file.js');
});

test('buildTree survives empty and malformed input', () => {
    assert.deepEqual(buildTree([]), []);
    assert.deepEqual(buildTree(undefined), []);
    assert.deepEqual(buildTree([{ type: 'blob' }]), []);
});

test('describeFailure explains the statuses that actually happen', () => {
    assert.match(describeFailure(401, '', '50'), /rejected the token/i);
    assert.match(describeFailure(403, '', '0'), /rate limit/i);
    assert.match(describeFailure(403, 'Resource not accessible', '50'), /permission/i);
    assert.match(describeFailure(404, '', '50'), /not found/i);
    assert.match(describeFailure(409, '', '50'), /changed on GitHub/i);
    assert.equal(describeFailure(422, 'Reference already exists', '50'), 'Reference already exists');
});

test('getFile decodes content and reports the blob sha', async () => {
    const calls = stubFetch([{
        status: 200,
        headers: { 'x-ratelimit-remaining': '4999' },
        body: { encoding: 'base64', content: encodeBase64('println("héllo")'), sha: 'abc123' },
    }]);

    const file = await getFile({
        owner: 'o', repo: 'r', path: 'src/a b/Main.java', ref: 'main', token: 't',
    });

    assert.equal(file.text, 'println("héllo")');
    assert.equal(file.sha, 'abc123');
    assert.equal(file.remaining, '4999');

    // Path segments are encoded individually so the slashes stay real.
    assert.match(calls[0].url, /contents\/src\/a%20b\/Main\.java\?ref=main$/);
    assert.equal(calls[0].headers.Authorization, 'Bearer t');
});

test('getFile refuses a file GitHub would not inline', async () => {
    stubFetch([{ status: 200, body: { encoding: 'none', content: '', sha: 'x' } }]);
    await assert.rejects(
        () => getFile({ owner: 'o', repo: 'r', path: 'big.js', ref: 'main' }),
        /too large/i
    );
});

test('putFile sends sha when updating and omits it when creating', async () => {
    let calls = stubFetch([{ status: 200, body: { content: { sha: 'new' }, commit: {} } }]);
    await putFile({
        owner: 'o', repo: 'r', path: 'a.js', message: 'm',
        text: 'code', branch: 'main', sha: 'old', token: 't',
    });
    assert.equal(calls[0].method, 'PUT');
    assert.equal(calls[0].body.sha, 'old');
    assert.equal(calls[0].body.branch, 'main');
    assert.equal(decodeBase64(calls[0].body.content), 'code');

    calls = stubFetch([{ status: 200, body: { content: { sha: 'new' }, commit: {} } }]);
    await putFile({
        owner: 'o', repo: 'r', path: 'a.js', message: 'm',
        text: 'code', branch: 'main', sha: undefined, token: 't',
    });
    assert.ok(!('sha' in calls[0].body), 'sha must be absent when creating a file');
});

test('a failed request raises GitHubError carrying the status', async () => {
    stubFetch([{
        status: 409,
        headers: { 'x-ratelimit-remaining': '4998' },
        body: { message: 'is at 1234 but expected 5678' },
    }]);

    await assert.rejects(
        () => putFile({ owner: 'o', repo: 'r', path: 'a.js', message: 'm', text: 'c', token: 't' }),
        (err) => {
            assert.ok(err instanceof GitHubError);
            assert.equal(err.status, 409);
            assert.equal(err.remaining, '4998');
            assert.match(err.message, /changed on GitHub/i);
            return true;
        }
    );
});

test('no Authorization header is sent without a token', async () => {
    const calls = stubFetch([{
        status: 200,
        body: { encoding: 'base64', content: encodeBase64('x'), sha: 's' },
    }]);
    await getFile({ owner: 'o', repo: 'r', path: 'a.js', ref: 'main' });
    assert.ok(!('Authorization' in calls[0].headers));
});
