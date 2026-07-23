// @ts-check

import path from "node:path";

/**
 * @param {string} repoRoot
 * @param {string} environmentVariable
 * @param {string} defaultExecutable
 */
export function resolveReleaseExecutable(repoRoot, environmentVariable, defaultExecutable) {
    const configuredExecutable = process.env[environmentVariable];
    if (
        configuredExecutable
        && (!path.isAbsolute(configuredExecutable) || isWithinDirectory(configuredExecutable, repoRoot))
    ) {
        throw new Error(`${environmentVariable} must be an absolute path outside the repository`);
    }

    const safePathEntries = configuredExecutable
        ? [
            path.dirname(configuredExecutable),
            path.dirname(process.execPath),
            ...(process.platform === "win32" ? [] : ["/usr/bin", "/bin"]),
        ]
        : (process.env.PATH ?? "")
            .split(path.delimiter)
            .filter(entry =>
                path.isAbsolute(entry)
                && !isWithinDirectory(entry, repoRoot)
                && !/[\\/]node_modules[\\/]\.bin(?:$|[\\/])/u.test(entry)
            );
    const safePath = [...new Set(safePathEntries)].join(path.delimiter);
    return {
        executable: configuredExecutable ?? defaultExecutable,
        environment: {
            ...process.env,
            PATH: safePath,
        },
    };
}

/**
 * @param {string} candidatePath
 * @param {string} directoryPath
 */
function isWithinDirectory(candidatePath, directoryPath) {
    const relativePath = path.relative(directoryPath, candidatePath);
    return relativePath === ""
        || (!relativePath.startsWith(`..${path.sep}`) && relativePath !== ".." && !path.isAbsolute(relativePath));
}
