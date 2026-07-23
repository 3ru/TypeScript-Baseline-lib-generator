// @ts-check

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020Import from "ajv/dist/2020.js";
import { compareStringsCaseSensitive } from "./shared.mjs";

const modulePath = fileURLToPath(import.meta.url);
const moduleDirectory = path.dirname(modulePath);
const schemaPath = path.resolve(moduleDirectory, "..", "registry", "compat-management.schema.json");
const schemaPromise = readJsonFile(schemaPath);

/**
 * @param {string} filePath
 */
export async function loadCompatManagementRegistry(filePath) {
    const sourceText = await readFile(filePath, "utf8");
    const data = JSON.parse(sourceText);

    await validateCompatManagementSchema({
        data,
        filePath,
    });

    /** @type {CompatManagementGroupRecord[]} */
    const groups = [];
    /** @type {CompatManagementEntry[]} */
    const entries = [];
    /** @type {Map<string, CompatManagementEntry>} */
    const entryByCompatKey = new Map();
    /** @type {Map<string, DeclarationMapping>} */
    const declarationMappingByCompatKey = new Map(
        Object.entries(data.declarationMappings ?? {})
            .sort(([left], [right]) => compareStringsCaseSensitive(left, right))
            .map(([compatKey, mapping]) => [compatKey, {
                scope: mapping.scope,
                memberNames: [...mapping.memberNames],
            }]),
    );
    /** @type {string[]} */
    const compilerSupportSurfaces = data.compilerSupport
        .flatMap((/** @type {{ surfaces: string[]; }} */ group) => group.surfaces)
        .sort(compareStringsCaseSensitive);
    /** @type {string[]} */
    const runtimeAliasSurfaces = data.runtimeAliases
        .flatMap((/** @type {{ surfaces: string[]; }} */ group) => group.surfaces)
        .sort(compareStringsCaseSensitive);
    assertUniqueSupportSurfaces(filePath, "compiler support", compilerSupportSurfaces);
    assertUniqueSupportSurfaces(filePath, "runtime alias", runtimeAliasSurfaces);
    const conflictingSupportSurfaces = compilerSupportSurfaces.filter(surface => runtimeAliasSurfaces.includes(surface));
    if (conflictingSupportSurfaces.length) {
        throw new Error(
            `Compat management registry ${filePath} declares surfaces as both compiler support and runtime aliases:\n`
                + conflictingSupportSurfaces.sort(compareStringsCaseSensitive)
                    .map(surface => `- ${surface}`)
                    .join("\n"),
        );
    }

    for (const rawGroup of data.groups) {
        const group = normalizeCompatManagementGroup(rawGroup);
        groups.push(group);
        for (const compatKey of group.compatKeys) {
            if (entryByCompatKey.has(compatKey)) {
                throw new Error(`Compat management registry ${filePath} declares duplicate compat key ${compatKey}`);
            }
            const entry = {
                compatKey,
                groupId: group.id,
                category: group.category,
                delivery: group.delivery,
                upstreamState: group.upstreamState,
                compatRoot: group.compatRoot,
                expectedResolutionKinds: group.expectedResolutionKinds,
                declarationMapping: declarationMappingByCompatKey.get(compatKey),
                reason: group.reason,
                sourceUrls: group.sourceUrls,
                externalAction: group.externalAction,
            };
            entries.push(entry);
            entryByCompatKey.set(compatKey, entry);
        }
    }

    const unmanagedMappingKeys = [...declarationMappingByCompatKey.keys()]
        .filter(compatKey => !entryByCompatKey.has(compatKey));
    if (unmanagedMappingKeys.length) {
        throw new Error(
            `Compat management registry ${filePath} declares mappings for unmanaged compat keys:\n`
                + unmanagedMappingKeys.map(compatKey => `- ${compatKey}`).join("\n"),
        );
    }

    return {
        kind: data.kind,
        schemaVersion: data.schemaVersion,
        sourcePath: filePath,
        sourceHash: hashText(sourceText),
        compilerSupportSurfaces,
        runtimeAliasSurfaces,
        groups,
        entries,
        entryByCompatKey,
    };
}

/**
 * @param {string} filePath
 * @param {string} groupKind
 * @param {string[]} surfaces
 */
function assertUniqueSupportSurfaces(filePath, groupKind, surfaces) {
    const duplicates = surfaces.filter((surface, index) => surfaces.indexOf(surface) !== index);
    if (duplicates.length) {
        throw new Error(
            `Compat management registry ${filePath} declares duplicate ${groupKind} surfaces:\n`
                + [...new Set(duplicates)].sort(compareStringsCaseSensitive)
                    .map(surface => `- ${surface}`)
                    .join("\n"),
        );
    }
}

/**
 * @param {{
 *   data: any;
 *   filePath: string;
 * }} options
 */
async function validateCompatManagementSchema(options) {
    const schema = await schemaPromise;
    const ajv = createAjv2020({
        allErrors: true,
        strict: true,
    });
    const validate = ajv.compile(schema);
    const valid = validate(options.data);

    if (valid) {
        return;
    }

    const errors = (validate.errors ?? [])
        .map(
            /** @param {import("ajv").ErrorObject} error */
            error => {
            const instancePath = error.instancePath || "/";
            if (error.keyword === "additionalProperties" && error.params && "additionalProperty" in error.params) {
                return `${instancePath}: unexpected property ${error.params.additionalProperty}`;
            }
            return `${instancePath}: ${error.message ?? error.keyword}`;
            },
        )
        .join("\n");

    throw new Error(`Compat management registry ${options.filePath} failed JSON schema validation:\n${errors}`);
}

/**
 * @param {any} rawGroup
 */
function normalizeCompatManagementGroup(rawGroup) {
    return {
        id: rawGroup.id,
        category: rawGroup.category,
        delivery: rawGroup.delivery,
        upstreamState: rawGroup.upstreamState,
        compatRoot: rawGroup.compatRoot,
        expectedResolutionKinds: rawGroup.expectedResolutionKinds,
        reason: rawGroup.reason,
        sourceUrls: [...new Set(rawGroup.sourceUrls)].sort(compareStringsCaseSensitive),
        externalAction: rawGroup.externalAction,
        compatKeys: [...new Set(rawGroup.compatKeys)].sort(compareStringsCaseSensitive),
    };
}

/**
 * @param {string} filePath
 */
async function readJsonFile(filePath) {
    return JSON.parse(await readFile(filePath, "utf8"));
}

/**
 * @param {string} value
 */
function hashText(value) {
    return `sha256-${createHash("sha256").update(value).digest("hex")}`;
}

/**
 * `ajv/dist/2020.js` exposes a constructor at runtime, but the ESM typing shape
 * is awkward under `checkJs`. Keep the cast at this boundary and keep the rest
 * of the file strongly typed.
 *
 * @param {ConstructorParameters<typeof import("ajv").default>[0]} options
 */
function createAjv2020(options) {
    return new (/** @type {typeof import("ajv").default} */ (/** @type {unknown} */ (Ajv2020Import)))(options);
}

/**
 * @typedef {{
 *   id: string;
 *   category: string;
 *   delivery: string;
 *   upstreamState: string;
 *   compatRoot?: string;
 *   expectedResolutionKinds?: string[];
 *   reason: string;
 *   sourceUrls: string[];
 *   externalAction?: any;
 *   compatKeys: string[];
 * }} CompatManagementGroupRecord
 */

/**
 * @typedef {{
 *   compatKey: string;
 *   groupId: string;
 *   category: string;
 *   delivery: string;
 *   upstreamState: string;
 *   compatRoot?: string;
 *   expectedResolutionKinds?: string[];
 *   declarationMapping?: DeclarationMapping;
 *   reason: string;
 *   sourceUrls: string[];
 *   externalAction?: any;
 * }} CompatManagementEntry
 */

/**
 * @typedef {{
 *   scope: "instance" | "static";
 *   memberNames: string[];
 * }} DeclarationMapping
 */
