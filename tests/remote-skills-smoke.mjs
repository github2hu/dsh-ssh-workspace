/**
 * Pure checks for the remote skill provider: frontmatter parsing, project-root
 * walking, discovery over a stub filesystem, and body re-reads.
 *
 * Imports `lib/remote-skills.js`, which depends only on `lib/protocol.js` — the
 * suite runs without the DSH peers installed. The stub filesystem implements
 * exactly the five `ctx.fs` methods the provider uses.
 *
 * Run: node tests/remote-skills-smoke.mjs
 */

import { parseSkillFile, createRemoteSkillProvider, PROVIDER_NAME } from '../lib/remote-skills.js'

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

/** The remote spelling's path portion, which the stub keys its tree by. */
function remoteOf (spelling) {
  const cut = spelling.indexOf('/', 'ssh://'.length)
  return spelling.slice(cut)
}

/**
 * A `ctx.fs` stand-in over a flat table of remote paths.
 *
 * @param {Record<string, {type: 'dir'|'file', content?: string}>} tree - the world.
 */
function makeFs (tree) {
  const calls = []
  const fsType = entry => (entry.type === 'dir' ? 'directory' : 'file')
  const api = {
    calls,
    async resolve (path) { calls.push(['resolve', path]); return { targetKey: path, displayPath: path } },
    async lstat (path) {
      calls.push(['lstat', path])
      const entry = tree[remoteOf(path)]
      return entry === undefined ? undefined : { version: 'v1', type: fsType(entry) }
    },
    async stat (target) {
      const entry = tree[remoteOf(target.displayPath)]
      return entry === undefined ? undefined : { version: 'v1', type: fsType(entry) }
    },
    async listDir (target) {
      const base = remoteOf(target.displayPath).replace(/\/$/u, '')
      const entries = []
      for (const [path, entry] of Object.entries(tree)) {
        if (!path.startsWith(`${base}/`)) continue
        const rest = path.slice(base.length + 1)
        if (rest === '' || rest.includes('/')) continue
        entries.push({ name: rest, type: entry.type === 'dir' ? 'directory' : 'file', target: { targetKey: path, displayPath: path } })
      }
      return entries
    },
    async readText (target) {
      const entry = tree[remoteOf(target.displayPath)]
      if (entry === undefined || entry.type !== 'file') throw new Error('FS_NOT_TEXT')
      return entry.content ?? ''
    },
    async watch () { return async () => {} },
  }
  return api
}

const skillFile = (name, description, body = 'BODY') =>
  `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`

console.log('\n=== remote-skills smoke ===\n')

console.log('[parseSkillFile]')
{
  const parsed = parseSkillFile(skillFile('demo-skill', 'A demo'))
  check('parses a valid skill', parsed?.name === 'demo-skill' && parsed?.description === 'A demo', json(parsed))
  check('keeps the body without frontmatter', parsed?.body.trim() === 'BODY', json(parsed?.body))
  check('defaults both invocation surfaces to true',
    parsed?.modelInvocable === true && parsed?.userInvocable === true)
}
{
  const parsed = parseSkillFile('---\nname: demo\ndescription: d\ndisable-model-invocation: true\nuser-invocable: "no"\n---\nx')
  check('honours disable-model-invocation', parsed?.modelInvocable === false)
  check('honours user-invocable', parsed?.userInvocable === false)
}
check('rejects a non-kebab-case name',
  parseSkillFile(skillFile('Demo_Skill', 'd')) === undefined)
check('rejects a missing description',
  parseSkillFile('---\nname: demo\n---\nbody') === undefined)
check('rejects an invalid invocation value',
  parseSkillFile('---\nname: demo\ndescription: d\nuser-invocable: maybe\n---\nbody') === undefined)
check('rejects a file with no frontmatter', parseSkillFile('# just markdown') === undefined)
check('rejects a non-string', parseSkillFile(undefined) === undefined)

console.log('\n[discovery]')
const tree = {
  '/home/u/proj': { type: 'dir' },
  '/home/u/proj/.git': { type: 'dir' },
  '/home/u/proj/.dsh/skills': { type: 'dir' },
  '/home/u/proj/.dsh/skills/demo': { type: 'dir' },
  '/home/u/proj/.dsh/skills/demo/SKILL.md': { type: 'file', content: skillFile('demo', 'Demo skill') },
  '/home/u/proj/.dsh/skills/flat.md': { type: 'file', content: skillFile('flat-skill', 'Flat skill') },
  '/home/u/proj/.dsh/skills/notes.txt': { type: 'file', content: 'ignored' },
  '/home/u/proj/.agents/skills': { type: 'dir' },
  '/home/u/proj/.agents/skills/agents-skill': { type: 'dir' },
  '/home/u/proj/.agents/skills/agents-skill/SKILL.md': { type: 'file', content: skillFile('agents-skill', 'Agents skill') },
  '/home/u/proj/.agents/skills/demo': { type: 'dir' },
  '/home/u/proj/.agents/skills/demo/SKILL.md': { type: 'file', content: skillFile('demo', 'Duplicate demo') },
}
const fs = makeFs(tree)
const provider = createRemoteSkillProvider({ fs, cwd: '', logger: undefined, watch: false })

check('provider name is stable', provider.name === PROVIDER_NAME)

{
  const observation = await provider.list({ cwd: '/home/u/proj' })
  check('local cwd yields no candidates', observation.candidates.length === 0 && observation.complete === true)
}
{
  const observation = await provider.list({ cwd: 'ssh://box/home/u/proj' })
  const names = observation.candidates.map(candidate => candidate.name).sort()
  check('discovers directory bundles and flat files', json(names) === json(['agents-skill', 'demo', 'flat-skill']), json(names))
  check('always reports a complete observation', observation.complete === true)
  const demo = observation.candidates.find(candidate => candidate.name === 'demo')
  check('project-dsh wins a duplicate and carries rank 90', demo?.source === 'project-dsh' && demo?.rank === 90, json(demo))
  const agents = observation.candidates.find(candidate => candidate.name === 'agents-skill')
  check('project-agents carries rank 190', agents?.source === 'project-agents' && agents?.rank === 190, json(agents))
  check('candidate.provider matches the provider name', demo?.provider === PROVIDER_NAME)
  check('candidate path is the ssh:// spelling of the skill file',
    demo?.path === 'ssh://box/home/u/proj/.dsh/skills/demo/SKILL.md', json(demo?.path))
  check('resource base is the skill directory',
    demo?.resourceBase?.kind === 'directory' && demo?.resourceBase?.path === 'ssh://box/home/u/proj/.dsh/skills/demo')
  check('non-.md files are ignored', names.includes('notes') === false)
}
{
  const nested = await provider.list({ cwd: 'ssh://box/home/u/proj/src/deep' })
  const names = nested.candidates.map(candidate => candidate.name).sort()
  check('walks up to the nearest .git ancestor', json(names) === json(['agents-skill', 'demo', 'flat-skill']), json(names))
}
{
  const other = await provider.list({ cwd: 'ssh://box/elsewhere' })
  check('a workspace without a project root still yields a complete empty observation',
    other.complete === true && other.candidates.length === 0)
}

console.log('\n[loading]')
{
  const observation = await provider.list({ cwd: 'ssh://box/home/u/proj' })
  const demo = observation.candidates.find(candidate => candidate.name === 'demo')
  const loaded = await provider.get(demo)
  check('loads the body', loaded?.content === 'BODY', json(loaded))
  check('loaded definition names the provider', loaded?.provider === PROVIDER_NAME)
  tree['/home/u/proj/.dsh/skills/demo/SKILL.md'] = { type: 'file', content: skillFile('demo', 'Demo skill', 'UPDATED') }
  const reloaded = await provider.get(demo)
  check('re-reads the body on every load', reloaded?.content === 'UPDATED', json(reloaded?.content))
  delete tree['/home/u/proj/.dsh/skills/demo/SKILL.md']
  check('returns undefined when the skill vanished', (await provider.get(demo)) === undefined)
}
{
  const gone = await provider.get({ locator: { skillPath: 'ssh://box/home/u/proj/.dsh/skills/missing/SKILL.md' } })
  check('returns undefined for an unreadable locator', gone === undefined)
}

console.log(`\n=== ${passes.length} passed, ${failures.length} failed ===`)
if (failures.length > 0) {
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exitCode = 1
}
