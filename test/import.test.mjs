// Unit tests for bulk import: which files are eligible, and how a batch read
// behaves when some of it fails. fetch is stubbed, so nothing here touches GitHub.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTree, flattenFiles } from '../frontend/src/tree.js';
import { getFiles, isSkippedPath, MAX_IMPORT_FILES } from '../frontend/src/github.js';

const TREE = buildTree([
    { path: 'README.md', type: 'blob', size: 100 },
    { path: 'src/main.js', type: 'blob', size: 200 },
    { path: 'src/util/helper.js', type: 'blob', size: 300 },
    { path: 'node_modules/dep/index.js', type: 'blob', size: 400 },
    { path: 'empty', type: 'tree' },
]);

test('flattenFiles returns only files, folders excluded', () => {
    const paths = flattenFiles(TREE).map((node) => node.path);

    assert.deepEqual(paths.slice().sort(), [
        'README.md',
        'node_modules/dep/index.js',
        'src/main.js',
        'src/util/helper.js',
    ]);
});

test('flattenFiles keeps the size so callers can apply a cap', () => {
    const helper = flattenFiles(TREE).find((node) => node.path.endsWith('helper.js'));
    assert.equal(helper.size, 300);
});

test('flattenFiles tolerates empty input', () => {
    assert.deepEqual(flattenFiles([]), []);
    assert.deepEqual(flattenFiles(undefined), []);
});

test('isSkippedPath rejects dependency and build directories at any depth', () => {
    assert.equal(isSkippedPath('node_modules/dep/index.js'), true);
    assert.equal(isSkippedPath('packages/app/dist/bundle.js'), true);
    assert.equal(isSkippedPath('a/__pycache__/mod.py'), true);
    assert.equal(isSkippedPath('src/main.js'), false);
    // Only whole segments count, so a legitimate file is not caught by substring.
    assert.equal(isSkippedPath('src/distance.js'), false);
    assert.equal(isSkippedPath('src/building.py'), false);
});

test('the import cap is a real limit, not unbounded', () => {
    assert.ok(Number.isInteger(MAX_IMPORT_FILES) && MAX_IMPORT_FILES > 0);
});

// --- getFiles ---------------------------------------------------------------

function stubFetch(handler) {
    const original = globalThis.fetch;
    globalThis.fetch = handler;
    return () => { globalThis.fetch = original; };
}

const ok = (body, remaining = '58') => ({
    ok: true,
    status: 200,
    headers: { get: (name) => (name === 'x-ratelimit-remaining' ? remaining : null) },
    json: async () => body,
});

const contents = (text, sha) => ok({
    encoding: 'base64',
    content: Buffer.from(text, 'utf8').toString('base64'),
    sha,
});

test('getFiles reads every path and returns them sorted', async () => {
    const restore = stubFetch(async (url) => {
        const name = decodeURIComponent(String(url).split('/contents/')[1].split('?')[0]);
        return contents(`body of ${name}`, `sha-${name}`);
    });

    try {
        const result = await getFiles({
            owner: 'o',
            repo: 'r',
            ref: 'main',
            paths: ['src/b.js', 'a.js', 'src/c.js'],
        });

        assert.deepEqual(result.loaded.map((f) => f.path), ['a.js', 'src/b.js', 'src/c.js']);
        assert.equal(result.loaded[0].text, 'body of a.js');
        assert.equal(result.loaded[0].sha, 'sha-a.js');
        assert.deepEqual(result.failed, []);
        assert.equal(result.remaining, '58');
    } finally {
        restore();
    }
});

test('one unreadable file does not abandon the whole import', async () => {
    const restore = stubFetch(async (url) => {
        if (String(url).includes('broken.js')) {
            return {
                ok: false,
                status: 404,
                headers: { get: () => '57' },
                json: async () => ({ message: 'Not Found' }),
            };
        }
        return contents('fine', 'sha');
    });

    try {
        const result = await getFiles({
            owner: 'o',
            repo: 'r',
            ref: 'main',
            paths: ['good.js', 'broken.js', 'also-good.js'],
        });

        assert.deepEqual(result.loaded.map((f) => f.path), ['also-good.js', 'good.js']);
        assert.equal(result.failed.length, 1);
        assert.equal(result.failed[0].path, 'broken.js');
        assert.match(result.failed[0].message, /Not found/i);
    } finally {
        restore();
    }
});

test('getFiles reports progress once per file', async () => {
    const restore = stubFetch(async () => contents('x', 's'));

    try {
        const seen = [];
        const paths = ['a.js', 'b.js', 'c.js', 'd.js', 'e.js'];
        await getFiles({
            owner: 'o', repo: 'r', ref: 'main', paths,
            onProgress: (done, total) => seen.push([done, total]),
        });

        assert.equal(seen.length, paths.length);
        // Workers run in parallel, so completion order is not guaranteed, but the
        // counter must still end at the total exactly once.
        assert.deepEqual(seen.at(-1), [paths.length, paths.length]);
        assert.deepEqual(
            seen.map(([done]) => done).sort((a, b) => a - b),
            [1, 2, 3, 4, 5]
        );
    } finally {
        restore();
    }
});

test('getFiles on an empty list does no work', async () => {
    const restore = stubFetch(async () => {
        throw new Error('fetch should not be called');
    });

    try {
        const result = await getFiles({ owner: 'o', repo: 'r', ref: 'main', paths: [] });
        assert.deepEqual(result.loaded, []);
        assert.deepEqual(result.failed, []);
    } finally {
        restore();
    }
});
