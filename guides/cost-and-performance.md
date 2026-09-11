# Cost and performance measurement

[Back to the mode](../README.md)

The native mode uses **OpenRouter GLM 5.3 Flash/max** for the root and execution workers, and **Codex GPT-6 Astra/high** for architecture, final-diff review, and difficult-debugging consultations. The previous Astra-root/DeepSeek-worker estimates do not describe this topology and have been removed.

## What consumes which account

- Ordinary root turns and bounded execution workers use OpenRouter.
- The three Astra consultation roles use the configured ChatGPT/Codex subscription route and its limits.
- A fork inherits the root's current route. Selecting a different root model changes that cost.
- The root's separate workflow/ralph paths are not pinned by the role configuration.

The mode does not reduce a fixed subscription fee or enforce a spending cap. Mandatory checkpoints can add requests. A cheaper token price does not prove lower total task cost, because retries, context size, reasoning output, and task success can differ.

## Measure rather than assume

For comparable tasks, record:

1. Starting files, task prompt, preset revision, and actual root/child model selections.
2. End-to-end acceptance outcome, including failed or incomplete work.
3. Actual input, cached input, output, and reasoning usage where reported.
4. Provider billing/usage and subscription consumption separately.
5. Wall-clock time, failed attempts, consultation count, and unsupported completion claims.

Use current [OpenRouter model pricing](https://openrouter.ai/z-ai/glm-5.3-flash) and actual account usage when calculating API charges. Do not apply historical DeepSeek rates or API list-price equivalents to subscription requests as if they were the user's bill.

A single native acceptance run can establish that GLM called Astra and completed that task. It does not establish a percentage saving, speedup, or long-session reliability. Follow the [behavioral comparison checklist](orchestration-playbook.md#manual-ab-rollout-checks) before making those claims.
