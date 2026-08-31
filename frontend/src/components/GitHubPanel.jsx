import React, { useCallback, useEffect, useState } from 'react';
import FileTree from './FileTree';
import {
    MAX_IMPORT_BYTES,
    createBranch,
    createPullRequest,
    getFile,
    getRepo,
    getTree,
    languageForPath,
    listCommits,
    parseRepo,
    putFile,
} from '../github';

// sessionStorage, not localStorage: the token should not outlive the tab.
const TOKEN_KEY = 'rce.github.token';

const slugify = (value) => String(value).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();

const GitHubPanel = ({ onOpenFile, getCode, disabled }) => {
    const [token, setToken] = useState('');
    const [repoInput, setRepoInput] = useState('');
    const [target, setTarget] = useState(null);
    const [branch, setBranch] = useState('');
    const [nodes, setNodes] = useState([]);
    const [truncated, setTruncated] = useState(false);

    const [activePath, setActivePath] = useState('');
    const [activeSha, setActiveSha] = useState('');

    const [commitPath, setCommitPath] = useState('');
    const [commitMessage, setCommitMessage] = useState('');
    const [prTitle, setPrTitle] = useState('');

    const [commits, setCommits] = useState([]);
    const [busy, setBusy] = useState('');
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [remaining, setRemaining] = useState(null);
    const [expanded, setExpanded] = useState(false);

    useEffect(() => {
        const stored = sessionStorage.getItem(TOKEN_KEY);
        if (stored) setToken(stored);
    }, []);

    const rememberToken = (value) => {
        setToken(value);
        if (value) sessionStorage.setItem(TOKEN_KEY, value);
        else sessionStorage.removeItem(TOKEN_KEY);
    };

    // Every action shares the same busy/error/rate-limit bookkeeping.
    const run = useCallback(async (label, action) => {
        setBusy(label);
        setError('');
        setNotice('');
        try {
            const result = await action();
            if (result?.remaining != null) setRemaining(result.remaining);
            return result;
        } catch (err) {
            setError(err.message || String(err));
            return null;
        } finally {
            setBusy('');
        }
    }, []);

    const loadRepo = () => run('Loading repository', async () => {
        const parsed = parseRepo(repoInput);
        if (!parsed) throw new Error('Enter a repository as owner/repo or a GitHub URL.');

        const info = await getRepo({ ...parsed, token });
        const ref = branch || info.defaultBranch;
        const tree = await getTree({ ...parsed, ref, token });

        setTarget(parsed);
        setBranch(ref);
        setNodes(tree.nodes);
        setTruncated(tree.truncated);
        setCommits([]);
        setNotice(`Loaded ${parsed.owner}/${parsed.repo} @ ${ref}`);
        return tree;
    });

    const openFile = (node) => run(`Opening ${node.name}`, async () => {
        // Opening writes into the shared document, so it has to wait for the room's
        // initial sync — otherwise the write lands nowhere.
        if (disabled) throw new Error('Waiting for the room to sync — try again in a moment.');
        if (node.size > MAX_IMPORT_BYTES) {
            throw new Error(`${node.name} is too large to open here.`);
        }
        const file = await getFile({ ...target, path: node.path, ref: branch, token });

        setActivePath(node.path);
        setActiveSha(file.sha);
        setCommitPath(node.path);
        setCommitMessage(`Update ${node.name}`);
        setPrTitle(`Update ${node.name}`);
        onOpenFile({
            path: node.path,
            text: file.text,
            language: languageForPath(node.path),
        });
        setNotice(`Opened ${node.path} — visible to everyone in the room`);
        return file;
    });

    const commit = () => run('Committing', async () => {
        if (!token) throw new Error('A token with Contents: read and write is required to commit.');
        if (!commitPath) throw new Error('Enter the file path to commit to.');
        if (!commitMessage.trim()) throw new Error('Enter a commit message.');

        const result = await putFile({
            ...target,
            path: commitPath,
            message: commitMessage,
            text: getCode(),
            branch,
            // Updating requires the blob's sha; creating a new path must omit it.
            sha: commitPath === activePath ? activeSha : undefined,
            token,
        });

        // Keep the sha current so a second commit in a row doesn't 409.
        if (commitPath === activePath && result.sha) setActiveSha(result.sha);
        setNotice(`Committed to ${branch}`);
        return result;
    });

    const openPullRequest = () => run('Opening pull request', async () => {
        if (!token) throw new Error('A token with Pull requests: write is required.');
        if (!commitPath) throw new Error('Enter the file path to commit to.');

        const head = `rce/${slugify(commitPath)}-${Date.now().toString(36)}`;
        await createBranch({ ...target, fromBranch: branch, name: head, token });

        await putFile({
            ...target,
            path: commitPath,
            message: commitMessage || `Update ${commitPath}`,
            text: getCode(),
            branch: head,
            sha: commitPath === activePath ? activeSha : undefined,
            token,
        });

        const pr = await createPullRequest({
            ...target,
            title: prTitle || `Update ${commitPath}`,
            head,
            base: branch,
            body: 'Opened from the collaborative editor.',
            token,
        });

        setNotice(`Opened PR #${pr.number}`);
        window.open(pr.url, '_blank', 'noopener');
        return pr;
    });

    const loadHistory = () => run('Loading history', async () => {
        const result = await listCommits({ ...target, path: activePath, ref: branch, token });
        setCommits(result.commits);
        return result;
    });

    const openHistoricVersion = (sha) => run('Loading version', async () => {
        const file = await getFile({ ...target, path: activePath, ref: sha, token });
        onOpenFile({
            path: activePath,
            text: file.text,
            language: languageForPath(activePath),
        });
        // The blob sha belongs to that old commit, so committing on top of it would
        // conflict; clear it and let the next commit be treated as a fresh write.
        setActiveSha('');
        setNotice(`Loaded ${activePath} at ${sha.slice(0, 7)}`);
        return file;
    });

    return (
        <div className='gh-panel'>
            <button
                type='button'
                className='gh-toggle'
                onClick={() => setExpanded((open) => !open)}
            >
                {expanded ? '▾' : '▸'} GitHub
            </button>

            {expanded && (
                <div className='gh-body'>
                    <input
                        type='password'
                        placeholder='Personal access token (optional)'
                        value={token}
                        onChange={(e) => rememberToken(e.target.value)}
                        autoComplete='off'
                    />
                    <p className='gh-hint'>
                        Stays in this tab only — never sent to this app&apos;s server or shared
                        with the room. Public repositories can be browsed without one.
                    </p>

                    <input
                        type='text'
                        placeholder='owner/repo'
                        value={repoInput}
                        onChange={(e) => setRepoInput(e.target.value)}
                    />
                    <input
                        type='text'
                        placeholder='branch (default branch if blank)'
                        value={branch}
                        onChange={(e) => setBranch(e.target.value)}
                    />
                    <button type='button' onClick={loadRepo} disabled={!!busy || disabled}>
                        Load repository
                    </button>

                    {busy && <p className='gh-busy'>{busy}…</p>}
                    {error && <p className='gh-error'>{error}</p>}
                    {notice && <p className='gh-notice'>{notice}</p>}
                    {remaining != null && (
                        <p className='gh-hint'>API calls left this hour: {remaining}</p>
                    )}
                    {truncated && (
                        <p className='gh-hint'>
                            Repository is large — GitHub truncated the file list.
                        </p>
                    )}

                    {nodes.length > 0 && (
                        <FileTree
                            nodes={nodes}
                            onOpen={openFile}
                            canOpen={(node) => !!languageForPath(node.path)
                                && node.size <= MAX_IMPORT_BYTES}
                            activePath={activePath}
                        />
                    )}

                    {target && (
                        <div className='gh-actions'>
                            <input
                                type='text'
                                placeholder='path to commit to'
                                value={commitPath}
                                onChange={(e) => setCommitPath(e.target.value)}
                            />
                            <input
                                type='text'
                                placeholder='commit message'
                                value={commitMessage}
                                onChange={(e) => setCommitMessage(e.target.value)}
                            />
                            <button type='button' onClick={commit} disabled={!!busy}>
                                Commit to {branch}
                            </button>

                            <input
                                type='text'
                                placeholder='pull request title'
                                value={prTitle}
                                onChange={(e) => setPrTitle(e.target.value)}
                            />
                            <button type='button' onClick={openPullRequest} disabled={!!busy}>
                                Open pull request
                            </button>

                            {activePath && (
                                <button type='button' onClick={loadHistory} disabled={!!busy}>
                                    History of {activePath.split('/').pop()}
                                </button>
                            )}
                        </div>
                    )}

                    {commits.length > 0 && (
                        <ul className='gh-commits'>
                            {commits.map((entry) => (
                                <li key={entry.sha}>
                                    <button
                                        type='button'
                                        onClick={() => openHistoricVersion(entry.sha)}
                                        disabled={!!busy}
                                        title={`Load this version — ${entry.author}`}
                                    >
                                        <code>{entry.sha.slice(0, 7)}</code> {entry.message}
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            )}
        </div>
    );
};

export default GitHubPanel;
