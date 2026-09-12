#!/usr/bin/env node
// Offline contract tests for OMP v18.1.16 extension APIs; no model requests.
import assert from "node:assert/strict";
import { test, after } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import astromode from "../omp/extensions/astromode.js";

const ROOT = { provider: "openai-codex", id: "gpt-6-astra", thinking: { efforts: ["high", "xhigh"] } };
const FLASH = { provider: "openrouter", id: "z-ai/glm-5.3-flash", thinking: { efforts: ["low", "high", "max"] } };
const OTHER = { provider: "other", id: "other" };
const dirs = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

function host(options = {}, factory = astromode) {
  const handlers = new Map();
  const flags = new Map();
  const calls = [];
  const notices = [];
  let model = options.current ?? OTHER;
  let effort = "medium";
  let id = "root-session";
  let generation = 0;
  let inference = 0;
  const pi = {
    registerFlag(name, definition) { flags.set(name, definition.default); calls.push(["flag", name, definition]); },
    getFlag(name) { return flags.get(name); },
    on(name, fn) { handlers.set(name, fn); },
    async setModel(value) {
      calls.push(["setModel", value]);
      if (options.setModel) return options.setModel(value, (next) => { model = next; });
      model = value;
      return true;
    },
    setThinkingLevel(value, persist) { calls.push(["thinking", value, persist]); effort = options.clamp ?? value; },
    getThinkingLevel() { return effort; },
  };
  const ctx = {
    hasUI: true,
    sessionManager: { getSessionId: () => id },
    models: { list: () => options.models ?? [ROOT, FLASH], current: () => model },
    modelRegistry: {},
    abort() { generation += 1; calls.push(["abort"]); },
    ui: { notify: (message, severity) => notices.push([message, severity]), setStatus: (...args) => calls.push(["status", ...args]) },
  };
  factory(pi);
  // Real CLI reparses extension flags AFTER registration. Child rebinding never
  // copies parent flag values, even though the process argv is shared.
  if (options.flag !== undefined) flags.set("astromode", options.flag);
  async function emit(name, event = {}) {
    // OMP runner contains extension errors. Tests must not rely on throws
    // cancelling inference; abort changes the prompt-generation token instead.
    try { return await handlers.get(name)?.({ type: name, ...event }, ctx); }
    catch (error) { notices.push([`runner caught: ${error.message}`, "error"]); }
  }
  async function prompt({ bypassInput = false, systemPrompt = ["parent instructions", "another extension"] } = {}) {
    if (!bypassInput && (await emit("input", { text: "task" }))?.handled) return false;
    const before = generation;
    const result = await emit("before_agent_start", { prompt: "task", systemPrompt });
    if (before !== generation) return false; // agent-session.ts:6544
    inference += 1;
    return result?.systemPrompt ?? systemPrompt;
  }
  return {
    pi, ctx, flags, calls, notices, emit, prompt,
    get model() { return model; }, get effort() { return effort; }, get inference() { return inference; },
    switchId(next) { id = next; }, drift(next = OTHER, thinking = "medium") { model = next; effort = thinking; },
  };
}

async function missingRulesFactory(text) {
  const dir = mkdtempSync(join(tmpdir(), "astra-mode-")); dirs.push(dir);
  mkdirSync(join(dir, "extensions"));
  writeFileSync(join(dir, "package.json"), '{"type":"module"}');
  const file = join(dir, "extensions", "astromode.js");
  writeFileSync(file, readFileSync(new URL("../omp/extensions/astromode.js", import.meta.url)));
  if (text !== undefined) {
    mkdirSync(join(dir, "skills", "astra-orchestrator"), { recursive: true });
    writeFileSync(join(dir, "skills", "astra-orchestrator", "SKILL.md"), text);
  }
  return (await import(pathToFileURL(file).href)).default;
}

test("plain omp is inert even with missing rules and unusable context", async () => {
  const h = host({}, await missingRulesFactory());
  h.ctx.models.list = () => { throw new Error("must not query models"); };
  for (const event of ["session_start", "session_switch", "session_branch", "session_tree", "input", "before_agent_start"]) {
    assert.equal(await h.emit(event), undefined);
  }
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0].slice(0, 2), ["flag", "astromode"]);
  assert.equal(h.calls[0][2].type, "boolean");
  assert.equal(h.calls[0][2].default, false);
  assert.equal(h.notices.length, 0);
});

test("flag read after registration activates exact root before first prompt", async () => {
  const h = host({ flag: true });
  await h.emit("session_start");
  assert.equal(h.model, ROOT);
  assert.equal(h.effort, "xhigh");
  assert.deepEqual(h.calls.find(([name]) => name === "thinking"), ["thinking", "xhigh", false]);
  assert.ok(h.calls.some(([name, key, text]) => name === "status" && key === "astromode" && text.includes("Astro mode")));
  assert.ok(await h.prompt());
  assert.equal(h.inference, 1);
});

test("actual installed skill body is reused once, preserving all parent chunks", async () => {
  const h = host({ flag: true }); await h.emit("session_start");
  const parent = ["parent", "other extension"];
  const first = await h.emit("before_agent_start", { systemPrompt: parent });
  const second = await h.emit("before_agent_start", { systemPrompt: first.systemPrompt });
  assert.deepEqual(parent, ["parent", "other extension"]);
  assert.deepEqual(second.systemPrompt, first.systemPrompt);
  assert.deepEqual(first.systemPrompt.slice(0, 2), parent);
  const text = readFileSync(new URL("../omp/skills/astra-orchestrator/SKILL.md", import.meta.url), "utf8")
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
  assert.equal(first.systemPrompt[2], `<!-- astra-orchestrator:astromode -->\n${text}`);
});

for (const [name, options] of [
  ["missing Astra", { models: [FLASH] }],
  ["wrong provider Astra", { models: [{ ...ROOT, provider: "openrouter" }, FLASH] }],
  ["missing GLM", { models: [ROOT] }],
  ["GLM lacks max", { models: [ROOT, { ...FLASH, thinking: { efforts: ["high", "xhigh"] } }] }],
  ["Astra lacks xhigh", { models: [{ ...ROOT, thinking: { efforts: ["high"] } }, FLASH] }],
  ["setModel false", { setModel: async () => false }],
  ["setModel throws", { setModel: async () => { throw new Error("auth unavailable"); } }],
  ["wrong resolved model", { setModel: async (_value, set) => { set(OTHER); return true; } }],
  ["effort silently clamped", { clamp: "high" }],
]) {
  test(`${name}: activation fails closed for input and synthetic prompts`, async () => {
    const h = host({ flag: true, ...options }); await h.emit("session_start");
    assert.equal(await h.prompt(), false);
    assert.equal(await h.prompt({ bypassInput: true }), false);
    assert.equal(h.inference, 0);
    assert.ok(h.calls.some(([name]) => name === "abort"));
    assert.ok(h.notices.some(([message]) => message.startsWith("Astro mode blocked:")));
  });
}

for (const [label, text] of [["missing", undefined], ["empty", "---\nname: astra-orchestrator\n---\n\n"]]) {
  test(`${label} installed skill blocks activation without touching model`, async () => {
    const h = host({ flag: true }, await missingRulesFactory(text));
    await h.emit("session_start");
    assert.equal(await h.prompt({ bypassInput: true }), false);
    assert.equal(h.calls.filter(([name]) => name === "setModel").length, 0);
  });
}

test("pending activation cannot leak inference if runner times out awaiting it", async () => {
  let finish;
  const h = host({ flag: true, setModel: (_value, set) => new Promise((resolve) => {
    finish = () => { set(ROOT); resolve(true); };
  }) });
  const activation = h.emit("session_start");
  assert.equal(await h.prompt({ bypassInput: true }), false);
  assert.equal(h.inference, 0);
  finish(); await activation;
});

test("current root or thinking drift blocks the next prompt without changing defaults", async () => {
  const h = host({ flag: true }); await h.emit("session_start");
  h.drift(ROOT, "high");
  assert.equal(await h.prompt(), false);
  assert.equal(h.inference, 0);
});

test("switch, branch, tree and same-session reload reapply invocation-only mode", async () => {
  const h = host({ flag: true }); await h.emit("session_start");
  for (const event of ["session_switch", "session_branch", "session_tree", "session_switch"]) {
    h.switchId(`id-${event}`); h.drift();
    await h.emit(event);
    assert.equal(h.model, ROOT); assert.equal(h.effort, "xhigh");
    assert.ok(await h.prompt());
  }
});

test("unexpected session change without lifecycle activation blocks synthetic input", async () => {
  const h = host({ flag: true }); await h.emit("session_start"); h.switchId("other");
  assert.equal(await h.prompt({ bypassInput: true }), false);
});

test("fresh child binding and later resume without flag remain inert", async () => {
  const parent = host({ flag: true }); await parent.emit("session_start");
  const child = host({ current: FLASH }); await child.emit("session_start");
  assert.equal(child.model, FLASH); assert.equal(child.calls.length, 1);
  const resumed = host({ current: ROOT }); await resumed.emit("session_start");
  assert.equal(resumed.model, ROOT); assert.equal(resumed.calls.length, 1);
  assert.equal(await resumed.emit("before_agent_start", { systemPrompt: ["saved"] }), undefined);
});

test("false and string flags do not accidentally enable mode", async () => {
  for (const flag of [false, "false", "true"]) {
    const h = host({ flag }); await h.emit("session_start"); assert.equal(h.calls.length, 1);
  }
});

test("malformed system prompt fails closed instead of losing parent instructions", async () => {
  const h = host({ flag: true }); await h.emit("session_start");
  assert.equal(await h.prompt({ bypassInput: true, systemPrompt: "not an array" }), false);
  assert.equal(h.inference, 0);
});
