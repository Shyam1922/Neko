import { test } from "node:test";
import assert from "node:assert/strict";
import { ConfigError, DEFAULT_LIMITS, loadConfig } from "../src/config.ts";

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

test("rate limits are on by default, can be changed or turned off with 0, and reject nonsense", () => {
  assert.deepEqual(loadConfig(base).limits, { ...DEFAULT_LIMITS, trustProxy: false });
  const c = loadConfig({ ...base, TURNS_PER_HOUR: "5", TURNS_PER_DAY: "0", NEW_USERS_PER_IP_PER_HOUR: "3", TRUST_PROXY: "true" }).limits;
  assert.deepEqual(c, { turnsPerHour: 5, turnsPerDay: 0, newUsersPerIpPerHour: 3, trustProxy: true });
  for (const bad of ["-1", "2.5", "lots"]) {
    assert.throws(() => loadConfig({ ...base, TURNS_PER_HOUR: bad }), /TURNS_PER_HOUR/, bad);
  }
});
