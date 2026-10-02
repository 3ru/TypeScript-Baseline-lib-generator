// @ts-check

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { getCompatFeatureMemberships } from "../lib/compat-rows.mjs";
import {
    cleanupTempDirectories,
    createManifest,
    createTempDirectory,
    readJsonFile,
    repoDatasetPath,
    runGenerate,
    writeJsonFile,
} from "./helpers.mjs";

/** @type {string[]} */
const tempDirectories = [];

test.afterEach(() => {
    cleanupTempDirectories(tempDirectories);
});

test("feature overlaps preserve baseline, allowlist, and year declarations without double counting", () => {
    const tempDirectory = createTempDirectory(tempDirectories);
    const datasetPath = path.join(tempDirectory, "dataset.json");
    const dataset = readJsonFile(repoDatasetPath);
    writeJsonFile(datasetPath, dataset);
    const fixture = createManifest(tempDirectory, { datasetPath });
    runGenerate(fixture.manifestPath);
    const originalDeclarations = declarationSnapshot(path.join(fixture.outputRoot, "generated"));
    const originalClassification = readJsonFile(fixture.classificationOutputPath);
    const originalGeneration = readJsonFile(fixture.generationOutputPath);
    const originalManagement = readJsonFile(fixture.compatManagementOutputPath);

    const overlappingKeys = new Set([
        "javascript.builtins.Array.at",
        "javascript.builtins.Set.union",
        "javascript.builtins.String.substr",
    ]);
    const originalRows = dataset.compatRows.filter(
        /** @param {{ compatKey: string; }} row */
        row => overlappingKeys.has(row.compatKey),
    );
    assert.equal(originalRows.length, overlappingKeys.size);
    const addedFeature = {
        featureId: "aaa-overlapping-feature",
        featureName: "Overlapping feature",
        snapshot: ["ecmascript-2025"],
        group: ["overlapping-group"],
    };
    dataset.featureRows.push({ ...addedFeature, baselineStatus: false });
    dataset.compatRows.push(...originalRows.map(
        /** @param {any} row */
        row => ({ ...row, ...addedFeature, sourceRefs: ["overlap-source", ...row.sourceRefs] }),
    ));
    writeJsonFile(datasetPath, dataset);
    runGenerate(fixture.manifestPath);

    const classification = readJsonFile(fixture.classificationOutputPath);
    assert.deepEqual(classification.summary, {
        ...originalClassification.summary,
        featureCount: originalClassification.summary.featureCount + 1,
    });
    assert.deepEqual(readJsonFile(fixture.generationOutputPath), originalGeneration);
    assert.deepEqual(readJsonFile(fixture.compatManagementOutputPath), originalManagement);
    assert.deepEqual(declarationSnapshot(path.join(fixture.outputRoot, "generated")), originalDeclarations);

    for (const originalRow of originalRows) {
        const matchingRows = classification.classifiedCompatRows.filter(
            /** @param {{ compatKey: string; }} row */
            row => row.compatKey === originalRow.compatKey,
        );
        assert.equal(matchingRows.length, 1);
        const classified = matchingRows[0];
        assert.equal(classified.featureId, addedFeature.featureId);
        assert.equal(classified.baselineStatus, originalRow.baselineStatus);
        assert.deepEqual(getCompatFeatureMemberships(classified), [
            addedFeature,
            ...getCompatFeatureMemberships(originalRow),
        ]);
        assert.deepEqual(classified.sourceRefs, [...originalRow.sourceRefs, "overlap-source"].sort());
    }

    const report = fs.readFileSync(fixture.classificationOutputPath, "utf8");
    dataset.compatRows.reverse();
    dataset.featureRows.reverse();
    writeJsonFile(datasetPath, dataset);
    runGenerate(fixture.manifestPath);
    assert.equal(fs.readFileSync(fixture.classificationOutputPath, "utf8"), report);
    assert.deepEqual(declarationSnapshot(path.join(fixture.outputRoot, "generated")), originalDeclarations);
});

/** @param {string} directory */
function declarationSnapshot(directory) {
    return fs.readdirSync(directory, { recursive: true, withFileTypes: true })
        .filter(entry => entry.isFile())
        .map(entry => path.join(entry.parentPath, entry.name))
        .sort()
        .map(filePath => ({
            path: path.relative(directory, filePath),
            contents: fs.readFileSync(filePath, "utf8"),
        }));
}
