/**
 * SSH engine: one persistent ssh2 connection per host alias, plus the
 * promisified SFTP surface the remote filesystem backend is built on.
 *
 * Each connection carries a shared SFTP channel plus a lazily-opened second
 * channel that long streaming reads ride (`streamChannel`), so a large file
 * transfer does not make stats, listings and the change watcher queue behind
 * it. Every connection verifies the server's host key: trust on first use
 * records the SHA256 fingerprint in the shared host store, and a later key
 * that differs refuses the connection instead of silently trusting it. The
 * refusal message names both fingerprints and points at the panel's "forget
 * host key" action.
 *
 * @module @shiqyka/dsh-ssh-workspace/engine
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import { requirePeer } from './peers.js'
import { HostStore, expandHome } from './hosts.js'
import { isInsideAnyRemoteWorkspace, normalizeRemotePath } from './protocol.js'

const { Client } = requirePeer('ssh2')

/** Engine defaults; every entry is overridable through the constructor. */
const DEFAULTS = {
  idleTimeoutMs: 30 * 60_000,
  connectTimeoutMs: 15_000,
  keepaliveIntervalMs: 15_000,
  sweepIntervalMs: 60_000,
}

/** Take a positive finite number from the options, falling back otherwise. */
function tuningOf (value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * Tune the TCP socket under one ssh2 connection.
 *
 * ssh2 writes every request as a small segment. With Nagle left on and the
 * peer delaying its acknowledgement, each round trip of a command or an SFTP
 * request waits out the ~40 ms delayed-ACK window — twice, which measured as an
 * 88 ms floor per `exec` on a LAN whose ping is under a millisecond. Disabling
 * Nagle drops that floor to 6 ms, so the command itself becomes the cost. The
 * handle is ssh2's internal socket, so the tuning is best-effort: an absent or
 * unusual socket is skipped rather than failing the connection.
 *
 * @param {object | null | undefined} sock - the raw socket beneath the client.
 * @returns {boolean} whether a socket was tuned.
 */
export function tuneConnectionSocket (sock) {
  if (sock === undefined || sock === null) return false
  try {
    sock.setNoDelay?.(true)
    sock.setKeepAlive?.(true, 10_000)
    return true
  } catch {
    return false
  }
}

/** Translate a raw ssh2/SFTP failure into a stable `code` we can branch on. */
function ftpCodeOf (error) {
  const code = error?.code
  // ssh2 surfaces SFTP status codes numerically; 2 is NO_SUCH_FILE.
  if (code === 2 || error?.message?.includes('No such file')) return 'ENOENT'
  if (code === 4 || error?.message?.includes('Failure')) return 'EIO'
  if (code === 3 || error?.message?.includes('Permission denied')) return 'EACCES'
  if (typeof code === 'string') return code
  return 'EIO'
}

/**
 * The live remote-target engine.
 *
 * Owns the host store, the connection pool, and one SFTP channel per host,
 * kept open for the life of the connection because a filesystem backend issues
 * many small operations per tool call.
 */
export class SshWorkspaceEngine {
  /**
   * @param {object} [options] - engine options.
   * @param {HostStore} [options.store] - host store override (tests).
   * @param {object} [options.logger] - a Cordis logger, when available.
   * @param {number} [options.idleTimeoutMs] - close connections idle this long.
   * @param {number} [options.connectTimeoutMs] - per-connect handshake budget.
   * @param {number} [options.keepaliveIntervalMs] - ssh2 keepalive interval.
   * @param {number} [options.sweepIntervalMs] - how often idleness is swept.
   */
  constructor (options = {}) {
    this.store = options.store ?? new HostStore()
    this.logger = options.logger
    this.tuning = {
      idleTimeoutMs: tuningOf(options.idleTimeoutMs, DEFAULTS.idleTimeoutMs),
      connectTimeoutMs: tuningOf(options.connectTimeoutMs, DEFAULTS.connectTimeoutMs),
      keepaliveIntervalMs: tuningOf(options.keepaliveIntervalMs, DEFAULTS.keepaliveIntervalMs),
      sweepIntervalMs: tuningOf(options.sweepIntervalMs, DEFAULTS.sweepIntervalMs),
    }
    /** @type {Map<string, object>} alias → live connection record. */
    this.pool = new Map()
    /** @type {Map<string, Promise<object>>} alias → in-flight acquire. */
    this.acquiring = new Map()
    /**
     * Capability probes are answered once per host and then reused. Each probe
     * is one extra round trip at mount time; a mount is rare but a remount of
     * the same host is common, and a tool either exists or does not for the
     * lifetime of a session. Cleared when a record is closed so a reconnect
     * reports the host's current state.
     * @type {Map<string, Record<string, boolean|undefined>>}
     */
    this.capabilities = new Map()
    /** @type {import('./remote-fs.js').RemoteFileSystem | undefined} */
    this.fs = undefined
    /**
     * Remote workspaces the user unloaded: closed for EVERY operation, in every
     * seam this plugin serves (filesystem, shell, subprocess, terminal),
     * while their SSH connection stays usable.
     *
     * It lives on the engine rather than on the filesystem router because the
     * shell and subprocess halves never look at the router, and a workspace
     * that is "off" for reading but still runs commands is not off at all.
     *
     * @type {Set<string>}
     */
    this.disabledWorkspaces = new Set()
    this.disposed = false
    this.sweeper = setInterval(() => { this.sweep() }, this.tuning.sweepIntervalMs)
    if (typeof this.sweeper.unref === 'function') this.sweeper.unref()
  }

  /**
   * Remember the filesystem backend so mount/unmount can invalidate its caches.
   *
   * @param {import('./remote-fs.js').RemoteFileSystem} fs - the mounted backend.
   */
  attachFileSystem (fs) {
    this.fs = fs
  }

  /**
   * Take the detached-workspace set from the store.
   *
   * @param {Iterable<string>} workspacePaths - canonical `ssh://` paths to disable.
   * @returns {void}
   */
  setDisabledWorkspaces (workspacePaths) {
    this.disabledWorkspaces = new Set(workspacePaths)
    // Detaching or re-enabling a workspace changes what the alias serves, so
    // any cached metadata under it must not survive the switch.
    for (const path of this.disabledWorkspaces) this.fs?.invalidateWorkspace?.(path)
  }

  /**
   * Mark one remote workspace detached, or lift the mark.
   *
   * @param {string} workspacePath - canonical `ssh://` path.
   * @param {boolean} disabled - true to detach, false to re-enable.
   * @returns {void}
   */
  markWorkspaceDisabled (workspacePath, disabled) {
    const target = String(workspacePath)
    if (disabled === true) this.disabledWorkspaces.add(target)
    else this.disabledWorkspaces.delete(target)
    this.fs?.invalidateWorkspace?.(target)
  }

  /**
   * Whether a remote target lies inside a detached workspace.
   *
   * @param {string} alias - host alias.
   * @param {string} remotePath - remote absolute path.
   * @returns {boolean} true when the target must be refused.
   */
  isDisabledTarget (alias, remotePath) {
    if (this.disabledWorkspaces.size === 0) return false
    return isInsideAnyRemoteWorkspace(this.disabledWorkspaces, alias, normalizeRemotePath(remotePath))
  }

  /**
   * Refuse a target inside a detached workspace.
   *
   * @param {string} alias - host alias.
   * @param {string} remotePath - remote absolute path.
   * @returns {void}
   * @throws {Error} when the target is inside a detached workspace.
   */
  assertNotDisabled (alias, remotePath) {
    if (!this.isDisabledTarget(alias, remotePath)) return
    throw new Error(`cannot access ssh://${alias}${normalizeRemotePath(remotePath)}: the remote workspace is detached (re-enable it in the panel or with ssh_workspace_enable)`)
  }

  /** Drop every pooled connection and stop the sweeper. */
  dispose () {
    this.disposed = true
    clearInterval(this.sweeper)
    for (const [alias, record] of this.pool) this.closeRecord(alias, record)
    this.pool.clear()
  }

  /** Close connections idle beyond the configured threshold. */
  sweep () {
    const cutoff = Date.now() - this.tuning.idleTimeoutMs
    for (const [alias, record] of [...this.pool]) {
      if (record.inFlight === 0 && record.holds === 0 && record.idleAt < cutoff) this.closeRecord(alias, record)
    }
  }

  /**
   * Close one pooled record, leaving any replacement record alone.
   *
   * @param {string} alias - host alias.
   * @param {object} record - the record to close.
   */
  closeRecord (alias, record) {
    if (this.pool.get(alias) === record) this.pool.delete(alias)
    // A new connection means the host may have changed underneath us (a
    // package installed, a tool removed), so the cached probe no longer holds.
    this.capabilities.delete(alias)
    try { record.sftp?.end?.() } catch { /* channel already gone */ }
    try { record.streamSftp?.end?.() } catch { /* channel already gone */ }
    try { record.client.end() } catch { /* socket already gone */ }
  }

  /**
   * Drop the pooled connection for an alias because its configuration
   * changed; the next operation reconnects with the new record.
   *
   * @param {string} alias - host alias.
   */
  forget (alias) {
    const record = this.pool.get(alias)
    if (record !== undefined) this.closeRecord(alias, record)
  }

  /**
   * Build the ssh2 connect configuration for one host record.
   *
   * @param {object} resolved - a descriptor from {@link HostStore#resolve}.
   * @returns {object} ssh2 `ConnectConfig`.
   * @throws {Error} when key auth names a missing or unreadable key.
   */
  connectConfig (resolved) {
    /** @type {Record<string, unknown>} */
    const config = {
      host: resolved.host,
      port: resolved.port,
      username: resolved.user,
      readyTimeout: this.tuning.connectTimeoutMs,
      keepaliveInterval: this.tuning.keepaliveIntervalMs,
      keepaliveCountMax: 3,
      tryKeyboard: true,
    }
    // Opt-in transport flags. `agentForward` lets a command run on the remote
    // host authenticate with the keys held by THIS machine's ssh-agent (a
    // remote `git push` over SSH), so no private key is copied to the host.
    // `compress` trades CPU for bandwidth on a slow link. Both are off unless
    // the host entry asks for them.
    if (resolved.agentForward === true) config.agentForward = true
    if (resolved.compress === true) config.compress = true
    const auth = resolved.auth ?? { kind: 'agent' }
    if (auth.kind === 'password') {
      if (typeof auth.password !== 'string' || auth.password === '') {
        throw new Error(`host ${JSON.stringify(resolved.alias)} uses password auth but the store holds no password`)
      }
      config.password = auth.password
    } else if (auth.kind === 'agent') {
      const agentPath = resolveAgentPath(auth.agentPath)
      if (agentPath === undefined) {
        throw new Error(`host ${JSON.stringify(resolved.alias)} uses agent auth but no ssh-agent is available (set SSH_AUTH_SOCK or configure an agent path)`)
      }
      config.agent = agentPath
    } else {
      const keyPath = expandHome(auth.keyPath ?? '')
      if (keyPath === '' || !existsSync(keyPath)) {
        throw new Error(`host ${JSON.stringify(resolved.alias)}: private key not found at ${JSON.stringify(auth.keyPath ?? '(unset)')}`)
      }
      config.privateKey = readFileSync(keyPath, 'utf8')
      if (typeof auth.passphrase === 'string' && auth.passphrase !== '') config.passphrase = auth.passphrase
    }
    return config
  }

  /**
   * Build the host-key verifier for one host: trust on first use, then pin.
   *
   * ssh2 hands the verifier the server's raw public key blob during the
   * handshake and honours a synchronous boolean. The first key seen for an
   * alias is recorded (alias, host, key type, SHA256 fingerprint) in the
   * shared store and accepted; afterwards only the same fingerprint is
   * accepted, anything else refuses the connection with both fingerprints in
   * the message. A verifier that returns false makes the handshake fail, and
   * the detail is stashed on `state` for the connect failure to report.
   *
   * @param {object} resolved - a descriptor from {@link HostStore#resolve}.
   * @param {{mismatch?: {recorded: object, presented: object}}} state - per-connect state.
   * @returns {(key: Buffer) => boolean} the verifier.
   */
  #makeHostKeyVerifier (resolved, state) {
    return (key) => {
      const blob = Buffer.isBuffer(key) ? key : Buffer.from(String(key), 'utf8')
      const keyType = hostKeyTypeOf(blob)
      const fingerprint = hostKeyFingerprint(blob)
      const recorded = this.store.knownHostKey(resolved.alias)
      if (recorded === undefined) {
        try {
          this.store.rememberHostKey(resolved.alias, { host: resolved.host, port: resolved.port, keyType, fingerprint })
          this.logger?.info?.(`ssh-workspace: recorded host key for ${resolved.alias} (${keyType} ${fingerprint})`)
        } catch (error) {
          // The connection itself must not fail because the record could not
          // be persisted; the next connect attempts the record again.
          this.logger?.warn?.(`ssh-workspace: could not record the host key for ${resolved.alias}: ${error instanceof Error ? error.message : String(error)}`)
        }
        return true
      }
      if (recorded.fingerprint === fingerprint) return true
      state.mismatch = { recorded, presented: { keyType, fingerprint } }
      return false
    }
  }

  /**
   * Connect (or reuse) the pooled connection for an alias.
   *
   * @param {string} alias - host alias.
   * @returns {Promise<object>} the live connection record.
   */
  async acquire (alias) {
    if (this.disposed) throw new Error('ssh-workspace engine is disposed')
    const existing = this.pool.get(alias)
    if (existing !== undefined && !existing.broken) return existing
    if (existing !== undefined) this.closeRecord(alias, existing)
    const pending = this.acquiring.get(alias)
    if (pending !== undefined) return await pending
    const task = this.#connect(alias)
    this.acquiring.set(alias, task)
    try {
      return await task
    } finally {
      if (this.acquiring.get(alias) === task) this.acquiring.delete(alias)
    }
  }

  /**
   * Establish one new connection plus its SFTP channel.
   *
   * @param {string} alias - host alias.
   * @returns {Promise<object>} the new record.
   */
  async #connect (alias) {
    const resolved = this.store.resolve(alias)
    const config = this.connectConfig(resolved)
    // Host keys are verified below; a mismatch is recorded here because the
    // transport error ssh2 raises for a refused key cannot carry the details.
    const hostKey = { mismatch: undefined }
    config.hostVerifier = this.#makeHostKeyVerifier(resolved, hostKey)
    const client = await new Promise((resolve, reject) => {
      const candidate = new Client()
      let settled = false
      const fail = (error) => {
        if (settled) return
        settled = true
        try { candidate.destroy() } catch { /* already closed */ }
        if (hostKey.mismatch !== undefined) {
          reject(hostKeyMismatchError(alias, resolved, hostKey.mismatch, error))
          return
        }
        reject(error instanceof Error ? error : new Error(String(error)))
      }
      candidate.once('ready', () => {
        if (settled) return
        settled = true
        // Tune again: the socket exists from `connect()`, but a reconnect inside
        // ssh2 would hand us a fresh one.
        tuneConnectionSocket(candidate._sock)
        resolve(candidate)
      })
      candidate.on('keyboard-interactive', (name, instructions, lang, prompts, finish) => {
        // Password auth can arrive as a keyboard-interactive challenge; answer
        // it only when the configured password clearly matches the prompt.
        if (config.password !== undefined && prompts.length > 0 && prompts.every(prompt => /password/iu.test(prompt.prompt))) {
          finish(prompts.map(() => config.password))
          return
        }
        fail(new Error(`authentication failed (keyboard-interactive): ${prompts.map(prompt => prompt.prompt.trim()).join(', ') || 'unsupported challenge'}`))
      })
      // Keep an error listener attached past the handshake: ssh2 may emit a
      // second 'error' after the once-listener is consumed.
      candidate.on('error', fail)
      try {
        candidate.connect(config)
      } catch (error) {
        fail(error)
      }
      // `connect()` creates the socket synchronously, so tuning it here (also)
      // shortens the handshake itself: key exchange is round-trip bound too.
      tuneConnectionSocket(candidate._sock)
    })

    /** @type {object} */
    // `holds` counts long-lived consumers (open port forwards): the sweeper
    // must keep the connection while any hold remains, though ordinary
    // operations continue to track their own in-flight windows.
    const record = { alias, client, sftp: undefined, streamSftp: undefined, idleAt: Date.now(), inFlight: 0, holds: 0, broken: false }
    client.on('error', () => { record.broken = true })
    client.on('close', () => { record.broken = true })
    try {
      record.sftp = await new Promise((resolve, reject) => {
        client.sftp((error, sftp) => {
          if (error !== undefined && error !== null) reject(error)
          else resolve(sftp)
        })
      })
    } catch (error) {
      this.closeRecord(alias, record)
      throw new Error(`host ${JSON.stringify(alias)}: could not open an SFTP channel: ${error instanceof Error ? error.message : String(error)}`)
    }
    this.pool.set(alias, record)
    this.logger?.info?.(`ssh-workspace: connected to ${alias} (${resolved.user}@${resolved.host}:${resolved.port})`)
    return record
  }

  /**
   * Run one SFTP operation against a live connection, reconnecting once when
   * the connection turns out to be broken.
   *
   * @template T
   * @param {string} alias - host alias.
   * @param {(sftp: any, record: object) => Promise<T>} operation - the work.
   * @returns {Promise<T>} the operation result.
   */
  async withSftp (alias, operation) {
    let lastError
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const record = await this.acquire(alias)
      record.idleAt = Date.now()
      record.inFlight += 1
      try {
        return await operation(record.sftp, record)
      } catch (error) {
        lastError = error
        // Replay only when the transport itself died: a logic error on a
        // healthy connection must surface, never be retried.
        if (!record.broken) throw error
        this.closeRecord(alias, record)
      } finally {
        record.inFlight -= 1
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }

  /**
   * The record's dedicated SFTP channel for streaming reads, opened lazily.
   *
   * A long sequential read on the shared channel makes every other operation
   * on the connection — stats, listings, the change watcher — queue behind
   * it; a second channel keeps them responsive while a large file streams.
   * A channel that cannot be opened degrades to the shared one, and a stream
   * channel that closes on its own is dropped so the next reader reopens it:
   * a stream must never fail because the second channel is unavailable.
   *
   * @param {object} record - a live pooled connection record.
   * @returns {Promise<any>} the streaming SFTP channel.
   */
  async streamChannel (record) {
    if (record.streamSftp !== undefined) return record.streamSftp
    let channel
    try {
      channel = await new Promise((resolve, reject) => {
        record.client.sftp((error, sftp) => {
          if (error !== undefined && error !== null) reject(error)
          else resolve(sftp)
        })
      })
    } catch {
      return record.sftp
    }
    channel.on?.('close', () => {
      if (record.streamSftp === channel) record.streamSftp = undefined
    })
    record.streamSftp = channel
    return channel
  }

  /**
   * Remote paths that are writable scratch space for atomic publication.
   *
   * `/tmp` is the POSIX convention and is what the local backend's own
   * writable-root policy already names, so the same staging strategy works on
   * both sides of the seam.
   */
  static get stagingRoot () {
    return '/tmp'
  }

  /**
   * Probe which optional remote tools a host actually has.
   *
   * The plugin degrades in several places when a remote tool is missing — no
   * `rg` means glob/grep cannot run, no `git` silently disables change
   * tracking, no `inotifywait` means change watching falls back to polling —
   * and without a probe the user only discovers that by hitting the failure.
   * One `command -v` sweep per host turns those into an up-front answer.
   *
   * The probe never throws: a host that cannot be reached, or a shell that
   * answers oddly, yields `undefined` per capability so the caller reports
   * "unknown" rather than a false negative.
   *
   * @param {string} alias - host alias.
   * @param {object} [options] - probe options.
   * @param {AbortSignal} [options.signal] - caller cancellation.
   * @param {boolean} [options.refresh] - ignore the cached answer.
   * @returns {Promise<Record<string, boolean|undefined>>} capability → present.
   */
  async probeCapabilities (alias, options = {}) {
    const cached = this.capabilities.get(alias)
    if (cached !== undefined && options.refresh !== true) return cached
    /** @type {Record<string, boolean|undefined>} */
    const result = { rg: undefined, git: undefined, inotifywait: undefined }
    // One round trip: each marker is printed only when the tool resolved, so a
    // missing tool leaves its line out rather than failing the whole command.
    const script = [
      'command -v rg >/dev/null 2>&1 && printf "rg\\n"',
      'command -v git >/dev/null 2>&1 && printf "git\\n"',
      'command -v inotifywait >/dev/null 2>&1 && printf "inotifywait\\n"',
      'printf "dsh-probe-done\\n"',
    ].join('; ')
    try {
      const outcome = await this.exec(alias, script, { timeoutMs: 15_000, signal: options.signal })
      if (outcome.success !== true && outcome.exitCode !== 0) return result
      // A run that produced no completion marker cannot be trusted to have
      // reported every capability; leave the unknowns as unknown.
      if (!outcome.stdout.includes('dsh-probe-done')) return result
      result.rg = outcome.stdout.includes('rg')
      result.git = outcome.stdout.includes('git')
      result.inotifywait = outcome.stdout.includes('inotifywait')
      // Only a fully determined answer is worth remembering: caching an all-
      // unknown result would make one bad probe permanent for the session.
      if (result.rg !== undefined || result.git !== undefined || result.inotifywait !== undefined) {
        this.capabilities.set(alias, result)
      }
      return result
    } catch {
      return result
    }
  }

  /**
   * Run one shell command on a remote host.
   *
   * The filesystem seam carries file contents; a shell is a different
   * capability, so the remote workspace uses this for commands because the
   * deployment's pwsh/bash tools always execute on the local host.
   *
   * A transport death replays the command once, but only while it has not
   * produced any output: a command that already emitted something has run (and
   * may have had side effects), so it is settled as a connection loss instead.
   *
   * @param {string} alias - host alias.
   * @param {string} command - shell command to run remotely.
   * @param {object} [options] - exec options.
   * @param {number} [options.timeoutMs] - wall-clock budget (default 60000).
   * @param {number} [options.maxOutputBytes] - per-stream capture cap.
   * @param {string} [options.cwd] - remote working directory.
   * @param {AbortSignal} [options.signal] - caller cancellation.
   * @returns {Promise<{success: boolean, exitCode: number|null, timedOut: boolean, stdout: string, stderr: string, truncated: boolean, durationMs: number, error?: string}>} outcome.
   */
  async exec (alias, command, options = {}) {
    const started = Date.now()
    const budget = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 60_000
    const maxBytes = Number.isFinite(options.maxOutputBytes) && options.maxOutputBytes > 0 ? options.maxOutputBytes : 2 * 1024 * 1024
    const prefix = options.cwd === undefined || options.cwd === '' ? '' : `cd ${shellQuote(options.cwd)} && `
    let outcome
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const record = await this.acquire(alias)
      record.idleAt = Date.now()
      record.inFlight += 1
      let producedOutput
      try {
        ({ outcome, producedOutput } = await runRemoteCommand(record.client, `${prefix}${command}`, {
          budget,
          maxBytes,
          signal: options.signal,
          started,
        }))
      } finally {
        record.inFlight -= 1
        record.idleAt = Date.now()
      }
      // ssh2 marks the pooled record broken before the channel's close event
      // settles the run, so by the time the await above resumes the flag is
      // already reliable. Only a replay that cannot repeat side effects (no
      // output yet, not a timeout, not an abort) is allowed.
      const lostBeforeOutput = outcome.success !== true
        && producedOutput !== true
        && outcome.timedOut !== true
        && options.signal?.aborted !== true
        && record.broken
      if (!(attempt === 1 && lostBeforeOutput)) break
      this.closeRecord(alias, record)
    }
    return outcome
  }

  /**
   * Open a long-lived exec channel and hold the pooled connection for it.
   *
   * `exec` is snapshot-shaped: it buffers and settles. A consumer that wants a
   * stream — the push-based change watcher feeding `inotifywait`, or a terminal
   * — needs the channel itself, plus the guarantee that the idle sweeper does
   * not reap the connection out from under it. `holds` is that guarantee: the
   * same counter open port forwards already use.
   *
   * The returned channel is the raw ssh2 channel (`stdout` events, `write`,
   * `close`); the caller owns its lifecycle and MUST call `release()` — the
   * connection stays pinned until it does. A transport death closes the channel
   * and calls `onClose`, so a consumer never waits on a dead stream.
   *
   * @param {string} alias - host alias.
   * @param {string} command - shell command to run remotely.
   * @param {object} [options] - channel options.
   * @param {AbortSignal} [options.signal] - cancels the open and closes the channel.
   * @param {Function} [options.onClose] - called once when the channel closes for any reason.
   * @param {object|boolean} [options.pty] - request a remote PTY (`true` or `{cols, rows, term}`), making the channel interactive.
   * @returns {Promise<{channel: object, record: object, release: Function}>} the open channel plus its release.
   */
  async openChannel (alias, command, options = {}) {
    const record = await this.acquire(alias)
    let released = false
    const release = () => {
      if (released) return
      released = true
      record.holds = Math.max(0, record.holds - 1)
      record.idleAt = Date.now()
    }
    // Pin the connection before the channel exists, so a sweep that lands
    // between here and the resolve cannot close it.
    record.holds += 1
    record.idleAt = Date.now()
    record.inFlight += 1
    let channel
    try {
      channel = await new Promise((resolve, reject) => {
        const callback = (error, opened) => {
          if (error !== undefined && error !== null) reject(error)
          else resolve(opened)
        }
        // A PTY makes the remote end a terminal: it echoes, line-buffers and
        // reports a window size, which is what an interactive session needs.
        if (options.pty !== undefined && options.pty !== false) record.client.exec(command, { pty: options.pty }, callback)
        else record.client.exec(command, callback)
      })
    } catch (error) {
      record.inFlight -= 1
      release()
      throw error
    }
    record.inFlight -= 1
    record.idleAt = Date.now()
    let closed = false
    const finish = () => {
      if (closed) return
      closed = true
      release()
      try { options.onClose?.() } catch { /* a throwing consumer must not leak the hold */ }
    }
    if (typeof channel.once === 'function') channel.once('close', finish)
    else if (typeof channel.on === 'function') channel.on('close', finish)
    const onAbort = () => {
      try { channel.close() } catch { /* channel already gone */ }
      finish()
    }
    if (options.signal !== undefined && options.signal !== null && typeof options.signal.addEventListener === 'function') {
      if (options.signal.aborted === true) onAbort()
      else options.signal.addEventListener('abort', onAbort, { once: true })
    }
    return {
      channel,
      record,
      release: () => {
        options.signal?.removeEventListener?.('abort', onAbort)
        finish()
      },
    }
  }
}

/**
 * Run one command over an established client, collecting bounded output.
 *
 * Resolves (never rejects) with the settled outcome plus whether any output
 * arrived, which is what decides replayability: a command that already
 * produced output has run.
 *
 * @param {any} client - the ssh2 client to run on.
 * @param {string} command - the shell command (already prefixed with `cd`).
 * @param {{budget: number, maxBytes: number, signal?: AbortSignal, started: number}} options - run parameters.
 * @returns {Promise<{outcome: object, producedOutput: boolean}>} the settled run.
 */
function runRemoteCommand (client, command, options) {
  const { budget, maxBytes, signal, started } = options
  return new Promise((resolve) => {
    client.exec(command, (error, stream) => {
      if (error !== undefined && error !== null) {
        resolve({
          outcome: {
            success: false,
            exitCode: null,
            timedOut: false,
            stdout: '',
            stderr: '',
            truncated: false,
            durationMs: Date.now() - started,
            error: error.message ?? String(error),
          },
          producedOutput: false,
        })
        return
      }
      const stdout = { decoder: new StringDecoder('utf8'), text: '', bytes: 0, truncated: false }
      const stderr = { decoder: new StringDecoder('utf8'), text: '', bytes: 0, truncated: false }
      let producedOutput = false
      let timedOut = false
      let settled = false
      const finish = (outcome) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({
          outcome: {
            ...outcome,
            stdout: finalizeOutput(stdout),
            stderr: finalizeOutput(stderr),
            truncated: stdout.truncated || stderr.truncated,
            durationMs: Date.now() - started,
          },
          producedOutput,
        })
      }
      const timer = setTimeout(() => {
        timedOut = true
        try { stream.signal('KILL') } catch { /* channel gone */ }
        try { stream.close() } catch { /* channel gone */ }
        finish({
          success: false,
          exitCode: null,
          timedOut: true,
          error: `command timed out after ${budget} ms`,
        })
      }, budget)
      const abort = () => {
        try { stream.signal('KILL') } catch { /* channel gone */ }
        try { stream.close() } catch { /* channel gone */ }
        finish({
          success: false,
          exitCode: null,
          timedOut: false,
          error: 'command aborted by the caller',
        })
      }
      signal?.addEventListener('abort', abort, { once: true })
      stream.on('data', (chunk) => {
        if (chunk.length > 0) producedOutput = true
        appendCapped(stdout, chunk, maxBytes)
      })
      stream.stderr.on('data', (chunk) => {
        if (chunk.length > 0) producedOutput = true
        appendCapped(stderr, chunk, maxBytes)
      })
      stream.on('close', (code) => {
        signal?.removeEventListener?.('abort', abort)
        finish({
          success: code === 0,
          exitCode: typeof code === 'number' ? code : null,
          timedOut,
          ...(typeof code !== 'number' ? { error: 'connection lost before the command reported an exit status' } : {}),
        })
      })
      stream.on('error', (streamError) => {
        finish({
          success: false,
          exitCode: null,
          timedOut: false,
          error: streamError.message ?? String(streamError),
        })
      })
    })
  })
}

/**
 * Append one chunk up to a byte cap, marking truncation once.
 *
 * The cap is accounted in bytes and the stream is decoded with a persistent
 * {@link StringDecoder}: a multi-byte character split across chunks is held
 * back until the rest arrives instead of turning into replacement glyphs, and
 * the truncation cut falls on a complete-character boundary because the
 * decoder never emits half a character.
 */
function appendCapped (target, chunk, maxBytes) {
  if (target.truncated) return
  const remaining = maxBytes - target.bytes
  if (chunk.length > remaining) {
    target.text += target.decoder.write(chunk.subarray(0, Math.max(0, remaining)))
    target.text += '…[output truncated]'
    target.truncated = true
    return
  }
  target.bytes += chunk.length
  target.text += target.decoder.write(chunk)
}

/**
 * Flush a stream's decoder tail at settle time so a trailing multi-byte
 * character split across the final chunks still renders. Truncated streams
 * keep their marker and discard the held tail — the cap already applied.
 *
 * @param {{decoder: StringDecoder, text: string, truncated: boolean}} target - collected stream state.
 * @returns {string} the final text.
 */
function finalizeOutput (target) {
  if (!target.truncated) target.text += target.decoder.end()
  return target.text
}

/**
 * The algorithm name of an SSH public key blob.
 *
 * A host key arriving from the wire is `string algorithm-name` +
 * `string key-data`, the same framing that becomes a base64 known_hosts line.
 *
 * @param {Buffer} blob - the raw public key blob.
 * @returns {string} the algorithm name, or 'unknown' when the framing is odd.
 */
function hostKeyTypeOf (blob) {
  if (!Buffer.isBuffer(blob) || blob.length < 8) return 'unknown'
  const length = blob.readUInt32BE(0)
  if (length <= 0 || length > blob.length - 4) return 'unknown'
  return blob.subarray(4, 4 + length).toString('utf8')
}

/**
 * The OpenSSH-style SHA256 fingerprint of a public key blob
 * (`SHA256:` + unpadded base64), comparable with `ssh-keygen -lf`.
 *
 * @param {Buffer} blob - the raw public key blob.
 * @returns {string} the fingerprint.
 */
function hostKeyFingerprint (blob) {
  return `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/u, '')}`
}

/**
 * The refusal raised when a server presents a host key that differs from the
 * recorded one, naming both fingerprints so the user can decide.
 *
 * @param {string} alias - host alias.
 * @param {object} resolved - the resolved descriptor.
 * @param {{recorded: object, presented: object}} mismatch - both sides of the change.
 * @param {unknown} cause - the underlying transport error.
 * @returns {Error} the error to surface.
 */
function hostKeyMismatchError (alias, resolved, mismatch, cause) {
  const { recorded, presented } = mismatch
  const where = `${resolved.user}@${resolved.host}:${resolved.port}`
  const when = Number.isFinite(recorded.recordedAt) ? ` (recorded ${new Date(recorded.recordedAt).toISOString()})` : ''
  return new Error(
    `host ${JSON.stringify(alias)} (${where}): the server presented a different host key than the one recorded on first connect.\n`
    + `recorded: ${recorded.keyType} ${recorded.fingerprint}${when}\n`
    + `presented: ${presented.keyType} ${presented.fingerprint}\n`
    + 'If this host was reinstalled or its key was legitimately rotated, use "forget host key" for this host in the remote-workspace panel and connect again. '
    + 'If you did not expect a key change, treat it as a possible man-in-the-middle and do not proceed.',
    { cause },
  )
}

/** Quote one argument for a POSIX shell. */
export function shellQuote (value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

/**
 * Resolve the ssh-agent endpoint for agent auth.
 *
 * @param {string | undefined} configured - an explicit agent path.
 * @returns {string | undefined} the endpoint, or undefined when unavailable.
 */
export function resolveAgentPath (configured) {
  if (typeof configured === 'string' && configured !== '') return configured
  const sock = process.env.SSH_AUTH_SOCK
  if (sock !== undefined && sock !== '') return sock
  if (process.platform === 'win32') return 'pageant'
  return undefined
}

export { DEFAULTS as ENGINE_DEFAULTS, ftpCodeOf }
