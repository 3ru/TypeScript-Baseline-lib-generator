// @ts-check

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
    readInstalledPackageJson,
    resolveInstalledPackageRoot,
} from "./installed-package.mjs";

// TypeScript 7 ships declarations in platform packages; the hash pins their shared content.

/** @param {{ libSource?: unknown; }} manifest */
export function readLibSourceConfig(manifest) {
    const libSource = manifest.libSource;

    if (!libSource || typeof libSource !== "object" || Array.isArray(libSource)) {
        throw new Error("Manifest is missing libSource (TypeScript 7 toolchain requires an explicit lib source pin)");
    }

    if (!("basePackage" in libSource) || typeof libSource.basePackage !== "string" || !libSource.basePackage) {
        throw new Error("Manifest is missing libSource.basePackage");
    }

    if (!("platformPackagePrefix" in libSource) || typeof libSource.platformPackagePrefix !== "string" || !libSource.platformPackagePrefix) {
        throw new Error("Manifest is missing libSource.platformPackagePrefix");
    }

    if (!("referencePlatforms" in libSource) || !Array.isArray(libSource.referencePlatforms)) {
        throw new Error("Manifest libSource.referencePlatforms must list at least two distinct platforms");
    }

    const referencePlatforms = libSource.referencePlatforms.map((/** @type {unknown} */ platform) => {
        if (typeof platform !== "string" || !/^[a-z0-9]+-[a-z0-9]+$/u.test(platform)) {
            throw new Error("Manifest libSource.referencePlatforms contains an invalid platform");
        }

        return platform;
    });

    if (referencePlatforms.length < 2 || new Set(referencePlatforms).size !== referencePlatforms.length) {
        throw new Error("Manifest libSource.referencePlatforms must list at least two distinct platforms");
    }

    if (!("libContentHash" in libSource) || typeof libSource.libContentHash !== "string" || !/^sha256-[0-9a-f]{64}$/u.test(libSource.libContentHash)) {
        throw new Error("Manifest is missing a valid libSource.libContentHash (sha256-<hex>)");
    }

    if (!("libFileCount" in libSource) || typeof libSource.libFileCount !== "number" || !Number.isInteger(libSource.libFileCount) || libSource.libFileCount <= 0) {
        throw new Error("Manifest is missing a valid libSource.libFileCount");
    }

    return {
        basePackage: libSource.basePackage,
        platformPackagePrefix: libSource.platformPackagePrefix,
        referencePlatforms,
        libContentHash: libSource.libContentHash,
        libFileCount: libSource.libFileCount,
    };
}

/**
 * Convert process.platform / process.arch to npm's platform package naming
 * (`darwin-arm64`, etc.). Unknown pairs are fail-closed.
 *
 * @param {{ platform?: string; arch?: string; }} [options]
 */
export function resolvePlatformKey(options = {}) {
    const platform = options.platform ?? process.platform;
    const arch = options.arch ?? process.arch;

    return `${platform}-${arch}`;
}

/**
 * Resolve the platform lib package name for this runtime from the installed
 * typescript package. Check it against the actual optionalDependencies list to
 * detect changes in the naming scheme.
 *
 * @param {{
 *   repoRoot: string;
 *   manifest: { libSource?: unknown; };
 *   platformKey?: string;
 * }} options
 */
export async function resolvePlatformLibPackageName(options) {
    const libSource = readLibSourceConfig(options.manifest);
    const basePackageJson = await readInstalledPackageJson(options.repoRoot, libSource.basePackage);
    const optionalDependencies = basePackageJson.optionalDependencies ?? {};
    const platformKey = options.platformKey ?? resolvePlatformKey();
    const expectedName = `${libSource.platformPackagePrefix}${platformKey}`;

    if (!Object.hasOwn(optionalDependencies, expectedName)) {
        const available = Object.keys(optionalDependencies)
            .filter(name => name.startsWith(libSource.platformPackagePrefix))
            .sort();

        throw new Error([
            `Installed ${libSource.basePackage}@${basePackageJson.version} does not declare ${expectedName}.`,
            "The platform lib package naming scheme may have changed upstream.",
            `Declared platform packages:`,
            ...available.map(name => `- ${name}`),
        ].join("\n"));
    }

    return expectedName;
}

/**
 * Read the *.d.ts files in the lib directory in name order and compute an
 * aggregate content hash. The hash is a sha256 over a manifest text of
 * "file name + each file's sha256" (a digest-of-digests). It deliberately
 * doesn't absorb newline variance: it requires byte-for-byte identity.
 *
 * @param {string} libDirectory
 */
export function computeLibDirectoryContentHash(libDirectory) {
    if (!fs.existsSync(libDirectory) || !fs.statSync(libDirectory).isDirectory()) {
        throw new Error(`Lib directory does not exist: ${libDirectory}`);
    }

    const fileNames = fs.readdirSync(libDirectory, { withFileTypes: true })
        .filter(entry => entry.isFile() && entry.name.endsWith(".d.ts"))
        .map(entry => entry.name)
        .sort();

    if (!fileNames.length) {
        throw new Error(`Lib directory contains no .d.ts files: ${libDirectory}`);
    }

    const digestManifestLines = fileNames.map(fileName => {
        const fileHash = createHash("sha256")
            .update(fs.readFileSync(path.join(libDirectory, fileName)))
            .digest("hex");

        return `${fileName}\n${fileHash}`;
    });

    const aggregate = createHash("sha256")
        .update(digestManifestLines.join("\n"))
        .digest("hex");

    return {
        hash: `sha256-${aggregate}`,
        fileCount: fileNames.length,
        fileNames,
    };
}

/**
 * Entry point at generate time. Resolve the locally installed platform lib
 * package, verify its content hash matches the manifest pin, and return the lib
 * directory. Mismatch or absence throws (fail-closed).
 *
 * @param {{
 *   repoRoot: string;
 *   manifest: { libSource?: unknown; };
 * }} options
 */
export async function verifyLibSource(options) {
    const libSource = readLibSourceConfig(options.manifest);
    const platformPackageName = await resolvePlatformLibPackageName(options);
    const platformPackageRoot = resolveInstalledPackageRoot(options.repoRoot, platformPackageName);
    const libDirectory = path.join(platformPackageRoot, "lib");
    const computed = computeLibDirectoryContentHash(libDirectory);

    if (computed.fileCount !== libSource.libFileCount) {
        throw new Error([
            `Installed ${platformPackageName} ships ${computed.fileCount} lib files but the manifest pins ${libSource.libFileCount}.`,
            "Run scripts/update-typescript-toolchain.mjs to refresh the lib source pin.",
        ].join("\n"));
    }

    if (computed.hash !== libSource.libContentHash) {
        throw new Error([
            `Installed ${platformPackageName} lib content hash ${computed.hash} does not match the manifest pin ${libSource.libContentHash}.`,
            "Either the installed toolchain drifted from the manifest, or the platform package differs from the reference platforms.",
            "Run scripts/update-typescript-toolchain.mjs to refresh the lib source pin.",
        ].join("\n"));
    }

    return {
        platformPackageName,
        libDirectory,
        libContentHash: computed.hash,
        libFileCount: computed.fileCount,
    };
}
