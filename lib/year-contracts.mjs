// @ts-check

import { compareStringsCaseSensitive } from "./shared.mjs";

/**
 * @param {string} previousReportText
 * @param {string} currentReportText
 */
export function compareYearContracts(previousReportText, currentReportText) {
    const previousContracts = readYearContracts(previousReportText, "previous");
    const currentContracts = readYearContracts(currentReportText, "current");
    /** @type {Array<{ year: number; kind: "added" | "removed" | "expanded" | "changed"; }>} */
    const changes = [];

    for (const [year, previousContract] of previousContracts) {
        const currentContract = currentContracts.get(year);
        if (!currentContract) {
            changes.push({ year, kind: "removed" });
            continue;
        }
        if (JSON.stringify(currentContract) === JSON.stringify(previousContract)) {
            continue;
        }

        const removedCompatKey = previousContract.includedCompatKeys.some(
            compatKey => !currentContract.includedCompatKeys.includes(compatKey),
        );
        const addedCompatKey = currentContract.includedCompatKeys.some(
            compatKey => !previousContract.includedCompatKeys.includes(compatKey),
        );
        changes.push({
            year,
            kind: removedCompatKey || !addedCompatKey ? "changed" : "expanded",
        });
    }

    for (const year of currentContracts.keys()) {
        if (!previousContracts.has(year)) {
            changes.push({ year, kind: "added" });
        }
    }

    changes.sort((left, right) => left.year - right.year || compareStringsCaseSensitive(left.kind, right.kind));
    return {
        changes,
    };
}

/**
 * @param {string} reportText
 * @param {string} label
 */
function readYearContracts(reportText, label) {
    /** @type {{ yearEntries?: Array<{ year?: unknown; contentHash?: unknown; includedCompatKeys?: unknown; notModeledUpstreamCompatKeys?: unknown; }>; }} */
    const report = JSON.parse(reportText);
    /** @type {Map<number, { contentHash: string; includedCompatKeys: string[]; notModeledUpstreamCompatKeys: string[]; }>} */
    const contracts = new Map();
    for (const entry of report.yearEntries ?? []) {
        const year = Number.isInteger(entry.year) ? Number(entry.year) : undefined;
        if (
            year === undefined
            || typeof entry.contentHash !== "string"
            || !Array.isArray(entry.includedCompatKeys)
            || entry.includedCompatKeys.some(compatKey => typeof compatKey !== "string")
            || !Array.isArray(entry.notModeledUpstreamCompatKeys)
            || entry.notModeledUpstreamCompatKeys.some(compatKey => typeof compatKey !== "string")
            || contracts.has(year)
        ) {
            throw new Error(`Invalid ${label} Baseline year contract report`);
        }
        contracts.set(year, {
            contentHash: entry.contentHash,
            includedCompatKeys: [...entry.includedCompatKeys].sort(compareStringsCaseSensitive),
            notModeledUpstreamCompatKeys: [...entry.notModeledUpstreamCompatKeys].sort(compareStringsCaseSensitive),
        });
    }
    return contracts;
}
