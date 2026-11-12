import { test } from "node:test";
import assert from "node:assert/strict";
import { ModelTimeoutError, withTimeout } from "../src/adapters/timeout.ts";

test("resolves when the promise is fast enough", async () => {
  assert.equal(await withTimeout(Promise.resolve(7), 50, "x"), 7);
});

test("rejects with ModelTimeoutError when the promise stalls", async () => {
  const never = new Promise<void>(() => {});
  await assert.rejects(withTimeout(never, 20, "the first token"), (e: unknown) => {
    assert.ok(e instanceof ModelTimeoutError);
    assert.match(e.message, /first token/);
    return true;
  });
});
