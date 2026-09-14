#!/usr/bin/env node
// Contract and installer tests for the additive Oh My Pi Astra bundle.
//
// Pure Node (node:test + node:assert), no dependencies, no network, no writes
// outside freshly created temp directories. Run with:
//
//   node scripts/test-omp-bundle.mjs
//
// The tests cover:
//   * fresh install into a temp project
//   * idempotent re-install (no-op on identical content)
//   * conflict refusal with zero writes
//   * --dry-run with zero writes
//   * an existing config file left byte-identical
//   * the route / effort / frontmatter / spawn / report contract of every
//     shipped agent file, plus the settings keys in config.example.yml

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(HERE);
const INSTALLER = join(REPO_ROOT, "install-omp.mjs");
const BUNDLE_ROOT = join(REPO_ROOT, "omp");

const EXPECTED_FILES = [
  "skills/astra-orchestrator/SKILL.md",
  "agents/astra-worker.md",
  "agents/astra-explorer.md",
  "agents/astra-researcher.md",
  "agents/astra-tester.md",
  "agents/astra-reviewer.md",
  "extensions/astromode.js",
];

// Tools OMP actually registers that this bundle may declare. `web_fetch` is
// not one of them: URL fetching goes through `read` with a URL path.
const VERIFIED_TOOL_NAMES = new Set([
  "read",
  "write",
  "edit",
  "bash",
  "grep",
  "glob",
  "web_search",
  "yield",
]);

// The route contract, one row per installed agent.
const AGENT_CONTRACT = {
  "astra-worker": {
    model: "opencode-go/glm-5.3-flash:max",
    thinking: "max",
    mustHaveTools: ["read", "write", "edit", "bash", "grep", "glob"],
  },
  "astra-explorer": {
    model: "opencode-go/glm-5.3-flash:max",
    thinking: "max",
    mustHaveTools: ["read", "grep", "glob", "bash"],
  },
  "astra-researcher": {
    model: "opencode-go/glm-5.3-flash:max",
    thinking: "max",
    mustHaveTools: ["read", "grep", "glob", "web_search"],
  },
  "astra-tester": {
    model: "opencode-go/glm-5.3-flash:max",
    thinking: "max",
    mustHaveTools: ["read", "write", "edit", "bash", "grep", "glob"],
  },
  "astra-reviewer": {
    model: "openai-codex/gpt-6-astra:xhigh",
    thinking: "xhigh",
    mustHaveTools: ["read", "grep", "glob", "bash", "web_search"],
  },
};

const READ_ONLY_AGENTS = ["astra-explorer", "astra-researcher", "astra-reviewer"];

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const tempDirs = [];

function tempProject() {
  const dir = mkdtempSync(join(tmpdir(), "astra-omp-test-"));
  tempDirs.push(dir);
  return dir;
}

process.on("exit", () => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

function runInstaller(args, options = {}) {
  const spawnArgs = [];
  if (options.hook) {
    spawnArgs.push("--import", options.hook);
  }
  spawnArgs.push(INSTALLER, ...args);
  return spawnSync(process.execPath, spawnArgs, {
    encoding: "utf8",
    env: options.env ? { ...process.env, ...options.env } : process.env,
  });
}

function globalTestOptions(testHome) {
  const hook = join(tempProject(), "test-homedir.mjs");
  writeFileSync(hook, 'import os from "node:os";\nimport { syncBuiltinESMExports } from "node:module";\nos.homedir = () => process.env.ASTRA_TEST_HOME;\nsyncBuiltinESMExports();\n');
  return { hook, env: { ASTRA_TEST_HOME: testHome } };
}

test("global install uses the user agent directory, preserves config, and is idempotent", () => {
  const home = tempProject();
  const target = join(home, ".omp", "agent");
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "config.yml"), "# keep my defaults\n");
  const options = globalTestOptions(home);
  const result = runInstaller(["--global"], options);
  assert.equal(result.status, 0, result.stderr);
  for (const file of EXPECTED_FILES) {
    assert.equal(readFileSync(join(target, file), "utf8"), readFileSync(join(BUNDLE_ROOT, file), "utf8"));
  }
  assert.equal(readFileSync(join(target, "config.yml"), "utf8"), "# keep my defaults\n");
  const again = runInstaller(["--global"], options);
  assert.equal(again.status, 0);
  assert.match(again.stdout, /0 to create, 7 identical/);
});

test("global dry-run and invalid mixed targets make no writes", () => {
  const home = tempProject();
  const options = globalTestOptions(home);
  assert.equal(runInstaller(["--global", "--dry-run"], options).status, 0);
  assert.deepEqual(walk(home), []);
  assert.equal(runInstaller(["--global", "--project", home], options).status, 2);
  assert.deepEqual(walk(home), []);
});

test("global conflict refuses the complete install before writing missing files", () => {
  const home = tempProject();
  const target = join(home, ".omp", "agent");
  mkdirSync(join(target, "extensions"), { recursive: true });
  writeFileSync(join(target, "extensions", "astromode.js"), "custom mode\n");
  assert.equal(runInstaller(["--global"], globalTestOptions(home)).status, 1);
  assert.deepEqual(walk(target), ["extensions/astromode.js"]);
  assert.equal(readFileSync(join(target, "extensions", "astromode.js"), "utf8"), "custom mode\n");
});

test("global install refuses a redirected agent directory without outside writes", () => {
  const home = tempProject();
  const outside = tempProject();
  mkdirSync(join(home, ".omp"));
  symlinkSync(outside, join(home, ".omp", "agent"));
  assert.equal(runInstaller(["--global"], globalTestOptions(home)).status, 1);
  assert.deepEqual(walk(outside), []);
});

// A deterministic write-failure hook. `--import` loads it before the installer
// module, it patches node:fs.writeFileSync (and re-syncs the builtin ESM
// exports so the installer's named import sees the patch), and it throws on the
// Nth write whose path ends with ASTRA_FAIL_ON. A count makes the failure
// deterministic regardless of which write happens first.
function writeFailureHookPath() {
  const dir = tempProject();
  const hookPath = join(dir, "fail-write.mjs");
  writeFileSync(
    hookPath,
    [
      'import fs from "node:fs";',
      'import { syncBuiltinESMExports } from "node:module";',
      "const target = process.env.ASTRA_FAIL_ON;",
      "const failAfter = Number(process.env.ASTRA_FAIL_AFTER || 0);",
      "let seen = 0;",
      "const original = fs.writeFileSync;",
      "fs.writeFileSync = function (path, ...rest) {",
      "  if (target && String(path).endsWith(target)) {",
      "    seen += 1;",
      "    if (seen > failAfter) {",
      '      if (process.env.ASTRA_RACING_SENTINEL) original(process.env.ASTRA_RACING_SENTINEL, "concurrent user content\\n");',
      '      throw new Error("simulated disk failure for " + target);',
      "    }",
      "  }",
      "  return original.call(this, path, ...rest);",
      "};",
      "syncBuiltinESMExports();",
      "",
    ].join("\n"),
  );
  return hookPath;
}

function installedPath(project, rel) {
  return join(project, ".omp", ...rel.split("/"));
}

function walk(dir, base = dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, base, out);
    } else {
      out.push(relative(base, full).split(sep).join("/"));
    }
  }
  return out;
}

function snapshot(dir) {
  const files = walk(dir);
  return Object.fromEntries(
    files.sort().map((rel) => [rel, readFileSync(join(dir, ...rel.split("/")), "utf8")]),
  );
}

// ---------------------------------------------------------------------------
// frontmatter parsing (minimal, enough for our own files)
// ---------------------------------------------------------------------------

function parseFrontmatter(text, fileLabel) {
  assert.ok(text.startsWith("---\n"), `${fileLabel}: must start with a frontmatter block`);
  const end = text.indexOf("\n---\n", 4);
  assert.ok(end > 0, `${fileLabel}: frontmatter block must be terminated`);
  const block = text.slice(4, end + 1);
  const body = text.slice(end + 5);

  const scalars = {};
  const lists = {};
  let currentList = null;

  for (const rawLine of block.split("\n")) {
    if (rawLine.trim() === "") continue;
    const indented = /^\s+\S/.test(rawLine);
    if (indented) {
      assert.ok(currentList, `${fileLabel}: indented line outside a list: ${JSON.stringify(rawLine)}`);
      lists[currentList].push(rawLine.trim().replace(/^-\s*/, ""));
      continue;
    }
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(rawLine);
    assert.ok(match, `${fileLabel}: unparsable frontmatter line: ${JSON.stringify(rawLine)}`);
    const [, key, value] = match;
    currentList = null;
    if (value === "") {
      lists[key] = [];
      currentList = key;
    } else if (value.startsWith("[") && value.endsWith("]")) {
      const inner = value.slice(1, -1).trim();
      lists[key] = inner === "" ? [] : inner.split(",").map((item) => item.trim());
    } else {
      scalars[key] = value;
    }
  }

  return { scalars, lists, body };
}

function loadAgent(name) {
  const path = join(BUNDLE_ROOT, "agents", `${name}.md`);
  const text = readFileSync(path, "utf8");
  const parsed = parseFrontmatter(text, `omp/agents/${name}.md`);
  return { path, text, ...parsed };
}

// ---------------------------------------------------------------------------
// installer tests
// ---------------------------------------------------------------------------

test("fresh install writes the full manifest into the target project", () => {
  const project = tempProject();
  const result = runInstaller(["--project", project]);

  assert.equal(result.status, 0, `installer must succeed:\n${result.stdout}\n${result.stderr}`);
  for (const rel of EXPECTED_FILES) {
    const target = installedPath(project, rel);
    assert.ok(existsSync(target), `missing installed file: ${rel}`);
    assert.equal(
      readFileSync(target, "utf8"),
      readFileSync(join(BUNDLE_ROOT, ...rel.split("/")), "utf8"),
      `installed content differs from bundle: ${rel}`,
    );
  }
  const installed = walk(join(project, ".omp"));
  assert.deepEqual(installed.sort(), [...EXPECTED_FILES].sort(), "installer wrote an unexpected file set");
});

test("re-install over identical content is a no-op success", () => {
  const project = tempProject();
  assert.equal(runInstaller(["--project", project]).status, 0);

  const before = snapshot(join(project, ".omp"));
  const second = runInstaller(["--project", project]);
  assert.equal(second.status, 0, `idempotent install must succeed:\n${second.stdout}`);
  assert.match(second.stdout, /nothing to do/i, "second run must report nothing to do");
  assert.deepEqual(snapshot(join(project, ".omp")), before, "second run must not change any file");
});

test("a conflicting file refuses the whole install and writes nothing", () => {
  const project = tempProject();
  const conflictRel = "agents/astra-worker.md";
  const conflictPath = installedPath(project, conflictRel);
  const divergentRel = "agents/astra-explorer.md";
  const divergentPath = installedPath(project, divergentRel);

  mkdirSync(dirname(conflictPath), { recursive: true });
  writeFileSync(conflictPath, "---\nname: astra-worker\ndescription: local edit\n---\nlocal edit\n");

  const before = snapshot(project);
  const result = runInstaller(["--project", project]);

  assert.equal(result.status, 1, `collision must exit 1:\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /COLLISION/, "collision must be reported");
  assert.deepEqual(snapshot(project), before, "a refused install must write nothing");
  assert.ok(
    !existsSync(divergentPath),
    "no other target may be written after a collision (all-or-nothing)",
  );
  assert.match(
    readFileSync(conflictPath, "utf8"),
    /local edit/,
    "the conflicting file must be left untouched",
  );
});

test("--dry-run reports creates and writes nothing at all", () => {
  const project = tempProject();
  const result = runInstaller(["--project", project, "--dry-run"]);

  assert.equal(result.status, 0, `dry-run must succeed:\n${result.stdout}`);
  assert.match(result.stdout, /would create/, "dry-run must describe planned creates");
  assert.match(result.stdout, /no files were written/i, "dry-run must state that it wrote nothing");
  assert.ok(!existsSync(join(project, ".omp")), "dry-run must not create .omp");
  assert.deepEqual(walk(project), [], "dry-run must leave the project empty");
});

test("--dry-run on a conflict still exits 1 and writes nothing", () => {
  const project = tempProject();
  const conflictPath = installedPath(project, "agents/astra-reviewer.md");
  mkdirSync(dirname(conflictPath), { recursive: true });
  writeFileSync(conflictPath, "different\n");

  const result = runInstaller(["--project", project, "--dry-run"]);
  assert.equal(result.status, 1, "dry-run over a conflict must exit 1");
  assert.equal(readFileSync(conflictPath, "utf8"), "different\n");
  assert.deepEqual(walk(join(project, ".omp")), ["agents/astra-reviewer.md"]);
});

test("an existing project config is never created, read-as-target, or modified", () => {
  const project = tempProject();
  const configPath = join(project, ".omp", "config.yml");
  mkdirSync(dirname(configPath), { recursive: true });
  const configBody = "task:\n  maxEffort: high\n";
  writeFileSync(configPath, configBody);

  const result = runInstaller(["--project", project]);
  assert.equal(result.status, 0, `install must succeed alongside a config:\n${result.stdout}`);
  assert.equal(readFileSync(configPath, "utf8"), configBody, "existing config must be byte-identical");
  assert.ok(!existsSync(join(project, ".omp", "config.yml.bak")), "no config backup may be created");
});

test("usage errors and help behave predictably", () => {
  const missing = runInstaller([]);
  assert.equal(missing.status, 2, "missing --project must be a usage error");
  assert.match(missing.stderr, /--project DIR is required/);

  const help = runInstaller(["--help"]);
  assert.equal(help.status, 0, "--help must exit 0");
  assert.match(help.stdout, /USAGE/);
  assert.match(help.stdout, /--dry-run/);

  const bogus = runInstaller(["--project"]);
  assert.equal(bogus.status, 2, "--project without a value must be a usage error");

  const unknown = runInstaller(["--nope"]);
  assert.equal(unknown.status, 2, "unknown flags must be a usage error");

  const nonexistent = runInstaller(["--project", join(tmpdir(), "astra-does-not-exist-xyz")]);
  assert.equal(nonexistent.status, 1, "a missing target directory must fail");
});

// ---------------------------------------------------------------------------
// path-safety tests (symlinks and blocked ancestors)
// ---------------------------------------------------------------------------

test("a .omp symlink is refused with zero writes, including into its target", () => {
  const project = tempProject();
  const outside = tempProject();
  symlinkSync(outside, join(project, ".omp"));

  const result = runInstaller(["--project", project]);

  assert.equal(result.status, 1, `symlinked .omp must be refused:\n${result.stdout}`);
  assert.match(result.stdout, /symlink/i, "the refusal must name the symlink");
  assert.deepEqual(walk(outside), [], "nothing may be written through the symlink target");
  assert.ok(!existsSync(join(outside, "agents")), "no directory may be created through the symlink");
});

test("a symlinked .omp/agents directory is refused with zero writes", () => {
  const project = tempProject();
  const outside = tempProject();
  mkdirSync(join(project, ".omp"), { recursive: true });
  symlinkSync(outside, join(project, ".omp", "agents"));

  const result = runInstaller(["--project", project]);

  assert.equal(result.status, 1, "symlinked agents dir must be refused");
  assert.deepEqual(walk(outside), [], "nothing may be written through the symlinked directory");
  assert.ok(
    !existsSync(installedPath(project, "skills/astra-orchestrator/SKILL.md")),
    "the safe skill target must not be written when another target is unsafe",
  );
});

test("an ancestor that is a regular file is refused before any write", () => {
  const project = tempProject();
  mkdirSync(join(project, ".omp"), { recursive: true });
  writeFileSync(join(project, ".omp", "agents"), "not a directory\n");

  const result = runInstaller(["--project", project]);

  assert.equal(result.status, 1, "a file blocking an ancestor directory must be refused");
  assert.equal(readFileSync(join(project, ".omp", "agents"), "utf8"), "not a directory\n");
  assert.ok(
    !existsSync(installedPath(project, "skills/astra-orchestrator/SKILL.md")),
    "a refused install must not write the skill before failing on agents",
  );
});

test("a symlinked leaf file is refused and its target is not touched", () => {
  const project = tempProject();
  const outside = tempProject();
  const outsideFile = join(outside, "astra-worker.md");
  writeFileSync(outsideFile, "outside content\n");
  mkdirSync(join(project, ".omp", "agents"), { recursive: true });
  symlinkSync(outsideFile, join(project, ".omp", "agents", "astra-worker.md"));

  const result = runInstaller(["--project", project]);

  assert.equal(result.status, 1, "a symlinked leaf must be refused");
  assert.equal(readFileSync(outsideFile, "utf8"), "outside content\n", "the outside file is untouched");
});

test("a dangling symlink at a target path is refused, not treated as absent", () => {
  const project = tempProject();
  mkdirSync(join(project, ".omp", "agents"), { recursive: true });
  symlinkSync(join(project, "does-not-exist.md"), join(project, ".omp", "agents", "astra-worker.md"));

  const result = runInstaller(["--project", project]);

  assert.equal(result.status, 1, "a dangling symlink must be refused");
  assert.match(result.stdout, /symlink/i);
  assert.ok(
    !existsSync(installedPath(project, "skills/astra-orchestrator/SKILL.md")),
    "no other target may be written when one target is unsafe",
  );
});

test("a late collision leaves earlier would-be files unwritten", () => {
  const project = tempProject();
  const late1 = installedPath(project, "agents/astra-tester.md");
  const late2 = installedPath(project, "agents/astra-reviewer.md");
  mkdirSync(dirname(late1), { recursive: true });
  writeFileSync(late1, "user version\n");
  writeFileSync(late2, "user version\n");

  const result = runInstaller(["--project", project]);

  assert.equal(result.status, 1, "a late collision must refuse the whole install");
  assert.ok(
    !existsSync(installedPath(project, "skills/astra-orchestrator/SKILL.md")),
    "the first target must not be written before the collision is seen",
  );
  assert.ok(!existsSync(installedPath(project, "agents/astra-worker.md")), "no partial write");
  assert.equal(readFileSync(late1, "utf8"), "user version\n", "the user file is untouched");
});

test("a write failure warns about a partial install, preserves existing files, and never cleans up", () => {
  const project = tempProject();

  // An already-installed file that looks byte-identical to the bundle, so the preflight
  // records it as "identical" and never plans to write it. It must still be
  // exactly there after the failing run.
  const sentinelRel = "agents/astra-tester.md";
  const sentinelPath = installedPath(project, sentinelRel);
  mkdirSync(dirname(sentinelPath), { recursive: true });
  const sentinel = readFileSync(join(BUNDLE_ROOT, ...sentinelRel.split("/")), "utf8");
  writeFileSync(sentinelPath, sentinel);

  // The write that fails is a real planned create, after the sentinel's slot.
  const failRel = "agents/astra-worker.md";
  const failingPath = installedPath(project, failRel);
  const hook = writeFailureHookPath();
  const result = runInstaller(["--project", project], {
    hook,
    env: { ASTRA_FAIL_ON: failRel.split("/").pop(), ASTRA_FAIL_AFTER: "0" },
  });

  assert.equal(result.status, 1, `a write failure must exit 1:\n${result.stdout}\n${result.stderr}`);
  assert.match(
    result.stderr,
    /Installation may be partial; no cleanup was attempted\./,
    "the partial-install warning must be printed verbatim on the error stream",
  );
  assert.equal(
    readFileSync(sentinelPath, "utf8"),
    sentinel,
    "an existing file must be preserved: no recursive or destructive cleanup",
  );
  assert.ok(
    !existsSync(failingPath),
    "the failed target itself must not exist as a half-written file",
  );
});

test("write failure in a new .omp preserves concurrent user content", () => {
  const project = tempProject();
  const sentinel = join(project, ".omp", "config.yml");
  assert.ok(!existsSync(join(project, ".omp")));
  const result = runInstaller(["--project", project], {
    hook: writeFailureHookPath(),
    env: {
      ASTRA_FAIL_ON: "astra-worker.md",
      ASTRA_FAIL_AFTER: "0",
      ASTRA_RACING_SENTINEL: sentinel,
    },
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Installation may be partial; no cleanup was attempted\./);
  assert.equal(readFileSync(sentinel, "utf8"), "concurrent user content\n");
  assert.ok(existsSync(installedPath(project, "skills/astra-orchestrator/SKILL.md")));
});

// ---------------------------------------------------------------------------
// bundle content contract
// ---------------------------------------------------------------------------

test("the shipped manifest matches what the installer knows about", () => {
  const actual = [];
  for (const dir of ["skills/astra-orchestrator", "agents", "extensions"]) {
    for (const rel of walk(join(BUNDLE_ROOT, dir), BUNDLE_ROOT)) {
      actual.push(rel);
    }
  }
  assert.deepEqual(actual.sort(), [...EXPECTED_FILES].sort(), "bundle file set changed");
});

test("every agent declares the contracted route, thinking level, and empty spawn policy", () => {
  const seen = new Set();
  for (const [name, contract] of Object.entries(AGENT_CONTRACT)) {
    const agent = loadAgent(name);
    seen.add(agent.scalars.name);

    assert.equal(agent.scalars.name, name, `${name}: frontmatter name must equal the file name`);
    assert.ok(agent.scalars.description && agent.scalars.description.length > 20, `${name}: description`);
    assert.equal(agent.scalars.model, contract.model, `${name}: model selector`);
    assert.equal(
      agent.scalars.thinking,
      contract.thinking,
      `${name}: thinking must equal the model suffix effort`,
    );
    assert.equal(
      agent.scalars["thinking-level"],
      undefined,
      `${name}: use the thinking alias, not thinking-level`,
    );
    assert.equal(
      agent.scalars.thinkingLevel,
      undefined,
      `${name}: use the thinking alias, not the camelCase alias`,
    );

    assert.ok("spawns" in agent.lists, `${name}: spawns key must be present`);
    assert.deepEqual(agent.lists.spawns, [], `${name}: spawn policy must be an empty list`);

    const tools = agent.lists.tools;
    assert.ok(Array.isArray(tools) && tools.length > 0, `${name}: tools allowlist must be explicit`);
    assert.ok(!tools.includes("task"), `${name}: tools must not include task`);
    assert.ok(!tools.includes("eval"), `${name}: tools must not include eval`);
    for (const tool of tools) {
      assert.ok(VERIFIED_TOOL_NAMES.has(tool), `${name}: undeclared/unverified tool name ${tool}`);
    }
    for (const tool of contract.mustHaveTools) {
      assert.ok(tools.includes(tool), `${name}: tools must include ${tool}`);
    }
  }
  assert.equal(seen.size, Object.keys(AGENT_CONTRACT).length, "duplicate agent names");
});

test("read-only agents declare no write or edit tool", () => {
  for (const name of READ_ONLY_AGENTS) {
    const agent = loadAgent(name);
    for (const forbidden of ["write", "edit"]) {
      assert.ok(!agent.lists.tools.includes(forbidden), `${name}: must not have ${forbidden}`);
    }
  }
});

test("every agent body carries the shared child report contract", () => {
  for (const name of Object.keys(AGENT_CONTRACT)) {
    const agent = loadAgent(name);
    for (const line of [
      "Status: complete | partial | blocked",
      "Evidence:",
      "Changes:",
      "Risks/unverified:",
      "Next/decision needed:",
    ]) {
      assert.ok(agent.body.includes(line), `${name}: report block missing ${JSON.stringify(line)}`);
    }
  }
});

test("the model selector carries the same effort as the thinking field", () => {
  for (const [name, contract] of Object.entries(AGENT_CONTRACT)) {
    const agent = loadAgent(name);
    const suffix = agent.scalars.model.split(":").pop();
    assert.equal(suffix, contract.thinking, `${name}: model suffix must match the thinking field`);
  }
});

test("the skill targets the native task tool and keeps the orchestration rules", () => {
  const skillPath = join(BUNDLE_ROOT, "skills", "astra-orchestrator", "SKILL.md");
  const text = readFileSync(skillPath, "utf8");
  const { scalars } = parseFrontmatter(text, "SKILL.md");

  assert.equal(scalars.name, "astra-orchestrator");
  assert.ok(scalars.description.includes("Oh My Pi") || scalars.description.includes("task tool"));

  for (const needle of [
    "astra-worker",
    "astra-explorer",
    "astra-researcher",
    "astra-tester",
    "astra-reviewer",
    "openai-codex/gpt-6-astra",
    "opencode-go/glm-5.3-flash",
    "Delegation gate",
    "Delegation contract",
    "Completion gate",
    "Status: complete | partial | blocked",
    "agentModelOverrides",
    "maxEffort",
    "cannot enforce",
  ]) {
    assert.ok(text.includes(needle), `SKILL.md must mention ${JSON.stringify(needle)}`);
  }

  assert.ok(!/\bsubagent\b/.test(text), "SKILL.md must not reference DSH subagent role tools");
  assert.ok(!/\bsubagent_/.test(text), "SKILL.md must not reference DSH subagent_* tools");
});

test("config.example.yml contains only the intended verified keys", () => {
  const path = join(BUNDLE_ROOT, "config.example.yml");
  const text = readFileSync(path, "utf8");

  const active = text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");

  assert.match(active, /maxEffort: max/, "maxEffort must be max");
  assert.match(active, /enableSkillCommands: true/, "skills.enableSkillCommands must be true");

  const maxEffort = /maxEffort:(\s*)(\S+)/.exec(active);
  assert.ok(maxEffort, "maxEffort key must be present and active");
  assert.equal(maxEffort[2], "max", "maxEffort value must be exactly max");
  assert.ok(!active.includes("maxEffort: high"), "maxEffort must not be lowered");

  // Unverified or misleading keys must not ship as active settings.
  assert.ok(!/^\s*maxRecursionDepth:/m.test(active), "maxRecursionDepth must not be set");
  assert.ok(!/^\s*disabledAgents:/m.test(active), "disabledAgents must not be set");
  assert.ok(
    !/^\s*agentModelOverrides:/m.test(active),
    "agentModelOverrides must stay commented out by default",
  );
  assert.ok(
    !/falls back to the bundled/m.test(readFileSync(path, "utf8")),
    "the missing-name fallback claim must not ship",
  );
});

// ---------------------------------------------------------------------------
// self-check: the installer is the only writer, and it is dependency-free
// ---------------------------------------------------------------------------

test("the installer has no third-party imports", () => {
  const text = readFileSync(INSTALLER, "utf8");
  const imports = [...text.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
  for (const specifier of imports) {
    assert.match(specifier, /^node:/, `install-omp.mjs must only import node: builtins, saw ${specifier}`);
  }
});

test("a fresh temp project install executes with a clean exit code", () => {
  const project = tempProject();
  const out = execFileSync(process.execPath, [INSTALLER, "--project", project], { encoding: "utf8" });
  assert.match(out, /done\.|nothing to do/);
});
