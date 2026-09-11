#!/usr/bin/env node
/**
 * ChatGPT-subscription (Codex OAuth) sign-in for the Astra orchestrator mod.
 *
 * Why this exists: the `openai-codex` route authenticates only through OAuth
 * with a ChatGPT Plus/Pro subscription — there is no API key for it. The
 * harness owns the credential seam (`dsh-authorization` + the pi-ai login
 * flow), but the shipped profiles mount neither a sign-in surface nor a CLI
 * verb, so this script runs the same pi-ai OAuth flow out of process and
 * writes the resulting grant into the harness credential store.
 *
 * Two methods are offered by the provider itself:
 *   device   headless. Prints a code and a URL; you finish in your own browser
 *            while this script polls. Default, and the one that works without
 *            a local callback server.
 *   browser  Starts a local callback server on 127.0.0.1:1455, prints the
 *            authorization URL, and accepts a pasted code or redirect URL as a
 *            fallback.
 *
 * The grant lands in `<dshHome>/.credentials.yaml` as record
 * `llm-pi-ai/openai-codex` (`kind: grant`), which is exactly where the pi-ai
 * adapter's credential store reads it. The store watches the file, so a running
 * harness picks the sign-in up without a restart. Existing file contents are
 * preserved and a timestamped backup is written first.
 *
 * Usage:
 *   node scripts/login-openai-codex.mjs [--dsh-home <path>] [--method device|browser]
 *                                       [--check] [--logout] [--yes]
 *
 * Options:
 *   --dsh-home <path>  harness home (default: $DSH_HOME or ~/.dsh)
 *   --method <name>    device (default) or browser
 *   --check            resolve pi-ai and report the flow, then exit (no network)
 *   --logout           delete the stored `llm-pi-ai/openai-codex` record
 *   --yes              do not prompt before replacing an existing record
 *   --help
 *
 * No token is ever printed. Add `--json` only when a machine, not a human, is
 * reading the output: it reports metadata (accountId, expires) and never the
 * access or refresh token.
 */

import { spawnSync } from 'node:child_process'
import dns from 'node:dns'
import { chmodSync, cpSync, existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { createInterface } from 'node:readline/promises'
import { pathToFileURL } from 'node:url'

const RECORD_KEY = 'llm-pi-ai/openai-codex'
const PROVIDER_ID = 'openai-codex'

// ─── cli ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { method: 'device', check: false, logout: false, yes: false, json: false, dshHome: undefined }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case '--method': opts.method = need(argv, ++i, arg); break
      case '--dsh-home': opts.dshHome = need(argv, ++i, arg); break
      case '--check': opts.check = true; break
      case '--logout': opts.logout = true; break
      case '--yes': case '-y': opts.yes = true; break
      case '--json': opts.json = true; break
      case '--help': case '-h': opts.help = true; break
      default: fail(`unknown argument "${arg}" (try --help)`)
    }
  }
  if (!['device', 'browser'].includes(opts.method)) fail(`--method must be "device" or "browser", got "${opts.method}"`)
  return opts
}

function need(argv, index, flag) {
  const value = argv[index]
  if (value === undefined || value.startsWith('-')) fail(`${flag} needs a value`)
  return value
}

function fail(message) {
  process.stderr.write(`login-openai-codex: ${message}\n`)
  process.exit(1)
}

function out(line = '') {
  process.stdout.write(`${line}\n`)
}

// ─── pi-ai resolution ───────────────────────────────────────────────────────

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  return { ok: result.status === 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function which(name) {
  const result = run('sh', ['-c', `command -v ${name}`])
  if (!result.ok || result.stdout.trim() === '') return undefined
  // Follow the launcher symlink: the harness packages sit beside the real bin.js.
  try {
    return realpathSync(result.stdout.trim())
  } catch {
    return result.stdout.trim()
  }
}

function resolvePiAi() {
  const candidates = []
  const dshBin = which('dsh')
  if (dshBin !== undefined) candidates.push(path.join(path.dirname(path.dirname(dshBin)), 'node_modules', '@earendil-works', 'pi-ai'))
  const dshHome = resolveDshHome(undefined)
  candidates.push(path.join(dshHome, 'profiles', 'node_modules', '@earendil-works', 'pi-ai'))
  const globalRoot = run('npm', ['root', '-g'])
  if (globalRoot.ok) candidates.push(path.join(globalRoot.stdout.trim(), '@deepseek-ai', 'dsh', 'node_modules', '@earendil-works', 'pi-ai'))
  for (const candidate of candidates) {
    const flow = path.join(candidate, 'dist', 'auth', 'oauth', 'openai-codex.js')
    if (existsSync(flow)) return candidate
  }
  fail('could not find @earendil-works/pi-ai next to the dsh installation; pass --dsh-home or install dsh first')
  return undefined
}

function loadYaml() {
  const dshBin = which('dsh')
  const candidates = []
  if (dshBin !== undefined) candidates.push(path.join(path.dirname(path.dirname(dshBin)), 'node_modules', 'js-yaml', 'index.js'))
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    try {
      const yaml = createRequire(import.meta.url)(candidate)
      if (typeof yaml.load === 'function' && typeof yaml.dump === 'function') return yaml
    } catch { /* next */ }
  }
  return undefined
}

// ─── credential store ───────────────────────────────────────────────────────

function resolveDshHome(explicit) {
  if (explicit !== undefined) return path.resolve(explicit)
  if (process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== '') return path.resolve(process.env.DSH_HOME)
  return path.join(os.homedir(), '.dsh')
}

function readStore(yaml, file) {
  if (!existsSync(file)) return { version: 1, refs: {}, records: {} }
  const parsed = yaml.load(readFileSync(file, 'utf8'))
  if (typeof parsed !== 'object' || parsed === null) fail(`${file} is not a mapping`)
  return { version: parsed.version ?? 1, refs: parsed.refs ?? {}, records: parsed.records ?? {} }
}

function writeStore(yaml, file, store) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  if (existsSync(file)) {
    const backup = `${file}.bak-${stamp}`
    cpSync(file, backup)
    out(`backup:   ${backup}`)
  }
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, yaml.dump(store, { lineWidth: 120, noRefs: true }), { mode: 0o600 })
  renameSync(tmp, file)
  chmodSync(file, 0o600)
}

// ─── interaction ────────────────────────────────────────────────────────────

function makeInteraction(method, controller) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const close = () => rl.close()
  return {
    close,
    interaction: {
      signal: controller.signal,
      notify(event) {
        if (event.type === 'device_code') {
          out('')
          out('  Open:  ' + event.verificationUri)
          out('  Code:  ' + event.userCode)
          if (event.expiresInSeconds !== undefined) out(`  Valid: ${Math.round(event.expiresInSeconds / 60)} minutes`)
          out('')
          out('  Waiting for the code to be approved…')
          return
        }
        if (event.type === 'auth_url') {
          out('')
          out('  Open:  ' + event.url)
          if (event.instructions !== undefined) out('  ' + event.instructions)
          out('')
          return
        }
        if (event.type === 'info' || event.type === 'progress') {
          out(`  ${event.message}`)
          return
        }
      },
      async prompt(prompt) {
        if (prompt.type === 'select') {
          // The provider names its methods `browser` and `device_code`; this
          // script's flag is the shorter `device|browser`.
          const wanted = method === 'device' ? 'device_code' : method
          const chosen = prompt.options.find(option => option.id === wanted)
            ?? prompt.options.find(option => option.id.startsWith(wanted))
            ?? prompt.options[0]
          out(`  method: ${chosen.label} (${chosen.id})`)
          return chosen.id
        }
        const hint = prompt.placeholder === undefined ? '' : ` [${prompt.placeholder}]`
        return rl.question(`  ${prompt.message}${hint}\n  > `)
      },
    },
  }
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) { out(helpText()); return }

  const dshHome = resolveDshHome(opts.dshHome)
  const storeFile = path.join(dshHome, '.credentials.yaml')
  const yaml = loadYaml()
  if (yaml === undefined) fail('could not resolve js-yaml from the dsh installation; refusing to rewrite the credential store blind')

  const piAiDir = resolvePiAi()
  const flow = await import(pathToFileURL(path.join(piAiDir, 'dist', 'auth', 'oauth', 'openai-codex.js')).href)
  const oauth = flow.openaiCodexOAuth
  if (oauth === undefined) fail(`pi-ai at ${piAiDir} does not export openaiCodexOAuth`)

  if (opts.check) {
    out(`pi-ai:    ${piAiDir}`)
    out(`provider: ${PROVIDER_ID} — ${oauth.name}${oauth.isSubscription === true ? ' (subscription)' : ''}`)
    out(`methods:  device code, browser`)
    out(`store:    ${storeFile}`)
    out(`record:   ${RECORD_KEY}`)
    const store = readStore(yaml, storeFile)
    out(`signed in: ${store.records[RECORD_KEY] === undefined ? 'no' : 'yes'}`)
    return
  }

  if (opts.logout) {
    const store = readStore(yaml, storeFile)
    if (store.records[RECORD_KEY] === undefined) { out('nothing to remove: no stored ChatGPT grant'); return }
    delete store.records[RECORD_KEY]
    writeStore(yaml, storeFile, store)
    out(`removed ${RECORD_KEY} from ${storeFile}`)
    return
  }

  const existing = readStore(yaml, storeFile).records[RECORD_KEY]
  if (existing !== undefined && !opts.yes) {
    out(`an ${PROVIDER_ID} grant already exists in ${storeFile}; it is replaced on success (Ctrl-C to abort).`)
  }

  const controller = new AbortController()
  const onSignal = () => controller.abort()
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)

  out(`Signing in to ${oauth.name}.`)
  out('A ChatGPT Plus/Pro subscription is required; no API key is involved.')
  // Cloudflare-fronted endpoints resolve to IPv6 first here, and a failed IPv6
  // connect spends the whole 10s socket timeout before the IPv4 candidate is
  // tried. Preferring IPv4 makes the OAuth round trips reliable.
  try {
    dns.setDefaultResultOrder('ipv4first')
  } catch { /* older Node: keep the resolver default */ }

  const { interaction, close } = makeInteraction(opts.method, controller)
  let credential
  const attempts = 5
  try {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        credential = await oauth.login(interaction)
        break
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const cause = error instanceof Error && error.cause !== undefined ? ` (${describeCause(error.cause)})` : ''
        if (controller.signal.aborted) fail('sign-in cancelled')
        if (attempt === attempts) fail(`${message}${cause}`)
        // A dropped connection mid-poll invalidates the device code, so the next
        // attempt requests a fresh one and prints it again.
        out(`  attempt ${attempt} failed: ${message}${cause}`)
        out('  retrying with a fresh code…')
        await new Promise(resolve => setTimeout(resolve, 2000))
      }
    }
  } finally {
    close()
  }

  if (credential === undefined || typeof credential !== 'object') fail('the OAuth flow returned no credential')
  for (const field of ['access', 'refresh', 'expires']) {
    if (credential[field] === undefined) fail(`the OAuth flow returned a credential without "${field}"`)
  }

  const store = readStore(yaml, storeFile)
  store.records[RECORD_KEY] = { kind: 'grant', payload: { type: 'oauth', ...credential } }
  writeStore(yaml, storeFile, store)

  const account = typeof credential.accountId === 'string' ? credential.accountId : undefined
  if (opts.json) {
    out(JSON.stringify({ record: RECORD_KEY, store: storeFile, accountId: account, expires: credential.expires }))
    return
  }
  out('')
  out(`stored:   ${RECORD_KEY} in ${storeFile}`)
  if (account !== undefined) out(`account:  ${account}`)
  out('')
  out('Next: run install.mjs --activate if you have not already, then start a session on the')
  out('Astra Orchestrator preset. The running harness reloads the credential file automatically.')
}

function describeCause(cause) {
  if (cause === null || typeof cause !== 'object') return String(cause)
  const record = cause
  const code = typeof record.code === 'string' ? record.code : undefined
  const message = typeof record.message === 'string' ? record.message : undefined
  return [code, message].filter(Boolean).join(': ') || String(cause)
}

function helpText() {
  const source = readFileSync(new URL(import.meta.url), 'utf8')
  const doc = /\/\*\*([\s\S]*?)\*\//.exec(source)
  return doc === null ? '' : doc[1].replace(/^ \* ?/gm, '').replace(/^\s*\n/, '').trim()
}

main().catch(error => fail(error instanceof Error ? error.message : String(error)))
