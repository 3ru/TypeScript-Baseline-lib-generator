// @ts-check

import fs from "node:fs";
import path from "node:path";

// Shared text operations for idempotent patches to upstream
// (microsoft/TypeScript = Strada, microsoft/typescript-go = tsgo).
// Centralized here so both patchers run under the same invariants.
// Policy: throw if the anchor is missing (fail-closed, so we don't silently miss an
// upstream reformat), and no-op if the marker is already present (idempotent re-runs).

/**
 * @param {string} sourcePath
 * @param {string} targetPath
 */
export function copyFileIfChanged(sourcePath, targetPath) {
    const sourceText = fs.readFileSync(sourcePath, "utf8");
    const currentText = fs.existsSync(targetPath)
        ? fs.readFileSync(targetPath, "utf8")
        : undefined;
    const changed = currentText !== sourceText;

    if (changed) {
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(targetPath, sourceText);
    }

    return {
        changed,
        sourcePath,
        targetPath,
    };
}

/**
 * Insert insertion right after the anchor line. No-op if alreadyPresentMarker is already present.
 *
 * @param {string} filePath
 * @param {{
 *   alreadyPresentMarker: string;
 *   anchor: string;
 *   insertion: string;
 *   description: string;
 * }} options
 */
export function ensurePatchedTextFile(filePath, options) {
    const originalText = fs.readFileSync(filePath, "utf8");

    if (originalText.includes(options.alreadyPresentMarker)) {
        return {
            changed: false,
            filePath,
        };
    }

    if (!originalText.includes(options.anchor)) {
        throw new Error(`Could not find ${options.description} anchor in ${filePath}`);
    }

    const nextText = originalText.replace(options.anchor, options.insertion);
    fs.writeFileSync(filePath, nextText);

    return {
        changed: true,
        filePath,
    };
}

/**
 * @param {string} sourceRoot
 * @param {string} targetRoot
 */
export function copyDirectoryContents(sourceRoot, targetRoot) {
    /** @type {Array<{ targetPath: string; changed: boolean; }>} */
    const copiedFiles = [];

    for (const relativePath of listRelativeFiles(sourceRoot)) {
        const sourcePath = path.join(sourceRoot, relativePath);
        const targetPath = path.join(targetRoot, relativePath);
        const result = copyFileIfChanged(sourcePath, targetPath);
        copiedFiles.push({ targetPath, changed: result.changed });
    }

    return copiedFiles;
}

/**
 * @param {string} rootDirectory
 */
export function listRelativeFiles(rootDirectory) {
    /** @type {string[]} */
    const relativePaths = [];

    visit(rootDirectory, "");
    return relativePaths.sort();

    /**
     * @param {string} currentDirectory
     * @param {string} currentRelativePath
     */
    function visit(currentDirectory, currentRelativePath) {
        for (const entry of fs.readdirSync(currentDirectory, { withFileTypes: true })) {
            const entryRelativePath = currentRelativePath
                ? path.join(currentRelativePath, entry.name)
                : entry.name;
            const entryPath = path.join(currentDirectory, entry.name);

            if (entry.isDirectory()) {
                visit(entryPath, entryRelativePath);
                continue;
            }

            if (entry.isFile()) {
                relativePaths.push(entryRelativePath);
            }
        }
    }
}

/**
 * @param {string} filePath
 * @param {string} description
 */
export function assertFileExists(filePath, description) {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        throw new Error(`Missing ${description}: ${filePath}`);
    }
}

/**
 * @param {string} directoryPath
 * @param {string} description
 */
export function assertDirectoryExists(directoryPath, description) {
    if (!fs.existsSync(directoryPath) || !fs.statSync(directoryPath).isDirectory()) {
        throw new Error(`Missing ${description}: ${directoryPath}`);
    }
}
