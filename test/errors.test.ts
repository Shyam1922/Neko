import { test } from "node:test";
import assert from "node:assert/strict";
import { describeRateLimit, friendlyMessage, isOverloaded, parseRateLimit, retryDelayMs } from "../src/adapters/errors.ts";

const googleBody = JSON.stringify({
  error: {
    code: 429,
    status: "RESOURCE_EXHAUSTED",
    details: [
      {
        "@type": "type.googleapis.com/google.rpc.QuotaFailure",
        violations: [
          {
            quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier",
            quotaDimensions: { model: "gemini-x-flash" },
          },
        ],
      },
      { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "34s" },
    ],
  },
});

test("extracts limit, model and retry delay from a Google 429", () => {
  const err = Object.assign(new Error(googleBody), { status: 429 });
  const info = parseRateLimit(err);
  assert.equal(info?.limit, "GenerateRequestsPerDayPerProjectPerModel-FreeTier");
  assert.equal(info?.model, "gemini-x-flash");
  assert.equal(info?.retryDelaySec, 34);
  assert.match(describeRateLimit(info!), /gemini-x-flash/);
  assert.match(describeRateLimit(info!), /daily quota/);
});

test("recognizes a 429 with an unparseable message", () => {
  const info = parseRateLimit(new Error("429 RESOURCE_EXHAUSTED. Please retry in 12.5s"));
  assert.equal(info?.retryDelaySec, 12.5);
});

test("friendlyMessage turns Google's JSON errors into plain words", () => {
  const badKey = JSON.stringify({ error: { code: 400, message: "API key not valid.", details: [{ reason: "API_KEY_INVALID" }] } });
  assert.match(friendlyMessage(new Error(badKey)), /rejected the API key.*restart/);
  assert.equal(friendlyMessage(new Error(JSON.stringify({ error: { message: "Model not found" } }))), "Model not found");
  assert.equal(friendlyMessage(new Error("plain failure")), "plain failure");
});

test("overload (503) is retried with a growing delay; other errors are not", () => {
  const overloaded = new Error(JSON.stringify({ error: { code: 503, status: "UNAVAILABLE", message: "This model is currently experiencing high demand." } }));
  assert.equal(isOverloaded(overloaded), true);
  assert.equal(retryDelayMs(overloaded, 0), 2000);
  assert.equal(retryDelayMs(overloaded, 1), 4000);
  assert.equal(retryDelayMs(new Error("API key not valid"), 0), null);
  assert.equal(retryDelayMs(new Error("429 RESOURCE_EXHAUSTED. Please retry in 10s"), 0), 10250);
});

test("non-rate-limit errors return null", () => {
  assert.equal(parseRateLimit(new Error("network down")), null);
  assert.equal(parseRateLimit(undefined), null);
});
