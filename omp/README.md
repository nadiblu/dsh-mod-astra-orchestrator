# Astra Orchestrator for Oh My Pi

Additive Oh My Pi (OMP) bundle: an `--astromode` startup extension, shared
orchestration rules, and five leaf agents. It installs nothing by itself and
changes nothing that already exists — no DSH files, no OMP config, no global
state.

## What ships

| Path | Role |
|---|---|
| `extensions/astromode.js` | opt-in `omp --astromode` activation |
| `skills/astra-orchestrator/SKILL.md` | shared root rules, automatically injected by the mode |
| `agents/astra-worker.md` | bounded implementation (GLM 5.3 Flash, `max`) |
| `agents/astra-explorer.md` | read-only repository exploration (GLM 5.3 Flash, `max`) |
| `agents/astra-researcher.md` | read-only external research (GLM 5.3 Flash, `max`) |
| `agents/astra-tester.md` | reproduction and verification (GLM 5.3 Flash, `max`) |
| `agents/astra-reviewer.md` | independent review (`openai-codex/gpt-6-astra`, `xhigh`) |
| `config.example.yml` | optional manual settings; never applied by the installer |
| `../install-omp.mjs` | the installer |
| `../scripts/test-omp-bundle.mjs` | installer and agent contract tests |
| `../scripts/test-omp-mode.mjs` | startup extension lifecycle and failure tests |

Installed layout under the target project:

```text
<project>/.omp/extensions/astromode.js
<project>/.omp/skills/astra-orchestrator/SKILL.md
<project>/.omp/agents/astra-worker.md
<project>/.omp/agents/astra-explorer.md
<project>/.omp/agents/astra-researcher.md
<project>/.omp/agents/astra-tester.md
<project>/.omp/agents/astra-reviewer.md
```

OMP discovers project skills at `.omp/skills/<name>/SKILL.md` and project task
agents at `.omp/agents/*.md`. Nothing here is installed at user level.

## Install

```bash
node install-omp.mjs --project /path/to/project --dry-run   # plan only
node install-omp.mjs --project /path/to/project             # write
node install-omp.mjs --help
```

The installer is pure Node (>= 20.10) with no dependencies. It writes only into
`<project>/.omp/{skills,agents,extensions}`, requires an explicit
`--project` target, skips files whose content already matches, and refuses the
whole install if any target file differs from the bundle — before writing
anything. It never reads or edits a config file, never installs globally, and
never touches credentials or model defaults.

Exit codes: `0` installed / already current / clean dry-run, `1` collision or
filesystem error, `2` usage error.

The install is not transactional. If an I/O write fails partway, the installer
stops, prints `Installation may be partial; no cleanup was attempted.`, and
exits `1`; it does not delete or roll back anything, including files you had
there. Inspect the target and rerun. Do not replace or mutate `.omp` from
another process while the installer runs, and do not point two concurrent
installs at the same project — the preflight is a check, not a lock.

## Settings are manual

The installer does not apply settings. Merge what you want from
`config.example.yml` into `~/.omp/agent/config.yml` or
`<project>/.omp/config.yml` yourself:

- `task.maxEffort: max` — the ceiling on the coarse per-spawn effort hint (only
  reachable with `task.enableEffort`, default `false`). The workflow omits
  `effort`, so the agents keep their own `thinking` values.
- `skills.enableSkillCommands: true` — enables `/skill:astra-orchestrator`.

`config.example.yml` deliberately ships no recursion-depth setting: its exact
off-by-one behavior was not established to the standard required to publish a
value, so the file omits it rather than guessing. The only delegation
restriction is the absent `task` tool in every agent's allowlist; `spawns: []`
normalizes to unspecified and is declaration of intent, not an enforcement.

## Run

From the installed project's root:

```bash
omp --astromode
```

This extension-owned flag selects Astra at `xhigh` and injects the shared rules
before each turn; no `/skill` command is needed. Keep extension discovery enabled.
Project extensions are discovered in the current directory, not ancestor folders.
Plain `omp` leaves the mode inactive.

Activation follows the current invocation, including switching or resuming root
sessions within it. Pass `--astromode` again on a later invocation to enable it.
A saved session may restore its previously selected model without the flag, but
that is normal OMP session state, not persisted mode activation.

The manual path remains available: launch
`omp --model openai-codex/gpt-6-astra:xhigh` without an initial task, then invoke
`/skill:astra-orchestrator <task>`. Only this manual path requires skill commands.

## Routes and what is enforced

| Agent | Model selector | Thinking level | Tools |
|---|---|---|---|
| root session | `openai-codex/gpt-6-astra` | `xhigh` | session default |
| `astra-worker` | `openrouter/z-ai/glm-5.3-flash:max` | `max` | read, write, edit, bash, grep, glob |
| `astra-explorer` | `openrouter/z-ai/glm-5.3-flash:max` | `max` | read, grep, glob, bash |
| `astra-researcher` | `openrouter/z-ai/glm-5.3-flash:max` | `max` | read, grep, glob, web_search |
| `astra-tester` | `openrouter/z-ai/glm-5.3-flash:max` | `max` | read, write, edit, bash, grep, glob |
| `astra-reviewer` | `openai-codex/gpt-6-astra:xhigh` | `xhigh` | read, grep, glob, bash, web_search |

`yield` is appended by OMP to every explicit tool list, and it may add `hub` as
well; do not rely on the runtime list being exactly what the file declares. What
matters is what is absent: no agent lists `task`, and every agent declares
`spawns: []`. The missing `task` tool is the capability boundary — a child
cannot dispatch another agent — while the empty spawn policy documents intent.
An empty `spawns` array normalizes to "no restriction" in the installed build,
so it is not itself an enforced empty allowlist and must not be described as
one. None of this is an OS sandbox: a shell-bearing agent still runs with the
permissions of the session that spawned it.

`max`, not `xhigh`, is deliberate: the OpenRouter GLM 5.3 Flash catalog exposes
`low`, `high`, and `max`, so an `xhigh` request resolves to `high`. The bundle
targets the top level the catalog actually offers.

## Limits — read before trusting the pins

- The skill **cannot enforce a route** and **cannot switch the session's model**.
  OMP resolves a spawn model as `task.agentModelOverrides` → agent frontmatter
  `model` → the parent session's active model. A `task.agentModelOverrides`
  entry therefore wins over an explicit frontmatter pin, silently and by design.
  A session-level `--model` selection changes the root session and what a
  pinless child would inherit; it does not rewrite an agent that declares its
  own `model`.
- `task.maxEffort` is a ceiling on the coarse per-spawn effort hint, and that
  hint only exists when `task.enableEffort` is true (default `false`). Omitting
  `effort` — as this bundle's workflow does — leaves each agent's
  `thinking` setting intact. Separately, a model that cannot reach a requested
  level is satisfied by the nearest level it supports; that clamp is model
  behavior, not `maxEffort`.
- File ownership, the report format, the completion gate, and the preflight
  refusal to substitute routes are **instructed policy**. No OMP check rejects a
  violation.
- The bundle is additive: it does not modify, wrap, or replace any DSH skill,
  preset, or installer.

The skill's own preflight makes the honest response explicit: confirm the
routes, the effort ceilings, and the agent files with `omp models list` and a
read of `.omp/agents/*.md`, and **stop on any mismatch** instead of quietly
accepting a default or a lower effort.

## Tests

```bash
npm run test:omp
```

46 checks: 24 bundle/installer cases and 22 mode lifecycle cases. Pure Node,
no dependencies or network. Installer cases use temporary directories: fresh
install, idempotent re-install, conflict refusal with zero
writes, symlink and blocked-ancestor refusal with zero writes, dry-run with zero
writes, existing config left untouched, and the frontmatter contract (model
selector and its effort suffix, the `thinking` field, `spawns: []`, no `task`
tool, required report block).

The contract tests read the bundle under `omp/`, not an installed target. They
prove what this repository ships; confirming what a project actually has
installed still means reading that project's `.omp/agents/*.md`.
