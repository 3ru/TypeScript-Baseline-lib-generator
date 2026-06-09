// @ts-check

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    checkoutStradaSource,
    checkoutTypeScriptGoSource,
    readStradaSourcePin,
    readTypeScriptGoSourcePin,
} from "../lib/typescript-source.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const scriptDirectory = path.dirname(scriptPath);
const repoRoot = path.resolve(scriptDirectory, "..");
const defaultManifestPath = path.join(repoRoot, "manifests", "baseline-js.json");

const args = parseArgs(process.argv.slice(2));

main();

function main() {
    const manifestPath = path.resolve(args.manifest ?? defaultManifestPath);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

    if (args.source === "go") {
        const pin = readTypeScriptGoSourcePin(manifest);
        const summary = checkoutTypeScriptGoSource({
            manifest,
            outDirectory: args.out ?? path.join(repoRoot, ".tmp", "typescript-go"),
            force: args.force,
        });

        console.log(`# TypeScript Go Source Checkout

- Repository: \`${pin.repository}\`
- Tag: \`${pin.tag}\`
- Commit: \`${pin.commit}\`
- Strada submodule commit: \`${summary.stradaSubmoduleCommit}\`
- Directory: \`${summary.outDirectory}\`
- Reused existing checkout: ${summary.reusedExistingCheckout ? "yes" : "no"}`);
        return;
    }

    const pin = readStradaSourcePin(manifest);
    const summary = checkoutStradaSource({
        manifest,
        outDirectory: args.out ?? path.join(repoRoot, ".tmp", "TypeScript"),
        force: args.force,
    });

    console.log(`# TypeScript Source Checkout

- Repository: \`${pin.repository}\`
- Tag: \`${pin.tag}\`
- Commit: \`${pin.commit}\`
- Directory: \`${summary.outDirectory}\`
- Reused existing checkout: ${summary.reusedExistingCheckout ? "yes" : "no"}`);
}

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
    /** @type {{ manifest?: string; out?: string; force: boolean; source: "strada" | "go"; }} */
    const args = {
        force: false,
        source: "strada",
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
            case "--source": {
                const value = requireArgValue(argv[++index], current);
                if (value !== "strada" && value !== "go") {
                    throw new Error(`--source must be "strada" or "go", got ${value}`);
                }
                args.source = value;
                break;
            }
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
  node scripts/checkout-typescript-source.mjs [--manifest <path>] [--out <path>] [--source strada|go] [--force]

Examples:
  node scripts/checkout-typescript-source.mjs
  node scripts/checkout-typescript-source.mjs --out .tmp/TypeScript --force
  node scripts/checkout-typescript-source.mjs --source go --out .tmp/typescript-go --force
`);
    process.exit(0);
}
