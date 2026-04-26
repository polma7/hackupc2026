const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')
const QRCode = require('qrcode')

const RENDERER_DIR = path.join(__dirname, '..', 'renderer')
const JSQR_PATH = path.join(__dirname, '..', 'node_modules', 'jsqr', 'dist', 'jsQR.js')
const COOKIE_NAME = 'mvid'

function parseCookies(header) {
  const out = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const k = part.slice(0, eq).trim()
    const v = part.slice(eq + 1).trim()
    if (k) out[k] = decodeURIComponent(v)
  }
  return out
}

function setCookieHeader(name, value) {
  // Lax + Path=/ so the cookie travels on top-level navigations and AJAX.
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=86400; SameSite=Lax`
}

function getLanIPs() {
  const ips = []
  const ifaces = os.networkInterfaces()
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] || []) {
      if (info.family === 'IPv4' && !info.internal) ips.push(info.address)
    }
  }
  return ips
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers })
  res.end(body)
}

function sendJSON(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' })
}

async function readBody(req, max = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let total = 0
    const chunks = []
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > max) {
        reject(new Error('payload too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function serveStatic(res, filePath, contentType) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      send(res, 404, 'Not found')
      return
    }
    send(res, 200, data, { 'Content-Type': contentType })
  })
}

/**
 * Create the LAN HTTP bridge.
 *
 * Each browser session is identified by a cookie and gets its own voter
 * worker (managed by `sessions`). This means every phone that loads the
 * page becomes an independent peer with its own peerId, and the host PC's
 * own role (creator or voter) is irrelevant to the mobile flow.
 *
 * @param {object} opts
 * @param {{ newSid: () => string, hasSession: (sid: string) => boolean,
 *           getOrCreate: (sid: string) => any, getSnapshot: (sid: string) => object,
 *           join: (sid: string, topic: string) => Promise<void>,
 *           vote: (sid: string, optionIndex: number) => Promise<void>,
 *           ping: (sid: string) => Promise<void> }} opts.sessions
 * @param {number} [opts.port]
 */
function startHttpServer({ sessions, port = 8787 }) {
  function ensureSidCookie(req, res) {
    const cookies = parseCookies(req.headers.cookie)
    let sid = cookies[COOKIE_NAME]
    if (!sid || !/^[0-9a-f]{32}$/.test(sid)) {
      sid = sessions.newSid()
      res.setHeader('Set-Cookie', setCookieHeader(COOKIE_NAME, sid))
    }
    return sid
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)

      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        ensureSidCookie(req, res)
        return serveStatic(res, path.join(RENDERER_DIR, 'mobile.html'), 'text/html; charset=utf-8')
      }

      if (req.method === 'GET' && url.pathname === '/mobile.js') {
        return serveStatic(res, path.join(RENDERER_DIR, 'mobile.js'), 'application/javascript; charset=utf-8')
      }

      if (req.method === 'GET' && url.pathname === '/jsqr.js') {
        return serveStatic(res, JSQR_PATH, 'application/javascript; charset=utf-8')
      }

      if (req.method === 'GET' && url.pathname === '/qr') {
        const data = url.searchParams.get('data') || ''
        if (!data) return send(res, 400, 'data required')
        const svg = await QRCode.toString(data, {
          type: 'svg',
          errorCorrectionLevel: 'M',
          margin: 1,
          color: { dark: '#0a0a0a', light: '#ffffff' }
        })
        return send(res, 200, svg, { 'Content-Type': 'image/svg+xml; charset=utf-8' })
      }

      if (req.method === 'GET' && url.pathname === '/api/state') {
        const sid = ensureSidCookie(req, res)
        // Don't auto-spawn a worker just for polling state. If the session
        // hasn't joined yet, return a default snapshot.
        if (!sessions.hasSession(sid)) {
          return sendJSON(res, 200, { role: 'voter', topic: '', poll: null, peers: 0, ready: false })
        }
        // Trigger a PING so peer count refreshes between polls.
        sessions.ping(sid).catch(() => {})
        return sendJSON(res, 200, sessions.getSnapshot(sid))
      }

      if (req.method === 'POST' && url.pathname === '/api/join') {
        const sid = ensureSidCookie(req, res)
        const raw = await readBody(req)
        const body = raw ? JSON.parse(raw) : {}
        const match = String(body.key || '').match(/[0-9a-fA-F]{64}/)
        if (!match) return sendJSON(res, 400, { ok: false, error: 'topic must be 64 hex characters' })
        sessions.getOrCreate(sid)
        await sessions.join(sid, match[0].toLowerCase())
        return sendJSON(res, 200, { ok: true })
      }

      if (req.method === 'POST' && url.pathname === '/api/vote') {
        const sid = ensureSidCookie(req, res)
        const raw = await readBody(req)
        const body = raw ? JSON.parse(raw) : {}
        const optionIndex = Number(body.optionIndex)
        if (!Number.isInteger(optionIndex) || optionIndex < 0) {
          return sendJSON(res, 400, { ok: false, error: 'invalid optionIndex' })
        }
        if (!sessions.hasSession(sid)) {
          return sendJSON(res, 400, { ok: false, error: 'join a topic first' })
        }
        try {
          await sessions.vote(sid, optionIndex)
          return sendJSON(res, 200, { ok: true })
        } catch (e) {
          return sendJSON(res, 400, { ok: false, error: e.message })
        }
      }

      send(res, 404, 'Not found')
    } catch (error) {
      sendJSON(res, 500, { ok: false, error: error.message })
    }
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '0.0.0.0', () => {
      const ips = getLanIPs()
      const urls = ips.map((ip) => `http://${ip}:${port}`)
      console.log('[http] mobile bridge listening on:', urls.join(', ') || `0.0.0.0:${port}`)
      resolve({ server, port, urls, ips })
    })
  })
}

module.exports = { startHttpServer, getLanIPs }
