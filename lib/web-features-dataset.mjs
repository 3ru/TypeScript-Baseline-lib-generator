// @ts-check

import {
    mkdir,
    readFile,
    writeFile,
} from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
    normalizeCompatRows,
    parseBaselineStatus,
    readDataRecord,
    readDataString,
    readDataStringArray,
} from "./compat-rows.mjs";
import { readInstalledPackageJson, resolveInstalledPackageFile } from "./installed-package.mjs";
import { compareStringsCaseSensitive } from "./shared.mjs";

/**
 * @param {{
 *   repoRoot: string;
 *   packageName?: string;
 *   snapshotDate: string;
 *   snapshotName: string;
 * }} options
 */
export async function buildWebFeaturesDataset(options) {
    const packageName = options.packageName ?? "web-features";
    const webFeaturesPackageJson = await readInstalledPackageJson(options.repoRoot, packageName);

    const webFeaturesData = readDataRecord(JSON.parse(
        await readFile(resolveInstalledPackageFile(options.repoRoot, packageName, "data.json"), "utf8"),
    ), `${packageName} data.json`);

    const features = readDataRecord(webFeaturesData.features, `${packageName} features map`);
    /** @type {ExtractedFeatureRow[]} */
    const featureRows = [];
    /** @type {import("./compat-rows.mjs").CompatRow[]} */
    const compatRows = [];

    for (const [featureId, value] of Object.entries(features)) {
        const feature = readDataRecord(value, `${packageName} feature ${featureId}`);
        const kind = feature.kind ?? "feature";

        if (kind !== "feature" && kind !== "moved" && kind !== "split") {
            throw new Error(`${packageName} feature ${featureId} has unknown kind "${String(kind)}"`);
        }

        if (kind !== "feature") {
            continue;
        }

        const label = `${packageName} feature ${featureId}`;

        const snapshot = typeof feature.snapshot === "string"
            ? [feature.snapshot]
            : readDataStringArray(feature.snapshot, `${label} snapshot`);

        const status = feature.status === undefined ? undefined : readDataRecord(feature.status, `${label} status`);

        const byCompatKey = status?.by_compat_key === undefined
            ? {}
            : readDataRecord(status.by_compat_key, `${label} status.by_compat_key`);

        if (
            feature.compat_features === undefined
            && (
                snapshot.some(
                    value => value.startsWith("ecmascript-"),
                )
                || Object.keys(byCompatKey).length > 0
            )
        ) {
            throw new Error(`${packageName} feature ${featureId} is missing compat_features for compatibility-backed data`);
        }

        const rawCompatFeatures = readDataStringArray(feature.compat_features, `${label} compat_features`);

        const compatFeatures = rawCompatFeatures.filter(
            compatKey => compatKey.startsWith("javascript."),
        );

        const isJavaScriptFeature = compatFeatures.length > 0 || snapshot.some(
            snapshotValue => snapshotValue.startsWith("ecmascript-"),
        );

        if (!isJavaScriptFeature) {
            continue;
        }

        if (!status) {
            throw new Error(`${label} is missing status`);
        }

        const metadata = {
            featureId,
            featureName: readDataString(feature.name, `${label} name`),
            snapshot,
            group: readDataStringArray(feature.group, `${label} group`),
        };

        featureRows.push({
            featureId,
            featureName: metadata.featureName,
            ...parseSourceStatus(status, label),
            snapshot,
            group: metadata.group,
            hasCompatRows: compatFeatures.length > 0,
            spec: readDataStringArray(feature.spec, `${label} spec`),
        });

        for (const compatKey of compatFeatures) {
            const compatStatus = byCompatKey[compatKey];

            if (compatStatus === undefined) {
                throw new Error(`${label} is missing status.by_compat_key["${compatKey}"]`);
            }

            compatRows.push({
                compatKey,
                ...metadata,
                ...parseSourceStatus(readDataRecord(compatStatus, `${label} compat key ${compatKey}`), `${label} compat key ${compatKey}`),
                sourceRefs: [compatKey],
            });
        }
    }

    featureRows.sort((left, right) => compareStringsCaseSensitive(left.featureId, right.featureId));

    return {
        snapshot: {
            name: options.snapshotName,
            baselineDate: options.snapshotDate,
            extractedDate: options.snapshotDate,
            webFeaturesPackageName: packageName,
            webFeaturesPackageVersion: webFeaturesPackageJson.version,
        },
        featureRows,
        compatRows: normalizeCompatRows(compatRows),
    };
}

/**
 * @param {{ repoRoot: string; packageName?: string; dataset: unknown; }} options
 */
export async function verifyWebFeaturesDataset(options) {
    const data = readDataRecord(options.dataset, "Dataset");
    const snapshot = readDataRecord(data.snapshot, "Dataset snapshot");

    const expected = await buildWebFeaturesDataset({
        repoRoot: options.repoRoot,
        packageName: options.packageName,
        snapshotDate: readDataString(snapshot.baselineDate, "Dataset snapshot baselineDate"),
        snapshotName: readDataString(snapshot.name, "Dataset snapshot name"),
    });

    if (!isDeepStrictEqual(expected, data)) {
        throw new Error("Checked-in dataset does not match the pinned web-features package extraction");
    }
}

/**
 * Compare datasets for content equality, ignoring the extraction date
 * (baselineDate / extractedDate). With a pinned web-features version and the
 * same gitHead, extraction is deterministic, so a date-only diff isn't a real change.
 *
 * @param {import("./dataset-loader.mjs").BaselineDataset} left
 * @param {import("./dataset-loader.mjs").BaselineDataset} right
 */
export function datasetsEqualIgnoringDate(left, right) {
    return isDeepStrictEqual(withNormalizedDate(left), withNormalizedDate(right));
}

/**
 * When a checked-in dataset exists and matches the newly extracted dataset apart
 * from the date, keep the existing extraction date within the same calendar year.
 * A year boundary advances so the next completed year entrypoint can be created.
 *
 * @param {{ existingDataset: import("./dataset-loader.mjs").BaselineDataset | undefined; newDataset: import("./dataset-loader.mjs").BaselineDataset; candidateDate: string; }} options
 * @returns {string}
 */
export function resolveSnapshotDate(options) {
    if (options.existingDataset && datasetsEqualIgnoringDate(options.existingDataset, options.newDataset)) {
        const existingDate = options.existingDataset.snapshot?.baselineDate;

        if (
            typeof existingDate === "string"
            && existingDate.slice(0, 4) === options.candidateDate.slice(0, 4)
        ) {
            return existingDate;
        }
    }

    return options.candidateDate;
}

/**
 * @param {import("./dataset-loader.mjs").BaselineDataset} dataset
 */
function withNormalizedDate(dataset) {
    return {
        ...dataset,
        snapshot: {
            ...dataset.snapshot,
            baselineDate: "",
            extractedDate: "",
        },
    };
}

/** @param {Record<string, unknown>} data @param {string} label @returns {import("./compat-rows.mjs").CompatFacts} */
function parseSourceStatus(data, label) {
    /** @type {import("./compat-rows.mjs").CompatFacts} */
    const facts = { baselineStatus: parseBaselineStatus(data.baseline, label) };

    if (data.baseline_low_date !== undefined) {
        facts.baselineLowDate = readDataString(data.baseline_low_date, `${label} baseline_low_date`);
    }

    if (data.baseline_high_date !== undefined) {
        facts.baselineHighDate = readDataString(data.baseline_high_date, `${label} baseline_high_date`);
    }

    return facts;
}

/**
 * @param {{
 *   outputPath: string;
 *   dataset: ExtractedDataset;
 * }} options
 */
export async function writeWebFeaturesDataset(options) {
    await mkdir(path.dirname(options.outputPath), { recursive: true });
    await writeFile(options.outputPath, `${JSON.stringify(options.dataset, undefined, 2)}\n`);
}

/** @typedef {import("./compat-rows.mjs").FeatureMembership & import("./compat-rows.mjs").CompatFacts & { hasCompatRows: boolean; spec: string[]; }} ExtractedFeatureRow */
/** @typedef {{ snapshot: { name: string; baselineDate: string; extractedDate: string; webFeaturesPackageName: string; webFeaturesPackageVersion: string; }; featureRows: ExtractedFeatureRow[]; compatRows: import("./compat-rows.mjs").CompatRow[]; }} ExtractedDataset */
