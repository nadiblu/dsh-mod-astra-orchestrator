#!/usr/bin/env node
/**
 * Installer acceptance test: settings.yaml round-trip, copy idempotency,
 * activation, uninstall restoration, and unrelated-config preservation.
 *
 * Runs the real installer against a throwaway harness home in the OS temp
 * directory. It never touches `$DSH_HOME`.
 *
 *   node scripts/test-settings-merge.mjs
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const MOD_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const INSTALLER = path.join(MOD_DIR, 'install.mjs')

const FIXTURE = `# a user comment that must survive
ui-onboarding:
  welcomeNoticeVersion: 2026-08-13.1
agent-default-model:
  provider: deepseek-official
  model: deepseek-flash
  reasoningEffort: high
ui-theme:
  preference: dark
llm-pi-ai:
  providers:
    kimi-coding:
      apiKeyEnv: KIMI_CODING_API_KEY
    openrouter:
      displayName: OpenRouter
      apiKeyEnv: OPENROUTER_API_KEY
      models:
        - id: z-ai/glm-5.3-flash
          name: GLM 5.3 Flash
`

// A user who picked the mode's own route themselves, with no effort recorded.
// Uninstall must not confuse that selection with this installer's activation.
const GLM_USER_FIXTURE = FIXTURE.replace(
  '  provider: deepseek-official\n  model: deepseek-flash\n  reasoningEffort: high',
  '  provider: openrouter\n  model: z-ai/glm-5.3-flash'
)

const ACTIVATED_BLOCK = /^ {2}provider: openrouter\n {2}model: z-ai\/glm-5\.3-flash\n {2}reasoningEffort: max$/m
const USER_DEFAULT_PRESERVED = /^ {2}provider: deepseek-official\n {2}model: deepseek-flash\n {2}reasoningEffort: high$/m
const GLM_MODEL_ENTRY = '        - id: z-ai/glm-5.3-flash\n          name: GLM 5.3 Flash'

let failures = 0

function check(label, condition, detail = '') {
  if (condition) {
    process.stdout.write(`  ok   ${label}\n`)
    return
  }
  failures += 1
  process.stdout.write(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}\n`)
}

function installer(home, ...args) {
  const result = spawnSync(process.execPath, [INSTALLER, '--dsh-home', home, '--yes', ...args], { encoding: 'utf8' })
  return { status: result.status, out: `${result.stdout}${result.stderr}` }
}

function readSettings(home) {
  return readFileSync(path.join(home, 'settings.yaml'), 'utf8')
}

function sidecarText(home) {
  return readFileSync(path.join(home, '.astra-orchestrator-backups', 'model-selection.json'), 'utf8')
}

function sidecar(home) {
  return JSON.parse(sidecarText(home))
}

const home = mkdtempSync(path.join(os.tmpdir(), 'astra-orchestrator-test-'))
try {
  writeFileSync(path.join(home, 'settings.yaml'), FIXTURE)

  process.stdout.write('dry run\n')
  const dry = installer(home, '--dry-run', '--activate')
  check('dry run exits 0', dry.status === 0, dry.out)
  check('dry run writes nothing', readSettings(home) === FIXTURE)

  process.stdout.write('install --activate\n')
  const first = installer(home, '--activate')
  check('install exits 0', first.status === 0, first.out)
  const activated = readSettings(home)
  check('comment preserved', activated.startsWith('# a user comment that must survive'))
  check('route added under existing providers', /^ {4}openai-codex: \{\}$/m.test(activated))
  check('openrouter model list untouched', activated.includes(GLM_MODEL_ENTRY))
  check('other providers untouched', activated.includes('KIMI_CODING_API_KEY') && activated.includes('displayName: OpenRouter'))
  check('preset default set', /^agent-presets:\n {2}default: astra-orchestrator$/m.test(activated))
  check('activated to GLM at max', ACTIVATED_BLOCK.test(activated), activated)
  check('preset copied', existsSync(path.join(home, '.agent-presets', 'astra-orchestrator', 'agent.cordis.yml')))
  check('skill copied', existsSync(path.join(home, 'skills', 'astra-orchestrator', 'SKILL.md')))
  check('settings backup written', readdirSync(home).some(name => name.startsWith('settings.yaml.bak-')))
  check('sidecar captured the prior selection', JSON.stringify(sidecar(home).block?.lines ?? []).includes('deepseek-official'))

  process.stdout.write('install again\n')
  const sidecarBefore = sidecarText(home)
  const presetBefore = readFileSync(path.join(home, '.agent-presets', 'astra-orchestrator', 'agent.cordis.yml'), 'utf8')
  const second = installer(home, '--activate')
  check('second install exits 0', second.status === 0, second.out)
  check('idempotent settings', readSettings(home) === activated)
  check('idempotent preset', readFileSync(path.join(home, '.agent-presets', 'astra-orchestrator', 'agent.cordis.yml'), 'utf8') === presetBefore)
  check('no duplicate preset dirs', readdirSync(path.join(home, '.agent-presets')).length === 1)
  check('sidecar captured once', sidecarText(home) === sidecarBefore)
  check('backups dir holds only the model sidecar', readdirSync(path.join(home, '.astra-orchestrator-backups')).join(',') === 'model-selection.json')

  process.stdout.write('uninstall\n')
  const removed = installer(home, '--uninstall')
  check('uninstall exits 0', removed.status === 0, removed.out)
  check('settings restored byte for byte', readSettings(home) === FIXTURE, JSON.stringify(readSettings(home)))
  check('preset removed', !existsSync(path.join(home, '.agent-presets', 'astra-orchestrator')))
  check('skill removed', !existsSync(path.join(home, 'skills', 'astra-orchestrator')))

  process.stdout.write('install without --activate is non-switching\n')
  writeFileSync(path.join(home, 'settings.yaml'), FIXTURE)
  const plain = installer(home)
  check('plain install exits 0', plain.status === 0, plain.out)
  const plainSettings = readSettings(home)
  check('user default model preserved', USER_DEFAULT_PRESERVED.test(plainSettings), plainSettings)
  check('preset default still set', /^ {2}default: astra-orchestrator$/m.test(plainSettings))
  check('no sidecar without activation', !existsSync(path.join(home, '.astra-orchestrator-backups', 'model-selection.json')))
  const plainRemoved = installer(home, '--uninstall')
  check('plain uninstall exits 0', plainRemoved.status === 0, plainRemoved.out)
  check('settings restored byte for byte', readSettings(home) === FIXTURE, JSON.stringify(readSettings(home)))

  process.stdout.write('a user already on the mode route survives\n')
  writeFileSync(path.join(home, 'settings.yaml'), GLM_USER_FIXTURE)
  const glmUser = installer(home)
  check('plain install exits 0', glmUser.status === 0, glmUser.out)
  const glmUserRemoved = installer(home, '--uninstall')
  check('uninstall exits 0', glmUserRemoved.status === 0, glmUserRemoved.out)
  check('user GLM selection preserved byte for byte', readSettings(home) === GLM_USER_FIXTURE, JSON.stringify(readSettings(home)))

  process.stdout.write('activating on top of a user GLM selection restores it\n')
  const glmActivated = installer(home, '--activate')
  check('install exits 0', glmActivated.status === 0, glmActivated.out)
  check('activation records max effort', /^ {2}reasoningEffort: max$/m.test(readSettings(home)))
  check('sidecar holds the user block', JSON.stringify(sidecar(home).block?.lines ?? []).includes('z-ai/glm-5.3-flash'))
  const glmRestored = installer(home, '--uninstall')
  check('uninstall exits 0', glmRestored.status === 0, glmRestored.out)
  check('user selection restored byte for byte', readSettings(home) === GLM_USER_FIXTURE, JSON.stringify(readSettings(home)))

  process.stdout.write('activation without a prior selection restores absence\n')
  const noSelection = FIXTURE.replace('agent-default-model:\n  provider: deepseek-official\n  model: deepseek-flash\n  reasoningEffort: high\n', '')
  writeFileSync(path.join(home, 'settings.yaml'), noSelection)
  const noSelectionActivated = installer(home, '--activate')
  check('install exits 0', noSelectionActivated.status === 0, noSelectionActivated.out)
  const noSelectionRemoved = installer(home, '--uninstall')
  check('uninstall exits 0', noSelectionRemoved.status === 0, noSelectionRemoved.out)
  check('absent selection restored byte for byte', readSettings(home) === noSelection)

  process.stdout.write('an independently selected exact GLM max route survives\n')
  const exactUserSelection = GLM_USER_FIXTURE.replace('  model: z-ai/glm-5.3-flash\n', '  model: z-ai/glm-5.3-flash\n  reasoningEffort: max\n')
  writeFileSync(path.join(home, 'settings.yaml'), exactUserSelection)
  const exactUserInstalled = installer(home)
  check('plain install exits 0', exactUserInstalled.status === 0, exactUserInstalled.out)
  const exactUserRemoved = installer(home, '--uninstall')
  check('uninstall exits 0', exactUserRemoved.status === 0, exactUserRemoved.out)
  check('unowned exact selection preserved byte for byte', readSettings(home) === exactUserSelection)

  process.stdout.write('a later user effort change survives uninstall\n')
  writeFileSync(path.join(home, 'settings.yaml'), GLM_USER_FIXTURE)
  const effortActivated = installer(home, '--activate')
  check('install exits 0', effortActivated.status === 0, effortActivated.out)
  writeFileSync(path.join(home, 'settings.yaml'), readSettings(home).replace('  reasoningEffort: max\n', '  reasoningEffort: high\n'))
  const changedEffort = GLM_USER_FIXTURE.replace('  model: z-ai/glm-5.3-flash\n', '  model: z-ai/glm-5.3-flash\n  reasoningEffort: high\n')
  const effortRemoved = installer(home, '--uninstall')
  check('uninstall exits 0', effortRemoved.status === 0, effortRemoved.out)
  check('user effort change preserved byte for byte', readSettings(home) === changedEffort)

  for (const reactivate of [false, true]) {
    process.stdout.write(`legacy Astra activation upgrade${reactivate ? ' with reactivation' : ''}\n`)
    writeFileSync(path.join(home, 'settings.yaml'), FIXTURE)
    const seed = installer(home, '--activate')
    check('seed activation exits 0', seed.status === 0, seed.out)
    const legacyRecord = sidecar(home)
    delete legacyRecord.activatedSelection
    writeFileSync(path.join(home, '.astra-orchestrator-backups', 'model-selection.json'), `${JSON.stringify(legacyRecord, null, 2)}\n`)
    writeFileSync(path.join(home, 'settings.yaml'), readSettings(home).replace(
      '  provider: openrouter\n  model: z-ai/glm-5.3-flash\n  reasoningEffort: max',
      '  provider: openai-codex\n  model: gpt-6-astra\n  reasoningEffort: xhigh'
    ))
    const upgraded = installer(home, ...(reactivate ? ['--activate'] : []))
    check('upgrade exits 0', upgraded.status === 0, upgraded.out)
    const legacyRemoved = installer(home, '--uninstall')
    check('uninstall exits 0', legacyRemoved.status === 0, legacyRemoved.out)
    check('pre-legacy selection restored byte for byte', readSettings(home) === FIXTURE, JSON.stringify(readSettings(home)))
  }
} finally {
  rmSync(home, { recursive: true, force: true })
}

process.stdout.write(failures === 0 ? '\nall checks passed\n' : `\n${failures} check(s) failed\n`)
process.exit(failures === 0 ? 0 : 1)
