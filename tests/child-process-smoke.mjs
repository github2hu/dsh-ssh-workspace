/**
 * Pure checks for the git bridge over `node:child_process`.
 *
 * A fake engine stands in for the SSH side, so the suite runs without a host:
 * it asserts WHICH invocations get bridged, what command is sent, how the
 * ChildProcess facade reports success/failure, and that local calls and
 * destructive subcommands are left alone or refused.
 *
 * Run: node tests/child-process-smoke.mjs
 */

import childProcess from 'node:child_process'
import { installChildProcessBridge, uninstallChildProcessBridge, destructiveReasonOf, remoteGitCommand } from '../lib/patch-child-process.js'

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

/** Collect one spawned child's stdout and exit code. */
function settle (child) {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8') })
    child.on('error', error => resolve({ error, stdout, stderr }))
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

const calls = []
const engine = {
  async exec (alias, command, options) {
    calls.push({ alias, command, options })
    if (command.includes('BOOM')) {
      return { success: false, exitCode: 7, timedOut: false, stdout: '', stderr: 'fatal: BOOM', truncated: false }
    }
    return { success: true, exitCode: 0, timedOut: false, stdout: `OUT(${alias}):${command}`, stderr: '', truncated: false }
  },
}

console.log('\n=== child-process (git bridge) smoke ===\n')

console.log('[command construction]')
{
  const command = remoteGitCommand(['status', '--porcelain'], { GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', PATH: '/usr/bin', HOME: '/home/u' })
  check('quotes git arguments into one shell line', command.includes(`git 'status' '--porcelain'`), command)
  check('forwards the git/LC environment', command.includes('LC_ALL=C') || command.includes(`LC_ALL='C'`), command)
  check('drops unrelated environment entries', !command.includes('PATH=') && !command.includes('HOME='), command)
}

console.log('[destructive guard]')
check('refuses push --force', destructiveReasonOf(['push', '--force', 'origin', 'main']) !== undefined)
check('refuses push -f', destructiveReasonOf(['push', '-f']) !== undefined)
check('refuses reset --hard', destructiveReasonOf(['reset', '--hard', 'HEAD~1']) !== undefined)
check('refuses clean -fd', destructiveReasonOf(['clean', '-fd']) !== undefined)
check('refuses branch -D', destructiveReasonOf(['branch', '-D', 'topic']) !== undefined)
check('allows plain status', destructiveReasonOf(['status', '--porcelain']) === undefined)
check('allows plain commit', destructiveReasonOf(['commit', '-m', 'msg']) === undefined)
check('allows plain push', destructiveReasonOf(['push', 'origin', 'main']) === undefined)

console.log('[spawn bridge]')
const state = installChildProcessBridge({ engine, logger: undefined })
check('installed on the builtin', typeof childProcess.spawn === 'function' && childProcess.spawn !== state.originals.spawn)

{
  calls.length = 0
  const child = childProcess.spawn('git', ['-C', 'ssh://box/srv/repo', '--no-pager', '-c', 'color.ui=false', 'status', '--porcelain'], { stdio: ['ignore', 'pipe', 'pipe'] })
  const result = await settle(child)
  check('bridged a remote status call', calls.length === 1, json(calls.length))
  check('used the parsed alias', calls[0]?.alias === 'box', json(calls[0]?.alias))
  check('used the parsed remote cwd', calls[0]?.options?.cwd === '/srv/repo', json(calls[0]?.options?.cwd))
  check('rebuilt the argv without the -C target',
    typeof calls[0]?.command === 'string' &&
      calls[0].command.includes(`git `) &&
      calls[0].command.includes(`'status'`) &&
      !calls[0].command.includes('ssh://') &&
      !calls[0].command.includes(`'-C'`), json(calls[0]?.command))
  check('closed with exit code 0', result.code === 0, json(result.code))
  check('delivered stdout through the stream', String(result.stdout).includes('OUT(box)'), json(result.stdout))
}

{
  calls.length = 0
  const child = childProcess.spawn('git', ['-C', 'ssh://box/srv/repo', 'status', 'BOOM'])
  const result = await settle(child)
  check('reports a non-zero exit code', result.code === 7, json(result.code))
  check('delivers stderr for the caller error message', String(result.stderr).includes('fatal: BOOM'), json(result.stderr))
}

{
  calls.length = 0
  const child = childProcess.spawn('git', ['-C', 'ssh://box/srv/repo', 'push', '--force'])
  const result = await settle(child)
  check('refuses a destructive command instead of running it', calls.length === 0 && result.error instanceof Error, json(calls.length))
  check('the refusal names the command', String(result.error?.message).includes('push --force'), String(result.error?.message))
}

{
  calls.length = 0
  const child = childProcess.spawn(process.execPath, ['-e', 'process.stdout.write("local")'], { stdio: ['ignore', 'pipe', 'pipe'] })
  const result = await settle(child)
  check('forwards a non-git command to the builtin', calls.length === 0, json(calls.length))
  check('the forwarded child really ran', String(result.stdout).includes('local'), json(result.stdout))
}

{
  calls.length = 0
  const child = childProcess.spawn('git', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] })
  const result = await settle(child)
  check('forwards a local git call to the builtin', calls.length === 0, json(calls.length))
  check('the local git child produced output or an error without bridging', typeof result.stdout === 'string', json(result.code))
}

console.log('[execFile bridge]')
{
  calls.length = 0
  const answer = await new Promise((resolve) => {
    childProcess.execFile('git', ['-C', 'ssh://box/srv/repo', '--no-pager', 'rev-parse', 'HEAD'], { encoding: 'utf8' }, (error, stdout, stderr) => resolve({ error, stdout, stderr }))
  })
  check('bridged a remote execFile call', calls.length === 1 && calls[0]?.alias === 'box', json(calls.length))
  check('callback got no error for success', answer.error === null || answer.error === undefined, String(answer.error))
  check('callback got the remote stdout', String(answer.stdout).includes('OUT(box)'), json(answer.stdout))
}
{
  calls.length = 0
  const answer = await new Promise((resolve) => {
    childProcess.execFile('git', ['-C', 'ssh://box/srv/repo', 'status', 'BOOM'], {}, (error, stdout, stderr) => resolve({ error, stdout, stderr }))
  })
  check('callback error carries the exit code', answer.error?.code === 7, json(answer.error?.code))
  check('callback stderr is the remote stderr', String(answer.stderr).includes('fatal: BOOM'), json(answer.stderr))
}
{
  calls.length = 0
  const answer = await new Promise((resolve) => {
    childProcess.execFile('git', ['-C', 'ssh://box/srv/repo', 'reset', '--hard'], {}, (error) => resolve({ error }))
  })
  check('execFile refuses a destructive command', calls.length === 0 && answer.error instanceof Error, json(calls.length))
}

console.log('[teardown]')
uninstallChildProcessBridge()
check('restores the original spawn', childProcess.spawn === state.originals.spawn)
calls.length = 0
{
  const child = childProcess.spawn('git', ['-C', 'ssh://box/srv/repo', 'status'])
  await settle(child)
  check('does not bridge after uninstall', calls.length === 0, json(calls.length))
}

console.log(`\n=== ${passes.length} passed, ${failures.length} failed ===`)
if (failures.length > 0) {
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exitCode = 1
}
