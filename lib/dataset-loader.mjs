// @ts-check

import { readFile } from "node:fs/promises";

/**
 * @param {string} filePath
 * @param {string} expectedSnapshot
 * @param {string} [expectedBaselineDate]
 * @param {string} [expectedWebFeaturesVersion]
 */
export async function loadBaselineDataset(filePath, expectedSnapshot, expectedBaselineDate, expectedWebFeaturesVersion) {
    const dataset = JSON.parse(await readFile(filePath, "utf8"));
    const snapshotDate = expectedBaselineDate
        ? parseIsoDate(expectedBaselineDate, "manifest snapshot baselineDate")
        : undefined;
    if (!dataset.snapshot?.name) {
        throw new Error(`Dataset ${filePath} is missing snapshot.name`);
    }
    if (dataset.snapshot.name !== expectedSnapshot) {
        throw new Error(`Dataset snapshot ${dataset.snapshot.name} does not match expected snapshot ${expectedSnapshot}`);
    }
    if (expectedBaselineDate && dataset.snapshot.baselineDate !== expectedBaselineDate) {
        throw new Error(
            `Dataset baselineDate ${String(dataset.snapshot.baselineDate)} does not match expected ${expectedBaselineDate}`,
        );
    }
    if (
        expectedWebFeaturesVersion
        && dataset.snapshot.webFeaturesPackageVersion !== expectedWebFeaturesVersion
    ) {
        throw new Error(
            `Dataset webFeaturesPackageVersion ${String(dataset.snapshot.webFeaturesPackageVersion)} `
                + `does not match expected ${expectedWebFeaturesVersion}`,
        );
    }
    if (!Array.isArray(dataset.featureRows)) {
        throw new Error(`Dataset ${filePath} is missing featureRows`);
    }
    if (!Array.isArray(dataset.compatRows)) {
        throw new Error(`Dataset ${filePath} is missing compatRows`);
    }

    const featureRowById = new Map();
    for (const featureRow of dataset.featureRows) {
        if (!featureRow.featureId) {
            throw new Error(`Dataset ${filePath} has a feature row without featureId`);
        }
        if (featureRowById.has(featureRow.featureId)) {
            throw new Error(`Dataset ${filePath} has duplicate featureId ${featureRow.featureId}`);
        }
        featureRowById.set(featureRow.featureId, featureRow);
    }

    const compatRowByKey = new Map();
    for (const compatRow of dataset.compatRows) {
        if (!compatRow.compatKey) {
            throw new Error(`Dataset ${filePath} has a compat row without compatKey`);
        }
        if (compatRowByKey.has(compatRow.compatKey)) {
            throw new Error(`Dataset ${filePath} has duplicate compatKey ${compatRow.compatKey}`);
        }
        // Inclusion depends on an exact match of baselineStatus. Silently accepting a
        // dataset whose enum was renamed or dropped would quietly generate a nearly empty
        // lib with every row excluded, so reject it at load time.
        if (compatRow.baselineStatus !== "high" && compatRow.baselineStatus !== "low" && compatRow.baselineStatus !== false) {
            throw new Error(
                `Dataset ${filePath} compat row ${compatRow.compatKey} has unsupported baselineStatus `
                    + `${JSON.stringify(compatRow.baselineStatus)} (expected "high", "low", or false)`,
            );
        }
        if (compatRow.baselineStatus !== false || compatRow.baselineLowDate !== undefined) {
            const lowDate = parseBaselineLowDate(
                compatRow.baselineLowDate,
                `compat row ${compatRow.compatKey} baselineLowDate`,
            );
            if (snapshotDate && lowDate > snapshotDate) {
                throw new Error(
                    `Dataset ${filePath} compat row ${compatRow.compatKey} baselineLowDate `
                        + `${lowDate} is after snapshot ${snapshotDate}`,
                );
            }
        }
        compatRowByKey.set(compatRow.compatKey, compatRow);
    }

    return {
        ...dataset,
        featureRowById,
        compatRowByKey,
    };
}

/**
 * @param {unknown} value
 * @param {string} label
 */
export function parseBaselineLowDate(value, label) {
    if (typeof value !== "string" || !/^(?:≤)?\d{4}-\d{2}-\d{2}$/u.test(value)) {
        throw new Error(`${label} is not a valid Baseline date`);
    }
    return parseIsoDate(value.replace(/^≤/u, ""), label);
}

/**
 * @param {string} value
 * @param {string} label
 */
function parseIsoDate(value, label) {
    const timestamp = Date.parse(`${value}T00:00:00Z`);
    if (
        !/^\d{4}-\d{2}-\d{2}$/u.test(value)
        || !Number.isFinite(timestamp)
        || new Date(timestamp).toISOString().slice(0, 10) !== value
    ) {
        throw new Error(`${label} is not a valid ISO date: ${value}`);
    }
    return value;
}
