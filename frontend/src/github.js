// GitHub REST client, called straight from the browser.
//
// The token deliberately never leaves this tab: it is not sent to our own server
// and — importantly — never written into the Y.Doc, which is broadcast to every
// room participant and snapshotted to disk.
//
// api.github.com sends `Access-Control-Allow-Origin: *` and exposes the rate-limit
// headers, so no proxy is required.

// buildTree is shared with the room's own file list, so it lives in its own
// module. Re-exported here because callers of this module expect it.
import { buildTree } from './tree.js';

export { buildTree };

const API = 'https://api.github.com';
const API_VERSION = '2022-11-28';

/** Contents API refuses to inline anything larger, and huge files are useless here. */
export const MAX_IMPORT_BYTES = 512 * 1024;

// Importing costs one API call per file against a 60/hour unauthenticated budget,
// so a bulk import is capped rather than allowed to drain it on one repository.
export const MAX_IMPORT_FILES = 25;

// Fetched in parallel, but not so many that we look like an attack.
const IMPORT_CONCURRENCY = 4;

// Directories that would exhaust the file budget without contributing source.
const SKIPPED_DIRECTORIES = new Set([
    'node_modules', 'dist', 'build', 'out', 'vendor', 'coverage',
    '.git', '.next', '.cache', '__pycache__', 'target',
]);

export function isSkippedPath(filePath) {
    return String(filePath).split('/').some((part) => SKIPPED_DIRECTORIES.has(part));
}

export class GitHubError extends Error {
    constructor(message, { status, remaining } = {}) {
        super(message);
        this.name = 'GitHubError';
        this.status = status;
        this.remaining = remaining;
    }
}

/** Turn HTTP status codes into something a user can act on. */
export function describeFailure(status, detail, remaining) {
    switch (status) {
        case 401:
            return 'GitHub rejected the token. It may be expired or mistyped.';
        case 403:
            if (remaining === '0') {
                return 'GitHub rate limit reached (60/hour without a token, 5,000 with one). Add a token or wait.';
            }
            return `Forbidden — the token is probably missing a permission. ${detail}`.trim();
        case 404:
            return 'Not found. Check the owner/repo and branch, and that the token can see this repository.';
        case 409:
            return 'Conflict — this file changed on GitHub since it was loaded. Re-open it before committing.';
        case 422:
            return detail || 'GitHub rejected the request as invalid.';
        default:
            return detail ? `GitHub error ${status}: ${detail}` : `GitHub error ${status}.`;
    }
}

async function request(path, { token, method = 'GET', body } = {}) {
    const headers = {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': API_VERSION,
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body) headers['Content-Type'] = 'application/json';

    const res = await fetch(`${API}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
    });

    const remaining = res.headers.get('x-ratelimit-remaining');

    if (!res.ok) {
        let detail = '';
        try {
            const parsed = await res.json();
            detail = parsed?.message ?? '';
        } catch {
            // A non-JSON error body tells us nothing useful; the status carries the meaning.
        }
        throw new GitHubError(describeFailure(res.status, detail, remaining), {
            status: res.status,
            remaining,
        });
    }

    const data = res.status === 204 ? null : await res.json();
    return { data, remaining };
}

// --- encoding ---------------------------------------------------------------
// btoa/atob work on Latin-1, so passing them a JS string silently mangles every
// multi-byte character. Both directions have to go through TextEncoder/TextDecoder.

export function encodeBase64(text) {
    const bytes = new TextEncoder().encode(text);
    // Chunked because String.fromCharCode(...bytes) blows the call stack on big files.
    const CHUNK = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
}

export function decodeBase64(encoded) {
    const binary = atob(String(encoded).replace(/\s/g, ''));
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    return new TextDecoder().decode(bytes);
}

// --- path helpers -----------------------------------------------------------

/** Accepts `owner/repo`, a full GitHub URL, or a `.git` suffix. */
export function parseRepo(input) {
    const cleaned = String(input ?? '')
        .trim()
        .replace(/^git@github\.com:/, '')
        .replace(/^https?:\/\/(www\.)?github\.com\//, '')
        .replace(/\.git$/, '')
        .replace(/^\/+|\/+$/g, '');

    const match = cleaned.match(/^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/);
    return match ? { owner: match[1], repo: match[2] } : null;
}

// Only extensions the room can actually edit and run — opening a .png would be
// meaningless, and there is no buffer to hold a .md.
const EXTENSION_LANGUAGE = {
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    py: 'python',
    java: 'java',
    cpp: 'cpp', cc: 'cpp', cxx: 'cpp', c: 'cpp', h: 'cpp', hpp: 'cpp',
};

export function languageForPath(path) {
    const dot = String(path ?? '').lastIndexOf('.');
    if (dot === -1) return null;
    return EXTENSION_LANGUAGE[path.slice(dot + 1).toLowerCase()] ?? null;
}

/** Each path segment is encoded separately so slashes survive. */
const encodePath = (path) => String(path).split('/').map(encodeURIComponent).join('/');

// --- API calls --------------------------------------------------------------

export async function getRepo({ owner, repo, token }) {
    const { data, remaining } = await request(`/repos/${owner}/${repo}`, { token });
    return { defaultBranch: data.default_branch, private: data.private, remaining };
}

export async function getTree({ owner, repo, ref, token }) {
    const { data, remaining } = await request(
        `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
        { token }
    );
    return { nodes: buildTree(data.tree), truncated: Boolean(data.truncated), remaining };
}

export async function getFile({ owner, repo, path, ref, token }) {
    const { data, remaining } = await request(
        `/repos/${owner}/${repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`,
        { token }
    );

    // Files above the inline limit come back with no content and encoding "none".
    if (data.encoding !== 'base64' || typeof data.content !== 'string') {
        throw new GitHubError(
            'That file is too large to read through the contents API (1 MB limit).',
            { status: 200 }
        );
    }
    return { text: decodeBase64(data.content), sha: data.sha, remaining };
}

/**
 * Read many files at once. Individual failures are collected rather than thrown,
 * so one unreadable file cannot abandon an otherwise good import.
 */
export async function getFiles({ owner, repo, ref, token, paths, onProgress }) {
    const loaded = [];
    const failed = [];
    let remaining = null;
    let cursor = 0;
    let done = 0;

    const worker = async () => {
        while (cursor < paths.length) {
            const filePath = paths[cursor];
            cursor += 1;

            try {
                const file = await getFile({ owner, repo, path: filePath, ref, token });
                loaded.push({ path: filePath, text: file.text, sha: file.sha });
                if (file.remaining != null) remaining = file.remaining;
            } catch (err) {
                failed.push({ path: filePath, message: err.message });
            }

            done += 1;
            onProgress?.(done, paths.length);
        }
    };

    await Promise.all(
        Array.from({ length: Math.min(IMPORT_CONCURRENCY, paths.length) }, worker)
    );

    // Workers finish out of order; sort so the caller sees a stable list.
    loaded.sort((a, b) => a.path.localeCompare(b.path));
    return { loaded, failed, remaining };
}

export async function putFile({ owner, repo, path, message, text, branch, sha, token }) {
    const { data, remaining } = await request(
        `/repos/${owner}/${repo}/contents/${encodePath(path)}`,
        {
            token,
            method: 'PUT',
            body: {
                message,
                content: encodeBase64(text),
                ...(branch ? { branch } : {}),
                // Omitted when creating a file; required when updating one.
                ...(sha ? { sha } : {}),
            },
        }
    );
    return { sha: data.content?.sha, commitUrl: data.commit?.html_url, remaining };
}

export async function listCommits({ owner, repo, path, ref, token }) {
    const params = new URLSearchParams({ per_page: '15' });
    if (path) params.set('path', path);
    if (ref) params.set('sha', ref);

    const { data, remaining } = await request(
        `/repos/${owner}/${repo}/commits?${params}`,
        { token }
    );
    return {
        commits: data.map((entry) => ({
            sha: entry.sha,
            message: entry.commit.message.split('\n')[0],
            author: entry.commit.author?.name ?? 'unknown',
            date: entry.commit.author?.date ?? null,
            url: entry.html_url,
        })),
        remaining,
    };
}

export async function createBranch({ owner, repo, fromBranch, name, token }) {
    const { data: base } = await request(
        `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(fromBranch)}`,
        { token }
    );
    const { remaining } = await request(`/repos/${owner}/${repo}/git/refs`, {
        token,
        method: 'POST',
        body: { ref: `refs/heads/${name}`, sha: base.object.sha },
    });
    return { remaining };
}

export async function createPullRequest({ owner, repo, title, head, base, body, token }) {
    const { data, remaining } = await request(`/repos/${owner}/${repo}/pulls`, {
        token,
        method: 'POST',
        body: { title, head, base, body },
    });
    return { number: data.number, url: data.html_url, remaining };
}
