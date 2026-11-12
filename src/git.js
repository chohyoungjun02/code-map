import './buffer-polyfill.js'
import git from 'isomorphic-git'
import { CODE_EXT, IGNORED, readAliases } from './analyze.js'

// Read-only in-memory fs over the files of a picked folder, so isomorphic-git can read .git without a server.
// blobs: { '.git/HEAD': Blob, '.git/objects/..': Blob, ... }
function makeFs(blobs) {
  const dirs = new Map([['', new Set()]])
  for (const p of Object.keys(blobs)) {
    const parts = p.split('/')
    for (let i = 0; i < parts.length; i++) {
      const parent = parts.slice(0, i).join('/')
      if (!dirs.has(parent)) dirs.set(parent, new Set())
      dirs.get(parent).add(parts[i])
    }
  }
  const norm = (p) => p.replace(/^\/+/, '').replace(/\/+$/, '')
  const missing = (p) => Object.assign(new Error('ENOENT: ' + p), { code: 'ENOENT' })
  const stat = async (p) => {
    p = norm(p)
    const file = blobs[p], dir = dirs.has(p) && !file
    if (!file && !dir) throw missing(p)
    return {
      type: dir ? 'dir' : 'file', mode: dir ? 0o40000 : 0o100644, size: file?.size ?? 0,
      ino: 0, uid: 0, gid: 0, dev: 0, mtimeMs: 0, ctimeMs: 0,
      isFile: () => !dir, isDirectory: () => dir, isSymbolicLink: () => false,
    }
  }
  const readOnly = async () => { throw new Error('read-only') }
  return {
    promises: {
      async readFile(p, opts) {
        const file = blobs[norm(p)]
        if (!file) throw missing(p)
        const buf = Buffer.from(await file.arrayBuffer())
        return (typeof opts === 'string' ? opts : opts?.encoding) ? buf.toString('utf8') : buf
      },
      async readdir(p) {
        const d = dirs.get(norm(p))
        if (!d || blobs[norm(p)]) throw missing(p)
        return [...d]
      },
      stat, lstat: stat,
      readlink: readOnly, writeFile: readOnly, unlink: readOnly, mkdir: readOnly, rmdir: readOnly, symlink: readOnly, chmod: readOnly,
    },
  }
}

export const hasGit = (blobs) => '.git/HEAD' in blobs

export function openRepo(blobs) {
  const repo = { fs: makeFs(blobs), dir: '/', gitdir: '/.git', cache: {} }
  return {
    // shortcut: only the history of the current branch (HEAD), newest first; add a branch picker if people need it.
    log: (depth = 200) => git.log({ ...repo, depth }),
    // Code files (and tsconfig paths) exactly as they were at a commit.
    async filesAt(oid) {
      const files = {}
      let config
      await git.walk({
        ...repo, trees: [git.TREE({ ref: oid })],
        map: async (path, [entry]) => {
          if (path === '.') return true
          if (IGNORED.test(path + '/')) return null // skip the whole folder
          if ((await entry.type()) !== 'blob') return true
          if (CODE_EXT.test(path)) files[path] = new TextDecoder().decode(await entry.content()).replace(/\r\n/g, '\n')
          else if (/^(tsconfig|jsconfig)\.json$/.test(path)) config = new TextDecoder().decode(await entry.content())
          return true
        },
      })
      return { files, aliases: config ? readAliases(config) : undefined }
    },
  }
}
