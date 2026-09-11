#!/usr/bin/env node
/**
 * Installer acceptance test: settings.yaml round-trip, copy idempotency,
 * uninstall restoration, and route/preset activation.
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

const home = mkdtempSync(path.join(os.tmpdir(), 'astra-orchestrator-test-'))
try {
  writeFileSync(path.join(home, 'settings.yaml'), FIXTURE)
  const yamlPath = path.join(home, 'settings.yaml')

  process.stdout.write('dry run\n')
  const dry = installer(home, '--dry-run', '--activate')
  check('dry run exits 0', dry.status === 0, dry.out)
  check('dry run writes nothing', readSettings(home) === FIXTURE)
  check('dry run shows the route', dry.out.includes('openai-codex: {}'), dry.out)

  process.stdout.write('install --activate\n')
  const first = installer(home, '--activate')
  check('install exits 0', first.status === 0, first.out)
  const installed = readSettings(home)
  check('comment preserved', installed.startsWith('# a user comment that must survive'))
  check('route added under existing providers', /^ {4}openai-codex: \{\}$/m.test(installed))
  check('other providers untouched', installed.includes('KIMI_CODING_API_KEY') && installed.includes('z-ai/glm-5.3-flash'))
  check('preset default set', /^agent-presets:\n {2}default: astra-orchestrator$/m.test(installed))
  check('orchestrator activated at xhigh', /provider: openai-codex\n {2}model: gpt-6-astra\n {2}reasoningEffort: xhigh/.test(installed))
  check('preset copied', existsSync(path.join(home, '.agent-presets', 'astra-orchestrator', 'agent.cordis.yml')))
  check('skill copied', existsSync(path.join(home, 'skills', 'astra-orchestrator', 'SKILL.md')))
  check('settings backup written', readdirSync(home).some(name => name.startsWith('settings.yaml.bak-')))

  process.stdout.write('install again\n')
  const second = installer(home, '--activate')
  check('second install exits 0', second.status === 0, second.out)
  check('idempotent settings', readSettings(home) === installed)
  check('idempotent preset', second.out.includes('already this revision'), second.out)
  check('no duplicate preset dirs', readdirSync(path.join(home, '.agent-presets')).length === 1)
  check('backups dir holds only the model sidecar', readdirSync(path.join(home, '.astra-orchestrator-backups')).join(',') === 'model-selection.json')

  process.stdout.write('uninstall\n')
  const removed = installer(home, '--uninstall')
  check('uninstall exits 0', removed.status === 0, removed.out)
  check('settings restored byte for byte', readSettings(home) === FIXTURE, JSON.stringify(readSettings(home)))
  check('preset removed', !existsSync(path.join(home, '.agent-presets', 'astra-orchestrator')))
  check('skill removed', !existsSync(path.join(home, 'skills', 'astra-orchestrator')))
} finally {
  rmSync(home, { recursive: true, force: true })
}

process.stdout.write(failures === 0 ? '\nall checks passed\n' : `\n${failures} check(s) failed\n`)
process.exit(failures === 0 ? 0 : 1)
