import React, { useState } from 'react';
import FileTree from './FileTree';
import { languageForPath } from '../github';

// The room's own files. Operations mutate the CRDT through the callbacks, which
// throw a readable Error on invalid input rather than failing silently — this
// component is the one place that renders the reason.

const PROMPTS = {
    file: { title: 'New file', placeholder: 'src/helper.js', action: 'Create file' },
    folder: { title: 'New folder', placeholder: 'src/utils', action: 'Create folder' },
    rename: { title: 'Rename to', placeholder: 'new/path.js', action: 'Rename' },
};

const FilesPanel = ({
    nodes,
    activePath,
    viewers,
    fileCount,
    onSelect,
    onCreateFile,
    onCreateFolder,
    onRename,
    onDelete,
    onRemoveFolder,
    disabled,
}) => {
    const [prompt, setPrompt] = useState(null);
    const [draft, setDraft] = useState('');
    const [error, setError] = useState('');

    const canDelete = fileCount > 1 && !!activePath;

    const open = (kind) => {
        setPrompt(kind);
        setError('');
        // Renaming starts from the current path, so a small edit stays a small edit.
        setDraft(kind === 'rename' ? activePath : '');
    };

    const close = () => {
        setPrompt(null);
        setDraft('');
        setError('');
    };

    const attempt = (fn) => {
        try {
            fn();
            close();
        } catch (err) {
            setError(err.message || String(err));
        }
    };

    const submit = (event) => {
        event.preventDefault();
        if (prompt === 'file') attempt(() => onCreateFile(draft));
        else if (prompt === 'folder') attempt(() => onCreateFolder(draft));
        else if (prompt === 'rename') attempt(() => onRename(activePath, draft));
    };

    return (
        <div className='files-panel'>
            <h3 className='sidebar-title'>Files</h3>

            <FileTree
                nodes={nodes}
                onOpen={(node) => onSelect(node.path)}
                // Every file in the room is editable; only running one needs a runtime.
                canOpen={() => true}
                activePath={activePath}
                badges={viewers}
                onRemoveFolder={onRemoveFolder}
            />

            <div className='files-actions'>
                <button type='button' onClick={() => open('file')} disabled={disabled}>
                    + File
                </button>
                <button type='button' onClick={() => open('folder')} disabled={disabled}>
                    + Folder
                </button>
                <button
                    type='button'
                    onClick={() => open('rename')}
                    disabled={disabled || !activePath}
                >
                    Rename
                </button>
                <button
                    type='button'
                    className='files-delete'
                    onClick={() => open('delete')}
                    disabled={disabled || !canDelete}
                    title={
                        fileCount <= 1
                            ? 'A room keeps at least one file'
                            : `Delete ${activePath}`
                    }
                >
                    Delete
                </button>
            </div>

            {activePath && !languageForPath(activePath) && (
                <p className='files-hint'>
                    {activePath.split('/').pop()} is editable, but there is no runtime
                    for this file type.
                </p>
            )}

            {prompt === 'delete' ? (
                <div className='files-prompt'>
                    <p className='files-confirm'>
                        Delete <strong>{activePath}</strong> for everyone in the room?
                    </p>
                    <div className='files-prompt-buttons'>
                        <button
                            type='button'
                            className='files-delete'
                            onClick={() => attempt(() => onDelete(activePath))}
                        >
                            Delete
                        </button>
                        <button type='button' onClick={close}>Cancel</button>
                    </div>
                </div>
            ) : prompt && (
                <form className='files-prompt' onSubmit={submit}>
                    <label>
                        {PROMPTS[prompt].title}
                        <input
                            type='text'
                            autoFocus
                            value={draft}
                            placeholder={PROMPTS[prompt].placeholder}
                            onChange={(e) => setDraft(e.target.value)}
                        />
                    </label>
                    <div className='files-prompt-buttons'>
                        <button type='submit'>{PROMPTS[prompt].action}</button>
                        <button type='button' onClick={close}>Cancel</button>
                    </div>
                    {prompt !== 'rename' && (
                        <p className='files-hint'>
                            Folders come from the path: <code>src/a.js</code> creates{' '}
                            <code>src/</code> as well.
                        </p>
                    )}
                </form>
            )}

            {error && <p className='files-error'>{error}</p>}
        </div>
    );
};

export default FilesPanel;
