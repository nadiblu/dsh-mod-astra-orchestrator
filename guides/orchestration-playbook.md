# Orchestration playbook

Short, copy-paste decision rules for the Astra Orchestrator preset. The skill
carries the full doctrine; this file is the pocket card.

## Which topology for which task

| Task shape | Topology |
|---|---|
| One-file edit, clear acceptance | root only |
| Question about code you can read in one pass | root only |
| Bug traced across 2+ modules | one `subagent_explorer` per suspected area in parallel → root decides → one `subagent` → `subagent_tester` |
| Multi-file feature with separable slices | explorers in parallel → one `subagent` per owned file set → tester → reviewer |
| Version/API/dependency uncertainty | `subagent_researcher` alongside the explorers |
| Risky change (auth, data, concurrency, public API) | full chain, and `subagent_reviewer` is mandatory |
| "Get a second opinion with our context" | `subagent_fork` (inherits route + history; not a cost saving) |

One bounded worker is often the whole team. Plan for at most three concurrently
active children, reviewer included — soft planning budget, not a hard cap. Role
count is not a success metric, and tightly coupled writers stay with one owner.
Every child is a leaf: `maxDepth: 1` on the six role tools, so children cannot
delegate further. The root's own `workflow` and `ralph` tools are separate and
only used when the user explicitly asks.

Enforced by the harness: route pins, `maxDepth`, `toolFilter`. Instructed policy:
file ownership, the three-child budget, the report template, and the completion
gate. These are design hypotheses to evaluate, not runtime checks or measured gains.

Restricted roles (explorer, researcher, reviewer) have no standard shell or edit
tools (own-scope plugin tools may remain). Give the reviewer the actual diff or
before/after evidence — a diff artifact path or pasted hunks — or, when no diff is
possible, a named whole-file review it must report as such. Produce the runtime
evidence yourself; the filter is a tool restriction, not an OS sandbox.

## Contract template

```text
Objective: <one outcome>
Scope: <files / module / symbol / question>
Context: <only what is needed>
Constraints: <what must not change>
Deliverable: <what to return or implement>
Acceptance: <how success is checked>
Stop/Budget: <when to return early; the budget for this task>
```

Explorers, researchers, and the reviewer must not modify files; their standard
shell/write/edit tools are withheld. Their deliverable is evidence with paths and
symbols. Workers own files; never assign two workers the same file.

## Child report template

```text
Status: complete | partial | blocked
Evidence: paths/symbols, or commands with observed result and exit status
Changes: files changed, or none
Risks/unverified: what could not be checked
Next/decision needed: what the root must decide or do
```

A child's "complete" is a report, not the root's acceptance.

## Architecture gate (nontrivial changes)

Before editing: name the acceptance criteria and non-goals; trace the real data
or control path and its invariants; list missing evidence and risks; compare the
minimal coherent fix with leaving the design intact. Record the decision, why the
rejected option lost, and the check that would falsify it. The root decides.

## Parallel vs serial

Parallel when the tasks do not read each other's results: independent explorers,
independent file-owned workers, a researcher before you decide.

Serial when a decision is needed between steps:

```text
explore → decide → implement → test → review → fix → final verify
```

## Cost rules

- Anything routine runs on the flash workers; only planning, integration,
  synthesis, and review run on `gpt-6-astra`.
- Do not paste raw logs or whole files into the root. Ask children for
  conclusions, paths, commands, observed results, risks.
- The reviewer is the one role that is *supposed* to be expensive; give it the
  actual diff or before/after evidence and the acceptance criteria, not a summary
  of intent. Current files alone are not a review of the change.
- Escalation is the root's decision and must be stated. A flash worker never
  promotes itself, and no child tool exposes route selection.

## Background children

A call returns a durable **child id**, not a job id. The settlement notice or a
foreground return carries the result. `send_message` starts or steers a child; it
is not a completion receipt. `list_agents` status `ready` or `idle` means the
child exists, not that its work is done. `job_output` takes job ids from real
background jobs only. Never finish a turn while required work is running.

## Failure handling

1. Read the failure reason.
2. Retry once with a changed hypothesis or better context, then narrow, reassign,
   or do it yourself in the root — a hard architectural problem may be resolved
   in the root after the bounded failure is recorded.
3. Say which fallback happened in the final answer.

Never claim a child succeeded when it failed or never ran. A verified fallback
may still complete the objective; report which path succeeded. Never claim cost
or improvement benefits that were not measured.

## Completion gate

- the original task's acceptance criteria are met
- no required child still running; every required child completed or failed with
  its scope accounted for
- reviewer findings either resolved or explicitly accepted with a reason
- the highest-value, outcome-focused checks were run, or the missing validation
  is named
- the final actual diff was inspected by the root

## Manual A/B rollout checks

Run `npm test` first; those offline checks need no activation. The behavioral A/B
checks below are a separate, explicitly authorized rollout, not part of that suite.
For each revision, install with plain `node install.mjs --yes` (preset and skill
update; default model preserved), restart the host when idle, and start a fresh
session. Avoid `--activate`: it overwrites the root's effort setting. Confirm the
effective route and child tool catalog rather than assuming a reload. Keep inputs,
model routes, budgets, and workspace starting state the same across revisions;
record revision identifiers and reserve held-out tasks. Full flag notes live in
the [setup reference](setup-reference.md). The current activation defaults are
Astra at xhigh for the lead and Astra at high for the reviewer; workers remain
DeepSeek at high. Record any overrides in your results. Keep the
[calculated cost and scheduling scenarios](cost-and-performance.md) separate
from measurements collected here.

Run these checks by hand on the candidate and on the previous revision, then
compare. Record each observed outcome, including failures — do not report an
improvement that was not measured.

| Check | Scenario | What to look for |
|---|---|---|
| Trivial task | one-file edit with clear acceptance | root does it directly; no children spawned |
| Coupled bug | failure spanning 2+ modules | one explorer per area, one writer, tester reproduces the original failure |
| Conflicting source | docs disagree with observed code | researcher cites the fetched primary URL and version; root resolves, not the child |
| False completion | child returns `complete` with weak evidence | root re-checks the diff and rejects or repairs before presenting |
| Leaf containment | child tries to delegate | child's delegation tools are denied and the depth cap rejects any attempt |

Metrics, only when actually measured: outcome correctness, unsupported
completion claims, wall-clock time, and tokens. A single unfavourable run is
evidence, not a verdict; keep the raw evidence path per run.

## References

Two sources shaped this design; neither measures this preset:

- [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)
  — supporting evidence for explicit role boundaries, task-dependent fan-out that
  varies with the work, and the need for a small real evaluation set.
- [Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents)
  — supporting evidence for unambiguous tool contracts and for measuring end
  states rather than intermediate activity.

They support the design reasoning here. They are not evidence that this preset
improves Astra outcomes; only a local evaluation can support such a claim.
