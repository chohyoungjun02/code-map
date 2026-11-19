import dagre from '@dagrejs/dagre'
import { parse } from '@babel/parser'

export const CODE_EXT = /\.(jsx?|tsx?|mjs|cjs|py|java)$/
export const IGNORED = /(^|\/)(node_modules|dist|build|\.git|\.next|coverage|__pycache__|\.?venv|site-packages|target|\.gradle|\.idea|out)\//
const RESOLVE_EXT = ['', '.js', '.jsx', '.ts', '.tsx', '.mjs', '/index.js', '/index.jsx', '/index.ts', '/index.tsx']
// Files a framework or test runner loads by name, so nobody imports them on purpose.
const CONVENTION = /(^|\/)(page|layout|route|loading|error|not-found|template|default|middleware)\.[jt]sx?$/
const ENTRY = new RegExp('(^|/)(' + [
  '(main|index)\\.[jt]sx?', '[^/]+\\.(test|spec)\\.[mc]?[jt]sx?', '[^/]+\\.config\\.[mc]?[jt]s', '[^/]+\\.d\\.ts', // JS/TS
  '(__init__|__main__|main|app|manage|setup|conftest|wsgi|asgi)\\.py', 'test_[^/]+\\.py', '[^/]+_test\\.py', // Python
  '[^/]+Tests?\\.java', '(package|module)-info\\.java', // Java
].join('|') + ')$')

// "route.ts" x 12 is unreadable; show the route folder instead, e.g. "api/teams/[code] · route".
export function labelOf(id) {
  const name = id.split('/').pop()
  if (!CONVENTION.test(id)) return name
  const dir = id.split('/').slice(0, -1).join('/').replace(/^(.*\/)?app\/?/, '')
  return (dir || '/') + ' · ' + name.replace(/\.[jt]sx?$/, '')
}

function pluginsFor(path) {
  if (path.endsWith('.ts')) return ['typescript']
  if (path.endsWith('.tsx')) return ['typescript', 'jsx']
  return ['jsx']
}

// Collect imports ({ src, names }), export names and whether the file renders JSX.
// names lists what is taken from the module; '*' means "could be anything" (namespace, export *, dynamic import).
function scan(code, path) {
  const ast = parse(code, { sourceType: 'unambiguous', plugins: pluginsFor(path), errorRecovery: true })
  const imports = [], exports = []
  let jsx = false
  const walk = (n) => {
    if (!n || typeof n.type !== 'string') return
    switch (n.type) {
      case 'ImportDeclaration':
        imports.push({ src: n.source.value, names: n.specifiers.map((s) =>
          s.type === 'ImportDefaultSpecifier' ? 'default' : s.type === 'ImportNamespaceSpecifier' ? '*' : s.imported.name ?? s.imported.value) })
        break
      case 'ExportAllDeclaration':
        imports.push({ src: n.source.value, names: ['*'] }); break
      case 'ExportNamedDeclaration':
        if (n.source) imports.push({ src: n.source.value, names: n.specifiers.map((s) => s.local?.name ?? '*') })
        if (n.declaration?.id) exports.push(n.declaration.id.name)
        n.declaration?.declarations?.forEach((d) => d.id?.name && exports.push(d.id.name))
        n.specifiers?.forEach((s) => exports.push(s.exported.name ?? s.exported.value))
        break
      case 'ExportDefaultDeclaration':
        exports.push('default'); break
      case 'CallExpression':
        if ((n.callee.type === 'Import' || n.callee.name === 'require') && n.arguments[0]?.type === 'StringLiteral')
          imports.push({ src: n.arguments[0].value, names: ['*'] })
        break
      case 'ImportExpression':
        if (n.source?.type === 'StringLiteral') imports.push({ src: n.source.value, names: ['*'] })
        break
      case 'JSXElement':
      case 'JSXFragment':
        jsx = true
    }
    for (const k in n) {
      if (k === 'loc' || k === 'start' || k === 'end') continue
      const v = n[k]
      if (Array.isArray(v)) v.forEach(walk)
      else if (v && typeof v === 'object') walk(v)
    }
  }
  walk(ast.program)
  return { imports, exports, jsx, ...scanComponents(ast.program) }
}

// Python and Java have simple import statements, so they are read with regexes instead of a full parser.
// Their imports carry `bases`: candidate file paths without extension, best first; `rel` = relative (no suffix search).
// shortcut: imports inside strings/docstrings are not told apart from real ones; use a real parser if that causes wrong edges.
const dirOf = (path) => path.split('/').slice(0, -1).join('/')

function scanPython(code, path) {
  const imports = [], exports = []
  // `from .a.b import (x, y)` / `from pkg import x as y`
  for (const [, mod, list] of code.matchAll(/^[ \t]*from[ \t]+([.\w]+)[ \t]+import[ \t]+(\([^)]*\)|[^\n#]+)/gm)) {
    const dots = mod.match(/^\.*/)[0].length
    const rel = dots > 0
    let dir = dirOf(path)
    for (let i = 1; i < dots; i++) dir = dirOf(dir)
    const modPath = mod.slice(dots).replace(/\./g, '/')
    const base = rel ? [dir, modPath].filter(Boolean).join('/') : modPath
    for (const name of list.replace(/[()\n]/g, ' ').split(',').map((s) => s.trim().split(/\s+/)[0]).filter(Boolean)) {
      // `from pkg import mod` may name a submodule file rather than something defined in pkg.
      imports.push({ src: mod, names: [name === '*' ? '*' : name], bases: name === '*' ? [base] : [[base, name].filter(Boolean).join('/'), base], rel })
    }
  }
  // `import a.b.c as d, e`
  for (const [, list] of code.matchAll(/^[ \t]*import[ \t]+([^\n#]+)/gm)) {
    for (const mod of list.split(',').map((s) => s.trim().split(/\s+/)[0]).filter(Boolean)) imports.push({ src: mod, names: ['*'], bases: [mod.replace(/\./g, '/')], rel: false })
  }
  // A decorated def/class (`@bp.route(...)`, `@app.get`, `@pytest.fixture`) is used by the framework, not imported, so it is not an export.
  // shortcut: any decorator counts, so an unused `@lru_cache` helper is not flagged either; list framework decorators if that matters.
  for (const m of code.matchAll(/^(?:async[ \t]+)?(?:def|class)[ \t]+(\w+)|^([A-Za-z]\w*)[ \t]*(?::[^=\n]+)?=[^=]/gm)) {
    const name = m[1] ?? m[2]
    if (!name.startsWith('_') && !(m[1] && /(^|\n)@[^\n]*\n$/.test(code.slice(0, m.index)))) exports.push(name)
  }
  return { imports, exports, jsx: false, components: [], locals: {}, entry: /^if[ \t]+__name__[ \t]*==/m.test(code) }
}

function scanJava(code) {
  const clean = code.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')
  const imports = [], wildcards = []
  for (const [, isStatic, name] of clean.matchAll(/^[ \t]*import[ \t]+(static[ \t]+)?([\w.]+(?:\.\*)?)[ \t]*;/gm)) {
    if (name.endsWith('.*')) { if (!isStatic) wildcards.push(name.slice(0, -2).replace(/\./g, '/')); else imports.push({ src: name, names: ['*'], bases: [name.slice(0, -2).replace(/\./g, '/')], rel: false }); continue }
    const p = name.replace(/\./g, '/')
    imports.push({ src: name, names: ['*'], bases: isStatic ? [dirOf(p), p] : [p], rel: false })
  }
  // Classes of the same package (and of `import pkg.*`) are used without an import line, so look for their names.
  const words = new Set(clean.match(/\b[A-Z]\w*/g))
  const entry = /\bstatic\s+void\s+main\s*\(|@(SpringBootApplication|RestController|Controller|Configuration|ControllerAdvice)\b/.test(clean)
  const exports = [...clean.matchAll(/\bpublic\s+(?:(?:abstract|final|sealed|static)\s+)*(?:class|interface|enum|record|@interface)\s+(\w+)/g)].map((m) => m[1])
  return { imports, exports, jsx: false, components: [], locals: {}, entry, java: { words, wildcards } }
}

// Visits every AST node under n.
function each(n, fn) {
  if (!n || typeof n.type !== 'string') return
  fn(n)
  for (const k in n) {
    if (k === 'loc' || k === 'start' || k === 'end') continue
    const v = n[k]
    if (Array.isArray(v)) v.forEach((c) => each(c, fn))
    else if (v && typeof v === 'object') each(v, fn)
  }
}

// React components: top-level Capitalized functions that return JSX, plus the Capitalized tags each renders.
// locals maps an imported name to where it came from, so tags can be followed to other files.
function scanComponents(program) {
  const components = [], locals = {}
  let defaultName = null
  const isName = (s) => /^[A-Z]/.test(s ?? '')
  const add = (name, fn, isDefault) => {
    const tags = new Set()
    let hasJsx = false
    each(fn, (n) => {
      if (n.type === 'JSXElement' || n.type === 'JSXFragment') hasJsx = true
      if (n.type === 'JSXOpeningElement' && n.name.type === 'JSXIdentifier' && isName(n.name.name)) tags.add(n.name.name)
    })
    if (hasJsx) components.push({ name, renders: [...tags], isDefault })
  }
  // memo(...) / forwardRef(...) wrap the real function.
  const fnOf = (init) => /Function/.test(init?.type) ? init
    : init?.type === 'CallExpression' && /Function/.test(init.arguments[0]?.type) ? init.arguments[0] : null
  const declare = (d, isDefault) => {
    if (!d) return
    if (d.type === 'FunctionDeclaration') add(d.id?.name ?? 'default', d, isDefault || false)
    if (d.type === 'VariableDeclaration') d.declarations.forEach((v) => isName(v.id?.name) && fnOf(v.init) && add(v.id.name, fnOf(v.init), false))
  }
  for (const s of program.body) {
    if (s.type === 'ImportDeclaration') s.specifiers.forEach((sp) => {
      locals[sp.local.name] = { src: s.source.value, imported: sp.type === 'ImportDefaultSpecifier' ? 'default' : sp.type === 'ImportNamespaceSpecifier' ? '*' : sp.imported.name ?? sp.imported.value }
    })
    else if (s.type === 'ExportNamedDeclaration') declare(s.declaration, false)
    else if (s.type === 'ExportDefaultDeclaration') {
      if (s.declaration.type === 'Identifier') defaultName = s.declaration.name
      else if (/Function/.test(s.declaration.type)) add(s.declaration.id?.name ?? 'default', s.declaration, true)
      else if (fnOf(s.declaration)) add('default', fnOf(s.declaration), true)
    } else declare(s, false)
  }
  components.forEach((c) => { if (c.name === defaultName) c.isDefault = true })
  return { components: components.filter((c) => c.name === 'default' || isName(c.name)), locals }
}

function join(dir, rel) {
  const parts = dir ? dir.split('/') : []
  for (const p of rel.split('/')) {
    if (p === '..') parts.pop()
    else if (p !== '.' && p !== '') parts.push(p)
  }
  return parts.join('/')
}

// Tarjan SCC: every node in a component of size > 1 (or a self-import) is part of a cycle.
function findCycles(ids, edges) {
  const adj = new Map(ids.map((id) => [id, []]))
  edges.forEach((e) => adj.get(e.source).push(e.target))
  let i = 0
  const index = new Map(), low = new Map(), stack = [], onStack = new Set(), inCycle = new Set()
  const visit = (v) => {
    index.set(v, i); low.set(v, i++); stack.push(v); onStack.add(v)
    for (const w of adj.get(v)) {
      if (!index.has(w)) { visit(w); low.set(v, Math.min(low.get(v), low.get(w))) }
      else if (onStack.has(w)) low.set(v, Math.min(low.get(v), index.get(w)))
    }
    if (low.get(v) === index.get(v)) {
      const comp = []
      let w
      do { w = stack.pop(); onStack.delete(w); comp.push(w) } while (w !== v)
      if (comp.length > 1 || adj.get(v).includes(v)) comp.forEach((c) => inCycle.add(c))
    }
  }
  ids.forEach((id) => !index.has(id) && visit(id))
  return inCycle
}

/** Reads "paths" from tsconfig/jsconfig text, e.g. {"@/*": ["./src/*"]} -> [['@/', 'src/']]. Falls back to @/ -> src/. */
export function readAliases(configText) {
  try {
    // shortcut: strips // comments and trailing commas only; exotic tsconfig syntax falls back to the default.
    const json = JSON.parse(configText.replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1'))
    const paths = json.compilerOptions?.paths ?? {}
    const list = Object.entries(paths).map(([k, [v]]) => [k.replace(/\*$/, ''), join('', v.replace(/\*$/, '')) + (v.endsWith('/*') ? '/' : '')])
    if (list.length) return list
  } catch { /* fall through */ }
  return [['@/', 'src/']]
}

/** files: { [path]: sourceCode }, aliases: [[prefix, folder]]. Returns graph data with cycle/unused flags. */
export function analyze(files, aliases = [['@/', 'src/']]) {
  const ids = Object.keys(files)
  const idSet = new Set(ids)
  const nodes = {}, edges = [], errors = [], infos = {}
  // Project file an import points to, or null for packages / missing files.
  const resolve = (from, src) => {
    const alias = aliases.find(([prefix]) => src.startsWith(prefix))
    if (!src.startsWith('.') && !alias) return null
    const base = alias ? alias[1] + src.slice(alias[0].length) : join(from.split('/').slice(0, -1).join('/'), src)
    return RESOLVE_EXT.map((ext) => base + ext).find((p) => idSet.has(p)) ?? null
  }
  // Python/Java: module path -> file. Absolute imports may sit under a source root (src/, src/main/java/), so match by suffix too.
  // shortcut: suffix search is a scan over all files per import; index by suffix if huge projects get slow.
  const findModule = (bases, exts, rel) => {
    for (const b of bases) for (const e of exts) {
      const p = b + e
      if (idSet.has(p)) return p
      const hit = !rel && ids.find((f) => f.endsWith('/' + p))
      if (hit) return hit
    }
    return null
  }
  const javaIds = ids.filter((f) => f.endsWith('.java'))
  for (const id of ids) {
    const lang = id.endsWith('.py') ? 'py' : id.endsWith('.java') ? 'java' : 'js'
    let info = { imports: [], exports: [], jsx: false, components: [], locals: {} }
    try { info = lang === 'py' ? scanPython(files[id], id) : lang === 'java' ? scanJava(files[id]) : scan(files[id], id) } catch (e) { errors.push(`${id}: ${e.message}`) }
    infos[id] = info
    const local = new Map(), external = new Set()
    for (const { src, names, bases, rel } of info.imports) {
      const hit = bases ? findModule(bases, lang === 'py' ? ['.py', '/__init__.py'] : ['.java'], rel) : resolve(id, src)
      if (hit) { if (hit !== id) local.set(hit, [...(local.get(hit) ?? []), ...names]) }
      else if (bases ? !rel : !src.startsWith('.') && !aliases.some(([p]) => src.startsWith(p))) external.add(lang === 'js' ? src : src.split('.')[0])
    }
    if (info.java) {
      const dirs = [dirOf(id), ...info.java.wildcards]
      for (const other of javaIds) {
        const d = dirOf(other)
        if (other !== id && !local.has(other) && dirs.some((w) => d === w || d.endsWith('/' + w)) && info.java.words.has(other.split('/').pop().slice(0, -5))) local.set(other, ['*'])
      }
    }
    local.forEach((names, t) => edges.push({ id: `${id}->${t}`, source: id, target: t, names }))
    nodes[id] = { id, exports: info.exports, jsx: info.jsx, external: [...external], lines: files[id].split('\n').length, runs: !!info.entry }
  }
  const imported = new Set(edges.map((e) => e.target))
  const cycles = findCycles(ids, edges)
  for (const n of Object.values(nodes)) {
    n.inCycle = cycles.has(n.id)
    // runs: started by the interpreter or a framework (Python __main__, Java main / Spring controller).
    n.entry = (ENTRY.test(n.id) || CONVENTION.test(n.id) || n.runs) && !imported.has(n.id)
    n.unused = !n.entry && !imported.has(n.id)
    n.importedBy = edges.filter((e) => e.target === n.id).map((e) => e.source)
    n.isolated = !n.importedBy.length && !edges.some((e) => e.source === n.id)
  }
  addRisks(nodes, edges)
  return { nodes, edges, errors, tree: componentTree(infos, resolve) }
}

// Component tree: node per component ("file#Name"), edge when one component renders another.
// shortcut: follows direct imports only, not re-exports through index files; add barrel following if projects use them.
function componentTree(infos, resolve) {
  const nodes = {}, edges = [], defaultOf = {}
  for (const [file, info] of Object.entries(infos)) for (const c of info.components) {
    const name = c.name === 'default' ? file.split('/').pop().replace(/\.[^.]+$/, '') : c.name
    nodes[`${file}#${name}`] = { id: `${file}#${name}`, file, name, renders: [], renderedBy: [] }
    if (c.isDefault) defaultOf[file] = name
  }
  for (const [file, info] of Object.entries(infos)) for (const c of info.components) {
    const from = `${file}#${c.name === 'default' ? defaultOf[file] : c.name}`
    for (const tag of c.renders) {
      let to = `${file}#${tag}`
      const imp = info.locals[tag]
      if (!nodes[to] && imp) {
        const target = resolve(file, imp.src)
        to = target && `${target}#${imp.imported === 'default' ? defaultOf[target] : imp.imported}`
      }
      if (to && nodes[to] && to !== from && !nodes[from].renders.includes(to)) {
        nodes[from].renders.push(to)
        nodes[to].renderedBy.push(from)
        edges.push({ id: `${from}->${to}`, source: from, target: to })
      }
    }
  }
  for (const n of Object.values(nodes)) {
    n.importedBy = n.renderedBy // layout() reads importedBy
    n.isolated = !n.renders.length && !n.renderedBy.length
  }
  return { nodes, edges }
}

export const BIG_FILE = 300

// Maintenance risks per file: { kind, text } with a plain-language reason. No AI, just the graph.
function addRisks(nodes, edges) {
  const total = Object.keys(nodes).length
  const reverse = new Map(Object.keys(nodes).map((id) => [id, []]))
  edges.forEach((e) => reverse.get(e.target).push(e.source))
  const hubLimit = Math.max(5, Math.ceil(total * 0.2))
  for (const n of Object.values(nodes)) {
    // Everything that imports this file directly or through other files.
    const seen = new Set(), queue = [n.id]
    while (queue.length) reverse.get(queue.pop()).forEach((p) => !seen.has(p) && p !== n.id && (seen.add(p), queue.push(p)))
    n.impact = seen.size
    const used = new Set(edges.filter((e) => e.target === n.id).flatMap((e) => e.names))
    n.unusedExports = n.entry || used.has('*') ? [] : n.exports.filter((x) => !used.has(x))
    n.risks = []
    if (n.inCycle) n.risks.push({ kind: 'cycle', text: '순환 의존: 서로가 서로를 import 해서, 한쪽을 고치면 다른 쪽도 함께 깨질 수 있습니다.' })
    if (n.impact >= hubLimit) n.risks.push({ kind: 'impact', text: `영향 범위 큼: 파일 ${n.impact}개가 이 파일에 (간접 포함) 의존합니다. 수정 전 주의하세요.` })
    if (n.lines > BIG_FILE) n.risks.push({ kind: 'big', text: `큰 파일: ${n.lines}줄입니다. 역할별로 나누면 읽고 고치기 쉬워집니다.` })
    if (n.unused) n.risks.push({ kind: 'unused', text: '사용 안 됨: 어떤 파일도 import 하지 않습니다. 지워도 되는지 확인하세요.' })
    else if (n.unusedExports.length) n.risks.push({ kind: 'exports', text: `안 쓰는 export: ${n.unusedExports.join(', ')}` })
  }
}

export const NODE_W = 220, NODE_H = 46
const GROUP_PAD = 16, GROUP_HEAD = 26

// Folder a file is boxed into: its directory, cut to 3 levels (src/app/api/auth/login -> src/app/api).
export function groupOf(id) {
  const dir = id.split('/').slice(0, -1)
  return dir.slice(0, 3).join('/') || '(루트)'
}

// dagre orders nodes inside each column to minimise crossing edges.
export function layout(nodes, edges, grouped = false) {
  const g = new dagre.graphlib.Graph({ compound: grouped })
    .setGraph({ rankdir: 'LR', ranksep: 120, nodesep: grouped ? 24 : 18 }).setDefaultEdgeLabel(() => ({}))
  const connected = Object.keys(nodes).filter((id) => !nodes[id].isolated)
  const folders = new Set()
  connected.forEach((id) => {
    g.setNode(id, { width: NODE_W, height: NODE_H })
    if (!grouped) return
    const folder = 'dir:' + groupOf(id)
    if (!folders.has(folder)) { folders.add(folder); g.setNode(folder, { paddingLeft: GROUP_PAD, paddingRight: GROUP_PAD, paddingTop: GROUP_HEAD + 8, paddingBottom: GROUP_PAD }) }
    g.setParent(id, folder)
  })
  edges.forEach((e) => g.setEdge(e.source, e.target))
  dagre.layout(g)
  const pos = {}
  let bottom = 0, right = 0
  connected.forEach((id) => {
    const { x, y } = g.node(id)
    pos[id] = { x: x - NODE_W / 2, y: y - NODE_H / 2 }
    bottom = Math.max(bottom, y + NODE_H / 2)
    right = Math.max(right, x + NODE_W / 2)
  })
  // Folder boxes, drawn behind the files. Size comes from the files inside so the box always fits them.
  const groups = [...folders].map((folder) => {
    const kids = g.children(folder).map((id) => pos[id])
    const x = Math.min(...kids.map((p) => p.x)) - GROUP_PAD, y = Math.min(...kids.map((p) => p.y)) - GROUP_HEAD - 8
    const w = Math.max(...kids.map((p) => p.x)) + NODE_W + GROUP_PAD - x, h = Math.max(...kids.map((p) => p.y)) + NODE_H + GROUP_PAD - y
    bottom = Math.max(bottom, y + h)
    return { id: folder, name: folder.slice(4), x, y, w, h, count: kids.length }
  })
  // Files with no imports in either direction go in their own grid below the graph.
  const isolatedTop = connected.length ? bottom + 100 : 40
  const cols = Math.max(4, Math.floor(right / (NODE_W + 40)))
  Object.keys(nodes).filter((id) => nodes[id].isolated).sort().forEach((id, k) => {
    pos[id] = { x: (k % cols) * (NODE_W + 40), y: isolatedTop + Math.floor(k / cols) * (NODE_H + 30) }
  })
  return { pos, isolatedTop, groups }
}
