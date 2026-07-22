// @ts-check

import {
    mkdir,
    readFile,
    rm,
    writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
// TypeScript 7 (tsgo) has a different JS API than Strada, so parse .d.ts and
// self-check with the frozen final Strada line (npm alias: typescript-strada).
import ts from "typescript-strada";
import {
    classifyManifest,
    resolveRootAvailabilityUnitIds,
} from "./classifier.mjs";
import { verifyLibSource } from "./toolchain-libs.mjs";
import {
    compareStringsCaseSensitive,
    formatPathForReport,
    resolveOutputPath,
} from "./shared.mjs";
import {
    createSurfaceInventory,
    discoverBuiltinSourceLibEntries,
    emitSelectedUnits,
    getDeclarationUnits,
    getOwnerMemberUnits,
    getPreferredDeclarationUnits,
    getRootSurface,
} from "./surface-inventory.mjs";
import { loadAllowlistRegistry } from "./allowlist-registry.mjs";

const RUNTIME_DECLARATION_KINDS = new Set(["var", "function", "class", "enum", "namespace"]);
const NON_MERGEABLE_ALLOW_CONTAINER_KINDS = new Set(["class", "type-literal-var"]);
const BASELINE_SURFACE = Symbol("baseline");

// Resolution kinds where resolvedUnitIds points at the declaration surface of
// the feature itself. Units from excluded rows (includeInTarget: false) with
// these kinds must not exist in the generated artifact unless some included
// row also resolves them. signature-compat / behavioral / transform-only track
// qualifications on already-included surface, so the base surface stays even
// when they are excluded.
const SURFACE_DEFINING_RESOLUTION_KINDS = new Set([
    "member",
    "constructor",
    "inherited-member",
    "option-property",
    "type-property",
    "root-availability",
]);

/**
 * @param {{
 *   manifestPath: string;
 *   repoRoot: string;
 * }} options
 */
export async function generateFirstClassBaselineLib(options) {
    const plan = await createGenerationPlan(options);
    await publishGenerationPlan(plan);
    return plan;
}

/**
 * Return declaration units resolved by excluded compat rows that should be
 * blocked from the generated artifact. Units also resolved by an included row
 * (shared surface) are not blocked.
 *
 * @param {Array<{
 *   compatKey: string;
 *   includeInTarget: boolean;
 *   resolutionKind: string;
 *   resolvedUnitIds: string[];
 * }>} classifiedCompatRows
 */
export function resolveExcludedUnits(classifiedCompatRows) {
    const includedUnitIds = new Set(
        classifiedCompatRows
            .filter(row => row.includeInTarget)
            .flatMap(row => row.resolvedUnitIds),
    );

    /** @type {Map<string, string[]>} */
    const excludedRowsByUnitId = new Map();
    for (const row of classifiedCompatRows) {
        if (row.includeInTarget || !SURFACE_DEFINING_RESOLUTION_KINDS.has(row.resolutionKind)) {
            continue;
        }
        for (const unitId of row.resolvedUnitIds) {
            if (includedUnitIds.has(unitId)) {
                continue;
            }
            const compatKeys = excludedRowsByUnitId.get(unitId) ?? [];
            compatKeys.push(row.compatKey);
            excludedRowsByUnitId.set(unitId, compatKeys);
        }
    }

    return {
        excludedUnitIds: new Set(excludedRowsByUnitId.keys()),
        excludedRowsByUnitId,
    };
}

/**
 * Preserve globally visible erased aliases that compatibility data cannot
 * classify. Interfaces and their members remain compat- or dependency-driven.
 *
 * @param {{
 *   inventory: import("./surface-inventory.mjs").SurfaceInventory;
 *   classifiedCompatRows: Array<{ resolvedUnitIds: string[]; }>;
 *   excludedUnitIds: Set<string>;
 * }} options
 */
export function resolveUnclaimedTypeOnlyUnitIds(options) {
    const {
        inventory,
        classifiedCompatRows,
        excludedUnitIds,
    } = options;
    const claimedUnitIds = new Set(classifiedCompatRows.flatMap(row => row.resolvedUnitIds));

    return inventory.units
        .filter(unit => {
            if (
                claimedUnitIds.has(unit.id)
                || excludedUnitIds.has(unit.id)
            ) {
                return false;
            }
            if (inventory.fileByLibFileName.get(unit.libFileName)?.preserveWholeFile) {
                return false;
            }
            return unit.unitKind === "declaration"
                && unit.declarationKind === "type-alias"
                && !unit.parentContainerId;
        })
        .map(unit => unit.id)
        .sort(compareStringsCaseSensitive);
}

/**
 * @param {{
 *   inventory: import("./surface-inventory.mjs").SurfaceInventory;
 *   compatSelectedUnitIds: Set<string>;
 *   typeOnlyUnitIds: string[];
 *   completeContainerUnitIds: Set<string>;
 *   excludedUnitIds: Set<string>;
 * }} options
 */
export function resolveTypeOnlyDependencyClosure(options) {
    const compatClosure = new Set(resolveDependencyClosure({
        inventory: options.inventory,
        initiallySelectedUnitIds: options.compatSelectedUnitIds,
        completeContainerUnitIds: new Set(options.completeContainerUnitIds),
        excludedUnitIds: options.excludedUnitIds,
    }));
    const selectedUnitIds = resolveDependencyClosure({
        inventory: options.inventory,
        initiallySelectedUnitIds: new Set([
            ...options.compatSelectedUnitIds,
            ...options.typeOnlyUnitIds,
        ]),
        completeContainerUnitIds: options.completeContainerUnitIds,
        excludedUnitIds: options.excludedUnitIds,
    });
    const introducedRuntimeUnits = selectedUnitIds.filter(unitId => {
        if (compatClosure.has(unitId)) {
            return false;
        }
        const unit = options.inventory.unitById.get(unitId);
        return unit?.unitKind === "declaration"
            && RUNTIME_DECLARATION_KINDS.has(unit.declarationKind ?? "");
    });
    if (introducedRuntimeUnits.length) {
        throw new Error(
            "Type-only aliases introduce runtime declarations not selected by compat data:\n"
                + introducedRuntimeUnits.map(unitId => `- ${unitId}`).join("\n"),
        );
    }
    return selectedUnitIds;
}

/**
 * Enforce, before emit, that units judged excluded are absent from the
 * generated artifact. No matter which path selected them (complete-container
 * promotion, dependency closure, or compiler-global completion), an
 * intersection with excluded units is either a bug or a policy conflict that
 * the registry must arbitrate explicitly, so fail instead of passing silently.
 *
 * @param {{
 *   inventory: import("./surface-inventory.mjs").SurfaceInventory;
 *   selectedUnitIds: Iterable<string>;
 *   excludedUnitIds: Set<string>;
 *   excludedRowsByUnitId: Map<string, string[]>;
 * }} options
 */
export function assertExclusionInvariants(options) {
    const {
        inventory,
        selectedUnitIds,
        excludedUnitIds,
        excludedRowsByUnitId,
    } = options;

    const selectedSet = new Set(selectedUnitIds);

    const selectedExcludedUnitIds = [...selectedSet]
        .filter(unitId => excludedUnitIds.has(unitId))
        .sort(compareStringsCaseSensitive);
    if (selectedExcludedUnitIds.length) {
        const details = selectedExcludedUnitIds
            .map(unitId => `- ${unitId} (excluded by: ${(excludedRowsByUnitId.get(unitId) ?? []).join(", ")})`)
            .join("\n");
        throw new Error(
            `Excluded compat units were selected for emission. `
                + `Resolve the policy conflict explicitly (registry) instead of emitting non-Baseline surface:\n${details}`,
        );
    }

    // When every declaration unit of a selected member's container is excluded,
    // the container is not emitted and the member silently disappears. That's a
    // selection contradiction, not an exclusion, so fail.
    /** @type {string[]} */
    const orphanedMembers = [];
    for (const unitId of selectedSet) {
        const unit = inventory.unitById.get(unitId);
        if (!unit?.parentContainerId) {
            continue;
        }
        const containerDeclarationUnits = inventory.units.filter(
            candidate => candidate.unitKind === "declaration" && candidate.containerId === unit.parentContainerId,
        );
        if (
            containerDeclarationUnits.length
            && containerDeclarationUnits.every(declarationUnit => excludedUnitIds.has(declarationUnit.id))
        ) {
            orphanedMembers.push(unitId);
        }
    }
    if (orphanedMembers.length) {
        const details = orphanedMembers
            .sort(compareStringsCaseSensitive)
            .map(unitId => `- ${unitId}`)
            .join("\n");
        throw new Error(
            `Selected units belong to containers whose declarations are all excluded:\n${details}`,
        );
    }
}

/**
 * @param {{
 *   manifestPath: string;
 *   repoRoot: string;
 * }} options
 */
async function createGenerationPlan({ manifestPath, repoRoot }) {
    const manifest = await readManifest(manifestPath);
    if (!manifest.firstClassLib?.libName) {
        throw new Error(`Manifest ${manifestPath} is missing firstClassLib.libName`);
    }
    if (!manifest.firstClassLib?.outputFile) {
        throw new Error(`Manifest ${manifestPath} is missing firstClassLib.outputFile`);
    }

    const topLevelOutputPath = path.resolve(path.dirname(manifestPath), manifest.firstClassLib.outputFile);
    const allowOutputDirectory = path.resolve(
        path.dirname(manifestPath),
        manifest.firstClassLib.allowDirectory ?? path.join(path.dirname(manifest.firstClassLib.outputFile), "allow"),
    );
    if (!manifest.allowlistRegistry) {
        throw new Error(`Manifest ${manifestPath} is missing allowlistRegistry`);
    }
    const allowlistRegistryPath = path.resolve(path.dirname(manifestPath), manifest.allowlistRegistry);
    const allowlistRegistry = await loadAllowlistRegistry(allowlistRegistryPath);
    const generationOutputPath = resolveOutputPath(manifest.generationOutput, manifestPath, "generation.json");
    const inventoryOutputPath = resolveOutputPath(manifest.inventoryOutput, manifestPath, "inventory.json");

    // In TS7, lib.*.d.ts ships in platform-specific packages, so verify it
    // matches the manifest libSource pin (content hash) before reading.
    const libSource = await verifyLibSource({
        repoRoot,
        manifest,
    });
    const sourceLibEntries = await discoverBuiltinSourceLibEntries({
        libDirectory: libSource.libDirectory,
        reportPathPrefix: `${manifest.libSource.basePackage}/lib`,
    });
    const inventory = await createSurfaceInventory({
        snapshotName: manifest.snapshot.name,
        repoRoot,
        sourceLibEntries,
        inventoryOutputPath,
    });

    const classification = await classifyManifest({
        manifest,
        manifestPath,
        repoRoot,
        inventory,
    });

    const compatSelectedUnitIds = classification.classifiedCompatRows
        .filter(row => row.includeInTarget)
        .flatMap(row => row.resolvedUnitIds);
    const {
        excludedUnitIds,
        excludedRowsByUnitId,
    } = resolveExcludedUnits(classification.classifiedCompatRows);
    const typeOnlyUnitIds = resolveUnclaimedTypeOnlyUnitIds({
        inventory,
        classifiedCompatRows: classification.classifiedCompatRows,
        excludedUnitIds,
    });
    const initiallySelectedUnitIds = new Set([
        ...compatSelectedUnitIds,
        ...typeOnlyUnitIds,
    ]);
    const completeContainerUnitIds = new Set(
        classification.classifiedCompatRows
            .filter(row => row.includeInTarget && row.resolutionKind === "root-availability")
            .flatMap(row => row.resolvedUnitIds)
            .filter(unitId => {
                const unit = inventory.unitById.get(unitId);
                return unit?.unitKind === "declaration" && Boolean(unit.containerId);
            }),
    );

    const unitTextOverrides = buildUnitTextOverrides({
        classification,
        inventory,
        initiallySelectedUnitIds,
    });

    const selectedUnitIds = stabilizeCompilerGlobalSupport({
        inventory,
        unitTextOverrides,
        selectedUnitIds: resolveTypeOnlyDependencyClosure({
            inventory,
            compatSelectedUnitIds: new Set(compatSelectedUnitIds),
            typeOnlyUnitIds,
            completeContainerUnitIds,
            excludedUnitIds,
        }),
        completeContainerUnitIds,
        excludedUnitIds,
    });

    assertExclusionInvariants({
        inventory,
        selectedUnitIds,
        excludedUnitIds,
        excludedRowsByUnitId,
    });

    const emittedBaselineUnitIds = collectEmittedUnitIds({
        inventory,
        selectedUnitIds,
        completeContainerUnitIds,
        excludedUnitIds,
    });

    const allowEntries = createAllowEntries({
        classification,
        inventory,
        emittedBaselineUnitIds,
        completeContainerUnitIds,
        excludedUnitIds,
        allowOutputDirectory,
        registryEntries: allowlistRegistry.entries,
    });
    assertAllowEntryIsolation({
        allowEntries,
        baselineUnitIds: emittedBaselineUnitIds,
        inventory,
    });
    const allowSupportArtifacts = createAllowSupportArtifacts(allowEntries, allowOutputDirectory);

    return {
        manifest,
        manifestPath,
        repoRoot,
        sourceLibEntries,
        inventory,
        classification,
        inventoryOutputPath,
        generationOutputPath,
        compatManagementOutputPath: classification.compatManagementOutputPath,
        topLevelOutputPath,
        allowOutputDirectory,
        allowEntries,
        allowSupportArtifacts,
        selectedUnitIds,
        completeContainerUnitIds,
        excludedUnitIds,
        excludedRowsByUnitId,
        typeOnlyUnitIds,
        unitTextOverrides,
        outputEntries: [
            {
                kind: "top-level-lib",
                outputPath: topLevelOutputPath,
            },
            ...allowEntries.map(entry => ({
                kind: "allow-entry",
                outputPath: entry.outputPath,
            })),
            ...allowSupportArtifacts.map(artifact => ({
                kind: "allow-support",
                outputPath: artifact.outputPath,
            })),
        ],
    };
}

/**
 * Include units emitted through complete-container selection in the baseline set.
 *
 * @param {{
 *   inventory: import("./surface-inventory.mjs").SurfaceInventory;
 *   selectedUnitIds: string[];
 *   completeContainerUnitIds: Set<string>;
 *   excludedUnitIds: Set<string>;
 * }} options
 */
function collectEmittedUnitIds(options) {
    const emittedUnitIds = new Set(options.selectedUnitIds);

    /** @param {string} unitId */
    function includeUnit(unitId) {
        if (options.excludedUnitIds.has(unitId)) {
            return;
        }
        emittedUnitIds.add(unitId);
        const unit = options.inventory.unitById.get(unitId);
        if (!unit?.containerId) {
            return;
        }
        for (const child of options.inventory.units.filter(candidate => candidate.parentContainerId === unit.containerId)) {
            includeUnit(child.id);
        }
    }

    for (const unitId of options.completeContainerUnitIds) {
        includeUnit(unitId);
    }
    return emittedUnitIds;
}

/**
 * @param {{
 *   classification: Awaited<ReturnType<typeof classifyManifest>>;
 *   inventory: import("./surface-inventory.mjs").SurfaceInventory;
 *   emittedBaselineUnitIds: Set<string>;
 *   completeContainerUnitIds: Set<string>;
 *   excludedUnitIds: Set<string>;
 *   allowOutputDirectory: string;
 *   registryEntries: Array<{ entryName: string; compatKeys: string[]; }>;
 * }} options
 */
function createAllowEntries(options) {
    const rowByCompatKey = new Map(
        options.classification.classifiedCompatRows.map(row => [row.compatKey, row]),
    );
    /** @type {Map<string, Array<{ compatKey: string; baselineStatus: string | boolean | undefined; }>>} */
    const claimsByUnitId = new Map();
    for (const row of options.classification.classifiedCompatRows) {
        for (const unitId of [
            ...row.resolvedUnitIds,
            ...row.transforms.map(transform => transform.unitId),
        ]) {
            const claims = claimsByUnitId.get(unitId) ?? [];
            claims.push({ compatKey: row.compatKey, baselineStatus: row.baselineStatus });
            claimsByUnitId.set(unitId, claims);
        }
    }

    return options.registryEntries.map(registryEntry => {
        const rows = registryEntry.compatKeys.map(compatKey => {
            const row = rowByCompatKey.get(compatKey);
            if (!row) {
                throw new Error(`Allow entry ${registryEntry.entryName} references missing compat key ${compatKey}`);
            }
            if (row.baselineStatus !== "high" && row.baselineStatus !== "low") {
                throw new Error(
                    `Allow entry ${registryEntry.entryName} references a compat key that is not Baseline: ${compatKey}`,
                );
            }
            return row;
        });
        const highRows = rows.filter(row => row.baselineStatus === "high");
        for (const row of highRows) {
            const rowUnitIds = [
                ...row.resolvedUnitIds,
                ...row.transforms.map(transform => transform.unitId),
            ];
            if (
                ["already-excluded-upstream", "behavioral", "not-modeled-upstream"].includes(row.resolutionKind)
                || !rowUnitIds.length
                || rowUnitIds.some(unitId => !options.emittedBaselineUnitIds.has(unitId))
            ) {
                throw new Error(
                    `Allow entry ${registryEntry.entryName} cannot alias ${row.compatKey}; `
                        + "the baseline artifact does not emit its declaration surface",
                );
            }
        }
        const lowRows = rows.filter(row => row.baselineStatus === "low");
        const outputPath = path.join(options.allowOutputDirectory, registryEntry.entryName, "index.d.ts");
        if (!lowRows.length) {
            return {
                kind: "alias",
                entryName: registryEntry.entryName,
                compatKeys: registryEntry.compatKeys,
                unitIds: [],
                supportUnitIds: [],
                outputPath,
            };
        }

        const unitIds = new Set();
        for (const row of lowRows) {
            if (["already-excluded-upstream", "behavioral", "not-modeled-upstream"].includes(row.resolutionKind)) {
                throw new Error(
                    `Allow entry ${registryEntry.entryName} cannot emit ${row.compatKey} (${row.resolutionKind})`,
                );
            }
            const rowUnitIds = new Set();
            for (const unitId of row.resolvedUnitIds) {
                if (options.excludedUnitIds.has(unitId)) {
                    rowUnitIds.add(unitId);
                }
                if (row.resolutionKind !== "root-availability") {
                    continue;
                }
                const rootUnit = options.inventory.unitById.get(unitId);
                if (!rootUnit?.containerId) {
                    continue;
                }
                for (const childUnit of options.inventory.units) {
                    if (
                        childUnit.parentContainerId === rootUnit.containerId
                        && !options.emittedBaselineUnitIds.has(childUnit.id)
                        && !options.excludedUnitIds.has(childUnit.id)
                    ) {
                        rowUnitIds.add(childUnit.id);
                    }
                }
            }
            for (const transform of row.transforms) {
                rowUnitIds.add(transform.unitId);
            }
            if (!rowUnitIds.size) {
                throw new Error(
                    `Allow entry ${registryEntry.entryName} does not emit declarations for ${row.compatKey}`,
                );
            }
            for (const unitId of rowUnitIds) {
                unitIds.add(unitId);
            }
        }

        if (!unitIds.size) {
            throw new Error(`Allow entry ${registryEntry.entryName} does not emit any declarations`);
        }

        const registeredCompatKeys = new Set(registryEntry.compatKeys);
        for (const unitId of unitIds) {
            for (const claim of claimsByUnitId.get(unitId) ?? []) {
                if (
                    claim.baselineStatus !== "high"
                    && (claim.baselineStatus !== "low" || !registeredCompatKeys.has(claim.compatKey))
                ) {
                    throw new Error(
                        `Allow entry ${registryEntry.entryName} cannot safely emit shared unit ${unitId}; `
                            + `it also belongs to ${claim.compatKey} (${String(claim.baselineStatus)})`,
                    );
                }
            }
        }

        const selectedWithEntry = new Set([...options.emittedBaselineUnitIds, ...unitIds]);
        const blockedUnitIds = new Set(options.excludedUnitIds);
        for (const unitId of unitIds) {
            blockedUnitIds.delete(unitId);
        }
        const resolvedUnitIds = resolveDependencyClosure({
            inventory: options.inventory,
            initiallySelectedUnitIds: selectedWithEntry,
            completeContainerUnitIds: new Set(options.completeContainerUnitIds),
            excludedUnitIds: blockedUnitIds,
        });
        const supportUnitIds = resolvedUnitIds
            .filter(unitId => !selectedWithEntry.has(unitId))
            .sort(compareStringsCaseSensitive);
        return {
            kind: "active",
            entryName: registryEntry.entryName,
            compatKeys: registryEntry.compatKeys,
            unitIds: [...unitIds].sort(compareStringsCaseSensitive),
            supportUnitIds,
            outputPath,
        };
    });
}

/**
 * @param {{
 *   allowEntries: Array<{ kind: string; entryName: string; unitIds: string[]; supportUnitIds: string[]; }>;
 *   baselineUnitIds: Iterable<string>;
 *   inventory: import("./surface-inventory.mjs").SurfaceInventory;
 * }} options
 */
function assertAllowEntryIsolation(options) {
    /** @type {Map<string, string>} */
    const primaryEntryByUnitId = new Map();
    /** @type {Map<string, Set<string>>} */
    const supportEntriesByUnitId = new Map();
    /** @type {Map<string, Set<string | symbol>>} */
    const surfaceIdsByContainerId = new Map();

    /**
     * @param {string | symbol} surfaceId
     * @param {Iterable<string>} unitIds
     */
    function recordNonMergeableContainers(surfaceId, unitIds) {
        for (const unitId of new Set(unitIds)) {
            const unit = options.inventory.unitById.get(unitId);
            if (!unit) {
                throw new Error(`Unknown generated declaration unit ${unitId}`);
            }
            let containerId = unit.containerId ?? unit.parentContainerId;
            while (containerId) {
                const container = options.inventory.containerById.get(containerId);
                if (!container) {
                    throw new Error(`Unknown generated declaration container ${containerId}`);
                }
                if (NON_MERGEABLE_ALLOW_CONTAINER_KINDS.has(container.containerKind)) {
                    const surfaceIds = surfaceIdsByContainerId.get(containerId) ?? new Set();
                    surfaceIds.add(surfaceId);
                    surfaceIdsByContainerId.set(containerId, surfaceIds);
                }
                containerId = container.parentContainerId;
            }
        }
    }

    recordNonMergeableContainers(BASELINE_SURFACE, options.baselineUnitIds);

    for (const entry of options.allowEntries) {
        if (entry.kind !== "active") {
            continue;
        }
        for (const unitId of entry.unitIds) {
            const existingEntryName = primaryEntryByUnitId.get(unitId);
            if (existingEntryName && existingEntryName !== entry.entryName) {
                throw new Error(
                    `Allow declaration unit ${unitId} belongs to multiple entries: `
                        + `${existingEntryName}, ${entry.entryName}`,
                );
            }
            primaryEntryByUnitId.set(unitId, entry.entryName);
        }
        for (const unitId of entry.supportUnitIds) {
            const entryNames = supportEntriesByUnitId.get(unitId) ?? new Set();
            entryNames.add(entry.entryName);
            supportEntriesByUnitId.set(unitId, entryNames);
        }
        recordNonMergeableContainers(entry.entryName, [...entry.unitIds, ...entry.supportUnitIds]);
    }

    for (const [unitId, primaryEntryName] of primaryEntryByUnitId) {
        const conflictingEntryNames = [...supportEntriesByUnitId.get(unitId) ?? []]
            .filter(entryName => entryName !== primaryEntryName)
            .sort(compareStringsCaseSensitive);
        if (conflictingEntryNames.length) {
            throw new Error(
                `Allow declaration unit ${unitId} is primary in ${primaryEntryName} `
                    + `and support in ${conflictingEntryNames.join(", ")}`,
            );
        }
    }

    for (const [containerId, surfaceIds] of surfaceIdsByContainerId) {
        const sortedSurfaceNames = [...surfaceIds]
            .map(surfaceId => typeof surfaceId === "string" ? surfaceId : "baseline")
            .sort(compareStringsCaseSensitive);
        if (sortedSurfaceNames.length > 1) {
            const container = options.inventory.containerById.get(containerId);
            throw new Error(
                `Non-mergeable declaration container ${container?.symbolName ?? containerId} `
                    + `cannot span generated surfaces: ${sortedSurfaceNames.join(", ")}`,
            );
        }
    }
}

/**
 * @param {Array<{ entryName: string; supportUnitIds: string[]; }>} allowEntries
 * @param {string} allowOutputDirectory
 */
function createAllowSupportArtifacts(allowEntries, allowOutputDirectory) {
    /** @type {Map<string, Set<string>>} */
    const entryNamesByUnitId = new Map();
    for (const entry of allowEntries) {
        for (const unitId of entry.supportUnitIds) {
            const entryNames = entryNamesByUnitId.get(unitId) ?? new Set();
            entryNames.add(entry.entryName);
            entryNamesByUnitId.set(unitId, entryNames);
        }
    }

    /** @type {Map<string, { entryNames: string[]; unitIds: string[]; }>} */
    const groups = new Map();
    for (const [unitId, entryNames] of entryNamesByUnitId) {
        const sortedEntryNames = [...entryNames].sort(compareStringsCaseSensitive);
        const groupKey = sortedEntryNames.join("\0");
        const group = groups.get(groupKey) ?? {
            entryNames: sortedEntryNames,
            unitIds: [],
        };
        group.unitIds.push(unitId);
        groups.set(groupKey, group);
    }

    const fileNames = new Set();
    return [...groups.values()].map(group => {
        group.unitIds.sort(compareStringsCaseSensitive);
        const fileName = group.entryNames.length === 1
            ? `${group.entryNames[0]}.d.ts`
            : `shared-${createHash("sha256").update(group.entryNames.join("\0")).digest("hex").slice(0, 16)}.d.ts`;
        if (fileNames.has(fileName)) {
            throw new Error(`Allow support filename collision: ${fileName}`);
        }
        fileNames.add(fileName);
        return {
            entryNames: group.entryNames,
            unitIds: group.unitIds,
            fileName,
            outputPath: path.join(allowOutputDirectory, "_support", fileName),
        };
    }).sort((left, right) => compareStringsCaseSensitive(left.fileName, right.fileName));
}

/**
 * @param {GenerationPlan} plan
 */
async function publishGenerationPlan(plan) {
    const previousOutputs = await readPreviousOutputEntries(plan.generationOutputPath, plan.repoRoot);
    const nextOutputs = new Set(plan.outputEntries.map(entry => entry.outputPath));

    for (const previousOutputPath of previousOutputs) {
        if (!nextOutputs.has(previousOutputPath)) {
            await rm(previousOutputPath, { force: true });
        }
    }

    const topLevelContents = emitSelectedUnits({
        inventory: plan.inventory,
        selectedUnitIds: plan.selectedUnitIds,
        unitTextOverrides: plan.unitTextOverrides,
        completeContainerUnitIds: plan.completeContainerUnitIds,
        excludedUnitIds: plan.excludedUnitIds,
    });

    await mkdir(path.dirname(plan.topLevelOutputPath), { recursive: true });
    await writeFile(plan.topLevelOutputPath, topLevelContents);

    await rm(plan.allowOutputDirectory, { recursive: true, force: true });
    /** @type {Map<string, typeof plan.allowSupportArtifacts>} */
    const supportArtifactsByEntryName = new Map();
    for (const artifact of plan.allowSupportArtifacts) {
        const contents = emitSelectedUnits({
            inventory: plan.inventory,
            selectedUnitIds: artifact.unitIds,
        });
        await mkdir(path.dirname(artifact.outputPath), { recursive: true });
        await writeFile(artifact.outputPath, contents);
        for (const entryName of artifact.entryNames) {
            const artifacts = supportArtifactsByEntryName.get(entryName) ?? [];
            artifacts.push(artifact);
            supportArtifactsByEntryName.set(entryName, artifacts);
        }
    }
    for (const entry of plan.allowEntries) {
        if (entry.kind === "alias") {
            const relativePath = path.relative(path.dirname(entry.outputPath), plan.topLevelOutputPath)
                .split(path.sep)
                .join(path.posix.sep);
            await mkdir(path.dirname(entry.outputPath), { recursive: true });
            await writeFile(entry.outputPath, `/// <reference path="${relativePath}" />\n`);
            continue;
        }
        const declarations = emitSelectedUnits({
            inventory: plan.inventory,
            selectedUnitIds: entry.unitIds,
        });
        const supportArtifacts = supportArtifactsByEntryName.get(entry.entryName) ?? [];
        const coveredSupportUnitIds = new Set(supportArtifacts.flatMap(artifact => artifact.unitIds));
        for (const unitId of entry.supportUnitIds) {
            if (!coveredSupportUnitIds.has(unitId)) {
                throw new Error(`Missing allow support artifact for unit ${unitId}`);
            }
        }
        const references = supportArtifacts.map(artifact => {
            const relativePath = path.relative(path.dirname(entry.outputPath), artifact.outputPath)
                .split(path.sep)
                .join(path.posix.sep);
            return `/// <reference path="${relativePath}" />`;
        });
        const contents = references.length
            ? `${references.join("\n")}\n\n${declarations}`
            : declarations;
        await mkdir(path.dirname(entry.outputPath), { recursive: true });
        await writeFile(entry.outputPath, contents);
    }

    await mkdir(path.dirname(plan.generationOutputPath), { recursive: true });
    await writeFile(plan.generationOutputPath, `${JSON.stringify(getGenerationReport(plan), undefined, 2)}\n`);
}

/**
 * @param {{
 *   classification: Awaited<ReturnType<typeof classifyManifest>>;
 *   inventory: import("./surface-inventory.mjs").SurfaceInventory;
 *   initiallySelectedUnitIds: Set<string>;
 * }} options
 */
function buildUnitTextOverrides(options) {
    const {
        classification,
        inventory,
        initiallySelectedUnitIds,
    } = options;

    /** @type {Map<string, string>} */
    const overrides = new Map();

    for (const row of classification.classifiedCompatRows) {
        if (row.includeInTarget) {
            continue;
        }

        for (const transform of row.transforms) {
            if (!initiallySelectedUnitIds.has(transform.unitId)) {
                continue;
            }

            const unit = inventory.unitById.get(transform.unitId);
            if (!unit) {
                throw new Error(`Unknown transform target unit ${transform.unitId}`);
            }

            const currentText = overrides.get(transform.unitId) ?? unit.text;
            overrides.set(transform.unitId, applyTransform(currentText, transform));
        }
    }

    return overrides;
}

/**
 * @param {{
 *   inventory: import("./surface-inventory.mjs").SurfaceInventory;
 *   initiallySelectedUnitIds: Set<string>;
 *   completeContainerUnitIds: Set<string>;
 *   excludedUnitIds: Set<string>;
 * }} options
 */
function resolveDependencyClosure(options) {
    const {
        inventory,
        initiallySelectedUnitIds,
        completeContainerUnitIds,
        excludedUnitIds,
    } = options;

    const selectedUnitIds = new Set(initiallySelectedUnitIds);
    const pending = [...selectedUnitIds];

    for (const completeContainerUnitId of completeContainerUnitIds) {
        includeCompleteContainerChildren({
            inventory,
            selectedUnitIds,
            pending,
            completeContainerUnitIds,
            declarationUnitId: completeContainerUnitId,
            excludedUnitIds,
        });
    }

    while (pending.length) {
        const unitId = pending.pop();
        if (!unitId) {
            continue;
        }
        const unit = inventory.unitById.get(unitId);
        if (!unit) {
            throw new Error(`Unknown inventory unit ${unitId}`);
        }

        for (const dependencyUnitId of resolveDependencyUnitIds(inventory, unit, selectedUnitIds)) {
            if (excludedUnitIds.has(dependencyUnitId)) {
                continue;
            }
            if (!selectedUnitIds.has(dependencyUnitId)) {
                selectedUnitIds.add(dependencyUnitId);
                pending.push(dependencyUnitId);
            }
            maybePromoteDependencyDeclarationToCompleteContainer({
                inventory,
                selectedUnitIds,
                pending,
                completeContainerUnitIds,
                declarationUnitId: dependencyUnitId,
                initiallySelectedUnitIds,
                excludedUnitIds,
            });
        }
    }

    return [...selectedUnitIds].sort(compareStringsCaseSensitive);
}

/**
 * @param {{
 *   inventory: import("./surface-inventory.mjs").SurfaceInventory;
 *   selectedUnitIds: string[];
 *   unitTextOverrides: Map<string, string>;
 *   completeContainerUnitIds: Set<string>;
 *   excludedUnitIds: Set<string>;
 * }} options
 */
function stabilizeCompilerGlobalSupport(options) {
    const {
        inventory,
        unitTextOverrides,
        completeContainerUnitIds,
        excludedUnitIds,
    } = options;

    const selectedUnitIds = new Set(options.selectedUnitIds);

    for (let iteration = 0; iteration < 8; iteration++) {
        const emittedText = emitSelectedUnits({
            inventory,
            selectedUnitIds,
            unitTextOverrides,
            completeContainerUnitIds,
            excludedUnitIds,
        });
        const compilerCheck = getCompilerDiagnostics(emittedText);
        if (!compilerCheck.missingGlobalTypes.length) {
            // Diagnostics other than missing global types (broken references,
            // corrupt syntax) are generation defects completion can't fix, so
            // fail on the spot.
            if (compilerCheck.otherDiagnostics.length) {
                throw new Error(
                    `Generated baseline lib does not compile standalone:\n${compilerCheck.otherDiagnostics
                        .map(message => `- ${message}`)
                        .join("\n")}`,
                );
            }
            return [...selectedUnitIds].sort(compareStringsCaseSensitive);
        }

        let changed = false;
        for (const missingGlobalType of compilerCheck.missingGlobalTypes) {
            for (const supportUnitId of resolveCompilerSupportUnitIds(inventory, missingGlobalType)) {
                if (excludedUnitIds.has(supportUnitId)) {
                    continue;
                }
                if (!selectedUnitIds.has(supportUnitId)) {
                    maybePromoteDependencyDeclarationToCompleteContainer({
                        inventory,
                        selectedUnitIds,
                        pending: [],
                        completeContainerUnitIds,
                        declarationUnitId: supportUnitId,
                        initiallySelectedUnitIds: selectedUnitIds,
                        excludedUnitIds,
                    });
                    selectedUnitIds.add(supportUnitId);
                    changed = true;
                }
            }
        }

        if (!changed) {
            throw new Error(`Unable to satisfy compiler-required global types: ${compilerCheck.missingGlobalTypes.join(", ")}`);
        }

        for (
            const unitId of resolveDependencyClosure({
                inventory,
                initiallySelectedUnitIds: selectedUnitIds,
                completeContainerUnitIds,
                excludedUnitIds,
            })
        ) {
            selectedUnitIds.add(unitId);
        }
    }

    throw new Error("Exceeded compiler support stabilization iterations while generating baseline lib");
}

/**
 * @param {import("./surface-inventory.mjs").SurfaceInventory} inventory
 * @param {string} symbolName
 */
function resolveCompilerSupportUnitIds(inventory, symbolName) {
    const rootSurface = getRootSurface(inventory, symbolName);
    if (rootSurface) {
        return resolveRootAvailabilityUnitIds(inventory, rootSurface);
    }

    return getPreferredDeclarationUnits(inventory, symbolName).map(unit => unit.id);
}

/**
 * @param {string} libText
 */
function getCompilerDiagnostics(libText) {
    const libFileName = "/lib.baseline.d.ts";
    const testFileName = "/baseline-support-check.ts";
    const files = new Map([
        [libFileName, libText],
        [testFileName, ""],
    ]);

    /** @type {ts.CompilerHost} */
    const host = {
        fileExists: fileName => files.has(fileName),
        readFile: fileName => files.get(fileName),
        getSourceFile(fileName, languageVersion) {
            const sourceText = files.get(fileName);
            return sourceText === undefined
                ? undefined
                : ts.createSourceFile(fileName, sourceText, languageVersion, /*setParentNodes*/ true, ts.ScriptKind.TS);
        },
        getDefaultLibFileName: () => libFileName,
        getCurrentDirectory: () => "/",
        getDirectories: () => [],
        directoryExists: directoryName => directoryName === "/",
        getCanonicalFileName: fileName => fileName,
        useCaseSensitiveFileNames: () => true,
        getNewLine: () => "\n",
        writeFile() {},
    };

    const program = ts.createProgram({
        rootNames: [libFileName, testFileName],
        options: {
            noLib: true,
            strict: true,
            target: ts.ScriptTarget.ESNext,
        },
        host,
    });

    /** @type {string[]} */
    const missingGlobalTypes = [];
    /** @type {string[]} */
    const otherDiagnostics = [];
    for (const diagnostic of ts.getPreEmitDiagnostics(program)) {
        const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
        if (diagnostic.code === 2318) {
            const globalTypeName = message.match(/Cannot find global type '([^']+)'/)?.[1];
            if (globalTypeName) {
                missingGlobalTypes.push(globalTypeName);
                continue;
            }
        }
        const position = diagnostic.file && diagnostic.start !== undefined
            ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
            : undefined;
        otherDiagnostics.push(
            position
                ? `TS${diagnostic.code} at ${diagnostic.file?.fileName}:${position.line + 1}:${position.character + 1}: ${message}`
                : `TS${diagnostic.code}: ${message}`,
        );
    }

    return {
        missingGlobalTypes: [...new Set(missingGlobalTypes)].sort(compareStringsCaseSensitive),
        otherDiagnostics,
    };
}

/**
 * @param {import("./surface-inventory.mjs").SurfaceInventory} inventory
 * @param {import("./surface-inventory.mjs").InventoryUnitRecord} unit
 * @param {Set<string>} selectedUnitIds
 */
function resolveDependencyUnitIds(inventory, unit, selectedUnitIds) {
    /** @type {string[]} */
    const dependencyUnitIds = [];

    for (const dependencySymbol of unit.dependencySymbols) {
        const selectedDeclarationUnits = getDeclarationUnits(inventory, dependencySymbol)
            .filter(declarationUnit => selectedUnitIds.has(declarationUnit.id));
        if (selectedDeclarationUnits.length) {
            dependencyUnitIds.push(...selectedDeclarationUnits.map(declarationUnit => declarationUnit.id));
        }

        const selectedMemberUnits = getOwnerMemberUnits(inventory, dependencySymbol)
            .filter(memberUnit => selectedUnitIds.has(memberUnit.id));
        if (selectedMemberUnits.length) {
            dependencyUnitIds.push(...selectedMemberUnits.map(memberUnit => memberUnit.id));
        }

        if (!selectedDeclarationUnits.length) {
            dependencyUnitIds.push(
                ...getPreferredDeclarationUnits(inventory, dependencySymbol).map(declarationUnit => declarationUnit.id),
            );
        }
    }

    return [...new Set(dependencyUnitIds)].sort(compareStringsCaseSensitive);
}

/**
 * @param {{
 *   inventory: import("./surface-inventory.mjs").SurfaceInventory;
 *   selectedUnitIds: Set<string>;
 *   pending: string[];
 *   completeContainerUnitIds: Set<string>;
 *   declarationUnitId: string;
 *   initiallySelectedUnitIds: Set<string>;
 *   excludedUnitIds: Set<string>;
 * }} options
 */
function maybePromoteDependencyDeclarationToCompleteContainer(options) {
    const {
        inventory,
        selectedUnitIds,
        pending,
        completeContainerUnitIds,
        declarationUnitId,
        initiallySelectedUnitIds,
        excludedUnitIds,
    } = options;

    const unit = inventory.unitById.get(declarationUnitId);
    if (!unit || unit.unitKind !== "declaration" || !unit.containerId || !unit.symbolName) {
        return;
    }
    if (initiallySelectedUnitIds.has(declarationUnitId) || completeContainerUnitIds.has(declarationUnitId)) {
        return;
    }

    const hasExplicitMemberSelection = getOwnerMemberUnits(inventory, unit.symbolName)
        .some(memberUnit => initiallySelectedUnitIds.has(memberUnit.id));
    if (hasExplicitMemberSelection) {
        return;
    }

    completeContainerUnitIds.add(declarationUnitId);
    includeCompleteContainerChildren({
        inventory,
        selectedUnitIds,
        pending,
        completeContainerUnitIds,
        declarationUnitId,
        excludedUnitIds,
    });
}

/**
 * @param {{
 *   inventory: import("./surface-inventory.mjs").SurfaceInventory;
 *   selectedUnitIds: Set<string>;
 *   pending: string[];
 *   completeContainerUnitIds: Set<string>;
 *   declarationUnitId: string;
 *   excludedUnitIds: Set<string>;
 * }} options
 */
function includeCompleteContainerChildren(options) {
    const {
        inventory,
        selectedUnitIds,
        pending,
        completeContainerUnitIds,
        declarationUnitId,
        excludedUnitIds,
    } = options;

    const unit = inventory.unitById.get(declarationUnitId);
    if (!unit || unit.unitKind !== "declaration" || !unit.containerId) {
        return;
    }
    completeContainerUnitIds.add(declarationUnitId);

    for (const childUnit of inventory.units
        .filter(candidate => candidate.parentContainerId === unit.containerId)
        .sort((left, right) =>
            left.order - right.order || compareStringsCaseSensitive(left.id, right.id)
        )) {
        // Even when the whole container is widely available, don't select a
        // child that an individual compat row excluded; it isn't Baseline surface.
        if (excludedUnitIds.has(childUnit.id)) {
            continue;
        }
        if (!selectedUnitIds.has(childUnit.id)) {
            selectedUnitIds.add(childUnit.id);
            pending.push(childUnit.id);
        }
    }
}

/**
 * @param {string} currentText
 * @param {{ kind: string; compatKey: string; }} transform
 */
function applyTransform(currentText, transform) {
    switch (transform.kind) {
        case "strip-inline-max-byte-length-option": {
            const updatedText = currentText.replace(/,\s*options\?:\s*\{\s*maxByteLength\?:\s*number;\s*\}/g, "");
            if (updatedText === currentText) {
                throw new Error(`Transform ${transform.kind} did not change the source for ${transform.compatKey}`);
            }
            return updatedText;
        }
        default:
            throw new Error(`Unsupported transform kind ${transform.kind}`);
    }
}

/**
 * @param {GenerationPlan} plan
 */
function getGenerationReport(plan) {
    return {
        snapshot: plan.manifest.snapshot.name,
        baselineTarget: plan.classification.baselineTarget,
        libSource: {
            basePackage: plan.manifest.libSource.basePackage,
            libContentHash: plan.manifest.libSource.libContentHash,
            libFileCount: plan.manifest.libSource.libFileCount,
        },
        topLevelLib: {
            libName: plan.manifest.firstClassLib.libName,
            outputPath: formatPathForReport(plan.repoRoot, plan.topLevelOutputPath),
        },
        datasetPath: formatPathForReport(plan.repoRoot, plan.classification.datasetPath),
        classificationOutputPath: formatPathForReport(plan.repoRoot, plan.classification.classificationOutputPath),
        compatManagementOutputPath: formatPathForReport(plan.repoRoot, plan.compatManagementOutputPath),
        inventoryOutputPath: formatPathForReport(plan.repoRoot, plan.inventoryOutputPath),
        summary: {
            sourceLibCount: plan.sourceLibEntries.length,
            classifiedCompatCount: plan.classification.classifiedCompatRows.length,
            selectedUnitCount: plan.selectedUnitIds.length,
            completeContainerCount: plan.completeContainerUnitIds.size,
            excludedUnitCount: plan.excludedUnitIds.size,
            preservedTypeOnlyUnitCount: plan.typeOnlyUnitIds.length,
            transformedUnitCount: plan.unitTextOverrides.size,
            allowEntryCount: plan.allowEntries.length,
            allowEntryUnitCount: plan.allowEntries.reduce((count, entry) => count + entry.unitIds.length, 0),
            allowSupportUnitCount: new Set(plan.allowSupportArtifacts.flatMap(artifact => artifact.unitIds)).size,
        },
        // Record sourcePath in canonical form (<basePackage>/lib/<file>). Don't
        // write the real path of the platform-specific package: it's
        // environment-dependent and breaks the determinism of checked-in
        // artifacts (regeneration must match across mac / CI Linux).
        sourceLibs: plan.sourceLibEntries.map(sourceLibEntry => ({
            sourceFileName: sourceLibEntry.sourceFileName,
            libFileName: sourceLibEntry.libFileName,
            sourcePath: sourceLibEntry.reportPath,
            sourceHash: sourceLibEntry.sourceHash,
        })),
        outputEntries: plan.outputEntries.map(entry => ({
            kind: entry.kind,
            outputPath: formatPathForReport(plan.repoRoot, entry.outputPath),
        })),
        preservedTypeOnlyUnits: [...plan.typeOnlyUnitIds].sort(compareStringsCaseSensitive),
        transformedUnits: [...plan.unitTextOverrides.keys()].sort(compareStringsCaseSensitive),
        allowEntries: plan.allowEntries.map(entry => ({
            kind: entry.kind,
            entryName: entry.entryName,
            outputPath: formatPathForReport(plan.repoRoot, entry.outputPath),
            compatKeys: entry.compatKeys,
            unitIds: entry.unitIds,
            supportUnitIds: entry.supportUnitIds,
        })),
        // For audit: which compat rows block which units from the artifact.
        excludedUnits: [...plan.excludedRowsByUnitId.entries()]
            .sort(([left], [right]) => compareStringsCaseSensitive(left, right))
            .map(([unitId, compatKeys]) => ({
                unitId,
                compatKeys: [...compatKeys].sort(compareStringsCaseSensitive),
            })),
    };
}

/**
 * @param {string} generationOutputPath
 * @param {string} repoRoot
 */
async function readPreviousOutputEntries(generationOutputPath, repoRoot) {
    try {
        /** @type {{ outputEntries?: Array<{ outputPath?: string }>; }} */
        const previousReport = JSON.parse(await readFile(generationOutputPath, "utf8"));
        /** @type {string[]} */
        const previousOutputEntries = [];
        for (const entry of previousReport.outputEntries ?? []) {
            if (!entry.outputPath) {
                continue;
            }
            previousOutputEntries.push(
                path.isAbsolute(entry.outputPath)
                    ? entry.outputPath
                    : path.resolve(repoRoot, entry.outputPath),
            );
        }
        return previousOutputEntries;
    }
    catch {
        return [];
    }
}

/**
 * @param {string} manifestPath
 */
async function readManifest(manifestPath) {
    return JSON.parse(await readFile(manifestPath, "utf8"));
}

/**
 * @typedef {{
 *   manifest: any;
 *   manifestPath: string;
 *   repoRoot: string;
 *   sourceLibEntries: import("./surface-inventory.mjs").BuiltinSourceLibEntry[];
 *   inventory: import("./surface-inventory.mjs").SurfaceInventory;
 *   classification: Awaited<ReturnType<typeof classifyManifest>>;
 *   inventoryOutputPath: string;
 *   generationOutputPath: string;
 *   compatManagementOutputPath: string;
 *   topLevelOutputPath: string;
 *   allowOutputDirectory: string;
 *   allowEntries: Array<{
 *     kind: string;
 *     entryName: string;
 *     compatKeys: string[];
 *     unitIds: string[];
 *     supportUnitIds: string[];
 *     outputPath: string;
 *   }>;
 *   allowSupportArtifacts: Array<{
 *     entryNames: string[];
 *     unitIds: string[];
 *     fileName: string;
 *     outputPath: string;
 *   }>;
 *   selectedUnitIds: string[];
 *   completeContainerUnitIds: Set<string>;
 *   excludedUnitIds: Set<string>;
 *   excludedRowsByUnitId: Map<string, string[]>;
 *   typeOnlyUnitIds: string[];
 *   unitTextOverrides: Map<string, string>;
 *   outputEntries: Array<{ kind: string; outputPath: string; }>;
 * }} GenerationPlan
 */
