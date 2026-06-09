// @ts-check

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
    createPackageStages,
    createPackageTarball,
} from "./package-lib.mjs";

const args = parseArgs(process.argv.slice(2));

const summaries = await createPackageStages({
    packageId: args.package,
    versionOverride: args.version,
});

/** @type {Array<Record<string, string>>} */
const tarballSummaries = [];
for (const summary of summaries) {
    const tarballPath = await createPackageTarball(summary.stageDirectory);
    tarballSummaries.push({
        packageName: summary.packageConfig.name,
        packageVersion: summary.packageVersion,
        stageDirectory: summary.stageDirectory,
        tarballPath,
    });

    console.log(`Built: ${summary.packageConfig.name}`);
    console.log(`Stage: ${summary.stageDirectory}`);
    console.log(`Version: ${summary.packageVersion}`);
    console.log(`Tarball: ${tarballPath}`);
}

if (args.summaryOut) {
    await mkdir(path.dirname(args.summaryOut), { recursive: true });
    await writeFile(args.summaryOut, `${JSON.stringify(tarballSummaries, undefined, 2)}\n`);
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
  node deploy/createPackageTarball.mjs [--package <id>] [--version <semver>] [--summary-out <path>]

Examples:
  node deploy/createPackageTarball.mjs
  node deploy/createPackageTarball.mjs --version 0.0.0-test
`);
    process.exit(0);
}
