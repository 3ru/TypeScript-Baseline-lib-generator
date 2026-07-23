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
import ts from "typescript-strada";
import { retryAsync, retrySync } from "../lib/net-retry.mjs";
import { compareYearContracts } from "../lib/year-contracts.mjs";
import { packages, repoRoot } from "./package-registry.mjs";
import { resolveReleaseExecutable } from "./trusted-executable.mjs";

/**
 * @param {{
 *   packageId?: string;
 *   versionOverride?: string;
 *   stageDirectoryRoot?: string;
 * }} [options]
 */
export async function createPackageStages(options = {}) {
    const selectedPackages = selectPackages(options.packageId);
    const snapshot = await readCurrentSnapshot();

    /** @type {PackageStageSummary[]} */
    const summaries = [];
    for (const packageConfig of selectedPackages) {
        summaries.push(await createPackageStage(
            packageConfig,
            snapshot,
            options.versionOverride,
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
 *   stageDirectoryRoot?: string;
 *   preview?: boolean;
 * }} [options]
 */
export async function collectReleasePlans(options = {}) {
    const stageSummaries = await createPackageStages(options);

    /** @type {ReleasePlan[]} */
    const releasePlans = [];
    for (const stageSummary of stageSummaries) {
        releasePlans.push(await buildReleasePlan(
            stageSummary,
            options.versionOverride !== undefined,
            options.preview === true,
        ));
    }

    return releasePlans;
}

/**
 * @param {PackageRegistryEntry} packageConfig
 * @param {CurrentSnapshot} snapshot
 * @param {string | undefined} versionOverride
 * @param {string} stageDirectory
 */
async function createPackageStage(packageConfig, snapshot, versionOverride, stageDirectory) {
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

    const packageVersion = versionOverride ?? await resolveNextPackageVersion(packageConfig);
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
 * @param {boolean} reviewedVersion
 * @param {boolean} preview
 */
async function buildReleasePlan(stageSummary, reviewedVersion, preview) {
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
    if (reviewedVersion) {
        assertExplicitVersionIncrease(published.version, stageSummary.packageVersion);
    }
    assertNoRemovedAllowEntries(removedFiles);
    assertAllowEntryContractsPreserved(
        published.snapshot.get("reports/generation.json"),
        stagedSnapshot.get("reports/generation.json"),
    );
    assertNoRemovedYearEntryPoints(removedFiles);
    const yearVersionBump = assertYearContractsPreserved(
        published.snapshot.get("reports/generation.json"),
        stagedSnapshot.get("reports/generation.json"),
        { preview: true },
    );
    const declarationVersionBump = getDeclarationContractImpact(published.snapshot, stagedSnapshot);
    const requiredVersionBump = maximumVersionBump(yearVersionBump, declarationVersionBump);
    assertReleaseVersionReview({
        requiredVersionBump,
        reviewedVersion,
        preview,
        publishedVersion: published.version,
        stagedVersion: stageSummary.packageVersion,
    });
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
        requiredVersionBump,
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
 * @param {Map<string, string>} publishedSnapshot
 * @param {Map<string, string>} stagedSnapshot
 * @returns {"major" | "minor" | undefined}
 */
export function getDeclarationContractImpact(publishedSnapshot, stagedSnapshot) {
    if (!publishedSnapshot.size) {
        return undefined;
    }
    /** @type {"minor" | undefined} */
    let additiveImpact;
    for (const [relativePath, publishedText] of publishedSnapshot) {
        if (!relativePath.endsWith(".d.ts")) {
            continue;
        }
        const stagedText = stagedSnapshot.get(relativePath);
        if (stagedText === undefined) {
            return "major";
        }
        if (stagedText !== publishedText) {
            if (!isSafeDeclarationAddition(publishedText, stagedText)) {
                return "major";
            }
            additiveImpact = "minor";
        }
    }
    if (publicTypeRoutingChanged(publishedSnapshot.get("package.json"), stagedSnapshot.get("package.json"))) {
        return "major";
    }
    if (additiveImpact) {
        return additiveImpact;
    }
    return [...stagedSnapshot.keys()].some(
        relativePath => relativePath.endsWith(".d.ts") && !publishedSnapshot.has(relativePath),
    )
        ? "minor"
        : undefined;
}

/**
 * @param {string} previousText
 * @param {string} nextText
 */
function isSafeDeclarationAddition(previousText, nextText) {
    if (!isLineSubsequence(previousText, nextText)) {
        return false;
    }
    const previousSourceFile = ts.createSourceFile("previous.d.ts", previousText, ts.ScriptTarget.Latest, true);
    const nextSourceFile = ts.createSourceFile("next.d.ts", nextText, ts.ScriptTarget.Latest, true);
    if (
        ts.isExternalModule(previousSourceFile) !== ts.isExternalModule(nextSourceFile)
        || previousSourceFile.hasNoDefaultLib !== nextSourceFile.hasNoDefaultLib
    ) {
        return false;
    }

    return declarationListPreserved(
        previousSourceFile.statements,
        nextSourceFile.statements,
        previousSourceFile,
        nextSourceFile,
    );
}

/**
 * @param {readonly import("typescript-strada").Node[]} previousNodes
 * @param {readonly import("typescript-strada").Node[]} nextNodes
 * @param {import("typescript-strada").SourceFile} previousSourceFile
 * @param {import("typescript-strada").SourceFile} nextSourceFile
 */
function declarationListPreserved(previousNodes, nextNodes, previousSourceFile, nextSourceFile) {
    const unmatchedNodes = [...nextNodes];
    for (const previousNode of previousNodes) {
        const key = getDeclarationNodeKey(previousNode, previousSourceFile);
        const exactIndex = unmatchedNodes.findIndex(nextNode => (
            getDeclarationNodeKey(nextNode, nextSourceFile) === key
            && previousNode.getText(previousSourceFile) === nextNode.getText(nextSourceFile)
        ));
        const compatibleIndex = exactIndex >= 0
            ? exactIndex
            : unmatchedNodes.findIndex(nextNode => (
                getDeclarationNodeKey(nextNode, nextSourceFile) === key
                && declarationNodePreserved(previousNode, nextNode, previousSourceFile, nextSourceFile)
            ));
        if (compatibleIndex < 0) {
            return false;
        }
        unmatchedNodes.splice(compatibleIndex, 1);
    }
    return true;
}

/**
 * @param {import("typescript-strada").Node} previousNode
 * @param {import("typescript-strada").Node} nextNode
 * @param {import("typescript-strada").SourceFile} previousSourceFile
 * @param {import("typescript-strada").SourceFile} nextSourceFile
 */
function declarationNodePreserved(previousNode, nextNode, previousSourceFile, nextSourceFile) {
    if (previousNode.kind !== nextNode.kind) {
        return false;
    }
    const previousContainer = getDeclarationContainer(previousNode, previousSourceFile);
    const nextContainer = getDeclarationContainer(nextNode, nextSourceFile);
    return Boolean(
        previousContainer
        && nextContainer
        && previousContainer.prefix === nextContainer.prefix
        && previousContainer.suffix === nextContainer.suffix
        && declarationListPreserved(
            previousContainer.children,
            nextContainer.children,
            previousSourceFile,
            nextSourceFile,
        ),
    );
}

/**
 * @param {import("typescript-strada").Node} node
 * @param {import("typescript-strada").SourceFile} sourceFile
 */
function getDeclarationContainer(node, sourceFile) {
    if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) {
        return createDeclarationContainer(node, node.members, node.members.pos, node.members.end, sourceFile);
    }
    if (ts.isEnumDeclaration(node)) {
        return createDeclarationContainer(node, node.members, node.members.pos, node.members.end, sourceFile);
    }
    if (ts.isModuleDeclaration(node) && node.body) {
        if (ts.isModuleBlock(node.body)) {
            return createDeclarationContainer(node, node.body.statements, node.body.statements.pos, node.body.statements.end, sourceFile);
        }
        return createDeclarationContainer(node, [node.body], node.body.getStart(sourceFile), node.body.end, sourceFile);
    }
    if (ts.isVariableStatement(node) && node.declarationList.declarations.length === 1) {
        const type = node.declarationList.declarations[0].type;
        if (type && ts.isTypeLiteralNode(type)) {
            return createDeclarationContainer(node, type.members, type.members.pos, type.members.end, sourceFile);
        }
    }
    return undefined;
}

/**
 * @param {import("typescript-strada").Node} node
 * @param {readonly import("typescript-strada").Node[]} children
 * @param {number} childrenStart
 * @param {number} childrenEnd
 * @param {import("typescript-strada").SourceFile} sourceFile
 */
function createDeclarationContainer(node, children, childrenStart, childrenEnd, sourceFile) {
    return {
        children,
        prefix: sourceFile.text.slice(node.getStart(sourceFile), childrenStart),
        suffix: sourceFile.text.slice(childrenEnd, node.end),
    };
}

/**
 * @param {import("typescript-strada").Node} node
 * @param {import("typescript-strada").SourceFile} sourceFile
 */
function getDeclarationNodeKey(node, sourceFile) {
    if (
        ts.isClassDeclaration(node)
        || ts.isEnumDeclaration(node)
        || ts.isFunctionDeclaration(node)
        || ts.isInterfaceDeclaration(node)
        || ts.isModuleDeclaration(node)
        || ts.isTypeAliasDeclaration(node)
    ) {
        return `${node.kind}:${node.name?.getText(sourceFile) ?? "<anonymous>"}`;
    }
    if (ts.isVariableStatement(node)) {
        return `${node.kind}:${node.declarationList.declarations
            .map(declaration => declaration.name.getText(sourceFile))
            .join(",")}`;
    }
    return `${node.kind}:${node.getText(sourceFile)}`;
}

/**
 * @param {string} previousText
 * @param {string} nextText
 */
function isLineSubsequence(previousText, nextText) {
    const previousLines = previousText.split("\n");
    const nextLines = nextText.split("\n");
    let previousIndex = 0;
    for (const line of nextLines) {
        if (line === previousLines[previousIndex]) {
            previousIndex++;
        }
    }
    return previousIndex === previousLines.length;
}

/**
 * @param {string | undefined} publishedPackageJsonText
 * @param {string | undefined} stagedPackageJsonText
 */
function publicTypeRoutingChanged(publishedPackageJsonText, stagedPackageJsonText) {
    if (!publishedPackageJsonText || !stagedPackageJsonText) {
        return publishedPackageJsonText !== stagedPackageJsonText;
    }
    const selectRouting = (/** @type {string} */ packageJsonText) => {
        const packageJson = JSON.parse(packageJsonText);
        return JSON.stringify({
            types: packageJson.types,
            typesVersions: packageJson.typesVersions,
            exports: packageJson.exports,
        });
    };
    return selectRouting(publishedPackageJsonText) !== selectRouting(stagedPackageJsonText);
}

/**
 * @param {"major" | "minor" | undefined} left
 * @param {"major" | "minor" | undefined} right
 * @returns {"major" | "minor" | undefined}
 */
function maximumVersionBump(left, right) {
    return left === "major" || right === "major"
        ? "major"
        : left === "minor" || right === "minor"
            ? "minor"
            : undefined;
}

/**
 * @param {{
 *   requiredVersionBump: "major" | "minor" | undefined;
 *   reviewedVersion: boolean;
 *   preview: boolean;
 *   publishedVersion: string | undefined;
 *   stagedVersion: string;
 * }} options
 */
function assertReleaseVersionReview(options) {
    if (!options.requiredVersionBump) {
        return;
    }
    if (!options.reviewedVersion) {
        if (options.preview) {
            return;
        }
        throw new Error(
            `Published declaration contracts require review (${options.requiredVersionBump}); `
                + "pass an explicit --version after inspecting the package diff",
        );
    }
    assertVersionBump(
        options.publishedVersion,
        options.stagedVersion,
        options.requiredVersionBump,
    );
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
 * @param {string | undefined} publishedReportText
 * @param {string | undefined} stagedReportText
 * @param {{ reviewedVersion?: boolean; preview?: boolean; publishedVersion?: string; stagedVersion?: string; }} [options]
 */
export function assertYearContractsPreserved(publishedReportText, stagedReportText, options = {}) {
    if (!publishedReportText) {
        return undefined;
    }
    if (!stagedReportText) {
        throw new Error("The staged package is missing reports/generation.json");
    }

    const comparison = compareYearContracts(publishedReportText, stagedReportText);
    const removedYear = comparison.changes.find(change => change.kind === "removed");
    if (removedYear) {
        throw new Error(`Published Baseline year contract is missing: year/${removedYear.year}`);
    }
    if (!comparison.requiredVersionBump) {
        return undefined;
    }
    if (!options.reviewedVersion) {
        if (options.preview) {
            return comparison.requiredVersionBump;
        }
        throw new Error(
            `Baseline year contracts require review (${comparison.changes.map(change => change.year).join(", ")}); `
                + "pass an explicit --version after inspecting the generated diff",
        );
    }
    assertVersionBump(
        options.publishedVersion,
        options.stagedVersion,
        comparison.requiredVersionBump,
    );
    return comparison.requiredVersionBump;
}

/**
 * @param {string | undefined} publishedVersion
 * @param {string | undefined} stagedVersion
 * @param {"major" | "minor"} requiredBump
 */
function assertVersionBump(publishedVersion, stagedVersion, requiredBump) {
    if (!publishedVersion || !stagedVersion) {
        throw new Error("Reviewed Baseline year changes require published and staged package versions");
    }
    const published = parseVersion(publishedVersion);
    const staged = parseVersion(stagedVersion);
    const sufficient = requiredBump === "major"
        ? published.major === 0
            ? staged.major > 0 || (staged.major === 0 && staged.minor > published.minor)
            : staged.major > published.major
        : staged.major > published.major
            || (staged.major === published.major && staged.minor > published.minor);
    if (!sufficient) {
        throw new Error(
            `Public declaration contract changes require a ${requiredBump} version increase from ${publishedVersion}; got ${stagedVersion}`,
        );
    }
}

/**
 * @param {string | undefined} publishedVersion
 * @param {string | undefined} stagedVersion
 */
export function assertExplicitVersionIncrease(publishedVersion, stagedVersion) {
    if (!stagedVersion) {
        throw new Error("Explicit package version is missing");
    }
    const staged = parseVersion(stagedVersion);
    if (staged.prerelease) {
        throw new Error(`Explicit release versions must be stable; got ${stagedVersion}`);
    }
    if (!publishedVersion) {
        return;
    }
    if (compareVersion(staged, parseVersion(publishedVersion)) <= 0) {
        throw new Error(
            `Explicit package version must be greater than ${publishedVersion}; got ${stagedVersion}`,
        );
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
 * @param {ReturnType<typeof parseVersion>} left
 * @param {ReturnType<typeof parseVersion>} right
 */
function compareVersion(left, right) {
    const coreDifference = left.major - right.major
        || left.minor - right.minor
        || left.patch - right.patch;
    if (coreDifference) {
        return coreDifference;
    }
    if (left.prerelease === right.prerelease) {
        return 0;
    }
    if (!left.prerelease) {
        return 1;
    }
    if (!right.prerelease) {
        return -1;
    }
    const leftParts = left.prerelease.split(".");
    const rightParts = right.prerelease.split(".");
    for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index++) {
        const leftPart = leftParts[index];
        const rightPart = rightParts[index];
        if (leftPart === undefined) {
            return -1;
        }
        if (rightPart === undefined) {
            return 1;
        }
        if (leftPart === rightPart) {
            continue;
        }
        const leftNumeric = /^\d+$/.test(leftPart);
        const rightNumeric = /^\d+$/.test(rightPart);
        if (leftNumeric && rightNumeric) {
            if (leftPart.length !== rightPart.length) {
                return leftPart.length - rightPart.length;
            }
            return leftPart < rightPart ? -1 : 1;
        }
        if (leftNumeric !== rightNumeric) {
            return leftNumeric ? -1 : 1;
        }
        return leftPart < rightPart ? -1 : 1;
    }
    return 0;
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
 */
async function resolveNextPackageVersion(packageConfig) {
    const currentVersion = await getLatestPublishedVersion(packageConfig.name);
    if (!currentVersion) {
        return packageConfig.initialVersion;
    }

    const match = currentVersion.match(/^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
    if (!match) {
        throw new Error(`Unsupported published version format for ${packageConfig.name}: ${currentVersion}`);
    }

    // When latest is a prerelease (e.g. 0.0.2-rc.0), use its base version
    // (0.0.2) as the next stable release. This keeps a prerelease on latest from
    // permanently wedging the release job, and preserves semver ordering.
    const hasPrerelease = currentVersion.includes("-");
    if (hasPrerelease) {
        return `${match[1]}.${match[2]}.${match[3]}`;
    }

    return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
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
 *   requiredVersionBump?: "major" | "minor";
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
