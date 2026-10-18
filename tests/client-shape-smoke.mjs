/**
 * Structural checks on the package manifest and the browser half.
 *
 * The client bundle is loaded by DSH's own front end through the
 * `window.__ModuleLoader__.load(...)` convention (no bundler), and the
 * discovery path depends entirely on package.json metadata — `dsh.client`,
 * `exports["./client"]` and `dsh.bundle.patch`. A wrong field silently keeps
 * the panel out of the boot graph, so this suite pins the shape that
 * discovery relies on. Pure Node, no dependencies: CI-safe.
 *
 * Run: node tests/client-shape-smoke.mjs
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(here, '..')

const passes = []
const failures = []
function check (name, condition, detail) {
  if (condition) {
    passes.push(name)
    console.log(`  PASS  ${name}`)
  } else {
    failures.push(`${name}${detail === undefined ? '' : ` — ${detail}`}`)
    console.log(`  FAIL  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

console.log('\n=== client shape smoke ===\n')
console.log(`[package root: ${packageRoot}]`)

const pkg = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))

check('package is ESM', pkg.type === 'module', String(pkg.type))
check('main points at lib/index.js', pkg.main === 'lib/index.js', String(pkg.main))

console.log('\n[dsh.client]')
check('dsh.client is declared', typeof pkg.dsh?.client === 'object' && pkg.dsh.client !== null)
check('platform is web', pkg.dsh?.client?.platform === 'web', String(pkg.dsh?.client?.platform))
check('inject lists the client-side peers',
  Array.isArray(pkg.dsh?.client?.inject) && pkg.dsh.client.inject.length > 0
    && pkg.dsh.client.inject.every(entry => typeof entry === 'string' && entry.startsWith('@deepseek-ai/')),
  JSON.stringify(pkg.dsh?.client?.inject))

console.log('\n[dsh.bundle.patch]')
check('bundle patch is declared', typeof pkg.dsh?.bundle?.patch === 'string', String(pkg.dsh?.bundle?.patch))
const patchPath = path.join(packageRoot, String(pkg.dsh?.bundle?.patch ?? ''))
check('the patch file exists', existsSync(patchPath), patchPath)
if (existsSync(patchPath)) {
  const patch = readFileSync(patchPath, 'utf8')
  check('the patch inserts the plugin row by package name',
    patch.includes(pkg.name),
    patch.slice(0, 120))
}

console.log('\n[exports]')
const clientExport = pkg.exports?.['./client']
const clientRel = typeof clientExport === 'string' ? clientExport : clientExport?.default
check('exports["./client"] resolves to a string path', typeof clientRel === 'string', JSON.stringify(clientExport))
check('the client bundle exists', typeof clientRel === 'string' && existsSync(path.join(packageRoot, clientRel)), String(clientRel))
if (typeof clientRel === 'string' && existsSync(path.join(packageRoot, clientRel))) {
  const clientPath = path.join(packageRoot, clientRel)
  check('the client bundle is non-empty', statSync(clientPath).size > 0, String(statSync(clientPath).size))
  const client = readFileSync(clientPath, 'utf8')
  check('the first line uses the __ModuleLoader__ convention', client.split('\n', 1)[0].includes('__ModuleLoader__'),
    client.split('\n', 1)[0].slice(0, 100))
  check('the bundle exports apply()', client.includes('exports.apply'), '(marker not found)')
} else {
  check('the client bundle is non-empty', false, 'bundle missing')
  check('the first line uses the __ModuleLoader__ convention', false, 'bundle missing')
  check('the bundle exports apply()', false, 'bundle missing')
}

console.log('\n[host half]')
check('lib/index.js exists', existsSync(path.join(packageRoot, 'lib/index.js')))
check('lib/client.js is excluded from the host entry points',
  pkg.exports?.['.']?.default !== './lib/client.js', JSON.stringify(pkg.exports?.['.']))

console.log('\n[five-row list cap]')
// Each long list is a scrolling viewport, not a truncation: dropping rows
// would hide a row's controls (a tunnel you cannot see is one you cannot turn
// off). The four sections the cap applies to are pinned here, because losing
// one of the wrappers silently brings back a panel that scrolls for pages.
if (typeof clientRel === 'string' && existsSync(path.join(packageRoot, clientRel))) {
  const client = readFileSync(path.join(packageRoot, clientRel), 'utf8')
  check('LIST_CAP is 5', /const LIST_CAP = 5\b/.test(client))
  check('CappedList is defined', /function CappedList \(/.test(client))
  const capped = (client.match(/jsx\(CappedList, \{/g) ?? []).length
  check('all four lists are capped (hosts, forwards, mounted, detached)', capped === 4, `found ${capped} wrappers`)
  check('the cap is measured, not assumed from a fixed row height',
    /getBoundingClientRect\(\)\.height/.test(client) && !/LIST_CAP \* \d+px/.test(client))
  check('a short list renders without a reserved scrollbar slot',
    /\.sshwsp-cap \{[^}]*\}/.test(client) && !/\.sshwsp-cap \{[^}]*overflow-y/.test(client),
    'an unconditional overflow-y reserves a gutter on lists that never scroll')
  check('overflow scrolls only once capped', /\.sshwsp-cap-scroll \{[^}]*overflow-y: auto/.test(client))
  check('capped rows drop their own bottom margin (flex does not collapse it)',
    /\.sshwsp-cap > \.sshwsp-card, \.sshwsp-cap > \.sshwsp-mount \{ margin-bottom: 0; \}/.test(client))
}

console.log('\n[stylesheet covers the classes the bundle renders]')
// A class can be rendered without ever being declared. That is invisible until
// someone reads the DOM: the layout pass that added the list cap deleted the
// `.sshwsp-empty` rule as collateral, and every empty / loading / error
// placeholder silently lost its padding and centring. Nothing failed, because
// no test compared what the bundle renders against what the sheet declares.
// Each entry below is a class the panel depends on for MEANING, not decoration.
if (typeof clientRel === 'string' && existsSync(path.join(packageRoot, clientRel))) {
  const client = readFileSync(path.join(packageRoot, clientRel), 'utf8')
  for (const className of ['sshwsp-empty', 'sshwsp-mount', 'sshwsp-mount-path', 'sshwsp-entry-meta', 'sshwsp-btn', 'sshwsp-input', 'sshwsp-mount-off', 'sshwsp-check']) {
    // Rendered either as its own class token or inside a multi-class list
    // ("sshwsp-mount sshwsp-mount-off"); the declaration is what this pins.
    check(`.${className} is rendered and declared`,
      client.includes(className) && new RegExp(`\\.${className}\\s*[,{]`).test(client),
      'used in the UI but missing from the injected stylesheet')
  }
} else {
  check('the client bundle is inspectable for declared classes', false, 'bundle missing')
}

console.log('\n[detached workspace: delete for good]')
if (typeof clientRel === 'string' && existsSync(path.join(packageRoot, clientRel))) {
  const client = readFileSync(path.join(packageRoot, clientRel), 'utf8')
  // The action only touches the local side: mode "forget" clears the DSH
  // workspace registration AND this plugin's disabled mark, so no row and no
  // runtime fence survives it. Both locales must carry every label, or one
  // language renders a blank button.
  for (const key of ['detached.purge', 'detached.purging', 'detached.confirmPurge', 'detached.purgeTitle', 'detached.purgeHint', 'detached.purgeOk', 'detached.purgeFail']) {
    const occurrences = (client.match(new RegExp(`'${key.replaceAll('.', '\\.')}':`, 'g')) ?? []).length
    check(`${key} is translated in both dictionaries`, occurrences === 2, `found ${occurrences}`)
  }
  check('the action posts forget mode and leaves archiving alone',
    /mode: 'forget', archiveSessions: false/.test(client))
  check('the row button opens a confirmation dialog instead of acting',
    /onClick: \(\) => setPurgeTarget\(wsPath\)/.test(client) &&
      /onClick: \(\) => handlePurge\(purgeTarget\)/.test(client))
  check('the dialog can be dismissed without deleting',
    /if \(purgeBusy === null\) setPurgeTarget\(null\)/.test(client) &&
      /onClick: \(\) => setPurgeTarget\(null\)/.test(client))
  check('the dialog reuses the shared backdrop/dialog styles',
    /sshwsp-backdrop/.test(client) && /sshwsp-dialog sshwsp-dialog-narrow/.test(client))
  check('the destructive button reuses the shared danger style',
    /sshwsp-btn sshwsp-btn-danger/.test(client))
}

console.log('\n[publish whitelist]')
const files = pkg.files ?? []
check('lib/ ships in the tarball', files.includes('lib/'), JSON.stringify(files))
check('cordis.patch.yml ships in the tarball', files.includes('cordis.patch.yml'), JSON.stringify(files))
check('tests are not shipped in the tarball', !files.some(entry => String(entry).startsWith('tests')), JSON.stringify(files))

console.log(`\n=== ${passes.length} passed, ${failures.length} failed ===`)
if (failures.length > 0) {
  console.log('\nfailures:')
  for (const failure of failures) console.log(`  - ${failure}`)
}
process.exit(failures.length === 0 ? 0 : 1)
