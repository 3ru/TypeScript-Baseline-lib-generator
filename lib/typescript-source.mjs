// @ts-check

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { retrySync } from "./net-retry.mjs";

export const defaultTypeScriptRepository = "https://github.com/microsoft/TypeScript.git";

export const defaultTypeScriptRef = "main";

/**
 * @param {{ manifest: any; repository?: string; ref?: string; }} options
 */
export function applyTypeScriptSourcePin(options) {
    const repository = options.repository ?? defaultTypeScriptRepository;
    const ref = options.ref ?? defaultTypeScriptRef;
    const commit = resolveGitRefCommit(repository, ref);

    options.manifest.typescriptSource = {
        repository,
        ref,
        commit,
    };

    return options.manifest.typescriptSource;
}

/**
 * @param {any} manifest
 */
export function readTypeScriptSourcePin(manifest) {
    const repository = manifest.typescriptSource?.repository;
    const ref = manifest.typescriptSource?.ref;
    const commit = manifest.typescriptSource?.commit;

    if (!repository || typeof repository !== "string") {
        throw new Error("Manifest is missing typescriptSource.repository");
    }

    if (!ref || typeof ref !== "string") {
        throw new Error("Manifest is missing typescriptSource.ref");
    }

    if (!commit || typeof commit !== "string" || !/^[0-9a-f]{40}$/u.test(commit)) {
        throw new Error("Manifest is missing a valid typescriptSource.commit");
    }

    return {
        repository,
        ref,
        commit,
    };
}

/**
 * @param {{ manifest: any; outDirectory: string; force?: boolean; }} options
 */
export function checkoutTypeScriptSource(options) {
    const pin = readTypeScriptSourcePin(options.manifest);
    const outDirectory = path.resolve(options.outDirectory);
    const existingCommit = readGitHeadCommit(outDirectory);

    if (existingCommit === pin.commit && isGitWorkingTreeClean(outDirectory)) {
        return {
            ...pin,
            outDirectory,
            reusedExistingCheckout: true,
        };
    }

    if (fs.existsSync(outDirectory) && !options.force) {
        const reason = existingCommit === pin.commit
            ? "The checkout has local changes."
            : `The checkout is at ${existingCommit ?? "an unknown revision"}, not ${pin.commit}.`;

        throw new Error(
            `${reason} Refusing to replace ${outDirectory}. Re-run with --force or choose an empty path.`,
        );
    }

    retrySync(`checkout ${pin.repository}@${pin.commit}`, () => {
        fs.rmSync(outDirectory, { recursive: true, force: true });
        fs.mkdirSync(outDirectory, { recursive: true });
        execFileSync("git", ["init", "--quiet"], { cwd: outDirectory });
        execFileSync("git", ["remote", "add", "origin", pin.repository], { cwd: outDirectory });
        execFileSync("git", ["fetch", "--depth", "1", "origin", pin.commit], {
            cwd: outDirectory,
            stdio: "inherit",
        });
        execFileSync("git", ["checkout", "--quiet", "--detach", "FETCH_HEAD"], { cwd: outDirectory });
    });

    const checkedOutCommit = readGitHeadCommit(outDirectory);

    if (checkedOutCommit !== pin.commit) {
        throw new Error(
            `Pinned checkout mismatch. Expected ${pin.commit}, got ${checkedOutCommit ?? "<unknown>"}.`,
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
 * @param {string} ref
 */
function resolveGitRefCommit(repository, ref) {
    const remoteRef = ref.startsWith("refs/") ? ref : `refs/heads/${ref}`;

    const output = retrySync(`resolve ${ref} from ${repository}`, () => execFileSync(
        "git",
        ["ls-remote", repository, remoteRef],
        { encoding: "utf8" },
    )).trim();

    const lines = output.split(/\r?\n/u).filter(Boolean);

    if (lines.length !== 1) {
        throw new Error(`Expected one exact match for ${remoteRef} from ${repository}, got ${lines.length}`);
    }

    const [commit, resolvedRef] = lines[0].split(/\s+/u);

    if (!commit || !/^[0-9a-f]{40}$/u.test(commit) || resolvedRef !== remoteRef) {
        throw new Error(`Resolved invalid commit for ${remoteRef}: ${lines[0]}`);
    }

    return commit;
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

/**
 * @param {string} directory
 */
function isGitWorkingTreeClean(directory) {
    const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
        cwd: directory,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
    });

    return status.length === 0;
}
