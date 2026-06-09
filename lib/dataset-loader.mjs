// @ts-check

import { readFile } from "node:fs/promises";

/**
 * @param {string} filePath
 * @param {string} expectedSnapshot
 */
export async function loadBaselineDataset(filePath, expectedSnapshot) {
    const dataset = JSON.parse(await readFile(filePath, "utf8"));
    if (!dataset.snapshot?.name) {
        throw new Error(`Dataset ${filePath} is missing snapshot.name`);
    }
    if (dataset.snapshot.name !== expectedSnapshot) {
        throw new Error(`Dataset snapshot ${dataset.snapshot.name} does not match expected snapshot ${expectedSnapshot}`);
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
        compatRowByKey.set(compatRow.compatKey, compatRow);
    }

    return {
        ...dataset,
        featureRowById,
        compatRowByKey,
    };
}
