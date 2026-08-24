// @ts-check

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
    enumMapsRelativePath,
    findUnexpectedTypeScriptPatchPaths,
    hasPassingGoTestEvent,
    prepareTypeScriptBaselinePatch,
    renderTypeScriptPatchDiff,
    renderTypeScriptPatchSummary,
    typescriptLibSourceDirectory,
} from "../lib/typescript-upstream.mjs";
import {
    cleanupTempDirectories,
    createTempDirectory,
} from "./helpers.mjs";

/** @type {string[]} */
const tempDirectories = [];

test.afterEach(() => {
    cleanupTempDirectories(tempDirectories);
});

test("prepareTypeScriptBaselinePatch patches the unified TypeScript tree once", () => {
    const tempDirectory = createTempDirectory(tempDirectories);
    const typescriptDir = createFakeTypeScriptTree(tempDirectory);
    const generatedLibPath = path.join(tempDirectory, "generated", "baseline.d.ts");
    const fixturesRoot = createFixtureTree(tempDirectory);

    fs.mkdirSync(path.dirname(generatedLibPath), { recursive: true });
    fs.writeFileSync(generatedLibPath, "// generated baseline\n");

    const first = prepareTypeScriptBaselinePatch({
        repoRoot: tempDirectory,
        typescriptDir,
        generatedLibPath,
        fixturesRoot,
    });

    const libSourcePath = path.join(typescriptDir, typescriptLibSourceDirectory, "baseline.d.ts");
    const libsJsonPath = path.join(typescriptDir, typescriptLibSourceDirectory, "libs.json");
    const enumMapsPath = path.join(typescriptDir, enumMapsRelativePath);
    const testCasePath = path.join(typescriptDir, "tsc", "testdata", "tests", "cases", "compiler", "libBaseline.ts");
    const baselinePath = path.join(typescriptDir, "tsc", "testdata", "baselines", "reference", "compiler", "libBaseline.errors.txt");

    assert.equal(fs.readFileSync(libSourcePath, "utf8"), "// generated baseline\n");
    assert.equal([...fs.readFileSync(libsJsonPath, "utf8").matchAll(/"baseline"/g)].length, 1);
    assert.equal([...fs.readFileSync(enumMapsPath, "utf8").matchAll(/Value: "lib\.baseline\.d\.ts"/g)].length, 1);
    assert.ok(fs.existsSync(testCasePath));
    assert.ok(fs.existsSync(baselinePath));
    assert.equal(first.copiedGeneratedLib.changed, true);
    assert.equal(first.patchedLibsJson.changed, true);
    assert.equal(first.patchedEnumMaps.changed, true);
    assert.equal(first.fixtureFiles.length, 2);
    assert.equal(first.changedFixtureFiles.length, 2);
    assert.match(renderTypeScriptPatchSummary(first), /npm ci && npm run generate/u);

    const second = prepareTypeScriptBaselinePatch({
        repoRoot: tempDirectory,
        typescriptDir,
        generatedLibPath,
        fixturesRoot,
    });
    assert.equal(second.copiedGeneratedLib.changed, false);
    assert.equal(second.patchedLibsJson.changed, false);
    assert.equal(second.patchedEnumMaps.changed, false);
    assert.equal(second.fixtureFiles.length, 2);
    assert.equal(second.changedFixtureFiles.length, 0);
});

test("prepareTypeScriptBaselinePatch uses the checkout command's default directory", () => {
    const tempDirectory = createTempDirectory(tempDirectories);
    const sourceDirectory = createFakeTypeScriptTree(tempDirectory);
    const typescriptDir = path.join(tempDirectory, ".tmp", "TypeScript");
    const generatedLibPath = path.join(tempDirectory, "generated", "baseline.d.ts");
    const fixturesRoot = createFixtureTree(tempDirectory);

    fs.mkdirSync(path.dirname(typescriptDir), { recursive: true });
    fs.renameSync(sourceDirectory, typescriptDir);
    fs.mkdirSync(path.dirname(generatedLibPath), { recursive: true });
    fs.writeFileSync(generatedLibPath, "// generated baseline\n");

    const summary = prepareTypeScriptBaselinePatch({
        repoRoot: tempDirectory,
        generatedLibPath,
        fixturesRoot,
    });
    assert.equal(summary.typescriptDir, typescriptDir);
});

test("prepareTypeScriptBaselinePatch fails closed when the LibMap anchor drifts", () => {
    const tempDirectory = createTempDirectory(tempDirectories);
    const typescriptDir = createFakeTypeScriptTree(tempDirectory);
    const generatedLibPath = path.join(tempDirectory, "generated", "baseline.d.ts");
    const fixturesRoot = createFixtureTree(tempDirectory);
    const enumMapsPath = path.join(typescriptDir, enumMapsRelativePath);

    fs.mkdirSync(path.dirname(generatedLibPath), { recursive: true });
    fs.writeFileSync(generatedLibPath, "// generated baseline\n");
    fs.writeFileSync(enumMapsPath, "var LibMap = ...\n\t{Key: \"es2025\", Value: \"lib.es2025.d.ts\"},\n");

    assert.throws(
        () => prepareTypeScriptBaselinePatch({ repoRoot: tempDirectory, typescriptDir, generatedLibPath, fixturesRoot }),
        /enummaps\.go LibMap entry anchor/u,
    );
});

test("prepareTypeScriptBaselinePatch preserves upstream line endings", () => {
    const tempDirectory = createTempDirectory(tempDirectories);
    const typescriptDir = createFakeTypeScriptTree(tempDirectory);
    const generatedLibPath = path.join(tempDirectory, "generated", "baseline.d.ts");
    const fixturesRoot = createFixtureTree(tempDirectory);
    const libsJsonPath = path.join(typescriptDir, typescriptLibSourceDirectory, "libs.json");

    fs.mkdirSync(path.dirname(generatedLibPath), { recursive: true });
    fs.writeFileSync(generatedLibPath, "// generated baseline\n");
    fs.writeFileSync(libsJsonPath, fs.readFileSync(libsJsonPath, "utf8").replace(/\n/gu, "\r\n"));

    prepareTypeScriptBaselinePatch({ repoRoot: tempDirectory, typescriptDir, generatedLibPath, fixturesRoot });
    assert.doesNotMatch(fs.readFileSync(libsJsonPath, "utf8"), /(?<!\r)\n/u);
});

test("prepareTypeScriptBaselinePatch refuses a clone that drifted from the pin", () => {
    const tempDirectory = createTempDirectory(tempDirectories);
    const typescriptDir = createFakeTypeScriptTree(tempDirectory);
    const generatedLibPath = path.join(tempDirectory, "generated", "baseline.d.ts");
    const fixturesRoot = createFixtureTree(tempDirectory);

    fs.mkdirSync(path.dirname(generatedLibPath), { recursive: true });
    fs.writeFileSync(generatedLibPath, "// generated baseline\n");
    execFileSync("git", ["init", "--quiet"], { cwd: typescriptDir });
    execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "add", "."], { cwd: typescriptDir });
    execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "--quiet", "-m", "fixture"], { cwd: typescriptDir });

    assert.throws(
        () => prepareTypeScriptBaselinePatch({
            repoRoot: tempDirectory,
            typescriptDir,
            generatedLibPath,
            fixturesRoot,
            expectedCommit: "0000000000000000000000000000000000000000",
        }),
        /Refusing to patch an unpinned clone/u,
    );
    assert.ok(!fs.existsSync(path.join(typescriptDir, typescriptLibSourceDirectory, "baseline.d.ts")));
});

test("TypeScript patch auditing rejects changes outside the proposal surface", () => {
    const tempDirectory = createTempDirectory(tempDirectories);
    initializeGitFixture(tempDirectory, { "allowed.txt": "before\n" });

    fs.writeFileSync(path.join(tempDirectory, "allowed.txt"), "after\n");
    fs.writeFileSync(path.join(tempDirectory, "unexpected.txt"), "unexpected\n");
    assert.deepEqual(findUnexpectedTypeScriptPatchPaths(tempDirectory, ["allowed.txt"]), ["unexpected.txt"]);
});

test("TypeScript patch diff includes tracked and untracked proposal files without staging them", () => {
    const tempDirectory = createTempDirectory(tempDirectories);
    initializeGitFixture(tempDirectory, { "tracked.txt": "before\n" });

    fs.writeFileSync(path.join(tempDirectory, "tracked.txt"), "after\n");
    fs.writeFileSync(path.join(tempDirectory, "new.txt"), "new\n");
    const diff = renderTypeScriptPatchDiff(tempDirectory);

    assert.match(diff, /-before/u);
    assert.match(diff, /\+after/u);
    assert.match(diff, /diff --git .*new\.txt/u);
    assert.match(diff, /\+new/u);
    assert.equal(execFileSync("git", ["diff", "--cached", "--name-only"], {
        cwd: tempDirectory,
        encoding: "utf8",
    }), "");
});

test("Go harness output must contain the exact passing subtest", () => {
    const packagePass = '{"Action":"pass","Package":"example.test/internal/testrunner"}';
    const targetPass = '{"Action":"pass","Test":"TestLocal/libBaseline.ts"}';
    const otherPass = '{"Action":"pass","Test":"TestLocal/other.ts"}';

    assert.equal(hasPassingGoTestEvent(`${packagePass}\n${targetPass}\n`, "TestLocal/libBaseline.ts"), true);
    assert.equal(hasPassingGoTestEvent(`${packagePass}\n${otherPass}\n`, "TestLocal/libBaseline.ts"), false);
});

test("TypeScript patch auditing accepts only mechanical lib-list baseline updates", () => {
    const tempDirectory = createTempDirectory(tempDirectories);
    const baselinePath = "tsc/testdata/baselines/reference/tsoptions/lib-list.js";
    const wrappedHelpPath = "tsc/testdata/baselines/reference/tsc/commandLine/help.js";
    const diffHelpPath = "tsc/testdata/baselines/reference/tscWatch/commandLineWatch/help-diff.js";
    const mixedContentPath = "tsc/testdata/baselines/reference/tsc/commandLine/mixed.js";
    const semanticPath = "tsc/testdata/baselines/reference/compiler/semantic.js";
    initializeGitFixture(tempDirectory, {
        [baselinePath]: "Argument for '--lib' option must be: 'es5', 'esnext', 'dom'.\n",
        [wrappedHelpPath]: "header\none or more: es5, esnext, do\n  m, webworker\n\nfooter\n",
        [diffHelpPath]: "Diff::\n-one or more: es5, esnext, dom\n-default: undefined\n",
        [mixedContentPath]: "one or more: es5, esnext, dom\n\nresult: alpha, omega\n",
        [semanticPath]: "semantic result: alpha, omega\n",
    });

    fs.writeFileSync(
        path.join(tempDirectory, baselinePath),
        "Argument for '--lib' option must be: 'es5', 'esnext', 'baseline', 'dom'.\n",
    );
    fs.writeFileSync(
        path.join(tempDirectory, wrappedHelpPath),
        "header\none or more: es5, esnext, baseline, dom,\n  webworker\n\nfooter\n",
    );
    fs.writeFileSync(
        path.join(tempDirectory, diffHelpPath),
        "Diff::\n-one or more: es5, esnext, baseline, dom\n-default: undefined\n",
    );
    assert.deepEqual(findUnexpectedTypeScriptPatchPaths(tempDirectory, []), []);

    fs.writeFileSync(
        path.join(tempDirectory, mixedContentPath),
        "one or more: es5, esnext, baseline, dom\n\nresult: alpha, baseline, omega\n",
    );
    assert.deepEqual(findUnexpectedTypeScriptPatchPaths(tempDirectory, []), [mixedContentPath]);

    fs.writeFileSync(path.join(tempDirectory, semanticPath), "semantic result: alpha, baseline, omega\n");
    assert.deepEqual(findUnexpectedTypeScriptPatchPaths(tempDirectory, []), [semanticPath, mixedContentPath]);
});

/**
 * @param {string} tempDirectory
 */
function createFakeTypeScriptTree(tempDirectory) {
    const typescriptDir = path.join(tempDirectory, "TypeScript");
    const libSourceDirectory = path.join(typescriptDir, typescriptLibSourceDirectory);
    const enumMapsPath = path.join(typescriptDir, enumMapsRelativePath);

    fs.mkdirSync(libSourceDirectory, { recursive: true });
    fs.mkdirSync(path.dirname(enumMapsPath), { recursive: true });
    fs.writeFileSync(
        path.join(libSourceDirectory, "libs.json"),
        "{\n    \"libs\": [\n        \"es2025\",\n        \"esnext\",\n        \"dom.generated\"\n    ]\n}\n",
    );
    fs.writeFileSync(
        enumMapsPath,
        "var LibMap = collections.NewOrderedMapFromList([]collections.MapEntry[string, any]{\n\t{Key: \"es2025\", Value: \"lib.es2025.d.ts\"},\n\t{Key: \"esnext\", Value: \"lib.esnext.d.ts\"},\n\t{Key: \"dom\", Value: \"lib.dom.d.ts\"},\n})\n",
    );

    return typescriptDir;
}

/**
 * @param {string} tempDirectory
 */
function createFixtureTree(tempDirectory) {
    const fixturesRoot = path.join(tempDirectory, "fixtures");
    const testCasePath = path.join(fixturesRoot, "tests", "cases", "compiler", "libBaseline.ts");
    const baselinePath = path.join(fixturesRoot, "tests", "baselines", "reference", "libBaseline.errors.txt");

    fs.mkdirSync(path.dirname(testCasePath), { recursive: true });
    fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
    fs.writeFileSync(testCasePath, "// @lib: baseline\nObject.hasOwn({}, 'x');\n");
    fs.writeFileSync(baselinePath, "fixture baseline\n");
    return fixturesRoot;
}

/**
 * @param {string} directory
 * @param {Record<string, string>} files
 */
function initializeGitFixture(directory, files) {
    execFileSync("git", ["init", "--quiet"], { cwd: directory });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: directory });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: directory });
    for (const [relativePath, text] of Object.entries(files)) {
        const filePath = path.join(directory, relativePath);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, text);
    }
    execFileSync("git", ["add", "."], { cwd: directory });
    execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: directory });
}
