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
    assertExclusionInvariants,
    resolveExcludedUnits,
    resolveUnclaimedTypeOnlyUnitIds,
} from "../lib/generator.mjs";
import {
    createSurfaceInventory,
    discoverBuiltinSourceLibEntries,
    emitSelectedUnits,
} from "../lib/surface-inventory.mjs";

/** @type {string[]} */
const tempDirectories = [];

test.afterEach(() => {
    cleanupTempDirectories(tempDirectories);
});

/**
 * @param {string} tempDirectory
 * @param {Record<string, string>} libFiles
 */
async function createFixtureInventory(tempDirectory, libFiles) {
    const libDirectory = path.join(tempDirectory, "node_modules", "typescript", "lib");
    fs.mkdirSync(libDirectory, { recursive: true });
    fs.writeFileSync(
        path.join(tempDirectory, "node_modules", "typescript", "package.json"),
        `${JSON.stringify({
            name: "typescript",
            version: "0.0.0-test",
        }, undefined, 4)}\n`,
    );
    for (const [fileName, sourceText] of Object.entries(libFiles)) {
        fs.writeFileSync(path.join(libDirectory, fileName), sourceText);
    }

    const sourceLibEntries = await discoverBuiltinSourceLibEntries({
        libDirectory,
        reportPathPrefix: "typescript/lib",
    });
    return createSurfaceInventory({
        snapshotName: "excluded-units-test",
        repoRoot: tempDirectory,
        sourceLibEntries,
        inventoryOutputPath: path.join(tempDirectory, "inventory.json"),
    });
}

/**
 * @param {import("../lib/surface-inventory.mjs").SurfaceInventory} inventory
 * @param {string} memberKey
 */
function requireMemberUnit(inventory, memberKey) {
    const units = inventory.memberUnitsByOwnerAndName.get(memberKey) ?? [];
    assert.equal(units.length, 1, `expected exactly one unit for ${memberKey}`);
    return units[0];
}

test("complete-container emission never includes excluded member units", async () => {
    const tempDirectory = createTempDirectory(tempDirectories);
    const inventory = await createFixtureInventory(tempDirectory, {
        "lib.es5.d.ts": [
            "interface Widget {",
            "    good(): void;",
            "    bad(): void;",
            "}",
            "declare var Widget: WidgetConstructor;",
            "interface WidgetConstructor {",
            "    new(): Widget;",
            "}",
            "",
        ].join("\n"),
    });

    const widgetInterface = (inventory.declarationUnitsBySymbol.get("Widget") ?? [])
        .find(unit => unit.declarationKind === "interface");
    assert.ok(widgetInterface, "expected Widget interface declaration unit");
    const goodMember = requireMemberUnit(inventory, "Widget::good");
    const badMember = requireMemberUnit(inventory, "Widget::bad");

    // No exclusions: complete-container promotion force-emits children (baseline behavior).
    const unrestricted = emitSelectedUnits({
        inventory,
        selectedUnitIds: [widgetInterface.id],
        completeContainerUnitIds: new Set([widgetInterface.id]),
    });
    assert.match(unrestricted, /good\(\): void;/);
    assert.match(unrestricted, /bad\(\): void;/);

    // With exclusions: excluded units are never emitted, even through forceEmit.
    const restricted = emitSelectedUnits({
        inventory,
        selectedUnitIds: [widgetInterface.id, goodMember.id],
        completeContainerUnitIds: new Set([widgetInterface.id]),
        excludedUnitIds: new Set([badMember.id]),
    });
    assert.match(restricted, /good\(\): void;/);
    assert.doesNotMatch(restricted, /bad\(\): void;/);
});

test("whole-file preserved libs fail closed when they contain excluded units", async () => {
    const tempDirectory = createTempDirectory(tempDirectories);
    const inventory = await createFixtureInventory(tempDirectory, {
        "lib.esnext.widget.d.ts": [
            "export {};",
            "declare global {",
            "    interface GlobalWidget {",
            "        safe(): void;",
            "        risky(): void;",
            "    }",
            "}",
            "",
        ].join("\n"),
    });

    const fileRecord = inventory.fileByLibFileName.get("lib.esnext.widget.d.ts");
    assert.ok(fileRecord?.preserveWholeFile, "fixture file must be whole-file preserved");
    const safeMember = requireMemberUnit(inventory, "global.GlobalWidget::safe");
    const riskyMember = requireMemberUnit(inventory, "global.GlobalWidget::risky");

    assert.throws(
        () =>
            emitSelectedUnits({
                inventory,
                selectedUnitIds: [safeMember.id],
                excludedUnitIds: new Set([riskyMember.id]),
            }),
        /Cannot emit whole-file lib lib\.esnext\.widget\.d\.ts/,
    );
});

test("resolveExcludedUnits bans surface-defining exclusions but keeps shared and qualifier-tracked units", () => {
    const rows = [
        {
            compatKey: "javascript.builtins.Widget.bad",
            includeInTarget: false,
            resolutionKind: "member",
            resolvedUnitIds: ["unit-bad"],
        },
        {
            compatKey: "javascript.builtins.Widget.good.options_parameter",
            includeInTarget: false,
            resolutionKind: "signature-compat",
            resolvedUnitIds: ["unit-good"],
        },
        {
            compatKey: "javascript.builtins.Widget.shared.legacy_alias",
            includeInTarget: false,
            resolutionKind: "member",
            resolvedUnitIds: ["unit-shared"],
        },
        {
            compatKey: "javascript.builtins.Widget.shared",
            includeInTarget: true,
            resolutionKind: "member",
            resolvedUnitIds: ["unit-shared"],
        },
    ];

    const { excludedUnitIds, excludedRowsByUnitId } = resolveExcludedUnits(rows);

    assert.deepEqual([...excludedUnitIds], ["unit-bad"]);
    assert.deepEqual(excludedRowsByUnitId.get("unit-bad"), ["javascript.builtins.Widget.bad"]);
    // signature-compat qualifies an already-included surface, so don't block it.
    assert.ok(!excludedUnitIds.has("unit-good"));
    // Don't block a shared unit that also resolves to an included row.
    assert.ok(!excludedUnitIds.has("unit-shared"));
});

test("resolveUnclaimedTypeOnlyUnitIds preserves global aliases without selecting interface surface", async () => {
    const tempDirectory = createTempDirectory(tempDirectories);
    const inventory = await createFixtureInventory(tempDirectory, {
        "lib.es5.d.ts": [
            "type Utility<T> = { value: T };",
            "type ClaimedAlias = string;",
            "interface ExcludedSupport { detail: string; }",
            "interface TypeOnly {",
            "    value: string;",
            "    excluded(input: Utility<ExcludedSupport>): void;",
            "}",
            "interface RuntimeThing {",
            "    visible(): void;",
            "}",
            "interface RuntimeThingConstructor {",
            "    new(): RuntimeThing;",
            "}",
            "declare var RuntimeThing: RuntimeThingConstructor;",
            "",
        ].join("\n"),
    });
    const claimedAlias = (inventory.declarationUnitsBySymbol.get("ClaimedAlias") ?? [])[0];
    const excludedMember = requireMemberUnit(inventory, "TypeOnly::excluded");
    assert.ok(claimedAlias);

    const selected = resolveUnclaimedTypeOnlyUnitIds({
        inventory,
        classifiedCompatRows: [
            { resolvedUnitIds: [claimedAlias.id] },
            { resolvedUnitIds: [excludedMember.id] },
        ],
        excludedUnitIds: new Set([excludedMember.id]),
    });
    const selectedUnits = selected.map(unitId => inventory.unitById.get(unitId));

    assert.ok(selectedUnits.some(unit => unit?.symbolName === "Utility"));
    assert.ok(!selectedUnits.some(unit => unit?.symbolName === "ClaimedAlias"));
    assert.ok(!selectedUnits.some(unit => unit?.symbolName === "ExcludedSupport"));
    assert.ok(!selectedUnits.some(unit => unit?.ownerSymbol === "ExcludedSupport"));
    assert.ok(!selectedUnits.some(unit => unit?.symbolName === "TypeOnly"));
    assert.ok(!selectedUnits.some(unit => unit?.ownerSymbol === "TypeOnly"));
    assert.ok(!selectedUnits.some(unit => unit?.ownerSymbol === "TypeOnly" && unit.memberName === "excluded"));
    assert.ok(!selectedUnits.some(unit => unit?.symbolName?.startsWith("RuntimeThing")));
    assert.ok(!selectedUnits.some(unit => unit?.ownerSymbol?.startsWith("RuntimeThing")));
});

test("assertExclusionInvariants rejects selections that intersect excluded units", async () => {
    const tempDirectory = createTempDirectory(tempDirectories);
    const inventory = await createFixtureInventory(tempDirectory, {
        "lib.es5.d.ts": [
            "interface Widget {",
            "    bad(): void;",
            "}",
            "",
        ].join("\n"),
    });
    const badMember = requireMemberUnit(inventory, "Widget::bad");

    assert.throws(
        () =>
            assertExclusionInvariants({
                inventory,
                selectedUnitIds: [badMember.id],
                excludedUnitIds: new Set([badMember.id]),
                excludedRowsByUnitId: new Map([[badMember.id, ["javascript.builtins.Widget.bad"]]]),
            }),
        /Excluded compat units were selected for emission[\s\S]*javascript\.builtins\.Widget\.bad/,
    );

    // Passes when there's no intersection.
    assertExclusionInvariants({
        inventory,
        selectedUnitIds: [],
        excludedUnitIds: new Set([badMember.id]),
        excludedRowsByUnitId: new Map([[badMember.id, ["javascript.builtins.Widget.bad"]]]),
    });
});
