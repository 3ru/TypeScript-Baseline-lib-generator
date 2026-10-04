// @ts-check

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { compareStringsCaseSensitive } from "./shared.mjs";

const modulePath = fileURLToPath(import.meta.url);

const moduleDirectory = path.dirname(modulePath);

const schemaPath = path.resolve(moduleDirectory, "..", "registry", "compat-management.schema.json");

/** @type {Promise<import("ajv").ValidateFunction<RegistrySource>>} */
const validatorPromise = readJsonFile(schemaPath).then(
    /** @param {import("ajv").JSONSchemaType<RegistrySource>} schema */
    schema => new Ajv2020({ allErrors: true, strict: true }).compile(schema),
);

/**
 * @param {string} filePath
 */
export async function loadCompatManagementRegistry(filePath) {
    const sourceText = await readFile(filePath, "utf8");
    const data = await parseCompatManagementRegistry(JSON.parse(sourceText), filePath);

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
        .flatMap(group => group.surfaces)
        .sort(compareStringsCaseSensitive);

    /** @type {string[]} */
    const runtimeAliasSurfaces = data.runtimeAliases
        .flatMap(group => group.surfaces)
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
 * @param {unknown} data
 * @param {string} filePath
 */
async function parseCompatManagementRegistry(data, filePath) {
    const validate = await validatorPromise;

    if (validate(data)) {
        return data;
    }

    const errors = (validate.errors ?? []).map(error => {
        const instancePath = error.instancePath || "/";

        if (error.keyword === "additionalProperties" && "additionalProperty" in error.params) {
            return `${instancePath}: unexpected property ${error.params.additionalProperty}`;
        }

        return `${instancePath}: ${error.message ?? error.keyword}`;
    }).join("\n");

    throw new Error(`Compat management registry ${filePath} failed JSON schema validation:\n${errors}`);
}

/**
 * @param {CompatManagementGroupRecord} rawGroup
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
 * @typedef {{
 *   id: string;
 *   category: string;
 *   delivery: string;
 *   upstreamState: string;
 *   compatRoot?: string;
 *   expectedResolutionKinds?: string[];
 *   reason: string;
 *   sourceUrls: string[];
 *   externalAction: ExternalAction;
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
 *   externalAction: ExternalAction;
 * }} CompatManagementEntry
 */

/**
 * @typedef {{
 *   scope: "instance" | "static";
 *   memberNames: string[];
 * }} DeclarationMapping
 */

/**
 * @typedef {{
 *   kind: "typescript-baseline-lib/compat-management-registry";
 *   schemaVersion: 1;
 *   declarationMappings?: Record<string, DeclarationMapping>;
 *   compilerSupport: SupportGroup[];
 *   runtimeAliases: SupportGroup[];
 *   groups: CompatManagementGroupRecord[];
 * }} RegistrySource
 *
 * @typedef {{ id: string; reason: string; sourceUrls: string[]; surfaces: string[]; }} SupportGroup
 *
 * @typedef {{ kind: "none"; note: string; }
 *   | { kind: "watch-existing" | "consider-focused-issue"; repo: string; targetUrl: string; note: string; }
 *   | { kind: "watch-proposal"; targetUrl: string; note: string; }
 *   | { kind: "file-issue"; repo: string; targetUrl?: string; note: string; }} ExternalAction
 */
