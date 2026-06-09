// @ts-check

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { selectActiveNegativeProbes } from "../lib/negative-probes.mjs";
import {
    cleanupTempDirectories,
    createManifest,
    createTempDirectory,
    readJsonFile,
    repoDatasetPath,
    repoRegistryPath,
    runGenerate,
    runGenerateExpectFailure,
    writeJsonFile,
} from "./helpers.mjs";

/** @type {string[]} */
const tempDirectories = [];

test.afterEach(() => {
    cleanupTempDirectories(tempDirectories);
});

test("generate emits a direct baseline lib for the current JS builtins widely available surface", () => {
    const tempDirectory = createTempDirectory(tempDirectories);
    const fixture = createManifest(tempDirectory);
    /** @type {{ featureRows: unknown[]; compatRows: Array<{ compatKey: string; baselineStatus: string | boolean | undefined; }>; }} */
    const dataset = readJsonFile(repoDatasetPath);
    const expectedLibCompatRows = dataset.compatRows.filter(row => row.compatKey.startsWith("javascript.builtins."));
    const expectedHighCompatRows = expectedLibCompatRows.filter(row => row.baselineStatus === "high");

    const output = runGenerate(fixture.manifestPath);
    assert.match(output, /Generated first-class baseline lib baseline/);

    const topLevelOutput = fs.readFileSync(fixture.topLevelOutputPath, "utf8");
    const classificationReport = readJsonFile(fixture.classificationOutputPath);
    const compatManagementReport = readJsonFile(fixture.compatManagementOutputPath);
    const inventoryReport = readJsonFile(fixture.inventoryOutputPath);
    const generationReport = readJsonFile(fixture.generationOutputPath);

    assert.match(topLevelOutput, /interface Array<T>/);
    assert.match(topLevelOutput, /declare namespace Intl/);
    assert.match(topLevelOutput, /interface CallableFunction/);
    assert.match(topLevelOutput, /interface Iterator<T, TReturn = any, TNext = any> \{[\s\S]*next\(/);
    assert.match(topLevelOutput, /interface ArrayBufferTypes \{[\s\S]*ArrayBuffer: ArrayBuffer;/);
    assert.match(topLevelOutput, /interface ListFormatOptions \{[\s\S]*localeMatcher\?:/);
    assert.doesNotMatch(topLevelOutput, /\/\/\/ <reference lib=/);
    assert.equal([...topLevelOutput.matchAll(/Copyright \(c\) Microsoft Corporation/g)].length, 1);

    // Pick negative probes dynamically from the just-generated classification.
    // Stable probes (baselineStatus: false) never appear in the output, and low
    // probes never appear until they're promoted.
    const negativeProbes = selectActiveNegativeProbes(classificationReport.classifiedCompatRows);
    assert.ok(negativeProbes.length >= 4, "expected stable probes plus at least one active low probe");
    for (const probe of negativeProbes) {
        if (probe.absencePattern) {
            assert.doesNotMatch(
                topLevelOutput,
                probe.absencePattern,
                `excluded probe ${probe.compatKey} must not appear in the emitted lib`,
            );
        }
    }

    // RegExp legacy statics (BCD single key RegExp.n) must not leak in either.
    assert.doesNotMatch(topLevelOutput, /"\$1"/);
    assert.doesNotMatch(topLevelOutput, /"lastMatch"/);

    // The exclusion-invariant audit info must appear in the report.
    assert.ok(generationReport.summary.excludedUnitCount > 0);
    assert.ok(Array.isArray(generationReport.excludedUnits));
    assert.ok(
        generationReport.excludedUnits.some(
            /** @param {{ compatKeys: string[]; }} entry */
            entry => entry.compatKeys.includes("javascript.builtins.Function.caller"),
        ),
    );

    assert.equal(classificationReport.summary.featureCount, dataset.featureRows.length);
    assert.equal(classificationReport.summary.compatCount, dataset.compatRows.length);
    assert.equal(classificationReport.summary.libCompatCount, expectedLibCompatRows.length);
    assert.equal(classificationReport.summary.highCompatCount, expectedHighCompatRows.length);
    assert.equal(classificationReport.summary.libCompatCount, classificationReport.classifiedCompatRows.length);
    assert.equal(compatManagementReport.registry.kind, "typescript-baseline-lib/compat-management-registry");
    assert.equal(generationReport.summary.classifiedCompatCount, expectedLibCompatRows.length);
    assert.equal(generationReport.topLevelLib.libName, "baseline");
    assert.ok(inventoryReport.summary.unitCount > 0);

    // Determinism guard: checked-in reports must hold only the canonical source
    // path (<basePackage>/lib/<file>) and never leak an environment-specific real
    // path (a platform-specific package or an absolute/relative node_modules path).
    // A leak makes artifacts differ between CI (linux) and local (mac) and breaks
    // the determinism check (a regression that actually happened).
    for (const [label, report] of [["generation", generationReport], ["inventory", inventoryReport]]) {
        assert.ok(Array.isArray(report.sourceLibs) && report.sourceLibs.length > 0, `${label} report must list source libs`);
        for (const sourceLib of report.sourceLibs) {
            assert.equal(
                sourceLib.sourcePath,
                `typescript/lib/${sourceLib.sourceFileName}`,
                `${label} report sourcePath must be canonical and platform-neutral`,
            );
            assert.doesNotMatch(
                sourceLib.sourcePath,
                /node_modules|typescript-(darwin|linux|win32|freebsd|openbsd|netbsd|sunos|aix)/u,
                `${label} report sourcePath must not leak a platform-specific package path`,
            );
        }
    }
});

test("generate fails closed when compat-management metadata drifts", () => {
    const tempDirectory = createTempDirectory(tempDirectories);
    const registryPath = `${tempDirectory}/compat-management.json`;
    const registry = readJsonFile(repoRegistryPath);

    writeJsonFile(registryPath, {
        ...registry,
        groups: registry.groups.map(
            /** @param {{ id: string; compatKeys: string[]; }} group */
            group =>
            group.id === "globalthis-checker-covered"
                ? {
                    ...group,
                    compatKeys: ["javascript.builtins.globalThis.misaligned"],
                }
                : group
        ),
    });

    const fixture = createManifest(tempDirectory, { registryPath });
    const failureOutput = runGenerateExpectFailure(fixture.manifestPath);

    assert.match(failureOutput, /compat management registry drift detected/);
    assert.match(failureOutput, /javascript\.builtins\.globalThis/);
});
