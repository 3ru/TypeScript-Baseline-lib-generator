// @ts-check

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    refreshManifestSnapshot,
    writeManifest,
} from "../lib/manifest-snapshot.mjs";
import {
    buildWebFeaturesDataset,
    resolveSnapshotDate,
    writeWebFeaturesDataset,
} from "../lib/web-features-dataset.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const scriptDirectory = path.dirname(scriptPath);
const repoRoot = path.resolve(scriptDirectory, "..");

const args = parseArgs(process.argv.slice(2));
const manifestPath = path.resolve(args.manifest ?? path.join(repoRoot, "manifests", "baseline-js.json"));
const snapshotDate = args.snapshotDate ?? new Date().toISOString().slice(0, 10);
const snapshotName = args.snapshotName ?? "baseline-js";

await main();

async function main() {
    const datasetPath = path.join(repoRoot, "datasets", "web-features-js-compat.json");
    const dataset = await buildWebFeaturesDataset({
        repoRoot,
        snapshotDate,
        snapshotName,
    });

    // In weeks with no real web-features change, avoid a "date-only PR" where only
    // the extraction date moves: if the content matches the checked-in dataset, keep the existing extraction date.
    const existingDataset = existsSync(datasetPath)
        ? JSON.parse(readFileSync(datasetPath, "utf8"))
        : undefined;
    const effectiveDate = resolveSnapshotDate({
        existingDataset,
        newDataset: dataset,
        candidateDate: snapshotDate,
    });
    dataset.snapshot.baselineDate = effectiveDate;
    dataset.snapshot.extractedDate = effectiveDate;

    await writeWebFeaturesDataset({
        outputPath: datasetPath,
        dataset,
    });

    const { manifest } = await refreshManifestSnapshot({
        repoRoot,
        manifestPath,
        snapshotName,
        baselineDate: effectiveDate,
        updateOutputPaths: true,
    });
    await writeManifest({
        manifestPath,
        manifest,
    });

    const dateNote = effectiveDate === snapshotDate ? "" : " (unchanged content; snapshot date preserved)";
    console.log(`Wrote ${dataset.featureRows.length} feature rows and ${dataset.compatRows.length} compat rows to ${datasetPath}`);
    console.log(`Updated manifest ${manifestPath}`);
    console.log(`Dataset path: ${datasetPath}`);
    console.log(`Snapshot: ${snapshotName} @ ${effectiveDate}${dateNote}`);
}

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
    /** @type {{ manifest?: string; snapshotDate?: string; snapshotName?: string }} */
    const args = {};

    for (let index = 0; index < argv.length; index++) {
        const current = argv[index];
        switch (current) {
            case "--manifest":
                args.manifest = requireArgValue(argv[++index], current);
                break;
            case "--snapshot-date":
                args.snapshotDate = requireArgValue(argv[++index], current);
                break;
            case "--snapshot-name":
                args.snapshotName = requireArgValue(argv[++index], current);
                break;
            case "--help":
            case "-h":
                printUsageAndExit();
                break;
            default:
                throw new Error(`Unknown argument: ${current}`);
        }
    }

    return args;
}

/**
 * @param {string | undefined} value
 * @param {string} flagName
 */
function requireArgValue(value, flagName) {
    if (!value) {
        throw new Error(`Missing value for ${flagName}`);
    }
    return value;
}

function printUsageAndExit() {
    console.log(`Usage:
  node scripts/update-web-features.mjs [--manifest <path>] [--snapshot-date <YYYY-MM-DD>] [--snapshot-name <name>]

Examples:
  node scripts/update-web-features.mjs
  node scripts/update-web-features.mjs --snapshot-date 2026-04-28
`);
    process.exit(0);
}
