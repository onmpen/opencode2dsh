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
import { existsSync, readFileSync } from 'node:fs'
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
const check = (ok, label, detail) => rows.push({ ok, label, detail })

const declared = manifest.dependencies?.[pkg]
check(Boolean(declared), 'dependency declared', declared ?? 'absent from dependencies')

const bundles = manifest.dsh?.profile?.bundles ?? []
check(bundles.includes(pkg), 'bundle selected', bundles.join(', '))

const pkgDir = join(profileDir, 'node_modules', ...pkg.split('/'))
const pkgJsonPath = join(pkgDir, 'package.json')
const installed = existsSync(pkgJsonPath) ? readJson(pkgJsonPath) : undefined
check(Boolean(installed), 'package installed', installed ? installed.version : 'not installed')

for (const [label, relative] of [
  ['host entry present', join('lib', 'index.js')],
  ['client entry present', join('lib', 'client.js')],
  ['bundle patch present', 'cordis.patch.yml'],
]) {
  const present = existsSync(join(pkgDir, relative))
  check(present, label, present ? relative : `missing ${relative}`)
}

const statusPath = join(homedir(), '.opencode2dsh', 'adapter-status.json')
if (existsSync(statusPath)) {
  const status = readJson(statusPath)
  check(
    status.status === 'ready',
    'catalog ready',
    `status=${status.status} exposed=${status.exposed}/${status.total} error=${status.lastError || 'none'}`,
  )
} else {
  check(false, 'catalog ready', `no snapshot at ${statusPath} yet (written once the host boots the plugin)`)
}

for (const row of rows) console.log(`${row.ok ? '[ok]  ' : '[!!]  '} ${row.label.padEnd(20)} ${row.detail}`)
const failed = rows.filter((row) => !row.ok).length
console.log(`\n${rows.length - failed}/${rows.length} checks passed`)
process.exit(failed === 0 ? 0 : 1)
