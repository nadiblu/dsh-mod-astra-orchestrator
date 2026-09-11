#!/usr/bin/env node
/**
 * dsh-mod-astra-orchestrator installer.
 *
 * Two install modes, both idempotent:
 *
 *   copy (default)  the preset directory is copied into
 *                   `<dshHome>/.agent-presets/astra-orchestrator`, which the
 *                   roster scans as a `user` root with no configuration change,
 *                   and the skill is copied into `<dshHome>/skills/`. Takes
 *                   effect without a CLI restart (settings hot-reload; preset
 *                   roots are re-scanned).
 *
 *   bundle          the package is installed into a profile with
 *                   `dsh plugin --profile <p> add <this dir>`, which reconciles
 *                   `dsh.profile.bundles` from the manifest. The bundle patch
 *                   adds the preset root and registers the `openai-codex`
 *                   (ChatGPT subscription) route. A CLI restart is required.
 *
 * Both modes merge `$DSH_HOME/settings.yaml` surgically: comments and unrelated
 * namespaces are preserved line by line, a timestamped backup is written before
 * the first change, and the result is re-parsed before it is kept.
 *
 * Usage:
 *   astra-orchestrator [install] [options]
 *   astra-orchestrator --uninstall [options]
 *
 * Options:
 *   --profile <name>   profile the bundle is installed into (default: web)
 *   --bundle           use bundle mode instead of copying the preset
 *   --copy             force copy mode (default)
 *   --activate         also point `agent-default-model` at
 *                      openai-codex/gpt-6-astra (run AFTER signing in)
 *   --login            run the ChatGPT (Codex OAuth) sign-in after installing
 *   --method <name>    login method for --login: device (default) or browser
 *   --logout           delete the stored ChatGPT grant and exit
 *   --uninstall        remove what this installer added
 *   --dsh-home <path>  override the harness home (default: $DSH_HOME or ~/.dsh)
 *   --dry-run          print the plan and the settings diff, write nothing
 *   --yes              do not prompt for confirmation
 *   --verify           after writing, run `dsh --profile <p> --dump-config`
 *   --help
 */

import { spawnSync } from 'node:child_process'
import {
  cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync,
} from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const MOD_DIR = path.dirname(fileURLToPath(import.meta.url))
const MOD_NAME = 'astra-orchestrator'
const PKG_NAME = 'dsh-mod-astra-orchestrator'
const PRESET_ID = 'astra-orchestrator'
const SKILL_ID = 'astra-orchestrator'
const ENV_KEY = 'ASTRA_ORCHESTRATOR_PRESETS'
const ORCHESTRATOR = { provider: 'openai-codex', model: 'gpt-6-astra', reasoningEffort: 'medium' }
const ACTIVATED_VALUE = PRESET_ID

// ─── cli ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { mode: 'install', profile: 'web', activate: false, login: false, logout: false, method: 'device', dryRun: false, yes: false, verify: false, dshHome: undefined }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case 'install': opts.mode = 'install'; break
      case '--uninstall': case 'uninstall': opts.mode = 'uninstall'; break
      case '--bundle': opts.mode = 'install'; opts.bundle = true; break
      case '--copy': opts.bundle = false; break
      case '--activate': opts.activate = true; break
      case '--login': opts.login = true; break
      case '--logout': opts.logout = true; break
      case '--method': opts.method = need(argv, ++i, arg); break
      case '--dry-run': opts.dryRun = true; break
      case '--yes': case '-y': opts.yes = true; break
      case '--verify': opts.verify = true; break
      case '--profile': opts.profile = need(argv, ++i, arg); break
      case '--dsh-home': opts.dshHome = need(argv, ++i, arg); break
      case '--help': case '-h': opts.help = true; break
      default: fail(`unknown argument "${arg}" (try --help)`)
    }
  }
  return opts
}

function need(argv, index, flag) {
  const value = argv[index]
  if (value === undefined || value.startsWith('-')) fail(`${flag} needs a value`)
  return value
}

function fail(message) {
  process.stderr.write(`astra-orchestrator: ${message}\n`)
  process.exit(1)
}

function log(line = '') {
  process.stdout.write(`${line}\n`)
}

// ─── yaml (resolved from the running harness, never vendored) ───────────────

function loadYaml() {
  const candidates = []
  const dshBin = which('dsh')
  if (dshBin !== undefined) {
    const pkgRoot = path.dirname(path.dirname(dshBin))
    candidates.push(path.join(pkgRoot, 'node_modules', 'js-yaml', 'index.js'))
  }
  const globalRoot = run('npm', ['root', '-g'])
  if (globalRoot.ok) candidates.push(path.join(globalRoot.stdout.trim(), '@deepseek-ai/dsh', 'node_modules', 'js-yaml', 'index.js'))
  candidates.push(path.join(MOD_DIR, 'node_modules', 'js-yaml', 'index.js'))
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    try {
      const yaml = createRequire(import.meta.url)(candidate)
      if (typeof yaml.load === 'function') return yaml
    } catch { /* next candidate */ }
  }
  return undefined
}

function jsSchema(yaml) {
  const JsType = new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: String })
  return yaml.DEFAULT_SCHEMA.extend([JsType])
}

// ─── settings.yaml surgery ──────────────────────────────────────────────────

const TOP_LEVEL = /^([A-Za-z0-9_.-]+):/

function topLevelBlocks(lines) {
  const blocks = []
  for (let i = 0; i < lines.length; i += 1) {
    const match = TOP_LEVEL.exec(lines[i])
    if (match === null) continue
    let end = i + 1
    while (end < lines.length && TOP_LEVEL.exec(lines[end]) === null) end += 1
    blocks.push({ key: match[1], start: i, end })
  }
  return blocks
}

/** Index just past the last non-blank line of a half-open range. */
function lastContent(lines, start, end) {
  let index = end
  while (index > start && lines[index - 1].trim() === '') index -= 1
  return index
}

/** Range of an indented child block (the key line plus every deeper line). */
function childRange(lines, start, end, key, indent) {
  const header = new RegExp(`^ {${indent}}${escapeRegExp(key)}:`)
  for (let i = start; i < end; i += 1) {
    if (!header.test(lines[i])) continue
    let stop = i + 1
    while (stop < end) {
      const line = lines[stop]
      if (line.trim() === '') { stop += 1; continue }
      if (leadingSpaces(line) <= indent) break
      stop += 1
    }
    return { start: i, end: stop }
  }
  return undefined
}

function leadingSpaces(line) {
  const match = /^ */.exec(line)
  return match === null ? 0 : match[0].length
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Set `key: value` at `indent` inside a range, replacing an existing line or
 * inserting after the range's last content line.
 */
function setScalar(lines, start, end, key, value, indent) {
  const pattern = new RegExp(`^ {${indent}}${escapeRegExp(key)}:.*$`)
  for (let i = start; i < end; i += 1) {
    if (pattern.test(lines[i])) {
      lines[i] = `${' '.repeat(indent)}${key}: ${value}`
      return
    }
  }
  const insertAt = lastContent(lines, start, end)
  lines.splice(insertAt, 0, `${' '.repeat(indent)}${key}: ${value}`)
}

function removeScalar(lines, start, end, key, indent) {
  const pattern = new RegExp(`^ {${indent}}${escapeRegExp(key)}:.*$`)
  for (let i = end - 1; i >= start; i -= 1) {
    if (pattern.test(lines[i])) { lines.splice(i, 1); return }
  }
}

/** Set `indent`-level `key` to an empty inline map, creating parents as needed. */
function ensureNestedEmptyMap(lines, keyPath, indentStep = 2) {
  let parentStart = 0
  let parentEnd = lines.length
  let indent = 0
  for (let depth = 0; depth < keyPath.length - 1; depth += 1) {
    const key = keyPath[depth]
    const range = childRange(lines, parentStart, parentEnd, key, indent)
    if (range === undefined) {
      const insertAt = lastContent(lines, parentStart, parentEnd)
      lines.splice(insertAt, 0, `${' '.repeat(indent)}${key}:`)
      parentStart = insertAt + 1
      parentEnd = insertAt + 1
      indent += indentStep
      continue
    }
    parentStart = range.start
    parentEnd = range.end
    indent += indentStep
  }
  const leaf = keyPath[keyPath.length - 1]
  const existing = childRange(lines, parentStart, parentEnd, leaf, indent)
  if (existing !== undefined) return
  const insertAt = lastContent(lines, parentStart, parentEnd)
  lines.splice(insertAt, 0, `${' '.repeat(indent)}${leaf}: {}`)
}

/** Remove `indent`-level `key` and prune parents left empty by the removal. */
function removeNestedKey(lines, keyPath, indentStep = 2) {
  const range = findNested(lines, keyPath, indentStep)
  if (range === undefined) return
  lines.splice(range.start, range.end - range.start)
  pruneEmptyParents(lines, keyPath.slice(0, -1), indentStep)
}

function findNested(lines, keyPath, indentStep = 2) {
  let parentStart = 0
  let parentEnd = lines.length
  let indent = 0
  for (let depth = 0; depth < keyPath.length; depth += 1) {
    const range = childRange(lines, parentStart, parentEnd, keyPath[depth], indent)
    if (range === undefined) return undefined
    if (depth === keyPath.length - 1) return range
    parentStart = range.start
    parentEnd = range.end
    indent += indentStep
  }
  return undefined
}

function pruneEmptyParents(lines, keyPath, indentStep = 2) {
  for (let depth = keyPath.length - 1; depth >= 0; depth -= 1) {
    const range = findNested(lines, keyPath.slice(0, depth + 1), indentStep)
    if (range === undefined) continue
    const children = lines.slice(range.start + 1, range.end).filter(line => line.trim() !== '' && !line.trim().startsWith('#'))
    if (children.length === 0) lines.splice(range.start, range.end - range.start)
  }
}

function topBlockRange(lines, key) {
  const block = topLevelBlocks(lines).find(candidate => candidate.key === key)
  return block === undefined ? undefined : { start: block.start, end: block.end }
}

function ensureTopBlock(lines, key) {
  const existing = topBlockRange(lines, key)
  if (existing !== undefined) return existing
  const insertAt = lastContent(lines, 0, lines.length)
  lines.splice(insertAt, 0, `${key}:`)
  return { start: insertAt, end: insertAt + 1 }
}

function enableRoute(lines) {
  ensureNestedEmptyMap(lines, ['llm-pi-ai', 'providers', 'openai-codex'])
}

function disableRoute(lines) {
  removeNestedKey(lines, ['llm-pi-ai', 'providers', 'openai-codex'])
}

function setPresetDefault(lines) {
  setTopScalar(lines, 'agent-presets', 'default', ACTIVATED_VALUE)
}

function clearPresetDefault(lines) {
  const block = topBlockRange(lines, 'agent-presets')
  if (block === undefined) return
  const index = lines.findIndex((line, at) => at > block.start && at < block.end && line === `  default: ${ACTIVATED_VALUE}`)
  if (index !== -1) lines.splice(index, 1)
  pruneEmptyParents(lines, ['agent-presets'])
}

/**
 * Set one indented key of a top-level block, re-reading the block bounds after
 * every insert so consecutive new keys keep their call order instead of
 * stacking in reverse.
 */
function setTopScalar(lines, blockKey, key, value) {
  ensureTopBlock(lines, blockKey)
  const range = topBlockRange(lines, blockKey)
  setScalar(lines, range.start, range.end, key, value, 2)
}

function activateDefaultModel(lines) {
  setTopScalar(lines, 'agent-default-model', 'provider', ORCHESTRATOR.provider)
  setTopScalar(lines, 'agent-default-model', 'model', ORCHESTRATOR.model)
  setTopScalar(lines, 'agent-default-model', 'reasoningEffort', ORCHESTRATOR.reasoningEffort)
}

function deactivateDefaultModel(lines) {
  const block = topBlockRange(lines, 'agent-default-model')
  if (block === undefined) return
  const owned = [`  provider: ${ORCHESTRATOR.provider}`, `  model: ${ORCHESTRATOR.model}`, `  reasoningEffort: ${ORCHESTRATOR.reasoningEffort}`]
  for (let at = block.end - 1; at > block.start; at -= 1) {
    if (owned.includes(lines[at])) lines.splice(at, 1)
  }
  pruneEmptyTopBlocks(lines)
}

/** Drop top-level keys left with no value and no children. */
function pruneEmptyTopBlocks(lines) {
  for (const block of [...topLevelBlocks(lines)].reverse()) {
    if (!/^[A-Za-z0-9_.-]+:\s*$/.test(lines[block.start])) continue
    const children = lines.slice(block.start + 1, block.end).filter(line => line.trim() !== '' && !line.trim().startsWith('#'))
    if (children.length === 0) lines.splice(block.start, block.end - block.start)
  }
}

function readSettings(file) {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n')
}

function readModelSelection(text) {
  if (text.trim() === '') return undefined
  const lines = text.split('\n')
  const block = topBlockRange(lines, 'agent-default-model')
  if (block === undefined) return undefined
  const pick = key => {
    const prefix = `  ${key}:`
    const line = lines.slice(block.start + 1, block.end).find(candidate => candidate.startsWith(prefix))
    return line === undefined ? undefined : line.slice(prefix.length).trim()
  }
  const selection = { provider: pick('provider'), model: pick('model'), reasoningEffort: pick('reasoningEffort') }
  return Object.values(selection).every(value => value === undefined) ? undefined : selection
}

/**
 * Capture the verbatim `agent-default-model` block plus its ordinal position,
 * so uninstall can put the user's own selection back exactly where it was
 * instead of appending reordered keys.
 */
function captureModelBlock(text) {
  if (text.trim() === '') return undefined
  const lines = text.split('\n')
  const block = topBlockRange(lines, 'agent-default-model')
  if (block === undefined) return undefined
  const content = lines.slice(block.start, lastContent(lines, block.start, block.end))
  const index = topLevelBlocks(lines).findIndex(candidate => candidate.key === 'agent-default-model')
  return { index, lines: content }
}

function restoreModelBlock(lines, captured) {
  const block = topBlockRange(lines, 'agent-default-model')
  if (block !== undefined) lines.splice(block.start, block.end - block.start)
  const blocks = topLevelBlocks(lines)
  const at = Math.min(Math.max(captured.index, 0), blocks.length)
  const insertAt = at < blocks.length ? blocks[at].start : lastContent(lines, 0, lines.length)
  lines.splice(insertAt, 0, ...captured.lines)
}

function sidecarPath(dshHome) {
  return path.join(dshHome, '.astra-orchestrator-backups', 'model-selection.json')
}

function readSidecar(file) {
  if (!existsSync(file)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined
  } catch {
    return undefined
  }
}

function renderSettings(lines) {
  if (lines.length === 0) return ''
  const text = lines.join('\n')
  return text.endsWith('\n') ? text : `${text}\n`
}

// ─── file plan ──────────────────────────────────────────────────────────────

function plan(paths, opts) {
  const actions = []
  const before = renderSettings(readSettings(paths.settings))
  const lines = readSettings(paths.settings)
  let snapshot

  if (opts.mode === 'uninstall') {
    if (existsSync(paths.presetDest)) actions.push({ kind: 'rm', target: paths.presetDest })
    if (existsSync(paths.skillDest)) actions.push({ kind: 'rm', target: paths.skillDest })
    const previous = readSidecar(sidecarPath(paths.dshHome))
    const current = readModelSelection(before)
    const ours = current !== undefined && current.provider === ORCHESTRATOR.provider && current.model === ORCHESTRATOR.model
    disableRoute(lines)
    clearPresetDefault(lines)
    deactivateDefaultModel(lines)
    const captured = previous?.block
    if (captured !== undefined && Array.isArray(captured.lines) && ours) {
      restoreModelBlock(lines, captured)
      const restored = readModelSelection(renderSettings(lines))
      actions.push({ kind: 'restore', target: `agent-default-model → ${restored?.provider ?? '(none)'}/${restored?.model ?? '(none)'}` })
    }
  } else if (opts.bundle === true) {
    actions.push({ kind: 'pnpm-add', target: `${PKG_NAME} → profiles/${opts.profile}` })
    enableRoute(lines)
    setPresetDefault(lines)
    if (opts.activate) {
      snapshot = captureModelBlock(before)
      activateDefaultModel(lines)
    }
  } else {
    if (!dirsEqual(paths.presetSrc, paths.presetDest)) {
      actions.push({ kind: 'copy', target: `${paths.presetSrc} → ${paths.presetDest}` })
    } else {
      actions.push({ kind: 'current', target: `${paths.presetDest} (already this revision)` })
    }
    actions.push({ kind: 'copy', target: `${paths.skillSrc} → ${paths.skillDest}` })
    enableRoute(lines)
    setPresetDefault(lines)
    if (opts.activate) {
      snapshot = captureModelBlock(before)
      activateDefaultModel(lines)
    }
  }
  return { actions, before, after: renderSettings(lines), snapshot }
}

function printDiff(before, after) {
  if (before === after) {
    log('settings.yaml: no change')
    return
  }
  const beforeLines = before.split('\n')
  const afterLines = after.split('\n')
  const beforeSet = new Set(beforeLines)
  const afterSet = new Set(afterLines)
  log('settings.yaml diff:')
  for (const line of beforeLines) if (!afterSet.has(line)) log(`  - ${line}`)
  for (const line of afterLines) if (!beforeSet.has(line)) log(`  + ${line}`)
}

/** Whether two directories hold the same relative files with identical bytes. */
function dirsEqual(left, right) {
  if (!existsSync(left) || !existsSync(right)) return false
  const listing = directory => {
    const files = []
    const walk = (current, prefix) => {
      for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
        if (entry.isDirectory()) walk(path.join(current, entry.name), rel)
        else files.push(rel)
      }
    }
    walk(directory, '')
    return files
  }
  const leftFiles = listing(left)
  const rightFiles = listing(right)
  if (leftFiles.length !== rightFiles.length) return false
  return leftFiles.every((rel, index) => rel === rightFiles[index]
    && readFileSync(path.join(left, rel)).equals(readFileSync(path.join(right, rel))))
}

// ─── process helpers ────────────────────────────────────────────────────────

function which(name) {
  const result = run('sh', ['-c', `command -v ${name}`])
  if (!result.ok || result.stdout.trim() === '') return undefined
  // `command -v` answers with the launcher symlink; the harness packages sit
  // beside the real bin.js, so follow it before walking up two directories.
  try {
    return realpathSync(result.stdout.trim())
  } catch {
    return result.stdout.trim()
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options })
  return { ok: result.status === 0, status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function resolveDshHome(explicit) {
  if (explicit !== undefined) return path.resolve(explicit)
  if (process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== '') return path.resolve(process.env.DSH_HOME)
  return path.join(os.homedir(), '.dsh')
}

function pathsFor(dshHome, opts) {
  return {
    dshHome,
    settings: path.join(dshHome, 'settings.yaml'),
    env: path.join(dshHome, '.env'),
    presetSrc: path.join(MOD_DIR, 'preset'),
    presetDest: path.join(dshHome, '.agent-presets', PRESET_ID),
    skillSrc: path.join(MOD_DIR, 'skills', SKILL_ID),
    skillDest: path.join(dshHome, 'skills', SKILL_ID),
    profileDir: path.join(dshHome, 'profiles', opts.profile),
  }
}

function backup(file) {
  if (!existsSync(file)) return undefined
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = `${file}.bak-${stamp}`
  cpSync(file, target)
  return target
}

function writeAtomic(file, contents) {
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, contents)
  renameSync(tmp, file)
}

function upsertEnvKey(file, key, value) {
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n') : []
  const pattern = new RegExp(`^\\s*(export\\s+)?${escapeRegExp(key)}=`)
  const index = lines.findIndex(line => pattern.test(line))
  const rendered = `${key}=${value}`
  if (index === -1) {
    const at = lastContent(lines, 0, lines.length)
    lines.splice(at, 0, rendered)
  } else {
    lines[index] = rendered
  }
  writeAtomic(file, renderSettings(lines))
}

function dropEnvKey(file, key) {
  if (!existsSync(file)) return
  const lines = readFileSync(file, 'utf8').split('\n')
  const pattern = new RegExp(`^\\s*(export\\s+)?${escapeRegExp(key)}=`)
  const kept = lines.filter(line => !pattern.test(line))
  writeAtomic(file, renderSettings(kept))
}

// ─── install steps ──────────────────────────────────────────────────────────

function planSteps(opts, paths) {
  const planned = plan(paths, opts)
  const yaml = loadYaml()
  if (yaml !== undefined && planned.after.trim() !== '') {
    try {
      yaml.load(planned.after, { schema: jsSchema(yaml) })
    } catch (error) {
      fail(`refusing to write settings.yaml: the merged document would not parse\n  ${error.message}`)
    }
  }
  return { ...planned, yaml }
}

function presetBackupDir(dshHome) {
  return path.join(dshHome, '.astra-orchestrator-backups')
}

async function install(opts, paths) {
  const steps = planSteps(opts, paths)
  log(`dsh home: ${paths.dshHome}`)
  log(`mode:     ${opts.bundle === true ? `bundle (profile ${opts.profile})` : 'copy'}`)
  log('plan:')
  for (const action of steps.actions) log(`  ${action.kind.padEnd(9)} ${action.target}`)
  printDiff(steps.before, steps.after)

  if (opts.dryRun) { log('dry run: nothing written'); return }

  if (!opts.yes && process.stdin.isTTY && !await confirm('Apply this plan? [y/N] ')) fail('cancelled')

  // 1. settings.yaml (backup first, then atomic replace)
  if (steps.after !== steps.before) {
    const saved = backup(paths.settings)
    if (saved !== undefined) log(`backup:   ${saved}`)
    writeAtomic(paths.settings, steps.after)
    log(`settings: ${paths.settings} updated`)
  } else {
    log('settings: already up to date')
  }

  // Remember the pre-activation model selection so --uninstall can put it back.
  // Captured only once, and only when there was a selection to restore.
  if (steps.snapshot !== undefined && !existsSync(sidecarPath(paths.dshHome))) {
    const file = sidecarPath(paths.dshHome)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify({ block: steps.snapshot, capturedAt: new Date().toISOString() }, null, 2)}\n`)
    log(`restore:  ${file}`)
  }

  // 2. preset + skill
  if (opts.bundle === true) {
    const add = run('dsh', ['plugin', '--profile', opts.profile, 'add', MOD_DIR])
    if (!add.ok) {
      process.stderr.write(add.stdout)
      process.stderr.write(add.stderr)
      fail(`\`dsh plugin --profile ${opts.profile} add ${MOD_DIR}\` failed; settings were written, rerun after fixing the bundle install`)
    }
    log(`bundle:   ${PKG_NAME} added to profile "${opts.profile}"`)
    const installed = resolveInstalledPreset(paths.profileDir)
    if (installed === undefined) fail(`installed package not found under ${paths.profileDir}/node_modules`)
    upsertEnvKey(paths.env, ENV_KEY, installed)
    log(`env:      ${ENV_KEY}=${installed} (${paths.env})`)
    log('restart required: bundle layers are composed at profile boot.')
  } else {
    if (!dirsEqual(paths.presetSrc, paths.presetDest)) {
      if (existsSync(paths.presetDest)) {
        const saved = path.join(presetBackupDir(paths.dshHome), `${PRESET_ID}-${new Date().toISOString().replace(/[:.]/g, '-')}`)
        mkdirSync(path.dirname(saved), { recursive: true })
        cpSync(paths.presetDest, saved, { recursive: true })
        log(`backup:   ${saved}`)
      }
      rmSync(paths.presetDest, { recursive: true, force: true })
      cpSync(paths.presetSrc, paths.presetDest, { recursive: true })
      log(`preset:   ${paths.presetDest}`)
    } else {
      log(`preset:   ${paths.presetDest} (already this revision)`)
    }
  }

  rmSync(paths.skillDest, { recursive: true, force: true })
  mkdirSync(path.dirname(paths.skillDest), { recursive: true })
  cpSync(paths.skillSrc, paths.skillDest, { recursive: true })
  log(`skill:    ${paths.skillDest}`)

  if (opts.login || opts.logout) runLogin(opts, paths)
  warnIfNotSignedIn(paths.dshHome, opts)
  if (opts.activate) {
    log(`activated: fresh sessions default to ${ORCHESTRATOR.provider}/${ORCHESTRATOR.model} (effort ${ORCHESTRATOR.reasoningEffort})`)
  } else {
    log('')
    log('note:     fresh sessions still use your saved default model.')
    log(`          run  node ${path.relative(process.cwd(), path.join(MOD_DIR, 'install.mjs'))} --activate  to put the orchestrator on ${ORCHESTRATOR.provider}/${ORCHESTRATOR.model}.`)
  }
  if (opts.verify) verify(opts)
}

/**
 * Run the out-of-process Codex OAuth sign-in. Inherited stdio is required: the
 * flow prints a device code or an authorization URL and may read a pasted code.
 */
function runLogin(opts, paths) {
  const script = path.join(MOD_DIR, 'scripts', 'login-openai-codex.mjs')
  const args = [script, '--dsh-home', paths.dshHome, '--yes']
  if (opts.logout) args.push('--logout')
  else args.push('--method', opts.method)
  log('')
  log(`login:    node ${path.relative(process.cwd(), script)}${opts.logout ? ' --logout' : ` --method ${opts.method}`}`)
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' })
  if (result.status !== 0) fail('sign-in did not complete; the rest of the install is already applied')
}

function resolveInstalledPreset(profileDir) {
  const installed = path.join(profileDir, 'node_modules', PKG_NAME, 'preset')
  return existsSync(installed) ? installed : undefined
}

function warnIfNotSignedIn(dshHome, opts) {
  const credentials = path.join(dshHome, '.credentials.yaml')
  const signedIn = existsSync(credentials) && readFileSync(credentials, 'utf8').includes('llm-pi-ai/openai-codex')
  if (signedIn) { log('auth:     ChatGPT subscription sign-in present'); return }
  log('')
  log('auth:     no `llm-pi-ai/openai-codex` credential found yet.')
  log('          Sign in before activating, or the orchestrator route fails every request.')
  log('          This build ships no sign-in UI, so run the bundled flow:')
  log(`            node ${path.relative(process.cwd(), path.join(MOD_DIR, 'scripts', 'login-openai-codex.mjs'))} --method device`)
  log('          or rerun this installer with --login.')
  if (opts.activate) log('          (--activate was requested; reverting is `--uninstall`.)')
}

function verify(opts) {
  log('')
  log(`verify: dsh --profile ${opts.profile} --dump-config`)
  const result = run('dsh', ['--profile', opts.profile, '--dump-config'])
  if (!result.ok) {
    process.stderr.write(result.stdout)
    process.stderr.write(result.stderr)
    fail('config dump failed — revert with --uninstall and inspect the diagnostics')
  }
  log('verify: composed configuration is valid')
}

async function uninstall(opts, paths) {
  const steps = planSteps(opts, paths)
  log(`dsh home: ${paths.dshHome}`)
  log('plan:')
  for (const action of steps.actions) log(`  ${action.kind.padEnd(9)} ${action.target}`)
  printDiff(steps.before, steps.after)
  if (opts.dryRun) { log('dry run: nothing written'); return }
  if (!opts.yes && process.stdin.isTTY && !await confirm('Remove these? [y/N] ')) fail('cancelled')

  if (steps.after !== steps.before) {
    const saved = backup(paths.settings)
    if (saved !== undefined) log(`backup:   ${saved}`)
    writeAtomic(paths.settings, steps.after)
    log(`settings: ${paths.settings} updated`)
  }
  rmSync(paths.presetDest, { recursive: true, force: true })
  rmSync(paths.skillDest, { recursive: true, force: true })
  rmSync(sidecarPath(paths.dshHome), { force: true })
  dropEnvKey(paths.env, ENV_KEY)
  if (opts.bundle === true) {
    const removed = run('dsh', ['plugin', '--profile', opts.profile, 'remove', PKG_NAME])
    if (!removed.ok) log(`warning: \`dsh plugin --profile ${opts.profile} remove ${PKG_NAME}\` failed; remove it manually`)
  }
  log('uninstalled. A running CLI picks the change up at the next boot (copy mode: next settings read).')
}

async function confirm(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await rl.question(question)
    return /^y(es)?$/i.test(answer.trim())
  } finally {
    rl.close()
  }
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) { log(helpText()); return }
  for (const required of ['preset/preset.yml', 'preset/agent.cordis.yml', `skills/${SKILL_ID}/SKILL.md`, 'cordis.patch.yml']) {
    if (!existsSync(path.join(MOD_DIR, required))) fail(`package is incomplete: missing ${required}`)
  }
  const dshHome = resolveDshHome(opts.dshHome)
  const paths = pathsFor(dshHome, opts)
  if (opts.logout) { runLogin(opts, paths); return }
  if (opts.mode === 'uninstall') await uninstall(opts, paths)
  else await install(opts, paths)
  if (opts.mode === 'install' && !opts.dryRun) {
    log('')
    log('done. presets appear in the GUI preset picker; verify with --verify on a stopped CLI.')
  }
}

function helpText() {
  const source = readFileSync(new URL(import.meta.url), 'utf8')
  const doc = /\/\*\*([\s\S]*?)\*\//.exec(source)
  const body = doc === null ? '' : doc[1].replace(/^ \* ?/gm, '').replace(/^\s*\n/, '')
  return body.trim()
}

main().catch(error => fail(error instanceof Error ? error.message : String(error)))
