/**
 * Bridge `node:child_process` git invocations onto the remote host.
 *
 * The Host's builtin sidebars (the source-control panel in `dsh-better-sidebar`
 * is one) read git state by spawning the SYSTEM `git` binary directly —
 * `spawn('git', ['-C', cwd, …])` and `execFile('git', ['-C', cwd, …])` — with a
 * `cwd` that is the session workspace. On a remote workspace that spelling is
 * `ssh://<alias>/<path>`, which a local `git` cannot use, so the panel reports
 * "not a git repository" even though the remote tree is a healthy repository.
 *
 * This module patches those two entry points: an invocation whose `-C` target
 * (or explicit `cwd` option) is remote runs on the host through the SSH engine
 * instead, and the answer is replayed through a ChildProcess-shaped object
 * (`stdout`/`stderr` streams, `error`, `close`, `kill`) or through the
 * `execFile` callback, so the caller's existing parsing is untouched.
 *
 * Only `git` is bridged. Every other command, and every local `git` call, is
 * forwarded to the original function bound to the builtin — the host's behavior
 * is unchanged for them.
 *
 * Destructive subcommands are refused here and must be run from a remote
 * terminal: the sidebar's buttons have no confirmation surface, and silently
 * rewriting history from a stray click is not a risk worth taking.
 *
 * @module @shiqyka/dsh-ssh-workspace/patch-child-process
 */

import childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { syncBuiltinESMExports } from 'node:module'
import { PassThrough } from 'node:stream'
import { shellQuote } from './engine.js'
import { isRemotePath, normalizeRemotePath, parseRemotePath } from './protocol.js'

/** Instance marker proving this module already patched the builtin. */
export const INSTALLED = Symbol.for('dsh-ssh-workspace.child-process-installed')

/** Environment families forwarded to the remote git invocation. */
const ENV_NAME_RE = /^(GIT_[A-Z_]+|LC_[A-Z_]+|LANG|LANGUAGE)$/u

/** Default per-invocation budget; the sidebar's own timers are usually shorter. */
const DEFAULT_TIMEOUT_MS = 30_000

/** Default capture cap, matching the sidebar's own 8 MiB stdout budget. */
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024

/** `git rev-parse` flags whose whole answer is one remote path. */
const PATH_FLAGS = new Set(['--show-toplevel', '--absolute-git-dir', '--show-superproject-working-tree'])

/**
 * Turn one remote POSIX path into the `ssh://` spelling the workspace uses.
 *
 * @param {string} alias - host alias.
 * @param {string} remotePath - remote absolute path.
 * @returns {string} the `ssh://` spelling.
 */
function sshSpelling (alias, remotePath) {
  return `ssh://${alias}${normalizeRemotePath(remotePath)}`
}

/**
 * Rewrite the path-shaped answers of the git commands whose output the sidebar
 * feeds back into `node:path` and `node:fs`.
 *
 * The Host's own path helpers treat a bare POSIX path as a local absolute path
 * (on Windows `C:\home\…`), so a `--show-toplevel` answer of
 * `/home/u/repo` silently turns the session's remote cwd into a host path and
 * every following git call misses the bridge. Answering in the workspace's own
 * `ssh://` spelling keeps the caller inside the remote world — the plugin's
 * `node:path`/`node:fs` bridge already understands that spelling.
 *
 * Only single-path answers are rewritten; `git log`, `status` and `diff` bodies
 * are left byte-identical, because their paths are workspace-relative.
 *
 * @param {string[]} argv - git arguments.
 * @param {string} alias - host alias.
 * @param {string} cwd - remote absolute working directory.
 * @param {string} stdout - the raw remote stdout.
 * @returns {string} the translated stdout.
 */
export function translateGitPaths (argv, alias, cwd, stdout) {
  if (typeof stdout !== 'string' || stdout === '') return stdout
  const has = flag => argv.includes(flag)
  if (has('rev-parse')) {
    if ([...PATH_FLAGS].some(has)) {
      return stdout.split('\n').map((line) => {
        const value = line.trim()
        return value.startsWith('/') ? sshSpelling(alias, value) : line
      }).join('\n')
    }
    if (has('--git-dir') || has('--git-common-dir')) {
      return stdout.split('\n').map((line) => {
        const value = line.trim()
        if (value === '') return line
        if (value.startsWith('/')) return sshSpelling(alias, value)
        const joined = cwd === '/' ? `/${value}` : `${cwd}/${value}`
        return sshSpelling(alias, joined)
      }).join('\n')
    }
  }
  if (has('worktree') && has('list')) {
    return stdout.split('\n').map((line) => {
      if (!line.startsWith('worktree ')) return line
      const value = line.slice('worktree '.length).trim()
      return value.startsWith('/') ? `worktree ${sshSpelling(alias, value)}` : line
    }).join('\n')
  }
  return stdout
}

/**
 * The remote target of one `git` invocation, or undefined when the call is local.
 *
 * Both carrier shapes are recognised: `['-C', 'ssh://…', …]` (what the sidebar
 * passes explicitly) and an `options.cwd` that is remote (an implicit cwd).
 *
 * @param {string} command - the spawned executable.
 * @param {string[]} args - its argv.
 * @param {object | undefined} options - spawn/execFile options.
 * @returns {{alias: string, cwd: string, argv: string[]} | undefined} the target.
 */
function remoteTargetOf (command, args, options) {
  if (command !== 'git' || !Array.isArray(args)) return undefined
  let cwd
  let argv
  if (args[0] === '-C' && typeof args[1] === 'string') {
    cwd = args[1]
    argv = args.slice(2)
  } else if (options !== null && typeof options === 'object' && typeof options.cwd === 'string') {
    cwd = options.cwd
    argv = args.slice()
  } else {
    return undefined
  }
  if (!isRemotePath(cwd)) return undefined
  let parts
  try {
    parts = parseRemotePath(cwd)
  } catch {
    return undefined
  }
  if (parts === undefined) return undefined
  return { alias: parts.alias, cwd: parts.remotePath, argv }
}

/**
 * Why one git invocation is destructive, or undefined when it is ordinary.
 *
 * The check is deliberately lexical and broad: a false refusal costs the user a
 * terminal command, while a false permission silently rewrites a repository.
 *
 * @param {string[]} argv - git arguments (the subcommand plus its options).
 * @returns {string | undefined} a human-readable reason.
 */
export function destructiveReasonOf (argv) {
  const has = (subcommand) => argv.includes(subcommand)
  const optionStartingWith = (prefix) => argv.some(arg => arg.startsWith(prefix))
  if (has('push') && (optionStartingWith('--force') || argv.includes('-f') || argv.includes('--mirror') || argv.includes('--delete'))) {
    return 'git push --force/--mirror/--delete'
  }
  if (has('reset') && argv.includes('--hard')) return 'git reset --hard'
  if (has('clean') && optionStartingWith('-f')) return 'git clean -f'
  if (has('checkout') && (argv.includes('-f') || argv.includes('--force'))) return 'git checkout --force'
  if (has('branch') && optionStartingWith('-D')) return 'git branch -D'
  if (has('update-ref')) return 'git update-ref'
  if (has('reflog') && has('expire')) return 'git reflog expire'
  if (has('gc') && argv.includes('--prune')) return 'git gc --prune'
  if (has('filter-branch') || has('filter-repo')) return 'git filter-branch/filter-repo'
  return undefined
}

/**
 * Build the shell command line for one remote git invocation.
 *
 * @param {string[]} argv - git arguments.
 * @param {object | undefined} env - the caller's environment.
 * @returns {string} the command to run remotely.
 */
export function remoteGitCommand (argv, env) {
  const assignments = []
  if (env !== null && typeof env === 'object') {
    for (const [name, value] of Object.entries(env)) {
      if (typeof value !== 'string' || !ENV_NAME_RE.test(name)) continue
      assignments.push(`${name}=${shellQuote(value)}`)
    }
  }
  // `GIT_TERMINAL_PROMPT=0` keeps a push from blocking on a credential prompt
  // nobody can answer over an exec channel.
  if (!assignments.some(assignment => assignment.startsWith('GIT_TERMINAL_PROMPT='))) {
    assignments.push('GIT_TERMINAL_PROMPT=0')
  }
  return `${assignments.join(' ')} git ${argv.map(shellQuote).join(' ')}`
}

/**
 * Run one remote git invocation, enforcing the destructive guard first.
 *
 * @param {object} state - the installed bridge state.
 * @param {{alias: string, cwd: string, argv: string[]}} target - the parsed target.
 * @param {object} options - per-run options.
 * @param {object | undefined} options.env - the caller's environment.
 * @param {number | undefined} options.timeoutMs - caller timeout.
 * @param {number | undefined} options.maxBuffer - caller capture cap.
 * @param {AbortSignal} [signal] - cancellation.
 * @returns {Promise<object>} the engine outcome.
 */
async function runRemoteGit (state, target, options, signal) {
  const reason = destructiveReasonOf(target.argv)
  if (reason !== undefined) {
    rememberCall(state, target, undefined, new Error(`refused ${reason}`))
    throw new Error(`ssh-workspace: refused ${reason} on a remote workspace from the sidebar — run it in the remote terminal`)
  }
  const command = remoteGitCommand(target.argv, options.env)
  try {
    const outcome = await state.engine.exec(target.alias, command, {
      cwd: target.cwd,
      timeoutMs: Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS,
      maxOutputBytes: Number.isFinite(options.maxBuffer) ? options.maxBuffer : DEFAULT_MAX_BYTES,
      signal,
    })
    const translated = {
      ...outcome,
      stdout: translateGitPaths(target.argv, target.alias, target.cwd, outcome.stdout),
    }
    rememberCall(state, target, translated)
    return translated
  } catch (error) {
    rememberCall(state, target, undefined, error)
    throw error
  }
}

/**
 * Append one intercepted invocation to the bounded diagnostic ring.
 *
 * The ring is what the `/api/dsh-ssh-workspace/diagnostics` route reports, so a
 * sidebar that still says "not a git repository" can be told apart from a bridge
 * that never saw its call at all.
 *
 * @param {object} state - the installed bridge state.
 * @param {{alias: string, cwd: string, argv: string[]}} target - the parsed target.
 * @param {object} [outcome] - the engine outcome, when the run settled.
 * @param {Error} [error] - the failure, when it did not.
 * @returns {void}
 */
function rememberCall (state, target, outcome, error) {
  const entry = {
    at: new Date().toISOString(),
    alias: target.alias,
    cwd: target.cwd,
    argv: target.argv,
    ok: error === undefined && outcome?.success === true,
    exitCode: Number.isInteger(outcome?.exitCode) ? outcome.exitCode : null,
    ...(error === undefined ? {} : { error: String(error?.message ?? error) }),
  }
  state.calls.push(entry)
  if (state.calls.length > 32) state.calls.shift()
}

/**
 * What the git bridge has intercepted in this process.
 *
 * @returns {{installed: boolean, calls: object[]}} the diagnostic snapshot.
 */
export function childProcessBridgeDiagnostics () {
  const state = globalThis[INSTALLED]
  if (state === undefined) return { installed: false, calls: [] }
  return { installed: true, calls: state.calls.slice(-32) }
}

/**
 * A ChildProcess-shaped facade over one buffered remote run.
 *
 * The sidebar consumes `stdout.on('data')`, `stderr.on('data')`, `close` (with
 * the exit code) and `kill` (its timeout path), so those are what this provides.
 * Output is delivered as a single chunk right before `close`: git's own writers
 * parse complete text, never incremental state.
 *
 * @param {(signal: AbortSignal) => Promise<object>} run - the remote execution.
 * @returns {EventEmitter} the child facade.
 */
function remoteChild (run) {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdin = null
  child.pid = -1
  child.killed = false
  const controller = new AbortController()
  child.kill = () => {
    child.killed = true
    controller.abort()
    return true
  }
  queueMicrotask(async () => {
    let code = null
    try {
      const outcome = await run(controller.signal)
      if (typeof outcome.stdout === 'string' && outcome.stdout !== '') child.stdout.write(outcome.stdout)
      if (typeof outcome.stderr === 'string' && outcome.stderr !== '') child.stderr.write(outcome.stderr)
      if (outcome.success === true) code = 0
      else if (Number.isInteger(outcome.exitCode)) code = outcome.exitCode
      else code = 1
      if (outcome.timedOut === true && child.killed !== true) code = null
    } catch (error) {
      child.stdout.end()
      child.stderr.end()
      child.emit('error', error instanceof Error ? error : new Error(String(error)))
      return
    }
    child.stdout.end()
    child.stderr.end()
    child.emit('close', code, null)
  })
  return child
}

/**
 * Install the git bridge over the live `node:child_process` builtin.
 *
 * @param {object} options - install options.
 * @param {object} options.engine - the live SSH engine.
 * @param {object} [options.logger] - a Cordis logger.
 * @returns {object} the bridge state (also stored on globalThis for re-installs).
 */
export function installChildProcessBridge (options) {
  const existing = globalThis[INSTALLED]
  if (existing !== undefined) {
    existing.engine = options.engine
    existing.logger = options.logger
    return existing
  }
  const originalSpawn = childProcess.spawn
  const originalExecFile = childProcess.execFile
  if (typeof originalSpawn !== 'function' || typeof originalExecFile !== 'function') {
    throw new Error('ssh-workspace: node:child_process is missing spawn/execFile; the git bridge cannot install')
  }
  const state = {
    engine: options.engine,
    logger: options.logger,
    originals: { spawn: originalSpawn, execFile: originalExecFile },
    calls: [],
  }

  childProcess.spawn = function spawn (command, args, spawnOptions) {
    const target = remoteTargetOf(command, args, spawnOptions)
    if (target === undefined) return originalSpawn.call(childProcess, command, args, spawnOptions)
    state.logger?.info?.(`ssh-workspace: running git ${target.argv[0] ?? ''} on ${target.alias} for a remote workspace`)
    return remoteChild(signal => runRemoteGit(state, target, {
      env: spawnOptions?.env,
      timeoutMs: spawnOptions?.timeout,
    }, signal))
  }

  childProcess.execFile = function execFile (file, args, execOptions, callback) {
    const options = typeof execOptions === 'function' ? {} : (execOptions ?? {})
    const done = typeof execOptions === 'function' ? execOptions : callback
    const target = remoteTargetOf(file, args, options)
    if (target === undefined) {
      return typeof execOptions === 'function'
        ? originalExecFile.call(childProcess, file, args, execOptions)
        : originalExecFile.call(childProcess, file, args, execOptions, callback)
    }
    const controller = new AbortController()
    const child = new EventEmitter()
    child.kill = () => { controller.abort(); return true }
    queueMicrotask(async () => {
      let outcome
      try {
        outcome = await runRemoteGit(state, target, { env: options.env, timeoutMs: options.timeout, maxBuffer: options.maxBuffer }, controller.signal)
      } catch (error) {
        if (typeof done === 'function') done(error, '', '')
        return
      }
      const stdout = typeof outcome.stdout === 'string' ? outcome.stdout : ''
      const stderr = typeof outcome.stderr === 'string' ? outcome.stderr : ''
      if (outcome.success === true) {
        if (typeof done === 'function') done(null, stdout, stderr)
        return
      }
      const error = new Error(stderr.trim() !== '' ? stderr.trim() : `git exited with ${String(outcome.exitCode)}`)
      error.code = Number.isInteger(outcome.exitCode) ? outcome.exitCode : 1
      error.killed = false
      error.signal = null
      if (typeof done === 'function') done(error, stdout, stderr)
    })
    return child
  }

  // The sidebar may already have loaded its named imports; re-syncing the ESM
  // facades is what makes the patched functions visible to it (see fs-shim.js).
  syncBuiltinESMExports()
  globalThis[INSTALLED] = state
  options.logger?.info?.('ssh-workspace: bridged node:child_process git invocations for ssh:// workspaces')
  return state
}

/**
 * Undo {@link installChildProcessBridge}.
 *
 * @returns {void}
 */
export function uninstallChildProcessBridge () {
  const state = globalThis[INSTALLED]
  if (state === undefined) return
  childProcess.spawn = state.originals.spawn
  childProcess.execFile = state.originals.execFile
  syncBuiltinESMExports()
  delete globalThis[INSTALLED]
}
