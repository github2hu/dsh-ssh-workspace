/**
 * Check every link and image the documentation ships.
 *
 * Three classes of target, because they fail differently:
 *
 *  - relative paths  — must resolve on disk from the file that names them, and
 *                      a `#anchor` on another `.md` must match one of its headings;
 *  - bare `#anchors` — must match a heading in the SAME file (that is the class
 *                      that leaves a dead TOC entry);
 *  - absolute GitHub URLs into this repository — these exist because the npm
 *                      package page cannot resolve relative paths, so they are
 *                      load-bearing for the published README. They are checked
 *                      against the working tree too: a renamed doc would rot
 *                      them silently otherwise.
 *
 * Run: node scripts/check-doc-links.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO = 'https://github.com/siqyka/dsh-ssh-workspace/blob/main/'

const files = []
;(function walk (dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full)
    else if (entry.name.endsWith('.md')) files.push(path.relative(root, full))
  }
})(root)

/** GitHub's heading-anchor spelling, near enough to catch a real mismatch. */
function slug (heading) {
  return heading
    .replace(/<[^>]*>/gu, '')
    .replace(/[`*_[\]()]/gu, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/gu, '-')
    .toLowerCase()
}

const headings = new Map()
for (const file of files) {
  const source = fs.readFileSync(path.join(root, file), 'utf8')
  headings.set(file, new Set([...source.matchAll(/^#{1,6}\s+(.+)$/gmu)].map(m => slug(m[1]))))
}

const problems = []
for (const file of files) {
  const source = fs.readFileSync(path.join(root, file), 'utf8')
  const dir = path.dirname(file)

  for (const match of source.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu)) {
    const target = match[1]

    if (target.startsWith('#')) {
      if (!headings.get(file).has(target.slice(1))) problems.push(`dead anchor   ${file} ${target}`)
      continue
    }
    if (target.startsWith(REPO)) {
      const local = target.slice(REPO.length).split('#')[0]
      if (!fs.existsSync(path.join(root, local))) problems.push(`dead repo URL ${file} -> ${target}`)
      continue
    }
    if (/^https?:/u.test(target) || target.startsWith('mailto:')) continue

    const [rawPath, hash] = target.split('#')
    const resolved = path.relative(root, path.resolve(root, dir, rawPath))
    if (!fs.existsSync(path.join(root, resolved))) {
      problems.push(`missing file  ${file} -> ${target}`)
      continue
    }
    if (hash !== undefined && resolved.endsWith('.md') && !headings.get(resolved)?.has(hash)) {
      problems.push(`dead anchor   ${file} -> ${target}`)
    }
  }

  for (const match of source.matchAll(/src="([^"]+)"/gu)) {
    const target = match[1]
    if (target.startsWith(REPO)) continue
    if (/^https?:/u.test(target)) continue
    if (!fs.existsSync(path.join(root, path.resolve(root, dir, target)))) {
      problems.push(`missing image ${file} -> ${target}`)
    }
  }
}

if (problems.length === 0) {
  console.log(`all links OK (${files.length} markdown files)`)
} else {
  for (const problem of problems) console.log(problem)
  console.log(`\n${problems.length} problem(s)`)
  process.exit(1)
}
