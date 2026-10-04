// @ts-check

import { readFile } from "node:fs/promises";
import {
    getCompatFeatureMemberships,
    normalizeCompatRows,
    parseBaselineStatus,
    readDataRecord,
    readDataString,
    readDataStringArray,
} from "./compat-rows.mjs";

/**
 * @param {string} filePath
 * @param {string} expectedSnapshot
 * @param {string} [expectedBaselineDate]
 * @param {string} [expectedWebFeaturesVersion]
 */
export async function loadBaselineDataset(filePath, expectedSnapshot, expectedBaselineDate, expectedWebFeaturesVersion) {
    return parseBaselineDataset(JSON.parse(await readFile(filePath, "utf8")), filePath, expectedSnapshot, expectedBaselineDate, expectedWebFeaturesVersion);
}

/**
 * @param {unknown} value
 * @param {string} filePath
 * @param {string} expectedSnapshot
 * @param {string} [expectedBaselineDate]
 * @param {string} [expectedWebFeaturesVersion]
 */
export function parseBaselineDataset(value, filePath, expectedSnapshot, expectedBaselineDate, expectedWebFeaturesVersion) {
    const data = readDataRecord(value, `Dataset ${filePath}`);
    const snapshot = parseDatasetSnapshot(data.snapshot);
    const baselineDate = expectedBaselineDate ?? snapshot.baselineDate;
    const snapshotDate = baselineDate === undefined ? undefined : parseIsoDate(baselineDate, "snapshot baselineDate");

    if (snapshot.name !== expectedSnapshot) {
        throw new Error(`Dataset snapshot ${snapshot.name} does not match expected snapshot ${expectedSnapshot}`);
    }

    if (expectedBaselineDate && snapshot.baselineDate !== expectedBaselineDate) {
        throw new Error(
            `Dataset baselineDate ${String(snapshot.baselineDate)} does not match expected ${expectedBaselineDate}`,
        );
    }

    if (
        expectedWebFeaturesVersion
        && snapshot.webFeaturesPackageVersion !== expectedWebFeaturesVersion
    ) {
        throw new Error(
            `Dataset webFeaturesPackageVersion ${String(snapshot.webFeaturesPackageVersion)} `
                + `does not match expected ${expectedWebFeaturesVersion}`,
        );
    }

    if (!Array.isArray(data.featureRows)) {
        throw new Error(`Dataset ${filePath} is missing featureRows`);
    }

    if (!Array.isArray(data.compatRows)) {
        throw new Error(`Dataset ${filePath} is missing compatRows`);
    }

    const featureRows = data.featureRows.map(parseFeatureRow);
    /** @type {Map<string, FeatureRow>} */
    const featureRowById = new Map();

    for (const featureRow of featureRows) {
        if (featureRowById.has(featureRow.featureId)) {
            throw new Error(`Dataset ${filePath} has duplicate featureId ${featureRow.featureId}`);
        }

        featureRowById.set(featureRow.featureId, featureRow);
    }

    const compatRows = normalizeCompatRows(data.compatRows);

    for (const compatRow of compatRows) {
        validateCompatDates(compatRow, filePath, snapshotDate);

        for (const membership of getCompatFeatureMemberships(compatRow)) {
            if (!featureRowById.has(membership.featureId)) {
                throw new Error(`Dataset ${filePath} compat row ${compatRow.compatKey} references missing feature ${membership.featureId}`);
            }
        }
    }

    const compatRowByKey = new Map(compatRows.map(row => [row.compatKey, row]));

    return { snapshot, featureRows, compatRows, featureRowById, compatRowByKey };
}

/**
 * @param {import("./compat-rows.mjs").CompatRow} compatRow
 * @param {string} filePath
 * @param {string | undefined} snapshotDate
 */
function validateCompatDates(compatRow, filePath, snapshotDate) {
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

    if (compatRow.baselineHighDate !== undefined) {
        const highDate = parseBaselineLowDate(compatRow.baselineHighDate, `compat row ${compatRow.compatKey} baselineHighDate`);

        if (
            compatRow.baselineLowDate !== undefined
            && !compatRow.baselineLowDate.startsWith("≤")
            && !compatRow.baselineHighDate.startsWith("≤")
            && highDate < compatRow.baselineLowDate
        ) {
            throw new Error(`Dataset ${filePath} compat row ${compatRow.compatKey} baselineHighDate is before baselineLowDate`);
        }
    }
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

/** @param {unknown} value @returns {DatasetSnapshot} */
function parseDatasetSnapshot(value) {
    const data = readDataRecord(value, "Dataset snapshot");
    /** @type {DatasetSnapshot} */
    const snapshot = { name: readDataString(data.name, "Dataset snapshot.name") };

    for (const field of /** @type {const} */ (["baselineDate", "extractedDate", "webFeaturesPackageName", "webFeaturesPackageVersion"])) {
        if (data[field] !== undefined) {
            snapshot[field] = readDataString(data[field], `Dataset snapshot.${field}`);
        }
    }

    if (snapshot.extractedDate !== undefined) {
        parseIsoDate(snapshot.extractedDate, "Dataset snapshot.extractedDate");
    }

    return snapshot;
}

/** @param {unknown} value @returns {FeatureRow} */
function parseFeatureRow(value) {
    const data = readDataRecord(value, "Dataset feature row");
    /** @type {FeatureRow} */
    const row = { featureId: readDataString(data.featureId, "Dataset feature row featureId") };

    for (const field of /** @type {const} */ (["featureName", "baselineLowDate", "baselineHighDate"])) {
        if (data[field] !== undefined) {
            row[field] = readDataString(data[field], `Feature ${row.featureId} ${field}`);
        }
    }

    for (const field of /** @type {const} */ (["snapshot", "group", "spec"])) {
        if (data[field] !== undefined) {
            row[field] = readDataStringArray(data[field], `Feature ${row.featureId} ${field}`);
        }
    }

    if (data.baselineStatus !== undefined) {
        row.baselineStatus = parseBaselineStatus(data.baselineStatus, `Feature ${row.featureId}`);
    }

    if (data.hasCompatRows !== undefined) {
        if (data.hasCompatRows !== true && data.hasCompatRows !== false) {
            throw new Error(`Feature ${row.featureId} has invalid hasCompatRows`);
        }

        row.hasCompatRows = data.hasCompatRows;
    }

    return row;
}

/** @typedef {{ name: string; baselineDate?: string; extractedDate?: string; webFeaturesPackageName?: string; webFeaturesPackageVersion?: string; }} DatasetSnapshot */
/** @typedef {{ featureId: string; featureName?: string; baselineStatus?: import("./compat-rows.mjs").BaselineStatus; baselineLowDate?: string; baselineHighDate?: string; snapshot?: string[]; group?: string[]; spec?: string[]; hasCompatRows?: boolean; }} FeatureRow */
/** @typedef {{ snapshot: DatasetSnapshot; featureRows: FeatureRow[]; compatRows: import("./compat-rows.mjs").CompatRow[]; }} BaselineDataset */
