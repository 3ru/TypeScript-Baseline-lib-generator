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
import { loadBaselineDataset } from "../lib/dataset-loader.mjs";
import { getCompatFeatureMemberships } from "../lib/compat-rows.mjs";
import {
    buildWebFeaturesDataset,
    datasetsEqualIgnoringDate,
    resolveSnapshotDate,
    verifyWebFeaturesDataset,
} from "../lib/web-features-dataset.mjs";

// Weekly-update noise suppression: in a week where web-features itself doesn't
// change, hold the extraction date and don't open a "date-only PR". Pin this invariant.
/**
 * @param {string} date
 * @param {Record<string, unknown>} [extra]
 */
function datasetFixture(date, extra = {}) {
    return {
        snapshot: {
            name: "baseline-js",
            baselineDate: date,
            extractedDate: date,
            webFeaturesPackageName: "web-features",
            webFeaturesPackageVersion: "3.32.0",
        },
        featureRows: [{ featureId: "a" }],
        compatRows: [{ compatKey: "javascript.builtins.A", baselineStatus: "high" }],
        ...extra,
    };
}

test("resolveSnapshotDate preserves the existing date when only the date differs", () => {
    const existing = datasetFixture("2026-07-07");
    const rebuilt = datasetFixture("2026-12-31");
    assert.ok(datasetsEqualIgnoringDate(existing, rebuilt));
    assert.equal(
        resolveSnapshotDate({ existingDataset: existing, newDataset: rebuilt, candidateDate: "2026-12-31" }),
        "2026-07-07",
    );
});

test("resolveSnapshotDate advances the date when the content actually changed", () => {
    const existing = datasetFixture("2026-07-07");
    const rebuilt = datasetFixture("2026-12-31", {
        compatRows: [{ compatKey: "javascript.builtins.A", baselineStatus: "low" }],
    });
    assert.ok(!datasetsEqualIgnoringDate(existing, rebuilt));
    assert.equal(
        resolveSnapshotDate({ existingDataset: existing, newDataset: rebuilt, candidateDate: "2026-12-31" }),
        "2026-12-31",
    );
});

test("resolveSnapshotDate advances at a year boundary even when content is unchanged", () => {
    const existing = datasetFixture("2026-12-29");
    const rebuilt = datasetFixture("2027-01-05");
    assert.ok(datasetsEqualIgnoringDate(existing, rebuilt));
    assert.equal(
        resolveSnapshotDate({ existingDataset: existing, newDataset: rebuilt, candidateDate: "2027-01-05" }),
        "2027-01-05",
    );
});

test("resolveSnapshotDate uses the candidate date on first extraction (no existing dataset)", () => {
    assert.equal(
        resolveSnapshotDate({ existingDataset: undefined, newDataset: datasetFixture("2026-12-31"), candidateDate: "2026-12-31" }),
        "2026-12-31",
    );
});

/** @type {string[]} */
const tempDirectories = [];

test.afterEach(() => {
    cleanupTempDirectories(tempDirectories);
});

/**
 * @param {string} tempDirectory
 * @param {Record<string, any>} features
 */
function installWebFeaturesFixture(tempDirectory, features) {
    const packageDirectory = path.join(tempDirectory, "node_modules", "web-features");
    fs.mkdirSync(packageDirectory, { recursive: true });
    writeJsonFile(path.join(packageDirectory, "package.json"), {
        name: "web-features",
        version: "0.0.0-test",
    });
    writeJsonFile(path.join(packageDirectory, "data.json"), { features });
}

/** @returns {any} */
function validFeature() {
    return {
        kind: "feature",
        name: "Widget helpers",
        compat_features: ["javascript.builtins.Widget.good"],
        status: {
            baseline: "high",
            baseline_low_date: "2020-01-01",
            baseline_high_date: "2022-07-01",
            by_compat_key: {
                "javascript.builtins.Widget.good": {
                    baseline: "high",
                    baseline_low_date: "2020-01-01",
                    baseline_high_date: "2022-07-01",
                },
            },
        },
    };
}

test("web-features extractor accepts well-formed per-key statuses", async () => {
    const tempDirectory = createTempDirectory(tempDirectories);
    installWebFeaturesFixture(tempDirectory, {
        "widget-helpers": validFeature(),
        // v3 redirect entries carry no feature data and can be skipped.
        "widget-old-name": { kind: "moved", redirect_target: "widget-helpers" },
    });

    const dataset = await buildWebFeaturesDataset({
        repoRoot: tempDirectory,
        snapshotDate: "2026-07-07",
        snapshotName: "web-features-test",
    });

    assert.equal(dataset.compatRows.length, 1);
    assert.equal(dataset.compatRows[0].compatKey, "javascript.builtins.Widget.good");
    assert.equal(dataset.compatRows[0].baselineStatus, "high");
});

test("overlapping keys retain every feature membership and use per-key facts", async () => {
    const tempDirectory = createTempDirectory(tempDirectories);
    const firstFeature = {
        ...validFeature(),
        name: "First feature",
        snapshot: ["ecmascript-2020"],
        group: ["first-group"],
    };
    const secondFeature = {
        ...validFeature(),
        name: "Second feature",
        snapshot: ["ecmascript-2024"],
        group: ["second-group"],
    };
    secondFeature.status.baseline = "low";
    secondFeature.status.baseline_low_date = "2024-01-01";
    delete secondFeature.status.baseline_high_date;
    const options = {
        repoRoot: tempDirectory,
        snapshotDate: "2026-07-07",
        snapshotName: "web-features-test",
    };
    installWebFeaturesFixture(tempDirectory, { second: secondFeature, first: firstFeature });
    const dataset = await buildWebFeaturesDataset(options);
    assert.equal(dataset.featureRows.length, 2);
    assert.equal(dataset.compatRows.length, 1);
    assert.deepEqual(dataset.compatRows[0], {
        compatKey: "javascript.builtins.Widget.good",
        featureId: "first",
        featureName: "First feature",
        baselineStatus: "high",
        baselineLowDate: "2020-01-01",
        baselineHighDate: "2022-07-01",
        snapshot: ["ecmascript-2020"],
        group: ["first-group"],
        sourceRefs: ["javascript.builtins.Widget.good"],
        featureMemberships: [
            { featureId: "first", featureName: "First feature", snapshot: ["ecmascript-2020"], group: ["first-group"] },
            { featureId: "second", featureName: "Second feature", snapshot: ["ecmascript-2024"], group: ["second-group"] },
        ],
    });

    installWebFeaturesFixture(tempDirectory, { first: firstFeature, second: secondFeature });
    assert.equal(JSON.stringify(await buildWebFeaturesDataset(options)), JSON.stringify(dataset));
    await verifyWebFeaturesDataset({ repoRoot: tempDirectory, dataset });
    const datasetPath = path.join(tempDirectory, "dataset.json");
    writeJsonFile(datasetPath, dataset);
    const loaded = await loadBaselineDataset(datasetPath, options.snapshotName);
    assert.deepEqual(loaded.compatRows, dataset.compatRows);
    assert.equal(loaded.compatRowByKey.size, 1);
});

test("overlapping keys reject conflicting per-key statuses and dates", async () => {
    const tempDirectory = createTempDirectory(tempDirectories);
    /** @type {Array<[string, string | undefined]>} */
    const conflicts = [
        ["baseline", "low"],
        ["baseline_low_date", "2021-01-01"],
        ["baseline_high_date", "2023-07-01"],
        ["baseline_high_date", undefined],
    ];
    for (const [field, value] of conflicts) {
        const secondFeature = validFeature();
        secondFeature.status.by_compat_key["javascript.builtins.Widget.good"][field] = value;
        installWebFeaturesFixture(tempDirectory, {
            first: validFeature(),
            second: secondFeature,
        });
        await assert.rejects(
            buildWebFeaturesDataset({
                repoRoot: tempDirectory,
                snapshotDate: "2026-07-07",
                snapshotName: "web-features-test",
            }),
            /Compat key javascript\.builtins\.Widget\.good has conflicting baseline.* across features first and second/,
        );
    }
});

test("web-features extractor rejects repeated compat keys within a feature", async () => {
    const tempDirectory = createTempDirectory(tempDirectories);
    const feature = validFeature();
    feature.compat_features.push("javascript.builtins.Widget.good");
    installWebFeaturesFixture(tempDirectory, { "widget-helpers": feature });
    await assert.rejects(
        buildWebFeaturesDataset({
            repoRoot: tempDirectory,
            snapshotDate: "2026-07-07",
            snapshotName: "web-features-test",
        }),
        /Duplicate compat key membership javascript\.builtins\.Widget\.good in feature widget-helpers/,
    );
});

test("dataset loader rejects conflicts and duplicate memberships in overlapping rows", async () => {
    const tempDirectory = createTempDirectory(tempDirectories);
    const datasetPath = path.join(tempDirectory, "dataset.json");
    installWebFeaturesFixture(tempDirectory, { first: validFeature(), second: validFeature() });
    const dataset = await buildWebFeaturesDataset({
        repoRoot: tempDirectory,
        snapshotDate: "2026-07-07",
        snapshotName: "web-features-test",
    });
    const overlapping = dataset.compatRows[0];
    const conflicting = {
        ...overlapping,
        featureId: "third",
        featureMemberships: undefined,
        baselineStatus: "low",
    };
    writeJsonFile(datasetPath, { ...dataset, compatRows: [overlapping, conflicting] });
    await assert.rejects(
        loadBaselineDataset(datasetPath, "web-features-test"),
        /conflicting baselineStatus/,
    );

    overlapping.featureMemberships.push(overlapping.featureMemberships[0]);
    writeJsonFile(datasetPath, dataset);
    await assert.rejects(
        loadBaselineDataset(datasetPath, "web-features-test"),
        /Duplicate compat key membership .* in feature first/,
    );
});

test("explicit feature memberships reject malformed provenance", async () => {
    const tempDirectory = createTempDirectory(tempDirectories);
    const datasetPath = path.join(tempDirectory, "dataset.json");
    installWebFeaturesFixture(tempDirectory, { first: validFeature(), second: validFeature() });
    const dataset = await buildWebFeaturesDataset({
        repoRoot: tempDirectory,
        snapshotDate: "2026-07-07",
        snapshotName: "web-features-test",
    });
    const row = dataset.compatRows[0];
    const memberships = row.featureMemberships;
    const invalidValues = [
        null,
        {},
        [],
        [memberships[0]],
        [memberships[0], null],
        [memberships[0], []],
        [memberships[0], "second"],
        ...["featureId", "featureName", "snapshot", "group"].flatMap(field => [
            [memberships[0], { ...memberships[1], [field]: undefined }],
            [memberships[0], { ...memberships[1], [field]: 42 }],
        ]),
        [memberships[0], { ...memberships[1], featureId: "" }],
        [memberships[0], { ...memberships[1], featureName: "" }],
        [memberships[0], { ...memberships[1], snapshot: "ecmascript-2020" }],
        [memberships[0], { ...memberships[1], snapshot: [null] }],
        [memberships[0], { ...memberships[1], group: null }],
        [memberships[0], { ...memberships[1], group: [42] }],
    ];
    for (const featureMemberships of invalidValues) {
        row.featureMemberships = featureMemberships;
        assert.throws(() => getCompatFeatureMemberships(row), /Compat row .* invalid/);
        writeJsonFile(datasetPath, dataset);
        await assert.rejects(loadBaselineDataset(datasetPath, "web-features-test"), /Compat row .* invalid/);
    }
});

test("checked-in dataset must exactly match the pinned package extraction", async () => {
    const tempDirectory = createTempDirectory(tempDirectories);
    installWebFeaturesFixture(tempDirectory, { "widget-helpers": validFeature() });
    const dataset = await buildWebFeaturesDataset({
        repoRoot: tempDirectory,
        snapshotDate: "2026-07-07",
        snapshotName: "web-features-test",
    });

    await verifyWebFeaturesDataset({ repoRoot: tempDirectory, dataset });

    dataset.compatRows[0].baselineStatus = "low";
    await assert.rejects(
        verifyWebFeaturesDataset({ repoRoot: tempDirectory, dataset }),
        /does not match the pinned web-features package extraction/u,
    );
});

test("web-features extractor fails closed when by_compat_key is missing instead of inheriting feature status", async () => {
    const tempDirectory = createTempDirectory(tempDirectories);
    const feature = validFeature();
    // Reproduce schema drift: with per-key status gone, the feature stays "high".
    // The old implementation silently inherited the feature status here and could
    // include an API that should be low/false per key.
    delete feature.status.by_compat_key;
    installWebFeaturesFixture(tempDirectory, { "widget-helpers": feature });

    await assert.rejects(
        buildWebFeaturesDataset({
            repoRoot: tempDirectory,
            snapshotDate: "2026-07-07",
            snapshotName: "web-features-test",
        }),
        /missing status\.by_compat_key\["javascript\.builtins\.Widget\.good"\]/,
    );
});

test("web-features extractor fails closed when compat_features changes shape", async () => {
    const tempDirectory = createTempDirectory(tempDirectories);
    installWebFeaturesFixture(tempDirectory, {
        "widget-helpers": {
            ...validFeature(),
            compat_features: { widget: "javascript.builtins.Widget.good" },
            snapshot: "ecmascript-2024",
        },
    });

    await assert.rejects(
        buildWebFeaturesDataset({
            repoRoot: tempDirectory,
            snapshotDate: "2026-07-07",
            snapshotName: "web-features-test",
        }),
        /non-array compat_features/,
    );

    const renamedDirectory = createTempDirectory(tempDirectories);
    const renamedFeature = validFeature();
    renamedFeature.compatFeatures = renamedFeature.compat_features;
    delete renamedFeature.compat_features;
    renamedFeature.snapshot = "ecmascript-2024";
    installWebFeaturesFixture(renamedDirectory, { "widget-helpers": renamedFeature });
    await assert.rejects(
        buildWebFeaturesDataset({
            repoRoot: renamedDirectory,
            snapshotDate: "2026-07-07",
            snapshotName: "web-features-test",
        }),
        /missing compat_features for compatibility-backed data/,
    );

    const arrayDirectory = createTempDirectory(tempDirectories);
    installWebFeaturesFixture(arrayDirectory, /** @type {any} */ ([]));
    await assert.rejects(
        buildWebFeaturesDataset({
            repoRoot: arrayDirectory,
            snapshotDate: "2026-07-07",
            snapshotName: "web-features-test",
        }),
        /missing the features map/,
    );
});

test("web-features extractor fails closed on unknown entry kinds and invalid baseline values", async () => {
    const unknownKindDirectory = createTempDirectory(tempDirectories);
    installWebFeaturesFixture(unknownKindDirectory, {
        "widget-helpers": { ...validFeature(), kind: "superseded" },
    });
    await assert.rejects(
        buildWebFeaturesDataset({
            repoRoot: unknownKindDirectory,
            snapshotDate: "2026-07-07",
            snapshotName: "web-features-test",
        }),
        /unknown kind "superseded"/,
    );

    const invalidBaselineDirectory = createTempDirectory(tempDirectories);
    const feature = validFeature();
    feature.status.by_compat_key["javascript.builtins.Widget.good"].baseline = "widely";
    installWebFeaturesFixture(invalidBaselineDirectory, { "widget-helpers": feature });
    await assert.rejects(
        buildWebFeaturesDataset({
            repoRoot: invalidBaselineDirectory,
            snapshotDate: "2026-07-07",
            snapshotName: "web-features-test",
        }),
        /unsupported baseline status "widely"/,
    );
});

test("dataset loader rejects checked-in rows with unsupported baseline statuses", async () => {
    const tempDirectory = createTempDirectory(tempDirectories);
    const datasetPath = path.join(tempDirectory, "dataset.json");
    writeJsonFile(datasetPath, {
        snapshot: { name: "web-features-test" },
        featureRows: [{ featureId: "widget-helpers" }],
        compatRows: [
            {
                compatKey: "javascript.builtins.Widget.good",
                featureId: "widget-helpers",
                baselineStatus: "widely",
            },
        ],
    });

    await assert.rejects(
        loadBaselineDataset(datasetPath, "web-features-test"),
        /unsupported baselineStatus "widely"/,
    );
});

test("dataset loader validates Baseline dates against the snapshot", async () => {
    const tempDirectory = createTempDirectory(tempDirectories);
    const datasetPath = path.join(tempDirectory, "dataset.json");

    /** @type {Array<[string | undefined, RegExp]>} */
    const invalidDates = [
        ["2024-99-99", /not a valid ISO date/],
        ["2027-01-01", /is after snapshot 2026-07-07/],
        [undefined, /is not a valid Baseline date/],
    ];
    for (const [baselineLowDate, expectedError] of invalidDates) {
        writeJsonFile(datasetPath, {
            snapshot: { name: "web-features-test", baselineDate: "2026-07-07" },
            featureRows: [{ featureId: "widget-helpers" }],
            compatRows: [{
                compatKey: "javascript.builtins.Widget.good",
                featureId: "widget-helpers",
                baselineStatus: "high",
                ...(baselineLowDate ? { baselineLowDate } : {}),
            }],
        });
        await assert.rejects(
            loadBaselineDataset(datasetPath, "web-features-test", "2026-07-07"),
            expectedError,
        );
    }
});

test("dataset loader requires the manifest and dataset Baseline dates to match", async () => {
    const tempDirectory = createTempDirectory(tempDirectories);
    const datasetPath = path.join(tempDirectory, "dataset.json");
    writeJsonFile(datasetPath, {
        snapshot: { name: "web-features-test", baselineDate: "2025-12-31" },
        featureRows: [],
        compatRows: [],
    });

    await assert.rejects(
        loadBaselineDataset(datasetPath, "web-features-test", "2026-07-07"),
        /Dataset baselineDate 2025-12-31 does not match expected 2026-07-07/,
    );
});

test("dataset loader requires the manifest and dataset package versions to match", async () => {
    const tempDirectory = createTempDirectory(tempDirectories);
    const datasetPath = path.join(tempDirectory, "dataset.json");
    writeJsonFile(datasetPath, {
        snapshot: {
            name: "web-features-test",
            baselineDate: "2026-07-07",
            webFeaturesPackageVersion: "1.0.0",
        },
        featureRows: [],
        compatRows: [],
    });

    await assert.rejects(
        loadBaselineDataset(datasetPath, "web-features-test", "2026-07-07", "2.0.0"),
        /Dataset webFeaturesPackageVersion 1\.0\.0 does not match expected 2\.0\.0/u,
    );
});
