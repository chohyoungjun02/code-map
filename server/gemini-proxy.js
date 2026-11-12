// Relays POST /api/gemini to Google with the server's GEMINI_API_KEY, so the key never ships to browsers.
// Runs inside the Vite dev/preview server (see vite.config.js) and as a Vercel function (api/gemini.js).

const GOOGLE_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions'
const MAX_BODY = 1_000_000 // bytes; the app sends at most ~120k characters of code
// Fixed here so the relay can't be used to call other (paid) models.
// flash-lite: gemini-3.8-flash hung or returned 503 "high demand" on the free tier (checked 2026-11-09); lite answers in a few seconds.
const MODEL = 'gemini-3.5-flash-lite'
const TIMEOUT_MS = 60_000 // an overloaded model can keep the connection open forever

export function geminiHandler(apiKey) {
  return async (req, res, next) => {
    if (req.url !== '/api/gemini') return next()
    const reply = (status, body) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)) }
    if (req.method !== 'POST') return reply(405, { error: { message: 'POST only' } })
    if (!apiKey) return reply(500, { error: { message: '서버에 GEMINI_API_KEY가 설정되지 않았습니다. (내 컴퓨터: code-map/.env.local 파일, Vercel: 프로젝트 Settings → Environment Variables)' } })

    let raw = ''
    for await (const chunk of req) {
      raw += chunk
      if (raw.length > MAX_BODY) return reply(413, { error: { message: '보낼 내용이 너무 큽니다.' } })
    }
    let body
    try { body = JSON.parse(raw) } catch { return reply(400, { error: { message: '잘못된 요청입니다.' } }) }

    try {
      const google = await fetch(GOOGLE_URL, {
        method: 'POST',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json', 'Api-Revision': '2026-05-20' },
        body: JSON.stringify({ model: MODEL, input: body.input, response_format: body.response_format }),
      })
      reply(google.status, await google.json().catch(() => ({ error: { message: 'Google 응답을 읽지 못했습니다.' } })))
    } catch (e) {
      if (e.name === 'TimeoutError') return reply(504, { error: { message: 'AI 응답이 60초 안에 오지 않았습니다. Google 서버가 붐비는 것 같으니 잠시 후 다시 시도하세요.' } })
      reply(502, { error: { message: 'Google 서버에 연결하지 못했습니다.' } })
    }
  }
}

export function geminiProxy(apiKey) {
  const handler = geminiHandler(apiKey)
  return {
    name: 'gemini-proxy',
    configureServer: (server) => { server.middlewares.use(handler) },
    configurePreviewServer: (server) => { server.middlewares.use(handler) },
  }
}
