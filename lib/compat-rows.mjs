// @ts-check

import { compareStringsCaseSensitive } from "./shared.mjs";

/** @type {ReadonlyArray<keyof CompatFacts>} */
const COMPAT_FACT_FIELDS = ["baselineStatus", "baselineLowDate", "baselineHighDate"];

const BASELINE_DATE_FIELDS = /** @type {const} */ (["baselineLowDate", "baselineHighDate"]);

/** @param {CompatFeatureMetadata} row @returns {FeatureMembership[]} */
export function getCompatFeatureMemberships(row) {
    return row.featureMemberships ?? [{
        featureId: row.featureId,
        featureName: row.featureName,
        snapshot: row.snapshot ?? [],
        group: row.group ?? [],
    }];
}

/** @param {unknown} value @returns {CompatRow} */
export function parseCompatRow(value) {
    const data = readDataRecord(value, "Compat row");
    const compatKey = readDataString(data.compatKey, "Compat row compatKey");
    const label = `Compat row ${compatKey}`;
    /** @type {CompatFacts} */
    const facts = { baselineStatus: parseBaselineStatus(data.baselineStatus, `${label} baselineStatus`) };

    for (const field of BASELINE_DATE_FIELDS) {
        if (data[field] !== undefined) {
            facts[field] = readDataString(data[field], `${label} ${field}`);
        }
    }

    const membership = parseFeatureMembership(data, label);

    /** @type {CompatRow} */
    const row = {
        compatKey,
        featureId: membership.featureId,
        featureName: membership.featureName,
        ...facts,
        snapshot: membership.snapshot,
        group: membership.group,
        sourceRefs: readDataStringArray(data.sourceRefs, `${label} sourceRefs`),
    };

    if (data.featureMemberships !== undefined) {
        if (!Array.isArray(data.featureMemberships) || data.featureMemberships.length < 2) {
            throw new Error(`${label} has invalid featureMemberships`);
        }

        row.featureMemberships = data.featureMemberships.map(membership => parseFeatureMembership(membership, label, true));
    }

    return row;
}

/** @param {unknown} value @param {string} label @param {boolean} [requireArrays] @returns {FeatureMembership} */
function parseFeatureMembership(value, label, requireArrays = false) {
    const data = readDataRecord(value, `${label} feature membership`);

    return {
        featureId: readDataString(data.featureId, `${label} feature membership featureId`),
        featureName: readDataString(data.featureName, `${label} feature membership featureName`),
        snapshot: readDataStringArray(data.snapshot, `${label} feature membership snapshot`, requireArrays),
        group: readDataStringArray(data.group, `${label} feature membership group`, requireArrays),
    };
}

/** @param {unknown} value @param {string} label @returns {BaselineStatus} */
export function parseBaselineStatus(value, label) {
    if (value !== "high" && value !== "low" && value !== false) {
        throw new Error(`${label} has unsupported baseline status ${JSON.stringify(value)}`);
    }

    return value;
}

/** @param {unknown} value @param {string} label @returns {Record<string, unknown>} */
export function readDataRecord(value, label) {
    if (!isDataRecord(value)) {
        throw new Error(`${label} must be an object`);
    }

    return value;
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isDataRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {unknown} value @param {string} label @returns {string} */
export function readDataString(value, label) {
    if (typeof value !== "string" || !value) {
        throw new Error(`${label} must be a nonempty string`);
    }

    return value;
}

/** @param {unknown} value @param {string} label @param {boolean} [required] @returns {string[]} */
export function readDataStringArray(value, label, required = false) {
    if (value === undefined && !required) {
        return [];
    }

    if (!Array.isArray(value)) {
        throw new Error(`${label} must be an array of strings`);
    }

    const values = [];

    for (const item of value) {
        if (typeof item !== "string") {
            throw new Error(`${label} must be an array of strings`);
        }

        values.push(item);
    }

    return values;
}

/** @param {unknown[]} rows @returns {CompatRow[]} */
export function normalizeCompatRows(rows) {
    /** @type {Map<string, CompatRow[]>} */
    const rowsByKey = new Map();

    for (const value of rows) {
        const row = parseCompatRow(value);
        const members = rowsByKey.get(row.compatKey) ?? [];
        members.push(row);
        rowsByKey.set(row.compatKey, members);
    }

    return [...rowsByKey.entries()]
        .sort(([left], [right]) => compareStringsCaseSensitive(left, right))
        .map(([compatKey, matchingRows]) => {
            /** @type {Map<string, FeatureMembership>} */
            const memberships = new Map();
            const sourceRefs = new Set();

            for (const row of matchingRows) {
                const conflictField = COMPAT_FACT_FIELDS.find(field => row[field] !== matchingRows[0][field]);

                if (conflictField) {
                    throw new Error(
                        `Compat key ${compatKey} has conflicting ${conflictField} across features `
                            + `${matchingRows[0].featureId} and ${row.featureId}`,
                    );
                }

                for (const membership of getCompatFeatureMemberships(row)) {
                    if (memberships.has(membership.featureId)) {
                        throw new Error(`Duplicate compat key membership ${compatKey} in feature ${membership.featureId}`);
                    }

                    memberships.set(membership.featureId, membership);
                }

                for (const sourceRef of row.sourceRefs) {
                    sourceRefs.add(sourceRef);
                }
            }

            if (memberships.size === 1) {
                return matchingRows[0];
            }

            const featureMemberships = [...memberships.values()]
                .sort((left, right) => compareStringsCaseSensitive(left.featureId, right.featureId));

            return {
                ...matchingRows[0],
                ...featureMemberships[0],
                sourceRefs: [...sourceRefs].sort(compareStringsCaseSensitive),
                featureMemberships,
            };
        });
}

/** @typedef {"high" | "low" | false} BaselineStatus */
/** @typedef {{ baselineStatus: BaselineStatus; baselineLowDate?: string; baselineHighDate?: string; }} CompatFacts */
/** @typedef {{ featureId: string; featureName: string; snapshot: string[]; group: string[]; }} FeatureMembership */
/** @typedef {{ featureId: string; featureName: string; snapshot?: string[]; group?: string[]; featureMemberships?: FeatureMembership[]; }} CompatFeatureMetadata */
/** @typedef {FeatureMembership & CompatFacts & { compatKey: string; sourceRefs: string[]; featureMemberships?: FeatureMembership[]; }} CompatRow */
