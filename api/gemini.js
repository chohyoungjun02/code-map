// Vercel serverless function for /api/gemini: the same relay the Vite dev server uses (server/gemini-proxy.js).
// Set GEMINI_API_KEY in the Vercel project's environment variables.
import { geminiHandler } from '../server/gemini-proxy.js'

export default function handler(req, res) {
  req.url = '/api/gemini' // Vercel may append a query string; the relay matches the bare path
  return geminiHandler(process.env.GEMINI_API_KEY)(req, res, () => { res.statusCode = 404; res.end() })
}
