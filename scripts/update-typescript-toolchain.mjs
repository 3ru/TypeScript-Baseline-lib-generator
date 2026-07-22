// @ts-check

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    refreshManifestSnapshot,
    writeManifest,
} from "../lib/manifest-snapshot.mjs";
import { npmViewField } from "../lib/installed-package.mjs";
import { retrySync } from "../lib/net-retry.mjs";
import { computeLibDirectoryContentHash } from "../lib/toolchain-libs.mjs";
import {
    applyStradaSourcePin,
    applyTypeScriptGoSourcePin,
} from "../lib/typescript-source.mjs";
import { assertTypeScriptPeerRange } from "../deploy/package-lib.mjs";
import { baselinePackage } from "../deploy/package-registry.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const scriptDirectory = path.dirname(scriptPath);
const repoRoot = path.resolve(scriptDirectory, "..");
const manifestPath = path.join(repoRoot, "manifests", "baseline-js.json");
const workRoot = path.join(repoRoot, ".tmp", "toolchain-update");

// TypeScript 7 (tsgo) is the primary toolchain. The lib.*.d.ts files ship in
// per-platform packages (@typescript/typescript-<os>-<arch>), so at pin time we
// cross-check tarballs from multiple platforms, record a content hash, and use it
// as the basis for the fail-closed comparison at generate time (lib/toolchain-libs.mjs).
//
// Strada (TypeScript 6) is feature-frozen on the 6.0 line. We keep
// `typescript-strada` (npm alias: typescript@6.x) for three roles:
// 1. The generator's .d.ts parser / self-check compiler API (TS7's JS API is different)
// 2. Compat smoke for TS6-line consumers
// 3. The version anchor for the existing Strada integration gate (hereby + libBaseline)
const libSourcePlatformPackagePrefix = "@typescript/typescript-";
const libSourceReferencePlatforms = ["linux-x64", "darwin-arm64", "win32-x64"];

const args = parseArgs(process.argv.slice(2));

await main();

async function main() {
    const typescriptVersion = args.typescriptVersion
        ?? resolveLatestStableVersion(
            `typescript@${baselinePackage.typescriptPeerDependencyRange}`,
            "supported TypeScript",
        );
    const stradaVersion = args.stradaVersion ?? resolveLatestStradaVersion();

    assertTypeScriptPeerRange(baselinePackage.typescriptPeerDependencyRange, [typescriptVersion]);
    assertTypeScriptPeerRange(">=6 <7", [stradaVersion]);

    execFileSync("npm", [
        "install",
        "--save-exact",
        `typescript@${typescriptVersion}`,
        `typescript-strada@npm:typescript@${stradaVersion}`,
    ], {
        cwd: repoRoot,
        stdio: "inherit",
        env: {
            ...process.env,
            npm_config_yes: "true",
        },
    });

    const libSource = computeCrossPlatformLibSourcePin(typescriptVersion);

    const { manifest } = await refreshManifestSnapshot({
        repoRoot,
        manifestPath,
    });

    manifest.toolchain = {
        typescriptPackage: "typescript",
        typescriptStradaPackage: "typescript-strada",
        webFeaturesPackage: manifest.toolchain?.webFeaturesPackage ?? "web-features",
    };
    manifest.libSource = libSource;

    const stradaSource = applyStradaSourcePin({
        manifest,
        stradaVersion,
    });
    const goSource = applyTypeScriptGoSourcePin({
        manifest,
        typescriptVersion,
        workDirectory: workRoot,
    });

    await writeManifest({
        manifestPath,
        manifest,
    });

    console.log([
        `Pinned TypeScript toolchain:`,
        `- typescript@${typescriptVersion} (tsgo)`,
        `- typescript-strada@npm:typescript@${stradaVersion}`,
        `- lib source: ${libSource.libFileCount} files, ${libSource.libContentHash} (verified across ${libSource.referencePlatforms.join(", ")})`,
        `- Strada source: ${stradaSource.tag} (${stradaSource.commit})`,
        `- typescript-go source: ${goSource.tag} (${goSource.commit}, strada submodule ${goSource.stradaSubmoduleCommit})`,
    ].join("\n"));
}

/**
 * Resolve the final Strada line (latest stable <7) from the registry.
 * Automatically follows any security patch released on 6.0.x.
 */
function resolveLatestStradaVersion() {
    return resolveLatestStableVersion("typescript@<7.0.0-0", "Strada (typescript <7)");
}

/**
 * @param {string} packageSpecifier
 * @param {string} label
 */
function resolveLatestStableVersion(packageSpecifier, label) {
    const versions = npmViewField(repoRoot, packageSpecifier, "version");
    const versionList = Array.isArray(versions) ? versions : [versions];
    const stableVersions = versionList
        .filter(version => typeof version === "string" && /^\d+\.\d+\.\d+$/u.test(version))
        .sort(compareStableSemver);

    const latest = stableVersions.at(-1);
    if (!latest) {
        throw new Error(`Could not resolve the latest stable ${label} version from the registry`);
    }
    return latest;
}

/**
 * @param {string} left
 * @param {string} right
 */
function compareStableSemver(left, right) {
    const leftParts = left.split(".").map(Number);
    const rightParts = right.split(".").map(Number);
    for (let index = 0; index < 3; index++) {
        const difference = leftParts[index] - rightParts[index];
        if (difference) {
            return difference;
        }
    }
    return 0;
}

/**
 * Compute the content hash of lib/*.d.ts from every reference platform's registry
 * tarball, verify they all match exactly, then return the pin.
 * If even one differs, the output could change depending on where you generate, so
 * fail-closed.
 *
 * @param {string} typescriptVersion
 */
function computeCrossPlatformLibSourcePin(typescriptVersion) {
    fs.rmSync(workRoot, { recursive: true, force: true });
    fs.mkdirSync(workRoot, { recursive: true });

    /** @type {Array<{ platformKey: string; hash: string; fileCount: number; }>} */
    const results = [];

    for (const platformKey of libSourceReferencePlatforms) {
        const packageName = `${libSourcePlatformPackagePrefix}${platformKey}`;
        const extractDirectory = path.join(workRoot, `lib-${platformKey}`);
        fs.mkdirSync(extractDirectory, { recursive: true });

        const tarballName = retrySync(`npm pack ${packageName}@${typescriptVersion}`, () => execFileSync("npm", [
            "pack",
            `${packageName}@${typescriptVersion}`,
            "--pack-destination",
            extractDirectory,
            "--silent",
        ], {
            cwd: repoRoot,
            encoding: "utf8",
            env: {
                ...process.env,
                npm_config_yes: "true",
            },
        })).trim().split(/\r?\n/u).at(-1);

        if (!tarballName) {
            throw new Error(`npm pack did not report a tarball name for ${packageName}@${typescriptVersion}`);
        }

        execFileSync("tar", ["-xzf", path.join(extractDirectory, tarballName), "-C", extractDirectory], {
            stdio: "inherit",
        });

        const computed = computeLibDirectoryContentHash(path.join(extractDirectory, "package", "lib"));
        results.push({
            platformKey,
            hash: computed.hash,
            fileCount: computed.fileCount,
        });
        console.log(`Verified ${packageName}@${typescriptVersion}: ${computed.fileCount} lib files, ${computed.hash}`);
    }

    const [first, ...rest] = results;
    for (const other of rest) {
        if (other.hash !== first.hash || other.fileCount !== first.fileCount) {
            const details = results
                .map(result => `- ${result.platformKey}: ${result.fileCount} files, ${result.hash}`)
                .join("\n");
            throw new Error(
                `Platform lib packages for typescript@${typescriptVersion} are not content-identical:\n${details}`,
            );
        }
    }

    fs.rmSync(workRoot, { recursive: true, force: true });

    return {
        basePackage: "typescript",
        platformPackagePrefix: libSourcePlatformPackagePrefix,
        referencePlatforms: [...libSourceReferencePlatforms],
        libContentHash: first.hash,
        libFileCount: first.fileCount,
    };
}

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
    /** @type {{ typescriptVersion?: string; stradaVersion?: string; }} */
    const args = {};

    for (let index = 0; index < argv.length; index++) {
        const current = argv[index];
        switch (current) {
            case "--typescript-version":
                args.typescriptVersion = requireArgValue(argv[++index], current);
                break;
            case "--strada-version":
                args.stradaVersion = requireArgValue(argv[++index], current);
                break;
            case "--help":
            case "-h":
                printUsageAndExit();
                break;
            default:
                throw new Error(`Unknown argument: ${current}`);
        }
    }

    return args;
}

/**
 * @param {string | undefined} value
 * @param {string} flagName
 */
function requireArgValue(value, flagName) {
    if (!value) {
        throw new Error(`Missing value for ${flagName}`);
    }
    return value;
}

function printUsageAndExit() {
    console.log(`Usage:
  node scripts/update-typescript-toolchain.mjs [--typescript-version <version>] [--strada-version <version>]

Examples:
  node scripts/update-typescript-toolchain.mjs
  node scripts/update-typescript-toolchain.mjs --typescript-version 7.0.2
  node scripts/update-typescript-toolchain.mjs --typescript-version 7.0.2 --strada-version 6.0.3
`);
    process.exit(0);
}
