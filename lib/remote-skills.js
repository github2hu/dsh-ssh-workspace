/**
 * Remote-workspace skill provider.
 *
 * The deployment's own skill providers discover skills with `node:fs`, so a
 * workspace whose cwd is an `ssh://<alias>/<path>` target yields no project
 * skills at all. This provider answers the same questions over the patched
 * `ctx.fs`, which this plugin already routes to SFTP for remote targets:
 *
 *   <project root>/.dsh/skills/<name>/SKILL.md      rank 100, source project-dsh
 *   <project root>/.dsh/skills/<name>.md            rank 100, source project-dsh
 *   <project root>/.agents/skills/<name>/SKILL.md   rank 200, source project-agents
 *   <project root>/.agents/skills/<name>.md         rank 200, source project-agents
 *
 * The project root is the nearest ancestor of the session cwd that contains a
 * `.git` entry, mirroring the deployment's filesystem provider. Discovery is
 * deliberately one level deep: nested `**\/SKILL.md` files are not skills.
 *
 * The catalog and the body have separate lifecycles — discovery parses the
 * frontmatter into a summary, and every load re-reads the file — so a body edit
 * never needs a cache invalidation. Only catalog changes matter, and those are
 * driven by `ctx.fs.watch` on each existing root, which the remote backend
 * implements itself (inotifywait when available, polling otherwise).
 *
 * @module @shiqyka/dsh-ssh-workspace/remote-skills
 */

import { isRemotePath, parseRemotePath, remoteDirname } from './protocol.js'

/** Provider name this module registers on `ctx.skills`. */
export const PROVIDER_NAME = 'ssh-workspace'

/** Root descriptors, in rank order. The rank sits just above the deployment
 * filesystem provider's own project ranks (100/200) so a remote project skill
 * deterministically wins a same-named duplicate in the same registry layer. */
export const SKILL_ROOTS = [
  { directory: '.dsh/skills', rank: 90, source: 'project-dsh' },
  { directory: '.agents/skills', rank: 190, source: 'project-agents' },
]

/** Largest number of ancestors walked while looking for the project root. */
const MAX_PROJECT_WALK = 12

/** Kebab-case skill names only, exactly as the deployment provider requires. */
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

/** Frontmatter delimiters: a leading `---` line and the next `---` line. */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u

/**
 * Parse one YAML scalar the way the skill format permits it: a quoted string,
 * a bare scalar, or nothing. Nested mappings are quoted or ignored by callers,
 * so only the first line of a value is taken.
 *
 * @param {string} raw - the text after `key:`.
 * @returns {string} the scalar value.
 */
function scalar (raw) {
  const value = raw.trim()
  if (value === '') return ''
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }
  return value
}

/**
 * Resolve one invocation key through the format's strict boolean grammar.
 *
 * @param {string} raw - the scalar text.
 * @returns {boolean | undefined} the boolean, or undefined when invalid.
 */
function strictBoolean (raw) {
  switch (raw.trim().toLowerCase()) {
    case 'true': case 'yes': case 'on': case '1': return true
    case 'false': case 'no': case 'off': case '0': return false
    default: return undefined
  }
}

/**
 * Parse a skill file into a catalog entry.
 *
 * A malformed entry is dropped as a whole rather than partially accepted: a
 * missing name, a name that is not kebab-case, a missing description, or a
 * rejected invocation value all return undefined, which the caller logs and
 * skips. A missing frontmatter block is equally invalid.
 *
 * @param {string} text - the complete file content.
 * @returns {{name: string, description: string, whenToUse?: string,
 *   modelInvocable: boolean, userInvocable: boolean, body: string} | undefined}
 *   the parsed skill, or undefined when the file is not a valid skill.
 */
export function parseSkillFile (text) {
  if (typeof text !== 'string') return undefined
  const match = FRONTMATTER_RE.exec(text)
  if (match === null) return undefined
  const fields = new Map()
  for (const line of match[1].split(/\r?\n/u)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    if (/^\s/u.test(line)) continue // nested block under the previous key
    const cut = line.indexOf(':')
    if (cut <= 0) continue
    fields.set(line.slice(0, cut).trim(), line.slice(cut + 1))
  }
  const name = scalar(fields.get('name') ?? '')
  const description = scalar(fields.get('description') ?? '')
  if (!SKILL_NAME_RE.test(name)) return undefined
  if (description === '') return undefined
  const whenToUse = scalar(fields.get('whenToUse') ?? fields.get('when-to-use') ?? '')
  let modelInvocable = true
  let userInvocable = true
  if (fields.has('disable-model-invocation')) {
    const value = strictBoolean(scalar(fields.get('disable-model-invocation')))
    if (value === undefined) return undefined
    modelInvocable = !value
  }
  if (fields.has('user-invocable')) {
    const value = strictBoolean(scalar(fields.get('user-invocable')))
    if (value === undefined) return undefined
    userInvocable = value
  }
  const body = text.slice(match[0].length)
  return {
    name,
    description,
    ...(whenToUse === '' ? {} : { whenToUse }),
    modelInvocable,
    userInvocable,
    body,
  }
}

/**
 * Join a remote directory and one child name.
 *
 * @param {string} directory - normalized remote absolute directory.
 * @param {string} name - child name.
 * @returns {string} the joined remote path.
 */
function remoteJoin (directory, name) {
  return directory === '/' ? `/${name}` : `${directory}/${name}`
}

/**
 * Build the remote `ssh://` spelling for a remote path on one host.
 *
 * @param {string} alias - host alias.
 * @param {string} remotePath - remote absolute path.
 * @returns {string} the `ssh://` spelling.
 */
function toRemoteSpelling (alias, remotePath) {
  return `ssh://${alias}${remotePath}`
}

/**
 * Create the skill provider registered on `ctx.skills`.
 *
 * @param {object} options - provider options.
 * @param {object} options.fs - the live (patched) `ctx.fs` service.
 * @param {string} options.cwd - the session working directory (may be local).
 * @param {object} [options.logger] - host logger.
 * @param {boolean} [options.watch] - attach root watchers when supported.
 * @param {() => void} [options.invalidate] - catalog invalidation callback.
 * @param {AbortSignal} [options.signal] - provider lifetime.
 * @returns {{name: string, list: Function, get: Function, dispose: Function}}
 *   the provider plus a disposer for its watchers.
 */
export function createRemoteSkillProvider (options) {
  const { fs, cwd, logger, invalidate, signal } = options
  const watch = options.watch !== false
  const closers = []

  /**
   * Stat one remote path without following its last component.
   *
   * @param {string} path - `ssh://` spelling.
   * @returns {Promise<object | undefined>} metadata, or undefined when absent.
   */
  async function pathInfo (path) {
    try {
      return await fs.lstat(path, undefined, signal)
    } catch {
      return undefined
    }
  }

  /**
   * Resolve a remote directory for listing, or undefined when it is absent.
   *
   * @param {string} path - `ssh://` spelling.
   * @returns {Promise<import('@deepseek-ai/dsh-fs').FsTarget | undefined>} target.
   */
  async function directoryTarget (path) {
    try {
      const target = await fs.resolve(path, { signal })
      const info = await fs.stat(target, signal)
      if (info === undefined || info.type !== 'directory') return undefined
      return target
    } catch {
      return undefined
    }
  }

  /**
   * Read one remote text file, tolerating any read failure as an invalid skill.
   *
   * @param {string} path - `ssh://` spelling.
   * @returns {Promise<string | undefined>} the content, or undefined.
   */
  async function readRemoteText (path) {
    try {
      return await fs.readText(await fs.resolve(path, { signal }), signal)
    } catch {
      return undefined
    }
  }

  /**
   * The nearest ancestor of `start` containing a `.git` entry.
   *
   * @param {string} alias - host alias.
   * @param {string} start - remote absolute directory.
   * @returns {Promise<string>} the project root, or the starting directory.
   */
  async function projectRoot (alias, start) {
    let directory = start
    for (let depth = 0; depth < MAX_PROJECT_WALK; depth += 1) {
      if (await pathInfo(toRemoteSpelling(alias, remoteJoin(directory, '.git'))) !== undefined) return directory
      if (directory === '/') break
      directory = remoteDirname(directory)
    }
    return start
  }

  /**
   * Discover the candidates of one root directory.
   *
   * @param {string} alias - host alias.
   * @param {string} root - remote absolute root directory.
   * @param {{rank: number, source: string}} descriptor - root descriptor.
   * @returns {Promise<object[]>} candidates.
   */
  async function listRoot (alias, root, descriptor) {
    const spelling = toRemoteSpelling(alias, root)
    const target = await directoryTarget(spelling)
    if (target === undefined) return []
    let entries
    try {
      entries = await fs.listDir(target, signal)
    } catch (error) {
      logger?.warn?.(`ssh-workspace: could not list remote skill root "${spelling}": ${error instanceof Error ? error.message : String(error)}`)
      return []
    }
    const candidates = []
    for (const entry of entries) {
      let skillPath
      let resourceBase
      if (entry.type === 'directory') {
        skillPath = remoteJoin(remoteJoin(root, entry.name), 'SKILL.md')
        resourceBase = remoteJoin(root, entry.name)
      } else if (entry.type === 'file' && entry.name.endsWith('.md')) {
        skillPath = remoteJoin(root, entry.name)
        resourceBase = root
      } else {
        continue
      }
      const fileSpelling = toRemoteSpelling(alias, skillPath)
      const text = await readRemoteText(fileSpelling)
      if (text === undefined) continue
      const parsed = parseSkillFile(text)
      if (parsed === undefined) {
        logger?.warn?.(`ssh-workspace: skipping invalid remote skill at "${fileSpelling}"`)
        continue
      }
      candidates.push({
        name: parsed.name,
        description: parsed.description,
        ...(parsed.whenToUse === undefined ? {} : { whenToUse: parsed.whenToUse }),
        invocation: { modelInvocable: parsed.modelInvocable, userInvocable: parsed.userInvocable },
        source: descriptor.source,
        provider: PROVIDER_NAME,
        rank: descriptor.rank,
        path: fileSpelling,
        resourceBase: { kind: 'directory', path: toRemoteSpelling(alias, resourceBase) },
        locator: { skillPath: fileSpelling },
      })
    }
    return candidates
  }

  /**
   * Attach watchers to the roots that exist right now.
   *
   * A missing root is not an error: it may be created later, and the next
   * discovery pass simply tries again.
   *
   * @param {string} alias - host alias.
   * @param {string[]} roots - remote absolute root directories.
   * @returns {void}
   */
  function attachWatchers (alias, roots) {
    for (const root of roots) {
      const spelling = toRemoteSpelling(alias, root)
      const changed = () => { try { invalidate?.() } catch { /* registry gone */ } }
      directoryTarget(spelling).then((target) => {
        if (target === undefined) return
        const controller = new AbortController()
        fs.watch(target, changed, controller.signal).then((close) => {
          closers.push(async () => {
            controller.abort()
            try { await close() } catch { /* already closed */ }
          })
        }).catch(() => { /* watching unsupported: catalog still refreshes on reload */ })
      }).catch(() => { /* root disappeared between probes */ })
    }
  }

  return {
    name: PROVIDER_NAME,
    /**
     * Answer the catalog question for one viewing cwd.
     *
     * @param {{cwd?: string, signal?: AbortSignal}} view - lookup options.
     * @returns {Promise<{candidates: object[], complete: boolean}>} observation.
     */
    async list (view = {}) {
      const viewCwd = view.cwd ?? cwd
      if (!isRemotePath(viewCwd)) return { candidates: [], complete: true }
      let parts
      try {
        parts = parseRemotePath(viewCwd)
      } catch {
        return { candidates: [], complete: true }
      }
      if (parts === undefined) return { candidates: [], complete: true }
      const root = await projectRoot(parts.alias, parts.remotePath)
      const seen = new Set()
      const candidates = []
      for (const descriptor of SKILL_ROOTS) {
        const list = await listRoot(parts.alias, remoteJoin(root, descriptor.directory), descriptor)
        for (const candidate of list) {
          if (seen.has(candidate.name)) continue
          seen.add(candidate.name)
          candidates.push(candidate)
        }
      }
      if (watch) attachWatchers(parts.alias, SKILL_ROOTS.map(descriptor => remoteJoin(root, descriptor.directory)))
      return { candidates, complete: true }
    },
    /**
     * Load one discovered skill body, re-reading the file every time.
     *
     * @param {{locator?: {skillPath?: string}, name?: string}} candidate - catalog entry.
     * @returns {Promise<object | undefined>} the definition, or undefined when it vanished.
     */
    async get (candidate) {
      const skillPath = candidate?.locator?.skillPath
      if (typeof skillPath !== 'string') return undefined
      const text = await readRemoteText(skillPath)
      if (text === undefined) return undefined
      const parsed = parseSkillFile(text)
      if (parsed === undefined) return undefined
      return {
        name: parsed.name,
        description: parsed.description,
        ...(parsed.whenToUse === undefined ? {} : { whenToUse: parsed.whenToUse }),
        invocation: { modelInvocable: parsed.modelInvocable, userInvocable: parsed.userInvocable },
        source: candidate.source ?? 'project-dsh',
        provider: PROVIDER_NAME,
        ...(candidate.path === undefined ? {} : { path: candidate.path }),
        ...(candidate.resourceBase === undefined ? {} : { resourceBase: candidate.resourceBase }),
        content: parsed.body.trim(),
      }
    },
    /** Release every root watcher this provider attached. */
    async dispose () {
      const pending = closers.splice(0)
      await Promise.all(pending.map(close => close().catch(() => {})))
    },
  }
}

/**
 * Parse a normalized remote spelling, returning undefined instead of throwing.
 *
 * @param {string} path - candidate `ssh://` spelling.
 * @returns {{alias: string, remotePath: string} | undefined} the parts.
 */
function parseRemotePathSafe (path) {
  if (!isRemotePath(path)) return undefined
  const cut = path.indexOf('/', 'ssh://'.length)
  if (cut <= 'ssh://'.length) return undefined
  const alias = path.slice('ssh://'.length, cut)
  try {
    return { alias, remotePath: normalizeRemotePath(path.slice(cut)) }
  } catch {
    return undefined
  }
}
