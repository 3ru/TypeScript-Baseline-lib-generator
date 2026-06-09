// @ts-check

import {
    mkdir,
    readFile,
    writeFile,
} from "node:fs/promises";
import path from "node:path";
import { readInstalledPackageJson, resolveInstalledPackageFile } from "./installed-package.mjs";
import { compareStringsCaseSensitive } from "./shared.mjs";

// web-features v3 entry kinds. An unknown kind signals a new data shape, so
// silently skipping it would drop features. Fail-closed instead.
const KNOWN_FEATURE_KINDS = new Set(["feature", "moved", "split"]);

const VALID_BASELINE_STATUSES = new Set(["high", "low", false]);

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
    /** @type {{ features?: Record<string, any>; }} */
    const webFeaturesData = JSON.parse(
        await readFile(resolveInstalledPackageFile(options.repoRoot, packageName, "data.json"), "utf8"),
    );
    if (!webFeaturesData.features || typeof webFeaturesData.features !== "object") {
        throw new Error(`${packageName} data.json is missing the features map`);
    }

    /** @type {any[]} */
    const featureRows = [];
    /** @type {any[]} */
    const compatRows = [];

    for (const [featureId, feature] of Object.entries(webFeaturesData.features)) {
        const kind = feature.kind ?? "feature";
        if (!KNOWN_FEATURE_KINDS.has(kind)) {
            throw new Error(
                `${packageName} feature ${featureId} has unknown kind "${kind}". `
                    + `Update the extractor for the new web-features schema instead of skipping entries silently.`,
            );
        }
        // "moved" / "split" are redirect entries with no feature data.
        if (kind !== "feature") {
            continue;
        }

        const compatFeatures = Array.isArray(feature.compat_features)
            ? feature.compat_features.filter(
                /** @param {unknown} compatKey */
                compatKey => typeof compatKey === "string" && compatKey.startsWith("javascript."),
            )
            : [];
        const snapshot = Array.isArray(feature.snapshot)
            ? feature.snapshot.filter(
                /** @param {unknown} snapshotValue */
                snapshotValue => typeof snapshotValue === "string",
            )
            : typeof feature.snapshot === "string"
                ? [feature.snapshot]
                : [];
        const isJavaScriptFeature = compatFeatures.length > 0 || snapshot.some(
            /** @param {string} snapshotValue */
            snapshotValue => snapshotValue.startsWith("ecmascript-"),
        );
        if (!isJavaScriptFeature) {
            continue;
        }

        if (!feature.status || typeof feature.status !== "object") {
            throw new Error(`${packageName} feature ${featureId} is missing status`);
        }
        requireValidBaselineStatus(packageName, `feature ${featureId}`, feature.status.baseline);

        featureRows.push({
            featureId,
            featureName: feature.name,
            baselineStatus: feature.status.baseline,
            baselineLowDate: feature.status.baseline_low_date,
            baselineHighDate: feature.status.baseline_high_date,
            snapshot,
            group: feature.group ?? [],
            hasCompatRows: compatFeatures.length > 0,
            spec: feature.spec ?? [],
        });

        for (const compatKey of compatFeatures) {
            // Don't let per-key status silently fall back to the feature-level
            // status. If by_compat_key is renamed, removed, or missing and we
            // inherit the feature status, a row where the key is low/false while
            // the whole feature is high gets wrongly included, and the wrong .d.ts
            // is generated with no error (the biggest hole in the fail-closed contract).
            const compatStatus = feature.status.by_compat_key?.[compatKey];
            if (!compatStatus || typeof compatStatus !== "object") {
                throw new Error(
                    `${packageName} feature ${featureId} is missing status.by_compat_key["${compatKey}"]. `
                        + `Refusing to fall back to the feature-level status.`,
                );
            }
            requireValidBaselineStatus(packageName, `feature ${featureId} compat key ${compatKey}`, compatStatus.baseline);

            compatRows.push({
                compatKey,
                featureId,
                featureName: feature.name,
                baselineStatus: compatStatus.baseline,
                baselineLowDate: compatStatus.baseline_low_date,
                baselineHighDate: compatStatus.baseline_high_date,
                snapshot,
                group: feature.group ?? [],
                sourceRefs: [compatKey],
            });
        }
    }

    featureRows.sort((left, right) => compareStringsCaseSensitive(left.featureId, right.featureId));
    compatRows.sort((left, right) => compareStringsCaseSensitive(left.compatKey, right.compatKey));

    return {
        snapshot: {
            name: options.snapshotName,
            baselineDate: options.snapshotDate,
            extractedDate: options.snapshotDate,
            webFeaturesPackageName: packageName,
            webFeaturesPackageVersion: webFeaturesPackageJson.version,
        },
        featureRows,
        compatRows,
    };
}

/**
 * Compare datasets for content equality, ignoring the extraction date
 * (baselineDate / extractedDate). With a pinned web-features version and the
 * same gitHead, extraction is deterministic, so a date-only diff isn't a real change.
 *
 * @param {any} left
 * @param {any} right
 */
export function datasetsEqualIgnoringDate(left, right) {
    return JSON.stringify(withNormalizedDate(left)) === JSON.stringify(withNormalizedDate(right));
}

/**
 * When a checked-in dataset exists and matches the newly extracted dataset apart
 * from the date, keep the existing extraction date. This avoids date-only noise PRs
 * in weeks with no real web-features change (weeks with a change use the candidate date, normally today).
 *
 * @param {{ existingDataset: any | undefined; newDataset: any; candidateDate: string; }} options
 * @returns {string}
 */
export function resolveSnapshotDate(options) {
    if (options.existingDataset && datasetsEqualIgnoringDate(options.existingDataset, options.newDataset)) {
        const existingDate = options.existingDataset.snapshot?.baselineDate;
        if (typeof existingDate === "string" && existingDate) {
            return existingDate;
        }
    }
    return options.candidateDate;
}

/**
 * @param {any} dataset
 */
function withNormalizedDate(dataset) {
    if (!dataset || typeof dataset !== "object") {
        return dataset;
    }
    return {
        ...dataset,
        snapshot: {
            ...dataset.snapshot,
            baselineDate: "",
            extractedDate: "",
        },
    };
}

/**
 * @param {string} packageName
 * @param {string} subject
 * @param {unknown} baselineStatus
 */
function requireValidBaselineStatus(packageName, subject, baselineStatus) {
    if (!VALID_BASELINE_STATUSES.has(/** @type {any} */ (baselineStatus))) {
        throw new Error(
            `${packageName} ${subject} has unsupported baseline status ${JSON.stringify(baselineStatus)} `
                + `(expected "high", "low", or false)`,
        );
    }
}

/**
 * @param {{
 *   outputPath: string;
 *   dataset: any;
 * }} options
 */
export async function writeWebFeaturesDataset(options) {
    await mkdir(path.dirname(options.outputPath), { recursive: true });
    await writeFile(options.outputPath, `${JSON.stringify(options.dataset, undefined, 2)}\n`);
}
