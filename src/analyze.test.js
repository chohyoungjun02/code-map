import assert from 'node:assert'
import { analyze, layout, readAliases } from './analyze.js'
const g = analyze({
  'src/main.jsx': "import App from './App'\nimport { createRoot } from 'react-dom/client'",
  'src/App.jsx': "import { a } from './util/a.js'\nimport { c } from '@/lib/c'\nexport default function App(){ return <div/> }",
  'src/lib/c.ts': "export const c = 3",
  'src/util/a.js': "import { b } from './b'\nexport const a = 1",
  'src/util/b.ts': "import { a } from './a'\nexport const b: number = 2",
  'src/old.js': "export function old() {}",
  'src/lazy.jsx': "const X = import('./old.js')",
  'next.config.ts': "export default {}",
})
assert.deepEqual(g.errors, [])
assert.equal(g.nodes['src/main.jsx'].entry, true)
assert.deepEqual(g.nodes['src/main.jsx'].external, ['react-dom/client'])
assert.equal(g.nodes['src/App.jsx'].jsx, true)
assert.deepEqual(g.nodes['src/lib/c.ts'].importedBy, ['src/App.jsx']) // @/ alias resolved
assert.equal(g.nodes['src/util/a.js'].inCycle, true)
assert.equal(g.nodes['src/util/b.ts'].inCycle, true)
assert.equal(g.nodes['src/App.jsx'].inCycle, false)
assert.equal(g.nodes['src/old.js'].unused, false) // dynamically imported
assert.equal(g.nodes['src/lazy.jsx'].unused, true)
assert.deepEqual(g.nodes['src/util/b.ts'].exports, ['b'])
assert.equal(g.nodes['next.config.ts'].isolated, true)
assert.equal(g.nodes['src/lazy.jsx'].isolated, false)
const { pos, isolatedTop } = layout(g.nodes, g.edges)
assert.ok(pos['src/App.jsx'].x > pos['src/main.jsx'].x)
assert.ok(pos['next.config.ts'].y >= isolatedTop)
assert.ok(Object.entries(pos).every(([id, p]) => g.nodes[id].isolated || p.y < isolatedTop))
assert.deepEqual(readAliases('{\n // c\n "compilerOptions": { "paths": { "~/*": ["./app/*"], } } }'), [['~/', 'app/']])
assert.deepEqual(readAliases('not json'), [['@/', 'src/']])
console.log('ok')
{
  const { labelOf } = await import('./analyze.js')
  assert.equal(labelOf('src/app/api/teams/[code]/route.ts'), 'api/teams/[code] · route')
  assert.equal(labelOf('src/app/page.tsx'), '/ · page')
  assert.equal(labelOf('src/lib/db.ts'), 'db.ts')
  const n = analyze({ 'src/app/api/x/route.ts': "import { db } from '@/lib/db'", 'src/lib/db.ts': 'export const db = 1', 'src/lib/db.test.mjs': "import { db } from './db.ts'" }).nodes
  assert.equal(n['src/app/api/x/route.ts'].unused, false)
  assert.equal(n['src/lib/db.test.mjs'].unused, false)
  console.log('ok next')
}
{
  const { groupOf, NODE_W, NODE_H } = await import('./analyze.js')
  assert.equal(groupOf('src/app/api/auth/login/route.ts'), 'src/app/api')
  assert.equal(groupOf('src/lib/db.ts'), 'src/lib')
  assert.equal(groupOf('next.config.ts'), '(루트)')
  const { pos, groups } = layout(g.nodes, g.edges, true)
  assert.ok(groups.length >= 3)
  for (const gr of groups) for (const [id, p] of Object.entries(pos)) {
    if (g.nodes[id].isolated || 'dir:' + groupOf(id) !== gr.id) continue
    assert.ok(p.x >= gr.x && p.y >= gr.y && p.x + NODE_W <= gr.x + gr.w && p.y + NODE_H <= gr.y + gr.h, id + ' inside ' + gr.id)
  }
  console.log('ok groups')
}
{
  const r = analyze({
    'src/main.jsx': "import { used } from './lib'\nimport * as all from './ns'",
    'src/lib.js': "export const used = 1\nexport const dead = 2\n" + 'x\n'.repeat(310),
    'src/ns.js': "export const a = 1",
    'src/hub.js': "export const h = 1",
    'vite.config.js': "export default {}",
  }).nodes
  assert.deepEqual(r['src/lib.js'].unusedExports, ['dead'])
  assert.deepEqual(r['src/ns.js'].unusedExports, []) // namespace import may use anything
  assert.ok(r['src/lib.js'].risks.some((x) => x.kind === 'big'))
  assert.equal(r['vite.config.js'].unused, false)
  assert.ok(r['src/hub.js'].risks.some((x) => x.kind === 'unused'))
  const { compareVersions, lineDiff } = await import('./diff.js')
  const oldF = { 'a.js': "import './b.js'", 'b.js': 'x', 'gone.js': '' }
  const newF = { 'a.js': "import './c.js'", 'b.js': 'x', 'c.js': 'y' }
  const d = compareVersions(oldF, newF, analyze(oldF), analyze(newF))
  assert.deepEqual(d.status, { 'a.js': 'changed', 'b.js': 'same', 'c.js': 'added' })
  assert.deepEqual(d.removed, ['gone.js'])
  assert.deepEqual([...d.addedEdges], ['a.js->c.js'])
  assert.deepEqual(d.removedEdges.map((e) => e.id), ['a.js->b.js'])
  assert.deepEqual(lineDiff('a\nb\nc', 'a\nc\nd').map((l) => l.type + l.text), [' a', '-b', ' c', '+d'])
  console.log('ok risks/diff')
}
{
  const t = analyze({
    'src/main.jsx': "import App from './App'\ncreateRoot(root).render(<App />)",
    'src/App.jsx': "import Header from './Header'\nimport { List, Item } from './List'\nexport default function App() { return <><Header /><List /><Local /></> }\nconst Local = () => <div />",
    'src/Header.jsx': "function Header() { return <h1>hi</h1> }\nexport default Header",
    'src/List.jsx': "export const Item = memo(() => <li />)\nexport function List() { return <ul><Item /></ul> }\nexport function helper() { return 1 }",
    'src/app/page.tsx': "export default function () { return <main /> }",
  }).tree
  assert.deepEqual(Object.keys(t.nodes).sort(), ['src/App.jsx#App', 'src/App.jsx#Local', 'src/Header.jsx#Header', 'src/List.jsx#Item', 'src/List.jsx#List', 'src/app/page.tsx#page'])
  assert.deepEqual(t.nodes['src/App.jsx#App'].renders.sort(), ['src/App.jsx#Local', 'src/Header.jsx#Header', 'src/List.jsx#List'])
  assert.deepEqual(t.nodes['src/List.jsx#List'].renders, ['src/List.jsx#Item'])
  assert.equal(t.nodes['src/app/page.tsx#page'].isolated, true)
  const { pos } = layout(t.nodes, t.edges, true)
  assert.ok(pos['src/Header.jsx#Header'].x > pos['src/App.jsx#App'].x)
  console.log('ok tree')
}

{ // Python: absolute (under src/), relative, submodule-from-package, __main__ entry, packages are external
  const g = analyze({
    'src/app/main.py': "import os\nfrom app.services import user_service\nfrom .models import (User,\n  Post)\nif __name__ == '__main__':\n  pass",
    'src/app/models.py': "from ..app.util import slug\nclass User: pass\nclass Post: pass\n_hidden = 1",
    'src/app/services/__init__.py': "",
    'src/app/services/user_service.py': "from . import helpers\nimport app.models as m\ndef get(): pass",
    'src/app/services/helpers.py': "def h(): pass",
    'src/app/util.py': "def slug(): pass",
    'tests/test_user.py': "from app.models import User",
    'scripts/lonely.py': "print(1)",
  })
  const n = g.nodes
  assert.deepEqual(n['src/app/main.py'].external, ['os'])
  assert.equal(n['src/app/main.py'].entry, true)
  assert.deepEqual(n['src/app/services/user_service.py'].importedBy, ['src/app/main.py'])
  assert.deepEqual(n['src/app/models.py'].importedBy.sort(), ['src/app/main.py', 'src/app/services/user_service.py', 'tests/test_user.py'])
  assert.deepEqual(n['src/app/services/helpers.py'].importedBy, ['src/app/services/user_service.py'])
  assert.deepEqual(n['src/app/util.py'].importedBy, ['src/app/models.py'])
  assert.deepEqual(n['src/app/models.py'].exports, ['User', 'Post'])
  assert.equal(n['tests/test_user.py'].entry, true)
  assert.equal(n['scripts/lonely.py'].isolated, true)
  console.log('ok python')
}

{ // Java: explicit import, same package without import, wildcard import, static import, main entry
  const j = 'src/main/java/com/shop/'
  const g = analyze({
    [j + 'App.java']: "package com.shop;\nimport com.shop.web.OrderController;\npublic class App { public static void main(String[] a) { new OrderController(); } }",
    [j + 'web/OrderController.java']: "package com.shop.web;\nimport com.shop.service.*;\nimport static com.shop.util.Money.format;\n@RestController\npublic class OrderController { OrderService s; }",
    [j + 'service/OrderService.java']: "package com.shop.service;\n// uses Repo below, not Unrelated\npublic class OrderService { OrderRepo r; }",
    [j + 'service/OrderRepo.java']: "package com.shop.service;\npublic interface OrderRepo {}",
    [j + 'service/Unrelated.java']: "package com.shop.service;\nclass Unrelated {}",
    [j + 'util/Money.java']: "package com.shop.util;\nimport java.util.List;\npublic final class Money { static String format() { return \"\"; } }",
  })
  const n = g.nodes
  assert.deepEqual(n[j + 'web/OrderController.java'].importedBy, [j + 'App.java'])
  assert.equal(n[j + 'App.java'].entry, true)
  assert.deepEqual(n[j + 'service/OrderService.java'].importedBy, [j + 'web/OrderController.java']) // wildcard + name used
  assert.deepEqual(n[j + 'service/OrderRepo.java'].importedBy, [j + 'service/OrderService.java']) // same package
  assert.deepEqual(n[j + 'service/Unrelated.java'].importedBy, []) // name only in a comment / not used
  assert.deepEqual(n[j + 'util/Money.java'].importedBy, [j + 'web/OrderController.java']) // static import
  assert.deepEqual(n[j + 'util/Money.java'].external, ['java'])
  assert.deepEqual(n[j + 'util/Money.java'].exports, ['Money'])
  console.log('ok java')
}
