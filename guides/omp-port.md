# Also for Oh My Pi (OMP)

[Back to the README](../README.md)

**Status: installed globally and live-tested on OMP 18.1.17 (September 13, 2026).**
This repository ships an OMP bundle next to the DeepSeek Harness (DSH) preset.
The DSH install is unchanged by it. Astra/xhigh root and reviewer inference,
OpenCode Go GLM Flash/max worker inference, and a complete coding/test/review workflow
passed on the tested local account. This is a small acceptance test, not a
quality, speed, or cost benchmark.

The bundle includes an opt-in `--astromode` extension, shared skill rules, and
five agents. The extension selects the root model and injects the rules;
the agent files configure workers and review. Workflow rules remain instructions,
not an OS sandbox. Choose `--global` for all folders in the default profile,
or `--project DIR` for one project. Separate named profiles and custom
`PI_CODING_AGENT_DIR` directories are not populated by the global installer.

## What the installer adds

| Path under `<project>/.omp/` or `~/.omp/agent/` | Role |
|---|---|
| `extensions/astromode.js` | registers `--astromode` and activates the mode |
| `skills/astra-orchestrator/SKILL.md` | shared working rules, automatically loaded by the mode |
| `agents/astra-worker.md` | bounded implementer |
| `agents/astra-explorer.md` | read-only mapping and tracing |
| `agents/astra-researcher.md` | read-only external facts |
| `agents/astra-tester.md` | reproduction and targeted validation |
| `agents/astra-reviewer.md` | independent post-change review |

`config.example.yml` sits next to the agents in this checkout as an optional,
**not applied** reference overlay. Only the seven bundle files are written;
no credentials, `config.yml`, or `models.yml` are edited.

## Install

From this checkout:

```bash
node install-omp.mjs --global                              # available from every folder
node scripts/check-omp.mjs --global --project /path/to/project

# Alternative: install only for one project
node install-omp.mjs --project /path/to/project          # show the plan and write
node install-omp.mjs --project /path/to/project --dry-run # preview only
node scripts/check-omp.mjs --project /path/to/project     # inspect installed/native setup
```

## Conflicts

When migrating to global, back up and remove older project copies of this
extension, skill, and five agents from OMP discovery paths. Project agents
override user agents, while different extension file paths may both load.
The installer intentionally does not search or delete files in other projects.


There is no ownership tracking. For each target file, identical content is
treated as already installed and left alone; **any** difference stops the
install, lists the collisions, and writes nothing at all. That includes a file
you edited and an older bundle you installed earlier — an upgrade is refused
until you resolve it by hand. Move or delete the conflicting file (keep a backup
if you changed it), then rerun.

These are preflight guarantees, not a filesystem transaction. An I/O failure or
concurrent change during writing may leave a partial install; the installer
reports it and never deletes project content to roll back. Do not rename or
replace target directories concurrently with installation. Existing symlinked
targets and blocked ancestors are refused; new files use exclusive creation.

Exit codes: `0` installed or already up to date, `1` collision refused or
filesystem/read error, `2` usage error. Exactly one of `--project` or `--global`
is required. A project target must already exist; global bundle directories are
created beneath the existing home directory.

## Use

After global installation, from any working folder. For a project-only
installation, use the installed project's root:

```bash
omp --astromode
```

The extension selects `openai-codex/gpt-6-astra` at `xhigh` and injects the shared
orchestration rules automatically. No slash command is required. Plain `omp`
does not activate the extension's behavior.

The flag applies to root sessions in this invocation, including session switches
and resumes. Pass it again on a later launch; no mode activation is saved in
settings. OMP may normally restore a saved session's model without activating
this mode. The extension blocks new prompts after failed activation or a root
model/effort change; correct the cause and reload or restart with the flag.
Child model overrides still require the skill's preflight checks.

The flag comes from the installed `extensions/astromode.js`; it is not a
stock OMP flag. Keep extension discovery enabled. The global copy under
`~/.omp/agent/` is discovered across folders. A project-only copy is cwd-only,
unlike ancestor-walking agent discovery.
Do not combine this mode with `--no-extensions` unless explicitly loading the
extension with `--extension`.

The manual skill remains available for compatibility: launch with
`omp --model openai-codex/gpt-6-astra:xhigh`, then run
`/skill:astra-orchestrator <task>`. Only that manual path requires
`skills.enableSkillCommands`.

The lead dispatches with one `task` batch, shared context, and one self-contained
task per child:

```json
{
  "context": "shared context for every task in this batch",
  "tasks": [{ "agent": "astra-worker", "task": "self-contained assignment" }]
}
```

A task item carries `agent` and `task` (plus an optional `name`). The default
batch schema has **no model field and no effort field**, so a child's route comes
from its agent file. When `task.enableEffort` is turned on, an `effort` hint can
appear; it is a coarse `lo`/`med`/`hi` hint clamped to the model's supported
levels, not a route, and the bundle does not rely on it.

## Model routing

### Continuing a consultation

OMP 18.1.17 has native continuation through `hub`, alongside the initial `task`
spawn. Retain the returned agent id and send later checkpoints with
`{"op":"send","to":"<same child id>","message":"<revisioned handoff>","await":true}`.
Wait for the actual report before accepting the checkpoint. `hub list` shows
idle children; `hub list` with `status: "parked"` can locate parked children
after a resume. Non-isolated children can be woken or revived; killed children
and children whose isolated worktrees were cleaned up cannot be resumed.

Keep the findings ledger in both cases. Only when continuation is unavailable
should a replacement task receive the prior ledger and exact delta. The earlier
claim that all OMP child context ends after one report was incorrect for this
version. The [hub implementation](https://github.com/can1357/oh-my-pi/blob/v18.1.17/packages/coding-agent/src/tools/hub/index.ts)
and [child lifecycle](https://github.com/can1357/oh-my-pi/blob/v18.1.17/packages/coding-agent/src/task/executor.ts)
define the distinction. `Alt+A` opens OMP's Agent Hub for inspecting agents.

### Routes

| Role | Agent file | Model selector | Thinking |
|---|---|---|---|
| lead | none — the session itself | `openai-codex/gpt-6-astra` | `xhigh` |
| worker | `astra-worker` | `opencode-go/glm-5.3-flash` | `max` |
| explorer | `astra-explorer` | `opencode-go/glm-5.3-flash` | `max` |
| researcher | `astra-researcher` | `opencode-go/glm-5.3-flash` | `max` |
| tester | `astra-tester` | `opencode-go/glm-5.3-flash` | `max` |
| reviewer | `astra-reviewer` | `openai-codex/gpt-6-astra` | `xhigh` |

Both selectors are listed by OMP 18.1.17; `openai-codex` is a built-in provider
with bundled Codex auth, so the Astra route needs no custom provider entry. A
catalog entry is not account entitlement and not a live call: verify the account
can use `gpt-6-astra` before relying on it, and never switch providers silently
when it is missing — report the gap.

GLM 5.3 Flash lists `low`, `high`, and `max`. OMP silently clamps an unsupported
effort instead of rejecting it, so an `xhigh` request on this model lands on
`high`; the agents pin `max` explicitly. `gpt-6-astra` lists `low`, `medium`,
`high`, `xhigh`, and `max`, so the root's and the reviewer's `xhigh` are
supported.

### What the routing does not enforce

The installer does not edit saved model defaults. With `--astromode`, the
extension selects Astra/xhigh for the root session; without it, root selection
comes from normal OMP settings, session state, or CLI flags. The skill alone
cannot select models. Child dispatch still follows OMP precedence:

1. `task.agentModelOverrides[agentName]` from an OMP settings file, when set;
2. otherwise the agent file's `model` and `thinking`;
3. otherwise the parent session's active model.

So an override written into settings wins over the table above, and naming a
different agent in a task item uses that agent's route. `modelRoles` is not a
fourth layer: it only expands `@alias` entries that appear in 1 or 2, and never
overrides an explicit `provider/model` selector. Check the session and the agent
roster rather than assuming the bundle's intent took effect.

## Tool and spawn limits

Each agent declares an explicit `tools` list that omits `task`. Worker and
tester have shell and write tools; explorer and reviewer have read-oriented tools
and shell; researcher has read and web tools. Reviewer's list also includes
`web_search`. OMP may add helper tools such as `yield` and `hub`.

The files also contain `spawns: []`, but OMP 18.1.16 normalizes that empty array
to an unspecified policy. **It is not an independent no-spawn guarantee.**
Omitting `task` is the bundle's actual delegation restriction; adding it later
would reopen delegation unless another effective policy blocks it.

These are tool restrictions, not an OS sandbox. Shell-bearing agents can still
write files or launch processes; read-only conduct and file ownership remain
instructions. This is not structurally equivalent to DSH's `maxDepth: 1`.
The installer does not change OMP session settings.

## Checked and not checked

`npm run test:omp` runs 28 installer/bundle checks and 21 extension lifecycle
checks, without model calls. Coverage includes an inert unflagged launch, exact
root model/effort activation, prompt preservation, failure guards, and fresh
child bindings. The OMP 18.1.16 parser, flag handling, and lifecycle source were
checked against the pinned version.

A native OMP 18.1.16 RPC startup probe installed the seven-file bundle into a
fresh project and sent only `get_state`: plain OMP kept its normal model/high;
`--astromode` selected `openai-codex/gpt-6-astra` at `xhigh`. Neither session was
streaming, and no prompt or model inference was requested. This proves flag
discovery and startup selection, not live delegated task execution.

On September 12, the same startup check passed on OMP 18.1.17. The new
`scripts/check-omp.mjs [--global] --project DIR` also checks all seven installed files,
conflicting effective route/prewalk settings, catalog efforts, all five roles
in the native task roster, and the presence of `hub`. It sends no model prompt
and does not prove live account access; additional CLI overlays can change the
checked setup.

A live disposable-project acceptance then ran Astra/xhigh as root,
`astra-worker` on GLM Flash/max, and `astra-reviewer` on Astra/xhigh. The worker
created a finite-number sum function and six tests; the root caught a coercion
edge case, repaired it, added a seventh test, and ran 7/7 successfully. The
independent reviewer checked the actual files and hashes and accepted with no
material findings. Session records confirm the exact child models and efforts.
Local evidence is under `test-results/omp-live-readiness/` (ignored by Git).

A second invocation resumed the same saved root session. `hub list` found
`SumSmokeReview` parked; `hub send` returned `revived` for that exact id. Before
reading any files, the reviewer recalled its prior acceptance and the closed
coercion finding from retained context. It then reread both source files and
confirmed acceptance. The root waited for the settled reply and recorded it;
no new `task` spawn was used. This verifies native continuation across a process
restart for that non-isolated child, not just a ledger reconstruction.

The explorer, researcher, and tester were confirmed in the native roster but
were not separately exercised with live prompts. Other accounts and larger
projects still need their own acceptance. The OMP and DSH root topologies differ:
this OMP bundle uses an Astra lead; the DSH preset uses a GLM lead with Astra
consultations.

## Remove

The installer has no uninstall step. Stop OMP before removing the bundle.
The commands below remove a project copy; for a global copy, use
`~/.omp/agent` in place of `/path/to/project/.omp`, removing only these same
seven bundle files and keeping config and other installed tools:

```bash
rm -f /path/to/project/.omp/extensions/astromode.js
rm -rf /path/to/project/.omp/skills/astra-orchestrator
rm -f /path/to/project/.omp/agents/astra-worker.md \
      /path/to/project/.omp/agents/astra-explorer.md \
      /path/to/project/.omp/agents/astra-researcher.md \
      /path/to/project/.omp/agents/astra-tester.md \
      /path/to/project/.omp/agents/astra-reviewer.md
```

Remove emptied `.omp/agents`, `.omp/skills`, and `.omp/extensions` directories
only if the project did not use them before.

## Sources

OMP documentation and mode implementation references:

- [Extension loading, v18.1.16](https://github.com/can1357/oh-my-pi/blob/v18.1.16/docs/extension-loading.md)
- [Extension flag parsing, v18.1.16](https://github.com/can1357/oh-my-pi/blob/v18.1.16/packages/coding-agent/src/cli/extension-flags.ts)
- [Extension APIs, v18.1.16](https://github.com/can1357/oh-my-pi/blob/v18.1.16/packages/coding-agent/src/extensibility/extensions/types.ts)
- [Session model controls, v18.1.16](https://github.com/can1357/oh-my-pi/blob/v18.1.16/packages/coding-agent/src/session/model-controls.ts)

Original skill-port references:

- [Skills](https://github.com/can1357/oh-my-pi/blob/main/docs/skills.md) —
  `.omp/skills/<name>/SKILL.md`, `/skill:<name>`, `enableSkillCommands`
- [Task agents](https://github.com/can1357/oh-my-pi/blob/main/docs/task-agent-discovery.md)
  — `.omp/agents/*.md`, `tools`, `spawns`, `model` and `thinking`,
  `task.agentModelOverrides` precedence, effort clamping
- [Models](https://github.com/can1357/oh-my-pi/blob/main/docs/models.md) —
  `provider/modelId:level` selectors and supported efforts
- [Settings](https://github.com/can1357/oh-my-pi/blob/main/docs/settings.md) —
  project `.omp/config.yml`, settings precedence, skill toggles
