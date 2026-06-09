// @ts-check

import { execFileSync } from "node:child_process";
import {
    existsSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { retrySync } from "./net-retry.mjs";

/**
 * @param {string} repoRoot
 */
function createRepoRequire(repoRoot) {
    return createRequire(path.join(repoRoot, "package.json"));
}

/**
 * @param {string} repoRoot
 * @param {string} packageName
 */
export function resolveInstalledPackageRoot(repoRoot, packageName) {
    const packageJsonFromNodeModules = path.join(repoRoot, "node_modules", ...packageName.split("/"), "package.json");
    if (existsSync(packageJsonFromNodeModules)) {
        return path.dirname(packageJsonFromNodeModules);
    }

    const repoRequire = createRepoRequire(repoRoot);
    const resolvedEntryPath = repoRequire.resolve(packageName);
    let currentDirectory = path.dirname(resolvedEntryPath);

    for (let depth = 0; depth < 5; depth++) {
        const packageJsonPath = path.join(currentDirectory, "package.json");
        if (existsSync(packageJsonPath)) {
            return currentDirectory;
        }
        const parentDirectory = path.dirname(currentDirectory);
        if (parentDirectory === currentDirectory) {
            break;
        }
        currentDirectory = parentDirectory;
    }

    throw new Error(`Could not resolve package root for ${packageName} from ${resolvedEntryPath}`);
}

/**
 * @param {string} repoRoot
 * @param {string} packageName
 * @param {string} packageRelativePath
 */
export function resolveInstalledPackageFile(repoRoot, packageName, packageRelativePath) {
    return path.join(resolveInstalledPackageRoot(repoRoot, packageName), packageRelativePath);
}

/**
 * @param {string} repoRoot
 * @param {string} packageName
 */
export async function readInstalledPackageJson(repoRoot, packageName) {
    return JSON.parse(await readFile(resolveInstalledPackageFile(repoRoot, packageName, "package.json"), "utf8"));
}

/**
 * @param {string} repoRoot
 * @param {string} packageSpecifier
 * @param {string} field
 */
export function npmViewField(repoRoot, packageSpecifier, field) {
    // `npm view` is read-only, so it's safe to retry against registry flake.
    const output = retrySync(`npm view ${packageSpecifier} ${field}`, () => execFileSync("npm", ["view", packageSpecifier, field, "--json"], {
        cwd: repoRoot,
        encoding: "utf8",
    })).trim();
    return output ? JSON.parse(output) : undefined;
}
