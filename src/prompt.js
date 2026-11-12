// Builds a bug-fix prompt that sends only the files around one file, instead of the whole project.

const LANG = { js: 'js', jsx: 'jsx', mjs: 'js', cjs: 'js', ts: 'ts', tsx: 'tsx', py: 'python', java: 'java' }

// shortcut: rough count (~4 ASCII chars per token, ~1 token per Korean/other char); use the model's tokenizer for exact numbers.
export function estimateTokens(text) {
  const ascii = text.replace(/[^\x00-\x7f]/g, '').length
  return Math.ceil(ascii / 4) + (text.length - ascii)
}

/** Files worth sending with `id`: the file, what it imports, and who imports it. */
export function neighbors(graph, id) {
  return {
    uses: graph.edges.filter((e) => e.source === id).map((e) => e.target),
    usedBy: graph.nodes[id].importedBy,
  }
}

/** include: file ids whose code goes in the prompt (id itself is always included). */
export function buildFixPrompt({ files, graph, id, include, problem }) {
  const n = graph.nodes[id]
  const { uses, usedBy } = neighbors(graph, id)
  const sent = [id, ...include.filter((f) => f !== id && files[f] != null)]
  const list = (ids) => ids.join(', ') || '없음'
  return [
    '아래 프로젝트에서 오류를 고쳐 주세요. 고친 부분은 파일 이름과 함께 바뀐 코드만 보여 주세요.',
    '',
    '## 오류 / 증상',
    problem.trim() || '(여기에 오류 메시지나 어떤 동작이 이상한지 적어 주세요)',
    '',
    '## 프로젝트 구조 (Code Map 분석)',
    `- 문제로 보이는 파일: ${id} (${n.lines}줄${n.entry ? ', 진입점' : ''})`,
    `- 이 파일이 import 하는 파일: ${list(uses)}`,
    `- 이 파일을 import 하는 파일 (수정하면 영향받음): ${list(usedBy)}`,
    ...(n.external.length ? [`- 외부 패키지: ${n.external.join(', ')}`] : []),
    ...n.risks.map((r) => `- 주의: ${r.text}`),
    `- 전체 ${Object.keys(files).length}개 파일 중 관련 파일 ${sent.length}개만 보냅니다. 다른 파일이 필요하면 파일 이름을 말해 주세요.`,
    '',
    '## 코드',
    ...sent.map((f) => `### ${f}\n\`\`\`${LANG[f.split('.').pop()] ?? ''}\n${files[f]}\n\`\`\``),
  ].join('\n')
}

/** The same request with every file pasted in, to show how much the focused prompt saves. */
export const wholeProjectTokens = (files) =>
  estimateTokens(Object.entries(files).map(([f, code]) => `### ${f}\n\`\`\`\n${code}\n\`\`\``).join('\n'))
