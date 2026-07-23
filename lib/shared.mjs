// @ts-check

import path from "node:path";
import { lstat, rm } from "node:fs/promises";

/**
 * @param {string} left
 * @param {string} right
 */
export function compareStringsCaseSensitive(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * @param {string} repoRoot
 * @param {string} filePath
 */
export function formatPathForReport(repoRoot, filePath) {
    const relativePath = path.relative(repoRoot, filePath);
    return relativePath.startsWith("..") ? filePath : relativePath;
}

/**
 * @param {string | undefined} relativePath
 * @param {string} repoRoot
 * @param {string} manifestPath
 * @param {string} propertyName
 * @param {string[]} allowedRoots
 */
export function resolveManagedOutputPath(relativePath, repoRoot, manifestPath, propertyName, allowedRoots) {
    if (!relativePath) {
        throw new Error(`Manifest ${manifestPath} is missing ${propertyName}`);
    }
    if (path.isAbsolute(relativePath) || relativePath.split(/[\\/]/u).includes("..")) {
        throw new Error(`Manifest ${propertyName} must be a repo-relative path without '..': ${relativePath}`);
    }
    const outputPath = path.resolve(repoRoot, relativePath);
    if (!allowedRoots.some(allowedRoot => isPathWithin(allowedRoot, outputPath))) {
        throw new Error(`Manifest ${propertyName} is outside its managed output root: ${relativePath}`);
    }
    return outputPath;
}

/**
 * @param {string | undefined} relativePath
 * @param {string} manifestPath
 * @param {string} propertyName
 */
export function requireRelativeManifestPath(relativePath, manifestPath, propertyName) {
    if (!relativePath) {
        throw new Error(`Manifest ${manifestPath} is missing ${propertyName}`);
    }
    return path.resolve(path.dirname(manifestPath), relativePath);
}

/**
 * @param {string} parentPath
 * @param {string} childPath
 */
export function isPathWithin(parentPath, childPath) {
    const relativePath = path.relative(path.resolve(parentPath), path.resolve(childPath));
    return relativePath === "" || (!path.isAbsolute(relativePath) && relativePath !== ".." && !relativePath.startsWith(`..${path.sep}`));
}

/**
 * @param {string} targetPath
 * @param {string} boundaryRoot
 * @param {string[]} allowedRoots
 * @param {{ recursive?: boolean; }} [options]
 */
export async function removeManagedPath(targetPath, boundaryRoot, allowedRoots, options = {}) {
    if (!allowedRoots.some(allowedRoot => isPathWithin(allowedRoot, targetPath))) {
        throw new Error(`Refusing to remove path outside managed roots: ${targetPath}`);
    }
    const relativePath = path.relative(path.resolve(boundaryRoot), path.resolve(targetPath));
    if (path.isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith(`..${path.sep}`)) {
        throw new Error(`Refusing to remove path outside boundary root: ${targetPath}`);
    }
    let currentPath = path.resolve(boundaryRoot);
    for (const segment of relativePath.split(path.sep).filter(Boolean)) {
        currentPath = path.join(currentPath, segment);
        let stats;
        try {
            stats = await lstat(currentPath);
        }
        catch (error) {
            if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
                break;
            }
            throw error;
        }
        if (stats.isSymbolicLink()) {
            throw new Error(`Refusing to remove through symbolic link: ${currentPath}`);
        }
    }
    await rm(targetPath, { recursive: options.recursive ?? false, force: true });
}
