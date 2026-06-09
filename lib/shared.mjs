// @ts-check

import path from "node:path";

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
 * @param {string} manifestPath
 * @param {string} defaultFileName
 */
export function resolveOutputPath(relativePath, manifestPath, defaultFileName) {
    const manifestDirectory = path.dirname(manifestPath);
    if (relativePath) {
        return path.resolve(manifestDirectory, relativePath);
    }

    return path.resolve(manifestDirectory, "..", "derived", "current", defaultFileName);
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
