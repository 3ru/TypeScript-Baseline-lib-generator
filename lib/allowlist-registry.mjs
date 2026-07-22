// @ts-check

import { readFile } from "node:fs/promises";
import { compareStringsCaseSensitive } from "./shared.mjs";

const ENTRY_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * @param {string} registryPath
 * @returns {Promise<AllowlistRegistry>}
 */
export async function loadAllowlistRegistry(registryPath) {
    const registry = JSON.parse(await readFile(registryPath, "utf8"));
    if (registry.schemaVersion !== 1 || !Array.isArray(registry.entries)) {
        throw new Error(`Invalid allowlist registry ${registryPath}`);
    }

    const entryNames = new Set();
    const compatKeys = new Set();
    for (const entry of registry.entries) {
        if (
            !entry
            || typeof entry !== "object"
            || Object.keys(entry).sort().join(",") !== "compatKeys,entryName"
            || typeof entry.entryName !== "string"
            || !ENTRY_NAME_PATTERN.test(entry.entryName)
            || !Array.isArray(entry.compatKeys)
            || !entry.compatKeys.length
            || entry.compatKeys.some((/** @type {unknown} */ compatKey) => typeof compatKey !== "string" || !compatKey)
        ) {
            throw new Error(`Invalid allowlist entry in ${registryPath}`);
        }
        if (entryNames.has(entry.entryName) || new Set(entry.compatKeys).size !== entry.compatKeys.length) {
            throw new Error(`Duplicate allowlist entry data in ${registryPath}: ${entry.entryName}`);
        }
        for (const compatKey of entry.compatKeys) {
            if (compatKeys.has(compatKey)) {
                throw new Error(`Allowlist compat key is assigned to multiple entries: ${compatKey}`);
            }
            compatKeys.add(compatKey);
        }
        const sortedCompatKeys = [...entry.compatKeys].sort(compareStringsCaseSensitive);
        if (JSON.stringify(sortedCompatKeys) !== JSON.stringify(entry.compatKeys)) {
            throw new Error(`Allowlist compat keys must be sorted for ${entry.entryName}`);
        }
        entryNames.add(entry.entryName);
    }

    const sortedEntries = [...registry.entries].sort((left, right) =>
        compareStringsCaseSensitive(left.entryName, right.entryName)
    );
    if (JSON.stringify(sortedEntries) !== JSON.stringify(registry.entries)) {
        throw new Error(`Allowlist entries in ${registryPath} must be sorted by entryName`);
    }
    return registry;
}

/**
 * @typedef {{
 *   schemaVersion: 1;
 *   entries: Array<{ entryName: string; compatKeys: string[]; }>;
 * }} AllowlistRegistry
 */
