// Everything language-specific lives here so it can be unit tested without
// starting the server.

// Wandbox compiler ids for the languages this app can run.
export const WANDBOX_COMPILERS = {
    javascript: { compiler: "nodejs-20.17.0" },
    python: { compiler: "cpython-3.13.8" },
    java: { compiler: "openjdk-jdk-21+35" },
    cpp: { compiler: "gcc-13.2.0", options: "warning,gnu++17" },
};

// Extension -> language. Only what we can actually execute; anything else is
// editable but not runnable.
//
// The browser keeps its own copy of this map in frontend/src/github.js, because
// importing across the frontend/backend boundary would couple the server to the
// Vite tree. Keep the two in step.
const EXTENSION_LANGUAGE = {
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    py: 'python',
    java: 'java',
    cpp: 'cpp', cc: 'cpp', cxx: 'cpp', c: 'cpp', h: 'cpp', hpp: 'cpp',
};

export function languageForPath(path) {
    const name = String(path ?? '');
    const dot = name.lastIndexOf('.');
    if (dot === -1) return null;
    return EXTENSION_LANGUAGE[name.slice(dot + 1).toLowerCase()] ?? null;
}

// The server seeds new rooms. Clients must never insert defaults themselves —
// under CRDT semantics two clients seeding the same fresh room would both
// succeed and the snippet would appear twice.
export const DEFAULT_FILES = {
    'main.js': `console.log("Hello World");`,
    'main.py': `print("Hello World")`,
    'Main.java': `public class Main {\n    public static void main(String[] args) {\n        System.out.println("Hello World");\n    }\n}`,
    'main.cpp': `#include <iostream>\n\nint main() {\n    std::cout << "Hello World" << std::endl;\n    return 0;\n}`,
};

// Rooms created before multi-file keyed their buffers by language name. These are
// the paths those buffers become.
export const LEGACY_LANGUAGE_PATHS = {
    javascript: 'main.js',
    python: 'main.py',
    java: 'Main.java',
    cpp: 'main.cpp',
};

// Wandbox writes every Java submission to prog.java, but javac rejects a public
// class whose name doesn't match its file. Dropping the modifier on top-level
// declarations is valid Java and leaves the user's code semantically unchanged —
// Wandbox locates the main method regardless of the class name.
// Anchored to column 0 so nested members, which are legally public, are untouched.
const PREPARE_SOURCE = {
    java: (code) => code.replace(
        /^public\s+(?=(?:final\s+|abstract\s+|strictfp\s+)*(?:class|interface|enum|record)\b)/gm,
        ''
    ),
};

/** Adapt a room's source to whatever the execution backend expects. */
export function prepareSource(language, code) {
    return PREPARE_SOURCE[language]?.(code) ?? code;
}
