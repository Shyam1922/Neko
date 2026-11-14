import { test } from "node:test";
import assert from "node:assert/strict";
import { ConfigError, loadConfig } from "../src/config.ts";

const base = { GEMINI_API_KEY: "k" };

test("defaults: fast model, port 3000, 45 second model timeout", () => {
  const c = loadConfig(base);
  assert.equal(c.model, "gemini-3.5-flash-lite");
  assert.equal(c.port, 3000);
  assert.equal(c.modelTimeoutMs, 45_000);
});

test("the model timeout can be raised for a slower, stronger model", () => {
  assert.equal(loadConfig({ ...base, MODEL_TIMEOUT_SECONDS: "120" }).modelTimeoutMs, 120_000);
  assert.equal(loadConfig({ ...base, MODEL_TIMEOUT_SECONDS: "7.5" }).modelTimeoutMs, 7_500);
  assert.equal(loadConfig({ ...base, MODEL_TIMEOUT_SECONDS: "  " }).modelTimeoutMs, 45_000); // blank means default
});

test("a bad timeout fails at startup with a clear message, not as a mystery later", () => {
  for (const bad of ["abc", "0", "4", "601", "-5"]) {
    assert.throws(() => loadConfig({ ...base, MODEL_TIMEOUT_SECONDS: bad }), (e: unknown) => e instanceof ConfigError && /MODEL_TIMEOUT_SECONDS/.test(e.message), bad);
  }
});

test("a missing key explains how to get one", () => {
  assert.throws(() => loadConfig({}), /aistudio\.google\.com\/apikey/);
});
