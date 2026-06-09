// @ts-check

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { retrySync } from "./net-retry.mjs";

export const defaultStradaRepository = "https://github.com/microsoft/TypeScript.git";
export const defaultTypeScriptGoRepository = "https://github.com/microsoft/typescript-go.git";
export const typescriptGoSubmodulePath = "_submodules/TypeScript";

// TypeScript 6 (Strada / microsoft/TypeScript) is feature-frozen on the 6.0 line.
// - typescriptSource: frozen pin of the final Strada series. Used by the existing
//   heavyweight integration gate (hereby build + libBaseline fixture) and to verify upstream PR shape.
// - typescriptGoSource: pin of TypeScript 7 (microsoft/typescript-go).
//   Tags are named `typescript/vX.Y.Z`. The canonical source for lib.d.ts is
//   that repo's _submodules/TypeScript (= a microsoft/TypeScript commit), so we
//   pin that submodule commit alongside it.

/**
 * @param {string} stradaVersion
 */
export function resolveStradaSourceTag(stradaVersion) {
    return `v${stradaVersion}`;
}

/**
 * @param {string} typescriptVersion
 */
export function resolveTypeScriptGoSourceTag(typescriptVersion) {
    return `typescript/v${typescriptVersion}`;
}

/**
 * @param {{ manifest: any; stradaVersion: string; repository?: string; }} options
 */
export function applyStradaSourcePin(options) {
    const repository = options.repository ?? defaultStradaRepository;
    const tag = resolveStradaSourceTag(options.stradaVersion);
    const commit = resolveGitTagCommit(repository, tag);

    options.manifest.typescriptSource = {
        repository,
        tag,
        commit,
    };

    return options.manifest.typescriptSource;
}

/**
 * Pin the typescript-go release tag and the Strada submodule commit at that tag.
 * ls-remote can't return the submodule commit, so read it with `git ls-tree`
 * from a temporary shallow clone.
 *
 * @param {{
 *   manifest: any;
 *   typescriptVersion: string;
 *   repository?: string;
 *   workDirectory: string;
 * }} options
 */
export function applyTypeScriptGoSourcePin(options) {
    const repository = options.repository ?? defaultTypeScriptGoRepository;
    const tag = resolveTypeScriptGoSourceTag(options.typescriptVersion);
    const commit = resolveGitTagCommit(repository, tag);

    const cloneDirectory = path.join(options.workDirectory, "typescript-go-pin");
    fs.rmSync(cloneDirectory, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(cloneDirectory), { recursive: true });
    retrySync(`clone ${repository}@${tag}`, () => {
        fs.rmSync(cloneDirectory, { recursive: true, force: true });
        execFileSync("git", ["clone", "--depth", "1", "--branch", tag, repository, cloneDirectory], {
            stdio: "inherit",
        });
    });

    const checkedOutCommit = readGitHeadCommit(cloneDirectory);
    if (checkedOutCommit !== commit) {
        throw new Error(`Pinned typescript-go checkout mismatch. Expected ${commit} from ${tag}, got ${checkedOutCommit ?? "<unknown>"}.`);
    }
    const stradaSubmoduleCommit = readSubmoduleCommit(cloneDirectory, typescriptGoSubmodulePath);
    fs.rmSync(cloneDirectory, { recursive: true, force: true });

    options.manifest.typescriptGoSource = {
        repository,
        tag,
        commit,
        stradaSubmoduleCommit,
    };

    return options.manifest.typescriptGoSource;
}

/**
 * @param {any} manifest
 */
export function readStradaSourcePin(manifest) {
    const repository = manifest.typescriptSource?.repository;
    const tag = manifest.typescriptSource?.tag;
    const commit = manifest.typescriptSource?.commit;

    if (!repository || typeof repository !== "string") {
        throw new Error("Manifest is missing typescriptSource.repository");
    }
    if (!tag || typeof tag !== "string") {
        throw new Error("Manifest is missing typescriptSource.tag");
    }
    if (!commit || typeof commit !== "string" || !/^[0-9a-f]{40}$/u.test(commit)) {
        throw new Error("Manifest is missing a valid typescriptSource.commit");
    }

    const expectedTag = manifest.snapshot?.typescriptStradaVersion
        ? resolveStradaSourceTag(manifest.snapshot.typescriptStradaVersion)
        : undefined;
    if (expectedTag && tag !== expectedTag) {
        throw new Error(
            `Manifest typescriptSource.tag ${tag} does not match snapshot.typescriptStradaVersion ${manifest.snapshot.typescriptStradaVersion}`,
        );
    }

    return {
        repository,
        tag,
        commit,
    };
}

/**
 * @param {any} manifest
 */
export function readTypeScriptGoSourcePin(manifest) {
    const repository = manifest.typescriptGoSource?.repository;
    const tag = manifest.typescriptGoSource?.tag;
    const commit = manifest.typescriptGoSource?.commit;
    const stradaSubmoduleCommit = manifest.typescriptGoSource?.stradaSubmoduleCommit;

    if (!repository || typeof repository !== "string") {
        throw new Error("Manifest is missing typescriptGoSource.repository");
    }
    if (!tag || typeof tag !== "string") {
        throw new Error("Manifest is missing typescriptGoSource.tag");
    }
    if (!commit || typeof commit !== "string" || !/^[0-9a-f]{40}$/u.test(commit)) {
        throw new Error("Manifest is missing a valid typescriptGoSource.commit");
    }
    if (!stradaSubmoduleCommit || typeof stradaSubmoduleCommit !== "string" || !/^[0-9a-f]{40}$/u.test(stradaSubmoduleCommit)) {
        throw new Error("Manifest is missing a valid typescriptGoSource.stradaSubmoduleCommit");
    }

    const expectedTag = manifest.snapshot?.typescriptVersion
        ? resolveTypeScriptGoSourceTag(manifest.snapshot.typescriptVersion)
        : undefined;
    if (expectedTag && tag !== expectedTag) {
        throw new Error(
            `Manifest typescriptGoSource.tag ${tag} does not match snapshot.typescriptVersion ${manifest.snapshot.typescriptVersion}`,
        );
    }

    return {
        repository,
        tag,
        commit,
        stradaSubmoduleCommit,
    };
}

/**
 * @param {{ manifest: any; outDirectory: string; force?: boolean; }} options
 */
export function checkoutStradaSource(options) {
    const pin = readStradaSourcePin(options.manifest);
    return checkoutPinnedRepository({
        pin,
        outDirectory: options.outDirectory,
        force: options.force,
    });
}

/**
 * Check out typescript-go at the pinned tag and verify the submodule pointer
 * matches the manifest's stradaSubmoduleCommit.
 * Doesn't initialize the submodule contents (not needed for the patch gate).
 *
 * @param {{ manifest: any; outDirectory: string; force?: boolean; }} options
 */
export function checkoutTypeScriptGoSource(options) {
    const pin = readTypeScriptGoSourcePin(options.manifest);
    const result = checkoutPinnedRepository({
        pin,
        outDirectory: options.outDirectory,
        force: options.force,
    });

    const submoduleCommit = readSubmoduleCommit(result.outDirectory, typescriptGoSubmodulePath);
    if (submoduleCommit !== pin.stradaSubmoduleCommit) {
        throw new Error(
            `typescript-go submodule pointer ${submoduleCommit} does not match pinned stradaSubmoduleCommit ${pin.stradaSubmoduleCommit}`,
        );
    }

    return {
        ...result,
        stradaSubmoduleCommit: submoduleCommit,
    };
}

/**
 * @param {{
 *   pin: { repository: string; tag: string; commit: string; };
 *   outDirectory: string;
 *   force?: boolean;
 * }} options
 */
function checkoutPinnedRepository(options) {
    const pin = options.pin;
    const outDirectory = path.resolve(options.outDirectory);
    const existingCommit = readGitHeadCommit(outDirectory);

    if (existingCommit === pin.commit) {
        return {
            ...pin,
            outDirectory,
            reusedExistingCheckout: true,
        };
    }

    if (fs.existsSync(outDirectory)) {
        if (!options.force) {
            throw new Error(
                `Refusing to replace existing directory ${outDirectory}. Re-run with --force or choose an empty path.`,
            );
        }
        fs.rmSync(outDirectory, { recursive: true, force: true });
    }

    retrySync(`clone ${pin.repository}@${pin.tag}`, () => {
        fs.rmSync(outDirectory, { recursive: true, force: true });
        execFileSync("git", ["clone", "--depth", "1", "--branch", pin.tag, pin.repository, outDirectory], {
            stdio: "inherit",
        });
    });

    const checkedOutCommit = readGitHeadCommit(outDirectory);
    if (checkedOutCommit !== pin.commit) {
        throw new Error(
            `Pinned checkout mismatch. Expected ${pin.commit} from ${pin.tag}, got ${checkedOutCommit ?? "<unknown>"}.`,
        );
    }

    return {
        ...pin,
        outDirectory,
        reusedExistingCheckout: false,
    };
}

/**
 * @param {string} repository
 * @param {string} tag
 */
function resolveGitTagCommit(repository, tag) {
    const output = retrySync(`resolve ${tag} from ${repository}`, () => execFileSync("git", ["ls-remote", "--tags", repository, `${tag}*`], {
        encoding: "utf8",
    })).trim();

    if (!output) {
        throw new Error(`Could not resolve ${tag} from ${repository}`);
    }

    const lines = output
        .split(/\r?\n/u)
        .map(line => line.trim())
        .filter(Boolean);
    const preferredRef = `refs/tags/${tag}^{}`;
    const directRef = `refs/tags/${tag}`;
    const preferredLine = lines.find(line => line.endsWith(preferredRef));
    const directLine = lines.find(line => line.endsWith(directRef));
    const selectedLine = preferredLine ?? directLine;

    if (!selectedLine) {
        throw new Error(`Could not resolve exact tag ${tag} from ${repository}`);
    }

    const [commit] = selectedLine.split(/\s+/u);
    if (!commit || !/^[0-9a-f]{40}$/u.test(commit)) {
        throw new Error(`Resolved invalid commit for ${tag}: ${selectedLine}`);
    }

    return commit;
}

/**
 * @param {string} repositoryDirectory
 * @param {string} submodulePath
 */
function readSubmoduleCommit(repositoryDirectory, submodulePath) {
    const output = execFileSync("git", ["ls-tree", "HEAD", submodulePath], {
        cwd: repositoryDirectory,
        encoding: "utf8",
    }).trim();

    const match = output.match(/^160000\s+commit\s+([0-9a-f]{40})\s/u);
    if (!match) {
        throw new Error(`Could not read submodule commit for ${submodulePath} in ${repositoryDirectory}: ${output || "<empty>"}`);
    }
    return match[1];
}

/**
 * @param {string} directory
 */
function readGitHeadCommit(directory) {
    if (!fs.existsSync(directory)) {
        return undefined;
    }
    try {
        return execFileSync("git", ["rev-parse", "HEAD"], {
            cwd: directory,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
    }
    catch {
        return undefined;
    }
}

