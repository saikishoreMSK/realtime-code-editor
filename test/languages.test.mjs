// Unit tests for the Java source adaptation, which exists because Wandbox writes
// every submission to prog.java while javac demands a matching filename.
import test from 'node:test';
import assert from 'node:assert/strict';
import { languageForPath, prepareSource } from '../backend/languages.js';

test('drops public from a top-level Java class', () => {
    const out = prepareSource('java', 'public class Main {\n}');
    assert.equal(out, 'class Main {\n}');
});

test('leaves nested public members alone', () => {
    const src = [
        'public class Main {',
        '    public static class Inner { public int x = 7; }',
        '    public static void main(String[] args) {}',
        '}',
    ].join('\n');

    const out = prepareSource('java', src);
    assert.ok(out.startsWith('class Main {'), 'top-level modifier not removed');
    assert.ok(out.includes('public static class Inner'), 'nested class was modified');
    assert.ok(out.includes('public static void main'), 'method modifier was modified');
});

test('handles abstract, final and interface declarations', () => {
    assert.equal(prepareSource('java', 'public abstract class A {}'), 'abstract class A {}');
    assert.equal(prepareSource('java', 'public final class B {}'), 'final class B {}');
    assert.equal(prepareSource('java', 'public interface C {}'), 'interface C {}');
    assert.equal(prepareSource('java', 'public record D(int x) {}'), 'record D(int x) {}');
});

test('does not touch identifiers that merely start with the keyword', () => {
    const src = 'public class Main {\n    int publicClassCount = 1;\n}';
    assert.ok(prepareSource('java', src).includes('int publicClassCount = 1;'));
});

test('other languages pass through untouched', () => {
    const py = 'print("Hello World")';
    assert.equal(prepareSource('python', py), py);
    assert.equal(prepareSource('javascript', 'console.log(1)'), 'console.log(1)');
});

test('maps file extensions to runnable languages', () => {
    assert.equal(languageForPath('main.js'), 'javascript');
    assert.equal(languageForPath('src/app.jsx'), 'javascript');
    assert.equal(languageForPath('main.py'), 'python');
    assert.equal(languageForPath('Main.java'), 'java');
    assert.equal(languageForPath('main.cpp'), 'cpp');
    assert.equal(languageForPath('lib/helper.hpp'), 'cpp');
});

test('extension matching ignores case and rejects unknown types', () => {
    assert.equal(languageForPath('Main.JAVA'), 'java');
    assert.equal(languageForPath('README.md'), null);
    assert.equal(languageForPath('logo.png'), null);
    assert.equal(languageForPath('Makefile'), null, 'a file with no extension is not runnable');
    assert.equal(languageForPath(''), null);
    assert.equal(languageForPath(undefined), null);
});
