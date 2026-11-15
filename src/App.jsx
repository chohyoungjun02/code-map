import { useEffect, useMemo, useRef, useState } from 'react'
import { ReactFlow, Background, Controls, MiniMap, Handle, Position, MarkerType } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { analyze, layout, readAliases, labelOf, CODE_EXT, IGNORED, NODE_W, NODE_H } from './analyze.js'
import { compareVersions, lineDiff } from './diff.js'
import { demoFiles } from './demo.js'
import { buildFixPrompt, estimateTokens, findFilesInError, neighbors, wholeProjectTokens } from './prompt.js'

const RISK_TAG = { cycle: '순환', impact: '영향 큼', big: '큰 파일', unused: '사용 안 됨', exports: '안 쓰는 export' }
const DIFF_TAG = { added: '새 파일', changed: '변경됨' }

function FileNode({ data }) {
  const n = data.file
  const cls = ['fnode', n.entry && 'entry', n.unused && 'unused', n.inCycle && 'cycle', data.diff, data.selected && 'selected', data.dim && 'dim']
  return (
    <div className={cls.filter(Boolean).join(' ')} title={data.role && `🤖 ${data.role}`}>
      <Handle type="target" position={Position.Left} />
      {n.risks.length > 0 && <span className="risk-badge" title={n.risks.map((r) => r.text).join('\n')}>⚠ {n.risks.length}</span>}
      {DIFF_TAG[data.diff] && <span className={'diff-badge ' + data.diff}>{DIFF_TAG[data.diff]}</span>}
      <b>{labelOf(n.id)}</b> {n.jsx && '⚛'}
      <small>{n.id}</small>
      <Handle type="source" position={Position.Right} />
    </div>
  )
}
function CompNode({ data }) {
  const c = data.comp
  const cls = ['fnode', 'comp', !c.renderedBy.length && 'entry', data.diff, data.selected && 'selected', data.dim && 'dim']
  return (
    <div className={cls.filter(Boolean).join(' ')} title={data.role && `🤖 ${data.role}`}>
      <Handle type="target" position={Position.Left} />
      {DIFF_TAG[data.diff] && <span className={'diff-badge ' + data.diff}>파일 {DIFF_TAG[data.diff]}</span>}
      <b>&lt;{c.name} /&gt;</b>
      <small>{c.file}</small>
      <Handle type="source" position={Position.Right} />
    </div>
  )
}
const nodeTypes = {
  file: FileNode,
  comp: CompNode,
  label: ({ data }) => <div className="group-label">{data.text}</div>,
  folder: ({ data }) => (
    <div className="folder" style={{ width: data.w, height: data.h }}>
      <span title={data.role}>📁 {data.name} ({data.count}){data.role && <em> — {data.role}</em>}</span>
    </div>
  ),
}


// Reads a picked folder into { files: { path: code }, aliases, git }.
// git holds the raw .git files (not read yet) when the folder is a repository, else null.
async function readFolder(fileList) {
  const rel = (f) => f.webkitRelativePath.split('/').slice(1).join('/')
  const gitFiles = Object.fromEntries(fileList.filter((f) => rel(f).startsWith('.git/')).map((f) => [rel(f), f]))
  const config = fileList.find((f) => /^[^/]+\/(tsconfig|jsconfig)\.json$/.test(f.webkitRelativePath))
  const aliases = config ? readAliases(await config.text()) : undefined
  const list = fileList.filter((f) => CODE_EXT.test(f.name) && !IGNORED.test(f.webkitRelativePath))
  // shortcut: whole files are read into memory, fine for typical student/side projects; stream or use a worker for huge repos.
  // CRLF -> LF so a Windows checkout does not look "changed" against the commits git stores with LF.
  const entries = await Promise.all(list.map(async (f) => [rel(f), (await f.text()).replace(/\r\n/g, '\n')]))
  return { files: Object.fromEntries(entries), aliases, git: '.git/HEAD' in gitFiles ? gitFiles : null }
}

export default function App() {
  const [folder, setFolder] = useState(null) // the picked folder as it is now
  const [project, setProject] = useState(null) // the version on screen: the folder or a commit
  const [base, setBase] = useState(null) // older commit to compare against
  const [repo, setRepo] = useState(null)
  const [commits, setCommits] = useState(null)
  const [fromRef, setFromRef] = useState('') // '' = no comparison
  const [toRef, setToRef] = useState('work') // 'work' = the folder as it is now
  const [selected, setSelected] = useState(null)
  const [hovered, setHovered] = useState(null)
  const [grouped, setGrouped] = useState(true)
  const [loading, setLoading] = useState(null)
  const [view, setView] = useState('files') // 'files' = import graph, 'tree' = React component tree
  const [roles, setRoles] = useState(null) // { folder: role } from AI
  const [fileRoles, setFileRoles] = useState(null) // { file: role } from AI
  const [bugText, setBugText] = useState('') // pasted error message / stack trace
  const [bug, setBug] = useState(null) // { text, found: [file ids, top frame first] }
  const [summary, setSummary] = useState(null) // one-line change summary from AI
  const [aiBusy, setAiBusy] = useState(null)
  const focus = selected ?? hovered
  const files = project?.files

  const graph = useMemo(() => project && analyze(project.files, project.aliases), [project])
  const baseGraph = useMemo(() => base && analyze(base.files, base.aliases), [base])
  const diff = useMemo(() => graph && baseGraph && compareVersions(base.files, files, baseGraph, graph), [graph, baseGraph, base, files])
  const hasTree = graph && Object.keys(graph.tree.nodes).length > 0
  const g = graph && (view === 'tree' && hasTree ? graph.tree : graph) // what the canvas shows
  const lay = useMemo(() => g && layout(g.nodes, g.edges, grouped), [g, grouped])
  // Clear the loading message only after the new graph has been analysed and drawn.
  useEffect(() => setLoading(null), [lay, diff])
  // AI answers belong to the version they were asked about.
  useEffect(() => { setRoles(null); setFileRoles(null); setBug(null) }, [project])
  useEffect(() => setSummary(null), [diff])
  const isolatedCount = g ? Object.values(g.nodes).filter((n) => n.isolated).length : 0

  function showView(v) { setView(v); setSelected(null); setHovered(null) }
  function pickFile(id) { showView('files'); setSelected(id) }

  async function runAi(kind) {
    setAiBusy({ roles: '폴더 역할을 물어보는 중…', files: '파일 역할을 물어보는 중… (파일이 많으면 조금 걸려요)' }[kind] ?? '변경 내용을 요약하는 중…')
    try {
      const ai = await import('./ai.js')
      if (kind === 'roles') setRoles(await ai.folderRoles(files, graph))
      else if (kind === 'files') setFileRoles(await ai.fileRoles(files, graph))
      else setSummary(await ai.changeSummary(base.files, files, diff))
    } catch (err) {
      alert('AI 요청 실패: ' + err.message)
    } finally {
      setAiBusy(null)
    }
  }

  // Open the repository and list its commits whenever a new folder is picked.
  useEffect(() => {
    setRepo(null); setCommits(null); setFromRef(''); setToRef('work'); setBase(null)
    if (!folder?.git) return
    let cancelled = false
    import('./git.js').then(async ({ openRepo }) => {
      const r = openRepo(folder.git)
      const log = await r.log()
      if (!cancelled) { setRepo(r); setCommits(log) }
    }).catch((err) => !cancelled && alert('git 기록을 읽지 못했습니다: ' + err.message))
    return () => { cancelled = true }
  }, [folder])

  // Load the two picked versions (older commit -> newer commit or the folder now).
  useEffect(() => {
    if (!repo) return
    let cancelled = false
    setLoading('커밋 내용을 읽는 중입니다…')
    Promise.all([fromRef ? repo.filesAt(fromRef) : null, toRef === 'work' ? folder : repo.filesAt(toRef)])
      .then(([older, newer]) => { if (!cancelled) { setBase(older); setProject(newer); setLoading(null) } })
      .catch((err) => { if (!cancelled) { setLoading(null); alert('커밋을 읽지 못했습니다: ' + err.message) } })
    return () => { cancelled = true }
  }, [repo, fromRef, toRef, folder])

  const related = useMemo(() => {
    const n = g && focus && g.nodes[focus]
    if (!n) return null
    return new Set([focus, ...n.importedBy, ...g.edges.filter((e) => e.source === focus).map((e) => e.target)])
  }, [g, focus])

  const nodes = useMemo(() => {
    if (!g) return []
    const tree = g === graph.tree
    const list = Object.values(g.nodes).map((n) => {
      const d = diff?.status[tree ? n.file : n.id]
      // In compare mode, untouched files fade so the changes stand out.
      const dim = related ? !related.has(n.id) : d === 'same'
      // A clicked file and every file it is directly linked to get the same highlight (related is built around the selection).
      const data = { [tree ? 'comp' : 'file']: n, diff: d, selected: !!selected && !!related?.has(n.id), dim, role: fileRoles?.[tree ? n.file : n.id] }
      // Sizes are given up front: these objects are rebuilt on every hover, and React Flow forgets measured sizes
      // of rebuilt nodes, which emptied the minimap and broke off-screen culling.
      return { id: n.id, type: tree ? 'comp' : 'file', position: lay.pos[n.id], initialWidth: NODE_W, initialHeight: NODE_H, data }
    })
    lay.groups.forEach((gr) => list.unshift({
      id: gr.id, type: 'folder', position: { x: gr.x, y: gr.y }, initialWidth: gr.w, initialHeight: gr.h, zIndex: -1, selectable: false, draggable: false,
      data: { name: gr.name, count: gr.count, w: gr.w, h: gr.h, role: roles?.[gr.name] },
    }))
    if (isolatedCount) list.push({
      id: '__isolated', type: 'label', position: { x: 0, y: lay.isolatedTop - 44 }, initialWidth: 600, initialHeight: 30, selectable: false, draggable: false,
      data: { text: tree ? `다른 컴포넌트를 그리지도, 그려지지도 않는 컴포넌트 (${isolatedCount}개)` : `다른 파일과 import 관계가 없는 파일 (${isolatedCount}개)` },
    })
    return list
  }, [g, graph, lay, selected, related, isolatedCount, diff, roles, fileRoles])
  // Panning stops a margin past the graph's edges, so a fast drag can't throw the whole graph off screen.
  const extent = useMemo(() => {
    if (!nodes.length) return undefined
    const xs = nodes.flatMap((n) => [n.position.x, n.position.x + n.initialWidth]), ys = nodes.flatMap((n) => [n.position.y, n.position.y + n.initialHeight])
    const m = 400
    return [[Math.min(...xs) - m, Math.min(...ys) - m], [Math.max(...xs) + m, Math.max(...ys) + m]]
  }, [nodes])

  const edges = useMemo(() => g ? g.edges.map((e) => {
    const cyc = g.nodes[e.source].inCycle && g.nodes[e.target].inCycle
    const hot = focus && (e.source === focus || e.target === focus)
    const fresh = diff?.addedEdges.has(e.id)
    const color = cyc ? 'var(--cycle)' : hot ? 'var(--accent)' : fresh ? 'var(--added)' : 'var(--muted)'
    // Edges stay faint until a file is hovered or selected, so the boxes stay readable.
    const opacity = hot || cyc || (fresh && !focus) ? 1 : focus ? 0.06 : 0.22
    return { ...e, animated: !!hot, zIndex: hot || fresh ? 1 : 0, style: { stroke: color, strokeWidth: hot || fresh ? 2 : 1, opacity }, markerEnd: { type: MarkerType.ArrowClosed, color } }
  }) : [], [g, focus, diff])

  // After the folder dialog closes, the browser lists every file (and asks "upload?") before onChange fires.
  // That can take a while, so show a message as soon as the page gets focus back.
  const picking = useRef(false)
  const moving = useRef(false) // canvas is being dragged or zoomed
  const UPLOADING = '업로드 중입니다… 파일이 많으면 시간이 조금 걸릴 수 있어요.'
  function onOpenPicker() {
    picking.current = true
    window.addEventListener('focus', () => picking.current && setLoading(UPLOADING), { once: true })
  }
  const inputRef = useRef(null)
  useEffect(() => {
    const input = inputRef.current
    const onCancel = () => { picking.current = false; setLoading((l) => (l === UPLOADING ? null : l)) }
    input.addEventListener('cancel', onCancel)
    return () => input.removeEventListener('cancel', onCancel)
  }, [])

  async function onPick(e) {
    picking.current = false
    const picked = [...e.target.files]
    e.target.value = '' // lets the same folder be picked again
    if (!picked.length) { setLoading(null); return }
    setLoading(`프로젝트 폴더를 여는 중입니다… (파일 ${picked.length}개 확인 중)`)
    try {
      const read = await readFolder(picked)
      setLoading(`코드 ${Object.keys(read.files).length}개를 분석하는 중입니다…`)
      await new Promise((r) => setTimeout(r)) // let the message paint before the synchronous analysis
      setSelected(null)
      setFolder(read)
      setProject(read)
    } catch (err) {
      setLoading(null)
      alert('폴더를 읽지 못했습니다: ' + err.message)
    }
  }

  function loadSelf() {
    setSelected(null)
    setFolder(null)
    setProject({ files: demoFiles })
  }

  const sel = selected && view === 'files' && graph.nodes[selected]
  const selComp = selected && g === graph?.tree && g.nodes[selected]
  const all = graph ? Object.values(graph.nodes) : []
  const risky = all.filter((n) => n.risks.length).sort((a, b) => b.risks.length - a.risks.length || b.impact - a.impact)
  const count = (s) => diff ? Object.values(diff.status).filter((x) => x === s).length : 0

  return (
    <>
      <header>
        <h1>Code Map</h1>
        <label className="btn primary">
          프로젝트 폴더 열기
          <input ref={inputRef} type="file" webkitdirectory="" multiple hidden onClick={onOpenPicker} onChange={onPick} />
        </label>
        {commits && (
          <span className="commit-compare">
            <label>커밋 비교 <select value={fromRef} onChange={(e) => setFromRef(e.target.value)} aria-label="이전 커밋">
              <option value="">이전 커밋 선택…</option>
              {commits.map((c) => <option key={c.oid} value={c.oid}>{commitLabel(c)}</option>)}
            </select></label>
            →
            <select value={toRef} onChange={(e) => setToRef(e.target.value)} aria-label="이후 버전">
              <option value="work">지금 폴더 (커밋 안 한 변경 포함)</option>
              {commits.map((c) => <option key={c.oid} value={c.oid}>{commitLabel(c)}</option>)}
            </select>
            {fromRef && <button className="btn" onClick={() => { setFromRef(''); setToRef('work') }}>비교 끄기</button>}
          </span>
        )}
        {folder && !folder.git && <span className="note" title="프로젝트 최상위 폴더(.git 폴더가 있는 곳)를 열면 커밋끼리 비교할 수 있습니다">git 저장소가 아니라서 커밋 비교를 쓸 수 없어요</span>}
        <button className="btn" onClick={loadSelf}>예제: 이 앱 자체 보기</button>
        {hasTree && (
          <span className="tabs" role="tablist">
            <button role="tab" aria-selected={view === 'files'} className={'btn' + (view === 'files' ? ' on' : '')} onClick={() => showView('files')}>파일 의존성</button>
            <button role="tab" aria-selected={view === 'tree'} className={'btn' + (view === 'tree' ? ' on' : '')} onClick={() => showView('tree')}>⚛ 컴포넌트 트리</button>
          </span>
        )}
        <label><input type="checkbox" checked={grouped} onChange={(e) => setGrouped(e.target.checked)} /> 폴더별 묶기</label>
        {graph && <span>파일 {all.length} · ⚠ 위험 파일 {risky.length}</span>}
        <div className="legend">
          <span><i className="dot" style={{ borderColor: 'var(--entry)' }} />진입점</span>
          <span><i className="dot" style={{ borderColor: 'var(--cycle)' }} />순환 의존</span>
          <span><i className="dot" style={{ borderColor: 'var(--unused)', borderStyle: 'dashed' }} />아무도 import 안 함</span>
          {diff && <><span><i className="dot" style={{ borderColor: 'var(--added)', background: 'var(--added-bg)' }} />새 파일</span>
            <span><i className="dot" style={{ borderColor: 'var(--changed)', background: 'var(--changed-bg)' }} />변경됨</span></>}
          <span>⚛ JSX 포함</span>
        </div>
      </header>
      <main>
        {loading && (
          <div className="loading" role="status">
            <div className="spinner" />{loading}
            {/* Fallback: some browsers send no "cancel" event when the upload prompt is declined. */}
            {loading === UPLOADING && <button className="btn" onClick={() => { picking.current = false; setLoading(null) }}>업로드를 취소했다면 닫기</button>}
          </div>
        )}
        {!graph ? (
          <div className="empty">
            <p>JS/TS(React), Python, Java 프로젝트 폴더를 선택하면 파일 간 import 관계를 그래프로 보여줍니다.</p>
            <p>코드는 서버로 전송되지 않고 브라우저 안에서만 분석됩니다. (AI 설명 버튼을 직접 누를 때만 Google Gemini로 보냅니다.)</p>
          </div>
        ) : (
          <>
            <div className="graph">
              {/* While panning/zooming, boxes slide under the cursor; a hover there would redraw the whole graph every frame. */}
              <ReactFlow colorMode="dark" nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView minZoom={0.1} onlyRenderVisibleElements translateExtent={extent}
                onMoveStart={() => { moving.current = true; setHovered(null) }} onMoveEnd={() => { moving.current = false }}
                onNodeClick={(_, n) => g.nodes[n.id] && setSelected(n.id)}
                onNodeMouseEnter={(_, n) => !moving.current && g.nodes[n.id] && setHovered(n.id)} onNodeMouseLeave={() => setHovered(null)} onPaneClick={() => setSelected(null)}
                nodesConnectable={false}>
                <Background />
                <Controls />
                <MiniMap pannable zoomable />
              </ReactFlow>
            </div>
            <aside>
              {selComp ? (
                <>
                  <button className="back" onClick={() => setSelected(null)}>← 목록으로</button>
                  <h2>&lt;{selComp.name} /&gt;</h2>
                  <p>정의된 파일: <button className="link" onClick={() => pickFile(selComp.file)}>{selComp.file}</button></p>
                  <h3>이 컴포넌트를 화면에 그리는 곳 (부모)</h3>
                  <FileList ids={selComp.renderedBy} onPick={setSelected} label={(id) => id.split('#')[1]} />
                  <h3>이 컴포넌트가 그리는 것 (자식)</h3>
                  <FileList ids={selComp.renders} onPick={setSelected} label={(id) => id.split('#')[1]} />
                  <h3>코드</h3>
                  <pre>{files[selComp.file]}</pre>
                </>
              ) : !sel ? (
                <>
                  <section className="bug">
                    <h2>🐞 오류로 파일 찾기</h2>
                    <textarea rows={4} value={bugText} onChange={(e) => setBugText(e.target.value)}
                      placeholder={'오류 메시지나 스택 트레이스를 통째로 붙여 넣으세요.\n예: TypeError: ... at run (http://localhost:5173/src/App.jsx:42:7)'} />
                    <button className="btn primary" disabled={!bugText.trim()} onClick={() => setBug({ text: bugText.trim(), found: findFilesInError(bugText, Object.keys(files)) })}>관련 파일 찾기</button>
                    {bug && (bug.found.length ? (
                      <>
                        <p className="note">오류에 나온 파일 {bug.found.length}개 (위에 있을수록 오류가 난 곳에 가까워요). 누르면 이 오류가 적힌 수정 요청 프롬프트가 열립니다.</p>
                        <ol className="bug-files">{bug.found.map((f, i) => (
                          <li key={f}><button onClick={() => pickFile(f)}>{f}</button>{i === 0 && <span className="tag" style={{ background: 'var(--cycle)' }}>가장 유력</span>}</li>
                        ))}</ol>
                      </>
                    ) : <p className="note">오류 메시지에서 이 프로젝트의 파일 경로를 찾지 못했어요. 파일 이름과 줄 번호가 나오는 스택 트레이스 전체를 붙여 넣어 보세요.</p>)}
                  </section>
                  <section className="ai">
                    <h2>🤖 AI 설명</h2>
                    <p className="note">버튼을 누르면 파일 내용(파일이 많으면 각 파일 앞부분만, 변경 요약은 바뀐 줄)이 Google Gemini로 전송됩니다. 누르기 전에는 아무것도 보내지 않습니다.</p>
                    <p className="note">⚠ 무료 AI라서 보낸 코드가 Google의 서비스 개선에 사용될 수 있습니다. 회사 코드처럼 민감한 코드에는 쓰지 마세요.</p>
                    <button className="btn" disabled={!!aiBusy} onClick={() => runAi('roles')}>폴더 역할 설명받기</button>
                    <button className="btn" disabled={!!aiBusy} onClick={() => runAi('files')}>파일 역할 설명받기</button>
                    {diff && <button className="btn" disabled={!!aiBusy} onClick={() => runAi('summary')}>변경 내용 한 줄 요약</button>}
                    {aiBusy && <p role="status"><span className="spinner small" /> {aiBusy}</p>}
                    {roles && <ul className="roles">{Object.entries(roles).map(([f, r]) => <li key={f}><b>📁 {f}</b> — {r}</li>)}</ul>}
                    {fileRoles && (
                      <>
                        <h3>파일 역할 <small className="note">(그래프 상자에 마우스를 올려도 보여요)</small></h3>
                        <ul className="roles files">{Object.entries(fileRoles).sort().map(([f, r]) => (
                          <li key={f}><button onClick={() => pickFile(f)}>{f}</button> — {r}</li>
                        ))}</ul>
                        {Object.keys(fileRoles).length < Object.keys(files).length &&
                          <p className="note">⚠ AI가 {Object.keys(files).length - Object.keys(fileRoles).length}개 파일의 설명을 빠뜨렸습니다. 다시 눌러 보세요.</p>}
                      </>
                    )}
                  </section>
                  {diff && (
                    <section className="diff-summary">
                      <h2>변경 비교</h2>
                      {summary && <p className="summary">🤖 {summary}</p>}
                      <p>
                        <span className="tag" style={{ background: 'var(--added)' }}>새 파일 {count('added')}</span>
                        <span className="tag" style={{ background: 'var(--changed)' }}>변경 {count('changed')}</span>
                        <span className="tag" style={{ background: 'var(--cycle)' }}>삭제 {diff.removed.length}</span>
                        <span className="tag" style={{ background: 'var(--accent)' }}>새 연결 {diff.addedEdges.size}</span>
                      </p>
                      <h3>바뀐 파일</h3>
                      <FileList ids={all.filter((n) => ['added', 'changed'].includes(diff.status[n.id])).map((n) => n.id)} onPick={pickFile}
                        note={(id) => DIFF_TAG[diff.status[id]]} />
                      {diff.removed.length > 0 && <><h3>삭제된 파일</h3><ul>{diff.removed.map((id) => <li key={id}>{id}</li>)}</ul></>}
                      {diff.removedEdges.length > 0 && <><h3>끊긴 연결</h3><ul>{diff.removedEdges.map((e) => <li key={e.id}>{e.source} → {e.target}</li>)}</ul></>}
                      {diff.newRisks.length > 0 && <><h3>이번 변경으로 새로 생긴 위험</h3>
                        <FileList ids={diff.newRisks.map((n) => n.id)} onPick={pickFile} note={(id) => graph.nodes[id].risks.map((r) => RISK_TAG[r.kind]).join(', ')} /></>}
                    </section>
                  )}
                  <h2>⚠ 유지보수 위험 ({risky.length})</h2>
                  <p>파일을 클릭하면 이유와 코드를 볼 수 있습니다. 화살표는 "import 하는 쪽 → import 되는 쪽" 방향입니다.</p>
                  <FileList ids={risky.map((n) => n.id)} onPick={pickFile} note={(id) => graph.nodes[id].risks.map((r) => RISK_TAG[r.kind]).join(', ')} />
                  {graph.errors.length > 0 && <><h3>파싱 실패</h3><ul>{graph.errors.map((e) => <li key={e}>{e}</li>)}</ul></>}
                </>
              ) : (
                <>
                  <button className="back" onClick={() => setSelected(null)}>← 목록으로</button>
                  <h2>{sel.id}</h2>
                  {sel.entry && <span className="tag" style={{ background: 'var(--entry)' }}>진입점</span>}
                  {DIFF_TAG[diff?.status[sel.id]] && <span className="tag" style={{ background: `var(--${diff.status[sel.id]})` }}>{DIFF_TAG[diff.status[sel.id]]}</span>}
                  <span>{sel.lines}줄 · 의존하는 파일 {sel.impact}개</span>
                  {fileRoles?.[sel.id] && <p className="summary">🤖 {fileRoles[sel.id]}</p>}
                  {sel.risks.length > 0 && <><h3>⚠ 위험</h3><ul className="risks">{sel.risks.map((r) => <li key={r.kind}>{r.text}</li>)}</ul></>}
                  <FixPrompt key={sel.id} files={files} graph={graph} id={sel.id} bug={bug?.found.includes(sel.id) ? bug : null} />
                  <h3>export</h3>
                  <p>{sel.exports.join(', ') || '없음'}</p>
                  <h3>이 파일을 import 하는 곳 (수정하면 영향받음)</h3>
                  <FileList ids={sel.importedBy} onPick={setSelected} />
                  <h3>이 파일이 import 하는 파일</h3>
                  <FileList ids={graph.edges.filter((e) => e.source === sel.id).map((e) => e.target)} onPick={setSelected} />
                  <h3>외부 패키지</h3>
                  <p>{sel.external.join(', ') || '없음'}</p>
                  {diff?.status[sel.id] === 'changed' ? (
                    <><h3>변경 내용 (- 이전 / + 이후)</h3><DiffView a={base.files[sel.id]} b={files[sel.id]} /></>
                  ) : (
                    <><h3>코드</h3><pre>{files[sel.id]}</pre></>
                  )}
                </>
              )}
            </aside>
          </>
        )}
      </main>
    </>
  )
}

function commitLabel(c) {
  const date = new Date(c.commit.author.timestamp * 1000).toLocaleDateString('ko-KR')
  return `${c.oid.slice(0, 7)} · ${c.commit.message.split('\n')[0].slice(0, 40)} (${date})`
}

function DiffView({ a, b }) {
  const lines = useMemo(() => lineDiff(a, b), [a, b])
  return <pre className="diff">{lines.map((l, i) => <div key={i} className={'line ' + { '+': 'add', '-': 'del', ' ': '', '!': '' }[l.type]}>{l.type} {l.text}</div>)}</pre>
}

// "AI에게 수정 요청하기": a prompt with only this file and the files next to it, plus how many tokens that saves.
// bug ({ text, found }): opened from "오류로 파일 찾기", so the error is filled in and the other files it names are ticked.
function FixPrompt({ files, graph, id, bug }) {
  const { uses, usedBy } = useMemo(() => neighbors(graph, id), [graph, id])
  const fromError = (bug?.found ?? []).filter((f) => f !== id && !uses.includes(f) && !usedBy.includes(f))
  const [open, setOpen] = useState(!!bug)
  const [problem, setProblem] = useState(bug?.text ?? '')
  // What this file uses is usually needed to fix it; so are the other files the stack trace passes through.
  const [include, setInclude] = useState(() => new Set([...uses, ...(bug?.found ?? []).filter((f) => f !== id)]))
  const [copied, setCopied] = useState(false)
  const whole = useMemo(() => wholeProjectTokens(files), [files])
  const prompt = useMemo(() => open && buildFixPrompt({ files, graph, id, include: [...include], problem }), [open, files, graph, id, include, problem])
  if (!open) return <button className="btn primary fix-open" onClick={() => setOpen(true)}>🛠 AI 수정 요청 프롬프트 만들기</button>

  const tokens = estimateTokens(prompt)
  const toggle = (f) => setInclude((s) => { const t = new Set(s); t.has(f) ? t.delete(f) : t.add(f); return t })
  const pick = (title, ids) => ids.length > 0 && (
    <fieldset>
      <legend>{title}</legend>
      {ids.map((f) => <label key={f}><input type="checkbox" checked={include.has(f)} onChange={() => toggle(f)} /> {f}</label>)}
    </fieldset>
  )
  async function copy() {
    try { await navigator.clipboard.writeText(prompt); setCopied(true) }
    catch { alert('복사하지 못했습니다. 아래 미리보기에서 직접 선택해 복사하세요.') }
  }
  return (
    <section className="fix">
      <h3>🛠 AI 수정 요청 프롬프트</h3>
      <label>오류 메시지나 이상한 동작
        <textarea rows={3} value={problem} onChange={(e) => { setProblem(e.target.value); setCopied(false) }}
          placeholder="예: 버튼을 누르면 TypeError: Cannot read properties of undefined (reading 'map')" />
      </label>
      <p className="note">함께 보낼 파일을 고르세요. 이 파일({id})은 항상 들어갑니다.</p>
      {pick('이 파일이 import 하는 파일', uses)}
      {pick('이 파일을 import 하는 파일 (수정하면 영향받음)', usedBy)}
      {pick('오류 메시지에 나온 다른 파일', fromError)}
      <p className="tokens">전체 코드를 보내면 약 <b>{whole.toLocaleString()}</b> 토큰 → 이 프롬프트는 약 <b>{tokens.toLocaleString()}</b> 토큰
        {whole > tokens && <> (<b>{Math.round((1 - tokens / whole) * 100)}%</b> 절약)</>}</p>
      <button className="btn primary" onClick={copy}>{copied ? '✅ 복사됨' : '프롬프트 복사'}</button>
      <button className="btn" onClick={() => setOpen(false)}>닫기</button>
      <details><summary>미리보기</summary><pre>{prompt}</pre></details>
    </section>
  )
}

function FileList({ ids, onPick, note, label = (id) => id }) {
  if (!ids.length) return <p>없음</p>
  return <ul>{ids.map((id) => <li key={id}><button onClick={() => onPick(id)}>{label(id)}</button>{note && <small className="note"> {note(id)}</small>}</li>)}</ul>
}
