import React, { useState } from 'react';

// Collapsible file tree, shared by the GitHub browser and the room's own files.
// It knows nothing about either source — it renders nodes and reports clicks.

const formatSize = (bytes) => (
    bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}M`
        : bytes >= 1024 ? `${Math.round(bytes / 1024)}K`
            : `${bytes}B`
);

const Viewers = ({ people }) => {
    if (!people?.length) return null;
    return (
        <span className='tree-viewers'>
            {people.map(({ name, color }) => (
                <span
                    key={name}
                    className='tree-viewer'
                    style={{ backgroundColor: color }}
                    title={`${name} is in this file`}
                />
            ))}
        </span>
    );
};

const TreeNode = ({ node, depth, onOpen, canOpen, activePath, badges, onRemoveFolder }) => {
    // Top-level folders start open; anything deeper stays collapsed so a large
    // repository doesn't render as a wall of text.
    const [expanded, setExpanded] = useState(depth === 0);
    const indent = { paddingLeft: `${depth * 12 + 4}px` };

    if (node.type === 'tree') {
        // Only a folder with nothing in it can be removed; deleting one that still
        // holds files would be a destructive action hidden behind a small glyph.
        const removable = onRemoveFolder && node.children.length === 0;

        return (
            <li className='tree-node'>
                <div className='tree-dir-row'>
                    <button
                        type='button'
                        className='tree-dir'
                        style={indent}
                        onClick={() => setExpanded((open) => !open)}
                    >
                        <span className='tree-caret'>{expanded ? '▾' : '▸'}</span>
                        {node.name}
                    </button>
                    {removable && (
                        <button
                            type='button'
                            className='tree-remove'
                            title={`Remove empty folder ${node.path}`}
                            aria-label={`Remove empty folder ${node.path}`}
                            onClick={() => onRemoveFolder(node.path)}
                        >
                            ✕
                        </button>
                    )}
                </div>
                {expanded && (
                    <ul className='tree-list'>
                        {node.children.map((child) => (
                            <TreeNode
                                key={child.path}
                                node={child}
                                depth={depth + 1}
                                onOpen={onOpen}
                                canOpen={canOpen}
                                activePath={activePath}
                                badges={badges}
                                onRemoveFolder={onRemoveFolder}
                            />
                        ))}
                    </ul>
                )}
            </li>
        );
    }

    const openable = canOpen(node);
    const classes = [
        'tree-file',
        openable ? '' : 'tree-file-disabled',
        node.path === activePath ? 'tree-file-active' : '',
    ].filter(Boolean).join(' ');

    return (
        <li className='tree-node'>
            <button
                type='button'
                className={classes}
                style={indent}
                disabled={!openable}
                // Unsupported files stay visible but explain themselves rather than
                // disappearing, so the tree still reflects the real contents.
                title={openable ? node.path : `${node.path} — not editable here`}
                onClick={() => onOpen(node)}
            >
                {node.name}
                <Viewers people={badges?.[node.path]} />
                {node.size ? <span className='tree-size'>{formatSize(node.size)}</span> : null}
            </button>
        </li>
    );
};

const FileTree = ({
    nodes,
    onOpen,
    canOpen = () => true,
    activePath = null,
    badges = null,
    onRemoveFolder = null,
}) => {
    if (!nodes?.length) return null;

    return (
        <ul className='tree-list tree-root'>
            {nodes.map((node) => (
                <TreeNode
                    key={node.path}
                    node={node}
                    depth={0}
                    onOpen={onOpen}
                    canOpen={canOpen}
                    activePath={activePath}
                    badges={badges}
                    onRemoveFolder={onRemoveFolder}
                />
            ))}
        </ul>
    );
};

export default FileTree;
