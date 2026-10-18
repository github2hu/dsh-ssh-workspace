/**
 * Keep `ctx.sandbox` usable for a child whose workspace root is remote.
 *
 * The PTC provider resolves its file policy from the session's standing policy,
 * whose `workspaceRoot` is the session workspace — an `ssh://` spelling on a
 * remote workspace. A local sandbox backend cannot confine a process to a
 * directory that only exists on another machine, so the confinement call fails
 * (or fences every write) before the program ever starts.
 *
 * The remote half therefore substitutes the same local scratch directory the
 * subprocess bridge hands the PTC child (see ptc-local.js): the program is
 * confined to its own scratch area and reaches the workspace exclusively
 * through the agent tools, which are fenced by the remote workspace set instead.
 * Every non-remote policy is forwarded unchanged, so local behavior is not
 * touched at all.
 *
 * @module @shiqyka/dsh-ssh-workspace/patch-sandbox
 */

import { isRemotePolicy, localScratchFor } from './ptc-local.js'

/** Instance marker proving this module already patched the service. */
export const INSTALLED = Symbol.for('dsh-ssh-workspace.sandbox-installed')

/**
 * Install the remote-aware `confine()` onto the live `ctx.sandbox` service.
 *
 * A service without `confine` (or no sandbox service at all) is left alone: the
 * PTC provider then keeps its own behavior instead of receiving a half patch.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - host plugin context.
 * @param {object} [options] - install options.
 * @param {object} [options.logger] - a Cordis logger, when available.
 * @returns {{confine: Function} | undefined} the router, or undefined when unavailable.
 */
export function installRemoteSandbox (ctx, options = {}) {
  const target = ctx.get('sandbox')
  if (target === undefined || target === null) return undefined
  if (target[INSTALLED] !== undefined) return target[INSTALLED]
  const original = target.confine
  if (typeof original !== 'function') return undefined
  const base = original.bind(target)
  const router = {
    /**
     * Confine one argv under a policy, substituting a local root for a remote one.
     *
     * @param {readonly string[]} argv - the argv about to be spawned.
     * @param {object} policy - the file-effect policy.
     * @param {AbortSignal} [signal] - cancellation.
     * @returns {Promise<object>} the confined argv and enforcement facts.
     */
    async confine (argv, policy, signal) {
      if (!isRemotePolicy(policy)) return base(argv, policy, signal)
      const scratch = localScratchFor(policy.workspaceRoot)
      options.logger?.info?.(`ssh-workspace: confining a local child to a scratch root for remote workspace ${policy.workspaceRoot}`)
      return base(argv, { ...policy, workspaceRoot: scratch }, signal)
    },
  }
  Object.defineProperty(target, 'confine', { value: router.confine, writable: true, configurable: true, enumerable: false })
  Object.defineProperty(target, INSTALLED, { value: router, writable: false, configurable: true, enumerable: false })
  options.logger?.info?.('ssh-workspace: took over ctx.sandbox for remote workspace roots')
  return router
}

/**
 * Undo {@link installRemoteSandbox}, restoring the original `confine`.
 *
 * @param {object | undefined} target - the patched service instance.
 * @returns {void}
 */
export function uninstallRemoteSandbox (target) {
  if (target === undefined || target === null) return
  if (target[INSTALLED] === undefined) return
  if (Object.hasOwn(target, 'confine')) delete target.confine
  delete target[INSTALLED]
}
