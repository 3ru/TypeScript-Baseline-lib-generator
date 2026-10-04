// @ts-check

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript-strada";
import {
    cleanupTempDirectories,
    createTempDirectory,
} from "./helpers.mjs";
import {
    createSurfaceInventory,
    discoverBuiltinSourceLibEntries,
    emitSelectedUnits,
} from "../lib/surface-inventory.mjs";
import { resolveTypeOnlyDependencyClosure } from "../lib/generator.mjs";

/** @type {string[]} */
const tempDirectories = [];

test.afterEach(() => {
    cleanupTempDirectories(tempDirectories);
});

test("dependency lookup respects namespace shadowing and explicit globalThis", async () => {
    const inventory = await inventoryFromSources({
        "lib.es5.d.ts": [
            "interface Same { globalOnly: number; }",
            "interface Parent { globalOnly(): void; }",
            "declare namespace Child { interface Value { globalOnly: number; } }",
            "declare namespace N {",
            "  interface Same { localOnly: string; }",
            "  interface Parent { localOnly(): void; }",
            "  namespace Child { interface Value { localOnly: string; } }",
            "  interface Use extends Parent { local: Same; global: globalThis.Same; relative: Child.Value; }",
            "  const local: Same; const absolute: globalThis.Same;",
            "}",
        ].join("\n"),
    });

    const use = inventory.declarationUnitsBySymbol.get("N.Use")?.[0];
    assert.ok(use);
    assert.deepEqual(use.dependencySymbols, ["N.Child.Value", "N.Parent", "N.Same", "Same"]);
    assert.deepEqual(use.heritageSymbols, ["N.Parent"]);
    assert.deepEqual(inventory.memberUnitsByOwnerAndName.get("N.Use::local")?.[0].dependencySymbols, ["N.Same"]);
    assert.equal(inventory.declarationUnitsBySymbol.get("N.local")?.[0].typeRefName, "N.Same");
    assert.equal(inventory.declarationUnitsBySymbol.get("N.absolute")?.[0].typeRefName, "Same");
});

test("comments mentioning declare global do not turn a script into a module", async () => {
    const inventory = await inventoryFromSources({
        "lib.es5.d.ts": "// Avoid declare global here.\ninterface Plain { value: string; }\n",
    });

    assert.equal(inventory.files[0].preserveWholeFile, false);
    assert.doesNotMatch(emitSelectedUnits({ inventory, selectedUnitIds: inventory.units.map(unit => unit.id) }), /export \{\};/);
});

test("whole-file emission rejects cross-module local merges and preserves valid globals", async () => {
    const sources = {
        "lib.es2025.a.d.ts": [
            "export {};",
            "interface Helper { a: string; }",
            "interface Helper { optional?: boolean; }",
            "declare function factory(value: string): Helper;",
            "declare function factory(value: number): Helper;",
            "declare global { interface AuditA { value: Helper; } interface AuditCommon { a: string; } }",
        ].join("\n"),
        "lib.es2025.b.d.ts": "export {}; interface Helper { b: number; } declare global { interface AuditB { value: Helper; } interface AuditCommon { b: number; } }",
    };

    const inventory = await inventoryFromSources(sources);
    const directory = createTempDirectory(tempDirectories);
    const probePath = path.join(directory, "probe.ts");
    fs.writeFileSync(probePath, "declare const a: AuditA; a.value.b;");
    const originalFiles = inventory.files.map(file => file.sourcePath);
    assert.deepEqual(typecheck([...originalFiles, probePath]), [2339]);
    assert.throws(
        () => emitSelectedUnits({ inventory, selectedUnitIds: inventory.units.map(unit => unit.id) }),
        /Cannot combine module-local symbol Helper from lib\.es2025\.a\.d\.ts and lib\.es2025\.b\.d\.ts/,
    );

    sources["lib.es2025.b.d.ts"] = sources["lib.es2025.b.d.ts"].replaceAll("Helper", "OtherHelper");
    const distinct = await inventoryFromSources(sources);
    const generatedPath = path.join(directory, "generated.d.ts");
    fs.writeFileSync(generatedPath, emitSelectedUnits({ inventory: distinct, selectedUnitIds: distinct.units.map(unit => unit.id) }));
    assert.deepEqual(typecheck([generatedPath, probePath]), [2339]);
    fs.writeFileSync(probePath, "declare const a: AuditA; declare const b: AuditB; declare const common: AuditCommon; a.value.a; b.value.b; common.a; common.b;");
    assert.deepEqual(typecheck([generatedPath, probePath]), []);
});

test("emission preserves multiline literal types inside global wrappers and containers", async () => {
    const inventory = await inventoryFromSources({
        "lib.es5.d.ts": [
            "type AuditLiteral = `\ndeclare foo\n`;",
            "declare namespace AuditNamespace {",
            "  type Literal = `\n  nested\n`;",
            "  interface Widget { code: `\nmember\n`; }",
            "}",
            "declare var auditValue: AuditLiteral;",
        ].join("\n"),
        "lib.es2025.a.d.ts": [
            '/// <reference lib="es5" />',
            "export {};",
            "type ModuleLiteral = `\n   \n/// <reference lib=\"esnext\" />\ndeclare foo\n`;",
            "declare global { interface AuditMarker { code: ModuleLiteral; } }",
        ].join("\n"),
    });

    const directory = createTempDirectory(tempDirectories);
    const probePath = path.join(directory, "probe.ts");
    fs.writeFileSync(probePath, [
        "const literal: AuditLiteral = `\ndeclare foo\n`;",
        "const nested: AuditNamespace.Literal = `\n  nested\n`;",
        "const member: AuditNamespace.Widget['code'] = `\nmember\n`;",
        "const moduleLiteral: AuditMarker['code'] = `\n   \n/// <reference lib=\"esnext\" />\ndeclare foo\n`;",
    ].join("\n"));
    assert.deepEqual(typecheck([...inventory.files.map(file => file.sourcePath), probePath]), []);
    const generatedPath = path.join(directory, "generated.d.ts");
    fs.writeFileSync(generatedPath, emitSelectedUnits({ inventory, selectedUnitIds: inventory.units.map(unit => unit.id) }));
    assert.deepEqual(typecheck([generatedPath, probePath]), []);
});

/** @param {Record<string, string>} sources */
async function inventoryFromSources(sources) {
    const directory = createTempDirectory(tempDirectories);
    const libDirectory = path.join(directory, "lib");
    fs.mkdirSync(libDirectory);

    for (const [fileName, source] of Object.entries(sources)) {
        fs.writeFileSync(path.join(libDirectory, fileName), source);
    }

    const sourceLibEntries = await discoverBuiltinSourceLibEntries({ libDirectory, reportPathPrefix: "typescript/lib" });

    return createSurfaceInventory({ snapshotName: "scope-test", sourceLibEntries, inventoryOutputPath: path.join(directory, "inventory.json") });
}

/** @param {string[]} files */
function typecheck(files) {
    const program = ts.createProgram(files, { strict: true, noEmit: true, target: ts.ScriptTarget.ESNext, types: [] });

    return ts.getPreEmitDiagnostics(program).map(diagnostic => diagnostic.code);
}

test("surface inventory discovers future ES lib files without hard-coded year updates", async () => {
    const tempDirectory = createTempDirectory(tempDirectories);
    const libDirectory = path.join(tempDirectory, "lib");
    fs.mkdirSync(libDirectory, { recursive: true });

    for (const fileName of [
        "lib.es5.d.ts",
        "lib.es2025.promise.d.ts",
        "lib.es2026.intl.d.ts",
        "lib.esnext.collection.d.ts",
        "lib.es2026.full.d.ts",
        "lib.esnext.disposable.d.ts",
        "lib.es6.d.ts",
        "lib.dom.d.ts",
        "lib.decorators.d.ts",
        "baseline.d.ts",
    ]) {
        fs.writeFileSync(path.join(libDirectory, fileName), "// fixture\n");
    }

    const sourceLibEntries = await discoverBuiltinSourceLibEntries({
        libDirectory,
        reportPathPrefix: "typescript/lib",
    });

    const sourceFileNames = sourceLibEntries.map(entry => entry.sourceFileName);

    assert.deepEqual(sourceFileNames, [
        "lib.es2025.promise.d.ts",
        "lib.es2026.intl.d.ts",
        "lib.es5.d.ts",
        "lib.esnext.collection.d.ts",
    ]);
    assert.deepEqual(
        sourceLibEntries.map(entry => entry.reportPath),
        [
            "typescript/lib/lib.es2025.promise.d.ts",
            "typescript/lib/lib.es2026.intl.d.ts",
            "typescript/lib/lib.es5.d.ts",
            "typescript/lib/lib.esnext.collection.d.ts",
        ],
        "report paths must be canonical and platform-neutral",
    );
});

test("surface inventory lookup maps share dependency-populated unit records", async () => {
    const tempDirectory = createTempDirectory(tempDirectories);
    const libDirectory = path.join(tempDirectory, "lib");
    fs.mkdirSync(libDirectory, { recursive: true });
    fs.writeFileSync(
        path.join(libDirectory, "lib.es5.d.ts"),
        [
            "interface HelperBag {",
            "    inheritedThing(): void;",
            "}",
            "interface WidgetOptions {",
            "    size?: number;",
            "}",
            "interface Widget extends HelperBag {",
            "    configure(options: WidgetOptions): void;",
            "}",
            "interface ReadonlyWidget {",
            "    configure(options: WidgetOptions): void;",
            "}",
            "declare var Widget: WidgetConstructor;",
            "interface WidgetConstructor {",
            "    new(): Widget;",
            "    readonly prototype: Widget;",
            "}",
            "",
        ].join("\n"),
    );

    const sourceLibEntries = await discoverBuiltinSourceLibEntries({
        libDirectory,
        reportPathPrefix: "typescript/lib",
    });

    const inventory = await createSurfaceInventory({
        snapshotName: "surface-inventory-test",
        sourceLibEntries,
        inventoryOutputPath: path.join(tempDirectory, "inventory.json"),
    });

    // The classifier reads dependencySymbols through declarationUnitsBySymbol /
    // memberUnitsByOwnerAndName. If a per-map copy split drops the dependency info,
    // inherited-member / option-property resolution silently turns into dead code
    // (a regression that actually happened), so pin both the dependency contents and reference identity.
    const widgetDeclarations = inventory.declarationUnitsBySymbol.get("Widget") ?? [];
    const widgetInterface = widgetDeclarations.find(unit => unit.declarationKind === "interface");
    assert.ok(widgetInterface, "expected Widget interface declaration unit");
    assert.ok(
        widgetInterface.dependencySymbols.includes("HelperBag"),
        `expected Widget dependencySymbols to include HelperBag, got: ${JSON.stringify(widgetInterface.dependencySymbols)}`,
    );
    assert.equal(widgetInterface, inventory.unitById.get(widgetInterface.id));

    const configureUnits = inventory.memberUnitsByOwnerAndName.get("Widget::configure") ?? [];
    assert.equal(configureUnits.length, 1);
    assert.ok(
        configureUnits[0].dependencySymbols.includes("WidgetOptions"),
        `expected Widget.configure dependencySymbols to include WidgetOptions, got: ${JSON.stringify(configureUnits[0].dependencySymbols)}`,
    );
    assert.equal(configureUnits[0], inventory.unitById.get(configureUnits[0].id));

    const widgetRoot = inventory.rootSurfaceByCompatName.get("Widget");
    assert.ok(widgetRoot);
    assert.ok(widgetRoot.instanceContainerSymbols.has("Widget"));
    assert.ok(!widgetRoot.instanceContainerSymbols.has("ReadonlyWidget"));

    for (const [symbolName, symbolUnits] of inventory.declarationUnitsBySymbol) {
        for (const unit of symbolUnits) {
            assert.equal(
                unit,
                inventory.unitById.get(unit.id),
                `declarationUnitsBySymbol[${symbolName}] must share the canonical unit record for ${unit.id}`,
            );
        }
    }

    for (const [memberKey, memberUnits] of inventory.memberUnitsByOwnerAndName) {
        for (const unit of memberUnits) {
            assert.equal(
                unit,
                inventory.unitById.get(unit.id),
                `memberUnitsByOwnerAndName[${memberKey}] must share the canonical unit record for ${unit.id}`,
            );
        }
    }
});

test("surface inventory rejects multi-declarator runtime globals", async () => {
    const tempDirectory = createTempDirectory(tempDirectories);
    const libDirectory = path.join(tempDirectory, "lib");
    fs.mkdirSync(libDirectory, { recursive: true });
    fs.writeFileSync(
        path.join(libDirectory, "lib.es5.d.ts"),
        "declare var Known: KnownConstructor, Surprise: SurpriseConstructor;\n",
    );

    const sourceLibEntries = await discoverBuiltinSourceLibEntries({
        libDirectory,
        reportPathPrefix: "typescript/lib",
    });

    await assert.rejects(
        createSurfaceInventory({
            snapshotName: "multi-declarator-test",
            sourceLibEntries,
            inventoryOutputPath: path.join(tempDirectory, "inventory.json"),
        }),
        /variable statement with multiple declarators/,
    );
});

test("readonly companion discovery fails closed on unmatched members", async () => {
    const tempDirectory = createTempDirectory(tempDirectories);
    const libDirectory = path.join(tempDirectory, "lib");
    fs.mkdirSync(libDirectory, { recursive: true });
    fs.writeFileSync(
        path.join(libDirectory, "lib.es5.d.ts"),
        [
            "interface Array<T> {",
            "    read(): void;",
            "}",
            "interface ReadonlyArray<T> {",
            "    unrelated(): void;",
            "}",
            "declare var Array: ArrayConstructor;",
            "interface ArrayConstructor {",
            "    new<T>(): Array<T>;",
            "}",
            "",
        ].join("\n"),
    );

    const sourceLibEntries = await discoverBuiltinSourceLibEntries({
        libDirectory,
        reportPathPrefix: "typescript/lib",
    });

    await assert.rejects(
        createSurfaceInventory({
            snapshotName: "readonly-companion-test",
            sourceLibEntries,
            inventoryOutputPath: path.join(tempDirectory, "inventory.json"),
        }),
        /Readonly companion ReadonlyArray does not structurally match Array: unrelated/,
    );
});

test("type-only aliases cannot introduce unclassified runtime declarations", async () => {
    const tempDirectory = createTempDirectory(tempDirectories);
    const libDirectory = path.join(tempDirectory, "lib");
    fs.mkdirSync(libDirectory, { recursive: true });
    fs.writeFileSync(
        path.join(libDirectory, "lib.es5.d.ts"),
        [
            "type FutureAlias = typeof FutureThing;",
            "declare var FutureThing: FutureThingConstructor;",
            "interface FutureThingConstructor {",
            "    dangerous(): void;",
            "}",
            "",
        ].join("\n"),
    );

    const sourceLibEntries = await discoverBuiltinSourceLibEntries({
        libDirectory,
        reportPathPrefix: "typescript/lib",
    });

    const inventory = await createSurfaceInventory({
        snapshotName: "type-only-runtime-test",
        sourceLibEntries,
        inventoryOutputPath: path.join(tempDirectory, "inventory.json"),
    });

    const aliasUnit = inventory.declarationUnitsBySymbol.get("FutureAlias")?.[0];
    assert.ok(aliasUnit);

    assert.throws(
        () => resolveTypeOnlyDependencyClosure({
            inventory,
            compatSelectedUnitIds: new Set(),
            compilerSupportUnitIds: new Set(),
            typeOnlyUnitIds: [aliasUnit.id],
            completeContainerUnitIds: new Set(),
            excludedUnitIds: new Set(),
        }),
        /Type-only aliases introduce runtime declarations.*FutureThing/s,
    );
});

test("declare global declarations merge into the global inventory surface", async () => {
    const tempDirectory = createTempDirectory(tempDirectories);
    const libDirectory = path.join(tempDirectory, "lib");
    fs.mkdirSync(libDirectory, { recursive: true });
    fs.writeFileSync(
        path.join(libDirectory, "lib.es2025.widget.d.ts"),
        [
            "export {};",
            "interface Widget extends globalThis.WidgetObject {}",
            "declare global {",
            "    interface WidgetObject {",
            "        map(): WidgetObject;",
            "    }",
            "    interface WidgetConstructor {",
            "        from(): WidgetObject;",
            "    }",
            "    var Widget: WidgetConstructor;",
            "}",
            "",
        ].join("\n"),
    );

    const sourceLibEntries = await discoverBuiltinSourceLibEntries({
        libDirectory,
        reportPathPrefix: "typescript/lib",
    });

    const inventory = await createSurfaceInventory({
        snapshotName: "global-surface-test",
        sourceLibEntries,
        inventoryOutputPath: path.join(tempDirectory, "inventory.json"),
    });

    assert.ok(inventory.declarationUnitsBySymbol.has("WidgetObject"));
    assert.ok(!inventory.declarationUnitsBySymbol.has("global.WidgetObject"));
    assert.equal(inventory.memberUnitsByOwnerAndName.get("WidgetObject::map")?.length, 1);
    assert.ok(
        inventory.declarationUnitsBySymbol.get("Widget")?.[0].dependencySymbols.includes("WidgetObject"),
    );
    const widgetRoot = inventory.rootSurfaceByCompatName.get("Widget");
    assert.ok(widgetRoot?.staticContainerSymbols.has("WidgetConstructor"));
    assert.ok(widgetRoot?.instanceContainerSymbols.has("WidgetObject"));
});
