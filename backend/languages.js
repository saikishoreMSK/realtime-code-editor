// Everything language-specific lives here so it can be unit tested without
// starting the server.

// Wandbox compiler ids for the languages exposed in the frontend selector.
export const WANDBOX_COMPILERS = {
    javascript: { compiler: "nodejs-20.17.0" },
    python: { compiler: "cpython-3.13.8" },
    java: { compiler: "openjdk-jdk-21+35" },
    cpp: { compiler: "gcc-13.2.0", options: "warning,gnu++17" },
};

// The server seeds new rooms. Clients must never insert defaults themselves —
// under CRDT semantics two clients seeding the same fresh room would both
// succeed and the snippet would appear twice.
export const DEFAULT_SNIPPETS = {
    javascript: `console.log("Hello World");`,
    python: `print("Hello World")`,
    java: `public class Main {\n    public static void main(String[] args) {\n        System.out.println("Hello World");\n    }\n}`,
    cpp: `#include <iostream>\n\nint main() {\n    std::cout << "Hello World" << std::endl;\n    return 0;\n}`,
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
