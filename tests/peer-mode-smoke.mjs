/**
 * The peer detector is the one piece of test infrastructure that can be WRONG in
 * a way no other suite notices.
 *
 * Every suite trusts it: `skipWithoutRealPeers()` decides whether a suite runs,
 * skips, or fails, and a detector that answers "real" for a stub turns every
 * dependent suite into a green run that verified nothing. A detector that
 * answers "absent" for a package that is installed but broken sends the reader to
 * install something they already have. Both are silent: the run looks normal.
 *
 * So this suite drives the detector against synthetic trees built here, with the
 * four package states reachable on demand. It needs no host tree — that is the
 * point, since the tree under test is the detector, not the plugin.
 *
 * Run: node tests/peer-mode-smoke.mjs
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let passed = 0
let failures = 0
function check (label, ok, detail) {
  if (ok) {
    passed += 1
    console.log(`  PASS  ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

console.log('\n=== peer mode detector smoke ===\n')

const {
  describePackage,
  describeTree,
  peerMode,
  HOST_PEERS,
  PACKAGE_STATE,
  TREE_MODE,
} = await import(pathToFileURL(path.join(pluginRoot, 'tests/support/peer-mode.mjs')).href)
const { installPeerStubs } = await import(pathToFileURL(path.join(pluginRoot, 'tests/peer-stubs.mjs')).href)

/** A scratch directory that the caller removes. */
function scratch () {
  return mkdtempSync(path.join(tmpdir(), 'dsh-peer-mode-'))
}

/**
 * Write a package into `root` in one of the four states.
 *
 * `broken` resolves and then throws while loading, which is the state the old
 * detector mistook for `absent`. The throw names a MISSING TRANSITIVE PEER, as a
 * real damaged tree does — that is what a reader has to be able to follow.
 */
function writePackage (root, name, state) {
  const dir = path.join(root, ...name.split('/'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.0', main: 'index.cjs' }), 'utf8')
  if (state === 'absent') {
    rmSync(dir, { recursive: true, force: true })
    return
  }
  if (state === 'broken') {
    writeFileSync(path.join(dir, 'index.cjs'),
      "throw new Error(\"Cannot find package '@deepseek-ai/dsh-scope' imported from " + name + "\")\n", 'utf8')
    return
  }
  const exportsTable = state === 'stub'
    ? `module.exports = { name: ${JSON.stringify(name)}, __dshStub: true }\n`
    : `module.exports = { name: ${JSON.stringify(name)} }\n`
  writeFileSync(path.join(dir, 'index.cjs'), exportsTable, 'utf8')
}

/** Build a tree from a `{name: state}` map; returns the node_modules path. */
function makeTree (spec) {
  const base = scratch()
  const root = path.join(base, 'node_modules')
  mkdirSync(root, { recursive: true })
  for (const [name, state] of Object.entries(spec)) writePackage(root, name, state)
  // The tree root needs a package.json so createRequire treats it as a directory
  // anchor rather than walking up out of the scratch dir.
  return { base, root }
}

// --- 1. The generated stub root is honestly reported -------------------------
//
// The most load-bearing check here: everything else trusts that a stub says so.
// Under the OLD code this tree came back as `mixed`/`real`-ish because only
// dsh-fs was inspected, and dsh-tools quietly claimed to be real.
{
  const base = scratch()
  const root = installPeerStubs(base)
  const tree = describeTree(root, HOST_PEERS)
  check('the generated stub root is reported as stub, not real',
    tree.mode === TREE_MODE.STUB, tree.reason)
  check('every host peer the stub root provides is marked __dshStub',
    tree.packages.every(entry => entry.state === PACKAGE_STATE.STUB),
    tree.packages.map(entry => `${entry.name}=${entry.state}`).join(', '))
  check('peerMode() says the generated root is not real',
    (() => {
      const previous = process.env.DSH_CORE_ROOT
      process.env.DSH_CORE_ROOT = root
      try { return peerMode().real === false } finally {
        if (previous === undefined) delete process.env.DSH_CORE_ROOT
        else process.env.DSH_CORE_ROOT = previous
      }
    })())
  rmSync(base, { recursive: true, force: true })
}

// --- 2. Mixed is its own answer ---------------------------------------------
//
// A real dsh-fs next to a stubbed dsh-tools used to be summarised as "real", and
// a suite that needed the stub then crashed in it. That is the shape a user's own
// node_modules produces, so it cannot stay unrepresentable.
{
  const { base, root } = makeTree({
    '@deepseek-ai/cordis': 'real',
    '@deepseek-ai/dsh-fs': 'real',
    '@deepseek-ai/dsh-tools': 'stub',
  })
  const tree = describeTree(root, HOST_PEERS)
  check('a real+stub tree is reported as mixed', tree.mode === TREE_MODE.MIXED, tree.reason)
  check('the mixed verdict names which package is the stub',
    tree.packages.find(entry => entry.name === '@deepseek-ai/dsh-tools')?.state === PACKAGE_STATE.STUB)
  rmSync(base, { recursive: true, force: true })
}

// --- 3. Resolved-but-unloadable is BROKEN, not absent ------------------------
//
// The exact defect the old ad-hoc check in boot-smoke.mjs had: it caught the
// throw and printed "is not in the core tree". A directory that exists and loads
// a broken module is not missing; telling someone to install it wastes the trip.
{
  const { base, root } = makeTree({
    '@deepseek-ai/cordis': 'real',
    '@deepseek-ai/dsh-fs': 'real',
    '@deepseek-ai/dsh-tools': 'broken',
  })
  const probe = describePackage(root, '@deepseek-ai/dsh-tools')
  check('a package that resolves then throws is BROKEN', probe.state === PACKAGE_STATE.BROKEN, JSON.stringify(probe))
  check('the broken verdict keeps the load error, so the cause is visible',
    /Cannot find package/.test(probe.error ?? ''), String(probe.error))
  check('the broken verdict keeps the resolved path, proving it is on disk',
    typeof probe.resolved === 'string' && probe.resolved.length > 0, String(probe.resolved))
  check('a tree containing a broken package is reported as broken',
    describeTree(root, HOST_PEERS).mode === TREE_MODE.BROKEN)
  rmSync(base, { recursive: true, force: true })
}

// --- 4. Absent is genuinely absent ------------------------------------------
{
  const { base, root } = makeTree({ '@deepseek-ai/cordis': 'real' })
  const probe = describePackage(root, '@deepseek-ai/dsh-fs')
  check('a package with nothing on disk is ABSENT', probe.state === PACKAGE_STATE.ABSENT, JSON.stringify(probe))
  check('an absent package has no load error to show', probe.error === null)
  check('a tree of nothing is reported as absent',
    describeTree(root, ['@deepseek-ai/nope']).mode === TREE_MODE.ABSENT)
  rmSync(base, { recursive: true, force: true })
}

// --- 5. Only the packages a suite names are consulted -----------------------
//
// A tree missing an unrelated peer must not skip work that could have run. This is
// why `requires` is per-suite rather than the whole peer list.
{
  const { base, root } = makeTree({
    '@deepseek-ai/cordis': 'real',
    '@deepseek-ai/dsh-fs': 'real',
    '@deepseek-ai/dsh-tools': 'absent',
  })
  check('a tree lacking an unrelated peer is not real overall',
    describeTree(root, HOST_PEERS).mode !== TREE_MODE.REAL)
  check('a suite that names only dsh-fs still sees its own requirement as real',
    describeTree(root, ['@deepseek-ai/dsh-fs']).mode === TREE_MODE.REAL)
  rmSync(base, { recursive: true, force: true })
}

// --- 6. End to end: a broken tree FAILS the suite, it does not skip it ------
//
// Driven in a child process, because the behaviour under test is `process.exit`.
// A skip here would be the worst outcome available: the run stays green while the
// dependency tree is provably damaged.
{
  const { base, root } = makeTree({
    '@deepseek-ai/cordis': 'real',
    '@deepseek-ai/dsh-fs': 'real',
    '@deepseek-ai/dsh-tools': 'broken',
  })
  const driver = path.join(base, 'driver.mjs')
  writeFileSync(driver, [
    "import { skipWithoutRealPeers } from " + JSON.stringify(pathToFileURL(path.join(pluginRoot, 'tests/support/peer-mode.mjs')).href),
    "skipWithoutRealPeers('detector smoke', 'the real tree', { requires: ['@deepseek-ai/dsh-tools'] })",
    "console.log('SUITE RAN')",
  ].join('\n'), 'utf8')
  const result = spawnSync(process.execPath, [driver], {
    encoding: 'utf8',
    env: { ...process.env, DSH_CORE_ROOT: root },
  })
  check('a broken required package makes the suite FAIL (exit 1)', result.status === 1, `exit ${result.status}`)
  check('the failure says the tree is damaged, not missing',
    /DAMAGED dependency tree, not a missing one/.test(result.stdout), result.stdout.slice(-400))
  check('the failure prints the load error that names the real cause',
    /Cannot find package '@deepseek-ai\/dsh-scope'/.test(result.stdout), result.stdout.slice(-400))
  check('the suite never reached its assertions',
    !/SUITE RAN/.test(result.stdout))
  rmSync(base, { recursive: true, force: true })
}

// --- 7. End to end: a stub tree still SKIPS cleanly -------------------------
{
  const base = scratch()
  const root = installPeerStubs(base)
  const driver = path.join(base, 'driver.mjs')
  writeFileSync(driver, [
    "import { skipWithoutRealPeers } from " + JSON.stringify(pathToFileURL(path.join(pluginRoot, 'tests/support/peer-mode.mjs')).href),
    "skipWithoutRealPeers('detector smoke', 'the real tree', { requires: ['@deepseek-ai/dsh-fs'] })",
    "console.log('SUITE RAN')",
  ].join('\n'), 'utf8')
  const result = spawnSync(process.execPath, [driver], {
    encoding: 'utf8',
    env: { ...process.env, DSH_CORE_ROOT: root },
  })
  check('a stubbed required package skips (exit 0)', result.status === 0, `exit ${result.status}`)
  check('the skip names the state of the package it refused to trust',
    /@deepseek-ai\/dsh-fs=stub/.test(result.stdout), result.stdout.slice(-300))
  check('a skip also never runs the assertions', !/SUITE RAN/.test(result.stdout))
  rmSync(base, { recursive: true, force: true })
}

// --- 8. Unset DSH_CORE_ROOT is absent, not broken --------------------------
{
  const previous = process.env.DSH_CORE_ROOT
  delete process.env.DSH_CORE_ROOT
  try {
    const mode = peerMode()
    check('an unset DSH_CORE_ROOT reports absent', mode.mode === TREE_MODE.ABSENT, JSON.stringify(mode))
    check('an unset DSH_CORE_ROOT is not real', mode.real === false)
    check('an unset DSH_CORE_ROOT explains itself', /DSH_CORE_ROOT is not set/.test(mode.reason), mode.reason)
  } finally {
    if (previous !== undefined) process.env.DSH_CORE_ROOT = previous
  }
}

console.log(`\n=== ${passed} passed, ${failures} failed ===`)
process.exit(failures === 0 ? 0 : 1)
