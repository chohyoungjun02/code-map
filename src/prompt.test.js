// Run: node src/prompt.test.js
import assert from 'node:assert'
import { analyze } from './analyze.js'
import { buildFixPrompt, estimateTokens, findFilesInError, neighbors, wholeProjectTokens } from './prompt.js'

const files = {
  'src/main.js': "import { run } from './app.js'\nrun()",
  'src/app.js': "import { add } from './math.js'\nexport function run() { return add(1) }",
  'src/math.js': 'export const add = (a, b) => a + b',
  'src/big.js': 'x'.repeat(4000),
}
const graph = analyze(files)
assert.deepEqual(neighbors(graph, 'src/app.js'), { uses: ['src/math.js'], usedBy: ['src/main.js'] })

const p = buildFixPrompt({ files, graph, id: 'src/app.js', include: ['src/math.js', 'src/app.js'], problem: ' NaN이 나와요 ' })
assert.ok(p.includes('## 오류 / 증상\nNaN이 나와요\n'))
assert.ok(p.includes('### src/app.js\n```js\n') && p.includes('### src/math.js'))
assert.equal(p.split('### src/app.js').length, 2) // not duplicated when also in include
assert.ok(!p.includes('### src/main.js') && !p.includes('xxxx')) // unchecked / unrelated files stay out
assert.ok(p.includes('이 파일을 import 하는 파일 (수정하면 영향받음): src/main.js'))
assert.ok(p.includes('전체 4개 파일 중 관련 파일 2개만'))
assert.ok(buildFixPrompt({ files, graph, id: 'src/math.js', include: [], problem: '' }).includes('(여기에 오류 메시지'))

assert.equal(estimateTokens('abcd'), 1)
assert.equal(estimateTokens('오류'), 2)
assert.ok(wholeProjectTokens(files) > estimateTokens(p))

{ // findFilesInError: stack traces from the browser, Windows, Python and Java
  const ids = ['src/App.jsx', 'src/data.js', 'src/a.js', 'src/lib/a.js', 'app/models.py', 'src/main/java/com/shop/OrderController.java', 'src/index.js', 'src/ui/index.js']
  const browser = 'TypeError: x is undefined\n    at run (http://localhost:5173/src/lib/a.js?t=17:4:2)\n    at http://localhost:5173/src/App.jsx:42:7'
  assert.deepEqual(findFilesInError(browser, ids), ['src/lib/a.js', 'src/App.jsx']) // top frame first
  assert.deepEqual(findFilesInError('at C:\\proj\\src\\data.js:3', ids), ['src/data.js']) // Windows path, and not src/a.js
  assert.deepEqual(findFilesInError('File "/home/me/proj/app/models.py", line 3, in get', ids), ['app/models.py'])
  assert.deepEqual(findFilesInError('at com.shop.OrderController.get(OrderController.java:42)', ids), ['src/main/java/com/shop/OrderController.java'])
  assert.deepEqual(findFilesInError('at index.js:3', ids), []) // two index.js files: too ambiguous by name alone
  assert.deepEqual(findFilesInError('no paths here', ids), [])
}
console.log('ok prompt')
