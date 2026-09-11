# dsh-mod-astra-orchestrator

A DeepSeek Harness mod that ports the
[`codex-astra-luna-orchestrator`](https://github.com/donvito/codex-astra-luna-orchestrator)
topology to DSH — with the tiers swapped:

| Role | Codex original | This mod |
|---|---|---|
| orchestrator (root) | GPT-6 Astra, medium | **`openai-codex` / `gpt-6-astra`** (requested default; effort is session/user selected) |
| worker family | GPT-5.6 Luna, max | **`deepseek-official` / `deepseek-flash` (DeepSeek-V41-Flash), high** |
| independent reviewer | GPT-6 Astra, low | **`openai-codex` / `gpt-6-astra`, low** |

Both tiers are real routes: the orchestrator and reviewer ride the **ChatGPT
Plus/Pro subscription** through pi-ai's `openai-codex` OAuth provider, and the
workers ride the **DeepSeek API** on the harness's own `deepseek-official` route.
Both run inside one DSH session tree; nothing shells out to Codex.

## What the mod installs

| Piece | Where | Why |
|---|---|---|
| Agent preset `astra-orchestrator` | `<dshHome>/.agent-presets/astra-orchestrator/` (copy mode) or the package dir (bundle mode) | the composition: Astra persona, six role tools (four pinned flash workers, one pinned Astra reviewer, one inherited fork), plus the standard tool surface |
| Skill `astra-orchestrator` | `<dshHome>/skills/astra-orchestrator/` | the delegation gate, architecture gate, role matrix, child report standard, cost rules, escalation and completion gates |
| Settings route + defaults | `<dshHome>/settings.yaml` | registers `openai-codex`, makes the preset the roster default, and (with `--activate`) makes Astra the default model |
| `openai-codex` login | credential store `<dshHome>/.credentials.yaml` | the ChatGPT subscription grant, record `llm-pi-ai/openai-codex` |
| Bundle patch (bundle mode) | profile layer stack | adds the preset root, the route, the default model, and the `dsh-authorization` sign-in seam |

The Codex file-by-file mapping:

| Codex original | DSH equivalent here |
|---|---|
| `.codex/config.toml` `model` / `model_reasoning_effort` | `agent-default-model` settings (provider/model/reasoningEffort) |
| `.codex/agents/worker.toml` etc. | one `@deepseek-ai/dsh-tool-subagent` row per role with `agentOptions` |
| `model = "gpt-5.6-luna"` in a role file | `agentOptions: { provider: deepseek-official, model: deepseek-flash }` |
| `model_reasoning_effort` in a role file | `agentOptions.reasoningEffort` |
| `developer_instructions` in a role file | the row's `persona` string |
| `sandbox_mode = "read-only"` | the restricted rows' read-oriented `toolFilter.allow` list; the worker, tester, and fork instead deny the eight delegation/workflow tools. This is a tool restriction, not an equivalent OS sandbox |
| `.agents/skills/astra-orchestrator/SKILL.md` | the same skill name under `<dshHome>/skills/` |
| `AGENTS.md` orchestration policy | the preset persona plus the skill (no global AGENTS.md edit) |
| `max_concurrent_threads_per_session = 4` | **no hard equivalent** — the skill carries a soft planning budget of three concurrently active children; delegation *depth* is capped with `maxDepth: 1`. See "Known gaps" |

## Orchestration boundaries

- The route pins live in `agentOptions` and are preset-owned. The generic
  `subagent` row sets `modelSelectionSettings: false`, so no child tool exposes
  route selection: a worker cannot silently promote itself, and a hard
  architectural problem is resolved by the root rather than rerouted.
- All six role tools carry `maxDepth: 1`: the root delegates once and a child
  cannot delegate at all. The root-side `workflow` and `ralph` tools are separate
  from those rows, inherit none of their pins or filters, and are used only on
  explicit user request.
- The child filters are a tool restriction, not an OS-level read-only sandbox.
  Explorer, researcher, and reviewer keep a read-oriented allowlist and therefore
  have no standard shell or write/edit tools: give the reviewer the actual diff or
  before/after evidence (a diff artifact path or pasted hunks; a named whole-file
  review only when no diff exists), and produce any runtime evidence that needs a
  shell in the root or a shell-bearing role.
- The root's model and effort above are the preset's requested default, not a
  runtime guarantee — the session or user can select otherwise.
- **Enforced versus instructed.** Only the route pins (`agentOptions`),
  `maxDepth`, `toolFilter`, and `modelSelectionSettings` are enforced by the
  harness. File ownership, the three-child planning budget, the child report
  envelope, and the completion gate are prompt and skill policy: they shape
  behavior but no runtime check rejects a violation.

## Install

Requirements: a working `dsh` installation (this mod is authored against
`@deepseek-ai/dsh` 0.1.5-rc.1), Node 20+, and a ChatGPT Plus/Pro subscription
with Codex access.

Clone the standalone repository and install from its root:

```bash
git clone <repository-url> dsh-mod-astra-orchestrator
cd dsh-mod-astra-orchestrator

# 1. install the preset, the skill, and the route, then sign in
node install.mjs --yes --login            # device-code sign-in by default
#    or: node install.mjs --yes --login --method browser

# 2. optional: make Astra the default model for fresh sessions (after the sign-in worked)
node install.mjs --yes --activate
```

The commands below assume you are already inside the checkout root.

Then start a session on the **Astra Orchestrator** preset. `--activate` also
points `agent-default-model` at `openai-codex/gpt-6-astra` and **rewrites that
entry's reasoning effort to medium**, so it discards a custom root effort:
existing users who already set their own effort should use plain
`node install.mjs --yes` for updates, which installs the preset and skill and
preserves `agent-default-model`. For activation, deliberately restart the host
when idle and start a fresh session; do not assume a running or already-mounted
preset picks up file changes. Verify the effective route and tools afterwards.

Useful flags:

```bash
node install.mjs --dry-run            # print the plan and the settings diff
node install.mjs --activate           # flip the default model (and reset its effort to medium)
node install.mjs --logout             # delete the stored ChatGPT grant
node install.mjs --uninstall          # remove preset, skill, route, and restore the previous default
node install.mjs --verify             # run `dsh --profile web --dump-config` after writing
node scripts/login-openai-codex.mjs --check   # provider/store state, no network
```

Bundle mode installs the package into a profile and composes the patch layer —
useful for a clean profile or for distribution. It requires a CLI restart:

```bash
node install.mjs --yes --bundle --profile web
dsh plugin --profile web why dsh-mod-astra-orchestrator   # confirm the layer
```

The installer is idempotent, backs up `settings.yaml` before its first write,
never touches unrelated namespaces or comments, and re-parses the merged
document before keeping it. `scripts/test-settings-merge.mjs` proves the
round-trip.

## The ChatGPT subscription (this is the part that needs a human)

`openai-codex` has **no API key** — pi-ai's provider declares OAuth only, with
`isSubscription: true` and base URL `https://chatgpt.com/backend-api`. The flow
is registered by `dsh-llm-pi-ai`, but only when `ctx.authorization` exists, and
the shipped profiles neither mount `@deepseek-ai/dsh-authorization` nor ship a
sign-in UI or a `dsh login` verb. So this mod ships the missing piece:

`scripts/login-openai-codex.mjs` runs pi-ai's own `openaiCodexOAuth.login()`
out of process and writes the result into the harness credential store.

- **device code (default, headless)** — prints
  `https://auth.openai.com/codex/device` plus a user code, then polls until you
  approve it in your own browser. No local callback server, no port.
- **browser** — starts the local callback server on `127.0.0.1:1455`, prints the
  authorization URL, and also accepts a pasted code or redirect URL.

The grant lands as:

```yaml
records:
  llm-pi-ai/openai-codex:
    kind: grant
    payload:
      type: oauth
      access: …
      refresh: …
      expires: 1234567890123
      accountId: …
```

`dsh-credentials-local` watches that file, so a running harness picks the
sign-in up without a restart. Tokens are never printed; `--json` reports only
metadata.

The bundle patch also mounts `@deepseek-ai/dsh-authorization` so the in-harness
flow exists for any surface that can start an authorization attempt (ACP, SDK, a
future client page). The CLI script above is the supported path today.

## Offline validation before activation

Run from this mod directory:

```bash
npm test
# Optional: validate against a specific installed harness package:
ASTRA_ORCHESTRATOR_DSH_ROOT=/path/to/dsh npm test
```

The suite needs installed DSH libraries; missing or incompatible libraries fail
rather than silently skipping. It checks parsed role configuration, real scoped
tool-registry restrictions over a stub catalog, the runtime depth policy, and a
copy installation into a temporary `DSH_HOME`. Discovery resolves plugin paths;
it does not mount a host. Live settings, preset, and skill are left untouched.

These checks do not create a real child session or call a model. They do not prove
live catalog compatibility, prompt compliance, or better coding/research outcomes.
The playbook describes the separate behavioral A/B checks, which require explicit
activation and realistic tasks. No speed, cost, or quality improvement is claimed.

## Verifying the topology

After a reinstall, restart the host when it is idle and open a fresh session;
then check the effective route and the child tool catalog rather than assuming a
hot reload.

1. `node scripts/login-openai-codex.mjs --check` → `signed in: yes`.
2. Start a session on the **Astra Orchestrator** preset and ask for something
   multi-file. The root should plan, then call `subagent_explorer` /
   `subagent` / `subagent_tester` / `subagent_reviewer`.
3. The GUI shows each child session with its own route; workers read
   `deepseek-official / deepseek-flash`, the reviewer `openai-codex /
   gpt-6-astra`.
4. Confirm the child's tool list: the restricted roles show no shell or edit
   tools, and no child shows `subagent`, `workflow`, or `ralph`.
5. `node install.mjs --verify` proves the composed profile tree still loads.
   (Run it with the CLI stopped.)

## Known gaps

- **No hard concurrency cap.** The Codex template's
  `max_concurrent_threads_per_session = 4` has no DSH counterpart, so the skill
  carries a soft planning budget of three concurrently active children, reviewer
  included. Delegation *depth* is capped instead: `maxDepth: 1` keeps every role
  child a leaf. The root-side `workflow` and `ralph` tools are outside those rows
  and are unaffected by the role pins and filters.
- **`--activate` resets the root effort.** It rewrites `agent-default-model` to
  `openai-codex/gpt-6-astra` at medium, discarding a custom effort. Use plain
  `node install.mjs --yes` to update the preset and skill without touching the
  default model.
- **Do not rely on mounted-preset hot reload.** Restart the host when idle and
  start a fresh session after an authorized reinstall. Check the effective route
  and child catalog; offline tests do not verify a running session's refresh.
- **No `--login` UI.** Sign-in is a CLI step in this build (see above).
- **Version coupling.** The preset copies the shipped `standard` composition of
  `@deepseek-ai/dsh-agent-presets` 0.1.5-rc.1. A harness upgrade that changes
  that preset's rows needs the same rows re-copied here; the role rows
  themselves are self-contained.
- **`gpt-6-astra` route access.** Model availability depends on the ChatGPT plan
  and on pi-ai's catalog (`openai-codex` currently advertises `gpt-6-astra`,
  `gpt-5.6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.5`, `gpt-5.4`,
  `gpt-5.4-mini`, `gpt-5.3-codex-spark`). A plan without Astra access fails at
  request time; switch the orchestrator row to another codex model if so.

## Design references

Two sources inform the role boundaries, task-dependent fan-out, and the manual
evaluation checklist (see the playbook):

- [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)
- [Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents)

They support the design reasoning. Neither measures this preset, so they are not
evidence that it improves outcomes here; only a local evaluation can be.

## Layout

```text
dsh-mod-astra-orchestrator/
├── cordis.patch.yml          bundle layer (roster root, route, default model, auth seam)
├── install.mjs               installer / uninstaller / activator
├── package.json              dsh.bundle.patch manifest + bin
├── preset/
│   ├── preset.yml            roster metadata
│   └── agent.cordis.yml      the composition (standard + role-pinned delegation)
├── skills/astra-orchestrator/SKILL.md
├── scripts/
│   ├── login-openai-codex.mjs
│   ├── test-settings-merge.mjs
│   └── test-preset-composition.mjs
├── guides/
│   └── orchestration-playbook.md
├── licenses/
│   └── Apache-2.0.txt        upstream license text (third-party)
└── THIRD_PARTY_NOTICES.md    upstream attribution and license split
```

## License

This mod's original additions use the [MIT license](LICENSE). Any retained material
from [codex-astra-luna-orchestrator](https://github.com/donvito/codex-astra-luna-orchestrator)
remains subject to [Apache License 2.0](licenses/Apache-2.0.txt).

The exact adapted portions have not been compared file by file; no blanket claim
of independent authorship or relicensing is made. See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for provenance, modification
notes, and the limits of the attribution audit. Preserve both license texts.
