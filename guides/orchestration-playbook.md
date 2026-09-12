# Orchestration playbook

The native `astra-orchestrator` preset is **GLM Lead · Astra Checkpoints**. GLM implements, integrates, verifies, and answers. Astra supplies bounded advice and independent review rather than running every turn.

## Which topology for which task

| Task | Required action |
|---|---|
| Routine low-risk edit or direct question | GLM inline; no consultation quota |
| Consequential state, persistence, concurrency, or control-routing design | Complete `subagent_architect` before committing to the design |
| Substantial completed change | Verify, then complete `subagent_reviewer` on the final actual diff before completion/deployment |
| Defect survives one meaningful changed-hypothesis retry | Complete `subagent_debug_consult` with the failed hypothesis and evidence |
| Independent execution slices | Optionally use bounded GLM workers with disjoint file ownership |
| Explicit request for consultation | Use the requested appropriate Astra role |

Architecture advice never substitutes for final-diff review. A role being available is not evidence that it ran. Each checkpoint requires an actual result and disposition of material findings; an unavailable required consultation blocks its dependent step.

Four execution roles are pinned to OpenRouter GLM/max; three consultation roles to Codex Astra/xhigh. Fork inherits the root. Keep tightly coupled edits with one writer and normally use no more than three concurrent children. The root's selected model remains host/session-controlled.

## Delegation contract

```text
Objective: one concrete outcome
Scope: exact files, symbols, or question
Context: relevant evidence, not the full transcript
Constraints: what must not change
Deliverable: recommendation, patch, or observed result
Acceptance: how the outcome will be checked
Stop: conditions requiring the root's decision
```

Explorers, researchers, architects, reviewers, and debug consultants are read-oriented roles. Give consultants the request header below with paths and the actual question; give final reviewers the real diff plus verification results. They cannot produce shell-based runtime evidence themselves through their standard tool surface.

## Consultation request header

Open every consult prompt with the same six fields; write
`not available: <reason>` rather than leaving a field blank. Follow-ups
reference finding ids, the evidence revision, what changed, and the narrowed
question instead of repeating the header.

```text
QUESTION: the decision or acceptance check this consultation gates
CONTEXT: workspace, scope, relevant background, non-goals
EVIDENCE: evidence revision (R1, R2, …), baseline, the actual change or reproduction, verification
CONSTRAINTS: invariants, tool limits, what must not change
READ FIRST: exact paths and symbols, in reading order
ANSWER WITH: numbered findings with the severity legend, then the compact report
```

Role minimums: architect — the decision, alternatives rejected and why (or
"none yet"), the invariants; reviewer — the complete final change against its
declared baseline, acceptance criteria, and the root's own verification
results; debug consult — exact reproduction, expected vs observed, the
initial and changed hypotheses with the evidence that falsified each, and what
remains unexplained.

The evidence handoff declares baseline and scope, captures the complete tracked
change — `git diff HEAD -- <paths>` when HEAD is the baseline (a bare `git
diff` misses staged work), `git diff <baseline> -- <paths>` for an older
commit, and before/after snapshots of the scoped files when the before-state
is dirty or the tree is not a git repo —
supplies untracked or new files separately, states exclusions, and records each
verification command with cwd, observed result, exit status, and the revision
it exercised. Default to an artifact directory per consult and revision (this
repository: `test-results/astra-consults/<session>/<consult>/R1/`); paste
inline only when the complete handoff is small, and never truncate. Artifacts
are local, uncommitted, redacted, root-written, and never added to `.gitignore`
automatically. Queue the consult after writers on the reviewed surface settle,
and keep that surface frozen until the result arrives.

## Findings ledger

Every consult numbers its material findings F1, F2, … before the compact
report, keeps ids stable across follow-ups, and appends new findings without
renumbering. The root records them as `<consult-alias>/F<n>`
(`architect-2/F1`). Severity legend (impact, not certainty; hypotheses stay
hypothetical):

- `blocker` — the dependent step is unsafe or impossible, or an acceptance criterion cannot hold
- `major` — a significant correctness, security, or reliability risk
- `minor` — a bounded real defect or a concrete validation gap
- `note` — an optional observation, not owed a disposition

The root closes the ledger with an explicit disposition per material finding:

```text
architect-2/F1 — fixed at src/state.ts:loadSnapshot; validation: state round-trip test passes
reviewer-3/F2 — accepted: retained risk is the documented fallback path, covered by the manual step
reviewer-3/F3 — rejected: counter-evidence — the caller already guards against null
```

`fixed` carries location plus validation; `accepted` names the consciously
retained risk and why; `rejected` cites counter-evidence or inapplicability. A
disposition cannot waive unmet acceptance criteria or safety rules.

A consult that cannot judge from its inputs returns `Status: blocked` naming
exactly what is missing; the checkpoint stays open until the root supplies
them and follows up with the same child — that is not a transport failure.
Follow-ups go to the same continuable child, and delivery is not completion:
wait for the actual result. A review covers the evidence revision as handed;
material post-review edits require re-verification and a delta review (same
reviewer, next revision, refreshed reads) before completion, and the final
change is compared against the reviewed revision before the ledger closes.

## Child report template

```text
Status: complete | partial | blocked
Evidence: paths/symbols or commands with observed results
Changes: changed files, or none
Risks/unverified: remaining evidence gaps
Next/decision needed: what the root must decide or do
```

The root verifies a child's report. Confidence and a `complete` label are not acceptance evidence.

## Architecture and debugging

Trace the causal path and relevant invariants first. Supply Astra with the consequential choice, alternatives, constraints, and evidence. The root records its decision and the check that could falsify it, then implements on GLM.

For repeated failures, name the reproduction and the changed hypothesis already falsified. Ask the debug consultant for the competing cause and a discriminating observation, not an expensive implementation takeover. GLM applies and verifies the resulting fix.

## Background children and boundaries

Native subagent calls return child IDs; settlement or a foreground result proves completion. `send_message` is not a completion receipt. `ready` or `idle` alone does not prove the assigned work finished. Background job IDs are separate from child IDs. Take consultations continuable (`run_in_background: true`) and keep the same child alive across checkpoints: a foreground call is one-shot and disposes the child, so continuity between Astra asks depends on continuable creation plus `send_message` follow-ups on the same child id. Gate the dependent step on the child's settled result — never sleep or poll to fill a wait.

All eight role tools enforce `maxDepth: 1`. Child route selection and tool filters are native controls; own-scope tool exemptions mean filters are not OS sandboxes. Root `workflow`/`ralph` paths are separate and reserved for explicit user requests.

Checkpoint timing, file ownership, and the completion policy are instructions, not mechanically enforced deployment gates.

## Completion gate

- Original acceptance criteria and realistic verification are satisfied.
- Triggered consultations actually completed; no required child remains running.
- The final actual diff was reviewed after verification for a substantial change, at its final evidence revision.
- The findings ledger is closed: every material finding recorded as fixed with validation, accepted with the retained-risk reason, or rejected with counter-evidence.
- The root checked the integrated result and reports unverified behavior honestly.
- No unmeasured cost, speed, or quality improvement is claimed.

## Manual A/B rollout checks

Run `npm test` first. Then use isolated **native web-preset** sessions, identical starting files and task prompts, and recorded model selections. Headless execution bypasses presets and is not comparable acceptance.

| Scenario | Observable result |
|---|---|
| Routine request | GLM answers without Astra |
| Consequential persistence change, without naming agents | Completed Astra/xhigh architecture consultation before writes; GLM implementation |
| Substantial final change | Completed Astra/xhigh final-diff review after meaningful execution proof |
| Repeated unresolved defect | Debug consultation after the changed-hypothesis retry fails |
| Failed required consultation | Dependent completion/deployment does not proceed silently |
| Long or resumed conversation | Required checkpoints still occur; fresh-session success alone is insufficient |

Use native journal `request/header`, `tool/call`, and `subagent/catalog` events to establish actual routes, calls, and outcomes. Compare correctness, unsupported completion claims, time, tokens, and real provider usage—not agent counts or an assumed delegation percentage. [Cost measurement](cost-and-performance.md).
