// @ts-check

// Lightweight retry for network operations. The weekly / release workflows run
// once, so retry **only idempotent read operations** a few times to keep a
// transient registry or GitHub blip from failing the whole job.
//
// Important: don't use this for non-idempotent writes like publish / release
// creation. Retrying a partially-succeeded write causes side effects like double
// publishing. Failure is always safe (eventually throws).

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 2000;

/**
 * @param {string} label
 * @param {number} attempt
 * @param {unknown} error
 */
function warnRetry(label, attempt, error) {
    console.warn(`Retrying (${attempt}/${DEFAULT_ATTEMPTS - 1}) after failure to ${label}: ${String(error)}`);
}

/**
 * Retry a synchronous idempotent network operation.
 *
 * @template T
 * @param {string} label
 * @param {() => T} operation
 * @param {{ attempts?: number; baseDelayMs?: number; }} [options]
 * @returns {T}
 */
export function retrySync(label, operation, options = {}) {
    const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
    const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    /** @type {unknown} */
    let lastError;

    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            return operation();
        }
        catch (error) {
            lastError = error;
            if (attempt < attempts) {
                warnRetry(label, attempt, error);
                sleepSync(attempt * baseDelayMs);
            }
        }
    }

    throw new Error(`Failed to ${label} after ${attempts} attempts: ${String(lastError)}`);
}

/**
 * Retry an asynchronous idempotent network operation.
 *
 * @template T
 * @param {string} label
 * @param {() => Promise<T>} operation
 * @param {{ attempts?: number; baseDelayMs?: number; }} [options]
 * @returns {Promise<T>}
 */
export async function retryAsync(label, operation, options = {}) {
    const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
    const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    /** @type {unknown} */
    let lastError;

    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            return await operation();
        }
        catch (error) {
            lastError = error;
            if (attempt < attempts) {
                warnRetry(label, attempt, error);
                await sleepAsync(attempt * baseDelayMs);
            }
        }
    }

    throw new Error(`Failed to ${label} after ${attempts} attempts: ${String(lastError)}`);
}

/**
 * @param {number} delayMs
 */
function sleepSync(delayMs) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
}

/**
 * @param {number} delayMs
 */
function sleepAsync(delayMs) {
    return new Promise(resolve => setTimeout(resolve, delayMs));
}
