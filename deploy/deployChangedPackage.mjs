// @ts-check

import {
    mkdir,
    writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
    collectReleasePlans,
    publishReleasePlan,
} from "./package-lib.mjs";

const args = parseArgs(process.argv.slice(2));

// A real publish is an irreversible external release, so don't run it unless
// in CI (e.g. GitHub Actions) or given an explicit --yes. This structurally
// prevents accidentally publishing to npm just by running
// `node deploy/deployChangedPackage.mjs`.
if (!args.dryRun && !args.yes && process.env.CI !== "true") {
    throw new Error(
        "Refusing to publish outside CI without explicit confirmation. "
            + "Re-run with --dry-run to preview, or pass --yes to publish from a local environment.",
    );
}

const releasePlans = await collectReleasePlans({
    packageId: args.package,
    versionOverride: args.version,
    preview: args.dryRun,
});

/** @type {Array<Record<string, unknown>>} */
const publishSummary = [];
for (const releasePlan of releasePlans) {
    const publishResult = await publishReleasePlan(releasePlan, {
        dryRun: args.dryRun,
        provenance: args.provenance,
        createGitHubRelease: args.githubRelease,
        githubRepository: process.env.GITHUB_REPOSITORY,
        githubToken: process.env.GITHUB_TOKEN,
        githubSha: process.env.GITHUB_SHA,
    });

    publishSummary.push({
        packageName: releasePlan.packageConfig.name,
        packageVersion: releasePlan.packageVersion,
        publishedVersion: releasePlan.publishedVersion,
        changed: releasePlan.changed,
        changedFiles: releasePlan.changedFiles,
        removedFiles: releasePlan.removedFiles,
        published: publishResult.published,
        releaseCreated: publishResult.releaseCreated,
        stageDirectory: releasePlan.stageDirectory,
    });

    console.log(`Package: ${releasePlan.packageConfig.name}`);
    console.log(`Next version: ${releasePlan.packageVersion}`);
    console.log(`Latest published: ${releasePlan.publishedVersion ?? "none"}`);
    console.log(`Changed: ${releasePlan.changed ? "yes" : "no"}`);
    if (releasePlan.requiredVersionBump && !args.version) {
        console.log(`Reviewed release version required: ${releasePlan.requiredVersionBump} bump`);
    }
    if (releasePlan.changedFiles.length) {
        console.log(`Changed files: ${releasePlan.changedFiles.join(", ")}`);
    }
    if (releasePlan.removedFiles.length) {
        console.log(`Removed files: ${releasePlan.removedFiles.join(", ")}`);
    }
    if (args.dryRun) {
        console.log("Publish: dry-run");
    }
}

if (args.notesOut) {
    await mkdir(path.dirname(args.notesOut), { recursive: true });
    const notesText = releasePlans.map(releasePlan => releasePlan.notesMarkdown).join("\n---\n\n");
    await writeFile(args.notesOut, `${notesText}\n`);
}

if (args.summaryOut) {
    await mkdir(path.dirname(args.summaryOut), { recursive: true });
    await writeFile(args.summaryOut, `${JSON.stringify(publishSummary, undefined, 2)}\n`);
}

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
    /** @type {{ package?: string; version?: string; notesOut?: string; summaryOut?: string; dryRun?: boolean; yes?: boolean; provenance?: boolean; githubRelease?: boolean; }} */
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
            case "--notes-out":
                args.notesOut = path.resolve(requireValue(argv[++index], current));
                break;
            case "--summary-out":
                args.summaryOut = path.resolve(requireValue(argv[++index], current));
                break;
            case "--dry-run":
                args.dryRun = true;
                break;
            case "--yes":
                args.yes = true;
                break;
            case "--provenance":
                args.provenance = true;
                break;
            case "--github-release":
                args.githubRelease = true;
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
  node deploy/deployChangedPackage.mjs [--package <id>] [--version <semver>] [--dry-run] [--yes] [--provenance] [--notes-out <path>] [--summary-out <path>] [--github-release]

Notes:
  A real publish runs only in CI (CI=true) or when --yes is passed.
  --provenance attaches npm provenance via GitHub Actions OIDC.

Examples:
  node deploy/deployChangedPackage.mjs --dry-run
  node deploy/deployChangedPackage.mjs --yes --notes-out .tmp/package-release-notes.md --summary-out .tmp/package-release-summary.json
`);
    process.exit(0);
}
