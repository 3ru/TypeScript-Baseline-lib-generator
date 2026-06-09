// @ts-check

import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateFirstClassBaselineLib } from "../lib/generator.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const scriptDirectory = path.dirname(scriptPath);
const repoRoot = path.resolve(scriptDirectory, "..");
const defaultManifestPath = path.join(repoRoot, "manifests", "baseline-js.json");

const args = parseArgs(process.argv.slice(2));
const manifestPath = path.resolve(args.manifest ?? defaultManifestPath);

await main();

async function main() {
    const plan = await generateFirstClassBaselineLib({
        manifestPath,
        repoRoot,
    });

    console.log(`Generated first-class baseline lib ${plan.manifest.firstClassLib.libName}`);
    console.log(`Top-level: ${path.relative(repoRoot, plan.topLevelOutputPath)}`);
    console.log(`Source libs: ${plan.sourceLibEntries.length}`);
    console.log(`Compat rows: ${plan.classification.classifiedCompatRows.length}`);
    console.log(`Selected units: ${plan.selectedUnitIds.length}`);
    console.log(`Transforms: ${plan.unitTextOverrides.size}`);
}

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
    /** @type {{ manifest?: string }} */
    const args = {};

    for (let index = 0; index < argv.length; index++) {
        const current = argv[index];
        switch (current) {
            case "--manifest":
                args.manifest = requireArgValue(argv[++index], current);
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
  node scripts/generate.mjs [--manifest <path>]

Examples:
  node scripts/generate.mjs
  node scripts/generate.mjs --manifest ./manifests/baseline-js.json
`);
    process.exit(0);
}
