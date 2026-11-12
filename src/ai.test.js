// Stubs fetch, so nothing is sent to Google. Run: node src/ai.test.js
import assert from 'node:assert'
import { Readable } from 'node:stream'
import { analyze } from './analyze.js'
import { compareVersions } from './diff.js'
import { changeSummary, folderRoles } from './ai.js'
import { geminiHandler } from '../server/gemini-proxy.js'

// Fake Google: answers like the Interactions API.
let toGoogle, googleStatus = 200
const google = async (url, init) => {
  toGoogle = { url, headers: init.headers, body: JSON.parse(init.body) }
  const answer = toGoogle.body.response_format.schema.required[0] === 'folders' ? '{"folders":[{"folder":"(루트)","role":"앱 전체"}]}' : '{"summary":"b 기능 추가"}'
  const body = googleStatus === 200
    ? { id: 'i', status: 'completed', steps: [{ type: 'thought', summary: [] }, { type: 'model_output', content: [{ type: 'text', text: answer }] }] }
    : { error: { code: googleStatus, message: 'API key not valid. Please pass a valid API key.' } }
  return new Response(JSON.stringify(body), { status: googleStatus, headers: { 'content-type': 'application/json' } })
}

// Runs the relay in-process: browser fetch('/api/gemini') -> geminiHandler -> fake Google.
let serverKey = 'server-key'
globalThis.fetch = async (url, init) => {
  if (url !== '/api/gemini') return google(url, init)
  const req = Object.assign(Readable.from([init.body]), { url, method: init.method })
  return new Promise((done) => {
    const res = { statusCode: 200, setHeader() {}, end: (b) => done(new Response(b, { status: res.statusCode })) }
    geminiHandler(serverKey)(req, res, () => done(new Response('not handled', { status: 404 })))
  })
}

const oldF = { 'a.js': 'export const a = 1' }, newF = { 'a.js': 'export const a = 2', 'b.js': 'export const b = 1' }
const d = compareVersions(oldF, newF, analyze(oldF), analyze(newF))

assert.equal(await changeSummary(oldF, newF, d), 'b 기능 추가')
assert.equal(toGoogle.url, 'https://generativelanguage.googleapis.com/v1beta/interactions')
assert.equal(toGoogle.headers['x-goog-api-key'], 'server-key') // key added on the server, not by the page
assert.equal(toGoogle.body.model, 'gemini-3.5-flash-lite')
assert.ok(!JSON.stringify(toGoogle.body).includes('additionalProperties'))
assert.ok(toGoogle.body.input.includes('+ export const a = 2') && toGoogle.body.input.includes('새 파일 b.js'))
assert.deepEqual(await folderRoles(newF, analyze(newF)), { '(루트)': { role: '앱 전체' } })
assert.ok(!('feedback' in toGoogle.body.response_format.schema.properties.folders.items.properties))
// 꿈나무 모드: the guess goes into the prompt and the schema asks for feedback.
await folderRoles(newF, analyze(newF), { '(루트)': '숫자 상수 모음', other: '  ' })
assert.ok(toGoogle.body.input.includes('- (루트): 숫자 상수 모음') && !toGoogle.body.input.includes('- other'))
assert.ok('feedback' in toGoogle.body.response_format.schema.properties.folders.items.properties)

googleStatus = 400
await assert.rejects(changeSummary(oldF, newF, d), /Gemini API 키가 올바르지 않습니다/)
googleStatus = 429
await assert.rejects(changeSummary(oldF, newF, d), /무료 사용 한도/)
serverKey = ''
await assert.rejects(changeSummary(oldF, newF, d), /GEMINI_API_KEY가 설정되지 않았습니다/)
const same = compareVersions(oldF, oldF, analyze(oldF), analyze(oldF))
assert.equal(await changeSummary(oldF, oldF, same), '바뀐 코드가 없습니다.')
console.log('ok ai')
