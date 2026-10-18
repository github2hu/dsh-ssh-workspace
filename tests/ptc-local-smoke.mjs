/**
 * Pure checks for the local PTC (`run_code`) support: recognizing the runtime's
 * own bootstrap child, rewriting its remote cwd, and the scratch directory the
 * child and the sandbox both use.
 *
 * Imports `lib/ptc-local.js`, which depends only on `lib/protocol.js` and Node
 * builtins — the suite runs anywhere.
 *
 * Run: node tests/ptc-local-smoke.mjs
 */

import { existsSync, statSync } from 'node:fs'
import { basename } from 'node:path'

import { isPtcBootstrapSpec, localScratchFor, localizePtcSpec, isRemotePolicy, REMOTE_WORKSPACE_ENV } from '../lib/ptc-local.js'

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
const json = value => JSON.stringify(value)

const NODE = process.platform === 'win32' ? 'C:\\Program Files\\nodejs\\node.exe' : '/usr/bin/node'
const BOOTSTRAP = process.platform === 'win32'
  ? 'C:\\app\\node_modules\\@deepseek-ai\\dsh-ptc-runtime-node\\lib\\process.js'
  : '/app/node_modules/@deepseek-ai/dsh-ptc-runtime-node/lib/process.js'

console.log('\n=== ptc-local smoke ===\n')

console.log('[isPtcBootstrapSpec]')
const CONTROL = { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', control: 'pipe' }
check('recognizes the per-call bootstrap child',
  isPtcBootstrapSpec({ cwd: 'ssh://box/home/u/proj', argv: [NODE, BOOTSTRAP], stdio: CONTROL }) === true)
check('recognizes the persistent-REPL bootstrap child',
  isPtcBootstrapSpec({ cwd: 'ssh://box/home/u/proj', argv: [NODE, '--max-old-space-size=512', BOOTSTRAP.replace('process.js', 'persistent-process.js'), '134217728'], stdio: CONTROL }) === true)
check('recognizes a packaged carrier that passes only size flags',
  isPtcBootstrapSpec({ cwd: 'ssh://box/x', argv: [process.execPath, '--max-old-space-size=512', '134217728'], stdio: CONTROL }) === true)
check('rejects a PTC-shaped child without the control channel',
  isPtcBootstrapSpec({ cwd: 'ssh://box/x', argv: [NODE, BOOTSTRAP] }) === false)
check('rejects git even with a control channel',
  isPtcBootstrapSpec({ cwd: 'ssh://box/x', argv: ['git', 'status'], stdio: CONTROL }) === false)
check('rejects a shell command even with a control channel',
  isPtcBootstrapSpec({ cwd: 'ssh://box/x', argv: ['bash', '-lc', 'ls'], stdio: CONTROL }) === false)
check('rejects a non-array argv', isPtcBootstrapSpec({ cwd: 'ssh://box/x', argv: 'node', stdio: CONTROL }) === false)
check('rejects an empty argv', isPtcBootstrapSpec({ cwd: 'ssh://box/x', argv: [], stdio: CONTROL }) === false)
check('rejects a null spec', isPtcBootstrapSpec(null) === false)

console.log('\n[localScratchFor]')
{
  const first = localScratchFor('ssh://box/home/u/proj')
  const second = localScratchFor('ssh://box/home/u/proj')
  const other = localScratchFor('ssh://box/home/u/other')
  check('is stable for one remote workspace', first === second, `${first} vs ${second}`)
  check('differs per remote workspace', first !== other)
  check('exists on disk', existsSync(first) && statSync(first).isDirectory(), first)
  check('lives under the host temp directory', first.includes('dsh-ssh-workspace-ptc'), first)
}

console.log('\n[localizePtcSpec]')
{
  const spec = { cwd: 'ssh://box/home/u/proj', argv: [NODE, BOOTSTRAP], env: { KEEP: '1' }, stdio: { stdout: 'ignore' } }
  const local = localizePtcSpec(spec)
  check('substitutes the scratch cwd', local.cwd === localScratchFor('ssh://box/home/u/proj'), json(local.cwd))
  check('preserves argv and stdio', json(local.argv) === json(spec.argv) && local.stdio === spec.stdio)
  check('keeps existing env entries', local.env.KEEP === '1')
  check('carries the remote workspace in env', local.env[REMOTE_WORKSPACE_ENV] === spec.cwd, json(local.env))
  check('does not mutate the original spec', spec.cwd === 'ssh://box/home/u/proj' && spec.env[REMOTE_WORKSPACE_ENV] === undefined)
  check('leaves the caller\'s own workspace value alone',
    localizePtcSpec({ ...spec, env: { [REMOTE_WORKSPACE_ENV]: 'ssh://custom/x' } }).env[REMOTE_WORKSPACE_ENV] === 'ssh://custom/x')
  check('scratch basename is not the remote spelling', basename(local.cwd) !== 'proj')
}

console.log('\n[isRemotePolicy]')
check('true for a remote workspace root', isRemotePolicy({ mode: 'workspace-write', workspaceRoot: 'ssh://box/x' }) === true)
check('false for a local root', isRemotePolicy({ mode: 'workspace-write', workspaceRoot: 'C:\\work' }) === false)
check('false for a missing policy', isRemotePolicy(undefined) === false)

console.log(`\n=== ${passes.length} passed, ${failures.length} failed ===`)
if (failures.length > 0) {
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exitCode = 1
}
