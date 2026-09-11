# Cost and performance estimates

[Back to the README](../README.md)

These are **calculated scenarios**, not observed benchmarks or forecasts of
typical tasks. The default team is Astra at **xhigh**, DeepSeek workers at
**high**, and an independent Astra reviewer at **high**. No task runs were used
to fit these estimates, and equal-quality results have not been demonstrated.

## Price inputs

USD per million tokens, checked September 11, 2026:

| API route | Uncached input | Cached input | Output |
|---|---:|---:|---:|
| GPT-6 Astra, standard | $10.00 | $1.00 | $50.00 |
| DeepSeek-V4.1-Flash, peak | $0.30 | $0.006 | $1.20 |
| DeepSeek-V4.1-Flash, off-peak | $0.15 | $0.003 | $0.60 |

Sources: [OpenAI](https://developers.openai.com/api/docs/models/gpt-6-astra)
and [DeepSeek](https://api-docs.deepseek.com/quick_start/pricing/).
DeepSeek peak hours are Monday–Friday, 01:00–04:00 and 06:00–10:00 UTC;
all other hours are off-peak. Recheck prices before using these estimates.

The examples use uncached text input, standard Astra API rates, and total billed
output including reasoning. Each assumed Astra request stays at or below 272K
input tokens. Longer requests have different rates. Explicit cache writes,
Batch/Flex/Fast pricing, tool charges, taxes, and infrastructure are excluded.

```text
API cost = (uncached input × input rate
          + cached input × cache-hit rate
          + billed output × output rate) / 1,000,000
```

For 50,000 uncached input tokens and 10,000 billed output tokens:

- Astra API: `(50,000 × 10 + 10,000 × 50) / 1,000,000 = $1.00`.
- DeepSeek peak: `(50,000 × 0.30 + 10,000 × 1.20) / 1,000,000 = $0.027`.
- Same-token worker price reduction: `1 − 0.027 / 1.00 = 97.3%`.

The off-peak comparison is $0.0135, or 98.65% lower. These percentages describe
the assumed traffic, not equivalent work completed or a user's total savings.

## What you actually pay with this mod

The lead and reviewer use `openai-codex` through a ChatGPT subscription. The
Astra API prices above are a comparison baseline; they are not how this route
is billed. Workers incur separate DeepSeek API charges.

```text
Monthly spend = ChatGPT subscription
              + any separately billed Codex usage
              + DeepSeek worker API usage
              + any paid tools or infrastructure
```

If you already have a subscription and stay within its included usage, the
additional model expense is the DeepSeek worker traffic. There is no claim that
offloading lowers the fixed subscription fee or increases usage limits by a
particular percentage. Compared with doing everything within an existing
subscription, adding paid workers can increase cash spending.

## Whole-workload comparison at API list prices

To include the lead, reviewer, and coordination, assume a workload totaling
**1M input + 200K output tokens across multiple requests**. Pricing every token
on Astra gives a **$20.00** reference cost.

For each scenario below:

- Move the stated fraction of both input and output to DeepSeek.
- Leave the remaining traffic on Astra, including the lead and reviewer.
- Add another **10% of the baseline input and output on Astra** for extra
  coordination. This overhead is a chosen assumption, not a measurement.
- Assume equal token counts for the transferred work, uncached input, DeepSeek
  peak pricing, no retries, and no change in task quality. Actual runs can differ.

| Assumed work traffic moved to DeepSeek | All-Astra reference | Hybrid API valuation | Calculated reduction |
|---|---:|---:|---:|
| 50% | $20.00 | $12.270 | 38.65% |
| 70% | $20.00 | $8.378 | 58.11% |
| 85% | $20.00 | $5.459 | 72.71% |

For the 70% example, Astra handles 40% of baseline traffic including the extra
10% overhead: `$20 × 0.40 = $8`. DeepSeek handles 70%:
`(700,000 × 0.30 + 140,000 × 1.20) / 1,000,000 = $0.378`.
The total valuation is **$8.378**. This is not a predicted subscription bill.

At these assumptions, each extra 10% of baseline traffic spent on Astra adds
$2 to the valuation. Moving the lead from medium to xhigh and review from low
to high can change reasoning-token use and elapsed time; no fixed multiplier
has been measured. Retries, repeated context, and weak worker results can reduce
or eliminate savings.

## Scheduling projections

Parallel workers can shorten independent execution stages, but planning,
integration, and final review remain sequential. This simple scheduling model
shows the tradeoff without inventing model throughput measurements:

```text
relative time = (1 − parallel fraction)
              + parallel fraction / workers
              + coordination overhead
speedup = 1 / relative time
```

All fractions are relative to a single-worker baseline. Assume equally sized
independent pieces, equal worker speed to the baseline, enough capacity for
simultaneous requests, and no retries. The sequential portion includes lead
reasoning and review. Extra overhead includes handoffs and integration.
The reviewer runs after the worker stage, within the three-child planning budget.

| Hypothetical workload | Parallel fraction | Workers | Extra overhead | Time vs baseline | Calculated speedup |
|---|---:|---:|---:|---:|---:|
| Mostly coupled changes | 30% | 2 | 25% | 110% | 0.91× (slower) |
| Partly independent pieces | 50% | 2 | 15% | 90% | 1.11× |
| Mostly independent pieces | 75% | 3 | 10% | 60% | 1.67× |

These are scheduling examples, not Astra-versus-DeepSeek inference benchmarks.
They do not predict that this preset will achieve those gains. Small tasks may
finish sooner with the lead alone. No success-rate, correctness, or benchmark
score prediction is published because this project has no measured baseline.

## Turn the estimates into benchmarks

Use the [manual evaluation guide](orchestration-playbook.md#manual-ab-rollout-checks)
on representative bugs, features, and research tasks. Preserve identical starting
workspaces and acceptance criteria; repeat runs and include failures.

Record the model and reasoning settings, elapsed time, input/cache/output tokens
for every role, worker retries, total charges, and whether the original task
actually passed. Keep actual subscription/API charges separate from API list-price
valuations. Compare cost per successful task and median runtime, and show sample
size and variation. Publish results only after those runs exist.
