// @ts-check

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    checkoutTypeScriptSource,
    readTypeScriptSourcePin,
} from "../lib/typescript-source.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const scriptDirectory = path.dirname(scriptPath);
const repoRoot = path.resolve(scriptDirectory, "..");
const defaultManifestPath = path.join(repoRoot, "manifests", "baseline-js.json");

const args = parseArgs(process.argv.slice(2));
const manifestPath = path.resolve(args.manifest ?? defaultManifestPath);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const pin = readTypeScriptSourcePin(manifest);
const summary = checkoutTypeScriptSource({
    manifest,
    outDirectory: args.out ?? path.join(repoRoot, ".tmp", "TypeScript"),
    force: args.force,
});

console.log(`# TypeScript Source Checkout

- Repository: \`${pin.repository}\`
- Ref: \`${pin.ref}\`
- Commit: \`${pin.commit}\`
- Directory: \`${summary.outDirectory}\`
- Reused existing checkout: ${summary.reusedExistingCheckout ? "yes" : "no"}`);

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
    /** @type {{ manifest?: string; out?: string; force: boolean; }} */
    const args = {
        force: false,
    };

    for (let index = 0; index < argv.length; index++) {
        const current = argv[index];
        switch (current) {
            case "--manifest":
                args.manifest = requireArgValue(argv[++index], current);
                break;
            case "--out":
                args.out = path.resolve(requireArgValue(argv[++index], current));
                break;
            case "--force":
                args.force = true;
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
  node scripts/checkout-typescript-source.mjs [--manifest <path>] [--out <path>] [--force]

Examples:
  node scripts/checkout-typescript-source.mjs
  node scripts/checkout-typescript-source.mjs --out .tmp/TypeScript --force
`);
    process.exit(0);
}
