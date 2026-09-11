#!/usr/bin/env node
/**
 * Offline acceptance for `preset/agent.cordis.yml` and the installer copy path.
 *
 * Everything here runs against the installed harness libraries with no live
 * host, no credentials, no network, and no writes to `$DSH_HOME`:
 *
 *   1. the composition is parsed with the loader's own YAML dialect
 *      (`@deepseek-ai/cordis-plugin-include` `entryListSchema`, the one that
 *      carries `!!js`), so a file the loader would reject fails here too
 *   2. every delegation role row is checked against the published contract
 *      (route pin, tool filter, depth cap, bounded persona) through the real
 *      `@deepseek-ai/dsh-tool-subagent` `Config` schema
 *   3. the filters are fed to the REAL tools registry
 *      (`@deepseek-ai/dsh-tools` `ToolRuntime`): a scoped child loses exactly
 *      the denied names, keeps exactly the allowed ones, leaves its parent
 *      untouched, and keeps what its own scope registers
 *   4. the depth cap is enforced by the real policy (`resolveChildDepth`)
 *   5. the installer copy path runs against a throwaway `DSH_HOME` and the
 *      installed preset/skill are compared byte for byte with the sources,
 *      then statically discovered by `@deepseek-ai/dsh-agent-presets`
 *      `scanRoot`, which parses the composition and resolves every enabled
 *      plugin specifier; it does NOT evaluate `!!js` gates, mount a plugin,
 *      or create a child agent
 *
 * The harness libraries are resolved from the running `dsh` install. A
 * non-empty `ASTRA_ORCHESTRATOR_DSH_ROOT` overrides that root and is
 * AUTHORITATIVE: when it does not name a complete harness package root this
 * test exits 2 without consulting the installed `dsh` or the global npm root,
 * so an override can never silently validate a different harness version.
 * Discovery subprocesses and the installer run carry finite timeouts.
 *
 *   node scripts/test-preset-composition.mjs
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const MOD_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const INSTALLER = path.join(MOD_DIR, 'install.mjs')
const COMPOSITION = path.join(MOD_DIR, 'preset', 'agent.cordis.yml')
const PRESET_ID = 'astra-orchestrator'
const SUBAGENT_PLUGIN = '@deepseek-ai/dsh-tool-subagent'

/** Contract: every enabled delegation role, its route pin, and its filter. */
const ALLOWED_READ_TOOLS = ['read', 'glob', 'grep', 'read_image', 'skill', 'web_search', 'web_fetch', 'send_message']
const DENIED_DELEGATION_TOOLS = ['subagent', 'subagent_explorer', 'subagent_tester', 'subagent_researcher', 'subagent_reviewer', 'subagent_fork', 'workflow', 'ralph']
const FLASH_HIGH = { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' }
const REVIEWER_PIN = { provider: 'openai-codex', model: 'gpt-6-astra', reasoningEffort: 'high' }
const ROLES = [
  { toolName: 'subagent', childProvider: 'spawn', pin: FLASH_HIGH, filter: { deny: DENIED_DELEGATION_TOOLS } },
  { toolName: 'subagent_explorer', childProvider: 'spawn', pin: FLASH_HIGH, filter: { allow: ALLOWED_READ_TOOLS } },
  { toolName: 'subagent_tester', childProvider: 'spawn', pin: FLASH_HIGH, filter: { deny: DENIED_DELEGATION_TOOLS } },
  { toolName: 'subagent_researcher', childProvider: 'spawn', pin: FLASH_HIGH, filter: { allow: ALLOWED_READ_TOOLS } },
  { toolName: 'subagent_reviewer', childProvider: 'spawn', pin: REVIEWER_PIN, filter: { allow: ALLOWED_READ_TOOLS } },
  { toolName: 'subagent_fork', childProvider: 'fork', pin: undefined, filter: { deny: DENIED_DELEGATION_TOOLS } },
]
/** Standard capabilities a restricted role must not be able to reach. */
const STANDARD_TOOLS = ['bash', 'write', 'edit', 'todo_write', 'ask_user_question', 'present']

let failures = 0
function check(label, condition, detail = '') {
  if (condition) {
    process.stdout.write(`  ok   ${label}\n`)
    return true
  }
  failures += 1
  process.stdout.write(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}\n`)
  return false
}

// ─── harness library resolution ─────────────────────────────────────────────

/** Finite ceilings so a wedged discovery command can never hang the suite. */
const WHICH_TIMEOUT_MS = 5000
const NPM_ROOT_TIMEOUT_MS = 10000
const INSTALL_TIMEOUT_MS = 120000

const DSH_TOOLS_PROBE = path.join('node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js')
const completeHarnessRoot = root => existsSync(path.join(root, DSH_TOOLS_PROBE))
const explicitRoot = process.env.ASTRA_ORCHESTRATOR_DSH_ROOT !== undefined && process.env.ASTRA_ORCHESTRATOR_DSH_ROOT !== ''
  ? path.resolve(process.env.ASTRA_ORCHESTRATOR_DSH_ROOT)
  : undefined

function discoveredRoots() {
  const roots = []
  const bin = spawnSync('which', ['dsh'], { encoding: 'utf8', timeout: WHICH_TIMEOUT_MS })
  if (bin.status === 0 && bin.stdout.trim() !== '') roots.push(path.dirname(path.dirname(bin.stdout.trim())))
  const globalRoot = spawnSync('npm', ['root', '-g'], { encoding: 'utf8', timeout: NPM_ROOT_TIMEOUT_MS })
  if (globalRoot.status === 0 && globalRoot.stdout.trim() !== '') {
    roots.push(path.join(globalRoot.stdout.trim(), '@deepseek-ai', 'dsh'))
  }
  roots.push(path.join(MOD_DIR, 'node_modules', '@deepseek-ai', 'dsh'))
  return [...new Set(roots)]
}

/**
 * A non-empty ASTRA_ORCHESTRATOR_DSH_ROOT is AUTHORITATIVE: it is the root
 * this run validates against and there is no fallback to the installed `dsh`
 * or the global npm root. Falling back would silently validate a different
 * harness than the caller named, which is exactly the false confidence the
 * override exists to prevent.
 */
function resolveDshRoot() {
  if (explicitRoot !== undefined) return completeHarnessRoot(explicitRoot) ? explicitRoot : undefined
  return discoveredRoots().find(completeHarnessRoot)
}

const DSH_ROOT = resolveDshRoot()
if (DSH_ROOT === undefined) {
  if (explicitRoot !== undefined) {
    process.stderr.write(
      `test-preset-composition: ASTRA_ORCHESTRATOR_DSH_ROOT=${explicitRoot} is not a complete harness package root.\n` +
      `  expected ${path.join(explicitRoot, DSH_TOOLS_PROBE)}\n` +
      '  the explicit override is authoritative — no fallback to the installed `dsh` or the global npm root.\n' +
      '  fix or unset ASTRA_ORCHESTRATOR_DSH_ROOT.\n',
    )
  } else {
    process.stderr.write(
      'test-preset-composition: no harness package root found — this test needs the installed DSH libraries.\n' +
      `  looked for ${DSH_TOOLS_PROBE} under:\n${discoveredRoots().map(root => `    ${root}`).join('\n')}\n` +
      '  install the harness, or set ASTRA_ORCHESTRATOR_DSH_ROOT to its package root.\n',
    )
  }
  process.exit(2)
}

const pkgFile = (name, file = 'lib/index.js') => path.join(DSH_ROOT, 'node_modules', '@deepseek-ai', name, file)

async function loadLibraries() {
  const wanted = [
    ['@deepseek-ai/cordis', pkgFile('cordis'), 'Context'],
    ['@deepseek-ai/dsh-system-prompt', pkgFile('dsh-system-prompt'), 'default'],
    ['@deepseek-ai/dsh-tools', pkgFile('dsh-tools'), 'ToolRuntime'],
    ['@deepseek-ai/dsh-scope', pkgFile('dsh-scope'), 'createScope'],
    ['@deepseek-ai/dsh-subagent', pkgFile('dsh-subagent'), 'resolveChildDepth'],
    ['@deepseek-ai/dsh-tool-subagent', pkgFile('dsh-tool-subagent'), 'Config'],
    ['@deepseek-ai/dsh-agent-presets', pkgFile('dsh-agent-presets'), 'scanRoot'],
    ['@deepseek-ai/cordis-plugin-include', pkgFile('cordis-plugin-include'), 'entryListSchema'],
    ['js-yaml', path.join(DSH_ROOT, 'node_modules', 'js-yaml', 'index.js'), 'default'],
  ]
  const missing = wanted.filter(([, file]) => !existsSync(file))
  if (missing.length > 0) {
    process.stderr.write(
      `test-preset-composition: harness root ${DSH_ROOT} is incomplete — missing:\n` +
      `${missing.map(([name, file]) => `    ${name} (${file})`).join('\n')}\n` +
      (explicitRoot !== undefined
        ? '  ASTRA_ORCHESTRATOR_DSH_ROOT is authoritative — no fallback root was tried; fix or unset it.\n'
        : '  set ASTRA_ORCHESTRATOR_DSH_ROOT to a complete harness package root.\n'),
    )
    process.exit(2)
  }
  const imported = {}
  for (const [name, file] of wanted) imported[name] = await import(pathToFileURL(file).href)
  return {
    Context: imported['@deepseek-ai/cordis'].Context,
    SystemPrompt: imported['@deepseek-ai/dsh-system-prompt'].default,
    tools: imported['@deepseek-ai/dsh-tools'],
    scope: imported['@deepseek-ai/dsh-scope'],
    subagent: imported['@deepseek-ai/dsh-subagent'],
    subagentConfig: imported['@deepseek-ai/dsh-tool-subagent'].Config,
    presets: imported['@deepseek-ai/dsh-agent-presets'],
    entryListSchema: imported['@deepseek-ai/cordis-plugin-include'].entryListSchema,
    yaml: imported['js-yaml'].default,
  }
}

const lib = await loadLibraries()
const tick = () => new Promise(resolve => setTimeout(resolve, 20))

// ─── 1. composition parsed with the loader's dialect ────────────────────────

process.stdout.write('composition parses with entryListSchema\n')
let rows = []
let parsedRows = []
try {
  rows = lib.yaml.load(readFileSync(COMPOSITION, 'utf8'), { schema: lib.entryListSchema })
  check('agent.cordis.yml parses', Array.isArray(rows) && rows.length > 0)
} catch (error) {
  check('agent.cordis.yml parses', false, error instanceof Error ? error.message.split('\n')[0] : String(error))
}
function walk(list, output = []) {
  for (const row of list ?? []) {
    if (row !== null && typeof row === 'object') {
      if (typeof row.id === 'string') output.push(row)
      if (Array.isArray(row.config)) walk(row.config, output)
    }
  }
  return output
}
parsedRows = walk(rows)
const enabled = row => row.disabled === undefined || row.disabled === false
const subagentRows = parsedRows.filter(row => row.name === SUBAGENT_PLUGIN)
const enabledSubagentRows = subagentRows.filter(enabled)
const roleRow = toolName => enabledSubagentRows.find(row => row.config?.toolName === toolName)
check('exactly six enabled delegation rows', enabledSubagentRows.length === 6, `found ${enabledSubagentRows.length}`)
check('six distinct role tools', new Set(enabledSubagentRows.map(row => row.config?.toolName)).size === enabledSubagentRows.length)
check('disabled provider rows stay disabled', subagentRows.filter(row => !enabled(row)).every(row => row.disabled === true))
check('no enabled row names a disabled provider', parsedRows.filter(enabled).every(row => !['codex', 'claude-code'].includes(row.config?.provider ?? row.config?.subagentProvider)))
check('no enabled row exposes a disabled provider tool', parsedRows.filter(enabled).every(row => !['subagent_codex', 'subagent_claude_code'].includes(row.config?.toolName)))

// ─── 2. role contract ───────────────────────────────────────────────────────

process.stdout.write('role contract\n')
const CONFIG_KEYS = new Set(Object.keys(lib.subagentConfig.dict))
const TOOL_FILTER_KEYS = new Set(Object.keys(lib.subagentConfig.dict.toolFilter.dict))
const personas = new Map()

for (const role of ROLES) {
  const row = roleRow(role.toolName)
  if (!check(`${role.toolName} row present`, row !== undefined)) continue
  const config = row.config

  check(`${role.toolName} child provider`, config.provider === role.childProvider, String(config.provider))
  check(`${role.toolName} runs continuable`, config.backgroundMode === 'continuable', String(config.backgroundMode))
  check(`${role.toolName} maxDepth is 1`, config.maxDepth === 1, String(config.maxDepth))
  check(`${role.toolName} model selection disabled`, config.modelSelectionSettings === undefined || config.modelSelectionSettings === false)

  if (role.pin === undefined) {
    check(`${role.toolName} inherits the parent route`, config.agentOptions === undefined, JSON.stringify(config.agentOptions))
  } else {
    const pin = config.agentOptions ?? {}
    check(`${role.toolName} route pin`, Object.entries(role.pin).every(([key, value]) => pin[key] === value), JSON.stringify(pin))
  }

  const filter = config.toolFilter
  const keys = filter === undefined ? [] : Object.keys(filter).sort()
  check(`${role.toolName} filter names exactly one side`, JSON.stringify(keys) === JSON.stringify(Object.keys(role.filter).sort()), JSON.stringify(keys))
  const side = role.filter.allow !== undefined ? 'allow' : 'deny'
  const observed = filter !== undefined && Array.isArray(filter[side]) ? filter[side] : []
  check(`${role.toolName} ${side} list matches the contract`, [...observed].sort().join(',') === [...role.filter[side]].sort().join(','), JSON.stringify(observed))

  const persona = config.persona
  const bounded = typeof persona === 'string' && persona.trim().length >= 100 && persona.length <= 4096
  check(`${role.toolName} persona present and bounded`, bounded, typeof persona === 'string' ? `${persona.length} chars` : String(persona))
  if (bounded) personas.set(role.toolName, persona.trim())

  check(`${role.toolName} config has no unknown fields`, Object.keys(config).every(key => CONFIG_KEYS.has(key)), Object.keys(config).filter(key => !CONFIG_KEYS.has(key)).join(','))
  if (filter !== undefined) {
    check(`${role.toolName} toolFilter has no unknown fields`, Object.keys(filter).every(key => TOOL_FILTER_KEYS.has(key)), Object.keys(filter).filter(key => !TOOL_FILTER_KEYS.has(key)).join(','))
  }
}
check('personas are distinct across roles', new Set(personas.values()).size === personas.size, `${personas.size} personas, ${new Set(personas.values()).size} distinct`)

const allowedNames = new Set(ALLOWED_READ_TOOLS)
check('allowed and denied sets are disjoint', DENIED_DELEGATION_TOOLS.every(name => !allowedNames.has(name)))
check('allowed set contains no shell, mutation, or delegation tool', ALLOWED_READ_TOOLS.every(name => name !== 'bash' && name !== 'write' && name !== 'edit' && !name.startsWith('subagent')))

const rootToolRow = id => enabled(parsedRows.find(row => row.id === id) ?? { disabled: true })
check('root keeps the workflow path', rootToolRow('tool-workflow') && rootToolRow('workflow-worker-thread'))
check('root keeps the ralph path', rootToolRow('tool-ralph') && parsedRows.find(row => row.id === 'tool-ralph')?.config?.maxRounds === 64)
check('delegation group still isolates the workflow engine', parsedRows.find(row => row.id === 'delegation')?.isolate?.workflowEngine === true)

// ─── 3. runtime Config validation ───────────────────────────────────────────

process.stdout.write('runtime Config validation\n')
for (const role of ROLES) {
  const row = roleRow(role.toolName)
  if (row === undefined) continue
  try {
    const normalized = lib.subagentConfig(row.config)
    check(`${role.toolName} Config accepts the row`, normalized.toolName === role.toolName && normalized.maxDepth === 1 && normalized.modelSelectionSettings === false && normalized.backgroundMode === 'continuable', JSON.stringify({ toolName: normalized.toolName, maxDepth: normalized.maxDepth, modelSelectionSelection: normalized.modelSelectionSettings, backgroundMode: normalized.backgroundMode }))
    if (role.pin !== undefined) {
      check(`${role.toolName} Config keeps the route pin`, Object.entries(role.pin).every(([key, value]) => normalized.agentOptions?.[key] === value), JSON.stringify(normalized.agentOptions))
    } else {
      check(`${role.toolName} Config keeps the inherited route`, normalized.agentOptions === undefined, JSON.stringify(normalized.agentOptions))
    }
  } catch (error) {
    check(`${role.toolName} Config accepts the row`, false, error instanceof Error ? error.message.split('\n')[0] : String(error))
  }
}
try {
  lib.subagentConfig({ provider: 'spawn', toolName: 'subagent', backgroundMode: 'not-a-mode' })
  check('Config rejects an invalid backgroundMode', false, 'accepted')
} catch {
  check('Config rejects an invalid backgroundMode', true)
}

// ─── 4. real tools registry, scoped restriction ─────────────────────────────

process.stdout.write('real tools registry restriction\n')
const ctx = new lib.Context()
await ctx.plugin(lib.SystemPrompt)
await ctx.plugin(lib.tools.default)
await tick()

const stubTool = name => lib.tools.defineTool({
  name,
  description: `offline stub for ${name}`,
  parameters: {},
  output: { schema: { type: 'string' }, render: () => name },
  execute: async () => name,
})
const catalog = [...new Set([...ALLOWED_READ_TOOLS, ...DENIED_DELEGATION_TOOLS, ...STANDARD_TOOLS])]
for (const name of catalog) ctx.tools.register(stubTool(name))
const visibleNames = scope => new Set([...ctx.tools.view(scope).visible.keys()])
check('stub catalog registered in the real registry', visibleNames(undefined).size === catalog.length, `${visibleNames(undefined).size}/${catalog.length}`)

const parentKey = { role: 'parent-agent' }
const parent = lib.scope.createScope(ctx, parentKey)
const parentNames = visibleNames(lib.scope.scopeOf(parent.ctx))

for (const role of ROLES) {
  const kind = role.filter.allow !== undefined ? 'allow' : 'deny'
  // The registry proof runs the SHIPPED filter, so a drifted composition fails
  // here too; the expectations stay the contract's, so a drifted filter cannot
  // satisfy the checks by agreeing with itself.
  const shippedFilter = roleRow(role.toolName)?.config?.toolFilter ?? role.filter
  const childKey = { role: `${role.toolName}-child` }
  const child = lib.scope.createScope(ctx, childKey, { parent: parentKey })
  child.ctx.inject(['tools'], scoped => { scoped.tools.restrict(shippedFilter) })
  await tick()
  const names = visibleNames(lib.scope.scopeOf(child.ctx))
  const catalogNames = ctx.tools.schemas(lib.scope.scopeOf(child.ctx)).map(schema => schema.name).sort()
  if (kind === 'deny') {
    check(`${role.toolName} child loses every denied name`, DENIED_DELEGATION_TOOLS.every(name => !names.has(name)), DENIED_DELEGATION_TOOLS.filter(name => names.has(name)).join(','))
    check(`${role.toolName} child keeps the unrestricted standard surface`, STANDARD_TOOLS.every(name => names.has(name)))
    check(`${role.toolName} child denies the delegation boundary at execution resolve`, DENIED_DELEGATION_TOOLS.every(name => ctx.tools.resolveExecution(name, lib.scope.scopeOf(child.ctx), false) === undefined))
  } else {
    check(`${role.toolName} child keeps exactly the allowlist`, ALLOWED_READ_TOOLS.every(name => names.has(name)) && [...names].every(name => ALLOWED_READ_TOOLS.includes(name)), JSON.stringify([...names].sort()))
    check(`${role.toolName} model-facing schema projection is the allowlist`, JSON.stringify(catalogNames) === JSON.stringify([...ALLOWED_READ_TOOLS].sort()), JSON.stringify(catalogNames))
    check(`${role.toolName} child loses shell, mutation, and delegation`, STANDARD_TOOLS.concat(['subagent', 'workflow', 'ralph']).every(name => !names.has(name)))
    check(`${role.toolName} child cannot resolve a denied tool through get()`, STANDARD_TOOLS.concat(['subagent']).every(name => ctx.tools.get(name, lib.scope.scopeOf(child.ctx)) === undefined))
    check(`${role.toolName} denied calls are rejected at execution resolve`, STANDARD_TOOLS.concat(['subagent', 'workflow', 'ralph']).every(name => ctx.tools.resolveExecution(name, lib.scope.scopeOf(child.ctx), false) === undefined))
    check(`${role.toolName} allowed calls still resolve at execution`, ALLOWED_READ_TOOLS.every(name => ctx.tools.resolveExecution(name, lib.scope.scopeOf(child.ctx), false) !== undefined))
  }
}

const explorer = roleRow('subagent_explorer')
if (explorer !== undefined) {
  const ownKey = { role: 'own-layer-child' }
  const own = lib.scope.createScope(ctx, ownKey, { parent: parentKey })
  own.ctx.inject(['tools'], scoped => { scoped.tools.restrict(explorer.config.toolFilter) })
  await tick()
  let registered = false
  own.ctx.inject(['tools'], scoped => { scoped.tools.register(stubTool('structured_output')); registered = true })
  await tick()
  check('scope-local registration survives the filter (exemption)', registered && visibleNames(lib.scope.scopeOf(own.ctx)).has('structured_output'))
}
check('parent surface is unaffected by child restrictions', [...parentNames].sort().join(',') === [...visibleNames(lib.scope.scopeOf(parent.ctx))].sort().join(','))
try {
  ctx.tools.restrict({ deny: ['read'] })
  check('an unscoped restriction is rejected', false, 'accepted')
} catch {
  check('an unscoped restriction is rejected', true)
}
let unknownNameRejected = false
let unknownNameMessage = ''
lib.scope.createScope(ctx, { role: 'unknown-name-child' }, { parent: parentKey }).ctx.inject(['tools'], scoped => {
  try {
    scoped.tools.restrict({ deny: [...DENIED_DELEGATION_TOOLS, 'not_a_registered_tool'] })
  } catch (error) {
    unknownNameRejected = true
    unknownNameMessage = error instanceof Error ? error.message : String(error)
  }
})
await tick()
check('a filter naming an unregistered tool is rejected', unknownNameRejected, unknownNameMessage)
let emptyFilterRejected = false
lib.scope.createScope(ctx, { role: 'empty-filter-child' }, { parent: parentKey }).ctx.inject(['tools'], scoped => {
  try {
    scoped.tools.restrict({})
  } catch {
    emptyFilterRejected = true
  }
})
await tick()
check('an empty filter is rejected', emptyFilterRejected)

// ─── 5. real depth policy ───────────────────────────────────────────────────

process.stdout.write('depth policy\n')
const parentStub = depth => ({ options: {}, session: { header: depth === 0 ? {} : { delegationDepth: depth } } })
try {
  const childDepth = lib.subagent.resolveChildDepth(parentStub(0), 1)
  check('a top-level parent may create a depth-1 child', childDepth === 1, String(childDepth))
} catch (error) {
  check('a top-level parent may create a depth-1 child', false, String(error))
}
try {
  lib.subagent.resolveChildDepth(parentStub(1), 1)
  check('a depth-1 child may not delegate further', false, 'accepted')
} catch (error) {
  check('a depth-1 child may not delegate further', error instanceof lib.subagent.SubagentDepthError && error.maxDepth === 1, String(error))
}

// ─── 6. temp DSH_HOME install copy acceptance ───────────────────────────────

process.stdout.write('temp DSH_HOME install copy\n')
function hashFile(file) {
  return existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : '(absent)'
}
function listFiles(dir, prefix = '', output = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) listFiles(path.join(dir, entry.name), rel, output)
    else output.push(rel)
  }
  return output
}
/**
 * Fingerprint one directory tree: its sorted file list plus each file's
 * content hash. `(absent)` stands for a path that is not there, so an absent
 * real preset and an untouched one are both stable across the run.
 */
function treeFingerprint(dir) {
  if (!existsSync(dir)) return '(absent)'
  return listFiles(dir).map(rel => `${rel}:${hashFile(path.join(dir, rel))}`).join('\n')
}
const realHome = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : path.join(os.homedir(), '.dsh')
const realSettingsHash = hashFile(path.join(realHome, 'settings.yaml'))
const realSkillHash = hashFile(path.join(realHome, 'skills', PRESET_ID, 'SKILL.md'))
const realPresetDir = path.join(realHome, '.agent-presets', PRESET_ID)
const realPresetBefore = treeFingerprint(realPresetDir)
const home = mkdtempSync(path.join(os.tmpdir(), 'astra-composition-test-'))
try {
  writeFileSync(path.join(home, 'settings.yaml'), 'ui-theme:\n  preference: dark\n')
  const run = spawnSync(process.execPath, [INSTALLER, '--yes'], { encoding: 'utf8', env: { ...process.env, DSH_HOME: home }, timeout: INSTALL_TIMEOUT_MS })
  const runDetail = run.error !== undefined
    ? `${run.error.message}`
    : run.signal !== null
      ? `terminated by ${run.signal} after ${INSTALL_TIMEOUT_MS}ms`
      : `${run.stdout}${run.stderr}`
  check('installer exits 0 with DSH_HOME pointing at the temp home', run.status === 0, runDetail)

  const installedPreset = path.join(home, '.agent-presets', PRESET_ID)
  const installedSkill = path.join(home, 'skills', PRESET_ID)
  check('source preset and installed copy list the same files', JSON.stringify(listFiles(path.join(MOD_DIR, 'preset'))) === JSON.stringify(listFiles(installedPreset)), JSON.stringify(listFiles(installedPreset)))
  for (const rel of listFiles(path.join(MOD_DIR, 'preset'))) {
    check(`installed preset/${rel} is byte-identical to source`, hashFile(path.join(installedPreset, rel)) === hashFile(path.join(MOD_DIR, 'preset', rel)))
  }
  for (const rel of listFiles(path.join(MOD_DIR, 'skills', PRESET_ID))) {
    check(`installed skill/${rel} is byte-identical to source`, hashFile(path.join(installedSkill, rel)) === hashFile(path.join(MOD_DIR, 'skills', PRESET_ID, rel)))
  }

  const discovered = await lib.presets.scanRoot({ path: path.join(home, '.agent-presets'), trust: 'user' }, pathToFileURL(`${DSH_ROOT}/`))
  check('installed preset is discovered under its id', discovered.length === 1 && discovered[0].id === PRESET_ID, JSON.stringify(discovered.map(entry => entry.id)))
  check('installed preset statically resolves every enabled plugin specifier', discovered[0]?.broken === undefined, discovered[0]?.broken ?? '')

  check('real $DSH_HOME/settings.yaml untouched', hashFile(path.join(realHome, 'settings.yaml')) === realSettingsHash)
  check('real $DSH_HOME skill untouched', hashFile(path.join(realHome, 'skills', PRESET_ID, 'SKILL.md')) === realSkillHash)
  const realPresetAfter = treeFingerprint(realPresetDir)
  check('real $DSH_HOME installed preset tree untouched', realPresetAfter === realPresetBefore, realPresetAfter === '(absent)' ? 'absent before and after' : realPresetAfter.split('\n')[0])
  process.stdout.write(`  info real installed preset ${realPresetDir}: ${realPresetBefore === '(absent)' ? '(absent)' : `${listFiles(realPresetDir).length} file(s)`}\n`)
  for (const line of realPresetBefore === '(absent)' ? [] : realPresetBefore.split('\n')) process.stdout.write(`  info   ${line}\n`)
} finally {
  rmSync(home, { recursive: true, force: true })
}

process.stdout.write(failures === 0 ? '\nall checks passed\n' : `\n${failures} check(s) failed\n`)
process.exit(failures === 0 ? 0 : 1)
