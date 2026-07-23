// @ts-check

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
    assertExplicitVersionIncrease,
    assertTypeScriptPeerRange,
    countIncludedCompatRows,
    getDeclarationContractImpact,
} from "../deploy/package-lib.mjs";
import { resolveInstalledPackageRoot } from "../lib/installed-package.mjs";
import {
    cleanupTempDirectories,
    readJsonFile,
    repoClassificationPath,
    repoManifest,
    repoRoot,
    stageBaselinePackage,
} from "./helpers.mjs";

/** @type {string[]} */
const tempDirectories = [];

test.afterEach(() => {
    cleanupTempDirectories(tempDirectories);
});

test("package metadata stages deterministically with the TypeScript peer contract and snapshot facts", async () => {
    const firstStage = await stageBaselinePackage({ tempDirectories });
    const secondStage = await stageBaselinePackage({ tempDirectories });

    const packageJson = readJsonFile(path.join(firstStage.stageDirectory, "package.json"));
    assert.deepEqual(packageJson.peerDependencies, {
        typescript: ">=6 <8",
    });
    assert.deepEqual(packageJson.peerDependenciesMeta, {
        typescript: {
            optional: true,
        },
    });
    assert.equal(packageJson.exports, undefined);
    assert.ok(packageJson.files.includes("snapshot.json"));

    /** @type {{ summary: { includedCompatCount: number; }; classifiedCompatRows: Array<{ includeInTarget: boolean; resolutionKind: string; }>; }} */
    const classification = readJsonFile(repoClassificationPath);
    const includedCompatCount = countIncludedCompatRows(classification.classifiedCompatRows);
    assert.ok(includedCompatCount < classification.summary.includedCompatCount);
    const expectedSnapshot = {
        schemaVersion: 1,
        baselineDate: repoManifest.snapshot.baselineDate,
        webFeaturesPackageVersion: repoManifest.snapshot.webFeaturesPackageVersion,
        webFeaturesGitHead: repoManifest.snapshot.webFeaturesGitHead,
        typescriptVersion: repoManifest.snapshot.typescriptVersion,
        includedCompatCount,
        generatorVersion: repoManifest.snapshot.generatorVersion,
    };
    assert.deepEqual(
        readJsonFile(path.join(firstStage.stageDirectory, "snapshot.json")),
        expectedSnapshot,
    );

    const readme = fs.readFileSync(path.join(firstStage.stageDirectory, "README.md"), "utf8");
    assert.match(readme, /Supported TypeScript versions: `>=6 <8`/);
    assert.ok(readme.includes(`Baseline date: \`${expectedSnapshot.baselineDate}\``));
    assert.ok(readme.includes(`Included compat rows: \`${expectedSnapshot.includedCompatCount}\``));
    assert.doesNotMatch(readme, /{{[A-Z_]+}}/);

    assert.deepEqual(
        readPackageContents(firstStage.stageDirectory),
        readPackageContents(secondStage.stageDirectory),
    );
});

test("included compat count accepts only declaration-backed resolution kinds", () => {
    assert.equal(countIncludedCompatRows([
        { includeInTarget: true, resolutionKind: "member" },
        { includeInTarget: true, resolutionKind: "inherited-member" },
        { includeInTarget: true, resolutionKind: "behavioral" },
        { includeInTarget: true, resolutionKind: "not-modeled-upstream" },
        { includeInTarget: false, resolutionKind: "member" },
    ]), 2);
    assert.throws(
        () => countIncludedCompatRows([{ includeInTarget: true, resolutionKind: "future-kind" }]),
        /Unknown compat resolution kind: future-kind/,
    );
    assert.throws(
        () => countIncludedCompatRows([{ includeInTarget: false, resolutionKind: "future-kind" }]),
        /Unknown compat resolution kind: future-kind/,
    );
});

test("TypeScript peer range contains every pinned compiler line", () => {
    assert.doesNotThrow(() => assertTypeScriptPeerRange(">=6 <8", ["6.0.3", "7.0.2"]));
    assert.throws(
        () => assertTypeScriptPeerRange(">=6 <8", ["6.0.3", "8.0.0"]),
        /TypeScript 8\.0\.0 is outside peer range >=6 <8/,
    );
    assert.throws(
        () => assertTypeScriptPeerRange("latest", ["7.0.2"]),
        /Unsupported TypeScript peer range: latest/,
    );
    assert.throws(
        () => assertTypeScriptPeerRange(">=6 <8", ["7.0.0-beta"]),
        /Unsupported TypeScript version: 7\.0\.0-beta/,
    );
    assert.throws(
        () => assertTypeScriptPeerRange(">=6 <8", []),
        /No TypeScript versions were provided/,
    );
    for (const range of [">=06 <8", ">=8 <8", undefined]) {
        assert.throws(
            () => assertTypeScriptPeerRange(/** @type {any} */ (range), ["7.0.2"]),
            /Unsupported TypeScript peer range/,
        );
    }
    assert.throws(
        () => assertTypeScriptPeerRange(">=6 <8", ["07.0.2"]),
        /Unsupported TypeScript version: 07\.0\.2/,
    );
});

test("package declaration snapshots require reviewed semantic versions", () => {
    const packageJson = JSON.stringify({
        types: "./index.d.ts",
        typesVersions: { "*": { "allow/*": ["allow/*/index.d.ts"] } },
    });
    const published = new Map([
        ["package.json", packageJson],
        ["index.d.ts", "/// <reference path=\"./baseline.d.ts\" />\n"],
        ["baseline.d.ts", "interface Stable { value: string; }\n"],
    ]);

    assert.equal(getDeclarationContractImpact(published, new Map(published)), undefined);
    assert.equal(getDeclarationContractImpact(published, new Map([
        ...published,
        ["allow/new/index.d.ts", "interface NewFeature {}\n"],
    ])), "minor");
    assert.equal(getDeclarationContractImpact(published, new Map([
        ...published,
        ["baseline.d.ts", "interface Stable { value: string; }\ninterface Added {}\n"],
    ])), "minor");
    const multilinePublished = new Map([
        ["baseline.d.ts", "interface Stable {\n    value: string;\n}\n"],
    ]);
    assert.equal(getDeclarationContractImpact(multilinePublished, new Map([
        ["baseline.d.ts", "interface Stable {\n    value: string;\n    added(): void;\n}\n"],
    ])), "minor");
    assert.equal(getDeclarationContractImpact(published, new Map([
        ...published,
        ["baseline.d.ts", "export {};\ninterface Stable { value: string; }\n"],
    ])), "major");
    assert.equal(getDeclarationContractImpact(published, new Map([
        ...published,
        ["baseline.d.ts", "declare namespace Wrapped {\ninterface Stable { value: string; }\n}\n"],
    ])), "major");
    const nestedPublished = new Map([
        ["baseline.d.ts", "declare namespace Outer {\ninterface Stable { value: string; }\n}\n"],
    ]);
    assert.equal(getDeclarationContractImpact(nestedPublished, new Map([
        ["baseline.d.ts", "declare namespace Outer {\nnamespace Nested {\ninterface Stable { value: string; }\n}\n}\n"],
    ])), "major");
    const typeAliasPublished = new Map([
        ["baseline.d.ts", "type Stable =\n    | string;\n"],
    ]);
    assert.equal(getDeclarationContractImpact(typeAliasPublished, new Map([
        ["baseline.d.ts", "type Stable =\n    & number\n    | string;\n"],
    ])), "major");
    assert.equal(getDeclarationContractImpact(published, new Map([
        ...published,
        ["baseline.d.ts", "interface Stable { value: number; }\n"],
    ])), "major");
    assert.equal(getDeclarationContractImpact(published, new Map(
        [...published].filter(([relativePath]) => relativePath !== "baseline.d.ts"),
    )), "major");
    assert.equal(getDeclarationContractImpact(published, new Map([
        ...published,
        ["package.json", JSON.stringify({ types: "./other.d.ts" })],
    ])), "major");
    assert.throws(
        () => assertExplicitVersionIncrease("0.0.1", "0.1.0-rc.0"),
        /must be stable/u,
    );
});

test("manifest compiler versions match the installed toolchains", () => {
    const installedTypeScript = readJsonFile(path.join(resolveInstalledPackageRoot(repoRoot, "typescript"), "package.json"));
    const installedStrada = readJsonFile(path.join(resolveInstalledPackageRoot(repoRoot, "typescript-strada"), "package.json"));
    assert.equal(repoManifest.snapshot.typescriptVersion, installedTypeScript.version);
    assert.equal(repoManifest.snapshot.typescriptStradaVersion, installedStrada.version);
});

/**
 * @param {string} packageDirectory
 */
function readPackageContents(packageDirectory) {
    /** @type {Record<string, Buffer>} */
    const contents = {};

    /**
     * @param {string} currentDirectory
     * @param {string} relativeDirectory
     */
    function visit(currentDirectory, relativeDirectory) {
        const entries = fs.readdirSync(currentDirectory, { withFileTypes: true })
            .sort((left, right) => left.name.localeCompare(right.name));
        for (const entry of entries) {
            const relativePath = relativeDirectory ? path.join(relativeDirectory, entry.name) : entry.name;
            const fullPath = path.join(currentDirectory, entry.name);
            if (entry.isDirectory()) {
                visit(fullPath, relativePath);
            }
            else {
                contents[relativePath.split(path.sep).join(path.posix.sep)] = fs.readFileSync(fullPath);
            }
        }
    }

    visit(packageDirectory, "");
    return contents;
}
