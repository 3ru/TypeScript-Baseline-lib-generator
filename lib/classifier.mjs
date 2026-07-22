// @ts-check

import {
    mkdir,
    writeFile,
} from "node:fs/promises";
import path from "node:path";
import { loadCompatManagementRegistry } from "./compat-management-registry.mjs";
import { loadBaselineDataset } from "./dataset-loader.mjs";
import {
    compareStringsCaseSensitive,
    formatPathForReport,
    requireRelativeManifestPath,
    resolveOutputPath,
} from "./shared.mjs";
import {
    findLongestCompatRoot,
    getCompatSegments,
    getDeclarationUnits,
    getPreferredBaseDeclarationUnits,
    getPreferredMemberUnits,
    getRootSurface,
    isLibCompatKey,
} from "./surface-inventory.mjs";

const BEHAVIOR_QUALIFIERS = new Set([
    "anchored_sticky_flag",
    "Atomic_operations_on_non_shared_buffers",
    "computed_timezone",
    "configurable_true",
    "dom_objects",
    "empty_regex_string",
    "ES2015_behavior",
    "escaping",
    "extended_values",
    "generic_arrays_as_arguments",
    "iana_time_zone_names",
    "leading_zero_strings_as_decimal",
    "inferred_names",
    "IntlLegacyConstructedSymbol",
    "prototype_accessor",
    "iso_8601",
    "json_superset",
    "key_equality_for_zeros",
    "negative",
    "named_properties",
    "number_parameter-string_decimal",
    "serializable_object",
    "sharedarraybuffer_support",
    "stable_sorting",
    "string_values",
    "toString_revision",
    "unicode_code_point_escapes",
    "well_formed_stringify",
    "index_properties_not_consulting_prototype",
]);

const SIGNATURE_QUALIFIERS = new Set([
    "constructor_without_parameters",
    "iterable_allowed",
    "locales_parameter",
    "null_allowed",
    "options_parameter",
]);

const TYPED_ARRAY_INSTANCE_SYMBOLS = [
    "Int8Array",
    "Uint8Array",
    "Uint8ClampedArray",
    "Int16Array",
    "Uint16Array",
    "Int32Array",
    "Uint32Array",
    "Float16Array",
    "Float32Array",
    "Float64Array",
    "BigInt64Array",
    "BigUint64Array",
];

/**
 * Resolve which concrete typed arrays the BCD "TypedArray" abstract row maps
 * onto. Of the candidates (TYPED_ARRAY_INSTANCE_SYMBOLS), map only those whose
 * own root row is included in the baseline target. This structurally prevents
 * surface from leaking into a not-yet-Baseline typed array like Float16Array
 * via the abstract (high) row, while a typed array joins the mapping
 * automatically once it's promoted. If a candidate has no root row in the
 * dataset, that signals an upstream modeling change, so stop and fail closed.
 * Resolution runs only when a TypedArray row actually appears (lazy).
 *
 * @param {any[]} libCompatRows
 * @param {string} baselineTarget
 * @returns {() => { instanceSymbols: string[]; constructorSymbols: string[]; }}
 */
function createTypedArrayFamilyResolver(libCompatRows, baselineTarget) {
    /** @type {{ instanceSymbols: string[]; constructorSymbols: string[]; } | undefined} */
    let resolvedFamily;

    return () => {
        if (resolvedFamily) {
            return resolvedFamily;
        }

        /** @type {Map<string, string | boolean>} */
        const statusByCompatKey = new Map(
            libCompatRows.map(compatRow => [compatRow.compatKey, compatRow.baselineStatus]),
        );
        /** @type {string[]} */
        const missingSymbols = [];
        /** @type {string[]} */
        const instanceSymbols = [];

        for (const symbol of TYPED_ARRAY_INSTANCE_SYMBOLS) {
            const status = statusByCompatKey.get(`javascript.builtins.${symbol}`);
            if (status === undefined) {
                missingSymbols.push(symbol);
                continue;
            }
            if (isCompatIncluded(status, baselineTarget)) {
                instanceSymbols.push(symbol);
            }
        }

        if (missingSymbols.length) {
            throw new Error([
                "Typed array family resolution failed. The dataset is missing root compat rows for:",
                ...missingSymbols.map(symbol => `- javascript.builtins.${symbol}`),
                "Either upstream stopped modeling these typed arrays (update TYPED_ARRAY_INSTANCE_SYMBOLS deliberately)",
                "or the dataset extraction dropped rows (fix the dataset).",
            ].join("\n"));
        }
        if (!instanceSymbols.length) {
            throw new Error("Typed array family resolution produced no included typed arrays; refusing to classify TypedArray rows against an empty family");
        }

        resolvedFamily = {
            instanceSymbols,
            constructorSymbols: instanceSymbols.map(symbol => `${symbol}Constructor`),
        };
        return resolvedFamily;
    };
}

/**
 * @param {{
 *   manifest: any;
 *   manifestPath: string;
 *   repoRoot: string;
 *   inventory: import("./surface-inventory.mjs").SurfaceInventory;
 * }} options
 */
export async function classifyManifest(options) {
    const {
        manifest,
        manifestPath,
        repoRoot,
        inventory,
    } = options;
    const baselineTarget = manifest.baselineTarget ?? "high";
    const datasetPath = requireRelativeManifestPath(manifest.dataset, manifestPath, "dataset");
    const classificationOutputPath = resolveOutputPath(manifest.classificationOutput, manifestPath, "classification.json");
    const compatManagementOutputPath = resolveOutputPath(manifest.compatManagementOutput, manifestPath, "compat-management-report.json");
    const compatManagementRegistryPath = manifest.compatManagementRegistry
        ? requireRelativeManifestPath(manifest.compatManagementRegistry, manifestPath, "compatManagementRegistry")
        : undefined;
    if (!compatManagementRegistryPath) {
        throw new Error(`Manifest ${manifestPath} is missing compatManagementRegistry`);
    }

    const dataset = await loadBaselineDataset(datasetPath, manifest.snapshot.name);
    const libCompatRows = dataset.compatRows
        .filter(
            /** @param {any} compatRow */
            compatRow => isLibCompatKey(compatRow.compatKey),
        )
        .sort(
            /** @param {any} left @param {any} right */
            (left, right) => compareStringsCaseSensitive(left.compatKey, right.compatKey),
        );
    const compatManagementRegistry = await loadCompatManagementRegistry(compatManagementRegistryPath);

    const typedArrayFamily = createTypedArrayFamilyResolver(libCompatRows, baselineTarget);

    /** @type {ClassifiedCompatRow[]} */
    const classifiedCompatRows = [];
    for (const compatRow of libCompatRows) {
        classifiedCompatRows.push(classifyCompatRow({
            compatRow,
            baselineTarget,
            inventory,
            compatManagementRegistry,
            typedArrayFamily,
        }));
    }

    validateCompatManagementRegistry({
        classifiedCompatRows,
        compatManagementRegistry,
    });

    const compatManagementReport = getCompatManagementReport({
        snapshot: manifest.snapshot.name,
        baselineTarget,
        repoRoot,
        compatManagementRegistryPath,
        compatManagementOutputPath,
        classificationOutputPath,
        compatManagementRegistry,
        classifiedCompatRows,
    });

    const classification = {
        snapshot: manifest.snapshot.name,
        baselineTarget,
        datasetPath: formatPathForReport(repoRoot, datasetPath),
        classificationOutputPath: formatPathForReport(repoRoot, classificationOutputPath),
        compatManagementOutputPath: formatPathForReport(repoRoot, compatManagementOutputPath),
        summary: {
            featureCount: dataset.featureRows.length,
            compatCount: dataset.compatRows.length,
            libCompatCount: libCompatRows.length,
            highCompatCount: classifiedCompatRows.filter(row => row.baselineStatus === "high").length,
            lowCompatCount: classifiedCompatRows.filter(row => row.baselineStatus === "low").length,
            falseCompatCount: classifiedCompatRows.filter(row => row.baselineStatus === false).length,
            includedCompatCount: classifiedCompatRows.filter(row => row.includeInTarget).length,
            emitCompatCount: classifiedCompatRows.filter(row => row.resolutionKind !== "behavioral" && row.resolutionKind !== "root-availability" && row.resolutionKind !== "already-excluded-upstream").length,
            notModeledUpstreamCount: classifiedCompatRows.filter(row => row.resolutionKind === "not-modeled-upstream").length,
            alreadyExcludedUpstreamCount: classifiedCompatRows.filter(row => row.resolutionKind === "already-excluded-upstream").length,
            managedCompatCount: classifiedCompatRows.filter(row => row.management).length,
            managedCategoryCounts: countManagedRowsByKey(classifiedCompatRows, row => row.management?.category),
            managedDeliveryCounts: countManagedRowsByKey(classifiedCompatRows, row => row.management?.delivery),
            managedUpstreamStateCounts: countManagedRowsByKey(classifiedCompatRows, row => row.management?.upstreamState),
            selectedUnitCount: [...new Set(classifiedCompatRows.flatMap(row => row.includeInTarget ? row.resolvedUnitIds : []))].length,
            transformedUnitCount: [...new Set(classifiedCompatRows.flatMap(row => row.transforms.map(transform => transform.unitId)))].length,
        },
        compatManagementRegistryPath: formatPathForReport(repoRoot, compatManagementRegistryPath),
        compatManagementRegistrySummary: {
            kind: compatManagementRegistry.kind,
            schemaVersion: compatManagementRegistry.schemaVersion,
            sourceHash: compatManagementRegistry.sourceHash,
            groupCount: compatManagementRegistry.groups.length,
            managedCompatCount: compatManagementRegistry.entries.length,
        },
        classifiedCompatRows,
    };

    await mkdir(path.dirname(classificationOutputPath), { recursive: true });
    await writeFile(classificationOutputPath, `${JSON.stringify(classification, undefined, 2)}\n`);
    await mkdir(path.dirname(compatManagementOutputPath), { recursive: true });
    await writeFile(compatManagementOutputPath, `${JSON.stringify(compatManagementReport, undefined, 2)}\n`);

    return {
        ...classification,
        compatManagementReport,
        dataset,
        datasetPath,
        classificationOutputPath,
        compatManagementOutputPath,
    };
}

/**
 * @param {{
 *   classifiedCompatRows: ClassifiedCompatRow[];
 *   compatManagementRegistry: CompatManagementRegistry;
 * }} options
 */
function validateCompatManagementRegistry(options) {
    const {
        classifiedCompatRows,
        compatManagementRegistry,
    } = options;

    const actualManaged = classifiedCompatRows
        .filter(row => row.management)
        .map(row => row.compatKey)
        .sort(compareStringsCaseSensitive);
    const expectedManaged = compatManagementRegistry.entries
        .map(entry => entry.compatKey)
        .sort(compareStringsCaseSensitive);

    const unexpectedManaged = actualManaged.filter(compatKey => !expectedManaged.includes(compatKey));
    const staleManaged = expectedManaged.filter(compatKey => !actualManaged.includes(compatKey));
    const unmanagedSpecialCases = classifiedCompatRows
        .filter(row => isRegistryManagedResolutionKind(row.resolutionKind) && !row.management)
        .map(row => row.compatKey)
        .sort(compareStringsCaseSensitive);
    const incompatibleExpectedKinds = classifiedCompatRows
        .filter(row =>
            row.management?.expectedResolutionKinds
            && !row.management.expectedResolutionKinds.includes(row.resolutionKind)
        )
        .map(row => `${row.compatKey} (actual: ${row.resolutionKind}; expected: ${row.management?.expectedResolutionKinds?.join(", ")})`);

    const message = [
        unexpectedManaged.length || staleManaged.length || unmanagedSpecialCases.length || incompatibleExpectedKinds.length ?
            "compat management registry drift detected." :
            undefined,
        unexpectedManaged.length ? `Unexpected managed compat keys:\n${unexpectedManaged.map(compatKey => `- ${compatKey}`).join("\n")}` : undefined,
        staleManaged.length ? `Stale managed compat keys:\n${staleManaged.map(compatKey => `- ${compatKey}`).join("\n")}` : undefined,
        unmanagedSpecialCases.length ? `Special compat keys missing registry metadata:\n${unmanagedSpecialCases.map(compatKey => `- ${compatKey}`).join("\n")}` : undefined,
        incompatibleExpectedKinds.length ? `Compat keys whose resolution kind no longer matches registry expectations:\n${incompatibleExpectedKinds.map(value => `- ${value}`).join("\n")}` : undefined,
    ]
        .filter(Boolean)
        .join("\n\n");

    if (message) {
        throw new Error(message);
    }
}

/**
 * @param {{
 *   snapshot: string;
 *   baselineTarget: string;
 *   repoRoot: string;
 *   compatManagementRegistryPath: string;
 *   compatManagementOutputPath: string;
 *   classificationOutputPath: string;
 *   compatManagementRegistry: CompatManagementRegistry;
 *   classifiedCompatRows: ClassifiedCompatRow[];
 * }} options
 */
function getCompatManagementReport(options) {
    const {
        snapshot,
        baselineTarget,
        repoRoot,
        compatManagementRegistryPath,
        compatManagementOutputPath,
        classificationOutputPath,
        compatManagementRegistry,
        classifiedCompatRows,
    } = options;

    /** @type {Map<string, ClassifiedCompatRow[]>} */
    const rowsByGroupId = new Map();
    for (const row of classifiedCompatRows) {
        if (!row.management) {
            continue;
        }
        const rows = rowsByGroupId.get(row.management.groupId) ?? [];
        rows.push(row);
        rowsByGroupId.set(row.management.groupId, rows);
    }

    return {
        snapshot,
        baselineTarget,
        compatManagementRegistryPath: formatPathForReport(repoRoot, compatManagementRegistryPath),
        compatManagementOutputPath: formatPathForReport(repoRoot, compatManagementOutputPath),
        classificationOutputPath: formatPathForReport(repoRoot, classificationOutputPath),
        registry: {
            kind: compatManagementRegistry.kind,
            schemaVersion: compatManagementRegistry.schemaVersion,
            sourcePath: formatPathForReport(repoRoot, compatManagementRegistry.sourcePath),
            sourceHash: compatManagementRegistry.sourceHash,
            groupCount: compatManagementRegistry.groups.length,
            managedCompatCount: compatManagementRegistry.entries.length,
        },
        summary: {
            managedCompatCount: classifiedCompatRows.filter(row => row.management).length,
            managedCategoryCounts: countManagedRowsByKey(classifiedCompatRows, row => row.management?.category),
            managedDeliveryCounts: countManagedRowsByKey(classifiedCompatRows, row => row.management?.delivery),
            managedUpstreamStateCounts: countManagedRowsByKey(classifiedCompatRows, row => row.management?.upstreamState),
            managedResolutionKindCounts: countManagedRowsByKey(classifiedCompatRows, row => row.management ? row.resolutionKind : undefined),
        },
        groups: compatManagementRegistry.groups.map(group => {
            const rows = rowsByGroupId.get(group.id) ?? [];
            return {
                id: group.id,
                category: group.category,
                delivery: group.delivery,
                upstreamState: group.upstreamState,
                compatRoot: group.compatRoot,
                expectedResolutionKinds: group.expectedResolutionKinds,
                reason: group.reason,
                sourceUrls: group.sourceUrls,
                externalAction: group.externalAction,
                compatKeyCount: group.compatKeys.length,
                compatKeys: group.compatKeys,
                actualResolutionKinds: [...new Set(rows.map(row => row.resolutionKind))].sort(compareStringsCaseSensitive),
            };
        }),
    };
}

/**
 * @param {{
 *   compatRow: any;
 *   baselineTarget: string;
 *   inventory: import("./surface-inventory.mjs").SurfaceInventory;
 *   compatManagementRegistry: CompatManagementRegistry;
 *   typedArrayFamily: () => { instanceSymbols: string[]; constructorSymbols: string[]; };
 * }} options
 */
function classifyCompatRow(options) {
    const {
        compatRow,
        baselineTarget,
        inventory,
        compatManagementRegistry,
        typedArrayFamily,
    } = options;
    const compatSegments = getCompatSegments(compatRow.compatKey);
    const compatManagement = compatManagementRegistry.entryByCompatKey.get(compatRow.compatKey);
    const rootResolution = resolveCompatRoot(inventory, compatSegments, compatManagement, typedArrayFamily);
    if (!rootResolution) {
        return createClassifiedRow(
            compatRow,
            compatManagement?.compatRoot ?? compatSegments[0],
            isCompatIncluded(compatRow.baselineStatus, baselineTarget),
            {
                resolutionKind: "not-modeled-upstream",
                resolvedUnitIds: [],
                notes: `${compatRow.compatKey} does not map to a dedicated TypeScript lib root in the current inventory`,
                transforms: [],
            },
            compatManagement,
        );
    }
    const {
        compatRoot,
        rootSurface,
    } = rootResolution;
    const includeInTarget = isCompatIncluded(compatRow.baselineStatus, baselineTarget);

    if (!rootSurface) {
        return createClassifiedRow(compatRow, compatRoot, includeInTarget, {
            resolutionKind: "not-modeled-upstream",
            resolvedUnitIds: [],
            notes: `${compatRoot} is not currently modeled as a dedicated TypeScript lib surface`,
            transforms: [],
        }, compatManagement);
    }

    const tailSegments = compatSegments.slice(compatRoot.split(".").length);

    const manualResolution = resolveManualClassification({
        compatRow,
        compatRoot,
        tailSegments,
        inventory,
        includeInTarget,
        typedArrayFamily,
    });
    if (manualResolution) {
        return createClassifiedRow(compatRow, compatRoot, includeInTarget, manualResolution, compatManagement);
    }

    if (!tailSegments.length) {
        const resolvedUnitIds = resolveRootAvailabilityUnitIds(inventory, rootSurface);
        return createClassifiedRow(compatRow, compatRoot, includeInTarget, {
            resolutionKind: "root-availability",
            resolvedUnitIds,
            notes: resolvedUnitIds.length ?
                `compat root ${compatRoot} selects standalone declaration units` :
                `compat root ${compatRoot} is represented by child declarations and does not require a standalone selection`,
            transforms: [],
        }, compatManagement);
    }

    const rootBaseName = compatRoot.split(".").at(-1);
    const isConstructorTail = tailSegments[0] === rootBaseName;
    if (isConstructorTail) {
        return createClassifiedRow(
            compatRow,
            compatRoot,
            includeInTarget,
            classifyConstructorRow({
                compatRow,
                compatRoot,
                qualifierSegments: tailSegments.slice(1),
                includeInTarget,
                inventory,
                rootSurface,
            }),
            compatManagement,
        );
    }

    if (tailSegments.length === 1 && isBehaviorQualifier(tailSegments)) {
        return createClassifiedRow(compatRow, compatRoot, includeInTarget, {
            resolutionKind: "behavioral",
            resolvedUnitIds: [],
            notes: `${compatRow.compatKey} is tracked as root-level behavior on ${compatRoot}`,
            transforms: [],
        }, compatManagement);
    }

    return createClassifiedRow(
        compatRow,
        compatRoot,
        includeInTarget,
        classifyMemberRow({
            compatRow,
            compatRoot,
            memberName: tailSegments[0],
            qualifierSegments: tailSegments.slice(1),
            includeInTarget,
            inventory,
            rootSurface,
        }),
        compatManagement,
    );
}

/**
 * @param {import("./surface-inventory.mjs").SurfaceInventory} inventory
 * @param {string[]} compatSegments
 * @param {CompatManagementEntry | undefined} compatManagement
 * @param {() => { instanceSymbols: string[]; constructorSymbols: string[]; }} typedArrayFamily
 */
function resolveCompatRoot(inventory, compatSegments, compatManagement, typedArrayFamily) {
    const compatRoot = findLongestCompatRoot(inventory, compatSegments);
    if (compatRoot) {
        const rootSurface = getRootSurface(inventory, compatRoot);
        if (compatRoot === "Iterator" && rootSurface) {
            return {
                compatRoot,
                rootSurface: {
                    ...rootSurface,
                    instanceContainerSymbols: new Set([...rootSurface.instanceContainerSymbols, "IteratorObject"]),
                    staticContainerSymbols: new Set([...rootSurface.staticContainerSymbols]),
                },
                resolutionKind: "inventory",
            };
        }
        if (compatRoot === "AsyncIterator" && rootSurface) {
            return {
                compatRoot,
                rootSurface: {
                    ...rootSurface,
                    instanceContainerSymbols: new Set([...rootSurface.instanceContainerSymbols, "AsyncIteratorObject"]),
                    staticContainerSymbols: new Set([...rootSurface.staticContainerSymbols]),
                },
                resolutionKind: "inventory",
            };
        }
        return {
            compatRoot,
            rootSurface,
            resolutionKind: "inventory",
        };
    }

    switch (compatSegments[0]) {
        case "TypedArray": {
            const family = typedArrayFamily();
            return {
                compatRoot: "TypedArray",
                rootSurface: {
                    compatName: "TypedArray",
                    rootDeclarationUnitIds: [],
                    instanceContainerSymbols: new Set(family.instanceSymbols),
                    staticContainerSymbols: new Set(family.constructorSymbols),
                },
                resolutionKind: "synthetic-typed-array",
            };
        }
        default:
            if (compatManagement?.compatRoot) {
                return {
                    compatRoot: compatManagement.compatRoot,
                    rootSurface: getRootSurface(inventory, compatManagement.compatRoot),
                    resolutionKind: "registry-root",
                };
            }
            return undefined;
    }
}

/**
 * @param {{
 *   compatRow: any;
 *   compatRoot: string;
 *   qualifierSegments: string[];
 *   includeInTarget: boolean;
 *   inventory: import("./surface-inventory.mjs").SurfaceInventory;
 *   rootSurface: import("./surface-inventory.mjs").RootSurfaceRecord;
 * }} options
 */
function classifyConstructorRow(options) {
    const {
        compatRow,
        compatRoot,
        qualifierSegments,
        inventory,
        rootSurface,
    } = options;
    const staticContainerSymbols = [...rootSurface.staticContainerSymbols];
    const resolvedUnits = staticContainerSymbols.flatMap(symbol => [
        ...getPreferredMemberUnits(inventory, symbol, "<construct>"),
        ...getPreferredMemberUnits(inventory, symbol, "<call>"),
    ]);
    if (!resolvedUnits.length) {
        return {
            resolutionKind: "not-modeled-upstream",
            resolvedUnitIds: [],
            notes: `${compatRow.compatKey} is not currently modeled as a dedicated constructor surface in TypeScript's lib declarations`,
            transforms: [],
        };
    }
    const resolvedUnitIds = resolvedUnits.map(unit => unit.id);

    if (!qualifierSegments.length) {
        return {
            resolutionKind: "constructor",
            resolvedUnitIds,
            notes: `constructor surface for ${compatRoot}`,
            transforms: [],
        };
    }

    if (qualifierSegments.length === 1 && SIGNATURE_QUALIFIERS.has(qualifierSegments[0])) {
        return {
            resolutionKind: "signature-compat",
            resolvedUnitIds,
            notes: `${qualifierSegments[0]} is tracked against the constructor signature`,
            transforms: [],
        };
    }

    const optionProperty = getOptionPropertyName(qualifierSegments);
    if (optionProperty) {
        const propertyUnitIds = resolveOptionPropertyUnitIds({
            inventory,
            baseUnits: resolvedUnits,
            propertyName: optionProperty,
        });
        if (propertyUnitIds.length) {
            return {
                resolutionKind: "option-property",
                resolvedUnitIds: propertyUnitIds,
                notes: `${compatRow.compatKey} maps to option property ${optionProperty}`,
                transforms: [],
            };
        }
        return {
            resolutionKind: "not-modeled-upstream",
            resolvedUnitIds: [],
            notes: `${compatRow.compatKey} is not currently modeled as a dedicated option property in TypeScript's lib declarations`,
            transforms: [],
        };
    }

    if (isBehaviorQualifier(qualifierSegments)) {
        return {
            resolutionKind: "behavioral",
            resolvedUnitIds: [],
            notes: `${compatRow.compatKey} is tracked as behavior on the constructor surface`,
            transforms: [],
        };
    }

    return {
        resolutionKind: "not-modeled-upstream",
        resolvedUnitIds: [],
        notes: `${compatRow.compatKey} is not currently modeled as a dedicated constructor refinement in TypeScript's lib declarations`,
        transforms: [],
    };
}

/**
 * @param {{
 *   compatRow: any;
 *   compatRoot: string;
 *   memberName: string;
 *   qualifierSegments: string[];
 *   includeInTarget: boolean;
 *   inventory: import("./surface-inventory.mjs").SurfaceInventory;
 *   rootSurface: import("./surface-inventory.mjs").RootSurfaceRecord;
 * }} options
 */
function classifyMemberRow(options) {
    const {
        compatRow,
        compatRoot,
        memberName,
        qualifierSegments,
        inventory,
        rootSurface,
    } = options;

    const memberUnits = [
        ...[...rootSurface.staticContainerSymbols].flatMap(symbol => getPreferredMemberUnits(inventory, symbol, memberName)),
        ...[...rootSurface.instanceContainerSymbols].flatMap(symbol => getPreferredMemberUnits(inventory, symbol, memberName)),
    ].sort((left, right) => compareStringsCaseSensitive(left.id, right.id));

    if (!memberUnits.length) {
        if (isBehaviorQualifier(qualifierSegments)) {
            return {
                resolutionKind: "behavioral",
                resolvedUnitIds: [],
                notes: `${compatRow.compatKey} is tracked as behavior on ${compatRoot}.${memberName}`,
                transforms: [],
            };
        }

        const inheritedUnits = [
            ...[...rootSurface.instanceContainerSymbols].flatMap(symbol =>
                getDeclarationUnits(inventory, symbol)
                    .flatMap(unit => unit.dependencySymbols)
                    .flatMap(dependencySymbol => getPreferredMemberUnits(inventory, dependencySymbol, memberName))
            ),
            ...[...rootSurface.staticContainerSymbols].flatMap(symbol =>
                getDeclarationUnits(inventory, symbol)
                    .flatMap(unit => unit.dependencySymbols)
                    .flatMap(dependencySymbol => getPreferredMemberUnits(inventory, dependencySymbol, memberName))
            ),
        ];
        if (inheritedUnits.length) {
            return {
                resolutionKind: "inherited-member",
                resolvedUnitIds: [...new Set(inheritedUnits.map(unit => unit.id))].sort(compareStringsCaseSensitive),
                notes: `${compatRow.compatKey} is inherited through a referenced helper interface`,
                transforms: [],
            };
        }

        const directOptionUnits = getPreferredMemberUnits(inventory, `${compatRoot}Options`, memberName);
        if (directOptionUnits.length) {
            return {
                resolutionKind: "inherited-member",
                resolvedUnitIds: [...new Set(directOptionUnits.map(unit => unit.id))].sort(compareStringsCaseSensitive),
                notes: `${compatRow.compatKey} is provided through ${compatRoot}Options`,
                transforms: [],
            };
        }

        if (memberName === "@@dispose" || memberName === "@@asyncDispose") {
            return {
                resolutionKind: "not-modeled-upstream",
                resolvedUnitIds: [],
                notes: `${compatRow.compatKey} is not currently modeled as a dedicated member in TypeScript's lib declarations`,
                transforms: [],
            };
        }

        if (memberName === "toString" || memberName === "valueOf" || memberName === "toLocaleString") {
            return {
                resolutionKind: "inherited-member",
                resolvedUnitIds: [],
                notes: `${compatRow.compatKey} is inherited from shared object prototype declarations`,
                transforms: [],
            };
        }

        return {
            resolutionKind: "not-modeled-upstream",
            resolvedUnitIds: [],
            notes: `${compatRow.compatKey} is not currently modeled as a dedicated member in TypeScript's lib declarations`,
            transforms: [],
        };
    }
    const resolvedUnitIds = [...new Set(memberUnits.map(unit => unit.id))];

    if (!qualifierSegments.length) {
        return {
            resolutionKind: "member",
            resolvedUnitIds,
            notes: `member surface ${compatRoot}.${memberName}`,
            transforms: [],
        };
    }

    if (qualifierSegments.length === 1 && (SIGNATURE_QUALIFIERS.has(qualifierSegments[0]) || isParameterQualifier(qualifierSegments[0]))) {
        return {
            resolutionKind: "signature-compat",
            resolvedUnitIds,
            notes: `${qualifierSegments[0]} is tracked against ${compatRoot}.${memberName}`,
            transforms: [],
        };
    }

    const optionProperty = getOptionPropertyName(qualifierSegments);
    if (optionProperty) {
        const propertyUnitIds = resolveOptionPropertyUnitIds({
            inventory,
            baseUnits: memberUnits,
            propertyName: optionProperty,
        });
        if (propertyUnitIds.length) {
            return {
                resolutionKind: "option-property",
                resolvedUnitIds: propertyUnitIds,
                notes: `${compatRow.compatKey} maps to option property ${optionProperty}`,
                transforms: [],
            };
        }
        return {
            resolutionKind: "not-modeled-upstream",
            resolvedUnitIds: [],
            notes: `${compatRow.compatKey} is not currently modeled as a dedicated option property in TypeScript's lib declarations`,
            transforms: [],
        };
    }

    if (isBehaviorQualifier(qualifierSegments)) {
        return {
            resolutionKind: "behavioral",
            resolvedUnitIds: [],
            notes: `${compatRow.compatKey} is tracked as behavior on ${compatRoot}.${memberName}`,
            transforms: [],
        };
    }

    return {
        resolutionKind: "not-modeled-upstream",
        resolvedUnitIds: [],
        notes: `${compatRow.compatKey} is not currently modeled as a dedicated member refinement in TypeScript's lib declarations`,
        transforms: [],
    };
}

/**
 * @param {{
 *   compatRow: any;
 *   compatRoot: string;
 *   tailSegments: string[];
 *   inventory: import("./surface-inventory.mjs").SurfaceInventory;
 *   includeInTarget: boolean;
 *   typedArrayFamily: () => { instanceSymbols: string[]; constructorSymbols: string[]; };
 * }} options
 */
function resolveManualClassification(options) {
    const {
        compatRow,
        compatRoot,
        tailSegments,
        inventory,
    } = options;

    const qualifierPath = tailSegments.join(".");

    if (compatRow.compatKey === "javascript.builtins.RegExp.n") {
        // BCD represents RegExp's legacy static properties $1..$9 with a single
        // key "RegExp.n". TypeScript's lib models them individually as
        // "$1".."$9" on RegExpConstructor, so map them explicitly. Without the
        // mapping, this falls to not-modeled-upstream and could be emitted via
        // complete-container promotion despite being excluded (baselineStatus:
        // false).
        const legacyMatchUnits = Array.from({ length: 9 }, (_, index) => `$${index + 1}`)
            .flatMap(memberName => getPreferredMemberUnits(inventory, "RegExpConstructor", memberName));
        if (!legacyMatchUnits.length) {
            throw new Error(`Unable to resolve RegExpConstructor $1..$9 for ${compatRow.compatKey}`);
        }
        return {
            resolutionKind: "member",
            resolvedUnitIds: [...new Set(legacyMatchUnits.map(unit => unit.id))].sort(compareStringsCaseSensitive),
            notes: `${compatRow.compatKey} maps to the legacy RegExpConstructor $1..$9 static properties`,
            transforms: [],
        };
    }

    if (compatRow.compatKey === "javascript.builtins.JSON.parse.reviver_parameter_context_argument") {
        // Watchdog on a pinned verdict: this row is treated as excluded on the
        // assumption that TypeScript's JSON.parse reviver doesn't yet model the
        // context argument (TC39 source-text-access proposal). To stop that
        // assumption from silently going false the day TS models it, inspect the
        // current lib signature for real.
        const parseUnits = getPreferredMemberUnits(inventory, "JSON", "parse");
        if (!parseUnits.length) {
            throw new Error(
                `${compatRow.compatKey}: could not find JSON.parse in the current lib to verify the reviver signature. `
                + "The fossilized 'already-excluded-upstream' verdict can no longer be trusted; re-evaluate this row.",
            );
        }
        const modelsContextArgument = parseUnits.some(unit => /reviver[\s\S]*\bcontext\b/u.test(unit.text));
        if (modelsContextArgument) {
            throw new Error(
                `${compatRow.compatKey}: TypeScript's JSON.parse now appears to model the reviver context argument `
                + "(the lib signature mentions `context`). The 'already-excluded-upstream' verdict is stale — "
                + "re-evaluate whether this row should now be included or re-classified.",
            );
        }
        return {
            resolutionKind: "already-excluded-upstream",
            resolvedUnitIds: [],
            notes: "TypeScript's built-in JSON.parse signature does not currently model the reviver context argument",
            transforms: [],
        };
    }

    if (compatRoot === "Proxy" && tailSegments[0] === "handler" && tailSegments[1]) {
        const handlerMemberName = tailSegments[1];
        const handlerUnits = getPreferredMemberUnits(inventory, "ProxyHandler", handlerMemberName);
        if (!handlerUnits.length) {
            throw new Error(`Unable to resolve ProxyHandler.${handlerMemberName} for ${compatRow.compatKey}`);
        }
        return {
            resolutionKind: "member",
            resolvedUnitIds: handlerUnits.map(unit => unit.id),
            notes: `${compatRow.compatKey} maps to ProxyHandler.${handlerMemberName}`,
            transforms: [],
        };
    }

    if (compatRoot === "TypedArray") {
        if (qualifierPath === "constructor_without_parameters" || qualifierPath === "iterable_in_constructor") {
            const constructorUnits = options.typedArrayFamily().constructorSymbols
                .flatMap(symbol => getPreferredMemberUnits(inventory, symbol, "<construct>"));
            if (!constructorUnits.length) {
                throw new Error(`Unable to resolve typed array constructors for ${compatRow.compatKey}`);
            }
            return {
                resolutionKind: "signature-compat",
                resolvedUnitIds: [...new Set(constructorUnits.map(unit => unit.id))].sort(compareStringsCaseSensitive),
                notes: `${compatRow.compatKey} is tracked against typed array constructor signatures`,
                transforms: [],
            };
        }

        if (qualifierPath === "name") {
            const functionNameUnits = getPreferredMemberUnits(inventory, "Function", "name");
            if (!functionNameUnits.length) {
                throw new Error(`Unable to resolve Function.name for ${compatRow.compatKey}`);
            }
            return {
                resolutionKind: "inherited-member",
                resolvedUnitIds: [...new Set(functionNameUnits.map(unit => unit.id))].sort(compareStringsCaseSensitive),
                notes: `${compatRow.compatKey} is inherited from Function.name`,
                transforms: [],
            };
        }
    }

    if (qualifierPath === "symbol_as_keys" || qualifierPath.endsWith(".symbol_as_target")) {
        const symbolUnits = getPreferredMemberUnits(inventory, "WeakKeyTypes", "symbol");
        if (!symbolUnits.length) {
            throw new Error(`Unable to resolve WeakKeyTypes.symbol for ${compatRow.compatKey}`);
        }
        return {
            resolutionKind: "type-property",
            resolvedUnitIds: symbolUnits.map(unit => unit.id),
            notes: `${compatRow.compatKey} maps to WeakKeyTypes.symbol`,
            transforms: [],
        };
    }

    if (qualifierPath === `${compatRoot.split(".").at(-1)}.maxByteLength_option` || qualifierPath === "maxByteLength_option") {
        const rootSurface = getRootSurface(inventory, compatRoot);
        if (!rootSurface) {
            throw new Error(`Missing root surface for ${compatRoot}`);
        }
        const constructorUnits = [...rootSurface.staticContainerSymbols]
            .flatMap(symbol => getPreferredMemberUnits(inventory, symbol, "<construct>"))
            .filter(unit => unit.text.includes("maxByteLength"));
        if (!constructorUnits.length) {
            throw new Error(`Unable to resolve constructor for ${compatRow.compatKey}`);
        }
        return {
            resolutionKind: "transform-only",
            resolvedUnitIds: constructorUnits.map(unit => unit.id),
            notes: `${compatRow.compatKey} strips the inline maxByteLength option from the constructor signature`,
            transforms: constructorUnits.map(unit => ({
                unitId: unit.id,
                kind: "strip-inline-max-byte-length-option",
                compatKey: compatRow.compatKey,
            })),
        };
    }

    return undefined;
}

/**
 * @param {any} compatRow
 * @param {string} compatRoot
 * @param {boolean} includeInTarget
 * @param {{
 *   resolutionKind: string;
 *   resolvedUnitIds: string[];
 *   notes: string;
 *   transforms: Array<{ unitId: string; kind: string; compatKey: string; }>;
 * }} resolution
 * @param {CompatManagementEntry | undefined} compatManagement
 */
function createClassifiedRow(compatRow, compatRoot, includeInTarget, resolution, compatManagement) {
    return {
        compatKey: compatRow.compatKey,
        featureId: compatRow.featureId,
        featureName: compatRow.featureName,
        baselineStatus: compatRow.baselineStatus,
        baselineLowDate: compatRow.baselineLowDate,
        baselineHighDate: compatRow.baselineHighDate,
        sourceRefs: compatRow.sourceRefs ?? [],
        snapshot: compatRow.snapshot ?? [],
        compatRoot,
        includeInTarget,
        resolutionKind: resolution.resolutionKind,
        resolvedUnitIds: [...resolution.resolvedUnitIds].sort(compareStringsCaseSensitive),
        transforms: resolution.transforms,
        notes: resolution.notes,
        management: compatManagement ? {
            groupId: compatManagement.groupId,
            category: compatManagement.category,
            delivery: compatManagement.delivery,
            upstreamState: compatManagement.upstreamState,
            reason: compatManagement.reason,
            sourceUrls: compatManagement.sourceUrls,
            externalAction: compatManagement.externalAction,
            expectedResolutionKinds: compatManagement.expectedResolutionKinds,
        } : undefined,
    };
}

/**
 * @param {import("./surface-inventory.mjs").SurfaceInventory} inventory
 * @param {import("./surface-inventory.mjs").RootSurfaceRecord} rootSurface
 */
export function resolveRootAvailabilityUnitIds(inventory, rootSurface) {
    const rootDeclarationUnits = rootSurface.rootDeclarationUnitIds
        .map(unitId => inventory.unitById.get(unitId))
        .filter(isPresent);

    const directRootUnits = rootDeclarationUnits.filter(unit =>
        unit
        && unit.unitKind === "declaration"
    );

    /** @type {string[]} */
    const resolvedUnitIds = [];

    for (const directRootUnit of directRootUnits) {
        if (!directRootUnit.containerId || isStandaloneRootDeclarationKind(directRootUnit.declarationKind)) {
            resolvedUnitIds.push(directRootUnit.id);
        }
    }

    for (
        const symbol of [
            ...rootSurface.instanceContainerSymbols,
            ...rootSurface.staticContainerSymbols,
        ]
    ) {
        resolvedUnitIds.push(
            ...getPreferredBaseDeclarationUnits(inventory, symbol).map(unit => unit.id),
        );
    }

    if (!resolvedUnitIds.length) {
        const canonicalRootUnit = directRootUnits
            .filter(unit => unit.unitKind === "declaration")
            .sort((left, right) =>
                compareStringsCaseSensitive(left.libFileName, right.libFileName)
                || left.order - right.order
                || compareStringsCaseSensitive(left.id, right.id)
            )
            .at(0);
        if (canonicalRootUnit) {
            resolvedUnitIds.push(canonicalRootUnit.id);
        }
    }

    return [...new Set(resolvedUnitIds)].sort(compareStringsCaseSensitive);
}

/**
 * @param {string} declarationKind
 */
function isStandaloneRootDeclarationKind(declarationKind) {
    return declarationKind === "var" || declarationKind === "function" || declarationKind === "enum" || declarationKind === "type-alias";
}

/**
 * @template T
 * @param {T | undefined | null} value
 * @returns {value is T}
 */
function isPresent(value) {
    return value !== undefined && value !== null;
}

/**
 * @param {{
 *   inventory: import("./surface-inventory.mjs").SurfaceInventory;
 *   baseUnits: import("./surface-inventory.mjs").InventoryUnitRecord[];
 *   propertyName: string;
 * }} options
 */
function resolveOptionPropertyUnitIds(options) {
    const {
        inventory,
        baseUnits,
        propertyName,
    } = options;

    const optionSymbols = new Set();
    for (const unit of baseUnits) {
        for (const dependencySymbol of unit.dependencySymbols) {
            if (dependencySymbol.endsWith("Options")) {
                optionSymbols.add(dependencySymbol);
            }
        }

        for (const match of unit.text.matchAll(/\b([A-Z][A-Za-z0-9]+Options)\b/g)) {
            optionSymbols.add(match[1]);
            if (unit.ownerSymbol?.includes(".")) {
                const ownerNamespace = unit.ownerSymbol.split(".").slice(0, -1).join(".");
                optionSymbols.add(`${ownerNamespace}.${match[1]}`);
            }
        }
    }

    const resolvedUnits = [];
    for (const optionSymbol of optionSymbols) {
        resolvedUnits.push(...getPreferredMemberUnits(inventory, optionSymbol, propertyName));
        const resolvedOptionSymbol = getResolvedOptionsSymbol(optionSymbol);
        if (resolvedOptionSymbol) {
            resolvedUnits.push(...getPreferredMemberUnits(inventory, resolvedOptionSymbol, propertyName));
        }
    }

    return [...new Set(resolvedUnits.map(unit => unit.id))].sort(compareStringsCaseSensitive);
}

/**
 * @param {string} optionSymbol
 */
function getResolvedOptionsSymbol(optionSymbol) {
    if (!optionSymbol.endsWith("Options")) {
        return undefined;
    }
    const baseName = optionSymbol.slice(0, -"Options".length);
    const resolvedName = `${baseName.startsWith("Intl.") ? "Intl." : ""}Resolved${baseName.replace(/^Intl\./, "")}Options`;
    return resolvedName;
}

/**
 * @param {string[]} qualifierSegments
 */
function getOptionPropertyName(qualifierSegments) {
    for (const qualifier of qualifierSegments) {
        const optionsMatch = qualifier.match(/^options_(.+)_parameter$/);
        if (optionsMatch) {
            return optionsMatch[1];
        }
    }
    return undefined;
}

/**
 * @param {string} qualifier
 */
function isParameterQualifier(qualifier) {
    return qualifier.endsWith("_parameter") || qualifier.startsWith("optional_");
}

/**
 * @param {string[]} qualifierSegments
 */
function isBehaviorQualifier(qualifierSegments) {
    return qualifierSegments.some(segment => BEHAVIOR_QUALIFIERS.has(segment));
}

/**
 * @param {string | boolean | undefined} baselineStatus
 * @param {string} baselineTarget
 */
function isCompatIncluded(baselineStatus, baselineTarget) {
    switch (baselineTarget) {
        case "high":
            return baselineStatus === "high";
        case "low":
            return baselineStatus === "high" || baselineStatus === "low";
        default:
            throw new Error(`Unsupported baseline target ${baselineTarget}`);
    }
}

/**
 * @param {ClassifiedCompatRow[]} rows
 * @param {(row: ClassifiedCompatRow) => string | undefined} selector
 */
function countManagedRowsByKey(rows, selector) {
    /** @type {Record<string, number>} */
    const counts = {};
    for (const row of rows) {
        const key = selector(row);
        if (!key) {
            continue;
        }
        counts[key] = (counts[key] ?? 0) + 1;
    }
    return Object.keys(counts)
        .sort(compareStringsCaseSensitive)
        .reduce((result, key) => {
            result[key] = counts[key];
            return result;
        }, /** @type {Record<string, number>} */ ({}));
}

/**
 * @param {string} resolutionKind
 */
function isRegistryManagedResolutionKind(resolutionKind) {
    return resolutionKind === "not-modeled-upstream" || resolutionKind === "already-excluded-upstream";
}

/**
 * @typedef {{
 *   compatKey: string;
 *   featureId: string;
 *   featureName: string;
 *   baselineStatus: string | boolean | undefined;
 *   baselineLowDate?: string;
 *   baselineHighDate?: string;
 *   sourceRefs: string[];
 *   snapshot: string[];
 *   compatRoot: string;
 *   includeInTarget: boolean;
 *   resolutionKind: string;
 *   resolvedUnitIds: string[];
 *   transforms: Array<{ unitId: string; kind: string; compatKey: string; }>;
 *   notes: string;
 *   management?: {
 *     groupId: string;
 *     category: string;
 *     delivery: string;
 *     upstreamState: string;
 *     reason: string;
 *     sourceUrls: string[];
 *     externalAction?: any;
 *     expectedResolutionKinds?: string[];
 *   };
 * }} ClassifiedCompatRow
 */

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
 *   reason: string;
 *   sourceUrls: string[];
 *   externalAction?: any;
 * }} CompatManagementEntry
 */

/**
 * @typedef {{
 *   kind: string;
 *   schemaVersion: number;
 *   sourcePath: string;
 *   sourceHash: string;
 *   groups: CompatManagementGroupRecord[];
 *   entries: CompatManagementEntry[];
 *   entryByCompatKey: Map<string, CompatManagementEntry>;
 * }} CompatManagementRegistry
 */
