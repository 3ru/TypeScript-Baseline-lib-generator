// @ts-check

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { generateTypeScriptProposalLib } from "../lib/typescript-proposal.mjs";
import { typescriptLibSourceDirectory } from "../lib/typescript-upstream.mjs";
import { verifyLibSource } from "../lib/toolchain-libs.mjs";
import {
    cleanupTempDirectories,
    createTempDirectory,
    repoGeneratedLibPath,
    repoManifest,
    repoManifestPath,
    repoRoot,
} from "./helpers.mjs";

/** @type {string[]} */
const tempDirectories = [];

test.afterEach(() => {
    cleanupTempDirectories(tempDirectories);
});

test("proposal generation follows the pinned TypeScript checkout declaration corpus", async () => {
    const tempDirectory = createTempDirectory(tempDirectories);
    const typescriptDir = path.join(tempDirectory, "TypeScript");
    const targetLibDirectory = path.join(typescriptDir, typescriptLibSourceDirectory);
    const proposalRepoRoot = path.join(tempDirectory, "repo");
    const externalDirectory = path.join(tempDirectory, "external");
    const sentinelPath = path.join(externalDirectory, "libs", "sentinel.txt");
    const packageLibSource = await verifyLibSource({ repoRoot, manifest: repoManifest });

    fs.cpSync(packageLibSource.libDirectory, targetLibDirectory, { recursive: true });
    addUpstreamJsonDeclarations(targetLibDirectory);
    removePluralRulesCallSignature(path.join(targetLibDirectory, "lib.es2018.intl.d.ts"));
    removePluralRulesCallSignature(path.join(targetLibDirectory, "lib.es2020.intl.d.ts"));
    fs.mkdirSync(path.dirname(sentinelPath), { recursive: true });
    fs.writeFileSync(sentinelPath, "keep\n");
    fs.mkdirSync(path.join(proposalRepoRoot, ".tmp"), { recursive: true });
    fs.symlinkSync(externalDirectory, path.join(proposalRepoRoot, ".tmp", "typescript-proposal"));

    const proposals = await Promise.all([
        generateTypeScriptProposalLib({ repoRoot: proposalRepoRoot, manifestPath: repoManifestPath, manifest: repoManifest, typescriptDir }),
        generateTypeScriptProposalLib({ repoRoot: proposalRepoRoot, manifestPath: repoManifestPath, manifest: repoManifest, typescriptDir }),
    ]);
    try {
        const packageOutput = fs.readFileSync(repoGeneratedLibPath, "utf8");
        const proposalOutputs = proposals.map(proposal => fs.readFileSync(proposal.outputPath, "utf8"));

        assert.match(packageOutput, /\(locales\?: LocalesArgument, options\?: PluralRulesOptions\): PluralRules;/u);
        assert.equal(proposalOutputs[0], proposalOutputs[1]);
        assert.doesNotMatch(proposalOutputs[0], /\n\s*\(locales\?: [^\n]+PluralRulesOptions\): PluralRules;/u);
        assert.match(proposalOutputs[0], /new \(locales\?: LocalesArgument, options\?: PluralRulesOptions\): PluralRules;/u);
        assert.equal(fs.readFileSync(sentinelPath, "utf8"), "keep\n");
        assert.doesNotMatch(proposalOutputs[0], /rawJSON\(text|isRawJSON\(value|context: \{ source/u);
        const yearOutput = fs.readFileSync(path.join(path.dirname(proposals[0].outputPath), "year", "2025", "index.d.ts"), "utf8");
        assert.match(yearOutput, /#isRawJson: unknown/u);
        assert.match(yearOutput, /rawJSON\(text: string\): RawJSON/u);
        assert.match(yearOutput, /context: \{ source\?: string \}/u);
    }
    finally {
        for (const proposal of proposals) {
            proposal.cleanup();
        }
    }
});

test("pinned proposal generation reads commit blobs instead of hidden working-tree changes", async () => {
    const tempDirectory = createTempDirectory(tempDirectories);
    const typescriptDir = path.join(tempDirectory, "TypeScript");
    const targetLibDirectory = path.join(typescriptDir, typescriptLibSourceDirectory);
    const packageLibSource = await verifyLibSource({ repoRoot, manifest: repoManifest });

    fs.cpSync(packageLibSource.libDirectory, targetLibDirectory, { recursive: true });
    addUpstreamJsonDeclarations(targetLibDirectory);
    execFileSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: typescriptDir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: typescriptDir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: typescriptDir });
    execFileSync("git", ["add", "."], { cwd: typescriptDir });
    execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: typescriptDir });
    const expectedCommit = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: typescriptDir,
        encoding: "utf8",
    }).trim();
    const trackedRelativePath = "tsc/internal/bundled/libs/lib.es2018.intl.d.ts";
    const trackedPath = path.join(typescriptDir, trackedRelativePath);
    fs.writeFileSync(
        trackedPath,
        fs.readFileSync(trackedPath, "utf8").replace(
            "select(n: number): LDMLPluralRule;",
            'select(n: "REPLACEMENT"): LDMLPluralRule;',
        ),
    );
    execFileSync("git", ["add", trackedRelativePath], { cwd: typescriptDir });
    execFileSync("git", ["commit", "--quiet", "-m", "replacement"], { cwd: typescriptDir });
    const replacementCommit = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: typescriptDir,
        encoding: "utf8",
    }).trim();
    execFileSync("git", ["reset", "--hard", expectedCommit], { cwd: typescriptDir });
    execFileSync("git", ["replace", expectedCommit, replacementCommit], { cwd: typescriptDir });
    fs.writeFileSync(
        trackedPath,
        fs.readFileSync(trackedPath, "utf8").replace(
            "select(n: number): LDMLPluralRule;",
            'select(n: "LOCAL"): LDMLPluralRule;',
        ),
    );
    execFileSync("git", ["update-index", "--assume-unchanged", trackedRelativePath], { cwd: typescriptDir });
    fs.writeFileSync(
        path.join(typescriptDir, ".git", "info", "exclude"),
        "tsc/internal/bundled/libs/lib.injected.d.ts\n",
    );
    fs.writeFileSync(
        path.join(targetLibDirectory, "lib.injected.d.ts"),
        "interface Array<T> { injected(): void; }\n",
    );

    const proposal = await generateTypeScriptProposalLib({
        repoRoot,
        manifestPath: repoManifestPath,
        manifest: repoManifest,
        typescriptDir,
        expectedCommit,
    });
    try {
        const output = fs.readFileSync(proposal.outputPath, "utf8");
        assert.doesNotMatch(output, /"LOCAL"|"REPLACEMENT"|injected\(\): void/u);
        assert.match(output, /select\(n: number\): LDMLPluralRule;/u);
    }
    finally {
        proposal.cleanup();
    }
});

/**
 * @param {string} filePath
 */
function removePluralRulesCallSignature(filePath) {
    const source = fs.readFileSync(filePath, "utf8");
    const updated = source.replace(/^\s*\(locales\?: .*PluralRulesOptions\): PluralRules;\r?\n/gmu, "");
    assert.notEqual(updated, source, `expected a PluralRules call signature in ${filePath}`);
    fs.writeFileSync(filePath, updated);
}

/** @param {string} libDirectory */
function addUpstreamJsonDeclarations(libDirectory) {
    fs.writeFileSync(path.join(libDirectory, "lib.es2026.json.d.ts"), [
        "export {};",
        "declare class RawJSONInstance {",
        "    #isRawJson: unknown;",
        "    readonly rawJSON: string;",
        "}",
        "declare global {",
        "    interface RawJSON extends RawJSONInstance {}",
        "    interface JSON {",
        "        parse(text: string, reviver: (this: any, key: string, value: any, context: { source?: string }) => any): any;",
        "        rawJSON(text: string): RawJSON;",
        "        isRawJSON(value: unknown): value is RawJSON;",
        "    }",
        "}",
        "",
    ].join("\n"));
}
