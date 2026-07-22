// @ts-check

/**
 * Single source of truth for the negative probes that verify, by actually
 * compiling, which APIs must not be in the baseline lib.
 *
 * Background: Intl.Segmenter / Promise.withResolvers / Map.groupBy used to be
 * hardcoded into tests and fixtures, but they're Baseline low and promote to
 * widely available at their low date + 30 months. The moment they promoted,
 * the weekly auto-update went permanently red — a date-driven time bomb.
 *
 * Approach:
 * - STABLE_NEGATIVE_PROBES: non-standard / deprecated APIs with baselineStatus
 *   false. They have no path to Baseline, so they're safe for static expected
 *   values (compiler fixture reference baselines and the like).
 * - LOW_NEGATIVE_PROBE_CANDIDATES: a pool of currently Baseline-low APIs. Each
 *   run picks only the ones still excluded against the classification, so it
 *   doesn't break on promotion and drops the candidate automatically. When the
 *   pool empties (all candidates promoted), fail explicitly and demand a refill.
 */

/**
 * @typedef {{
 *   compatKey: string;
 *   sourceText: string;
 *   errorPattern: RegExp;
 *   absencePattern?: RegExp;
 * }} NegativeProbe
 */

/** @type {NegativeProbe[]} */
export const STABLE_NEGATIVE_PROBES = [
    {
        compatKey: "javascript.builtins.Function.caller",
        sourceText: "(function probeCaller() {}).caller;",
        errorPattern: /caller/,
        absencePattern: /\bcaller: Function;/,
    },
    {
        compatKey: "javascript.builtins.String.substr",
        sourceText: "\"baseline\".substr(1);",
        errorPattern: /substr/,
        absencePattern: /\bsubstr\(/,
    },
    {
        compatKey: "javascript.builtins.RegExp.compile",
        sourceText: "new RegExp(\"baseline\").compile(\"baseline\");",
        errorPattern: /compile/,
        absencePattern: /\bcompile\(pattern/,
    },
    {
        compatKey: "javascript.functions.arguments.callee",
        sourceText: "(function probeArguments() { return arguments.callee; })();",
        errorPattern: /callee/,
        absencePattern: /\bcallee: Function;/,
    },
];

/** @type {NegativeProbe[]} */
export const LOW_NEGATIVE_PROBE_CANDIDATES = [
    {
        compatKey: "javascript.builtins.Intl.Segmenter",
        sourceText: "new Intl.Segmenter();",
        errorPattern: /Segmenter/,
        absencePattern: /Segmenter/,
    },
    {
        compatKey: "javascript.builtins.Promise.withResolvers",
        sourceText: "Promise.withResolvers();",
        errorPattern: /withResolvers/,
        absencePattern: /withResolvers/,
    },
    {
        compatKey: "javascript.builtins.Array.fromAsync",
        sourceText: "Array.fromAsync([1, 2, 3]);",
        errorPattern: /fromAsync/,
        absencePattern: /fromAsync/,
    },
    {
        compatKey: "javascript.builtins.Map.groupBy",
        sourceText: "Map.groupBy([1, 2, 3], (value: number) => value % 2);",
        errorPattern: /groupBy/,
        absencePattern: /groupBy/,
    },
    {
        compatKey: "javascript.builtins.Float16Array",
        sourceText: "new Float16Array(1);",
        errorPattern: /Float16Array/,
        absencePattern: /Float16Array/,
    },
    {
        compatKey: "javascript.builtins.Error.isError",
        sourceText: "Error.isError(new Error(\"probe\"));",
        errorPattern: /isError/,
        absencePattern: /\bisError\(/,
    },
    {
        compatKey: "javascript.builtins.RegExp.escape",
        sourceText: "RegExp.escape(\"probe\");",
        errorPattern: /escape/,
    },
    {
        compatKey: "javascript.builtins.Set.union",
        sourceText: "declare const probeReadonlySet: ReadonlySet<number>; probeReadonlySet.union(new Set<number>());",
        errorPattern: /union/,
        absencePattern: /\bunion<U>\(/,
    },
];

/**
 * Return the negative probes valid right now against the classification rows.
 *
 * - If a stable probe's row turns included, error immediately (probe rot).
 * - Return only the low candidates still excluded; if all are gone, error and
 *   demand a refill of the candidate pool.
 *
 * @param {Array<{ compatKey: string; includeInTarget: boolean; }>} classifiedCompatRows
 */
export function selectActiveNegativeProbes(classifiedCompatRows) {
    const rowByCompatKey = new Map(classifiedCompatRows.map(row => [row.compatKey, row]));

    for (const probe of STABLE_NEGATIVE_PROBES) {
        const row = rowByCompatKey.get(probe.compatKey);
        if (!row) {
            throw new Error(
                `Stable negative probe ${probe.compatKey} is missing from the classification. `
                    + `Update lib/negative-probes.mjs to track an API that still exists in web-features.`,
            );
        }
        if (row.includeInTarget) {
            throw new Error(
                `Stable negative probe ${probe.compatKey} is now included in the baseline target. `
                    + `Replace it in lib/negative-probes.mjs with an API that is excluded from Baseline.`,
            );
        }
    }

    const activeLowProbes = LOW_NEGATIVE_PROBE_CANDIDATES.filter(probe => {
        const row = rowByCompatKey.get(probe.compatKey);
        return row !== undefined && !row.includeInTarget;
    });
    if (!activeLowProbes.length) {
        throw new Error(
            "Every Baseline-low negative probe candidate has been promoted to widely available. "
                + "Top up LOW_NEGATIVE_PROBE_CANDIDATES in lib/negative-probes.mjs with newer Baseline-low APIs.",
        );
    }

    return [...STABLE_NEGATIVE_PROBES, ...activeLowProbes];
}

/**
 * Generate TypeScript source from the probes where every line should be a
 * compile error.
 *
 * @param {NegativeProbe[]} probes
 */
export function renderNegativeProbeSource(probes) {
    return `${probes
        .map(probe => `${probe.sourceText} // excluded: ${probe.compatKey}`)
        .join("\n")}\n`;
}
