// @ts-check

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
    cleanupTempDirectories,
    createTempDirectory,
    readJsonFile,
    repoRegistryPath,
    writeJsonFile,
} from "./helpers.mjs";
import { loadCompatManagementRegistry } from "../lib/compat-management-registry.mjs";

/** @type {string[]} */
const tempDirectories = [];

test.afterEach(() => {
    cleanupTempDirectories(tempDirectories);
});

test("compat-management registry accepts the canonical registry", async () => {
    const registry = await loadCompatManagementRegistry(repoRegistryPath);

    assert.equal(registry.kind, "typescript-baseline-lib/compat-management-registry");
    assert.ok(registry.groups.length > 0);
    assert.ok(registry.entries.length > 0);
});

test("compat-management registry fails schema validation on unexpected properties and enum drift", async () => {
    const tempDirectory = createTempDirectory(tempDirectories);
    const registryPath = path.join(tempDirectory, "compat-management.invalid.json");
    /** @type {{ groups: Array<{ category: string; [key: string]: unknown; }>; }} */
    const registry = readJsonFile(repoRegistryPath);

    writeJsonFile(registryPath, {
        ...registry,
        groups: registry.groups.map((group, index) => {
            if (index !== 0) {
                return group;
            }
            return {
                ...group,
                category: "invalid-category",
                stray: true,
            };
        }),
    });

    await assert.rejects(
        () => loadCompatManagementRegistry(registryPath),
        error => {
            assert.match(String(error), /failed JSON schema validation/);
            assert.match(String(error), /invalid-category|unexpected property stray/);
            return true;
        },
    );
});
