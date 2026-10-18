/**
 * Locate and remove the session-log directories that belong to one workspace.
 *
 * The shipped JSONL persistence backend stores each session as its own
 * directory `<root>/--<encoded-cwd>--/<encoded-id>/`. DSH exposes no public
 * "delete a session" API, so a permanent workspace deletion that also removes
 * the conversation history has to work on those directories directly. The
 * encoding below is copied from the backend's own layout rules (see
 * `@deepseek-ai/dsh-session-persistence-jsonl`'s "On-disk layout"): characters
 * outside `[A-Za-z0-9._-]` become `~<4 uppercase hex>`, and the project segment
 * folds `\\`, `/` and `:` into `-`.
 *
 * Only directories whose encoded name matches one of the given session ids are
 * touched, and they are located by scanning the project directories — the
 * workspace's own cwd is deliberately NOT used, because the authoritative list
 * of its sessions comes from the DSH registry, not from a path guess.
 *
 * @module @shiqyka/dsh-ssh-workspace/session-logs
 */

import { lstat, readdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** One directory-name encoding step, shared by ids and cwds. */
const ENCODE_UNSAFE = /[^A-Za-z0-9._-]/gu

/**
 * Encode one session id into its on-disk directory name.
 *
 * @param {string} sessionId - the session id.
 * @returns {string} the encoded directory name.
 */
export function encodeSessionSegment (sessionId) {
  if (sessionId === '.') return '~002E'
  if (sessionId === '..') return '~002E~002E'
  return String(sessionId).replace(ENCODE_UNSAFE, ch => `~${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`)
}

/**
 * The session-log root this deployment uses.
 *
 * `$DSH_HOME/sessions` is where the shipped JSONL backend is pointed in this
 * profile; an explicit override exists for tests and unusual deployments.
 *
 * @param {string} [override] - explicit root.
 * @returns {string} the absolute root directory.
 */
export function sessionsRoot (override) {
  if (typeof override === 'string' && override !== '') return override
  const home = process.env.DSH_HOME
  const base = typeof home === 'string' && home !== '' ? home : join(homedir(), '.dsh')
  return join(base, 'sessions')
}

/**
 * Find the on-disk directories of the given session ids.
 *
 * @param {readonly string[]} sessionIds - session ids to locate.
 * @param {object} [options] - lookup options.
 * @param {string} [options.root] - session-log root override.
 * @returns {Promise<{found: Array<{sessionId: string, directory: string}>, missing: string[]}>} matches.
 */
export async function locateSessionDirectories (sessionIds, options = {}) {
  const root = sessionsRoot(options.root)
  const known = Array.isArray(sessionIds) ? sessionIds.filter(id => typeof id === 'string' && id !== '') : []
  if (known.length === 0) return { found: [], missing: [] }
  let projects
  try {
    projects = await readdir(root, { withFileTypes: true })
  } catch {
    return { found: [], missing: known }
  }
  const matches = new Map()
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const projectDir = join(root, project.name)
    let children
    try {
      children = await readdir(projectDir, { withFileTypes: true })
    } catch {
      continue
    }
    const byName = new Map(children.filter(entry => entry.isDirectory()).map(entry => [entry.name, entry.name]))
    for (const sessionId of known) {
      const encoded = encodeSessionSegment(sessionId)
      if (!byName.has(encoded)) continue
      const directory = join(projectDir, encoded)
      const list = matches.get(sessionId) ?? []
      list.push(directory)
      matches.set(sessionId, list)
    }
  }
  const found = []
  const missing = []
  for (const sessionId of known) {
    const directories = matches.get(sessionId)
    if (directories === undefined || directories.length === 0) {
      missing.push(sessionId)
      continue
    }
    for (const directory of directories) found.push({ sessionId, directory })
  }
  return { found, missing }
}

/**
 * Whether one path is a directory (never throws).
 *
 * @param {string} path - candidate path.
 * @returns {Promise<boolean>} true for an existing directory.
 */
async function isDirectory (path) {
  try {
    return (await lstat(path)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Remove the session-log directories of the given sessions.
 *
 * Deletion is per session and best-effort: one unreadable directory must not
 * abort the rest, and the caller reports what could not be removed instead of
 * silently claiming success.
 *
 * @param {readonly string[]} sessionIds - sessions whose logs should go.
 * @param {object} [options] - deletion options.
 * @param {string} [options.root] - session-log root override.
 * @param {object} [options.logger] - optional logger for per-session failures.
 * @returns {Promise<{deleted: string[], missing: string[], failed: Array<{sessionId: string, error: string}>}>} outcome.
 */
export async function deleteSessionLogs (sessionIds, options = {}) {
  const { found, missing } = await locateSessionDirectories(sessionIds, options)
  const deleted = []
  const failed = []
  for (const entry of found) {
    if (!(await isDirectory(entry.directory))) {
      // Raced away between the listing and the delete: treat as gone.
      if (!deleted.includes(entry.sessionId)) deleted.push(entry.sessionId)
      continue
    }
    try {
      await rm(entry.directory, { recursive: true, force: true })
      if (!deleted.includes(entry.sessionId)) deleted.push(entry.sessionId)
    } catch (error) {
      failed.push({ sessionId: entry.sessionId, error: error instanceof Error ? error.message : String(error) })
      options.logger?.warn?.(`ssh-workspace: could not delete the logs of session ${entry.sessionId}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { deleted, missing, failed }
}
