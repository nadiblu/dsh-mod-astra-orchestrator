# Setup and technical reference

[Quick start](../README.md#quick-start)

Targets native DSH `0.1.5-rc.1`. The stable preset/skill id is `astra-orchestrator`; its picker label is **GLM Lead · Astra Checkpoints**.

## What the mod installs

| Piece | Location and purpose |
|---|---|
| Preset | `$DSH_HOME/.agent-presets/astra-orchestrator/` in copy mode; standing GLM-led policy, eight role tools, and standard tools |
| Skill | `$DSH_HOME/skills/astra-orchestrator/`; checkpoint workflows, role contracts, evidence and completion rules |
| Settings | `$DSH_HOME/settings.yaml`; Codex provider registration and preset default; `--activate` additionally writes GLM/max as the fresh-session model |
| Activation receipt | `$DSH_HOME/.astra-orchestrator-backups/model-selection.json`; original model block and exact owned activation |
| Bundle patch | Optional profile layer: preset root, OpenRouter/Codex routes, default provider/model, and authorization service |

`DSH_HOME` defaults to `~/.dsh`. Copy installation requires an already configured OpenRouter route/model/credential and preserves it. Bundle mode also declares an OpenRouter route using `OPENROUTER_API_KEY` and an `opencode-go` route carrying `sessionHeader: "x-opencode-session"` — OpenCode Go drops inference requests without a stable per-conversation id (deepseek-harness discussion #5495). The header needs DSH with llm-pi-ai `sessionHeader` support; older harnesses ignore the unknown field. User settings still layer over profile configuration.

## Install

```bash
node install.mjs --yes --activate --verify
```

`--activate` is an explicit settings write to:

```yaml
agent-default-model:
  provider: openrouter
  model: z-ai/glm-5.3-flash
  reasoningEffort: max
```

Plain `node install.mjs --yes` updates the preset and skill without changing the selected root model or effort. The host owns root model selection; the preset does not enforce it. The bundle's composition row accepts provider/model only, so use settings or `--activate` for `max`.

Restart DSH when idle and create a new session after updating. A running conversation's mounted preset and model are not replaced by copying files.

```bash
dsh --profile web
```

Select **GLM Lead · Astra Checkpoints** and verify **GLM 5.3 Flash / Max**.

Other installer operations:

```bash
node install.mjs --dry-run
node install.mjs --yes --login
node install.mjs --yes --login --method browser
node install.mjs --yes --bundle --profile web --activate
node install.mjs --uninstall
```

Installation backs up changed settings and replaced presets. The original model selection is captured once; explicit reactivation updates the receipt's owned route. Uninstall restores that selection only while the current route and effort still match the recorded activation. Legacy Astra/xhigh receipts remain removable after a non-activating upgrade. User changes made after activation are preserved.

## Credentials

GLM requests require working OpenRouter credentials. DSH can resolve stored credentials or configured environment references; an absent shell variable alone does not prove authentication is unavailable. Confirm a normal GLM request succeeds before using the mode.

Astra consultations use the `openai-codex` subscription route. The bundled helper supports device-code and browser sign-in:

```bash
node scripts/login-openai-codex.mjs --method device
node scripts/login-openai-codex.mjs --method browser
node scripts/login-openai-codex.mjs --check
```

Use `--login` only when sign-in is needed. Installation and mode updates do not replace existing credentials. A successful sign-in does not independently establish Astra entitlement; a real consultation must succeed.

## Native routing and restrictions

- `subagent`, `subagent_explorer`, `subagent_tester`, `subagent_researcher`: `openrouter/z-ai/glm-5.3-flash`, `max`.
- `subagent_architect`, `subagent_reviewer`, `subagent_debug_consult`: `openai-codex/gpt-6-astra`, `xhigh`.
- `subagent_fork`: inherits the root route and history.
- Model-supplied child route overrides are disabled. All eight roles have `maxDepth: 1`.
- Explorer, researcher, and the three Astra roles use read-oriented allowlists. Other children lose the eight role tools plus `workflow` and `ralph`.
- Tool restrictions are not OS sandboxes; own-scope plugin tools can remain. Supply a real diff and runtime evidence to reviewers because their standard shell/write tools are absent.
- Root-side `workflow` and `ralph` are separate, unpinned paths reserved for explicit user requests.

The installed pi-ai catalog for the exact OpenRouter GLM model declares `low`, `high`, and `max`. A model entry without its own `reasoningEfforts` inherits those capabilities. Do not add a redundant `modelOverrides` entry beside a configured `models` list: native DSH rejects that combination.

## Verification

```bash
npm test
# Optional installed-library location:
ASTRA_ORCHESTRATOR_DSH_ROOT=/path/to/dsh npm test
```

These checks use temporary homes and installed native libraries. Missing/incompatible libraries fail rather than silently skipping. They cover configuration, scoped tool restrictions, depth, copy discovery, and settings restoration—not inference or checkpoint compliance.

`node install.mjs --verify` checks the composed host configuration with `dsh --profile web --dump-config`; it does not exercise a mounted preset or consult a model.

For behavioral proof, create a fresh **web** session on this preset, run a disposable consequential coding task, and inspect native `request/header`, `tool/call`, and `subagent/catalog` events. Confirm real GLM/max execution, completed Astra/xhigh architecture and final-diff reviews, and no consultation for an ordinary follow-up. The headless runner bypasses presets and cannot replace this check.

## Known limits

The root model, checkpoint timing, file ownership, three-child planning budget, and findings disposition remain instructed policy, not runtime locks. Route/filter/depth enforcement alone cannot guarantee the root chooses to consult. Do not claim that a deployment is mechanically blocked by this preset.

A single successful run does not prove reliability after long context growth or resumption. Harness upgrades require composition and live route verification. No silent model fallback is authorized when a required route is unavailable.
