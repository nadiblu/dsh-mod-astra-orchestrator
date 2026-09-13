#!/usr/bin/env node
// Install the Oh My Pi Astra bundle into a project or the default user profile.
//
// Scope, deliberately narrow:
//   * writes only into the selected skills, agents, and extensions directories
//   * requires explicit --project DIR or --global; there is no implicit target
//   * refuses every non-identical collision before it writes anything
//   * refuses any symlink or non-directory ancestor inside the project, so a
//     redirected `.omp` cannot push writes outside the explicit target
//   * creates each file exclusively (flag "wx") rather than truncating
//   * never edits, creates, or backs up any config file
//   * never touches credentials or model defaults
//   * no dependency install or network access
//
// Node >= 20.10, no third-party dependencies.

import {
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  lstatSync,
} from "node:fs";
import { join, resolve, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLE_ROOT = join(HERE, "omp");

// Explicit manifest: the shipped surface is exactly these files. Anything else
// in the bundle directory (README, config.example.yml, future docs) is not
// installed.
const BUNDLE_FILES = [
  "skills/astra-orchestrator/SKILL.md",
  "agents/astra-worker.md",
  "agents/astra-explorer.md",
  "agents/astra-researcher.md",
  "agents/astra-tester.md",
  "agents/astra-reviewer.md",
  "extensions/astromode.js",
];

const USAGE = `install-omp.mjs — install the Astra Orchestrator bundle for Oh My Pi

USAGE
  node install-omp.mjs --project DIR [--dry-run]
  node install-omp.mjs --global [--dry-run]
  node install-omp.mjs --help

TARGET (choose exactly one)
  --project DIR   Project directory to install into. Files land in
                  DIR/.omp/{skills,agents,extensions}/. The directory must
                  already exist; there is no default target.
  --global        Install for all folders in the default OMP profile at
                  ~/.omp/agent/{skills,agents,extensions}/.

OPTIONS
  --dry-run       Report every action without writing anything.
  --help, -h      Print this help and exit.

BEHAVIOR
  * Identical existing files are skipped (safe no-op).
  * A differing existing file is a collision: the installer refuses, lists
    every collision, and writes nothing at all.
  * Every path component from the project root down to each target is checked
    before any write. A symlink, or a non-directory blocking an ancestor
    directory, refuses the whole install with zero writes. Parent directories
    above --project are not policed: resolve the real project root yourself.
  * New files are created with an exclusive "wx" open, so a file that appears
    after the checks fails the run instead of being truncated. A write failure
    may leave a partial install; no files are deleted to roll it back.
  * Do not concurrently rename or replace target directories while installing.
    Path checks are not an OS-level sandbox or an atomic transaction.
  * Existing config, credentials, and model defaults are never read or modified.
    --global writes only bundle files in the default user profile. Back up and
    remove older project copies to avoid duplicate extension activation. Merge omp/config.example.yml into your own
    config.yml yourself if you want those settings.

EXIT CODES
  0  installed, already up to date, or --dry-run reported a clean plan
  1  collision refused, or a filesystem/read error
  2  usage error (missing or bad arguments)
`;

function fail(code, message) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const out = { project: undefined, global: false, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      out.help = true;
    } else if (arg === "--global") {
      out.global = true;
    } else if (arg === "--dry-run") {
      out.dryRun = true;
    } else if (arg === "--project") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        fail(2, "error: --project requires a directory argument\n\n" + USAGE);
      }
      out.project = next;
      i += 1;
    } else if (arg.startsWith("--project=")) {
      out.project = arg.slice("--project=".length);
    } else {
      fail(2, `error: unknown argument ${JSON.stringify(arg)}\n\n` + USAGE);
    }
  }
  return out;
}

function loadBundle() {
  const entries = [];
  for (const rel of BUNDLE_FILES) {
    const source = join(BUNDLE_ROOT, rel);
    if (!existsSync(source)) {
      throw new Error(`bundle file missing: ${relative(HERE, source)}`);
    }
    entries.push({ rel, source, contents: readFileSync(source, "utf8") });
  }
  return entries;
}

/**
 * Descend the target path inside the project, rejecting anything that would
 * let a write escape the explicit project root or land on the wrong node:
 *
 *   - a symlink at any component (a redirected `.omp` or agent file)
 *   - a non-directory occupying an ancestor directory position
 *   - a broken/dangling leaf symlink, which `existsSync` reports as absent
 *
 * Parent directories above the project root are not policed: the caller chose
 * that root, and a symlinked parent is a legitimate way to reach it. Every
 * component at or below the root must be a real directory.
 */
function inspectTarget(projectDir, parts) {
  const trail = [];
  for (let i = 0; i < parts.length - 1; i += 1) {
    trail.push(parts[i]);
    const current = join(projectDir, ...trail);
    let info;
    try {
      info = lstatSync(current);
    } catch (error) {
      if (error.code === "ENOENT") return { kind: "absent" };
      throw error;
    }
    if (info.isSymbolicLink()) {
      return { kind: "symlink", path: current };
    }
    if (!info.isDirectory()) {
      return { kind: "not-directory", path: current };
    }
  }

  const leaf = join(projectDir, ...parts);
  let leafInfo;
  try {
    leafInfo = lstatSync(leaf);
  } catch (error) {
    if (error.code === "ENOENT") return { kind: "absent", path: leaf };
    throw error;
  }
  if (leafInfo.isSymbolicLink()) {
    return { kind: "symlink", path: leaf };
  }
  if (!leafInfo.isFile()) {
    return { kind: "not-file", path: leaf };
  }
  return { kind: "file", path: leaf };
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }

  if (args.global && args.project !== undefined) {
    fail(2, "error: choose --global or --project DIR, not both\n\n" + USAGE);
  }
  if (!args.global && (args.project === undefined || args.project.trim() === "")) {
    fail(2, "error: --project DIR is required unless --global is specified\n\n" + USAGE);
  }

  const projectDir = resolve(args.global ? homedir() : args.project);
  const prefix = args.global ? [".omp", "agent"] : [".omp"];
  const targetRoot = join(projectDir, ...prefix);
  if (!existsSync(projectDir) || !lstatSync(projectDir).isDirectory()) {
    fail(1, `error: --project target is not an existing directory: ${projectDir}`);
  }

  let bundle;
  try {
    bundle = loadBundle();
  } catch (error) {
    fail(1, `error: ${error.message}`);
  }

  // Path-safety preflight for every target, before any content comparison or
  // write. An unsafe target refuses the whole install with zero writes.
  const unsafe = [];
  const plan = bundle.map((entry) => {
    const parts = [...prefix, ...entry.rel.split("/")];
    const target = join(projectDir, ...parts);
    const inspection = inspectTarget(projectDir, parts);
    let state;
    if (inspection.kind === "absent") {
      state = "create";
    } else if (inspection.kind === "file") {
      state = readFileSync(target, "utf8") === entry.contents ? "identical" : "collision";
    } else {
      state = "unsafe";
      unsafe.push({ rel: entry.rel, target, inspection });
    }
    return { ...entry, target, state };
  });

  if (unsafe.length > 0) {
    const lines = [];
    lines.push(`bundle:  ${BUNDLE_ROOT}`);
    lines.push(`${args.global ? "home" : "project"}: ${projectDir}`);
    lines.push("");
    lines.push("refusing to write: a target path is not a plain directory/file node.");
    lines.push("A symlink or a blocking non-directory could redirect this install outside");
    lines.push("the project you named. Nothing was changed.");
    for (const item of unsafe) {
      lines.push(`  ${item.rel}: ${item.inspection.kind} at ${item.inspection.path}`);
    }
    lines.push("");
    lines.push("Remove the symlink or blocking file and run the installer again.");
    process.stdout.write(lines.join("\n") + "\n");
    process.exitCode = 1;
    return;
  }

  const mode = args.dryRun ? "dry-run" : "install";
  const lines = [];
  lines.push(`bundle:  ${BUNDLE_ROOT}`);
  lines.push(`${args.global ? "home" : "project"}: ${projectDir}`);
  lines.push(`target:  ${targetRoot}`);
  lines.push(`mode:    ${mode}`);
  lines.push("");

  for (const item of plan) {
    const shown = relative(projectDir, item.target) || item.target;
    const label =
      item.state === "create"
        ? args.dryRun
          ? "would create"
          : "create"
        : item.state === "identical"
          ? "skip (identical)"
          : "COLLISION";
    lines.push(`  ${label.padEnd(16)} ${shown}`);
  }

  const collisions = plan.filter((item) => item.state === "collision");
  const creates = plan.filter((item) => item.state === "create");
  const identical = plan.filter((item) => item.state === "identical");

  lines.push("");
  lines.push(
    `summary: ${creates.length} to create, ${identical.length} identical, ${collisions.length} collision(s)`,
  );

  if (collisions.length > 0) {
    lines.push("");
    lines.push("refusing to write: the files below exist with different content.");
    lines.push("Move them aside or delete them, then run again. Nothing was changed.");
    for (const item of collisions) {
      lines.push(`  ${relative(projectDir, item.target)}`);
    }
    process.stdout.write(lines.join("\n") + "\n");
    process.exitCode = 1;
    return;
  }

  if (!args.dryRun) {
    try {
      for (const item of creates) {
        const inspection = inspectTarget(projectDir, [...prefix, ...item.rel.split("/")]);
        if (inspection.kind !== "absent") {
          throw new Error(`target changed after preflight: ${item.target}`);
        }
        mkdirSync(dirname(item.target), { recursive: true });
        // Exclusive creation preserves a file that appears after preflight.
        writeFileSync(item.target, item.contents, { flag: "wx" });
      }
    } catch (error) {
      // This is not a transaction: another process may own any new content.
      // Never recursively remove a project directory to roll back a failure.
      fail(1, `error: write failed: ${error.message}\nInstallation may be partial; no cleanup was attempted. Inspect the target and rerun.`);
    }
  }

  if (creates.length === 0) {
    lines.push("nothing to do: bundle already installed at this target.");
  } else if (args.dryRun) {
    lines.push("dry-run: no files were written.");
  } else {
    lines.push("done. No config file was read or modified.");
    lines.push("Optional settings live in omp/config.example.yml — merge them by hand.");
  }

  process.stdout.write(lines.join("\n") + "\n");
}

try {
  main();
} catch (error) {
  fail(1, `error: ${error.message}`);
}
