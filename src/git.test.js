// Run: node src/git.test.js <path to a repo whose last two commits are "첫 커밋" (main, a) and "b 추가" (+ b)>
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { openRepo, hasGit } from './git.js'

const root = process.argv[2]
const blobs = {}
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
  const p = path.join(d, e.name)
  if (e.isDirectory()) walk(p)
  else blobs[path.relative(root, p).split(path.sep).join('/')] = new Blob([fs.readFileSync(p)])
})
walk(path.join(root, '.git'))
assert.ok(hasGit(blobs))
const repo = openRepo(blobs)
const log = await repo.log()
assert.deepEqual(log.map((c) => c.commit.message.trim()), ['b 추가', '첫 커밋'])
const newer = await repo.filesAt(log[0].oid), older = await repo.filesAt(log[1].oid)
assert.deepEqual(Object.keys(older.files).sort(), ['src/a.js', 'src/main.js'])
assert.deepEqual(Object.keys(newer.files).sort(), ['src/a.js', 'src/b.js', 'src/main.js'])
assert.ok(newer.files['src/main.js'].includes("from './b'"))
console.log('ok git')
