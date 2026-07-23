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
    assert.ok(registry.compilerSupportSurfaces.includes("IterableIterator"));
    assert.ok(registry.runtimeAliasSurfaces.includes("Function.prototype"));
    assert.deepEqual(
        registry.entryByCompatKey.get("javascript.builtins.RegExp.input")?.declarationMapping,
        { scope: "static", memberNames: ["input", "$_"] },
    );
});

test("compat-management registry keeps compiler support and runtime aliases disjoint", async () => {
    const tempDirectory = createTempDirectory(tempDirectories);
    const registryPath = path.join(tempDirectory, "compat-management.overlap.json");
    const registry = readJsonFile(repoRegistryPath);
    registry.runtimeAliases[0].surfaces.push(registry.compilerSupport[0].surfaces[0]);
    writeJsonFile(registryPath, registry);

    await assert.rejects(
        () => loadCompatManagementRegistry(registryPath),
        /both compiler support and runtime aliases/u,
    );
});

test("compat-management registry validates declaration mappings", async () => {
    const tempDirectory = createTempDirectory(tempDirectories);
    const registry = readJsonFile(repoRegistryPath);
    const invalidSchemaPath = path.join(tempDirectory, "compat-management.mapping-schema.json");
    writeJsonFile(invalidSchemaPath, {
        ...registry,
        declarationMappings: {
            ...registry.declarationMappings,
            "javascript.builtins.RegExp.input": {
                scope: "both",
                memberNames: ["input"],
                stray: true,
            },
        },
    });
    await assert.rejects(
        () => loadCompatManagementRegistry(invalidSchemaPath),
        /failed JSON schema validation/,
    );

    const unmanagedMappingPath = path.join(tempDirectory, "compat-management.unmanaged-mapping.json");
    writeJsonFile(unmanagedMappingPath, {
        ...registry,
        declarationMappings: {
            ...registry.declarationMappings,
            "javascript.builtins.Widget.ghost": {
                scope: "static",
                memberNames: ["ghost"],
            },
        },
    });
    await assert.rejects(
        () => loadCompatManagementRegistry(unmanagedMappingPath),
        /declares mappings for unmanaged compat keys:[\s\S]*javascript\.builtins\.Widget\.ghost/,
    );
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
