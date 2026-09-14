// OMP v18.1.16 extension. No imports from private OMP modules or global settings.
// Sources: github.com/can1357/oh-my-pi/tree/v18.1.16/packages/coding-agent/src
// cli/extension-flags.ts: flags are reparsed after extension registration.
// session/model-controls.ts: setModel and setThinkingLevel default to persist=false.
// session/agent-session.ts: abort increments prompt generation synchronously;
// prompt checks that generation after before_agent_start, before inference.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ROUTES = {
  root: "openai-codex/gpt-6-astra:xhigh",
  worker: "opencode-go/glm-5.3-flash:max",
  explorer: "opencode-go/glm-5.3-flash:max",
  researcher: "opencode-go/glm-5.3-flash:max",
  tester: "opencode-go/glm-5.3-flash:max",
  reviewer: "openai-codex/gpt-6-astra:xhigh",
};
const ROLE_DEFS = [
  { key: "root", label: "Lead / root", agent: undefined },
  { key: "worker", label: "Implementation worker", agent: "astra-worker" },
  { key: "explorer", label: "Codebase explorer", agent: "astra-explorer" },
  { key: "researcher", label: "Researcher", agent: "astra-researcher" },
  { key: "tester", label: "Test specialist", agent: "astra-tester" },
  { key: "reviewer", label: "Independent reviewer", agent: "astra-reviewer" },
];
const ROLE_KEYS = ROLE_DEFS.map(({ key }) => key);
const MARKER = "<!-- astra-orchestrator:astromode -->";
const RULES_URL = new URL("../skills/astra-orchestrator/SKILL.md", import.meta.url);
const matches = (model, route) => model?.provider === route.provider && model?.id === route.id;
const effortNames = (model) => Array.isArray(model?.thinking)
  ? model.thinking
  : Array.isArray(model?.thinking?.efforts) ? model.thinking.efforts : [];
const selector = (model, effort) => `${model.provider}/${model.id}:${effort}`;
const isSetupCommand = (text) => /^\/astromode-setup(?:\s|$)/.test(text?.trim() ?? "");

function configPath() {
  const agentDir = process.env.PI_CODING_AGENT_DIR
    || dirname(dirname(fileURLToPath(import.meta.url)));
  return join(agentDir, "config.yml");
}

function yamlScalar(value) {
  const text = value.trim();
  if (text.startsWith('"')) {
    try { return JSON.parse(text); } catch { return undefined; }
  }
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replace(/''/g, "'");
  return text || undefined;
}

function configuredRoutes() {
  const routes = { ...DEFAULT_ROUTES };
  let text;
  try { text = readFileSync(configPath(), "utf8"); } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return routes;
  }
  for (const key of ROLE_KEYS) {
    const match = text.match(new RegExp(`^  astromode_${key}:\\s*(.+?)\\s*$`, "m"));
    const value = match && yamlScalar(match[1]);
    if (value) routes[key] = value;
  }
  return routes;
}

function headerLine(key, indent) {
  return `${" ".repeat(indent)}${key.trim().replace(/:$/, "")}:`;
}

function headerIndex(lines, key, indent, start = 0, end = lines.length) {
  const prefix = " ".repeat(indent);
  const name = key.trim().replace(/:$/, "");
  for (let index = start; index < end; index += 1) {
    if (lines[index] === `${prefix}${name}:`) return index;
  }
  return -1;
}

function blockEnd(lines, start, indent, limit = lines.length) {
  for (let index = start + 1; index < limit; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const leading = line.match(/^ */)[0].length;
    if (leading <= indent) return index;
  }
  return limit;
}

function blockOnlyManaged(lines, start, end, { child, managed }) {
  const childHeader = child && headerLine(child, 2);
  for (let index = start + 1; index < end; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (childHeader && line === childHeader) continue;
    if (managed.test(line)) continue;
    return false;
  }
  return true;
}

function upsertMap(lines, { parent, child, entries, managed }) {
  let parentIndex = headerIndex(lines, parent, 0);
  if (parentIndex >= 0) {
    for (let index = lines.length - 1; index > parentIndex; index -= 1) {
      if (lines[index] !== headerLine(parent, 0)) continue;
      const end = blockEnd(lines, index, 0);
      if (blockOnlyManaged(lines, index, end, { child, managed })) lines.splice(index, end - index);
    }
    parentIndex = headerIndex(lines, parent, 0);
  }
  if (parentIndex < 0) {
    lines.push(headerLine(parent, 0));
    parentIndex = lines.length - 1;
  }
  const parentEnd = blockEnd(lines, parentIndex, 0);
  let mapIndex = parentIndex;
  let entryIndent = 2;
  if (child) {
    mapIndex = headerIndex(lines, child, 2, parentIndex + 1, parentEnd);
    if (mapIndex < 0) {
      lines.splice(parentIndex + 1, 0, headerLine(child, 2));
      mapIndex = parentIndex + 1;
    }
    entryIndent = 4;
  }
  const mapEnd = blockEnd(lines, mapIndex, child ? 2 : 0);
  for (let index = mapEnd - 1; index > mapIndex; index -= 1) {
    if (managed.test(lines[index])) lines.splice(index, 1);
  }
  lines.splice(mapIndex + 1, 0, ...entries.map((entry) => `${" ".repeat(entryIndent)}${entry}`));
}

function saveRoutes(routes) {
  const path = configPath();
  const agentDir = join(path, "..");
  let original = "";
  try { original = readFileSync(path, "utf8"); } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const lines = original.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  const roleEntries = ROLE_KEYS.map((key) => `astromode_${key}: ${JSON.stringify(routes[key])}`);
  const overrideEntries = ROLE_DEFS.filter(({ agent }) => agent)
    .map(({ agent, key }) => `${agent}: "@astromode_${key}"`);
  upsertMap(lines, {
    parent: "modelRoles:",
    entries: roleEntries,
    managed: /^  astromode_(root|worker|explorer|researcher|tester|reviewer):\s/,
  });
  upsertMap(lines, {
    parent: "task:",
    child: "  agentModelOverrides:",
    entries: overrideEntries,
    managed: /^    astra-(worker|explorer|researcher|tester|reviewer):\s/,
  });
  const updated = `${lines.join("\n")}\n`;
  if (updated === original) return;
  mkdirSync(agentDir, { recursive: true });
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
  const temporary = join(agentDir, `.config.yml.astromode-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, updated, { mode });
    renameSync(temporary, path);
  } catch (error) {
    throw error;
  }
}

function parseRoute(value) {
  const match = String(value).match(/^(.+?):(minimal|low|medium|high|xhigh|max)$/);
  if (!match) throw new Error(`invalid Astromode selector ${JSON.stringify(value)}`);
  const slash = match[1].lastIndexOf("/");
  if (slash < 1 || slash === match[1].length - 1) throw new Error(`invalid Astromode selector ${JSON.stringify(value)}`);
  return { provider: match[1].slice(0, slash), id: match[1].slice(slash + 1), effort: match[2] };
}

function routeForModel(route, available, role) {
  const parsed = parseRoute(route);
  const model = available.find((candidate) => matches(candidate, parsed));
  if (!model) throw new Error(`${role} route ${parsed.provider}/${parsed.id} is unavailable`);
  if (!effortNames(model).includes(parsed.effort)) {
    throw new Error(`${role} route ${route} is unavailable at its configured effort`);
  }
  return { model, effort: parsed.effort, selector: route };
}

function modelBase(model) {
  return `${model.provider}/${model.id}`;
}

async function setupWizard(ctx) {
  if (!ctx.hasUI || typeof ctx.ui?.select !== "function" || typeof ctx.ui?.confirm !== "function") {
    ctx.ui?.notify?.("Astromode setup needs an interactive OMP session", "warning");
    return;
  }
  const available = ctx.models.list().filter((model) => modelBase(model) && effortNames(model).length > 0);
  if (available.length === 0) throw new Error("OMP did not expose any models with selectable thinking levels");
  const routes = configuredRoutes();
  const selected = {};
  const modelByBase = new Map(available.map((model) => [modelBase(model), model]));
  for (const role of ROLE_DEFS) {
    let current;
    try { current = parseRoute(routes[role.key]); }
    catch { current = parseRoute(DEFAULT_ROUTES[role.key]); }
    const currentBase = `${current.provider}/${current.id}`;
    const choices = [...modelByBase.values()]
      .sort((a, b) => {
        const aPreferred = modelBase(a) === currentBase ? -1 : 0;
        const bPreferred = modelBase(b) === currentBase ? -1 : 0;
        return aPreferred - bPreferred || modelBase(a).localeCompare(modelBase(b));
      })
      .map((model) => ({
        label: modelBase(model),
        description: `${model.name || model.id} · ${effortNames(model).join("/")}`,
      }));
    const chosenBase = await ctx.ui.select(`Astromode setup · ${role.label}`, choices, {
      initialIndex: Math.max(0, choices.findIndex(({ label }) => label === currentBase)),
      helpText: "Choose the model for this role. Defaults are preselected.",
    });
    if (!chosenBase) return;
    const model = modelByBase.get(chosenBase);
    if (!model) throw new Error(`OMP returned an unknown model choice for ${role.label}`);
    const efforts = effortNames(model);
    const desiredEffort = modelBase(model) === currentBase && efforts.includes(current.effort)
      ? current.effort
      : efforts.at(-1);
    const chosenEffort = await ctx.ui.select(`Astromode setup · ${role.label} effort`, efforts, {
      initialIndex: Math.max(0, efforts.indexOf(desiredEffort)),
      helpText: "Higher levels use more reasoning and may use more quota.",
    });
    if (!chosenEffort) return;
    selected[role.key] = selector(model, chosenEffort);
  }
  const summary = ROLE_DEFS.map(({ key, label }) => `${label}: ${selected[key]}`).join("\n");
  if (!await ctx.ui.confirm("Save Astromode model setup?", summary)) return;
  saveRoutes(selected);
  ctx.ui.notify(`Astromode setup saved to ${configPath()}`, "info");
}

export default function astromode(pi) {
  // Do not inspect argv: task children rebind this factory with fresh flag values.
  // Reading getFlag during registration would see false before CLI's second pass.
  pi.registerFlag("astromode", {
    type: "boolean",
    default: false,
    description: "Configurable Astra orchestration mode (this invocation only)",
  });
  if (typeof pi.registerCommand === "function") {
    pi.registerCommand("astromode-setup", {
      description: "Choose Astromode models and thinking levels for each role",
      handler: async (_args, ctx) => {
        try { await setupWizard(ctx); }
        catch (error) { ctx.ui?.notify?.(`Astromode setup failed: ${error.message}`, "error"); }
      },
    });
  }

  let state = "inactive";
  let owner;
  let rules;
  let failure;
  let activeRoot;
  let activeRootEffort;
  let epoch = 0;
  const enabled = () => pi.getFlag("astromode") === true;
  const sessionId = (ctx) => ctx.sessionManager.getSessionId();

  function reportFailure(ctx, error) {
    state = "failed";
    ctx.abort();
    const message = `Astro mode blocked: ${error instanceof Error ? error.message : String(error)}`;
    if (message === failure) return;
    failure = message;
    try {
      if (ctx.hasUI) {
        ctx.ui.setStatus("astromode", "Astro mode: blocked");
        ctx.ui.notify(message, "error");
      } else process.stderr.write(`${message}\n`);
    } catch { /* a broken display must not bypass the abort */ }
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
      const routes = configuredRoutes();
      const resolved = Object.fromEntries(ROLE_KEYS.map((key) => [key, routeForModel(routes[key], available, key)]));
      if (!(await pi.setModel(resolved.root.model))) throw new Error("Astra model activation failed (check provider authentication)");
      if (activation !== epoch || owner !== sessionId(ctx)) return;
      pi.setThinkingLevel(resolved.root.effort, false);
      activeRoot = resolved.root.model;
      activeRootEffort = resolved.root.effort;
      if (!matches(ctx.models.current(), activeRoot) || pi.getThinkingLevel() !== activeRootEffort) {
        throw new Error("configured Astromode root was not applied exactly; refusing a silent downgrade");
      }
      const routing = ROLE_DEFS.map(({ key, label }) => `- ${label}: ${resolved[key].selector}`).join("\n");
      rules = `${MARKER}\n${text}\n\n## Active Astromode routing\n\nThis invocation uses the saved model setup below; it overrides the bundle defaults above.\n${routing}`;
      state = "ready";
      if (ctx.hasUI) ctx.ui.setStatus("astromode", `Astro mode: ${modelBase(activeRoot)} ${activeRootEffort} · configured roles`);
    } catch (error) {
      if (activation === epoch) reportFailure(ctx, error);
    }
  }

  function ready(ctx) {
    if (state !== "ready" || owner !== sessionId(ctx)) {
      reportFailure(ctx, failure?.replace(/^Astro mode blocked: /, "") ?? "activation is incomplete; restart or reload the session after fixing the cause");
      return false;
    }
    if (!matches(ctx.models.current(), activeRoot) || pi.getThinkingLevel() !== activeRootEffort) {
      reportFailure(ctx, "root model or effort changed; Astromode requires the configured root route");
      return false;
    }
    return true;
  }

  for (const event of ["session_start", "session_switch", "session_branch", "session_tree"]) pi.on(event, activate);
  pi.on("input", (event, ctx) => {
    if (!enabled() || isSetupCommand(event?.text)) return;
    try { if (!ready(ctx)) return { handled: true }; }
    catch (error) { reportFailure(ctx, error); return { handled: true }; }
  });
  pi.on("before_agent_start", (event, ctx) => {
    if (!enabled()) return;
    try {
      if (!ready(ctx)) return;
      if (!Array.isArray(event.systemPrompt)) throw new Error("unsupported OMP systemPrompt contract");
      return { systemPrompt: [...event.systemPrompt.filter((part) => !part.startsWith(MARKER)), rules] };
    } catch (error) { reportFailure(ctx, error); }
  });
}
