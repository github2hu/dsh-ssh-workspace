/**
 * Local execution support for the PTC (`run_code`) tool inside a remote
 * workspace.
 *
 * `run_code` executes model-written TypeScript in a FRESH Node process spawned
 * through `ctx.subprocess`, with the session workspace as its cwd. On a remote
 * workspace that cwd is an `ssh://` spelling: an ordinary local `spawn` cannot
 * chdir into it, and the remote subprocess bridge rejects non-git/ripgrep
 * commands on purpose. Without this module the PTC child therefore never
 * starts and `run_code` reports that it cannot read files at all.
 *
 * The chosen contract is: the program runs LOCALLY, in a private scratch
 * directory, and reaches the workspace through the ordinary agent tools
 * (`read`/`write`/`edit`/`glob`/`grep` bindings), which this plugin already
 * routes over SFTP. The scratch directory is also the confined workspace root
 * handed to `ctx.sandbox`, so a program cannot use its local process to escape
 * into the host filesystem — it can only touch its own scratch area.
 *
 * @module @shiqyka/dsh-ssh-workspace/ptc-local
 */

import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { isRemotePath } from './protocol.js'

/** Environment variable carrying the remote workspace spelling into the child. */
export const REMOTE_WORKSPACE_ENV = 'DSH_REMOTE_PTC_WORKSPACE'

/** Scratch root under the host temp directory. */
const SCRATCH_ROOT = join(tmpdir(), 'dsh-ssh-workspace-ptc')

/** Cache of scratch directories already created in this process. */
const scratchDirs = new Map()

/**
 * The local scratch directory reserved for one remote workspace.
 *
 * The path is derived from the remote spelling, so every `run_code` call in the
 * same workspace reuses one directory and earlier files survive between calls
 * (the PTC provider itself keeps no local state).
 *
 * @param {string} remotePath - the remote workspace spelling.
 * @returns {string} an existing local absolute directory.
 */
export function localScratchFor (remotePath) {
  const key = String(remotePath)
  const existing = scratchDirs.get(key)
  if (existing !== undefined) return existing
  const digest = createHash('sha1').update(key).digest('hex').slice(0, 16)
  const dir = join(SCRATCH_ROOT, digest)
  mkdirSync(dir, { recursive: true })
  scratchDirs.set(key, dir)
  return dir
}

/**
 * Whether a subprocess spec is the PTC runtime's own bootstrap child.
 *
 * The match is deliberately narrow: a Node-like executable, an argument that
 * names the PTC runtime package and one of its two bootstrap entry files, or an
 * embedded carrier that asks to run as Node. Every other command keeps the
 * bridge's loud rejection, because silently running an arbitrary program on the
 * host against a remote cwd would produce quietly wrong answers.
 *
 * @param {object} spec - a `ctx.subprocess` spawn spec.
 * @returns {boolean} true for the PTC bootstrap process only.
 */
export function isPtcBootstrapSpec (spec) {
  if (spec === null || typeof spec !== 'object') return false
  const argv = spec.argv
  if (!Array.isArray(argv) || argv.length < 2) return false
  if (typeof argv[0] !== 'string' || argv[0].trim() === '') return false
  const head = basename(argv[0]).toLowerCase()
  const hostHead = basename(process.execPath).toLowerCase()
  const nodeLike = head === 'node' || head === 'node.exe' || head === hostHead
  if (!nodeLike) return false
  const embedded = typeof spec.env === 'object' && spec.env !== null &&
    spec.env.ELECTRON_RUN_AS_NODE !== undefined
  for (const arg of argv.slice(1)) {
    if (typeof arg !== 'string') continue
    if (!arg.includes('ptc-runtime-node')) continue
    const tail = basename(arg).toLowerCase()
    if (tail === 'process.js' || tail === 'persistent-process.js') return true
    // Source execution may run an inline closure instead of a built bootstrap;
    // a PTC argument on a Node-like head with the carrier marker is still the
    // runtime's own child, never a user command.
    if (embedded) return true
  }
  return false
}

/**
 * Rewrite one remote-cwd spec so the PTC child can actually start locally.
 *
 * `cwd` becomes the scratch directory and the remote spelling travels in the
 * environment; everything else (argv, stdio, env) is preserved so the runtime's
 * control channel still works. A spec that already carries that variable keeps
 * its own value.
 *
 * @param {object} spec - the original spawn spec.
 * @returns {object} a shallow copy safe to hand to the local spawn.
 */
export function localizePtcSpec (spec) {
  const remote = String(spec.cwd)
  const cwd = localScratchFor(remote)
  const env = { ...(spec.env ?? {}) }
  if (env[REMOTE_WORKSPACE_ENV] === undefined) env[REMOTE_WORKSPACE_ENV] = remote
  return { ...spec, cwd, env }
}

/**
 * Whether a sandbox policy targets a remote workspace.
 *
 * @param {object | undefined} policy - a `SandboxPolicy`.
 * @returns {boolean} true when its workspace root is remote.
 */
export function isRemotePolicy (policy) {
  return policy !== null && typeof policy === 'object' && isRemotePath(policy.workspaceRoot)
}
