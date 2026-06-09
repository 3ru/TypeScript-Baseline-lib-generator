// @ts-check

import assert from "node:assert/strict";
import {
    execFileSync,
    spawnSync,
} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPackageStages, createPackageTarball } from "../deploy/package-lib.mjs";
import { resolveInstalledPackageRoot } from "../lib/installed-package.mjs";
import { selectActiveNegativeProbes } from "../lib/negative-probes.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(testDirectory, "..");
export const repoManifestPath = path.join(repoRoot, "manifests", "baseline-js.json");
export const repoManifest = JSON.parse(fs.readFileSync(repoManifestPath, "utf8"));
export const repoDatasetPath = path.join(repoRoot, "datasets", "web-features-js-compat.json");
export const repoRegistryPath = path.join(repoRoot, "registry", "compat-management.json");
export const repoGeneratedLibPath = path.join(repoRoot, "generated", "current", "baseline.d.ts");
export const repoClassificationPath = path.join(repoRoot, "derived", "current", "classification.json");

/**
 * Select the currently active negative probes from the checked-in classification.
 * Shared by the consumer-smoke tests.
 */
export function loadActiveNegativeProbesFromRepo() {
    /** @type {{ classifiedCompatRows: Array<{ compatKey: string; includeInTarget: boolean; }>; }} */
    const classification = readJsonFile(repoClassificationPath);
    return selectActiveNegativeProbes(classification.classifiedCompatRows);
}

/**
 * @param {string[]} tempDirectories
 */
export function createTempDirectory(tempDirectories) {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "ts-baseline-lib-generator-"));
    tempDirectories.push(tempDirectory);
    return tempDirectory;
}

/**
 * @param {string[]} tempDirectories
 */
export function cleanupTempDirectories(tempDirectories) {
    for (const tempDirectory of tempDirectories) {
        fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
    tempDirectories.length = 0;
}

/**
 * @param {string} filePath
 * @param {unknown} value
 */
export function writeJsonFile(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(value, undefined, 4)}\n`);
}

/**
 * @param {string} filePath
 * @param {string} value
 */
export function writeTextFile(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, value);
}

/**
 * @template T
 * @param {string} filePath
 * @returns {T}
 */
export function readJsonFile(filePath) {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

/**
 * @param {string} tempDirectory
 * @param {{ registryPath?: string; datasetPath?: string; generatedOutputPath?: string; }} [options]
 */
export function createManifest(tempDirectory, options = {}) {
    const outputRoot = path.join(tempDirectory, "out");
    const manifestPath = path.join(tempDirectory, "manifest.json");
    const manifestDirectory = path.dirname(manifestPath);
    const manifest = JSON.parse(JSON.stringify(repoManifest));

    manifest.dataset = toPosixRelativePath(manifestDirectory, options.datasetPath ?? repoDatasetPath);
    manifest.compatManagementRegistry = toPosixRelativePath(manifestDirectory, options.registryPath ?? repoRegistryPath);
    manifest.classificationOutput = path.join(outputRoot, "derived", "classification.json");
    manifest.compatManagementOutput = path.join(outputRoot, "derived", "compat-management-report.json");
    manifest.inventoryOutput = path.join(outputRoot, "derived", "inventory.json");
    manifest.generationOutput = path.join(outputRoot, "derived", "generation.json");
    manifest.firstClassLib = {
        libName: "baseline",
        outputFile: path.join(outputRoot, "generated", "baseline.d.ts"),
    };
    if (options.generatedOutputPath) {
        manifest.firstClassLib.outputFile = toPosixRelativePath(manifestDirectory, options.generatedOutputPath);
    }

    writeJsonFile(manifestPath, manifest);

    return {
        manifestPath,
        outputRoot,
        topLevelOutputPath: path.join(outputRoot, "generated", "baseline.d.ts"),
        classificationOutputPath: path.join(outputRoot, "derived", "classification.json"),
        compatManagementOutputPath: path.join(outputRoot, "derived", "compat-management-report.json"),
        inventoryOutputPath: path.join(outputRoot, "derived", "inventory.json"),
        generationOutputPath: path.join(outputRoot, "derived", "generation.json"),
    };
}

/**
 * @param {string} manifestPath
 */
export function runGenerate(manifestPath) {
    return execFileSync(process.execPath, [path.join(repoRoot, "scripts", "generate.mjs"), "--manifest", manifestPath], {
        cwd: repoRoot,
        encoding: "utf8",
    });
}

/**
 * @param {string} manifestPath
 */
export function runGenerateExpectFailure(manifestPath) {
    const result = spawnSync(process.execPath, [path.join(repoRoot, "scripts", "generate.mjs"), "--manifest", manifestPath], {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    });

    if (result.status && result.status !== 0) {
        return `${result.stdout ?? ""}${result.stderr ?? ""}`;
    }

    assert.fail(`Expected generator to fail for ${manifestPath}`);
}

// Compiler runs resolve the in-package bin explicitly instead of node_modules/.bin.
// typescript (7.x, tsgo) and typescript-strada (6.x alias) both expose a tsc bin
// of the same name, and which one the .bin symlink wins is non-deterministic.

/**
 * Run the tsc from TypeScript 7 (tsgo). The primary toolchain.
 *
 * @param {string[]} args
 * @param {{ allowFailure?: boolean; cwd?: string; }} [options]
 */
export function runTsc(args, options = {}) {
    return /** @type {string} */ (runPackageBinary("typescript", "tsc", args, options));
}

/**
 * Run the tsc from the frozen final Strada line (typescript-strada = npm alias:
 * typescript@6.x). Used to verify compat for TS6 consumers.
 *
 * @param {string[]} args
 * @param {{ allowFailure?: boolean; cwd?: string; }} [options]
 */
export function runTscStrada(args, options = {}) {
    return /** @type {string} */ (runPackageBinary("typescript-strada", "tsc", args, options));
}

/**
 * @param {string[]} args
 * @param {{ cwd?: string; }} [options]
 */
export function runTscExpectFailure(args, options = {}) {
    const result = runPackageBinary("typescript", "tsc", args, {
        ...options,
        allowFailure: true,
    });
    if (typeof result === "string") {
        assert.fail(`Expected tsc to fail for ${args.join(" ")}`);
    }
    return result;
}

/**
 * @param {string[]} args
 * @param {{ cwd?: string; }} [options]
 */
export function runTscStradaExpectFailure(args, options = {}) {
    const result = runPackageBinary("typescript-strada", "tsc", args, {
        ...options,
        allowFailure: true,
    });
    if (typeof result === "string") {
        assert.fail(`Expected strada tsc to fail for ${args.join(" ")}`);
    }
    return result;
}

/**
 * @param {string[]} args
 * @param {{ cwd?: string; }} [options]
 */
export function runNpm(args, options = {}) {
    return execFileSync("npm", args, {
        cwd: options.cwd ?? repoRoot,
        encoding: "utf8",
        env: {
            ...process.env,
            npm_config_yes: "true",
        },
    });
}

/**
 * @param {{ versionOverride?: string; tempDirectories?: string[]; }} [options]
 */
export async function stageBaselinePackage(options = {}) {
    const stageDirectoryRoot = createTempDirectory(options.tempDirectories ?? []);
    const [summary] = await createPackageStages({
        packageId: "baseline",
        versionOverride: options.versionOverride ?? "0.0.0-test",
        stageDirectoryRoot,
    });
    assert.ok(summary, "Expected baseline package staging summary");

    return {
        ...summary,
        sourceStageDirectory: summary.stageDirectory,
    };
}

/**
 * @param {{ versionOverride?: string; tempDirectories?: string[]; }} [options]
 */
export async function createBaselinePackageTarball(options = {}) {
    const summary = await stageBaselinePackage(options);
    const tarballPath = await createPackageTarball(summary.stageDirectory);
    return {
        ...summary,
        tarballPath,
    };
}

/**
 * @param {string} packageName
 * @param {string} binName
 * @param {string[]} args
 * @param {{ allowFailure?: boolean; cwd?: string; }} [options]
 * @returns {string | FailedCommandRun}
 */
function runPackageBinary(packageName, binName, args, options = {}) {
    const packageJsonPath = path.join(resolveInstalledPackageRoot(repoRoot, packageName), "package.json");
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    const binRelativePath = typeof packageJson.bin === "string"
        ? packageJson.bin
        : packageJson.bin?.[binName];
    assert.ok(binRelativePath, `Package ${packageName} does not expose a ${binName} binary`);

    const packageRoot = path.dirname(packageJsonPath);
    const executablePath = path.join(packageRoot, binRelativePath);

    try {
        return execFileSync(process.execPath, [executablePath, ...args], {
            cwd: options.cwd ?? repoRoot,
            encoding: "utf8",
            env: {
                ...process.env,
                npm_config_yes: "true",
            },
        });
    }
    catch (error) {
        if (options.allowFailure) {
            const failedError = /** @type {{ stdout?: string; stderr?: string; }} */ (error);
            return {
                ok: false,
                output: `${failedError.stdout ?? ""}${failedError.stderr ?? ""}`,
            };
        }
        throw error;
    }
}

/**
 * @param {string} fromDirectory
 * @param {string} toPath
 */
function toPosixRelativePath(fromDirectory, toPath) {
    return path.relative(fromDirectory, toPath).split(path.sep).join(path.posix.sep);
}

/**
 * @typedef {{
 *   ok: false;
 *   output: string;
 * }} FailedCommandRun
 */
