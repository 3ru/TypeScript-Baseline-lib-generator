// @ts-check

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
    cleanupTempDirectories,
    createTempDirectory,
} from "./helpers.mjs";
import {
    enumMapsRelativePath,
    prepareTypeScriptGoBaselinePatch,
    typescriptGoSubmoduleLibDir,
} from "../lib/typescript-go-upstream.mjs";

/** @type {string[]} */
const tempDirectories = [];

test.afterEach(() => {
    cleanupTempDirectories(tempDirectories);
});

// generate.go regenerates lib from two inputs: the submodule's src/lib/libs.json and
// the LibMap in enummaps.go. The patcher deterministically touches only those two inputs
// plus the baseline.d.ts install (never the generated files). Pin at the text level without a Go build.

test("prepareTypeScriptGoBaselinePatch installs baseline source and patches libs.json + enummaps once", () => {
    const tempDirectory = createTempDirectory(tempDirectories);
    const typescriptGoDir = createFakeTypeScriptGoTree(tempDirectory);
    const generatedLibPath = path.join(tempDirectory, "generated", "baseline.d.ts");
    fs.mkdirSync(path.dirname(generatedLibPath), { recursive: true });
    fs.writeFileSync(generatedLibPath, "// generated baseline\n");

    const first = prepareTypeScriptGoBaselinePatch({
        repoRoot: tempDirectory,
        typescriptGoDir,
        generatedLibPath,
    });

    const libSourcePath = path.join(typescriptGoDir, typescriptGoSubmoduleLibDir, "baseline.d.ts");
    const libsJsonPath = path.join(typescriptGoDir, typescriptGoSubmoduleLibDir, "libs.json");
    const enumMapsPath = path.join(typescriptGoDir, enumMapsRelativePath);

    assert.equal(fs.readFileSync(libSourcePath, "utf8"), "// generated baseline\n");

    const libsJson = fs.readFileSync(libsJsonPath, "utf8");
    assert.match(libsJson, /"baseline"/);
    assert.equal([...libsJson.matchAll(/"baseline"/g)].length, 1);
    // baseline lands right after esnext (order is pinned too).
    assert.ok(libsJson.indexOf('"esnext"') < libsJson.indexOf('"baseline"'));

    const enumMaps = fs.readFileSync(enumMapsPath, "utf8");
    assert.match(enumMaps, /\{Key: "baseline", Value: "lib\.baseline\.d\.ts"\},/);
    assert.equal([...enumMaps.matchAll(/Value: "lib\.baseline\.d\.ts"/g)].length, 1);

    assert.equal(first.copiedGeneratedLib.changed, true);
    assert.equal(first.patchedLibsJson.changed, true);
    assert.equal(first.patchedEnumMaps.changed, true);

    // Idempotent: the second run has zero diff.
    const second = prepareTypeScriptGoBaselinePatch({
        repoRoot: tempDirectory,
        typescriptGoDir,
        generatedLibPath,
    });
    assert.equal(second.copiedGeneratedLib.changed, false);
    assert.equal(second.patchedLibsJson.changed, false);
    assert.equal(second.patchedEnumMaps.changed, false);
    assert.equal([...fs.readFileSync(enumMapsPath, "utf8").matchAll(/Value: "lib\.baseline\.d\.ts"/g)].length, 1);
});

test("prepareTypeScriptGoBaselinePatch fails closed when the LibMap anchor is missing", () => {
    const tempDirectory = createTempDirectory(tempDirectories);
    const typescriptGoDir = createFakeTypeScriptGoTree(tempDirectory);
    const generatedLibPath = path.join(tempDirectory, "generated", "baseline.d.ts");
    fs.mkdirSync(path.dirname(generatedLibPath), { recursive: true });
    fs.writeFileSync(generatedLibPath, "// generated baseline\n");

    // Reproduce upstream reformatting the esnext line.
    const enumMapsPath = path.join(typescriptGoDir, enumMapsRelativePath);
    fs.writeFileSync(enumMapsPath, "var LibMap = ...\n\t{Key: \"es2025\", Value: \"lib.es2025.d.ts\"},\n");

    assert.throws(
        () => prepareTypeScriptGoBaselinePatch({ repoRoot: tempDirectory, typescriptGoDir, generatedLibPath }),
        /enummaps\.go LibMap entry anchor/u,
    );
});

test("prepareTypeScriptGoBaselinePatch refuses to patch a clone that drifted from the pin", () => {
    const tempDirectory = createTempDirectory(tempDirectories);
    const typescriptGoDir = createFakeTypeScriptGoTree(tempDirectory);
    const generatedLibPath = path.join(tempDirectory, "generated", "baseline.d.ts");
    fs.mkdirSync(path.dirname(generatedLibPath), { recursive: true });
    fs.writeFileSync(generatedLibPath, "// generated baseline\n");

    execFileSync("git", ["init", "--quiet"], { cwd: typescriptGoDir });
    execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "add", "."], { cwd: typescriptGoDir });
    execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "--quiet", "-m", "fixture"], { cwd: typescriptGoDir });

    assert.throws(
        () => prepareTypeScriptGoBaselinePatch({
            repoRoot: tempDirectory,
            typescriptGoDir,
            generatedLibPath,
            expectedCommit: "0000000000000000000000000000000000000000",
        }),
        /Refusing to patch an unpinned clone/u,
    );
    assert.ok(!fs.existsSync(path.join(typescriptGoDir, typescriptGoSubmoduleLibDir, "baseline.d.ts")));
});

/**
 * @param {string} tempDirectory
 */
function createFakeTypeScriptGoTree(tempDirectory) {
    const typescriptGoDir = path.join(tempDirectory, "typescript-go");
    const submoduleLibDir = path.join(typescriptGoDir, typescriptGoSubmoduleLibDir);
    const enumMapsDir = path.dirname(path.join(typescriptGoDir, enumMapsRelativePath));

    fs.mkdirSync(submoduleLibDir, { recursive: true });
    fs.mkdirSync(enumMapsDir, { recursive: true });

    fs.writeFileSync(
        path.join(submoduleLibDir, "libs.json"),
        `{
    "libs": [
        "es2025",
        "esnext",
        "dom"
    ]
}
`,
    );
    fs.writeFileSync(
        path.join(typescriptGoDir, enumMapsRelativePath),
        `package tsoptions

var LibMap = collections.NewOrderedMapFromList([]collections.MapEntry[string, any]{
	{Key: "es2025", Value: "lib.es2025.d.ts"},
	{Key: "esnext", Value: "lib.esnext.d.ts"},
	// Host only
	{Key: "dom", Value: "lib.dom.d.ts"},
})
`,
    );

    return typescriptGoDir;
}
