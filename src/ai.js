import { groupOf } from './analyze.js'
import { lineDiff } from './diff.js'

// Optional AI explanations (Gemini, free tier). Only these functions send code out of the browser, and only when the user clicks.
// The request goes to our own /api/gemini relay (server/gemini-proxy.js), which adds the API key on the server.
// Total code sent per request; split evenly over files so every folder is represented.
// shortcut: on very large projects each file gets only a few hundred characters; split into several requests if that becomes common.
export const MAX_CHARS = 120_000
const PER_FILE_MAX = 6_000 // small projects: roughly the whole file
const PER_FILE_MIN = 400 // huge projects: still the path, exports and the top of the file

// Gemini Interactions API (revision 2026-05-20): JSON text comes back in steps[type=model_output].content[].text.
async function ask(system, prompt, schema) {
  let res
  try {
    res = await fetch('/api/gemini', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: `${system}\n\n${prompt}`,
        response_format: { type: 'text', mime_type: 'application/json', schema },
      }),
    })
  } catch {
    throw new Error('서버에 연결하지 못했습니다.')
  }
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    const msg = body.error?.message ?? ''
    if (res.status === 503) throw new Error('Google AI 서버가 지금 붐빕니다. 잠시 후 다시 시도하세요.')
    if (res.status === 429) throw new Error('무료 사용 한도를 넘었습니다. 잠시 후(또는 내일) 다시 시도하세요.')
    if (res.status === 403 || /api key/i.test(msg)) throw new Error('서버에 설정된 Gemini API 키가 올바르지 않습니다.')
    throw new Error(msg || `AI 오류 (${res.status})`)
  }
  const text = (body.steps ?? []).filter((s) => s.type === 'model_output').flatMap((s) => s.content ?? []).map((c) => c.text ?? '').join('')
  if (!text) throw new Error('AI가 빈 답변을 보냈습니다.')
  return JSON.parse(text)
}

const SYSTEM = '당신은 코드를 처음 보는 개발자에게 프로젝트 구조를 설명하는 시니어 개발자입니다. 한국어로, 짧고 구체적으로 답합니다.'

// Text sent for one file: path, exports and its code up to `max` characters.
const fileBrief = (id, code, node, max) =>
  `--- ${id}${node?.exports.length ? ` (export: ${node.exports.join(', ')})` : ''}\n${code.length > max ? code.slice(0, max) + '\n…(생략)' : code}`

/**
 * { folder: { role } } for every folder box in the graph.
 * guesses ({ folder: text }, 꿈나무 모드): also comments on each guess -> { role, feedback }.
 * No right/wrong verdict on purpose: a free-text guess about a folder's role is too open to grade.
 */
export async function folderRoles(files, graph, guesses = {}) {
  const guessed = Object.entries(guesses).filter(([, t]) => t.trim())
  const ids = Object.keys(files).sort()
  const max = Math.max(PER_FILE_MIN, Math.min(PER_FILE_MAX, Math.floor(MAX_CHARS / ids.length)))
  const byFolder = {}
  for (const id of ids) (byFolder[groupOf(id)] ??= []).push(fileBrief(id, files[id], graph.nodes[id], max))
  const body = Object.entries(byFolder).map(([f, briefs]) => `### 폴더: ${f}\n${briefs.join('\n')}`).join('\n\n')
  const out = await ask(SYSTEM,
    `아래는 프로젝트 파일을 폴더별로 묶은 것입니다(긴 파일은 앞부분만).\n` +
    `폴더마다 "이 폴더가 프로젝트에서 맡은 역할"을 한 문장(40자 안팎)으로 설명하세요. folder 값은 "### 폴더:" 뒤의 이름을 그대로 쓰세요.\n` +
    (guessed.length
      ? `\n코드 구조를 공부하는 학생이 코드를 보기 전에 폴더 역할을 추측했습니다. 추측이 있는 폴더는 ` +
        `feedback(채점하지 말고, 추측에서 잘 본 점과 더 살펴볼 점을 학생 눈높이로 한두 문장, 근거가 된 파일 이름 포함)도 쓰세요. 추측이 없는 폴더는 feedback을 비워 두세요.\n` +
        guessed.map(([f, t]) => `- ${f}: ${t.trim()}`).join('\n') + '\n'
      : '') +
    `\n${body}`,
    {
      type: 'object', required: ['folders'],
      properties: { folders: { type: 'array', items: { type: 'object', required: ['folder', 'role'], properties: {
        folder: { type: 'string' }, role: { type: 'string' },
        ...(guessed.length && { feedback: { type: 'string' } }),
      } } } },
    })
  return Object.fromEntries(out.folders.map(({ folder, ...rest }) => [folder, rest]))
}

/** One-line Korean summary of what changed between two versions. */
export async function changeSummary(oldFiles, newFiles, diff) {
  const parts = []
  for (const [id, s] of Object.entries(diff.status)) {
    if (s === 'added') parts.push(`+++ 새 파일 ${id}\n${newFiles[id].slice(0, PER_FILE_MAX)}`)
    if (s === 'changed') parts.push(`*** 변경 ${id}\n${lineDiff(oldFiles[id], newFiles[id]).filter((l) => l.type !== ' ').map((l) => l.type + ' ' + l.text).join('\n')}`)
  }
  diff.removed.forEach((id) => parts.push(`--- 삭제된 파일 ${id}`))
  if (!parts.length) return '바뀐 코드가 없습니다.'
  const out = await ask(SYSTEM,
    `두 버전 사이의 코드 변경입니다("+" 추가된 줄, "-" 지운 줄).\n무엇이 왜 바뀌었는지 사용자 입장에서 한 줄(60자 안팎)로 요약하세요.\n\n${parts.join('\n\n').slice(0, MAX_CHARS)}`,
    { type: 'object', required: ['summary'], properties: { summary: { type: 'string' } } })
  return out.summary
}
