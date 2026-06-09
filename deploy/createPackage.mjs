// @ts-check

import {
    mkdir,
    writeFile,
} from "node:fs/promises";
import path from "node:path";
import { createPackageStages } from "./package-lib.mjs";

const args = parseArgs(process.argv.slice(2));

const summaries = await createPackageStages({
    packageId: args.package,
    versionOverride: args.version,
});

if (args.summaryOut) {
    await mkdir(path.dirname(args.summaryOut), { recursive: true });
    await writeFile(args.summaryOut, `${JSON.stringify(summaries.map(summary => ({
        packageName: summary.packageConfig.name,
        packageVersion: summary.packageVersion,
        stageDirectory: summary.stageDirectory,
    })), undefined, 2)}\n`);
}

for (const summary of summaries) {
    console.log(`Built: ${summary.packageConfig.name}`);
    console.log(`Stage: ${summary.stageDirectory}`);
    console.log(`Version: ${summary.packageVersion}`);
}

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
    /** @type {{ package?: string; version?: string; summaryOut?: string; }} */
    const args = {};

    for (let index = 0; index < argv.length; index++) {
        const current = argv[index];
        switch (current) {
            case "--package":
                args.package = requireValue(argv[++index], current);
                break;
            case "--version":
                args.version = requireValue(argv[++index], current);
                break;
            case "--summary-out":
                args.summaryOut = path.resolve(requireValue(argv[++index], current));
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
function requireValue(value, flagName) {
    if (!value) {
        throw new Error(`Missing value for ${flagName}`);
    }
    return value;
}

function printUsageAndExit() {
    console.log(`Usage:
  node deploy/createPackage.mjs [--package <id>] [--version <semver>] [--summary-out <path>]

Examples:
  node deploy/createPackage.mjs
  node deploy/createPackage.mjs --version 0.0.0-test
`);
    process.exit(0);
}
