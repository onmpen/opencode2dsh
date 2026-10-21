#!/usr/bin/env node
/**
 * Install @opencode2dsh/dsh-plugin into a DeepSeek Harness profile, including
 * the profiles `dsh plugin` cannot touch.
 *
 * The documented route is `dsh plugin --profile <name> add <pkg>`. Two profiles
 * or environments need more than that:
 *
 *   1. `desktop` is refused outright by the launcher:
 *        error: profile "desktop" is managed exclusively by the Electron application
 *      (`@deepseek-ai/dsh/lib/bin.js`, rejectElectronProfile). The desktop app
 *      still loads pnpm-installed plugins, so running pnpm inside the profile
 *      directory and selecting the bundle is the equivalent change.
 *   2. pnpm 11 fails the run with ERR_PNPM_IGNORED_BUILDS unless the two build
 *      scripts pi-ai drags in (`@google/genai`, `protobufjs`) are decided in the
 *      profile's pnpm-workspace.yaml. They are not needed at runtime. `dsh`
 *      treats that non-zero exit as a failed install and rolls back.
 *
 * Only profile-internal files are touched: `package.json` (dependency and
 * `dsh.profile.bundles`) and `pnpm-workspace.yaml` (`allowBuilds`).
 * `cordis.patch.yml` is never edited, so local overrides stay as they are.
 *
 * Usage:
 *   node scripts/install-dsh-profile.mjs --profile desktop
 *   node scripts/install-dsh-profile.mjs --profile web --version 0.3.14
 *   node scripts/install-dsh-profile.mjs --profile desktop --dry-run
 *   node scripts/install-dsh-profile.mjs --profile desktop --pnpm /path/to/pnpm.cjs
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const PKG = '@opencode2dsh/dsh-plugin'
const DEFAULT_VERSION = '0.3.14'
/** Build scripts the plugin's transitive dependencies declare; unused at runtime. */
const ALLOW_BUILDS = { '@google/genai': false, protobufjs: false }

function parseArgs(argv) {
  const out = { profile: 'desktop', version: DEFAULT_VERSION, pkg: PKG, pnpm: undefined, dryRun: false, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`)
      i += 1
      return value
    }
    if (arg === '--profile') out.profile = next()
    else if (arg === '--version') out.version = next()
    else if (arg === '--package') out.pkg = next()
    else if (arg === '--pnpm') out.pnpm = next()
    else if (arg === '--dry-run') out.dryRun = true
    else if (arg === '-h' || arg === '--help') out.help = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  return out
}

const usage = () => {
  const source = readFileSync(new URL(import.meta.url), 'utf8')
  return source.slice(source.indexOf('/**') + 3, source.indexOf('*/')).replace(/^ \* ?/gm, '').trim()
}

/** DSH home: `$DSH_HOME`, else `~/.dsh`. */
function resolveHome() {
  const fromEnv = process.env.DSH_HOME?.trim()
  return fromEnv && fromEnv.length > 0 ? fromEnv : join(homedir(), '.dsh')
}

/** Read JSON tolerating a UTF-8 BOM, which Windows editors like to add. */
function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

/**
 * Decide the two build scripts inside `allowBuilds`, preserving the rest of the
 * file. Returns the resulting text and whether it differs from the input.
 */
function ensureAllowBuilds(text) {
  const present = (name) =>
    new RegExp(`^\\s*'?"?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'?"?\\s*:`, 'm').test(text)
  const missing = Object.entries(ALLOW_BUILDS).filter(([name]) => !present(name))
  if (missing.length === 0) return { text, changed: false }

  const rendered = missing.map(([name, value]) => `  ${/[@/]/.test(name) ? `'${name}'` : name}: ${value}`)
  const lines = text.split(/\r?\n/)
  const header = lines.findIndex((line) => /^allowBuilds:\s*$/.test(line))

  if (header === -1) {
    const body = text.length === 0 || text.endsWith('\n') ? text : `${text}\n`
    const sep = body.length > 0 && !body.endsWith('\n\n') ? '\n' : ''
    return { text: `${body}${sep}allowBuilds:\n${rendered.join('\n')}\n`, changed: true }
  }
  lines.splice(header + 1, 0, ...rendered)
  return { text: lines.join('\n'), changed: true }
}

/**
 * Locate a pnpm entry point: the explicit flag, then PATH, then the copy the
 * DeepSeek Harness installation or the dsh runtime ships (which needs its own
 * node, since `node` may not be on PATH on a desktop-only install).
 */
function locatePnpm(explicit) {
  if (explicit) {
    const absolute = resolve(explicit)
    return /\.(cjs|mjs)$/.test(absolute) ? { kind: 'script', script: absolute } : { kind: 'binary', command: absolute }
  }
  const roots = [
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness'),
    'C:/Program Files/DeepSeek Harness',
    '/Applications/DeepSeek Harness.app/Contents/Resources',
    join(resolveHome(), 'dsh-runtimes'),
  ].filter(Boolean)
  for (const root of roots) {
    for (const deps of [
      join(root, 'resources', 'runtime', 'primary-runtime', 'dependencies'),
      join(root, 'runtime', 'primary-runtime', 'dependencies'),
      join(root, 'dsh-primary-runtime', 'dependencies'),
    ]) {
      const script = join(deps, 'pnpm', 'bin', 'pnpm.cjs')
      if (existsSync(script)) {
        const node = join(deps, 'node', 'bin', 'node.exe')
        return { kind: 'script', script, node: existsSync(node) ? node : process.execPath }
      }
    }
  }
  return { kind: 'binary', command: 'pnpm' }
}

function run({ command, args, cwd }) {
  return new Promise((resolvePromise) => {
    const proc = spawn(command, args, {
      cwd,
      stdio: 'inherit',
      shell: process.platform === 'win32' && !command.endsWith('.exe'),
    })
    proc.on('error', (error) => resolvePromise({ code: -1, error }))
    proc.on('exit', (code) => resolvePromise({ code: code ?? -1 }))
  })
}

const describePnpm = (pnpm) => (pnpm.kind === 'script' ? `node ${pnpm.script}` : pnpm.command)

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(usage())
    return 0
  }

  const profileDir = join(resolveHome(), 'profiles', options.profile)
  const manifestPath = join(profileDir, 'package.json')
  const workspacePath = join(profileDir, 'pnpm-workspace.yaml')

  if (!existsSync(manifestPath)) {
    console.error(`no profile at ${profileDir}`)
    console.error('create one first, e.g. dsh --profile <name> --from-default-profile web --dump-config')
    return 2
  }

  const pnpm = locatePnpm(options.pnpm)
  console.log(`profile:  ${profileDir}`)
  console.log(`package:  ${options.pkg}@${options.version}`)
  console.log(`pnpm:     ${describePnpm(pnpm)}`)

  const manifest = readJson(manifestPath)
  manifest.dependencies = { ...(manifest.dependencies ?? {}), [options.pkg]: options.version }
  const bundles = manifest.dsh?.profile?.bundles ?? []
  if (!bundles.includes(options.pkg)) {
    manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: [...bundles, options.pkg] } }
  }
  const workspace = ensureAllowBuilds(existsSync(workspacePath) ? readFileSync(workspacePath, 'utf8') : '')

  if (options.dryRun) {
    console.log('\n--- would write package.json ---')
    console.log(JSON.stringify(manifest, null, 2))
    if (workspace.changed) {
      console.log('\n--- would write pnpm-workspace.yaml ---')
      console.log(workspace.text)
    }
    console.log('\n(dry run: nothing changed, no install performed)')
    return 0
  }

  writeJson(manifestPath, manifest)
  if (workspace.changed) writeFileSync(workspacePath, workspace.text, 'utf8')

  const args = ['add', `${options.pkg}@${options.version}`]
  const invoke = (extra = []) =>
    pnpm.kind === 'script'
      ? run({ command: pnpm.node, args: [pnpm.script, ...args, ...extra], cwd: profileDir })
      : run({ command: pnpm.command, args: [...args, ...extra], cwd: profileDir })

  console.log(`\n> ${describePnpm(pnpm)} ${args.join(' ')}`)
  let result = await invoke()

  // A globally pinned strictDepBuilds can still fail the run; decide it here for
  // this invocation only rather than asking the user to edit a global config.
  if (result.code !== 0) {
    console.log(`\nfirst attempt exited ${result.code}; retrying with --config.strictDepBuilds=false`)
    result = await invoke(['--config.strictDepBuilds=false'])
  }

  if (result.code !== 0) {
    console.error(`\ninstall failed (exit ${result.code}); the profile files keep the changes written above.`)
    console.error('fix the package-manager error and re-run, or restore your backup.')
    return result.code
  }

  const installedPath = join(profileDir, 'node_modules', ...options.pkg.split('/'), 'package.json')
  console.log(`\ninstalled: ${existsSync(installedPath) ? readJson(installedPath).version : 'missing'}`)
  console.log(`bundles:   ${(manifest.dsh?.profile?.bundles ?? []).join(', ')}`)
  console.log('\nnext:')
  console.log('  1. restart DeepSeek Harness (a newly added bundle is not hot-loaded)')
  console.log('  2. open the model picker and pick a model under the opencode2dsh group')
  console.log(`  3. check the health snapshot: ${join(homedir(), '.opencode2dsh', 'adapter-status.json')}`)
  return 0
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  },
)
