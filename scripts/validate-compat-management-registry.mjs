// @ts-check

import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCompatManagementRegistry } from "../lib/compat-management-registry.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const scriptDirectory = path.dirname(scriptPath);
const repoRoot = path.resolve(scriptDirectory, "..");
const defaultRegistryPath = path.join(repoRoot, "registry", "compat-management.json");

const args = parseArgs(process.argv.slice(2));
const registryPath = path.resolve(args.registry ?? defaultRegistryPath);

await main();

async function main() {
    const registry = await loadCompatManagementRegistry(registryPath);

    console.log(`Validated compat-management registry ${registryPath}`);
    console.log(`Groups: ${registry.groups.length}`);
    console.log(`Compat keys: ${registry.entries.length}`);
    console.log(`Source hash: ${registry.sourceHash}`);
}

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
    /** @type {{ registry?: string; }} */
    const args = {};

    for (let index = 0; index < argv.length; index++) {
        const current = argv[index];
        switch (current) {
            case "--registry":
                args.registry = requireArgValue(argv[++index], current);
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
  node scripts/validate-compat-management-registry.mjs [--registry <path>]
`);
    process.exit(0);
}
