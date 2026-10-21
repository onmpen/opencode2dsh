#!/usr/bin/env node
/**
 * Read-only check that a DeepSeek Harness profile really carries a working
 * opencode2dsh installation: the dependency, the bundle selection, the version
 * actually on disk, the host and client entries, the bundle patch, and the
 * plugin's own health snapshot.
 *
 * Usage:
 *   node scripts/verify-dsh-install.mjs --profile desktop
 *   node scripts/verify-dsh-install.mjs --profile web --package @opencode2dsh/dsh-plugin
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PKG = '@opencode2dsh/dsh-plugin'

function parseArgs(argv) {
  const out = { profile: 'desktop', pkg: PKG }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`)
      i += 1
      return value
    }
    if (arg === '--profile') out.profile = next()
    else if (arg === '--package') out.pkg = next()
    else throw new Error(`unknown argument: ${arg}`)
  }
  return out
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))
const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
const { profile, pkg } = parseArgs(process.argv.slice(2))
const profileDir = join(home, 'profiles', profile)

const manifestPath = join(profileDir, 'package.json')
if (!existsSync(manifestPath)) {
  console.error(`no profile at ${profileDir}`)
  process.exit(2)
}
const manifest = readJson(manifestPath)
const rows = []
/**
 * Record one check. `pending` is a third state, not a failure: the item can only
 * be answered after the host boots this profile, and treating "not booted yet"
 * as a failure would make a fresh install look broken.
 */
const check = (state, label, detail) => rows.push({ state, label, detail })
const ok = (condition, label, detail) => check(condition ? 'ok' : 'fail', label, detail)

const declared = manifest.dependencies?.[pkg]
ok(Boolean(declared), 'dependency declared', declared ?? 'absent from dependencies')

const bundles = manifest.dsh?.profile?.bundles ?? []
ok(bundles.includes(pkg), 'bundle selected', bundles.join(', '))

const pkgDir = join(profileDir, 'node_modules', ...pkg.split('/'))
const pkgJsonPath = join(pkgDir, 'package.json')
const installed = existsSync(pkgJsonPath) ? readJson(pkgJsonPath) : undefined
ok(Boolean(installed), 'package installed', installed ? installed.version : 'not installed')

for (const [label, relative] of [
  ['host entry present', join('lib', 'index.js')],
  ['client entry present', join('lib', 'client.js')],
  ['bundle patch present', 'cordis.patch.yml'],
]) {
  const present = existsSync(join(pkgDir, relative))
  ok(present, label, present ? relative : `missing ${relative}`)
}

/**
 * The plugin writes one health snapshot per boot at a global path, so any
 * profile that has booted can leave one behind. Only a snapshot taken after this
 * profile last installed the plugin describes this install.
 *
 * The anchor is the profile's own lockfile, not the installed package's mtime:
 * pnpm hard-links from its content-addressable store, so the files under
 * node_modules keep the store's timestamps and can look older than a snapshot
 * written days later.
 */
const installAnchor = [
  join(profileDir, 'pnpm-lock.yaml'),
  join(profileDir, 'node_modules', '.modules.yaml'),
]
  .filter((path) => existsSync(path))
  .reduce((latest, path) => Math.max(latest, statSync(path).mtimeMs), 0)

const statusPath = join(homedir(), '.opencode2dsh', 'adapter-status.json')
if (!existsSync(statusPath)) {
  check('pending', 'catalog ready', `no snapshot yet at ${statusPath}; boot this profile once`)
} else {
  const status = readJson(statusPath)
  const writtenAt = Date.parse(status.writtenAt ?? '')
  const summary = `status=${status.status} exposed=${status.exposed}/${status.total} error=${status.lastError || 'none'}`
  if (Number.isFinite(writtenAt) && writtenAt < installAnchor) {
    check(
      'pending',
      'catalog ready',
      `snapshot predates this install (${new Date(writtenAt).toLocaleString()}); boot this profile and re-run`,
    )
  } else {
    ok(status.status === 'ready', 'catalog ready', summary)
  }
}

const marks = { ok: '[ok]  ', fail: '[!!]  ', pending: '[--]  ' }
for (const row of rows) console.log(`${marks[row.state]} ${row.label.padEnd(20)} ${row.detail}`)

const failed = rows.filter((row) => row.state === 'fail').length
const passed = rows.filter((row) => row.state === 'ok').length
const pending = rows.filter((row) => row.state === 'pending').length
const tail = pending > 0 ? `, ${pending} pending` : ''
console.log(`\n${passed}/${rows.length - pending} checks passed${tail}`)
process.exit(failed === 0 ? 0 : 1)
