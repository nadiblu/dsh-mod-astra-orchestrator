# Astra Orchestrator for Oh My Pi

Additive Oh My Pi (OMP) bundle: an `--astromode` startup extension, a model
setup wizard, shared orchestration rules, and five leaf agents. Installation
does not edit OMP config, credentials, or saved model defaults; the setup wizard
only writes the routes you explicitly confirm.

## What ships

| Path | Role |
|---|---|
| `extensions/astromode.js` | opt-in `omp --astromode` activation and `/astromode-setup` wizard |
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
agents at `.omp/agents/*.md`. With `--global`, the same seven paths instead
live under `~/.omp/agent/`, making the mode available from any folder in the
default OMP profile. Named profiles and `PI_CODING_AGENT_DIR` use separate
agent directories and are not populated by `--global`.

## Install

```bash
node install-omp.mjs --global                              # all folders, default profile
node scripts/check-omp.mjs --global --project /path/to/project

# Or install only for one project:
node install-omp.mjs --project /path/to/project --dry-run   # plan only
node install-omp.mjs --project /path/to/project             # write
node scripts/check-omp.mjs --project /path/to/project       # verify native readiness
node install-omp.mjs --help
```

The installer is pure Node (>= 20.10) with no dependencies. It writes only into
`<project>/.omp/{skills,agents,extensions}` or the corresponding global
`~/.omp/agent/` directories. It requires an explicit `--project` or `--global`, skips files whose content already matches, and refuses the
whole install if any target file differs from the bundle — before writing
anything. It never reads or edits a config file and never touches credentials
or model defaults. Before migrating to global installation, back up old project
extension, skill, and agent copies outside OMP discovery directories. Project
agents can override global agents, and duplicate extension copies can conflict.

Exit codes: `0` installed / already current / clean dry-run, `1` collision or
filesystem error, `2` usage error.

The install is not transactional. If an I/O write fails partway, the installer
stops, prints `Installation may be partial; no cleanup was attempted.`, and
exits `1`; it does not delete or roll back anything, including files you had
there. Inspect the target and rerun. Do not replace or mutate `.omp` from
another process while the installer runs, and do not point two concurrent
installs at the same project — the preflight is a check, not a lock.

## Choose models

After installation, run this command in an interactive OMP session:

```text
/astromode-setup
```

It walks through the lead/root, worker, explorer, researcher, tester, and
reviewer roles. Each role gets a model picker followed by a thinking-level
picker; the current route or shipped default is preselected. A final summary
must be confirmed before anything is written. The saved routes use OMP's
`modelRoles` aliases and `task.agentModelOverrides`, so they apply on the next
`omp --astromode` launch. Project installs save to that project's `.omp/config.yml`;
global installs save to `~/.omp/agent/config.yml`.

The shipped defaults remain:

- Astra `xhigh` for the lead and independent reviewer.
- GLM 5.3 Flash `max` for worker, explorer, researcher, and tester.

## Other settings

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

After global installation, from any working folder (or from the installed
project's root for a project-only installation):

```bash
omp --astromode
```

This extension-owned flag selects the saved root route (Astra at `xhigh` by
default) and injects the shared rules before each turn; no `/skill` command is
needed. Use `/astromode-setup` to change the saved role routes. Keep extension discovery enabled.
Global extensions are available across folders. Project-only extensions are
discovered in the current directory, not ancestor folders.
Plain `omp` leaves the mode inactive.

Activation follows the current invocation, including switching or resuming root
sessions within it. Pass `--astromode` again on a later invocation to enable it.
A saved session may restore its previously selected model without the flag, but
that is normal OMP session state, not persisted mode activation.

The manual path remains available: launch
`omp --model openai-codex/gpt-6-astra:xhigh` without an initial task, then invoke
`/skill:astra-orchestrator <task>`. Only this manual path requires skill commands.

The readiness command compares the installed files with this checkout, checks
effective routing settings and catalog efforts, and starts OMP in RPC mode to
verify the root, five task agents, and `hub` tool. It sends no model prompt.
Run it again after upgrading OMP or changing agent/config files. It checks a
plain `omp --astromode` launch; additional CLI overlays can change the result.

Start a first task with a concrete outcome and acceptance check, for example:

> Add the requested feature. Explore the relevant code, give a bounded change
> to a GLM worker, run the relevant tests, and ask the Astra reviewer to inspect
> the final diff. Reuse the reviewer for fixes and keep its findings ledger
> updated. Report the result, tests, and unresolved findings.

Press `Alt+A` in OMP to inspect the running agents and their models. For later
review checkpoints, the lead should use `hub` to message the same child id.
OMP 18.1.17 supports waking idle and reviving parked non-isolated children;
the ledger fallback is for unavailable continuation, not the default.

## Routes and what is enforced

| Agent | Model selector | Thinking level | Tools |
|---|---|---|---|
| root session | `openai-codex/gpt-6-astra` | `xhigh` | session default |
| `astra-worker` | `opencode-go/glm-5.3-flash:max` | `max` | read, write, edit, bash, grep, glob |
| `astra-explorer` | `opencode-go/glm-5.3-flash:max` | `max` | read, grep, glob, bash |
| `astra-researcher` | `opencode-go/glm-5.3-flash:max` | `max` | read, grep, glob, web_search |
| `astra-tester` | `opencode-go/glm-5.3-flash:max` | `max` | read, write, edit, bash, grep, glob |
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

`max`, not `xhigh`, is deliberate: the OpenCode Go GLM 5.3 Flash catalog exposes
`low`, `high`, and `max`. The agents pin `max` explicitly.

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

52 checks: 28 bundle/installer cases and 24 mode/setup cases. Pure Node,
no dependencies or network. Installer cases use temporary directories: fresh
install, idempotent re-install, conflict refusal with zero
writes, symlink and blocked-ancestor refusal with zero writes, dry-run with zero
writes, existing config left untouched, and the frontmatter contract (model
selector and its effort suffix, the `thinking` field, `spawns: []`, no `task`
tool, required report block).

The contract tests read the bundle under `omp/`, not an installed target. They
prove what this repository ships; confirming what a project actually has
installed still means inspecting its effective project or global agent files.
Use the readiness command with `--global` when checking a global installation.
