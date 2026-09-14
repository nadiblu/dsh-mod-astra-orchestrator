#!/usr/bin/env node
// Inspect the installed bundle and native startup without requesting inference.
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const globalInstall = args.includes("--global");
if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
  console.log("Usage: node scripts/check-omp.mjs [--global] --project DIR\nChecks installed files, effective settings, model catalog, and native astromode startup. No model prompt is sent.");
  process.exit(0);
}
const targetArgs = args.filter(arg => arg !== "--global");
if (targetArgs.length !== 2 || targetArgs[0] !== "--project" || !targetArgs[1].trim() || args.length !== (globalInstall ? 3 : 2)) {
  console.error("Usage: node scripts/check-omp.mjs [--global] --project DIR");
  process.exit(2);
}
const project = resolve(targetArgs[1]);
const installedRoot = globalInstall ? join(homedir(), ".omp", "agent") : join(project, ".omp");
const agents = ["worker", "explorer", "researcher", "tester", "reviewer"].map(role => `astra-${role}`);
const roleKeys = ["root", "worker", "explorer", "researcher", "tester", "reviewer"];
const defaultRoutes = {
  root: "openai-codex/gpt-6-astra:xhigh",
  worker: "opencode-go/glm-5.3-flash:max",
  explorer: "opencode-go/glm-5.3-flash:max",
  researcher: "opencode-go/glm-5.3-flash:max",
  tester: "opencode-go/glm-5.3-flash:max",
  reviewer: "openai-codex/gpt-6-astra:xhigh",
};
const files = ["extensions/astromode.js", "skills/astra-orchestrator/SKILL.md", ...agents.map(name => `agents/${name}.md`)];
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const omp = argv => execFileSync("omp", argv, { cwd: project, encoding: "utf8", timeout: 45000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });

async function startup() {
  return new Promise((resolveState, reject) => {
    const child = spawn("omp", ["--astromode", "--mode", "rpc", "--no-session", "--no-title"], {
      cwd: project, stdio: ["pipe", "pipe", "pipe"],
    });
    let buffer = "", errors = "", result, failure, killTimer;
    const stop = () => {
      child.stdin.end();
      child.kill("SIGTERM");
      killTimer ??= setTimeout(() => child.kill("SIGKILL"), 2000);
    };
    const timer = setTimeout(() => { failure = new Error("Native OMP startup timed out"); stop(); }, 45000);
    child.on("error", error => { failure = error; });
    child.stdin.on("error", () => {});
    child.stderr.on("data", chunk => { errors = (errors + chunk.toString()).slice(-4000); });
    child.stdout.on("data", chunk => {
      buffer += chunk.toString();
      let end;
      while ((end = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (event.type === "response" && event.id === "astromode-readiness") {
          result = event;
          stop();
        }
      }
    });
    child.on("close", () => {
      clearTimeout(timer); clearTimeout(killTimer);
      if (failure) return reject(failure);
      if (!result?.success) return reject(new Error("Native startup failed: " + (result?.error ?? errors ?? "no state response")));
      if (errors.includes("Astro mode blocked:")) return reject(new Error(errors));
      resolveState(result.data);
    });
    child.stdin.write(JSON.stringify({ id: "astromode-readiness", type: "get_state" }) + "\n");
  });
}

try {
  if (globalInstall) {
    assert(!existsSync(join(project, ".omp", "extensions", "astromode.js")), "A project astromode extension conflicts with the global copy; back it up and remove it");
    for (let dir = project; ; dir = dirname(dir)) {
      for (const agent of agents) {
        const local = join(dir, ".omp", "agents", `${agent}.md`);
        if (existsSync(local)) assert(readFileSync(local, "utf8") === readFileSync(join(installedRoot, "agents", `${agent}.md`), "utf8"), `Project agent overrides the global bundle: ${local}`);
      }
      if (dir === dirname(dir)) break;
    }
  }
  for (const file of files) {
    assert(readFileSync(join(installedRoot, file), "utf8") === readFileSync(join(root, "omp", file), "utf8"),
      `Installed file differs from this bundle: ${join(installedRoot, file)}. Back it up and reconcile before reinstalling.`);
  }
  console.log("PASS installed bundle: all seven files match");
  console.log(omp(["--version"]).trim());
  const settings = JSON.parse(omp(["config", "list", "--json"]));
  const value = key => settings[key]?.value;
  const routes = { ...defaultRoutes };
  for (const role of roleKeys) {
    if (value("modelRoles")?.[`astromode_${role}`]) routes[role] = value("modelRoles")[`astromode_${role}`];
  }
  const overrides = value("task.agentModelOverrides") ?? {};
  for (const agent of agents) {
    const role = agent.slice("astra-".length);
    assert(!overrides[agent] || overrides[agent] === `@astromode_${role}`, `task.agentModelOverrides changes ${agent} outside the setup wizard`);
    assert(!value("task.disabledAgents")?.includes(agent), `task.disabledAgents disables ${agent}`);
    assert(!value("task.agentPrewalk")?.[agent] || value("task.agentPrewalk")[agent] === "off", `task.agentPrewalk can switch ${agent}'s model`);
  }
  assert(!value("prewalk.enabled"), "prewalk.enabled can switch the root model; disable it for astromode");
  console.log("PASS effective settings: no conflicting model overrides, disabled roles, or prewalk");
  const { models } = JSON.parse(omp(["models", "--json"]));
  for (const [role, route] of Object.entries(routes)) {
    const match = route.match(/^(.+?):(minimal|low|medium|high|xhigh|max)$/);
    assert(match, `invalid configured Astromode route for ${role}: ${route}`);
    assert(models.some(model => model.selector === match[1] && model.thinking?.includes(match[2])), `${role} route ${route} is unavailable`);
  }
  console.log("PASS catalog: all configured Astromode routes and efforts are available");
  const state = await startup();
  const root = routes.root.match(/^(.+?):(minimal|low|medium|high|xhigh|max)$/);
  const [provider, id] = root[1].split(/\/(.*)/s).slice(0, 2);
  assert(state.model?.provider === provider && state.model?.id === id && state.thinkingLevel === root[2], "Astromode did not activate the configured root exactly");
  assert(!state.isStreaming, "Unexpected model streaming during startup-only check");
  const task = state.dumpTools?.find(tool => tool.name === "task");
  assert(task, "Native task tool is unavailable");
  for (const agent of agents) assert(task.description?.includes(agent), `${agent} is absent from the native task roster`);
  assert(state.dumpTools?.some(tool => tool.name === "hub"), "Native hub tool is unavailable for child continuation");
  console.log("PASS native startup: Astra/xhigh, all five task agents, and hub continuation tool");
  console.log(`Ready to launch from ${project}: omp --astromode`);
  console.log("This check sends no model prompt. Live provider access and task behavior require a live smoke test. Extra CLI config/model flags can change the checked setup.");
} catch (error) {
  console.error(`FAIL ${error.message}`);
  process.exitCode = 1;
}
