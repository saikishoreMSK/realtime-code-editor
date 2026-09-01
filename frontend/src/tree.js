// Both GitHub and the room's own document describe their contents as a flat list
// of paths. This folds either one into the nested shape the tree renders.

/**
 * @param entries {{ path: string, type: 'tree' | 'blob', size?: number }[]}
 * Folders sort before files, then alphabetically. Folders that were never listed
 * are inferred from the paths of the files inside them.
 */
export function buildTree(entries) {
    const root = { name: '', path: '', type: 'tree', children: [] };
    const dirs = new Map([['', root]]);

    const ensureDir = (dirPath) => {
        const existing = dirs.get(dirPath);
        if (existing) return existing;

        const cut = dirPath.lastIndexOf('/');
        const parent = ensureDir(cut === -1 ? '' : dirPath.slice(0, cut));
        const node = {
            name: dirPath.slice(cut + 1),
            path: dirPath,
            type: 'tree',
            children: [],
        };
        parent.children.push(node);
        dirs.set(dirPath, node);
        return node;
    };

    for (const entry of entries ?? []) {
        if (!entry?.path) continue;

        if (entry.type === 'tree') {
            ensureDir(entry.path);
            continue;
        }
        const cut = entry.path.lastIndexOf('/');
        const parent = ensureDir(cut === -1 ? '' : entry.path.slice(0, cut));
        parent.children.push({
            name: entry.path.slice(cut + 1),
            path: entry.path,
            type: 'blob',
            size: entry.size ?? 0,
        });
    }

    const sortNode = (node) => {
        node.children.sort((a, b) => (
            a.type === b.type
                ? a.name.localeCompare(b.name)
                : a.type === 'tree' ? -1 : 1
        ));
        node.children.forEach((child) => {
            if (child.type === 'tree') sortNode(child);
        });
    };
    sortNode(root);

    return root.children;
}

/** Depth-first list of the file nodes in a tree, in the order they render. */
export function flattenFiles(nodes) {
    const found = [];

    const walk = (list) => {
        for (const node of list) {
            if (node.type === 'tree') walk(node.children);
            else found.push(node);
        }
    };
    walk(nodes ?? []);

    return found;
}
