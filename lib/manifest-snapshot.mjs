// @ts-check

import {
    mkdir,
    readFile,
    writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
    npmViewField,
    readInstalledPackageJson,
} from "./installed-package.mjs";

/**
 * @param {{
 *   repoRoot: string;
 *   manifestPath: string;
 *   snapshotName?: string;
 *   baselineDate?: string;
 *   updateOutputPaths?: boolean;
 * }} options
 */
export async function refreshManifestSnapshot(options) {
    const {
        repoRoot,
        manifestPath,
        snapshotName,
        baselineDate,
        updateOutputPaths = false,
    } = options;

    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const manifestDirectory = path.dirname(manifestPath);
    const datasetPath = manifest.dataset
        ? path.resolve(manifestDirectory, manifest.dataset)
        : path.join(repoRoot, "datasets", "web-features-js-compat.json");
    const derivedDirectory = path.join(repoRoot, "derived", "current");
    const dataset = JSON.parse(await readFile(datasetPath, "utf8"));
    const repoPackageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
    const typescriptPackageName = manifest.toolchain?.typescriptPackage ?? "typescript";
    const typescriptStradaPackageName = manifest.toolchain?.typescriptStradaPackage ?? "typescript-strada";
    const webFeaturesPackageName = manifest.toolchain?.webFeaturesPackage ?? "web-features";
    const typescriptPackageJson = await readInstalledPackageJson(repoRoot, typescriptPackageName);
    const typescriptStradaPackageJson = await readInstalledPackageJson(repoRoot, typescriptStradaPackageName);
    const webFeaturesPackageJson = await readInstalledPackageJson(repoRoot, webFeaturesPackageName);
    const webFeaturesGitHead = npmViewField(repoRoot, `${webFeaturesPackageName}@${webFeaturesPackageJson.version}`, "gitHead");

    manifest.snapshot = {
        ...manifest.snapshot,
        name: snapshotName ?? manifest.snapshot?.name ?? dataset.snapshot.name ?? "baseline-js",
        baselineDate: baselineDate ?? manifest.snapshot?.baselineDate ?? dataset.snapshot.baselineDate,
        generatorVersion: repoPackageJson.version,
        typescriptVersion: typescriptPackageJson.version,
        typescriptStradaVersion: typescriptStradaPackageJson.version,
        webFeaturesPackageVersion: dataset.snapshot.webFeaturesPackageVersion,
        webFeaturesGitHead,
    };
    // In TypeScript 7, native-preview merged into the typescript package (next tag).
    // Explicitly drop the legacy fields carried over from old manifests.
    delete manifest.snapshot.tsgoVersion;
    delete manifest.toolchain?.tsgoPackage;
    manifest.dataset = toPosixRelativePath(manifestDirectory, datasetPath);

    if (updateOutputPaths) {
        manifest.classificationOutput = toPosixRelativePath(manifestDirectory, path.join(derivedDirectory, "classification.json"));
        manifest.compatManagementOutput = toPosixRelativePath(manifestDirectory, path.join(derivedDirectory, "compat-management-report.json"));
        manifest.inventoryOutput = toPosixRelativePath(manifestDirectory, path.join(derivedDirectory, "inventory.json"));
        manifest.generationOutput = toPosixRelativePath(manifestDirectory, path.join(derivedDirectory, "generation.json"));
    }

    return {
        manifest,
        dataset,
        datasetPath,
    };
}

/**
 * @param {{
 *   manifestPath: string;
 *   manifest: any;
 * }} options
 */
export async function writeManifest(options) {
    await mkdir(path.dirname(options.manifestPath), { recursive: true });
    await writeFile(options.manifestPath, `${JSON.stringify(options.manifest, undefined, 4)}\n`);
}

/**
 * @param {string} fromDirectory
 * @param {string} toPath
 */
function toPosixRelativePath(fromDirectory, toPath) {
    return path.relative(fromDirectory, toPath).split(path.sep).join(path.posix.sep);
}
