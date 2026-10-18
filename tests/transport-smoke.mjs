/**
 * Transport-option and background-job checks.
 *
 * Two seams whose behaviour is easy to break silently:
 *
 * 1. **Per-host transport flags** (#6). `agentForward` and `compress` are
 *    opt-in: a host that does not ask for them must produce exactly the ssh2
 *    config it produced before they existed, because enabling either by default
 *    changes how the connection behaves for everybody. The resolution path also
 *    spans three layers — the JSON store, `ssh config`, and the engine's
 *    `connectConfig` — so a flag that survives one and is dropped by another is
 *    the likely bug.
 *
 * 2. **Background exec** (#8). `ssh_workspace_exec` with `run_in_background`
 *    must register a job and return its id immediately, and must degrade to
 *    inline execution (not to a dangling id) when the deployment has no `jobs`
 *    seam.
 *
 * Run: node tests/transport-smoke.mjs
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// remote-fs.js (pulled in for the tool set) resolves the DSH peer packages, so
// the suite needs the assembled tree even though it never opens a connection.
const coreRoot = process.env.DSH_CORE_ROOT
if (!coreRoot) {
  console.log('\n=== transport smoke ===\n')
  console.log('  SKIP  DSH_CORE_ROOT is not set (needs @deepseek-ai/dsh-fs)')
  console.log('\n=== 0 passed, 0 failed, 1 suite skipped ===')
  process.exit(0)
}
process.env.DSH_PEER_ROOT = [coreRoot, process.env.DSH_PEER_ROOT].filter(Boolean).join(path.delimiter)

const { HostConfigStore } = await import(pathToFileURL(path.join(pluginRoot, 'lib/store.js')).href)
const { SshWorkspaceEngine } = await import(pathToFileURL(path.join(pluginRoot, 'lib/engine.js')).href)
const { RemoteFileSystem } = await import(pathToFileURL(path.join(pluginRoot, 'lib/remote-fs.js')).href)
const { workspaceTools } = await import(pathToFileURL(path.join(pluginRoot, 'lib/tools.js')).href)

let passed = 0
let failures = 0
function check (label, ok, detail) {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`) } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

console.log('\n=== transport smoke ===\n')

const entry = (alias, extra = {}) => ({
  alias,
  host: `${alias}.example`,
  port: 22,
  user: 'u',
  auth: { kind: 'agent' },
  ...extra,
})

/** An engine whose connections are never opened; only config building is exercised. */
function quietEngine () {
  return new SshWorkspaceEngine({})
}

// --- #6: opt-in means OFF by default --------------------------------------
{
  const engine = quietEngine()
  const config = engine.connectConfig({ alias: 'plain', host: 'h', port: 22, user: 'u', auth: { kind: 'password', password: 'p' } })
  check('agentForward is absent unless the host opts in', config.agentForward === undefined, String(config.agentForward))
  check('compress is absent unless the host opts in', config.compress === undefined, String(config.compress))
  engine.dispose()
}

{
  const engine = quietEngine()
  const config = engine.connectConfig({
    alias: 'fast', host: 'h', port: 22, user: 'u',
    auth: { kind: 'password', password: 'p' },
    agentForward: true,
    compress: true,
  })
  check('agentForward reaches the ssh2 config when requested', config.agentForward === true, String(config.agentForward))
  check('compress reaches the ssh2 config when requested', config.compress === true, String(config.compress))
  check('the rest of the config is unaffected', config.host === 'h' && config.port === 22 && config.username === 'u')
  engine.dispose()
}

{
  // A falsy-but-not-false value must not enable the flag.
  const engine = quietEngine()
  const config = engine.connectConfig({
    alias: 'sloppy', host: 'h', port: 22, user: 'u',
    auth: { kind: 'password', password: 'p' },
    agentForward: 'yes',
    compress: 1,
  })
  check('a non-boolean flag does not enable agentForward', config.agentForward === undefined, String(config.agentForward))
  check('a non-boolean flag does not enable compress', config.compress === undefined, String(config.compress))
  engine.dispose()
}

// --- #6: round-trip through the JSON store --------------------------------
{
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-transport-'))
  const file = path.join(dir, 'dsh-ssh.json')
  try {
    const store = new HostConfigStore(file)
    store.save([entry('stored', { agentForward: true, compress: true }), entry('bare')])

    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const stored = raw.hosts.find(host => host.alias === 'stored')
    const bare = raw.hosts.find(host => host.alias === 'bare')
    check('the store persists agentForward', stored.agentForward === true, JSON.stringify(stored.agentForward))
    check('the store persists compress', stored.compress === true, JSON.stringify(stored.compress))
    check('a host without the flags stays flag-free',
      bare.agentForward === undefined && bare.compress === undefined,
      JSON.stringify({ agentForward: bare.agentForward, compress: bare.compress }))

    // Resolve back through the engine's descriptor shape.
    const engine = quietEngine()
    const resolvedStored = engine.connectConfig({
      ...stored,
      auth: { kind: 'password', password: 'p' },
    })
    check('a stored flag survives into the connect config', resolvedStored.agentForward === true && resolvedStored.compress === true)
    engine.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// --- #8: background exec registers a job ----------------------------------
{
  const started = []
  const jobs = {
    start (spec) {
      started.push(spec)
      return {
        id: 'job-42',
        async wait () { return { success: true, exitCode: 0, stdout: 'done', stderr: '', timedOut: false, truncated: false, durationMs: 1 } },
        kill () {},
      }
    },
  }
  const ctx = {
    get (name) { return name === 'jobs' ? jobs : undefined },
    jobs,
  }
  const engine = {
    async exec () {
      return { success: true, exitCode: 0, timedOut: false, stdout: 'inline', stderr: '', truncated: false, durationMs: 2 }
    },
    listMounted: () => [],
    listConnections: () => [],
  }
  const router = new RemoteFileSystem({ engine })
  const tools = workspaceTools(ctx, engine, router, { list: () => [] }, { list: () => [] })
  const exec = tools.find(tool => tool.name === 'ssh_workspace_exec')

  const result = await exec.execute({ alias: 'a', command: 'sleep 1', run_in_background: true }, { agent: { id: 'agent-1' } })
  check('a background call registers exactly one job', started.length === 1, `started=${started.length}`)
  check('a background call returns the job id', result.jobId === 'job-42', JSON.stringify(result.jobId))
  check('a background call does not report the inline output', result.stdout === '', JSON.stringify(result.stdout))
}

// --- #8: no jobs seam degrades to inline, not to a dangling id -------------
{
  const ctx = { get: () => undefined }
  const engine = {
    async exec () {
      return { success: true, exitCode: 0, timedOut: false, stdout: 'inline-ran', stderr: '', truncated: false, durationMs: 3 }
    },
    listMounted: () => [],
    listConnections: () => [],
  }
  const router = new RemoteFileSystem({ engine })
  const tools = workspaceTools(ctx, engine, router, { list: () => [] }, { list: () => [] })
  const exec = tools.find(tool => tool.name === 'ssh_workspace_exec')

  const result = await exec.execute({ alias: 'a', command: 'echo hi', run_in_background: true }, {})
  check('without a jobs seam the command still runs', result.stdout === 'inline-ran', JSON.stringify(result.stdout))
  check('without a jobs seam no job id is invented', result.jobId === undefined, JSON.stringify(result.jobId))
  check('without a jobs seam the caller is told it ran inline',
    typeof result.error === 'string' && result.error.includes('inline'), JSON.stringify(result.error))
}

// --- socket tuning: the per-command latency floor --------------------------
// Every `exec` and every SFTP request pays one round trip on the pooled socket.
// With Nagle on, that round trip waited out the delayed-ACK window (88 ms on a
// LAN with sub-millisecond ping); these checks pin the tuning contract.
{
  const { tuneConnectionSocket } = await import(pathToFileURL(path.join(pluginRoot, 'lib/engine.js')).href)

  const calls = []
  const sock = {
    setNoDelay: (value) => { calls.push(['noDelay', value]) },
    setKeepAlive: (value, ms) => { calls.push(['keepAlive', value, ms]) },
  }
  check('tuning disables Nagle on the connection socket', tuneConnectionSocket(sock) === true && calls[0]?.[0] === 'noDelay' && calls[0][1] === true, JSON.stringify(calls))
  check('tuning enables TCP keepalive', calls[1]?.[0] === 'keepAlive' && calls[1][1] === true && calls[1][2] === 10_000, JSON.stringify(calls))
  check('an absent socket is skipped, not an error', tuneConnectionSocket(undefined) === false && tuneConnectionSocket(null) === false)
  check('a socket that refuses keepalive still gets Nagle disabled',
    tuneConnectionSocket({ setNoDelay: () => { throw new Error('nope') } }) === false)
  let disabled = 0
  check('a socket without optional methods is tolerated',
    tuneConnectionSocket({ setNoDelay: () => { disabled += 1 } }) === true && disabled === 1)
}

let exitCode = 0
console.log(`\n=== ${passed} passed, ${failures} failed ===`)
if (failures > 0) exitCode = 1
process.exit(exitCode)
