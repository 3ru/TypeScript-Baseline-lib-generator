// @ts-check

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadBaselineDataset } from "../lib/dataset-loader.mjs";
import { requireRelativeManifestPath } from "../lib/shared.mjs";
import { verifyWebFeaturesDataset } from "../lib/web-features-dataset.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDirectory, "..");
const manifestPath = path.join(repoRoot, "manifests", "baseline-js.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const datasetPath = requireRelativeManifestPath(manifest.dataset, manifestPath, "dataset");
const dataset = await loadBaselineDataset(
    datasetPath,
    manifest.snapshot.name,
    manifest.snapshot.baselineDate,
    manifest.snapshot.webFeaturesPackageVersion,
);

await verifyWebFeaturesDataset({
    repoRoot,
    packageName: manifest.toolchain.webFeaturesPackage,
    dataset,
});

console.log(`Verified ${datasetPath} against ${manifest.toolchain.webFeaturesPackage}@${manifest.snapshot.webFeaturesPackageVersion}`);
