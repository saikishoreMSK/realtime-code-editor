import React, { useState } from 'react';

// Collapsible file tree. Kept independent of GitHub so the same component can be
// pointed at the room's own documents once those are keyed by path.

const formatSize = (bytes) => (
    bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}M`
        : bytes >= 1024 ? `${Math.round(bytes / 1024)}K`
            : `${bytes}B`
);

const TreeNode = ({ node, depth, onOpen, canOpen, activePath }) => {
    // Top-level folders start open; anything deeper stays collapsed so a large
    // repository doesn't render as a wall of text.
    const [expanded, setExpanded] = useState(depth === 0);
    const indent = { paddingLeft: `${depth * 12 + 4}px` };

    if (node.type === 'tree') {
        return (
            <li className='tree-node'>
                <button
                    type='button'
                    className='tree-dir'
                    style={indent}
                    onClick={() => setExpanded((open) => !open)}
                >
                    <span className='tree-caret'>{expanded ? '▾' : '▸'}</span>
                    {node.name}
                </button>
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
                // disappearing, so the tree still reflects the real repository.
                title={openable ? node.path : `${node.path} — not editable here`}
                onClick={() => onOpen(node)}
            >
                {node.name}
                {node.size ? <span className='tree-size'>{formatSize(node.size)}</span> : null}
            </button>
        </li>
    );
};

const FileTree = ({ nodes, onOpen, canOpen = () => true, activePath = null }) => {
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
                />
            ))}
        </ul>
    );
};

export default FileTree;
