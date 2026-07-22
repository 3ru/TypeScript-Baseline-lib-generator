// @ts-check

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
    cleanupTempDirectories,
    createTempDirectory,
} from "./helpers.mjs";
import {
    createSurfaceInventory,
    discoverBuiltinSourceLibEntries,
} from "../lib/surface-inventory.mjs";
import { resolveTypeOnlyDependencyClosure } from "../lib/generator.mjs";

/** @type {string[]} */
const tempDirectories = [];

test.afterEach(() => {
    cleanupTempDirectories(tempDirectories);
});

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
        repoRoot: tempDirectory,
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
            repoRoot: tempDirectory,
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
        repoRoot: tempDirectory,
        sourceLibEntries,
        inventoryOutputPath: path.join(tempDirectory, "inventory.json"),
    });
    const aliasUnit = inventory.declarationUnitsBySymbol.get("FutureAlias")?.[0];
    assert.ok(aliasUnit);

    assert.throws(
        () => resolveTypeOnlyDependencyClosure({
            inventory,
            compatSelectedUnitIds: new Set(),
            typeOnlyUnitIds: [aliasUnit.id],
            completeContainerUnitIds: new Set(),
            excludedUnitIds: new Set(),
        }),
        /Type-only aliases introduce runtime declarations.*FutureThing/s,
    );
});
