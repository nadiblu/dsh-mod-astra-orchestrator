// OMP v18.1.16 extension. No imports from private OMP modules or global settings.
// Sources: github.com/can1357/oh-my-pi/tree/v18.1.16/packages/coding-agent/src
// cli/extension-flags.ts: flags are reparsed after extension registration.
// session/model-controls.ts: setModel and setThinkingLevel default to persist=false.
// session/agent-session.ts: abort increments prompt generation synchronously;
// prompt checks that generation after before_agent_start, before inference.
import { readFileSync } from "node:fs";

const ROOT = { provider: "openai-codex", id: "gpt-6-astra" };
const WORKER = { provider: "opencode-go", id: "glm-5.3-flash" };
const MARKER = "<!-- astra-orchestrator:astromode -->";
const RULES_URL = new URL("../skills/astra-orchestrator/SKILL.md", import.meta.url);
const matches = (model, route) => model?.provider === route.provider && model?.id === route.id;

export default function astromode(pi) {
  // Do not inspect argv: task children rebind this factory with fresh flag values.
  // Reading getFlag during registration would see false before CLI's second pass.
  pi.registerFlag("astromode", {
    type: "boolean",
    default: false,
    description: "Astra orchestration with GLM 5.3 Flash max workers (this invocation only)",
  });

  let state = "inactive";
  let owner;
  let rules;
  let failure;
  let epoch = 0;
  const enabled = () => pi.getFlag("astromode") === true;
  const sessionId = (ctx) => ctx.sessionManager.getSessionId();

  function reportFailure(ctx, error) {
    state = "failed";
    // Abort, not throw: OMP catches extension exceptions and otherwise continues.
    // This is deliberately not awaited (abort may wait for the current handler).
    ctx.abort();
    const message = `Astro mode blocked: ${error instanceof Error ? error.message : String(error)}`;
    if (message === failure) return;
    failure = message;
    try {
      if (ctx.hasUI) {
        ctx.ui.setStatus("astromode", "Astro mode: blocked");
        ctx.ui.notify(message, "error");
      } else {
        process.stderr.write(`${message}\n`);
      }
    } catch {
      // A broken display must not bypass the abort already issued above.
    }
  }

  async function activate(_event, ctx) {
    if (!enabled()) return;
    const activation = ++epoch;
    owner = sessionId(ctx);
    state = "activating";
    failure = undefined;
    try {
      const text = readFileSync(RULES_URL, "utf8").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
      if (!text) throw new Error("installed astra-orchestrator skill is empty");
      const available = ctx.models.list();
      const root = available.find((model) => matches(model, ROOT));
      const worker = available.find((model) => matches(model, WORKER));
      if (!root) throw new Error("openai-codex/gpt-6-astra is unavailable; no provider substitution permitted");
      if (!worker) throw new Error("opencode-go/glm-5.3-flash is unavailable");
      if (!root.thinking?.efforts?.includes("xhigh")) {
        throw new Error("Astra must support xhigh for root and review");
      }
      if (!worker.thinking?.efforts?.includes("max")) {
        throw new Error("GLM 5.3 Flash must support max; xhigh/high is not a substitute");
      }
      if (!(await pi.setModel(root))) throw new Error("Astra model activation failed (check Codex authentication)");
      if (activation !== epoch || owner !== sessionId(ctx)) return;
      // Public JS implementation accepts persist; false also matches the default
      // in all v18.1.16 runtime action adapters. Session history is still recorded.
      pi.setThinkingLevel("xhigh", false);
      if (!matches(ctx.models.current(), ROOT) || pi.getThinkingLevel() !== "xhigh") {
        throw new Error("Astra/xhigh was not applied exactly; refusing a silent downgrade");
      }
      rules = `${MARKER}\n${text}`;
      state = "ready";
      if (ctx.hasUI) ctx.ui.setStatus("astromode", "Astro mode: Astra xhigh · GLM Flash max");
    } catch (error) {
      if (activation === epoch) reportFailure(ctx, error);
    }
  }

  function ready(ctx) {
    if (state !== "ready" || owner !== sessionId(ctx)) {
      reportFailure(ctx, failure?.replace(/^Astro mode blocked: /, "") ?? "activation is incomplete; restart or reload the session after fixing the cause");
      return false;
    }
    if (!matches(ctx.models.current(), ROOT) || pi.getThinkingLevel() !== "xhigh") {
      reportFailure(ctx, "root model or effort changed; Astro mode requires Codex Astra/xhigh");
      return false;
    }
    return true;
  }

  // Invocation-scoped, including resumed sessions and in-process root switches.
  // No persisted mode marker: a later launch without --astromode stays inert.
  for (const event of ["session_start", "session_switch", "session_branch", "session_tree"]) {
    pi.on(event, activate);
  }
  pi.on("input", (_event, ctx) => {
    if (!enabled()) return;
    try {
      if (!ready(ctx)) return { handled: true };
    } catch (error) {
      reportFailure(ctx, error);
      return { handled: true };
    }
  });
  pi.on("before_agent_start", (event, ctx) => {
    if (!enabled()) return;
    try {
      if (!ready(ctx)) return;
      if (!Array.isArray(event.systemPrompt)) throw new Error("unsupported OMP systemPrompt contract");
      // Preserve every other extension/parent chunk; replace only our own chunk.
      return { systemPrompt: [...event.systemPrompt.filter((part) => !part.startsWith(MARKER)), rules] };
    } catch (error) {
      reportFailure(ctx, error);
    }
  });
}
