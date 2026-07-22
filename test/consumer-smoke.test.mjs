// @ts-check

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { baselinePackageName } from "../deploy/package-registry.mjs";
import {
    REGEXP_LEGACY_STATIC_ABSENCE_ASSERTION,
    renderNegativeProbeSource,
} from "../lib/negative-probes.mjs";
import {
    cleanupTempDirectories,
    loadActiveNegativeProbesFromRepo,
    readJsonFile,
    stageBaselinePackage,
    createTempDirectory,
    runNpm,
    runTsc,
    runTscExpectFailure,
    runTscStrada,
    runTscStradaExpectFailure,
    writeJsonFile,
    writeTextFile,
} from "./helpers.mjs";

/** @type {string[]} */
const tempDirectories = [];

test.afterEach(() => {
    cleanupTempDirectories(tempDirectories);
});

test("staged consumer smoke: stock tsc accepts supported baseline APIs and rejects excluded ones through package install", async () => {
    const tempDirectory = createTempDirectory(tempDirectories);
    const consumerDirectory = path.join(tempDirectory, "consumer");
    const { stageDirectory } = await stageBaselinePackage({ tempDirectories });

    writeJsonFile(path.join(consumerDirectory, "package.json"), {
        name: "baseline-consumer-stage-fixture",
        private: true,
    });
    writeJsonFile(path.join(consumerDirectory, "tsconfig.json"), {
        compilerOptions: {
            noLib: true,
            strict: true,
            types: [baselinePackageName],
        },
        files: ["consumer-pass.ts"],
    });
    runNpm(["install", "--no-package-lock", "--no-save", stageDirectory], { cwd: consumerDirectory });

    const stagedSnapshot = readJsonFile(path.join(stageDirectory, "snapshot.json"));
    const importProbePath = path.join(consumerDirectory, "snapshot-import.mjs");
    const requireProbePath = path.join(consumerDirectory, "snapshot-require.cjs");
    writeTextFile(importProbePath, [
        `import snapshot from "${baselinePackageName}/snapshot.json" with { type: "json" };`,
        "process.stdout.write(JSON.stringify(snapshot));",
        "",
    ].join("\n"));
    writeTextFile(requireProbePath, [
        `const snapshot = require("${baselinePackageName}/snapshot.json");`,
        "process.stdout.write(JSON.stringify(snapshot));",
        "",
    ].join("\n"));
    const importedSnapshot = JSON.parse(execFileSync(process.execPath, [importProbePath], {
        cwd: consumerDirectory,
        encoding: "utf8",
    }));
    const requiredSnapshot = JSON.parse(execFileSync(process.execPath, [requireProbePath], {
        cwd: consumerDirectory,
        encoding: "utf8",
    }));
    assert.deepEqual(importedSnapshot, stagedSnapshot);
    assert.deepEqual(requiredSnapshot, stagedSnapshot);

    const passPath = path.join(consumerDirectory, "consumer-pass.ts");
    writeTextFile(passPath, [
        "const reversed = [1, 2, 3].toReversed();",
        "Intl.supportedValuesOf(\"currency\");",
        "reversed.length;",
        REGEXP_LEGACY_STATIC_ABSENCE_ASSERTION,
        "",
    ].join("\n"));

    // Consumers will run a mix of TypeScript 6 (Strada) and 7 (tsgo) for now,
    // so pin that the staged package passes under both toolchains.
    runTsc(["-p", path.join(consumerDirectory, "tsconfig.json")], { cwd: consumerDirectory });
    runTscStrada(["-p", path.join(consumerDirectory, "tsconfig.json")], { cwd: consumerDirectory });

    // Verify excluded APIs by deriving the "currently excluded" probes from the
    // checked-in classification rather than hardcoding them. When a Baseline
    // promotion activates a probe it drops out of the candidates automatically,
    // so the test doesn't break with the calendar.
    const negativeProbes = loadActiveNegativeProbesFromRepo();
    const failPath = path.join(consumerDirectory, "consumer-fail.ts");
    writeTextFile(failPath, renderNegativeProbeSource(negativeProbes));
    writeJsonFile(path.join(consumerDirectory, "tsconfig.fail.json"), {
        compilerOptions: {
            noLib: true,
            strict: true,
            types: [baselinePackageName],
        },
        files: ["consumer-fail.ts"],
    });

    const failure = runTscExpectFailure(["-p", path.join(consumerDirectory, "tsconfig.fail.json")], { cwd: consumerDirectory });
    assert.equal(failure.ok, false);
    for (const probe of negativeProbes) {
        assert.match(failure.output, probe.errorPattern, `expected excluded probe ${probe.compatKey} to fail compilation`);
    }

    // Pin that excluded APIs fail the same way under Strada too (a leak is
    // caught by either checker).
    const stradaFailure = runTscStradaExpectFailure(["-p", path.join(consumerDirectory, "tsconfig.fail.json")], { cwd: consumerDirectory });
    assert.equal(stradaFailure.ok, false);
    for (const probe of negativeProbes) {
        assert.match(stradaFailure.output, probe.errorPattern, `expected excluded probe ${probe.compatKey} to fail compilation under strada`);
    }
});
