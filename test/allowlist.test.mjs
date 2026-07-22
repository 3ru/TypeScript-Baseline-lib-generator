// @ts-check

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
    assertAllowEntryContractsPreserved,
    assertNoRemovedAllowEntries,
} from "../deploy/package-lib.mjs";
import { baselinePackageName } from "../deploy/package-registry.mjs";
import { loadAllowlistRegistry } from "../lib/allowlist-registry.mjs";
import {
    cleanupTempDirectories,
    createBaselinePackageTarball,
    createManifest,
    createTempDirectory,
    readJsonFile,
    repoAllowlistRegistryPath,
    repoDatasetPath,
    runGenerate,
    runGenerateExpectFailure,
    runNpm,
    runTsc,
    runTscExpectFailure,
    runTscStrada,
    runTscStradaExpectFailure,
    writeJsonFile,
    writeTextFile,
} from "./helpers.mjs";

/** @type {Record<string, string>} */
const ALLOW_ENTRY_PROBES = {
    "array-fromasync": "Array.fromAsync([1, 2, 3]);\n",
    "array-group": [
        "Object.groupBy([1, 2, 3], value => String(value));",
        "Map.groupBy([1, 2, 3], value => value % 2);",
        "",
    ].join("\n"),
    "atomics-pause": "Atomics.pause();\n",
    "atomics-wait-async": "Atomics.waitAsync(new Int32Array(new SharedArrayBuffer(4)), 0, 0);\n",
    float16array: [
        "const float16 = new Float16Array(2);",
        "const float16View = new DataView(new ArrayBuffer(4));",
        "float16View.getFloat16(0);",
        "float16View.setFloat16(0, Math.f16round(1));",
        "float16.length;",
        "float16.map(value => value);",
        "Float16Array.from([1, 2, 3]);",
        "",
    ].join("\n"),
    getorinsert: [
        "const map = new Map<string, number>();",
        "map.getOrInsert(\"key\", 1);",
        "map.getOrInsertComputed(\"key\", () => 1);",
        "const weakMap = new WeakMap<object, number>();",
        "weakMap.getOrInsert({}, 1);",
        "weakMap.getOrInsertComputed({}, () => 1);",
        "",
    ].join("\n"),
    "intl-duration-format": [
        "const durationFormat = new Intl.DurationFormat(\"en\");",
        "durationFormat.format({ seconds: 1 });",
        "durationFormat.formatToParts({ seconds: 1 });",
        "durationFormat.resolvedOptions();",
        "Intl.DurationFormat.supportedLocalesOf([\"en\"]);",
        "",
    ].join("\n"),
    "intl-segmenter": [
        "const segmenter = new Intl.Segmenter(\"en\");",
        "const segments = segmenter.segment(\"text\");",
        "segments.containing(0);",
        "segments[Symbol.iterator]();",
        "segmenter.resolvedOptions();",
        "Intl.Segmenter.supportedLocalesOf([\"en\"]);",
        "",
    ].join("\n"),
    "promise-try": "Promise.try(() => 1);\n",
    "promise-withresolvers": "Promise.withResolvers<number>();\n",
    "regexp-escape": "RegExp.escape(\"a.b\");\n",
    "resizable-buffers": [
        "const resizable = new ArrayBuffer(8, { maxByteLength: 16 });",
        "resizable.maxByteLength;",
        "resizable.resizable;",
        "resizable.resize(12);",
        "const growable = new SharedArrayBuffer(8, { maxByteLength: 16 });",
        "growable.maxByteLength;",
        "growable.growable;",
        "growable.grow(12);",
        "",
    ].join("\n"),
    "set-methods": [
        "const left = new Set([1]);",
        "const right = new Set([2]);",
        "left.union(right);",
        "left.intersection(right);",
        "left.difference(right);",
        "left.symmetricDifference(right);",
        "left.isSubsetOf(right);",
        "left.isSupersetOf(right);",
        "left.isDisjointFrom(right);",
        "",
    ].join("\n"),
    "transferable-arraybuffer": [
        "const transferable = new ArrayBuffer(8);",
        "transferable.detached;",
        "transferable.transfer();",
        "transferable.transferToFixedLength();",
        "",
    ].join("\n"),
    "uint8array-base64-hex": [
        "const bytes = Uint8Array.fromBase64(\"AA==\");",
        "Uint8Array.fromHex(\"00\");",
        "bytes.setFromBase64(\"AA==\");",
        "bytes.setFromHex(\"00\");",
        "bytes.toBase64();",
        "bytes.toHex();",
        "",
    ].join("\n"),
};

/** @type {string[]} */
const tempDirectories = [];

test.afterEach(() => {
    cleanupTempDirectories(tempDirectories);
});

test("every registered allow entry exposes its complete API surface under TypeScript 6 and 7", async () => {
    const tempDirectory = createTempDirectory(tempDirectories);
    const consumerDirectory = path.join(tempDirectory, "consumer");
    const { stageDirectory, tarballPath } = await createBaselinePackageTarball({ tempDirectories });
    const registry = await loadAllowlistRegistry(repoAllowlistRegistryPath);
    const stagedPackageJson = readJsonFile(path.join(stageDirectory, "package.json"));
    const stagedGeneration = readJsonFile(path.join(stageDirectory, "reports", "generation.json"));
    const generationEntryByName = new Map(stagedGeneration.allowEntries.map(
        /** @param {{ entryName: string; kind: string; }} entry */
        entry => [entry.entryName, entry],
    ));

    assert.deepEqual(
        Object.keys(ALLOW_ENTRY_PROBES).sort(),
        registry.entries.map(entry => entry.entryName),
    );
    assert.deepEqual(stagedPackageJson.typesVersions["*"]["allow/*"], ["allow/*/index.d.ts"]);
    assert.equal(stagedPackageJson.exports, undefined);

    writeJsonFile(path.join(consumerDirectory, "package.json"), {
        name: "baseline-allow-consumer-fixture",
        private: true,
    });
    runNpm(["install", "--no-package-lock", "--no-save", tarballPath], { cwd: consumerDirectory });

    for (const entry of registry.entries) {
        writeTextFile(path.join(consumerDirectory, `${entry.entryName}.ts`), ALLOW_ENTRY_PROBES[entry.entryName]);
        writeConsumerConfig(consumerDirectory, entry.entryName, [
            baselinePackageName,
            `${baselinePackageName}/allow/${entry.entryName}`,
        ]);
        const configPath = path.join(consumerDirectory, `tsconfig.${entry.entryName}.json`);
        runTsc(["-p", configPath], { cwd: consumerDirectory });
        runTscStrada(["-p", configPath], { cwd: consumerDirectory });

        const baseName = `base-${entry.entryName}`;
        writeTextFile(path.join(consumerDirectory, `${baseName}.ts`), ALLOW_ENTRY_PROBES[entry.entryName]);
        writeConsumerConfig(consumerDirectory, baseName, [baselinePackageName]);
        const baseConfigPath = path.join(consumerDirectory, `tsconfig.${baseName}.json`);
        if (generationEntryByName.get(entry.entryName)?.kind === "active") {
            assert.equal(runTscExpectFailure(["-p", baseConfigPath], { cwd: consumerDirectory }).ok, false);
            assert.equal(runTscStradaExpectFailure(["-p", baseConfigPath], { cwd: consumerDirectory }).ok, false);
        }
        else {
            runTsc(["-p", baseConfigPath], { cwd: consumerDirectory });
            runTscStrada(["-p", baseConfigPath], { cwd: consumerDirectory });
        }
    }
});

test("allow entries preserve isolation under TypeScript 6 and 7", async () => {
    const tempDirectory = createTempDirectory(tempDirectories);
    const consumerDirectory = path.join(tempDirectory, "consumer");
    const { tarballPath } = await createBaselinePackageTarball({ tempDirectories });
    const promiseEntry = `${baselinePackageName}/allow/promise-withresolvers`;

    writeJsonFile(path.join(consumerDirectory, "package.json"), {
        name: "baseline-allow-isolation-fixture",
        private: true,
    });
    runNpm(["install", "--no-package-lock", "--no-save", tarballPath], { cwd: consumerDirectory });

    writeTextFile(path.join(consumerDirectory, "promise-only-fail.ts"), "Array.fromAsync([1, 2, 3]);\n");
    writeConsumerConfig(consumerDirectory, "promise-only-fail", [baselinePackageName, promiseEntry]);
    assertCompilerFailuresContain(consumerDirectory, "promise-only-fail", /fromAsync/);

    writeTextFile(path.join(consumerDirectory, "limited-fail.ts"), "\"legacy\".substr(1);\n");
    writeConsumerConfig(consumerDirectory, "limited-fail", [baselinePackageName, promiseEntry]);
    assertCompilerFailuresContain(consumerDirectory, "limited-fail", /substr/);
});

test("generation is registry-bound, non-empty, safe, and deterministic", async () => {
    const tempDirectory = createTempDirectory(tempDirectories);
    const fixture = createManifest(tempDirectory);
    const registry = await loadAllowlistRegistry(repoAllowlistRegistryPath);

    runGenerate(fixture.manifestPath);
    const firstSnapshot = readDirectorySnapshot(path.join(fixture.outputRoot, "generated", "allow"));
    const generation = readJsonFile(fixture.generationOutputPath);

    assert.deepEqual(
        generation.allowEntries.map(
            /** @param {{ entryName: string; }} entry */
            entry => entry.entryName,
        ),
        registry.entries.map(entry => entry.entryName),
    );
    assert.ok(generation.allowEntries.every(
        /** @param {{ kind: string; unitIds: string[]; }} entry */
        entry => entry.kind === "alias" || entry.unitIds.length > 0,
    ));
    assert.deepEqual(
        generation.allowEntries.filter(
            /** @param {{ entryName: string; }} entry */
            entry => ["iterator-concat", "iterator-methods", "json-raw", "math-sum-precise", "weak-references", "weakmap", "weakset"]
                .includes(entry.entryName),
        ),
        [],
    );

    const supportDirectory = path.join(fixture.outputRoot, "generated", "allow", "_support");
    const supportFiles = fs.existsSync(supportDirectory)
        ? fs.readdirSync(supportDirectory).sort()
        : [];
    /** @type {Map<string, Set<string>>} */
    const consumersByUnitId = new Map();
    for (const entry of generation.allowEntries) {
        for (const unitId of entry.supportUnitIds) {
            const consumers = consumersByUnitId.get(unitId) ?? new Set();
            consumers.add(entry.entryName);
            consumersByUnitId.set(unitId, consumers);
        }
    }
    const consumerGroups = new Set(
        [...consumersByUnitId.values()].map(consumers => [...consumers].sort().join("\0")),
    );
    assert.equal(supportFiles.length, consumerGroups.size);
    for (const group of consumerGroups) {
        const entryNames = group.split("\0");
        if (entryNames.length === 1) {
            assert.ok(supportFiles.includes(`${entryNames[0]}.d.ts`));
        }
    }

    const referencedSupportFiles = new Set();
    for (const entry of generation.allowEntries) {
        const source = fs.readFileSync(
            path.join(fixture.outputRoot, "generated", "allow", entry.entryName, "index.d.ts"),
            "utf8",
        );
        for (const match of source.matchAll(/^\/\/\/ <reference path="\.\.\/_support\/([^"]+)" \/>$/gm)) {
            assert.ok(supportFiles.includes(match[1]));
            referencedSupportFiles.add(match[1]);
        }
    }
    assert.deepEqual([...referencedSupportFiles].sort(), supportFiles);

    runGenerate(fixture.manifestPath);
    const secondSnapshot = readDirectorySnapshot(path.join(fixture.outputRoot, "generated", "allow"));
    assert.deepEqual(secondSnapshot, firstSnapshot);
});

test("shared support bundles preserve entry isolation and composition under TypeScript 6 and 7", () => {
    const tempDirectory = createTempDirectory(tempDirectories);
    const allowlistRegistryPath = path.join(tempDirectory, "allowlist.json");
    writeJsonFile(allowlistRegistryPath, {
        schemaVersion: 1,
        entries: [
            {
                entryName: "duration-core",
                compatKeys: [
                    "javascript.builtins.Intl.DurationFormat",
                    "javascript.builtins.Intl.DurationFormat.DurationFormat",
                    "javascript.builtins.Intl.DurationFormat.format",
                ],
            },
            {
                entryName: "duration-details",
                compatKeys: [
                    "javascript.builtins.Intl.DurationFormat.formatToParts",
                    "javascript.builtins.Intl.DurationFormat.resolvedOptions",
                ],
            },
        ],
    });
    const fixture = createManifest(tempDirectory, { allowlistRegistryPath });
    runGenerate(fixture.manifestPath);

    const coreEntryPath = path.join(fixture.outputRoot, "generated", "allow", "duration-core", "index.d.ts");
    const detailsEntryPath = path.join(fixture.outputRoot, "generated", "allow", "duration-details", "index.d.ts");
    const coreSupportFiles = readSupportReferences(coreEntryPath);
    const detailsSupportFiles = readSupportReferences(detailsEntryPath);
    const sharedSupportFiles = coreSupportFiles.filter(fileName => detailsSupportFiles.includes(fileName));
    assert.ok(sharedSupportFiles.length > 0);
    assert.ok(sharedSupportFiles.every(fileName => /^shared-[0-9a-f]{16}\.d\.ts$/.test(fileName)));

    const cases = [
        {
            name: "core",
            entries: [coreEntryPath],
            source: [
                "const formatter = new Intl.DurationFormat(\"en\");",
                "formatter.format({ seconds: 1 });",
                "",
            ].join("\n"),
        },
        {
            name: "details",
            entries: [detailsEntryPath],
            source: [
                "declare const formatter: Intl.DurationFormat;",
                "formatter.formatToParts({ seconds: 1 });",
                "formatter.resolvedOptions();",
                "",
            ].join("\n"),
        },
        {
            name: "combined",
            entries: [coreEntryPath, detailsEntryPath],
            source: [
                "const formatter = new Intl.DurationFormat(\"en\");",
                "formatter.format({ seconds: 1 });",
                "formatter.formatToParts({ seconds: 1 });",
                "formatter.resolvedOptions();",
                "",
            ].join("\n"),
        },
    ];
    for (const compilerCase of cases) {
        const configPath = writeDirectConsumerConfig({
            directory: tempDirectory,
            name: compilerCase.name,
            source: compilerCase.source,
            declarationFiles: [fixture.topLevelOutputPath, ...compilerCase.entries],
        });
        runTsc(["-p", configPath], { cwd: tempDirectory });
        runTscStrada(["-p", configPath], { cwd: tempDirectory });
    }

    const coreIsolationConfig = writeDirectConsumerConfig({
        directory: tempDirectory,
        name: "core-isolation",
        source: [
            "const formatter = new Intl.DurationFormat(\"en\");",
            "formatter.formatToParts({ seconds: 1 });",
            "",
        ].join("\n"),
        declarationFiles: [fixture.topLevelOutputPath, coreEntryPath],
    });
    assert.match(runTscExpectFailure(["-p", coreIsolationConfig], { cwd: tempDirectory }).output, /formatToParts/);
    assert.match(runTscStradaExpectFailure(["-p", coreIsolationConfig], { cwd: tempDirectory }).output, /formatToParts/);

    const detailsIsolationConfig = writeDirectConsumerConfig({
        directory: tempDirectory,
        name: "details-isolation",
        source: "new Intl.DurationFormat(\"en\");\n",
        declarationFiles: [fixture.topLevelOutputPath, detailsEntryPath],
    });
    assert.match(runTscExpectFailure(["-p", detailsIsolationConfig], { cwd: tempDirectory }).output, /DurationFormat/);
    assert.match(runTscStradaExpectFailure(["-p", detailsIsolationConfig], { cwd: tempDirectory }).output, /DurationFormat/);
});

test("non-mergeable declaration containers cannot span allow entries", () => {
    const tempDirectory = createTempDirectory(tempDirectories);
    const allowlistRegistryPath = path.join(tempDirectory, "allowlist.json");
    writeJsonFile(allowlistRegistryPath, {
        schemaVersion: 1,
        entries: [
            {
                entryName: "duration-core",
                compatKeys: [
                    "javascript.builtins.Intl.DurationFormat",
                    "javascript.builtins.Intl.DurationFormat.DurationFormat",
                    "javascript.builtins.Intl.DurationFormat.format",
                ],
            },
            {
                entryName: "duration-details",
                compatKeys: [
                    "javascript.builtins.Intl.DurationFormat.formatToParts",
                    "javascript.builtins.Intl.DurationFormat.resolvedOptions",
                    "javascript.builtins.Intl.DurationFormat.supportedLocalesOf",
                ],
            },
        ],
    });
    const fixture = createManifest(tempDirectory, { allowlistRegistryPath });

    const failure = runGenerateExpectFailure(fixture.manifestPath);
    assert.match(
        failure,
        /Non-mergeable declaration container Intl\.DurationFormat cannot span generated surfaces: duration-core, duration-details/,
    );
});

test("partial Baseline promotion cannot split a non-mergeable container from its allow entry", () => {
    const tempDirectory = createTempDirectory(tempDirectories);
    const datasetPath = path.join(tempDirectory, "dataset.json");
    const allowlistRegistryPath = path.join(tempDirectory, "allowlist.json");
    const dataset = readJsonFile(repoDatasetPath);
    const promotedCompatKeys = new Set([
        "javascript.builtins.Intl.DurationFormat",
        "javascript.builtins.Intl.DurationFormat.DurationFormat",
        "javascript.builtins.Intl.DurationFormat.format",
    ]);
    for (const row of dataset.compatRows) {
        if (promotedCompatKeys.has(row.compatKey)) {
            row.baselineStatus = "high";
        }
    }
    writeJsonFile(datasetPath, dataset);
    const durationFormatCompatKeys = [
        "javascript.builtins.Intl.DurationFormat",
        "javascript.builtins.Intl.DurationFormat.DurationFormat",
        "javascript.builtins.Intl.DurationFormat.format",
        "javascript.builtins.Intl.DurationFormat.formatToParts",
        "javascript.builtins.Intl.DurationFormat.resolvedOptions",
        "javascript.builtins.Intl.DurationFormat.supportedLocalesOf",
    ];

    for (const entryName of ["intl-duration-format", "baseline"]) {
        writeJsonFile(allowlistRegistryPath, {
            schemaVersion: 1,
            entries: [{ entryName, compatKeys: durationFormatCompatKeys }],
        });
        const fixture = createManifest(tempDirectory, { datasetPath, allowlistRegistryPath });
        const failure = runGenerateExpectFailure(fixture.manifestPath);
        const expectedSurfaces = entryName === "baseline"
            ? "baseline, baseline"
            : "baseline, intl-duration-format";
        assert.match(
            failure,
            new RegExp(
                `Non-mergeable declaration container Intl\\.DurationFormat `
                    + `cannot span generated surfaces: ${expectedSurfaces}`,
            ),
        );
    }
});

test("a registered path becomes a permanent baseline alias after promotion", () => {
    const tempDirectory = createTempDirectory(tempDirectories);
    const datasetPath = path.join(tempDirectory, "dataset.json");
    const allowlistRegistryPath = path.join(tempDirectory, "allowlist.json");
    const dataset = readJsonFile(repoDatasetPath);
    const compatKey = "javascript.builtins.Promise.withResolvers";
    writeJsonFile(datasetPath, dataset);
    writeJsonFile(allowlistRegistryPath, {
        schemaVersion: 1,
        entries: [{ entryName: "promise-withresolvers", compatKeys: [compatKey] }],
    });
    const fixture = createManifest(tempDirectory, { datasetPath, allowlistRegistryPath });

    runGenerate(fixture.manifestPath);
    const activeGeneration = readJsonFile(fixture.generationOutputPath);
    assert.equal(activeGeneration.allowEntries[0].kind, "active");
    assert.ok(activeGeneration.allowEntries[0].unitIds.length);

    const compatRow = dataset.compatRows.find(
        /** @param {{ compatKey: string; }} row */
        row => row.compatKey === compatKey,
    );
    assert.ok(compatRow);
    compatRow.baselineStatus = "high";
    writeJsonFile(datasetPath, dataset);
    runGenerate(fixture.manifestPath);

    const promotedGeneration = readJsonFile(fixture.generationOutputPath);
    assert.deepEqual(promotedGeneration.allowEntries[0], {
        kind: "alias",
        entryName: "promise-withresolvers",
        outputPath: path.join(fixture.outputRoot, "generated", "allow", "promise-withresolvers", "index.d.ts"),
        compatKeys: [compatKey],
        unitIds: [],
        supportUnitIds: [],
    });
    assert.equal(
        fs.readFileSync(path.join(fixture.outputRoot, "generated", "allow", "promise-withresolvers", "index.d.ts"), "utf8"),
        "/// <reference path=\"../../baseline.d.ts\" />\n",
    );

    const consumerDirectory = path.join(tempDirectory, "promoted-consumer");
    const aliasPath = path.join(fixture.outputRoot, "generated", "allow", "promise-withresolvers", "index.d.ts");
    writeTextFile(path.join(consumerDirectory, "pass.ts"), "Promise.withResolvers<number>();\n");
    writeJsonFile(path.join(consumerDirectory, "tsconfig.pass.json"), {
        compilerOptions: { noLib: true, strict: true },
        files: ["pass.ts", aliasPath],
    });
    runTsc(["-p", path.join(consumerDirectory, "tsconfig.pass.json")], { cwd: consumerDirectory });
    runTscStrada(["-p", path.join(consumerDirectory, "tsconfig.pass.json")], { cwd: consumerDirectory });

    writeTextFile(path.join(consumerDirectory, "fail.ts"), "Array.fromAsync([1, 2, 3]);\n");
    writeJsonFile(path.join(consumerDirectory, "tsconfig.fail.json"), {
        compilerOptions: { noLib: true, strict: true },
        files: ["fail.ts", aliasPath],
    });
    assertCompilerFailuresContain(consumerDirectory, "fail", /fromAsync/);
});

test("shared declaration units cannot unlock unregistered or Limited availability behavior", () => {
    const tempDirectory = createTempDirectory(tempDirectories);
    const allowlistRegistryPath = path.join(tempDirectory, "allowlist.json");
    writeJsonFile(allowlistRegistryPath, {
        schemaVersion: 1,
        entries: [{
            entryName: "weakmap",
            compatKeys: ["javascript.builtins.WeakMap.symbol_as_keys"],
        }],
    });
    const fixture = createManifest(tempDirectory, { allowlistRegistryPath });

    const failure = runGenerateExpectFailure(fixture.manifestPath);
    assert.match(failure, /cannot safely emit shared unit/);
});

test("every compat key in an active entry must emit declaration surface", () => {
    const tempDirectory = createTempDirectory(tempDirectories);
    const datasetPath = path.join(tempDirectory, "dataset.json");
    const allowlistRegistryPath = path.join(tempDirectory, "allowlist.json");
    const dataset = readJsonFile(repoDatasetPath);
    const behavioralCompatKey = "javascript.builtins.AggregateError.serializable_object";
    const behavioralRow = dataset.compatRows.find(
        /** @param {{ compatKey: string; }} row */
        row => row.compatKey === behavioralCompatKey,
    );
    assert.ok(behavioralRow);
    behavioralRow.baselineStatus = "low";
    delete behavioralRow.baselineHighDate;
    writeJsonFile(datasetPath, dataset);
    writeJsonFile(allowlistRegistryPath, {
        schemaVersion: 1,
        entries: [{
            entryName: "mixed-entry",
            compatKeys: [
                behavioralCompatKey,
                "javascript.builtins.Promise.withResolvers",
            ],
        }],
    });
    const fixture = createManifest(tempDirectory, { datasetPath, allowlistRegistryPath });

    const failure = runGenerateExpectFailure(fixture.manifestPath);
    assert.match(failure, /cannot emit .* \(behavioral\)/);
});

test("an alias requires declaration-backed surface in the baseline artifact", () => {
    const tempDirectory = createTempDirectory(tempDirectories);
    const allowlistRegistryPath = path.join(tempDirectory, "allowlist.json");
    writeJsonFile(allowlistRegistryPath, {
        schemaVersion: 1,
        entries: [{
            entryName: "intl-pluralrules-selectrange",
            compatKeys: ["javascript.builtins.Intl.PluralRules.selectRange"],
        }],
    });
    const fixture = createManifest(tempDirectory, { allowlistRegistryPath });

    const failure = runGenerateExpectFailure(fixture.manifestPath);
    assert.match(failure, /baseline artifact does not emit its declaration surface/);
});

test("allowlist registry assigns each compat key to one permanent entry", async () => {
    const tempDirectory = createTempDirectory(tempDirectories);
    const allowlistRegistryPath = path.join(tempDirectory, "allowlist.json");
    writeJsonFile(allowlistRegistryPath, {
        schemaVersion: 1,
        entries: [
            { entryName: "first", compatKeys: ["javascript.builtins.Promise.withResolvers"] },
            { entryName: "second", compatKeys: ["javascript.builtins.Promise.withResolvers"] },
        ],
    });

    await assert.rejects(
        loadAllowlistRegistry(allowlistRegistryPath),
        /Allowlist compat key is assigned to multiple entries/,
    );
});

test("release planning preserves published paths and exact compat contracts", () => {
    assert.doesNotThrow(() => assertNoRemovedAllowEntries([
        "reports/generation.json",
        "allow/_support/deadbeef.d.ts",
    ]));
    assert.throws(
        () => assertNoRemovedAllowEntries(["allow/promise-withresolvers/index.d.ts"]),
        /Published allow entry paths cannot be removed/,
    );

    const published = JSON.stringify({
        allowEntries: [{
            entryName: "promise-withresolvers",
            compatKeys: ["javascript.builtins.Promise.withResolvers"],
        }],
    });
    const unchanged = JSON.stringify({
        allowEntries: [{
            kind: "alias",
            entryName: "promise-withresolvers",
            compatKeys: ["javascript.builtins.Promise.withResolvers"],
        }],
    });
    assert.doesNotThrow(() => assertAllowEntryContractsPreserved(published, unchanged));
    assert.throws(
        () => assertAllowEntryContractsPreserved(published, JSON.stringify({
            allowEntries: [{
                entryName: "promise-withresolvers",
                compatKeys: [
                    "javascript.builtins.Promise.withResolvers",
                    "javascript.builtins.RegExp.escape",
                ],
            }],
        })),
        /Published allow entry contract changed/,
    );
    assert.throws(
        () => assertAllowEntryContractsPreserved(published, JSON.stringify({ allowEntries: [] })),
        /Published allow entry contract changed/,
    );
});

/**
 * @param {string} consumerDirectory
 * @param {string} name
 * @param {string[]} types
 */
function writeConsumerConfig(consumerDirectory, name, types) {
    writeJsonFile(path.join(consumerDirectory, `tsconfig.${name}.json`), {
        compilerOptions: {
            noLib: true,
            strict: true,
            types,
        },
        files: [`${name}.ts`],
    });
}

/**
 * @param {string} consumerDirectory
 * @param {string} name
 * @param {RegExp} expectedError
 */
function assertCompilerFailuresContain(consumerDirectory, name, expectedError) {
    const configPath = path.join(consumerDirectory, `tsconfig.${name}.json`);
    for (const failure of [
        runTscExpectFailure(["-p", configPath], { cwd: consumerDirectory }),
        runTscStradaExpectFailure(["-p", configPath], { cwd: consumerDirectory }),
    ]) {
        assert.match(failure.output, expectedError);
    }
}

/**
 * @param {string} entryPath
 */
function readSupportReferences(entryPath) {
    return [...fs.readFileSync(entryPath, "utf8").matchAll(
        /^\/\/\/ <reference path="\.\.\/_support\/([^"]+)" \/>$/gm,
    )].map(match => match[1]);
}

/**
 * @param {{ directory: string; name: string; source: string; declarationFiles: string[]; }} options
 */
function writeDirectConsumerConfig(options) {
    const sourcePath = path.join(options.directory, `${options.name}.ts`);
    const configPath = path.join(options.directory, `tsconfig.${options.name}.json`);
    writeTextFile(sourcePath, options.source);
    writeJsonFile(configPath, {
        compilerOptions: { noLib: true, strict: true },
        files: [sourcePath, ...options.declarationFiles],
    });
    return configPath;
}

/**
 * @param {string} directory
 */
function readDirectorySnapshot(directory) {
    return fs.readdirSync(directory, { recursive: true, withFileTypes: true })
        .filter(entry => entry.isFile())
        .map(entry => path.join(entry.parentPath, entry.name))
        .sort()
        .map(filePath => ({
            path: path.relative(directory, filePath),
            contents: fs.readFileSync(filePath, "base64"),
        }));
}
