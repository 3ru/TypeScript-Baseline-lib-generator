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
import { prepareTypeScriptBaselinePatch } from "../lib/typescript-upstream.mjs";

/** @type {string[]} */
const tempDirectories = [];

test.afterEach(() => {
    cleanupTempDirectories(tempDirectories);
});

test("prepareTypeScriptBaselinePatch installs baseline.d.ts source and patches TypeScript once", () => {
    const tempDirectory = createTempDirectory(tempDirectories);
    const typescriptDir = createFakeTypeScriptTree(tempDirectory);
    const generatedLibPath = path.join(tempDirectory, "generated", "baseline.d.ts");
    const fixturesRoot = path.join(tempDirectory, "fixtures");

    fs.mkdirSync(path.dirname(generatedLibPath), { recursive: true });
    fs.writeFileSync(generatedLibPath, "// generated baseline\n");

    fs.mkdirSync(path.join(fixturesRoot, "tests", "cases", "compiler"), { recursive: true });
    fs.mkdirSync(path.join(fixturesRoot, "tests", "baselines", "reference"), { recursive: true });
    fs.writeFileSync(
        path.join(fixturesRoot, "tests", "cases", "compiler", "libBaseline.ts"),
        "// @lib: baseline\nObject.hasOwn({}, 'x');\n",
    );
    fs.writeFileSync(
        path.join(fixturesRoot, "tests", "baselines", "reference", "libBaseline.errors.txt"),
        "fixture baseline\n",
    );

    const firstSummary = prepareTypeScriptBaselinePatch({
        repoRoot: tempDirectory,
        typescriptDir,
        generatedLibPath,
        fixturesRoot,
    });

    const targetLibPath = path.join(typescriptDir, "src", "lib", "baseline.d.ts");
    const commandLineParserPath = path.join(typescriptDir, "src", "compiler", "commandLineParser.ts");
    const libsJsonPath = path.join(typescriptDir, "src", "lib", "libs.json");

    assert.equal(fs.readFileSync(targetLibPath, "utf8"), "// generated baseline\n");
    assert.match(fs.readFileSync(commandLineParserPath, "utf8"), /\["baseline", "lib\.baseline\.d\.ts"\],/);
    assert.equal(
        [...fs.readFileSync(commandLineParserPath, "utf8").matchAll(/\["baseline", "lib\.baseline\.d\.ts"\],/g)].length,
        1,
    );
    assert.match(fs.readFileSync(libsJsonPath, "utf8"), /"baseline"/);
    assert.equal(
        [...fs.readFileSync(libsJsonPath, "utf8").matchAll(/"baseline"/g)].length,
        1,
    );
    assert.ok(fs.existsSync(path.join(typescriptDir, "tests", "cases", "compiler", "libBaseline.ts")));
    assert.ok(fs.existsSync(path.join(typescriptDir, "tests", "baselines", "reference", "libBaseline.errors.txt")));
    assert.equal(firstSummary.fixtureFiles.length, 2);
    // First run actually writes both files.
    assert.equal(firstSummary.changedFixtureFiles.length, 2);

    const secondSummary = prepareTypeScriptBaselinePatch({
        repoRoot: tempDirectory,
        typescriptDir,
        generatedLibPath,
        fixturesRoot,
    });

    assert.equal(secondSummary.copiedGeneratedLib.changed, false);
    assert.equal(secondSummary.patchedCommandLineParser.changed, false);
    assert.equal(secondSummary.patchedLibsJson.changed, false);
    // Second run reports the same fixture list, but zero files changed
    // (summary must not misreport unchanged files as "copied").
    assert.equal(secondSummary.fixtureFiles.length, 2);
    assert.equal(secondSummary.changedFixtureFiles.length, 0);
});

/**
 * @param {string} tempDirectory
 */
function createFakeTypeScriptTree(tempDirectory) {
    const typescriptDir = path.join(tempDirectory, "TypeScript");
    const compilerDirectory = path.join(typescriptDir, "src", "compiler");
    const libDirectory = path.join(typescriptDir, "src", "lib");

    fs.mkdirSync(compilerDirectory, { recursive: true });
    fs.mkdirSync(libDirectory, { recursive: true });

    fs.writeFileSync(
        path.join(compilerDirectory, "commandLineParser.ts"),
        `const libEntries: [string, string][] = [
    ["es2025", "lib.es2025.d.ts"],
    ["esnext", "lib.esnext.d.ts"],
    // Host only
    ["dom", "lib.dom.d.ts"],
];
`,
    );
    fs.writeFileSync(
        path.join(libDirectory, "libs.json"),
        `{
    "libs": [
        "es2025",
        "esnext",
        // Host only
        "dom"
    ]
}
`,
    );

    return typescriptDir;
}

test("prepareTypeScriptBaselinePatch refuses to patch a clone that drifted from the pin", () => {
    const tempDirectory = createTempDirectory(tempDirectories);
    const typescriptDir = createFakeTypeScriptTree(tempDirectory);
    const generatedLibPath = path.join(tempDirectory, "generated", "baseline.d.ts");
    const fixturesRoot = path.join(tempDirectory, "fixtures");

    fs.mkdirSync(path.dirname(generatedLibPath), { recursive: true });
    fs.writeFileSync(generatedLibPath, "// generated baseline\n");
    fs.mkdirSync(path.join(fixturesRoot, "tests", "cases", "compiler"), { recursive: true });

    // Turn the fixture tree into a real git repo to reproduce a HEAD that differs from the pin.
    execFileSync("git", ["init", "--quiet"], { cwd: typescriptDir });
    execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "add", "."], { cwd: typescriptDir });
    execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "--quiet", "-m", "fixture"], { cwd: typescriptDir });

    const pinnedCommit = "0000000000000000000000000000000000000000";
    assert.throws(
        () => prepareTypeScriptBaselinePatch({
            repoRoot: tempDirectory,
            typescriptDir,
            generatedLibPath,
            fixturesRoot,
            expectedCommit: pinnedCommit,
        }),
        /Refusing to patch an unpinned clone/u,
    );

    // Nothing was written (validation runs before patching).
    assert.ok(!fs.existsSync(path.join(typescriptDir, "src", "lib", "baseline.d.ts")));

    // allowUnpinned is an explicit opt-out that lets the patch through.
    const summary = prepareTypeScriptBaselinePatch({
        repoRoot: tempDirectory,
        typescriptDir,
        generatedLibPath,
        fixturesRoot,
        expectedCommit: pinnedCommit,
        allowUnpinned: true,
    });
    assert.equal(summary.copiedGeneratedLib.changed, true);
});
