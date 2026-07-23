// @ts-check

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
    cleanupTempDirectories,
    createTempDirectory,
    writeJsonFile,
} from "./helpers.mjs";
import { classifyManifest } from "../lib/classifier.mjs";
import {
    createSurfaceInventory,
    discoverBuiltinSourceLibEntries,
} from "../lib/surface-inventory.mjs";

/** @type {string[]} */
const tempDirectories = [];

test.afterEach(() => {
    cleanupTempDirectories(tempDirectories);
});

// Fixture that pins the classifier's decision logic directly with synthetic
// compat rows, not the incidental shape of the pinned dataset.
const FIXTURE_LIB_SOURCE = [
    "interface HelperBag {",
    "    inheritedThing(): void;",
    "}",
    "interface WidgetOptions {",
    "    size?: number;",
    "}",
    "interface Widget extends HelperBag {",
    "    configure(options: WidgetOptions): void;",
    "    toy(): void;",
    "}",
    "declare var Widget: WidgetConstructor;",
    "interface WidgetConstructor {",
    "    new(options?: WidgetOptions): Widget;",
    "    readonly prototype: Widget;",
    "}",
    // typed array family: the classifier requires root rows for all 12 kinds,
    // so the fixture lib declares every one of them.
    "interface Int8Array {",
    "    at(index: number): number;",
    "}",
    "declare var Int8Array: Int8ArrayConstructor;",
    "interface Int8ArrayConstructor {",
    "    new(length: number): Int8Array;",
    "    readonly prototype: Int8Array;",
    "}",
    "interface Uint8Array {",
    "    at(index: number): number;",
    "}",
    "declare var Uint8Array: Uint8ArrayConstructor;",
    "interface Uint8ArrayConstructor {",
    "    new(length: number): Uint8Array;",
    "    readonly prototype: Uint8Array;",
    "}",
    "interface Uint8ClampedArray {",
    "    at(index: number): number;",
    "}",
    "declare var Uint8ClampedArray: Uint8ClampedArrayConstructor;",
    "interface Uint8ClampedArrayConstructor {",
    "    new(length: number): Uint8ClampedArray;",
    "    readonly prototype: Uint8ClampedArray;",
    "}",
    "interface Int16Array {",
    "    at(index: number): number;",
    "}",
    "declare var Int16Array: Int16ArrayConstructor;",
    "interface Int16ArrayConstructor {",
    "    new(length: number): Int16Array;",
    "    readonly prototype: Int16Array;",
    "}",
    "interface Uint16Array {",
    "    at(index: number): number;",
    "}",
    "declare var Uint16Array: Uint16ArrayConstructor;",
    "interface Uint16ArrayConstructor {",
    "    new(length: number): Uint16Array;",
    "    readonly prototype: Uint16Array;",
    "}",
    "interface Int32Array {",
    "    at(index: number): number;",
    "}",
    "declare var Int32Array: Int32ArrayConstructor;",
    "interface Int32ArrayConstructor {",
    "    new(length: number): Int32Array;",
    "    readonly prototype: Int32Array;",
    "}",
    "interface Uint32Array {",
    "    at(index: number): number;",
    "}",
    "declare var Uint32Array: Uint32ArrayConstructor;",
    "interface Uint32ArrayConstructor {",
    "    new(length: number): Uint32Array;",
    "    readonly prototype: Uint32Array;",
    "}",
    "interface Float16Array {",
    "    at(index: number): number;",
    "}",
    "declare var Float16Array: Float16ArrayConstructor;",
    "interface Float16ArrayConstructor {",
    "    new(length: number): Float16Array;",
    "    readonly prototype: Float16Array;",
    "}",
    "interface Float32Array {",
    "    at(index: number): number;",
    "}",
    "declare var Float32Array: Float32ArrayConstructor;",
    "interface Float32ArrayConstructor {",
    "    new(length: number): Float32Array;",
    "    readonly prototype: Float32Array;",
    "}",
    "interface Float64Array {",
    "    at(index: number): number;",
    "}",
    "declare var Float64Array: Float64ArrayConstructor;",
    "interface Float64ArrayConstructor {",
    "    new(length: number): Float64Array;",
    "    readonly prototype: Float64Array;",
    "}",
    "interface BigInt64Array {",
    "    at(index: number): number;",
    "}",
    "declare var BigInt64Array: BigInt64ArrayConstructor;",
    "interface BigInt64ArrayConstructor {",
    "    new(length: number): BigInt64Array;",
    "    readonly prototype: BigInt64Array;",
    "}",
    "interface BigUint64Array {",
    "    at(index: number): number;",
    "}",
    "declare var BigUint64Array: BigUint64ArrayConstructor;",
    "interface BigUint64ArrayConstructor {",
    "    new(length: number): BigUint64Array;",
    "    readonly prototype: BigUint64Array;",
    "}",
    "interface Iterator<T> extends IteratorObject {",
    "    next(): T;",
    "}",
    "interface IteratorObject {",
    "    map(callback: unknown): IteratorObject;",
    "}",
    "interface IArguments {",
    "    [index: number]: any;",
    "    length: number;",
    "    callee: Function;",
    "    [Symbol.iterator](): Iterator<any>;",
    "}",
    "",
].join("\n");

/**
 * @param {{
 *   rows: Array<Record<string, unknown>>;
 *   declarationMappings?: Record<string, Record<string, unknown>>;
 *   additionalLibSources?: Record<string, string>;
 *   registryGroups?: Array<Record<string, unknown>>;
 *   baselineTarget?: string;
 *   libSource?: string;
 * }} options
 */
async function classifyFixture(options) {
    const tempDirectory = createTempDirectory(tempDirectories);
    const libDirectory = path.join(tempDirectory, "node_modules", "typescript", "lib");
    fs.mkdirSync(libDirectory, { recursive: true });
    writeJsonFile(path.join(tempDirectory, "node_modules", "typescript", "package.json"), {
        name: "typescript",
        version: "0.0.0-test",
    });
    fs.writeFileSync(path.join(libDirectory, "lib.es5.d.ts"), options.libSource ?? FIXTURE_LIB_SOURCE);
    for (const [fileName, sourceText] of Object.entries(options.additionalLibSources ?? {})) {
        fs.writeFileSync(path.join(libDirectory, fileName), sourceText);
    }

    const sourceLibEntries = await discoverBuiltinSourceLibEntries({
        libDirectory,
        reportPathPrefix: "typescript/lib",
    });
    const inventory = await createSurfaceInventory({
        snapshotName: "classifier-test",
        repoRoot: tempDirectory,
        sourceLibEntries,
        inventoryOutputPath: path.join(tempDirectory, "out", "inventory.json"),
    });

    writeJsonFile(path.join(tempDirectory, "dataset.json"), {
        snapshot: { name: "classifier-test" },
        featureRows: [{ featureId: "widget-fixture" }],
        compatRows: options.rows,
    });
    writeJsonFile(path.join(tempDirectory, "registry.json"), {
        kind: "typescript-baseline-lib/compat-management-registry",
        schemaVersion: 1,
        ...(options.declarationMappings ? { declarationMappings: options.declarationMappings } : {}),
        compilerSupport: [],
        runtimeAliases: [],
        groups: options.registryGroups ?? [],
    });

    const manifestPath = path.join(tempDirectory, "manifest.json");
    const manifest = {
        snapshot: { name: "classifier-test" },
        ...(options.baselineTarget ? { baselineTarget: options.baselineTarget } : {}),
        dataset: "dataset.json",
        compatManagementRegistry: "registry.json",
        classificationOutput: "derived/current/classification.json",
        compatManagementOutput: "derived/current/compat-management-report.json",
    };
    writeJsonFile(manifestPath, manifest);

    return classifyManifest({
        manifest,
        manifestPath,
        repoRoot: tempDirectory,
        inventory,
    });
}

/**
 * @param {string} compatKey
 * @param {string | boolean} baselineStatus
 */
function row(compatKey, baselineStatus) {
    return {
        compatKey,
        featureId: "widget-fixture",
        featureName: "Widget fixture",
        baselineStatus,
        ...(baselineStatus === false ? {} : { baselineLowDate: "2020-01-01" }),
    };
}

// When resolving the abstract TypedArray row, the classifier requires that
// every known typed array has a root row in the dataset (fail-closed). This
// helper supplies all 12 root rows and overrides status only where needed.
/**
 * @param {Record<string, string | boolean>} [overrides]
 */
function typedArrayFamilyRows(overrides = {}) {
    const names = [
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
    return names.map(name => row(`javascript.builtins.${name}`, overrides[name] ?? "high"));
}

/**
 * @param {Awaited<ReturnType<typeof classifyManifest>>} classification
 * @param {string} compatKey
 */
function findRow(classification, compatKey) {
    const found = classification.classifiedCompatRows.find(candidate => candidate.compatKey === compatKey);
    assert.ok(found, `expected classified row for ${compatKey}`);
    return found;
}

test("classifier routes synthetic compat rows to the expected resolution kinds", async () => {
    const classification = await classifyFixture({
        rows: [
            row("javascript.builtins.Widget", "high"),
            row("javascript.builtins.Widget.configure", "high"),
            row("javascript.builtins.Widget.inheritedThing", "high"),
            row("javascript.builtins.Widget.Widget", "high"),
            row("javascript.builtins.Widget.Widget.options_parameter", "low"),
            row("javascript.builtins.Widget.Widget.options_size_parameter", "low"),
            row("javascript.builtins.Widget.configure.options_size_parameter.extended_values", "high"),
            row("javascript.builtins.Widget.toy.stable_sorting", "high"),
            row("javascript.builtins.Widget.toString.escaping", "high"),
            row("javascript.builtins.TypedArray.at", "high"),
            row("javascript.builtins.Iterator.map", "low"),
            row("javascript.functions.arguments", "high"),
            row("javascript.functions.arguments.@@iterator", "high"),
            row("javascript.functions.arguments.callee", false),
            row("javascript.functions.arguments.length", "high"),
            ...typedArrayFamilyRows({ Float16Array: "low" }),
        ],
    });

    const rootRow = findRow(classification, "javascript.builtins.Widget");
    assert.equal(rootRow.resolutionKind, "root-availability");
    assert.ok(rootRow.includeInTarget);
    assert.ok(rootRow.resolvedUnitIds.length > 0);

    const memberRow = findRow(classification, "javascript.builtins.Widget.configure");
    assert.equal(memberRow.resolutionKind, "member");
    assert.ok(memberRow.resolvedUnitIds.some(unitId => unitId.includes("Widget.configure")));

    // Path revived in B2: inherited-member resolution through a heritage dependency (HelperBag).
    const inheritedRow = findRow(classification, "javascript.builtins.Widget.inheritedThing");
    assert.equal(inheritedRow.resolutionKind, "inherited-member");
    assert.ok(inheritedRow.resolvedUnitIds.some(unitId => unitId.includes("HelperBag.inheritedThing")));

    const constructorRow = findRow(classification, "javascript.builtins.Widget.Widget");
    assert.equal(constructorRow.resolutionKind, "constructor");
    assert.ok(constructorRow.resolvedUnitIds.some(unitId => unitId.includes("WidgetConstructor.<construct>")));
    assert.ok(constructorRow.resolvedUnitIds.some(unitId => unitId.includes("WidgetConstructor.prototype")));
    assert.ok(constructorRow.resolvedUnitIds.some(unitId => unitId.includes("::Widget::")));

    const signatureRow = findRow(classification, "javascript.builtins.Widget.Widget.options_parameter");
    assert.equal(signatureRow.resolutionKind, "signature-compat");
    assert.equal(signatureRow.includeInTarget, false);

    // Options interface resolution via a dependency symbol (the other path revived in B2).
    const optionRow = findRow(classification, "javascript.builtins.Widget.Widget.options_size_parameter");
    assert.equal(optionRow.resolutionKind, "option-property");
    assert.ok(optionRow.resolvedUnitIds.some(unitId => unitId.includes("WidgetOptions.size")));

    const qualifiedOptionRow = findRow(
        classification,
        "javascript.builtins.Widget.configure.options_size_parameter.extended_values",
    );
    assert.equal(qualifiedOptionRow.resolutionKind, "option-property");
    assert.ok(qualifiedOptionRow.resolvedUnitIds.some(unitId => unitId.includes("WidgetOptions.size")));

    const behaviorRow = findRow(classification, "javascript.builtins.Widget.toy.stable_sorting");
    assert.equal(behaviorRow.resolutionKind, "behavioral");
    assert.deepEqual(behaviorRow.resolvedUnitIds, []);

    const inheritedBehaviorRow = findRow(classification, "javascript.builtins.Widget.toString.escaping");
    assert.equal(inheritedBehaviorRow.resolutionKind, "behavioral");
    assert.deepEqual(inheritedBehaviorRow.resolvedUnitIds, []);

    // Synthetic TypedArray root: BCD's "TypedArray" expands to individual typed array types.
    // But only typed arrays whose own root row is in the target get mapped.
    const typedArrayRow = findRow(classification, "javascript.builtins.TypedArray.at");
    assert.equal(typedArrayRow.resolutionKind, "member");
    assert.ok(typedArrayRow.resolvedUnitIds.some(unitId => unitId.includes("Int8Array.at")));
    assert.ok(
        !typedArrayRow.resolvedUnitIds.some(unitId => unitId.includes("Float16Array")),
        "surface must not leak into Baseline-unavailable Float16Array via the abstract TypedArray row",
    );

    // The Iterator root expands to IteratorObject.
    const iteratorRow = findRow(classification, "javascript.builtins.Iterator.map");
    assert.equal(iteratorRow.resolutionKind, "member");
    assert.ok(iteratorRow.resolvedUnitIds.some(unitId => unitId.includes("IteratorObject.map")));

    const argumentsIterator = findRow(classification, "javascript.functions.arguments.@@iterator");
    assert.equal(argumentsIterator.resolutionKind, "member");
    assert.ok(argumentsIterator.resolvedUnitIds.some(unitId => unitId.includes("IArguments.@@iterator")));
    const argumentsCallee = findRow(classification, "javascript.functions.arguments.callee");
    assert.equal(argumentsCallee.resolutionKind, "member");
    assert.equal(argumentsCallee.includeInTarget, false);
});

test("classifier resolves declaration mappings and audits their containers", async () => {
    const compatKey = "javascript.builtins.Widget.legacy";
    const widgetLibSource = [
        "interface UnrelatedHelper {",
        '    "$future": string;',
        "}",
        "interface Widget {}",
        "declare var Widget: WidgetConstructor;",
        "interface WidgetConstructor {",
        "    new(): Widget;",
        "    readonly prototype: Widget;",
        "    legacy: string;",
        '    "$alias": string;',
        "}",
        "",
    ].join("\n");
    const rows = [
        row("javascript.builtins.Widget", "high"),
        row("javascript.builtins.Widget.Widget", "high"),
        row(compatKey, false),
    ];
    const declarationMappings = {
        [compatKey]: {
            scope: "static",
            memberNames: ["legacy", "$alias"],
        },
    };
    const registryGroups = [{
        id: "widget-legacy",
        category: "legacy_excluded",
        delivery: "exclude",
        upstreamState: "settled",
        expectedResolutionKinds: ["member"],
        reason: "Synthetic declaration mapping fixture.",
        sourceUrls: ["https://example.com/widget-legacy"],
        externalAction: { kind: "none", note: "Synthetic fixture." },
        compatKeys: [compatKey],
    }];

    const classification = await classifyFixture({
        libSource: widgetLibSource,
        additionalLibSources: {
            "lib.es2015.core.d.ts": [
                "interface WidgetConstructor {",
                '    "$alias": string;',
                "}",
                "",
            ].join("\n"),
        },
        rows,
        declarationMappings,
        registryGroups,
    });
    const classifiedRow = findRow(classification, compatKey);
    assert.equal(classifiedRow.resolutionKind, "member");
    assert.deepEqual(
        classifiedRow.resolvedUnitIds.map(unitId => unitId.match(/WidgetConstructor\.(.+)::\d+$/)?.[1]).sort(),
        ["$alias", "$alias", "legacy"],
    );

    await assert.rejects(
        classifyFixture({
            libSource: widgetLibSource.replace('    "$alias": string;\n', ""),
            rows,
            declarationMappings,
            registryGroups,
        }),
        /Declaration mapping javascript\.builtins\.Widget\.legacy could not resolve static members: WidgetConstructor\.\$alias/,
    );

    await assert.rejects(
        classifyFixture({
            libSource: widgetLibSource.replace('    "$alias": string;\n', '    "$alias": string;\n    "$future": string;\n'),
            rows,
            declarationMappings,
            registryGroups,
        }),
        /Members in mapped containers lack compat claims:[\s\S]*WidgetConstructor\.\$future/,
    );

    await assert.rejects(
        classifyFixture({
            libSource: [
                "declare class Widget {",
                "    static legacy: string;",
                "}",
                "",
            ].join("\n"),
            rows: [row("javascript.builtins.Widget", "high"), row(compatKey, false)],
            declarationMappings: {
                [compatKey]: { scope: "static", memberNames: ["legacy"] },
            },
            registryGroups,
        }),
        /Declaration mapping cannot distinguish static members on shared containers: Widget/,
    );
});

test("classifier audits declaration mappings on synthetic roots", async () => {
    const compatKey = "javascript.builtins.TypedArray.at";
    const rows = [row(compatKey, false), ...typedArrayFamilyRows()];
    const declarationMappings = {
        [compatKey]: { scope: "instance", memberNames: ["at"] },
    };
    const registryGroups = [{
        id: "typed-array-mapping",
        category: "legacy_excluded",
        delivery: "exclude",
        upstreamState: "settled",
        expectedResolutionKinds: ["member"],
        reason: "Synthetic root declaration mapping fixture.",
        sourceUrls: ["https://example.com/typed-array-mapping"],
        externalAction: { kind: "none", note: "Synthetic fixture." },
        compatKeys: [compatKey],
    }];
    const classification = await classifyFixture({ rows, declarationMappings, registryGroups });

    const classifiedRow = findRow(classification, compatKey);
    assert.equal(classifiedRow.resolutionKind, "member");
    assert.equal(classifiedRow.resolvedUnitIds.length, 12);

    await assert.rejects(
        classifyFixture({
            libSource: FIXTURE_LIB_SOURCE.replace("    at(index: number): number;\n", ""),
            rows,
            declarationMappings,
            registryGroups,
        }),
        /could not resolve instance members: Int8Array\.at/,
    );
});

test("classifier honors the low baseline target and rejects unknown targets", async () => {
    const lowTarget = await classifyFixture({
        rows: [row("javascript.builtins.Iterator.map", "low")],
        baselineTarget: "low",
    });
    assert.equal(findRow(lowTarget, "javascript.builtins.Iterator.map").includeInTarget, true);

    const highTarget = await classifyFixture({
        rows: [row("javascript.builtins.Iterator.map", "low")],
    });
    assert.equal(findRow(highTarget, "javascript.builtins.Iterator.map").includeInTarget, false);

    await assert.rejects(
        classifyFixture({
            rows: [row("javascript.builtins.Iterator.map", "low")],
            baselineTarget: "medium",
        }),
        /Unsupported baseline target medium/,
    );
});

test("classifier fails closed on unmanaged, stale, and kind-drifted registry state", async () => {
    const mysteryKey = "javascript.builtins.Widget.mystery";
    /**
     * @param {{ compatKeys: string[]; expectedResolutionKinds?: string[]; }} groupOptions
     */
    function registryGroup(groupOptions) {
        return {
            id: "widget-mystery",
            category: "actionable_upstream_gap",
            delivery: "defer-upstream",
            upstreamState: "actionable",
            reason: "Widget.mystery is not modeled in the synthetic lib fixture.",
            sourceUrls: ["https://example.com/widget-mystery"],
            externalAction: { kind: "none", note: "synthetic fixture" },
            ...groupOptions,
        };
    }

    // An unmanaged not-modeled-upstream row is an error.
    await assert.rejects(
        classifyFixture({ rows: [row(mysteryKey, "high")] }),
        /Special compat keys missing registry metadata[\s\S]*Widget\.mystery/,
    );

    // Managed in the registry, it passes and the row gets management metadata.
    const managed = await classifyFixture({
        rows: [row(mysteryKey, "high")],
        registryGroups: [registryGroup({ compatKeys: [mysteryKey] })],
    });
    const managedRow = findRow(managed, mysteryKey);
    assert.equal(managedRow.resolutionKind, "not-modeled-upstream");
    assert.equal(managedRow.management?.groupId, "widget-mystery");

    // A row the registry keeps managing but that actually resolves normally (stale) is an error.
    await assert.rejects(
        classifyFixture({
            rows: [row(mysteryKey, "high"), row("javascript.builtins.Widget.configure", "high")],
            registryGroups: [
                registryGroup({ compatKeys: [mysteryKey, "javascript.builtins.Widget.gone"] }),
            ],
        }),
        /Stale managed compat keys[\s\S]*Widget\.gone/,
    );

    // A mismatch between expectedResolutionKinds and the actual classification is an error.
    await assert.rejects(
        classifyFixture({
            rows: [row(mysteryKey, "high")],
            registryGroups: [
                registryGroup({
                    compatKeys: [mysteryKey],
                    expectedResolutionKinds: ["member"],
                }),
            ],
        }),
        /resolution kind no longer matches registry expectations[\s\S]*Widget\.mystery/,
    );
});

test("dataset loader rejects duplicate compat keys before classification", async () => {
    await assert.rejects(
        classifyFixture({
            rows: [
                row("javascript.builtins.Widget.configure", "high"),
                row("javascript.builtins.Widget.configure", "high"),
            ],
        }),
        /duplicate compatKey javascript\.builtins\.Widget\.configure/,
    );
});

// Pin the Float16Array "promotion scenario" ahead of time.
// When Float16Array is promoted to widely available around 2027, it must enter
// the abstract TypedArray row's mapping automatically, with no manual list update.
test("typed array family follows each concrete array's own baseline status", async () => {
    // Today: Float16Array is low, so it's outside the mapping.
    const today = await classifyFixture({
        rows: [
            row("javascript.builtins.TypedArray.at", "high"),
            ...typedArrayFamilyRows({ Float16Array: "low" }),
        ],
    });
    const todayRow = findRow(today, "javascript.builtins.TypedArray.at");
    assert.ok(todayRow.resolvedUnitIds.some(unitId => unitId.includes("Int8Array.at")));
    assert.ok(!todayRow.resolvedUnitIds.some(unitId => unitId.includes("Float16Array.at")));

    // After promotion: it enters the mapping automatically once its root row is high.
    const promoted = await classifyFixture({
        rows: [
            row("javascript.builtins.TypedArray.at", "high"),
            ...typedArrayFamilyRows(),
        ],
    });
    const promotedRow = findRow(promoted, "javascript.builtins.TypedArray.at");
    assert.ok(promotedRow.resolvedUnitIds.some(unitId => unitId.includes("Int8Array.at")));
    assert.ok(promotedRow.resolvedUnitIds.some(unitId => unitId.includes("Float16Array.at")));
});

test("typed array family fails closed when a known typed array loses its dataset row", async () => {
    const rows = [
        row("javascript.builtins.TypedArray.at", "high"),
        ...typedArrayFamilyRows().filter(candidate => candidate.compatKey !== "javascript.builtins.Float16Array"),
    ];

    await assert.rejects(
        () => classifyFixture({ rows }),
        /missing root compat rows[\s\S]*javascript\.builtins\.Float16Array/u,
        "when a known typed array root row disappears from the dataset, stop instead of silently narrowing the mapping",
    );
});

// The JSON.parse reviver context-argument verdict is pinned with a watchdog
// that inspects the current lib signature, so it can't quietly become a lie
// the day TypeScript models it.
const JSON_PARSE_KEY = "javascript.builtins.JSON.parse.reviver_parameter_context_argument";

// already-excluded-upstream is a managed special key, so it needs a registry entry.
function jsonParseRegistryGroup() {
    return {
        id: "json-parse-with-source-gap",
        category: "actionable_upstream_gap",
        delivery: "defer-upstream",
        upstreamState: "tracked",
        expectedResolutionKinds: ["already-excluded-upstream"],
        reason: "fixture: reviver context argument is not yet modeled by TypeScript's lib.",
        sourceUrls: ["https://github.com/tc39/proposal-json-parse-with-source"],
        externalAction: {
            kind: "watch-existing",
            repo: "microsoft/TypeScript",
            targetUrl: "https://github.com/microsoft/TypeScript/issues/61330",
            note: "fixture",
        },
        compatKeys: [JSON_PARSE_KEY],
    };
}

test("JSON.parse reviver verdict stays excluded while TypeScript does not model the context argument", async () => {
    const libSource = [
        "interface JSON {",
        "    parse(text: string, reviver?: (this: any, key: string, value: any) => any): any;",
        "}",
        "declare var JSON: JSON;",
        "",
    ].join("\n");

    const classification = await classifyFixture({
        rows: [row(JSON_PARSE_KEY, "low")],
        libSource,
        registryGroups: [jsonParseRegistryGroup()],
    });
    const parseRow = findRow(classification, JSON_PARSE_KEY);
    assert.equal(parseRow.resolutionKind, "already-excluded-upstream");
    assert.equal(parseRow.includeInTarget, false);
});

test("JSON.parse reviver verdict fails closed once TypeScript models the context argument", async () => {
    // A lib where TypeScript has added the context argument to reviver. The
    // pinned verdict must stop and prompt re-evaluation instead of silently lying.
    const libSource = [
        "interface JSONParseContext { source: string; }",
        "interface JSON {",
        "    parse(text: string, reviver?: (this: any, key: string, value: any, context: JSONParseContext) => any): any;",
        "}",
        "declare var JSON: JSON;",
        "",
    ].join("\n");

    await assert.rejects(
        () => classifyFixture({ rows: [row(JSON_PARSE_KEY, "low")], libSource }),
        /reviver context argument[\s\S]*stale|now appears to model the reviver context/u,
    );
});
