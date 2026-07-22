// @ts-check

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
    LOW_NEGATIVE_PROBE_CANDIDATES,
    REGEXP_LEGACY_STATIC_ABSENCE_ASSERTION,
    REGEXP_LEGACY_STATIC_MEMBER_NAMES,
    STABLE_NEGATIVE_PROBES,
    renderNegativeProbeSource,
    selectActiveNegativeProbes,
} from "../lib/negative-probes.mjs";
import {
    loadActiveNegativeProbesFromRepo,
    readJsonFile,
    repoRegistryPath,
    repoRoot,
} from "./helpers.mjs";

const compilerFixturePath = path.join(
    repoRoot,
    "fixtures",
    "typescript",
    "tests",
    "cases",
    "compiler",
    "libBaseline.ts",
);
const positiveSmokeFixturePath = path.join(
    repoRoot,
    "fixtures",
    "typescript",
    "smoke",
    "positive-flag.ts",
);

test("checked-in classification still excludes every stable probe and at least one low probe", () => {
    // If a stable probe flips to included or the low pool is wiped out, this
    // fails with an actionable "swap or top up the probes" message.
    // (A watchdog against the old Segmenter-hardcoded failure mode, where the
    // suite suddenly turned red for no obvious reason on the promotion day.)
    const activeProbes = loadActiveNegativeProbesFromRepo();

    for (const stableProbe of STABLE_NEGATIVE_PROBES) {
        assert.ok(
            activeProbes.some(probe => probe.compatKey === stableProbe.compatKey),
            `stable probe ${stableProbe.compatKey} must stay active`,
        );
    }
    assert.ok(
        activeProbes.length > STABLE_NEGATIVE_PROBES.length,
        "expected at least one active Baseline-low probe",
    );
});

test("TypeScript fixtures stay in sync with stable exclusion checks", () => {
    // Reference baselines are static expected values, so the compiler fixture
    // uses only permanently stable probes. This catches any drift between the
    // fixture and the probe definitions.
    const fixtureSource = fs.readFileSync(compilerFixturePath, "utf8");
    for (const probe of STABLE_NEGATIVE_PROBES) {
        assert.ok(
            fixtureSource.includes(probe.sourceText),
            `compiler fixture must contain stable probe source: ${probe.sourceText}`,
        );
    }
    for (const candidate of LOW_NEGATIVE_PROBE_CANDIDATES) {
        assert.ok(
            !fixtureSource.includes(candidate.sourceText),
            `compiler fixture must not hard-code dated low probe: ${candidate.compatKey}`,
        );
    }
    assert.ok(
        fixtureSource.includes(REGEXP_LEGACY_STATIC_ABSENCE_ASSERTION),
        "compiler fixture must contain the RegExp legacy static absence assertion",
    );
    assert.ok(
        fs.readFileSync(positiveSmokeFixturePath, "utf8").includes(REGEXP_LEGACY_STATIC_ABSENCE_ASSERTION),
        "upstream smoke fixture must contain the RegExp legacy static absence assertion",
    );

    const registry = readJsonFile(repoRegistryPath);
    const legacyGroup = registry.groups.find(
        /** @param {{ id: string; }} group */
        group => group.id === "regexp-legacy-statics-excluded",
    );
    assert.ok(legacyGroup);
    const mappedMemberNames = legacyGroup.compatKeys.flatMap(
        /** @param {string} compatKey */
        compatKey => registry.declarationMappings[compatKey].memberNames,
    );
    assert.deepEqual(
        [...new Set(mappedMemberNames)].sort(),
        [...REGEXP_LEGACY_STATIC_MEMBER_NAMES].sort(),
        "compiler assertion and declaration mappings must cover the same RegExp legacy statics",
    );
});

test("selectActiveNegativeProbes fails with actionable messages", () => {
    /**
     * @param {string} compatKey
     * @param {boolean} includeInTarget
     */
    function classificationRow(compatKey, includeInTarget) {
        return { compatKey, includeInTarget };
    }
    const allExcluded = [
        ...STABLE_NEGATIVE_PROBES.map(probe => classificationRow(probe.compatKey, false)),
        ...LOW_NEGATIVE_PROBE_CANDIDATES.map(probe => classificationRow(probe.compatKey, false)),
    ];

    // A stable probe flipping to included is an immediate error.
    assert.throws(
        () =>
            selectActiveNegativeProbes(
                allExcluded.map(row =>
                    row.compatKey === STABLE_NEGATIVE_PROBES[0].compatKey
                        ? classificationRow(row.compatKey, true)
                        : row
                ),
            ),
        /now included in the baseline target/,
    );

    // A wiped-out low pool errors, demanding a top-up.
    assert.throws(
        () =>
            selectActiveNegativeProbes(
                allExcluded.map(row =>
                    LOW_NEGATIVE_PROBE_CANDIDATES.some(probe => probe.compatKey === row.compatKey)
                        ? classificationRow(row.compatKey, true)
                        : row
                ),
            ),
        /Top up LOW_NEGATIVE_PROBE_CANDIDATES/,
    );

    // A promoted low probe silently drops out of the candidates.
    const [firstLow, ...remainingLow] = LOW_NEGATIVE_PROBE_CANDIDATES;
    const partiallyPromoted = selectActiveNegativeProbes(
        allExcluded.map(row =>
            row.compatKey === firstLow.compatKey ? classificationRow(row.compatKey, true) : row
        ),
    );
    assert.ok(!partiallyPromoted.some(probe => probe.compatKey === firstLow.compatKey));
    assert.ok(remainingLow.every(candidate => partiallyPromoted.some(probe => probe.compatKey === candidate.compatKey)));

    const rendered = renderNegativeProbeSource(partiallyPromoted);
    for (const probe of partiallyPromoted) {
        assert.ok(rendered.includes(probe.sourceText));
        assert.ok(rendered.includes(probe.compatKey));
    }
});
