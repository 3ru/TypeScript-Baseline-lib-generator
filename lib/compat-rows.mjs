// @ts-check

import { compareStringsCaseSensitive } from "./shared.mjs";

const COMPAT_FACT_FIELDS = ["baselineStatus", "baselineLowDate", "baselineHighDate"];

/**
 * @param {any} row
 * @returns {FeatureMembership[]}
 */
export function getCompatFeatureMemberships(row) {
    if (row.featureMemberships !== undefined) {
        if (!Array.isArray(row.featureMemberships) || row.featureMemberships.length < 2) {
            throw new Error(`Compat row ${row.compatKey} has invalid featureMemberships`);
        }
        for (const membership of row.featureMemberships) {
            validateFeatureMembership(membership, row.compatKey);
        }
        return row.featureMemberships;
    }
    return [{
        featureId: row.featureId,
        featureName: row.featureName,
        snapshot: row.snapshot ?? [],
        group: row.group ?? [],
    }];
}

/**
 * @param {any} membership
 * @param {string} compatKey
 */
function validateFeatureMembership(membership, compatKey) {
    if (!membership || typeof membership !== "object" || Array.isArray(membership)) {
        throw new Error(`Compat row ${compatKey} has an invalid feature membership`);
    }
    for (const field of ["featureId", "featureName"]) {
        if (typeof membership[field] !== "string" || !membership[field]) {
            throw new Error(`Compat row ${compatKey} has a feature membership with invalid ${field}`);
        }
    }
    for (const field of ["snapshot", "group"]) {
        if (!Array.isArray(membership[field]) || membership[field].some((/** @type {any} */ value) => typeof value !== "string")) {
            throw new Error(`Compat row ${compatKey} has a feature membership with invalid ${field}`);
        }
    }
}

/**
 * @param {any[]} rows
 * @returns {any[]}
 */
export function normalizeCompatRows(rows) {
    /** @type {Map<string, any[]>} */
    const rowsByKey = new Map();
    for (const row of rows) {
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
                    if (typeof membership.featureId !== "string" || !membership.featureId) {
                        throw new Error(`Compat row ${compatKey} has a feature membership without featureId`);
                    }
                    if (memberships.has(membership.featureId)) {
                        throw new Error(`Duplicate compat key membership ${compatKey} in feature ${membership.featureId}`);
                    }
                    memberships.set(membership.featureId, membership);
                }
                for (const sourceRef of row.sourceRefs ?? []) {
                    sourceRefs.add(sourceRef);
                }
            }

            if (memberships.size === 1) {
                return matchingRows[0];
            }
            const featureMemberships = [...memberships.values()]
                .sort((left, right) => compareStringsCaseSensitive(left.featureId, right.featureId));
            const firstMembership = featureMemberships[0];
            return {
                ...matchingRows[0],
                ...firstMembership,
                sourceRefs: [...sourceRefs].sort(compareStringsCaseSensitive),
                featureMemberships,
            };
        });
}

/**
 * @typedef {{
 *   featureId: string;
 *   featureName: string;
 *   snapshot: string[];
 *   group: string[];
 * }} FeatureMembership
 */
