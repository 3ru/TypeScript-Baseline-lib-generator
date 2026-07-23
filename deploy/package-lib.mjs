// @ts-check

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    cp,
    mkdtemp,
    mkdir,
    readFile,
    readdir,
    rm,
    writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { retryAsync, retrySync } from "../lib/net-retry.mjs";
import { packages, repoRoot } from "./package-registry.mjs";
import { resolveReleaseExecutable } from "./trusted-executable.mjs";

/**
 * @param {{
 *   packageId?: string;
 *   versionOverride?: string;
 *   versionBump?: ReleaseBump;
 *   stageDirectoryRoot?: string;
 * }} [options]
 */
export async function createPackageStages(options = {}) {
    if (options.versionOverride !== undefined && options.versionBump !== undefined) {
        throw new Error("Package staging accepts either versionOverride or versionBump, not both");
    }
    const selectedPackages = selectPackages(options.packageId);
    const snapshot = await readCurrentSnapshot();

    /** @type {PackageStageSummary[]} */
    const summaries = [];
    for (const packageConfig of selectedPackages) {
        summaries.push(await createPackageStage(
            packageConfig,
            snapshot,
            options.versionOverride,
            options.versionBump ?? "patch",
            getStageDirectory(packageConfig, options.stageDirectoryRoot),
        ));
    }

    return summaries;
}

const DELIVERED_COMPAT_RESOLUTION_KINDS = new Set([
    "constructor",
    "inherited-member",
    "member",
    "option-property",
    "root-availability",
    "signature-compat",
    "transform-only",
    "type-property",
]);
const NON_DECLARATION_COMPAT_RESOLUTION_KINDS = new Set([
    "already-excluded-upstream",
    "behavioral",
    "not-modeled-upstream",
]);

/**
 * @param {Array<{ includeInTarget: boolean; resolutionKind: string; }>} classifiedCompatRows
 */
export function countIncludedCompatRows(classifiedCompatRows) {
    let count = 0;
    for (const row of classifiedCompatRows) {
        const delivered = DELIVERED_COMPAT_RESOLUTION_KINDS.has(row.resolutionKind);
        const nonDeclaration = NON_DECLARATION_COMPAT_RESOLUTION_KINDS.has(row.resolutionKind);
        if (!delivered && !nonDeclaration) {
            throw new Error(`Unknown compat resolution kind: ${row.resolutionKind}`);
        }
        if (row.includeInTarget && delivered) {
            count++;
        }
    }
    return count;
}

/**
 * @param {string} range
 * @param {string[]} versions
 */
export function assertTypeScriptPeerRange(range, versions) {
    const numericIdentifier = "(0|[1-9]\\d*)";
    const rangeMatch = typeof range === "string"
        ? range.match(new RegExp(`^>=${numericIdentifier} <${numericIdentifier}$`))
        : undefined;
    if (!rangeMatch) {
        throw new Error(`Unsupported TypeScript peer range: ${range}`);
    }
    const minimumMajor = Number(rangeMatch[1]);
    const maximumMajor = Number(rangeMatch[2]);
    if (minimumMajor >= maximumMajor) {
        throw new Error(`Unsupported TypeScript peer range: ${range}`);
    }
    if (!versions.length) {
        throw new Error("No TypeScript versions were provided for peer range validation");
    }
    for (const version of versions) {
        const versionMatch = typeof version === "string"
            ? version.match(new RegExp(`^${numericIdentifier}\\.${numericIdentifier}\\.${numericIdentifier}$`))
            : undefined;
        if (!versionMatch) {
            throw new Error(`Unsupported TypeScript version: ${version}`);
        }
        const major = Number(versionMatch[1]);
        if (major < minimumMajor || major >= maximumMajor) {
            throw new Error(`TypeScript ${version} is outside peer range ${range}`);
        }
    }
}

/**
 * @param {{
 *   packageId?: string;
 *   versionOverride?: string;
 *   versionBump?: ReleaseBump;
 *   stageDirectoryRoot?: string;
 * }} [options]
 */
export async function collectReleasePlans(options = {}) {
    const stageSummaries = await createPackageStages(options);

    /** @type {ReleasePlan[]} */
    const releasePlans = [];
    for (const stageSummary of stageSummaries) {
        releasePlans.push(await buildReleasePlan(stageSummary));
    }

    return releasePlans;
}

/**
 * @param {PackageRegistryEntry} packageConfig
 * @param {CurrentSnapshot} snapshot
 * @param {string | undefined} versionOverride
 * @param {ReleaseBump} versionBump
 * @param {string} stageDirectory
 */
async function createPackageStage(packageConfig, snapshot, versionOverride, versionBump, stageDirectory) {
    assertTypeScriptPeerRange(packageConfig.typescriptPeerDependencyRange, [
        snapshot.manifest.snapshot.typescriptStradaVersion,
        snapshot.manifest.snapshot.typescriptVersion,
    ]);
    await rm(stageDirectory, { recursive: true, force: true });
    await mkdir(stageDirectory, { recursive: true });

    for (const file of packageConfig.generatedFiles) {
        const destinationPath = path.join(stageDirectory, file.to);
        await mkdir(path.dirname(destinationPath), { recursive: true });
        await cp(file.from, destinationPath, { recursive: true });
    }

    const packageVersion = versionOverride ?? await resolveNextPackageVersion(packageConfig, versionBump);
    const includedCompatCount = countIncludedCompatRows(snapshot.classification.classifiedCompatRows);
    const snapshotMetadata = {
        schemaVersion: 1,
        baselineDate: snapshot.manifest.snapshot.baselineDate,
        webFeaturesPackageVersion: snapshot.manifest.snapshot.webFeaturesPackageVersion,
        webFeaturesGitHead: snapshot.manifest.snapshot.webFeaturesGitHead,
        typescriptVersion: snapshot.manifest.snapshot.typescriptVersion,
        includedCompatCount,
        generatorVersion: snapshot.manifest.snapshot.generatorVersion,
    };
    const packageJson = {
        name: packageConfig.name,
        version: packageVersion,
        description: packageConfig.description,
        license: packageConfig.license,
        homepage: packageConfig.homepage,
        repository: {
            type: "git",
            url: packageConfig.repositoryUrl,
        },
        bugs: {
            url: packageConfig.bugsUrl,
        },
        peerDependencies: {
            typescript: packageConfig.typescriptPeerDependencyRange,
        },
        peerDependenciesMeta: {
            typescript: {
                optional: true,
            },
        },
        publishConfig: {
            access: "public",
        },
        keywords: packageConfig.keywords,
        types: "./index.d.ts",
        typesVersions: {
            "*": {
                "allow/*": ["allow/*/index.d.ts"],
                "year/*": ["year/*/index.d.ts"],
            },
        },
        files: [
            "index.d.ts",
            "baseline.d.ts",
            "snapshot.json",
            "allow/",
            "year/",
            "reports/",
            "README.md",
            "LICENSE",
            "NOTICE.txt",
        ],
    };

    await writeFile(
        path.join(stageDirectory, "index.d.ts"),
        "/// <reference path=\"./baseline.d.ts\" />\n",
    );
    await writeFile(
        path.join(stageDirectory, "package.json"),
        `${JSON.stringify(packageJson, undefined, 2)}\n`,
    );
    await writeFile(
        path.join(stageDirectory, "snapshot.json"),
        `${JSON.stringify(snapshotMetadata, undefined, 2)}\n`,
    );
    await writeFile(
        path.join(stageDirectory, "README.md"),
        renderTemplate(await readFile(packageConfig.readmeTemplatePath, "utf8"), {
            PACKAGE_NAME: packageConfig.name,
            PACKAGE_VERSION: packageVersion,
            TYPESCRIPT_PEER_DEPENDENCY_RANGE: packageConfig.typescriptPeerDependencyRange,
            BASELINE_DATE: snapshot.manifest.snapshot.baselineDate,
            TYPESCRIPT_VERSION: snapshot.manifest.snapshot.typescriptVersion,
            WEB_FEATURES_VERSION: snapshot.manifest.snapshot.webFeaturesPackageVersion,
            WEB_FEATURES_GIT_HEAD: snapshot.manifest.snapshot.webFeaturesGitHead,
            INCLUDED_COMPAT_COUNT: String(includedCompatCount),
            SELECTED_UNIT_COUNT: String(snapshot.generation.summary.selectedUnitCount),
            TRANSFORMED_UNIT_COUNT: String(snapshot.generation.summary.transformedUnitCount),
        }),
    );
    await cp(path.join(repoRoot, "LICENSE"), path.join(stageDirectory, "LICENSE"));
    await writeFile(
        path.join(stageDirectory, "NOTICE.txt"),
        renderNotice(packageConfig, snapshot),
    );

    return {
        packageConfig,
        stageDirectory,
        packageVersion,
        snapshot,
    };
}

/**
 * @param {PackageStageSummary} stageSummary
 */
async function buildReleasePlan(stageSummary) {
    const published = await getPublishedPackageState(stageSummary.packageConfig);
    const stagedSnapshot = await readComparablePackageSnapshot(stageSummary.stageDirectory);

    const changedFiles = [];
    const unchangedFiles = [];
    const stagedPaths = [...stagedSnapshot.keys()].sort(compareStrings);
    const publishedPaths = new Set(published.snapshot.keys());

    for (const relativePath of stagedPaths) {
        if (!published.snapshot.has(relativePath) || published.snapshot.get(relativePath) !== stagedSnapshot.get(relativePath)) {
            changedFiles.push(relativePath);
        }
        else {
            unchangedFiles.push(relativePath);
        }
        publishedPaths.delete(relativePath);
    }

    const removedFiles = [...publishedPaths].sort(compareStrings);
    assertNoRemovedAllowEntries(removedFiles);
    assertAllowEntryContractsPreserved(
        published.snapshot.get("reports/generation.json"),
        stagedSnapshot.get("reports/generation.json"),
    );
    assertNoRemovedYearEntryPoints(removedFiles);
    const changed = !published.version || changedFiles.length > 0 || removedFiles.length > 0;

    return {
        ...stageSummary,
        publishedVersion: published.version,
        publishedSnapshotHash: published.snapshotHash,
        stagedSnapshotHash: hashComparableSnapshot(stagedSnapshot),
        changed,
        changedFiles,
        unchangedFiles,
        removedFiles,
        notesMarkdown: renderReleaseNotes({
            stageSummary,
            publishedVersion: published.version,
            changed,
            changedFiles,
            removedFiles,
        }),
    };
}

/**
 * @param {string[]} removedFiles
 */
export function assertNoRemovedAllowEntries(removedFiles) {
    const removedEntries = removedFiles.filter(relativePath => /^allow\/[^/]+\/index\.d\.ts$/.test(relativePath));
    if (removedEntries.length) {
        throw new Error(`Published allow entry paths cannot be removed: ${removedEntries.join(", ")}`);
    }
}

/**
 * @param {string[]} removedFiles
 */
export function assertNoRemovedYearEntryPoints(removedFiles) {
    const removedEntryPoints = removedFiles.filter(relativePath => /^year\/\d{4}\/index\.d\.ts$/.test(relativePath));
    if (removedEntryPoints.length) {
        throw new Error(`Published Baseline year entrypoints cannot be removed: ${removedEntryPoints.join(", ")}`);
    }
}

/**
 * @param {string | undefined} publishedReportText
 * @param {string | undefined} stagedReportText
 */
export function assertAllowEntryContractsPreserved(publishedReportText, stagedReportText) {
    if (!publishedReportText) {
        return;
    }
    if (!stagedReportText) {
        throw new Error("The staged package is missing reports/generation.json");
    }

    const publishedEntries = readAllowEntryContracts(publishedReportText, "published");
    const stagedEntries = readAllowEntryContracts(stagedReportText, "staged");
    for (const [entryName, publishedCompatKeys] of publishedEntries) {
        const stagedCompatKeys = stagedEntries.get(entryName);
        if (!stagedCompatKeys || JSON.stringify(stagedCompatKeys) !== JSON.stringify(publishedCompatKeys)) {
            throw new Error(`Published allow entry contract changed: allow/${entryName}`);
        }
    }
}

/**
 * @param {string} currentVersion
 * @param {ReleaseBump} bump
 */
export function incrementPackageVersion(currentVersion, bump) {
    const current = parseVersion(currentVersion);
    switch (bump) {
        case "major":
            return `${current.major + 1}.0.0`;
        case "minor":
            return `${current.major}.${current.minor + 1}.0`;
        case "patch":
            return current.prerelease
                ? `${current.major}.${current.minor}.${current.patch}`
                : `${current.major}.${current.minor}.${current.patch + 1}`;
        default:
            throw new Error(`Unsupported release bump: ${bump}`);
    }
}

/**
 * @param {string} value
 */
function parseVersion(value) {
    const numericIdentifier = "(?:0|[1-9]\\d*)";
    const dotSeparatedIdentifiers = "[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*";
    const match = new RegExp(
        `^(${numericIdentifier})\\.(${numericIdentifier})\\.(${numericIdentifier})`
            + `(?:-(${dotSeparatedIdentifiers}))?(?:\\+${dotSeparatedIdentifiers})?$`,
    ).exec(value);
    if (
        !match
        || match[4]?.split(".").some(identifier => /^\d+$/.test(identifier) && identifier.length > 1 && identifier[0] === "0")
    ) {
        throw new Error(`Unsupported package version format: ${value}`);
    }
    const parsed = {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
        prerelease: match[4],
    };
    if (![parsed.major, parsed.minor, parsed.patch].every(Number.isSafeInteger)) {
        throw new Error(`Unsupported package version format: ${value}`);
    }
    return parsed;
}

/**
 * @param {string} reportText
 * @param {string} label
 */
function readAllowEntryContracts(reportText, label) {
    /** @type {{ allowEntries?: Array<{ entryName?: unknown; compatKeys?: unknown; }>; }} */
    const report = JSON.parse(reportText);
    const contracts = new Map();
    for (const entry of report.allowEntries ?? []) {
        if (
            typeof entry.entryName !== "string"
            || !Array.isArray(entry.compatKeys)
            || entry.compatKeys.some(compatKey => typeof compatKey !== "string")
            || contracts.has(entry.entryName)
        ) {
            throw new Error(`Invalid ${label} allow entry contract report`);
        }
        contracts.set(entry.entryName, [...entry.compatKeys].sort(compareStrings));
    }
    return contracts;
}

/**
 * @param {PackageRegistryEntry} packageConfig
 * @param {ReleaseBump} bump
 */
async function resolveNextPackageVersion(packageConfig, bump) {
    const currentVersion = await getLatestPublishedVersion(packageConfig.name);
    if (!currentVersion) {
        return bump === "patch"
            ? packageConfig.initialVersion
            : incrementPackageVersion("0.0.0", bump);
    }
    return incrementPackageVersion(currentVersion, bump);
}

/**
 * @param {string} packageName
 */
async function getLatestPublishedVersion(packageName) {
    const metadata = await fetchPackageMetadata(packageName);
    return metadata?.["dist-tags"]?.latest;
}

/**
 * @param {PackageRegistryEntry} packageConfig
 */
async function getPublishedPackageState(packageConfig) {
    const version = await getLatestPublishedVersion(packageConfig.name);
    if (!version) {
        return {
            version: undefined,
            snapshot: new Map(),
            snapshotHash: hashComparableSnapshot(new Map()),
        };
    }

    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "ts-baseline-published-package-"));
    try {
        // Fetching the published tarball is read-only, so it's safe to retry through registry flake.
        const npm = resolveReleaseExecutable(repoRoot, "RELEASE_NPM_EXECUTABLE", "npm");
        const packOutput = retrySync(`npm pack ${packageConfig.name}@${version}`, () => execFileSync(npm.executable, ["pack", `${packageConfig.name}@${version}`, "--silent"], {
            cwd: tempDirectory,
            encoding: "utf8",
            env: npm.environment,
        })).trim();
        const tarballName = packOutput.split(/\r?\n/).filter(Boolean).at(-1);
        if (!tarballName) {
            throw new Error(`npm pack did not return a tarball name for ${packageConfig.name}@${version}`);
        }

        const tar = resolveReleaseExecutable(repoRoot, "RELEASE_TAR_EXECUTABLE", "tar");
        execFileSync(tar.executable, ["-xzf", tarballName], {
            cwd: tempDirectory,
            stdio: "ignore",
            env: tar.environment,
        });

        const packageDirectory = path.join(tempDirectory, "package");
        const snapshot = await readComparablePackageSnapshot(packageDirectory);
        return {
            version,
            snapshot,
            snapshotHash: hashComparableSnapshot(snapshot),
        };
    }
    finally {
        await rm(tempDirectory, { recursive: true, force: true });
    }
}

/**
 * @param {string} packageName
 * @returns {Promise<NpmPackageMetadata | undefined>}
 */
async function fetchPackageMetadata(packageName) {
    // Registry metadata fetch is a read-only GET, so retrying is fine.
    // A 404 means "not published yet" — a normal case, so don't retry it.
    const response = await retryAsync(`fetch npm metadata for ${packageName}`, async () => {
        const result = await fetch(`https://registry.npmjs.org/${encodeURIComponent(packageName)}`);
        if (!result.ok && result.status !== 404) {
            throw new Error(`registry returned ${result.status} ${result.statusText}`);
        }
        return result;
    });
    if (response.status === 404) {
        return undefined;
    }
    if (!response.ok) {
        throw new Error(`Failed to fetch npm metadata for ${packageName}: ${response.status} ${response.statusText}`);
    }
    return /** @type {Promise<NpmPackageMetadata>} */ (response.json());
}

/**
 * @param {string} directoryPath
 */
export async function createPackageTarball(directoryPath) {
    const tarballRoot = path.join(repoRoot, ".tmp", "release-tarballs");
    await mkdir(tarballRoot, { recursive: true });
    const tarballDirectory = await mkdtemp(path.join(tarballRoot, "pack-"));
    const npm = resolveReleaseExecutable(repoRoot, "RELEASE_NPM_EXECUTABLE", "npm");
    const packOutput = execFileSync(npm.executable, ["pack", directoryPath, "--pack-destination", tarballDirectory, "--silent"], {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
            ...npm.environment,
            npm_config_cache: path.join(tarballDirectory, "npm-cache"),
        },
    }).trim();
    const tarballName = packOutput.split(/\r?\n/).filter(Boolean).at(-1);
    if (!tarballName) {
        throw new Error(`npm pack did not return a tarball name for ${directoryPath}`);
    }
    return path.join(tarballDirectory, tarballName);
}

/**
 * @param {string} packageDirectory
 */
async function readComparablePackageSnapshot(packageDirectory) {
    /** @type {Map<string, string>} */
    const snapshot = new Map();
    for (const relativePath of await listFilesRecursively(packageDirectory)) {
        const fullPath = path.join(packageDirectory, relativePath);
        if (relativePath === "package.json") {
            const packageJson = JSON.parse(await readFile(fullPath, "utf8"));
            delete packageJson.version;
            snapshot.set(relativePath, `${JSON.stringify(packageJson, undefined, 2)}\n`);
            continue;
        }
        snapshot.set(relativePath, normalizeLineEndings(await readFile(fullPath, "utf8")));
    }
    return snapshot;
}

/**
 * @param {string} directoryPath
 */
async function listFilesRecursively(directoryPath) {
    /** @type {string[]} */
    const relativePaths = [];

    /**
     * @param {string} currentDirectory
     * @param {string} currentRelativeDirectory
     */
    async function visit(currentDirectory, currentRelativeDirectory) {
        const entries = await readdir(currentDirectory, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(currentDirectory, entry.name);
            const relativePath = currentRelativeDirectory ? path.join(currentRelativeDirectory, entry.name) : entry.name;
            if (entry.isDirectory()) {
                await visit(fullPath, relativePath);
            }
            else {
                relativePaths.push(relativePath.split(path.sep).join(path.posix.sep));
            }
        }
    }

    await visit(directoryPath, "");
    return relativePaths.sort(compareStrings);
}

async function readCurrentSnapshot() {
    return {
        manifest: JSON.parse(await readFile(path.join(repoRoot, "manifests", "baseline-js.json"), "utf8")),
        classification: JSON.parse(await readFile(path.join(repoRoot, "derived", "current", "classification.json"), "utf8")),
        generation: JSON.parse(await readFile(path.join(repoRoot, "derived", "current", "generation.json"), "utf8")),
        compatManagement: JSON.parse(await readFile(path.join(repoRoot, "derived", "current", "compat-management-report.json"), "utf8")),
    };
}

/**
 * @param {PackageRegistryEntry} packageConfig
 * @param {CurrentSnapshot} snapshot
 */
function renderNotice(packageConfig, snapshot) {
    return [
        `This package is a generated artifact from ${packageConfig.homepage}.`,
        "",
        "Contents:",
        "- `LICENSE` contains the Apache License 2.0 text for this package.",
        "- Generated declaration files under `baseline.d.ts`, `allow/`, and `year/` are derived from the npm `typescript` package and retain the upstream Microsoft license notice.",
        "- `reports/` contains generator audit artifacts for the exact packaged snapshot.",
        "",
        "Snapshot:",
        `- Baseline date: ${snapshot.manifest.snapshot.baselineDate}`,
        `- TypeScript package: ${snapshot.manifest.snapshot.typescriptVersion}`,
        `- web-features package: ${snapshot.manifest.snapshot.webFeaturesPackageVersion}`,
        `- web-features gitHead: ${snapshot.manifest.snapshot.webFeaturesGitHead}`,
        "",
        "This package is not an official TypeScript distribution.",
        "",
    ].join("\n");
}

/**
 * @param {{
 *   stageSummary: PackageStageSummary;
 *   publishedVersion?: string;
 *   changed: boolean;
 *   changedFiles: string[];
 *   removedFiles: string[];
 * }} options
 */
function renderReleaseNotes(options) {
    const {
        stageSummary,
        publishedVersion,
        changed,
        changedFiles,
        removedFiles,
    } = options;
    const { packageConfig, packageVersion, snapshot } = stageSummary;

    const fileLines = changedFiles.length
        ? changedFiles.map(relativePath => `- changed: \`${relativePath}\``)
        : ["- no file content changes relative to the latest published package"];

    for (const relativePath of removedFiles) {
        fileLines.push(`- removed: \`${relativePath}\``);
    }

    return [
        `Release candidate for \`${packageConfig.name}@${packageVersion}\`.`,
        "",
        `- Previous published version: ${publishedVersion ?? "none (first publish)"}`,
        `- Publish required: ${changed ? "yes" : "no"}`,
        `- Baseline date: ${snapshot.manifest.snapshot.baselineDate}`,
        `- TypeScript package: ${snapshot.manifest.snapshot.typescriptVersion}`,
        `- web-features package: ${snapshot.manifest.snapshot.webFeaturesPackageVersion}`,
        `- web-features gitHead: ${snapshot.manifest.snapshot.webFeaturesGitHead}`,
        `- Included compat rows: ${countIncludedCompatRows(snapshot.classification.classifiedCompatRows)}`,
        `- Selected declaration units: ${snapshot.generation.summary.selectedUnitCount}`,
        `- Transformed units: ${snapshot.generation.summary.transformedUnitCount}`,
        "",
        "Changed package files:",
        ...fileLines,
        "",
    ].join("\n");
}

/**
 * @param {Map<string, string>} snapshot
 */
function hashComparableSnapshot(snapshot) {
    const hash = createHash("sha256");
    for (const relativePath of [...snapshot.keys()].sort(compareStrings)) {
        hash.update(relativePath);
        hash.update("\0");
        hash.update(snapshot.get(relativePath) ?? "");
        hash.update("\0");
    }
    return `sha256-${hash.digest("hex")}`;
}

/**
 * @param {string} template
 * @param {Record<string, string>} replacements
 */
function renderTemplate(template, replacements) {
    let rendered = template;
    for (const [name, value] of Object.entries(replacements)) {
        rendered = rendered.replaceAll(`{{${name}}}`, value);
    }
    return rendered;
}

/**
 * @param {string} value
 */
function normalizeLineEndings(value) {
    return value.replace(/\r\n/g, "\n");
}

/**
 * @param {string | undefined} packageId
 */
function selectPackages(packageId) {
    if (!packageId) {
        return packages;
    }
    const selectedPackage = packages.find(packageConfig => packageConfig.id === packageId);
    if (!selectedPackage) {
        throw new Error(`Unknown package id: ${packageId}`);
    }
    return [selectedPackage];
}

/**
 * @param {PackageRegistryEntry} packageConfig
 * @param {string | undefined} stageDirectoryRoot
 */
function getStageDirectory(packageConfig, stageDirectoryRoot) {
    if (!stageDirectoryRoot) {
        return packageConfig.stageDirectory;
    }
    return path.join(stageDirectoryRoot, packageConfig.id);
}

/**
 * @param {string} left
 * @param {string} right
 */
function compareStrings(left, right) {
    return left.localeCompare(right);
}

/**
 * @typedef {"major" | "minor" | "patch"} ReleaseBump
 */

/**
 * @typedef {{
 *   id: string;
 *   name: string;
 *   description: string;
 *   typescriptPeerDependencyRange: string;
 *   initialVersion: string;
 *   license: string;
 *   keywords: string[];
 *   homepage: string;
 *   repositoryUrl: string;
 *   bugsUrl: string;
 *   readmeTemplatePath: string;
 *   stageDirectory: string;
 *   generatedFiles: Array<{ from: string; to: string; }>;
 * }} PackageRegistryEntry
 */

/**
 * @typedef {{
 *   manifest: any;
 *   classification: any;
 *   generation: any;
 *   compatManagement: any;
 * }} CurrentSnapshot
 */

/**
 * @typedef {{
 *   packageConfig: PackageRegistryEntry;
 *   stageDirectory: string;
 *   packageVersion: string;
 *   snapshot: CurrentSnapshot;
 * }} PackageStageSummary
 */

/**
 * @typedef {{
 *   packageConfig: PackageRegistryEntry;
 *   stageDirectory: string;
 *   packageVersion: string;
 *   snapshot: CurrentSnapshot;
 *   publishedVersion?: string;
 *   publishedSnapshotHash: string;
 *   stagedSnapshotHash: string;
 *   changed: boolean;
 *   changedFiles: string[];
 *   unchangedFiles: string[];
 *   removedFiles: string[];
 *   notesMarkdown: string;
 * }} ReleasePlan
 */

/**
 * @typedef {{
 *   "dist-tags"?: {
 *     latest?: string;
 *   };
 * }} NpmPackageMetadata
 */
