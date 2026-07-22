// @ts-check

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
    assertExplicitVersionIncrease,
    assertNoRemovedYearEntryPoints,
    assertYearContractsPreserved,
} from "../deploy/package-lib.mjs";
import { baselinePackageName } from "../deploy/package-registry.mjs";
import { resolveBaselineYears } from "../lib/generator.mjs";
import { REGEXP_LEGACY_STATIC_ABSENCE_ASSERTION } from "../lib/negative-probes.mjs";
import {
    buildUpdateSummary,
    renderUpdateMarkdown,
} from "../scripts/write-update-pr-body.mjs";
import {
    cleanupTempDirectories,
    createBaselinePackageTarball,
    createManifest,
    createTempDirectory,
    readJsonFile,
    repoManifest,
    runGenerate,
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

test("year entrypoints are cumulative, date-bounded, and deterministic", () => {
    const tempDirectory = createTempDirectory(tempDirectories);
    const fixture = createManifest(tempDirectory);
    const expectedYears = resolveBaselineYears(
        repoManifest.snapshot.baselineDate,
        repoManifest.firstClassLib.firstYear,
    );

    runGenerate(fixture.manifestPath);
    const firstSnapshot = readDirectorySnapshot(path.join(fixture.outputRoot, "generated", "year"));
    const report = readJsonFile(fixture.generationOutputPath);
    const classification = readJsonFile(fixture.classificationOutputPath);
    const classifiedRowByKey = new Map(classification.classifiedCompatRows.map(
        /** @param {{ compatKey: string; }} row */
        row => [row.compatKey, row],
    ));

    assert.deepEqual(report.yearEntries.map(
        /** @param {{ year: number; }} entry */
        entry => entry.year,
    ), expectedYears);
    for (let index = 1; index < report.yearEntries.length; index++) {
        assert.ok(
            report.yearEntries[index - 1].selectedUnitCount <= report.yearEntries[index].selectedUnitCount,
            `Baseline ${report.yearEntries[index].year} must not contain fewer selected units than the prior year`,
        );
        assert.ok(
            report.yearEntries[index - 1].includedCompatKeys.every(
                /** @param {string} compatKey */
                compatKey => report.yearEntries[index].includedCompatKeys.includes(compatKey),
            ),
            `Baseline ${report.yearEntries[index].year} must include the prior year's declared compat keys`,
        );
    }
    for (const entry of report.yearEntries) {
        assert.match(entry.contentHash, /^sha256-[0-9a-f]{64}$/);
        const contents = fs.readFileSync(
            path.join(fixture.outputRoot, "generated", "year", String(entry.year), "index.d.ts"),
        );
        assert.equal(entry.contentHash, `sha256-${createHash("sha256").update(contents).digest("hex")}`);
        assert.deepEqual(entry.includedCompatKeys, [...entry.includedCompatKeys].sort());
        assert.deepEqual(entry.notModeledUpstreamCompatKeys, [...entry.notModeledUpstreamCompatKeys].sort());
        for (const compatKey of entry.notModeledUpstreamCompatKeys) {
            assert.ok(
                classifiedRowByKey.get(compatKey)?.management,
                `Baseline ${entry.year} gap ${compatKey} must be explicitly managed`,
            );
        }
    }

    const year2021 = fs.readFileSync(path.join(fixture.outputRoot, "generated", "year", "2021", "index.d.ts"), "utf8");
    const year2022 = fs.readFileSync(path.join(fixture.outputRoot, "generated", "year", "2022", "index.d.ts"), "utf8");
    const year2023 = fs.readFileSync(path.join(fixture.outputRoot, "generated", "year", "2023", "index.d.ts"), "utf8");
    const year2024 = fs.readFileSync(path.join(fixture.outputRoot, "generated", "year", "2024", "index.d.ts"), "utf8");
    const year2025 = fs.readFileSync(path.join(fixture.outputRoot, "generated", "year", "2025", "index.d.ts"), "utf8");
    assert.doesNotMatch(year2021, /\bfindLast\s*\(/);
    assert.match(year2022, /\bfindLast\s*\(/);
    assert.doesNotMatch(year2022, /\btoReversed\s*\(/);
    assert.match(year2023, /\btoReversed\s*\(/);
    assert.doesNotMatch(year2023, /\bunion<U>\s*\(/);
    assert.match(year2024, /\bunion<U>\s*\(/);
    assert.doesNotMatch(year2024, /interface IteratorConstructor extends IteratorObjectConstructor/);
    assert.match(year2025, /interface IteratorConstructor extends IteratorObjectConstructor/);
    assert.doesNotMatch(year2023, /\bwithResolvers\s*</);
    assert.doesNotMatch(year2023, /\bfromAsync\s*</);
    assert.match(year2024, /\bwithResolvers\s*</);
    assert.match(year2024, /\bfromAsync\s*</);

    for (const year of expectedYears) {
        const source = fs.readFileSync(
            path.join(fixture.outputRoot, "generated", "year", String(year), "index.d.ts"),
            "utf8",
        );
        assert.doesNotMatch(source, /\bsubstr\s*\(/);
        assert.doesNotMatch(source, /^declare function escape\b/m);
    }

    runGenerate(fixture.manifestPath);
    assert.deepEqual(
        readDirectorySnapshot(path.join(fixture.outputRoot, "generated", "year")),
        firstSnapshot,
    );
});

test("packed year entrypoints enforce API boundaries under TypeScript 6 and 7", async () => {
    const tempDirectory = createTempDirectory(tempDirectories);
    const consumerDirectory = path.join(tempDirectory, "consumer");
    const { stageDirectory, tarballPath } = await createBaselinePackageTarball({ tempDirectories });
    const packageJson = readJsonFile(path.join(stageDirectory, "package.json"));

    assert.equal(packageJson.exports, undefined);
    assert.deepEqual(packageJson.typesVersions["*"]["year/*"], ["year/*/index.d.ts"]);
    assert.ok(packageJson.files.includes("year/"));
    assert.match(fs.readFileSync(path.join(stageDirectory, "NOTICE.txt"), "utf8"), /`year\/`/);

    writeJsonFile(path.join(consumerDirectory, "package.json"), {
        name: "baseline-year-consumer-fixture",
        private: true,
    });
    runNpm(["install", "--no-package-lock", "--no-save", tarballPath], { cwd: consumerDirectory });

    for (const year of resolveBaselineYears(
        repoManifest.snapshot.baselineDate,
        repoManifest.firstClassLib.firstYear,
    )) {
        const name = `standalone-${year}`;
        writeTextFile(
            path.join(consumerDirectory, `${name}.ts`),
            `${REGEXP_LEGACY_STATIC_ABSENCE_ASSERTION}\n`,
        );
        writeConsumerConfig(consumerDirectory, name, [`${baselinePackageName}/year/${year}`]);
        const configPath = path.join(consumerDirectory, `tsconfig.${name}.json`);
        runTsc(["-p", configPath], { cwd: consumerDirectory });
        runTscStrada(["-p", configPath], { cwd: consumerDirectory });
    }

    writeTextFile(path.join(consumerDirectory, "year-2024.ts"), [
        "Promise.withResolvers<number>();",
        "Promise.prototype.then(value => value);",
        "Symbol.prototype.description;",
        "Array.fromAsync([1, 2, 3]);",
        "Object.groupBy([1, 2, 3], value => String(value));",
        "",
    ].join("\n"));
    writeConsumerConfig(consumerDirectory, "year-2024", [`${baselinePackageName}/year/2024`]);
    const passConfig = path.join(consumerDirectory, "tsconfig.year-2024.json");
    runTsc(["-p", passConfig], { cwd: consumerDirectory });
    runTscStrada(["-p", passConfig], { cwd: consumerDirectory });

    writeTextFile(path.join(consumerDirectory, "year-2023.ts"), "Promise.withResolvers<number>();\n");
    writeConsumerConfig(consumerDirectory, "year-2023", [`${baselinePackageName}/year/2023`]);
    assertCompilerFailuresContain(consumerDirectory, "year-2023", /withResolvers/);

    writeTextFile(path.join(consumerDirectory, "year-2022-array.ts"), "[1, 2, 3].findLast(value => value > 1);\n");
    writeConsumerConfig(consumerDirectory, "year-2022-array", [`${baselinePackageName}/year/2022`]);
    runTsc(["-p", path.join(consumerDirectory, "tsconfig.year-2022-array.json")], { cwd: consumerDirectory });
    runTscStrada(["-p", path.join(consumerDirectory, "tsconfig.year-2022-array.json")], { cwd: consumerDirectory });

    writeTextFile(path.join(consumerDirectory, "year-2021-array.ts"), "[1, 2, 3].findLast(value => value > 1);\n");
    writeConsumerConfig(consumerDirectory, "year-2021-array", [`${baselinePackageName}/year/2021`]);
    assertCompilerFailuresContain(consumerDirectory, "year-2021-array", /findLast/);

    writeTextFile(path.join(consumerDirectory, "limited.ts"), "\"legacy\".substr(1);\n");
    writeConsumerConfig(consumerDirectory, "limited", [`${baselinePackageName}/year/2024`]);
    assertCompilerFailuresContain(consumerDirectory, "limited", /substr/);

    writeTextFile(path.join(consumerDirectory, "year-2025.ts"), [
        "Iterator.from([1, 2, 3]).map(value => value * 2).toArray();",
        "",
    ].join("\n"));
    writeConsumerConfig(consumerDirectory, "year-2025", [`${baselinePackageName}/year/2025`]);
    runTsc(["-p", path.join(consumerDirectory, "tsconfig.year-2025.json")], { cwd: consumerDirectory });
    runTscStrada(["-p", path.join(consumerDirectory, "tsconfig.year-2025.json")], { cwd: consumerDirectory });

    writeTextFile(path.join(consumerDirectory, "year-2024-iterator.ts"), "Iterator.from([1, 2, 3]);\n");
    writeConsumerConfig(consumerDirectory, "year-2024-iterator", [`${baselinePackageName}/year/2024`]);
    assertCompilerFailuresContain(consumerDirectory, "year-2024-iterator", /Iterator/);

    writeTextFile(path.join(consumerDirectory, "year-2024-set.ts"), [
        "declare const values: ReadonlySet<number>;",
        "values.union(new Set<number>());",
        "",
    ].join("\n"));
    writeConsumerConfig(consumerDirectory, "year-2024-set", [`${baselinePackageName}/year/2024`]);
    runTsc(["-p", path.join(consumerDirectory, "tsconfig.year-2024-set.json")], { cwd: consumerDirectory });
    runTscStrada(["-p", path.join(consumerDirectory, "tsconfig.year-2024-set.json")], { cwd: consumerDirectory });

    writeTextFile(path.join(consumerDirectory, "year-2023-set.ts"), [
        "declare const values: ReadonlySet<number>;",
        "values.union(new Set<number>());",
        "",
    ].join("\n"));
    writeConsumerConfig(consumerDirectory, "year-2023-set", [`${baselinePackageName}/year/2023`]);
    assertCompilerFailuresContain(consumerDirectory, "year-2023-set", /union/);
});

test("year range and release guards fail closed", () => {
    assert.deepEqual(resolveBaselineYears("2024-12-31", 2020), [2020, 2021, 2022, 2023]);
    assert.throws(() => resolveBaselineYears("2024-02-30", 2020), /Invalid Baseline snapshot date/);
    assert.throws(() => resolveBaselineYears("2024-12-31", 2014), /Invalid first Baseline year/);
    assert.throws(() => resolveBaselineYears("2024-12-31", 2024), /Invalid first Baseline year/);
    assert.doesNotThrow(() => assertNoRemovedYearEntryPoints(["reports/generation.json"]));
    assert.throws(
        () => assertNoRemovedYearEntryPoints(["year/2024/index.d.ts"]),
        /Published Baseline year entrypoints cannot be removed/,
    );
    const contract = {
        yearEntries: [{
            year: 2023,
            contentHash: `sha256-${"a".repeat(64)}`,
            includedCompatKeys: ["javascript.builtins.Array"],
            notModeledUpstreamCompatKeys: [],
        }],
    };
    const addedYearReport = JSON.stringify({ yearEntries: [...contract.yearEntries, {
        year: 2024,
        contentHash: `sha256-${"b".repeat(64)}`,
        includedCompatKeys: ["javascript.builtins.Array", "javascript.builtins.Promise.withResolvers"],
        notModeledUpstreamCompatKeys: [],
    }] });
    assert.throws(
        () => assertYearContractsPreserved(JSON.stringify(contract), addedYearReport),
        /require review.*explicit --version/,
    );
    assert.equal(
        assertYearContractsPreserved(JSON.stringify(contract), addedYearReport, { preview: true }),
        "minor",
    );
    assert.throws(
        () => assertYearContractsPreserved(JSON.stringify(contract), addedYearReport, {
            reviewedVersion: true,
            publishedVersion: "0.0.4",
            stagedVersion: "0.0.5",
        }),
        /require a minor version increase/,
    );
    assert.doesNotThrow(() => assertYearContractsPreserved(JSON.stringify(contract), addedYearReport, {
        reviewedVersion: true,
        publishedVersion: "0.0.4",
        stagedVersion: "0.1.0",
    }));

    const twoChangedYears = JSON.stringify({
        yearEntries: [2022, 2023].map((year, index) => ({
            year,
            contentHash: `sha256-${String(index + 1).repeat(64)}`,
            includedCompatKeys: ["javascript.builtins.Array"],
            notModeledUpstreamCompatKeys: [],
        })),
    });
    const twoExpandedYears = JSON.stringify({
        yearEntries: [2022, 2023].map((year, index) => ({
            year,
            contentHash: `sha256-${String(index + 3).repeat(64)}`,
            includedCompatKeys: ["javascript.builtins.Array", `javascript.builtins.Example${year}`],
            notModeledUpstreamCompatKeys: [],
        })),
    });
    assert.equal(
        assertYearContractsPreserved(twoChangedYears, twoExpandedYears, { preview: true }),
        "minor",
    );

    const changedHashReport = JSON.stringify({
        yearEntries: [{
            ...contract.yearEntries[0],
            contentHash: `sha256-${"c".repeat(64)}`,
        }],
    });
    assert.throws(
        () => assertYearContractsPreserved(JSON.stringify(contract), changedHashReport),
        /require review/,
    );
    assert.throws(() => assertYearContractsPreserved(JSON.stringify(contract), changedHashReport, {
        reviewedVersion: true,
        publishedVersion: "1.2.3",
        stagedVersion: "1.2.4",
    }), /require a major version increase/);
    assert.equal(
        assertYearContractsPreserved(JSON.stringify(contract), changedHashReport, { preview: true }),
        "major",
    );
    assert.doesNotThrow(() => assertYearContractsPreserved(JSON.stringify(contract), changedHashReport, {
        reviewedVersion: true,
        publishedVersion: "1.2.3",
        stagedVersion: "2.0.0",
    }));

    const removedDeclarationReport = JSON.stringify({
        yearEntries: [{
            ...contract.yearEntries[0],
            includedCompatKeys: [],
        }],
    });
    assert.throws(
        () => assertYearContractsPreserved(JSON.stringify(contract), removedDeclarationReport, {
            reviewedVersion: true,
            publishedVersion: "1.2.3",
            stagedVersion: "1.3.0",
        }),
        /require a major version increase/,
    );

    assert.doesNotThrow(() => assertExplicitVersionIncrease(undefined, "0.0.1"));
    assert.doesNotThrow(() => assertExplicitVersionIncrease("1.2.3", "1.2.4"));
    assert.doesNotThrow(() => assertExplicitVersionIncrease("1.2.3-rc.2", "1.2.3-rc.10"));
    assert.throws(
        () => assertExplicitVersionIncrease("1.2.3", "1.2.3"),
        /must be greater than 1\.2\.3/,
    );
    assert.throws(
        () => assertExplicitVersionIncrease("1.2.3", "1.2.2"),
        /must be greater than 1\.2\.3/,
    );
    assert.throws(
        () => assertExplicitVersionIncrease("1.2.3", "1.2.3-rc.1"),
        /must be greater than 1\.2\.3/,
    );
    for (const invalidVersion of [undefined, "not-semver", "01.2.3", "1.2.3-.", "1.2.3-01"]) {
        assert.throws(
            () => assertExplicitVersionIncrease(undefined, invalidVersion),
            /Explicit package version is missing|Unsupported package version format/,
        );
    }
});

test("weekly update summary reports year contract changes and the required bump", () => {
    const previousState = createUpdateState([{
        year: 2024,
        contentHash: `sha256-${"a".repeat(64)}`,
        includedCompatKeys: ["javascript.builtins.Array"],
        notModeledUpstreamCompatKeys: [],
    }]);
    const currentState = createUpdateState([{
        year: 2024,
        contentHash: `sha256-${"b".repeat(64)}`,
        includedCompatKeys: ["javascript.builtins.Array"],
        notModeledUpstreamCompatKeys: [],
    }]);
    const manifest = {
        snapshot: {
            name: "baseline-js",
            baselineDate: "2026-07-07",
            generatorVersion: "0.0.1",
        },
        libSource: {},
        typescriptSource: {},
        typescriptGoSource: {},
    };
    const summary = buildUpdateSummary({
        currentManifest: manifest,
        currentState,
        previousManifest: manifest,
        previousState,
    });

    assert.deepEqual(summary.yearEntries, {
        count: 1,
        changes: ["year/2024 declaration contract changed"],
        requiredVersionBump: "major",
    });
    assert.ok(summary.reviewFlags.some(flag => flag.includes("at least a major package version bump")));
    const markdown = renderUpdateMarkdown(summary);
    assert.match(markdown, /Year contract changes: year\/2024 declaration contract changed/);
    assert.match(markdown, /Required package version bump: major/);
});

/**
 * @param {Array<{ year: number; contentHash: string; includedCompatKeys: string[]; notModeledUpstreamCompatKeys: string[]; }>} yearEntries
 */
function createUpdateState(yearEntries) {
    return {
        classification: {
            summary: {
                highCompatCount: 0,
                lowCompatCount: 0,
                falseCompatCount: 0,
                includedCompatCount: 0,
                notModeledUpstreamCount: 0,
                managedCompatCount: 0,
                alreadyExcludedUpstreamCount: 0,
            },
        },
        generation: {
            summary: {
                classifiedCompatCount: 0,
                selectedUnitCount: 0,
                transformedUnitCount: 0,
            },
            topLevelLib: { outputPath: "generated/current/baseline.d.ts" },
            allowEntries: [],
            yearEntries,
        },
        compatManagement: {
            registry: {
                sourceHash: "sha256-test",
                groupCount: 0,
                managedCompatCount: 0,
            },
            summary: {
                managedCategoryCounts: {},
                managedDeliveryCounts: {},
                managedUpstreamStateCounts: { actionable: 0 },
                managedResolutionKindCounts: {},
            },
        },
    };
}

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
