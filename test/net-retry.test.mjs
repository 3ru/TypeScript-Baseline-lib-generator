// @ts-check

import assert from "node:assert/strict";
import test from "node:test";
import { retryAsync, retrySync } from "../lib/net-retry.mjs";

// Pin the invariant that retries absorb transient failures of idempotent reads while
// still throwing on permanent failures (failing in the safe direction). Run with
// baseDelayMs: 0 so no sleep creeps in.

test("retrySync returns immediately on first success without retrying", () => {
    let calls = 0;
    const result = retrySync("op", () => {
        calls += 1;
        return "ok";
    }, { baseDelayMs: 0 });
    assert.equal(result, "ok");
    assert.equal(calls, 1);
});

test("retrySync recovers after transient failures", () => {
    let calls = 0;
    const result = retrySync("op", () => {
        calls += 1;
        if (calls < 3) {
            throw new Error("transient");
        }
        return "recovered";
    }, { attempts: 3, baseDelayMs: 0 });
    assert.equal(result, "recovered");
    assert.equal(calls, 3);
});

test("retrySync gives up after exhausting attempts and surfaces the last error", () => {
    let calls = 0;
    assert.throws(
        () => retrySync("fetch thing", () => {
            calls += 1;
            throw new Error(`boom-${calls}`);
        }, { attempts: 3, baseDelayMs: 0 }),
        /Failed to fetch thing after 3 attempts[\s\S]*boom-3/u,
    );
    assert.equal(calls, 3);
});

test("retryAsync recovers after transient rejection", async () => {
    let calls = 0;
    const result = await retryAsync("op", async () => {
        calls += 1;
        if (calls < 2) {
            throw new Error("transient");
        }
        return "recovered";
    }, { attempts: 3, baseDelayMs: 0 });
    assert.equal(result, "recovered");
    assert.equal(calls, 2);
});

test("retryAsync gives up after exhausting attempts", async () => {
    let calls = 0;
    await assert.rejects(
        () => retryAsync("fetch meta", async () => {
            calls += 1;
            throw new Error("down");
        }, { attempts: 2, baseDelayMs: 0 }),
        /Failed to fetch meta after 2 attempts/u,
    );
    assert.equal(calls, 2);
});
