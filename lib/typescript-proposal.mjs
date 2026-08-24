// @ts-check

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateFirstClassBaselineLib } from "./generator.mjs";
import { computeLibDirectoryContentHash } from "./toolchain-libs.mjs";
import {
    assertTypeScriptSourcePin,
    typescriptGeneratedLibDirectory,
} from "./typescript-upstream.mjs";

/**
 * Generate the proposal artifact from the declaration corpus in the pinned
 * TypeScript checkout rather than from the npm distribution corpus.
 *
 * @param {{
 *   repoRoot: string;
 *   manifestPath: string;
 *   manifest: any;
 *   typescriptDir?: string;
 *   expectedCommit?: string;
 *   allowUnpinned?: boolean;
 * }} options
 */
export async function generateTypeScriptProposalLib(options) {
    const repoRoot = path.resolve(options.repoRoot);
    const typescriptDir = path.resolve(options.typescriptDir ?? path.join(repoRoot, ".tmp", "TypeScript"));
    if (options.expectedCommit && !options.allowUnpinned) {
        assertTypeScriptSourcePin(typescriptDir, options.expectedCommit);
    }

    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "typescript-baseline-proposal-"));
    try {
        const libDirectory = path.join(workspaceRoot, "libs");
        if (options.expectedCommit && !options.allowUnpinned) {
            snapshotDeclarationCorpusFromCommit(typescriptDir, options.expectedCommit, libDirectory);
        }
        else {
            snapshotDeclarationCorpus(
                path.join(typescriptDir, typescriptGeneratedLibDirectory),
                libDirectory,
            );
        }

        const manifest = structuredClone(options.manifest);
        const fingerprint = computeLibDirectoryContentHash(libDirectory);
        manifest.libSource = {
            ...manifest.libSource,
            basePackage: "microsoft/TypeScript",
            libContentHash: fingerprint.hash,
            libFileCount: fingerprint.fileCount,
        };
        manifest.classificationOutput = ".tmp/derived/classification.json";
        manifest.compatManagementOutput = ".tmp/derived/compat-management-report.json";
        manifest.inventoryOutput = ".tmp/derived/inventory.json";
        manifest.generationOutput = ".tmp/derived/generation.json";
        manifest.firstClassLib = {
            ...manifest.firstClassLib,
            outputFile: ".tmp/generated/baseline.d.ts",
            allowDirectory: ".tmp/generated/allow",
            yearDirectory: ".tmp/generated/year",
        };

        const plan = await generateFirstClassBaselineLib({
            repoRoot: workspaceRoot,
            manifestPath: options.manifestPath,
            manifest,
            libDirectory,
            reportPathPrefix: "microsoft/TypeScript/tsc/internal/bundled/libs",
        });
        const verifiedFingerprint = computeLibDirectoryContentHash(libDirectory);
        if (
            verifiedFingerprint.hash !== fingerprint.hash
            || verifiedFingerprint.fileCount !== fingerprint.fileCount
        ) {
            throw new Error("TypeScript declaration corpus changed while generating the proposal");
        }
        return {
            outputPath: plan.topLevelOutputPath,
            cleanup: () => fs.rmSync(workspaceRoot, { recursive: true, force: true }),
        };
    }
    catch (error) {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
        throw error;
    }
}

/**
 * @param {string} typescriptDir
 * @param {string} commit
 * @param {string} destinationDirectory
 */
function snapshotDeclarationCorpusFromCommit(typescriptDir, commit, destinationDirectory) {
    const relativeDirectory = typescriptGeneratedLibDirectory.split(path.sep).join("/");
    const filePaths = execFileSync(
        "git",
        ["--no-replace-objects", "ls-tree", "-r", "--name-only", "-z", commit, "--", relativeDirectory],
        { cwd: typescriptDir, encoding: "utf8" },
    ).split("\0").filter(relativePath => (
        path.posix.dirname(relativePath) === relativeDirectory
        && relativePath.endsWith(".d.ts")
        && path.posix.basename(relativePath) !== "lib.baseline.d.ts"
    )).sort();
    if (!filePaths.length) {
        throw new Error(`Pinned TypeScript commit contains no declaration files under ${relativeDirectory}`);
    }

    fs.mkdirSync(destinationDirectory, { recursive: true });
    for (const relativePath of filePaths) {
        const source = execFileSync("git", ["--no-replace-objects", "show", `${commit}:${relativePath}`], {
            cwd: typescriptDir,
            maxBuffer: 16 * 1024 * 1024,
        });
        fs.writeFileSync(path.join(destinationDirectory, path.posix.basename(relativePath)), source);
    }
}

/**
 * @param {string} sourceDirectory
 * @param {string} destinationDirectory
 */
function snapshotDeclarationCorpus(sourceDirectory, destinationDirectory) {
    if (!fs.existsSync(sourceDirectory) || !fs.statSync(sourceDirectory).isDirectory()) {
        throw new Error(`TypeScript generated lib directory does not exist: ${sourceDirectory}`);
    }

    fs.mkdirSync(destinationDirectory, { recursive: true });
    const fileNames = fs.readdirSync(sourceDirectory, { withFileTypes: true })
        .filter(entry => entry.isFile() && entry.name.endsWith(".d.ts") && entry.name !== "lib.baseline.d.ts")
        .map(entry => entry.name)
        .sort();
    if (!fileNames.length) {
        throw new Error(`TypeScript generated lib directory contains no declaration files: ${sourceDirectory}`);
    }
    for (const fileName of fileNames) {
        fs.copyFileSync(path.join(sourceDirectory, fileName), path.join(destinationDirectory, fileName));
    }
}
