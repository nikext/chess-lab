import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone'

/**
 * Server-side proxy for the Jev API.
 *
 * The API key lives in .env as JEV_API_KEY (no VITE_ prefix), so Vite never
 * inlines it into client code. The browser posts a bare question payload to
 * /api/jev and this handler attaches the Authorization header.
 */
function jevProxy(env: Record<string, string>): Plugin {
  const handler = async (req: any, res: any, next: any) => {
    if (!req.url?.startsWith('/api/jev')) return next()

    const send = (status: number, body: unknown) => {
      res.statusCode = status
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(body))
    }

    if (req.method !== 'POST') return send(405, { error: 'POST only' })

    const key = env.JEV_API_KEY
    if (!key || key.startsWith('sk-ts-...')) {
      return send(503, {
        error: 'no_key',
        message: 'Set JEV_API_KEY in chess-lab/.env, then restart the dev server.',
      })
    }

    try {
      const chunks: Buffer[] = []
      for await (const c of req) chunks.push(c as Buffer)
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      payload.model ??= env.JEV_MODEL || 'jev-latest'

      const started = Date.now()
      const upstream = await fetch(JEV_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      })

      const text = await upstream.text()
      if (!upstream.ok) {
        return send(upstream.status, {
          error: 'upstream_error',
          status: upstream.status,
          body: text.slice(0, 2000),
        })
      }

      const json = JSON.parse(text)
      json._latencyMs = Date.now() - started
      send(200, json)
    } catch (err: any) {
      send(500, { error: 'proxy_failure', message: String(err?.message ?? err) })
    }
  }

  return {
    name: 'jev-proxy',
    configureServer: (s) => void s.middlewares.use(handler),
    configurePreviewServer: (s) => void s.middlewares.use(handler),
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [react(), jevProxy(env)],
    server: { host: '127.0.0.1', port: 5183, strictPort: true },
  }
})
