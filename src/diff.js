// Compare two analysed versions of a project: which files and import links were added, removed or changed.
export function compareVersions(oldFiles, newFiles, oldGraph, newGraph) {
  const status = {}
  for (const id of Object.keys(newFiles)) status[id] = !(id in oldFiles) ? 'added' : oldFiles[id] !== newFiles[id] ? 'changed' : 'same'
  const removed = Object.keys(oldFiles).filter((id) => !(id in newFiles))
  const oldEdges = new Set(oldGraph.edges.map((e) => e.id))
  const newEdges = new Set(newGraph.edges.map((e) => e.id))
  return {
    status,
    removed,
    addedEdges: new Set([...newEdges].filter((id) => !oldEdges.has(id))),
    removedEdges: oldGraph.edges.filter((e) => !newEdges.has(e.id)),
    newRisks: Object.values(newGraph.nodes).filter((n) => n.risks.some((r) => !oldGraph.nodes[n.id]?.risks.some((o) => o.kind === r.kind))),
  }
}

// Line diff via longest common subsequence. Returns [{ type: ' ' | '+' | '-', text }].
export function lineDiff(a, b) {
  const x = a.split('\n'), y = b.split('\n')
  // shortcut: O(n*m) memory; fine for files up to a few thousand lines, switch to Myers diff for bigger ones.
  if (x.length * y.length > 4e6) return [{ type: '!', text: '파일이 너무 커서 줄 단위 비교를 생략했습니다.' }]
  const n = x.length, m = y.length
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1])
  const out = []
  let i = 0, j = 0
  while (i < n && j < m) {
    if (x[i] === y[j]) { out.push({ type: ' ', text: x[i] }); i++; j++ }
    else if (L[i + 1][j] >= L[i][j + 1]) out.push({ type: '-', text: x[i++] })
    else out.push({ type: '+', text: y[j++] })
  }
  while (i < n) out.push({ type: '-', text: x[i++] })
  while (j < m) out.push({ type: '+', text: y[j++] })
  return out
}
