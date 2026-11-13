import { test } from "node:test";
import assert from "node:assert/strict";
import { pickFallbackModel } from "../src/adapters/llm.ts";

const gen = ["generateContent"];
// Shaped like a real key's model list (including models that must never be chosen for chat).
const models = [
  { name: "models/gemini-2.5-flash", supportedActions: gen },
  { name: "models/gemini-2.5-pro", supportedActions: gen },
  { name: "models/gemma-4-26b-a4b-it", supportedActions: gen },
  { name: "models/gemini-2.5-flash-lite", supportedActions: gen },
  { name: "models/gemini-2.5-flash-image", supportedActions: gen },
  { name: "models/gemini-3.1-flash-lite", supportedActions: gen },
  { name: "models/gemini-3.5-flash", supportedActions: gen },
  { name: "models/gemini-3.5-flash-lite", supportedActions: gen },
  { name: "models/gemini-3.8-flash", supportedActions: gen },
  { name: "models/gemini-4-argon", supportedActions: gen },
  { name: "models/gemini-embedding-001", supportedActions: ["embedContent"] },
];

test("picks the newest flash-lite text model", () => {
  assert.equal(pickFallbackModel(models, "gemini-flash-latest"), "gemini-3.5-flash-lite");
});

test("never picks the model that just failed", () => {
  assert.equal(pickFallbackModel(models, "gemini-3.5-flash-lite"), "gemini-3.1-flash-lite");
  assert.equal(pickFallbackModel(models, "models/gemini-3.5-flash-lite"), "gemini-3.1-flash-lite"); // with the models/ prefix too
});

test("falls back to the newest plain flash when there is no flash-lite", () => {
  const onlyFlash = models.filter((m) => !/lite/.test(m.name));
  assert.equal(pickFallbackModel(onlyFlash, "x"), "gemini-3.8-flash");
});

test("skips image, embedding, gemma and experimental models, and returns null when nothing is usable", () => {
  const junk = [models[2], models[4], models[9], models[10]];
  assert.equal(pickFallbackModel(junk, "x"), null);
  assert.equal(pickFallbackModel([], "x"), null);
});
