// @ts-check

import {
    mkdir,
    readFile,
    rm,
    writeFile,
} from "node:fs/promises";
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

const RUNTIME_DECLARATION_KINDS = new Set(["var", "function", "class", "enum", "namespace"]);

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
        ],
    };
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
 *   selectedUnitIds: string[];
 *   completeContainerUnitIds: Set<string>;
 *   excludedUnitIds: Set<string>;
 *   excludedRowsByUnitId: Map<string, string[]>;
 *   typeOnlyUnitIds: string[];
 *   unitTextOverrides: Map<string, string>;
 *   outputEntries: Array<{ kind: string; outputPath: string; }>;
 * }} GenerationPlan
 */
