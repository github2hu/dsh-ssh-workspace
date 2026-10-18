/**
 * Pure checks for the two pieces a permanent workspace deletion relies on:
 * the confirmation preferences stored in the shared host store, and the
 * session-log directory layout (locate + delete).
 *
 * No DSH host is needed: the store is pointed at a temp file and the session
 * root at a temp directory that mirrors the shipped backend's layout.
 *
 * Run: node tests/purge-smoke.mjs
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { HostConfigStore, preferencesOf } from '../lib/store.js'
import { encodeSessionSegment, locateSessionDirectories, deleteSessionLogs, sessionsRoot } from '../lib/session-logs.js'

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

console.log('\n=== purge smoke ===\n')

console.log('[preferences: normalization]')
check('defaults both opt-outs to false', json(preferencesOf(undefined)) === json({ skipUnmountConfirm: false, skipPurgeConfirm: false }))
check('reads a stored true', preferencesOf({ preferences: { skipUnmountConfirm: true } }).skipUnmountConfirm === true)
check('ignores a non-boolean value', preferencesOf({ preferences: { skipUnmountConfirm: 'yes' } }).skipUnmountConfirm === false)
check('degrades a damaged section to "ask"', json(preferencesOf({ preferences: [] })) === json({ skipUnmountConfirm: false, skipPurgeConfirm: false }))

console.log('[preferences: store round-trip]')
const storeDir = mkdtempSync(join(tmpdir(), 'dsh-ssh-workspace-prefs-'))
try {
  const store = new HostConfigStore(join(storeDir, 'dsh-ssh.json'))
  check('a fresh store asks', json(store.preferences()) === json({ skipUnmountConfirm: false, skipPurgeConfirm: false }))
  const written = store.setPreferences({ skipPurgeConfirm: true })
  check('writes the preference', written.skipPurgeConfirm === true && written.skipUnmountConfirm === false, json(written))
  check('persists across instances', new HostConfigStore(join(storeDir, 'dsh-ssh.json')).preferences().skipPurgeConfirm === true)
  let unknown
  try { store.setPreferences({ nope: true }) } catch (error) { unknown = error }
  check('rejects an unknown key', unknown instanceof Error, String(unknown))
  let nonBoolean
  try { store.setPreferences({ skipUnmountConfirm: 'yes' }) } catch (error) { nonBoolean = error }
  check('rejects a non-boolean value', nonBoolean instanceof Error, String(nonBoolean))
  check('a rejected write leaves the section untouched', store.preferences().skipUnmountConfirm === false)
} finally {
  rmSync(storeDir, { recursive: true, force: true })
}

console.log('[session log encoding]')
check('plain ids are unchanged', encodeSessionSegment('session-1185e205') === 'session-1185e205')
check('encodes a space as ~0020', encodeSessionSegment('a b') === 'a~0020b')
check('encodes an at-sign as ~0040', encodeSessionSegment('a@b') === 'a~0040b')
check('keeps dots and dashes', encodeSessionSegment('session.1-x') === 'session.1-x')

console.log('[session log locate/delete]')
const root = mkdtempSync(join(tmpdir(), 'dsh-ssh-workspace-sessions-'))
try {
  const project = join(root, '--ssh-box-home-u-proj--')
  const wanted = join(project, encodeSessionSegment('session-keep'))
  const other = join(project, encodeSessionSegment('session-other'))
  mkdirSync(wanted, { recursive: true })
  mkdirSync(other, { recursive: true })
  writeFileSync(join(wanted, 'session.v4.jsonl.zstd'), 'x')
  writeFileSync(join(other, 'session.v4.jsonl.zstd'), 'x')

  const located = await locateSessionDirectories(['session-keep', 'session-gone'], { root })
  check('locates a registered session directory', located.found.length === 1 && located.found[0].sessionId === 'session-keep', json(located))
  check('reports a session with no directory as missing', located.missing.length === 1 && located.missing[0] === 'session-gone')

  const deleted = await deleteSessionLogs(['session-keep'], { root })
  check('deletes the matching directory', deleted.deleted.length === 1 && !existsSync(wanted), json(deleted.deleted))
  check('leaves other sessions alone', existsSync(other) === true)
  check('deleting a missing session is not an error', (await deleteSessionLogs(['session-gone'], { root })).missing.length === 1)
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log('[root resolution]')
const previousHome = process.env.DSH_HOME
try {
  process.env.DSH_HOME = join(tmpdir(), 'dsh-home-probe')
  check('honours DSH_HOME', sessionsRoot().endsWith(join('dsh-home-probe', 'sessions')), sessionsRoot())
  check('an explicit override wins', sessionsRoot('/custom/sessions') === '/custom/sessions')
} finally {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
}
check('a missing root yields no matches instead of throwing',
  (await locateSessionDirectories(['session-x'], { root: join(tmpdir(), 'dsh-ssh-workspace-absent-root') })).found.length === 0)

console.log(`\n=== ${passes.length} passed, ${failures.length} failed ===`)
if (failures.length > 0) {
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exitCode = 1
}
