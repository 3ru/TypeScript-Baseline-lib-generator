// @ts-check

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { selectActiveNegativeProbes } from "../lib/negative-probes.mjs";
import { isLibCompatKey } from "../lib/surface-inventory.mjs";
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

test("generate emits the current TypeScript-declarable Baseline JavaScript surface", () => {
    const tempDirectory = createTempDirectory(tempDirectories);
    const fixture = createManifest(tempDirectory);
    /** @type {{ featureRows: unknown[]; compatRows: Array<{ compatKey: string; baselineStatus: string | boolean | undefined; }>; }} */
    const dataset = readJsonFile(repoDatasetPath);
    const registry = readJsonFile(repoRegistryPath);
    const expectedLibCompatRows = dataset.compatRows.filter(row => isLibCompatKey(row.compatKey));
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
    for (const typeName of [
        "Awaited",
        "Partial",
        "Required",
        "Readonly",
        "Pick",
        "Record",
        "Exclude",
        "Extract",
        "Omit",
        "NonNullable",
        "Parameters",
        "ConstructorParameters",
        "ReturnType",
        "InstanceType",
        "ThisParameterType",
        "OmitThisParameter",
        "ThisType",
        "Uppercase",
        "Lowercase",
        "Capitalize",
        "Uncapitalize",
        "ReadonlyMap",
        "ReadonlySet",
        "IterableIterator",
        "AsyncIterable",
        "AsyncIterableIterator",
        "TemplateStringsArray",
    ]) {
        assert.match(
            topLevelOutput,
            new RegExp(`(?:type|interface) ${typeName}(?:[<{\\s]|$)`),
            `expected erased declaration ${typeName}`,
        );
    }
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
    for (const probe of [
        { name: "Float16Array", pattern: /\b(?:interface|declare var) Float16Array\b/ },
        { name: "Promise.withResolvers", pattern: /\bwithResolvers\s*\(/ },
        { name: "Array.fromAsync", pattern: /\bfromAsync\s*</ },
        { name: "Intl.Segmenter", pattern: /\b(?:interface|const) Segmenter\b/ },
        { name: "String.prototype.substr", pattern: /\bsubstr\s*\(/ },
        { name: "escape", pattern: /^declare function escape\b/m },
    ]) {
        assert.doesNotMatch(topLevelOutput, probe.pattern, `excluded runtime surface ${probe.name} must stay absent`);
    }

    // The exclusion-invariant audit info must appear in the report.
    assert.ok(generationReport.summary.excludedUnitCount > 0);
    assert.ok(Array.isArray(generationReport.excludedUnits));
    assert.ok(
        generationReport.excludedUnits.some(
            /** @param {{ compatKeys: string[]; }} entry */
            entry => entry.compatKeys.includes("javascript.builtins.Function.caller"),
        ),
    );
    const classifiedRowByCompatKey = new Map(classificationReport.classifiedCompatRows.map(
        /** @param {{ compatKey: string; }} row */
        row => [row.compatKey, row],
    ));
    const excludedUnitById = new Map(generationReport.excludedUnits.map(
        /** @param {{ unitId: string; }} entry */
        entry => [entry.unitId, entry],
    ));
    for (const compatKey of Object.keys(registry.declarationMappings ?? {})) {
        const classifiedRow = classifiedRowByCompatKey.get(compatKey);
        assert.ok(classifiedRow, `expected mapped classification row ${compatKey}`);
        assert.equal(classifiedRow.resolutionKind, "member");
        assert.ok(classifiedRow.resolvedUnitIds.length > 0);
        if (!classifiedRow.includeInTarget) {
            for (const unitId of classifiedRow.resolvedUnitIds) {
                assert.ok(
                    excludedUnitById.get(unitId)?.compatKeys.includes(compatKey),
                    `mapped unit ${unitId} must retain exclusion provenance for ${compatKey}`,
                );
            }
        }
    }

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

test("generate rejects emitted instance and static members whose compat row disappeared", () => {
    for (const probe of [
        {
            compatKey: "javascript.builtins.String.substr",
            unitPattern: /lib\.es5\.d\.ts::String\.substr/u,
        },
        {
            compatKey: "javascript.builtins.Array.isArray",
            unitPattern: /lib\.es5\.d\.ts::ArrayConstructor\.isArray/u,
        },
        {
            compatKey: "javascript.builtins.String.toString",
            unitPattern: /lib\.es5\.d\.ts::String\.toString/u,
        },
        {
            compatKey: "javascript.builtins.String.valueOf",
            unitPattern: /lib\.es5\.d\.ts::String\.valueOf/u,
        },
    ]) {
        const tempDirectory = createTempDirectory(tempDirectories);
        const datasetPath = `${tempDirectory}/dataset.json`;
        const dataset = readJsonFile(repoDatasetPath);
        dataset.compatRows = dataset.compatRows.filter(
            /** @param {{ compatKey: string; }} row */
            row => row.compatKey !== probe.compatKey,
        );
        writeJsonFile(datasetPath, dataset);

        const fixture = createManifest(tempDirectory, { datasetPath });
        const failureOutput = runGenerateExpectFailure(fixture.manifestPath, probe.compatKey);
        assert.match(failureOutput, /Emitted runtime declarations lack compat or compiler-support provenance/u);
        assert.match(failureOutput, probe.unitPattern);
    }
});

test("generate rejects stale compiler support registry surfaces", () => {
    const tempDirectory = createTempDirectory(tempDirectories);
    const registryPath = `${tempDirectory}/compat-management.json`;
    const registry = readJsonFile(repoRegistryPath);
    registry.compilerSupport[0].surfaces.push("MissingCompilerSupportSurface");
    writeJsonFile(registryPath, registry);

    const fixture = createManifest(tempDirectory, { registryPath });
    assert.match(
        runGenerateExpectFailure(fixture.manifestPath),
        /Compiler support surface is not modeled by the TypeScript lib inventory: MissingCompilerSupportSurface/u,
    );
});

test("generate rejects stale runtime alias registry surfaces", () => {
    const tempDirectory = createTempDirectory(tempDirectories);
    const registryPath = `${tempDirectory}/compat-management.json`;
    const registry = readJsonFile(repoRegistryPath);
    registry.runtimeAliases[0].surfaces.push("MissingRuntimeAliasSurface");
    writeJsonFile(registryPath, registry);

    const fixture = createManifest(tempDirectory, { registryPath });
    assert.match(
        runGenerateExpectFailure(fixture.manifestPath),
        /Runtime alias surface is not modeled by the TypeScript lib inventory: MissingRuntimeAliasSurface/u,
    );
});

test("generate rejects manifest and stale-report paths outside managed output roots", () => {
    const tempDirectory = createTempDirectory(tempDirectories);
    const fixture = createManifest(tempDirectory);
    const manifest = readJsonFile(fixture.manifestPath);
    manifest.firstClassLib.allowDirectory = "../outside";
    writeJsonFile(fixture.manifestPath, manifest);
    assert.match(
        runGenerateExpectFailure(fixture.manifestPath),
        /must be a repo-relative path without '\.\.'/u,
    );

    const safeFixture = createManifest(createTempDirectory(tempDirectories));
    writeJsonFile(safeFixture.generationOutputPath, {
        outputEntries: [{ outputPath: "../outside" }],
    });
    assert.match(
        runGenerateExpectFailure(safeFixture.manifestPath),
        /outputEntries\[\]\.outputPath must be a repo-relative path without '\.\.'/u,
    );
});
