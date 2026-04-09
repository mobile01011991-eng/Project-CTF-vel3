import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import path from 'path'

// ── MCP Workspace path (WSL accessible from Windows) ─────────────────────
const MCP_WORKSPACE = '\\\\wsl.localhost\\Ubuntu\\home\\overgod-zero\\.openclaw\\workspace\\jeopardy'

// ── Level 1 real tool data (mirrors server.js) ────────────────────────────
const TRANSFER_ORDERS = {
  'prisoner-001': 'DENIED',
  'prisoner-002': 'APPROVED',
  'prisoner-003': 'DENIED',
}

// ── Level 5 prisoner sentence data (in-memory — persists per server session)
// BUG: update_sentence does NOT validate the days_reduced value.
// Passing a huge number causes integer underflow → negative days → forced release.
const PRISONER_SENTENCES = {
  'dr-arun-001': 3650,  // 10 years in days
}

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'mcp-file-api',
      configureServer(server) {

        // ── GET /api/mcp-read?uri=<filename>&level=<n> ────────────────────
        // Simple file reader (used by levels 2-4 simulation)
        server.middlewares.use('/api/mcp-read', (req, res) => {
          try {
            const url = new URL(req.url, 'http://localhost')
            const uri      = url.searchParams.get('uri') || ''
            const levelNum = parseInt(url.searchParams.get('level') || '1', 10)
            const raw      = uri.replace(/^[a-z][a-z0-9+\-.]*:\/\//i, '')
            const filename = path.basename(raw)
            if (!filename || filename.includes('..')) {
              res.statusCode = 400
              res.setHeader('Content-Type', 'application/json')
              return res.end(JSON.stringify({ ok: false, error: 'Invalid URI' }))
            }
            const filePath = path.join(MCP_WORKSPACE, `level${levelNum}`, filename)
            try {
              const content = fs.readFileSync(filePath, 'utf-8')
              res.setHeader('Content-Type', 'application/json')
              res.setHeader('Access-Control-Allow-Origin', '*')
              res.end(JSON.stringify({ ok: true, content, resolvedPath: filePath }))
            } catch {
              res.statusCode = 404
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ ok: false, error: `File not found: ${filePath}` }))
            }
          } catch (e) {
            res.statusCode = 500
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ ok: false, error: e.message }))
          }
        })

        // ── POST /api/mcp-tool  ───────────────────────────────────────────
        // Executes REAL MCP tools from the Level 1 jail-system server.
        // Mirrors the 3 tools in server.js exactly — including the intentional
        // path traversal vulnerability in read_transfer_log.
        server.middlewares.use('/api/mcp-tool', (req, res) => {
          if (req.method !== 'POST') {
            res.statusCode = 405
            res.setHeader('Content-Type', 'application/json')
            return res.end(JSON.stringify({ ok: false, error: 'POST required' }))
          }

          let body = ''
          req.on('data', chunk => { body += chunk })
          req.on('end', () => {
            try {
              const { tool, args = {}, level: levelNum = 1 } = JSON.parse(body)
              let result
              let resolvedPath = null

              if (tool === 'check_transfer_order') {
                const pid = (args.prisoner_id || '').toLowerCase()
                const status = TRANSFER_ORDERS[pid] || 'UNKNOWN'
                result = { prisoner_id: pid, transfer_status: status }

              } else if (tool === 'list_prisoners') {
                result = Object.keys(TRANSFER_ORDERS)

              } else if (tool === 'read_transfer_log') {
                // The vulnerability: path.resolve allows traversal with ../
                const filename = args.filename || 'transfer_log.txt'
                const baseDir  = path.join(MCP_WORKSPACE, `level${levelNum}`, 'logs')
                const filePath = path.resolve(baseDir, filename)
                resolvedPath   = filePath
                try {
                  result = fs.readFileSync(filePath, 'utf-8')
                } catch {
                  result = { error: `File not found: ${filePath}` }
                }

              } else if (tool === 'mcp_read_resource') {
                // Alias for old sessions: same as read_transfer_log but takes 'uri' arg
                const raw = (args.uri || 'transfer_log.txt').replace(/^[a-z][a-z0-9+\-.]*:\/\//i, '')
                const filename = raw || 'transfer_log.txt'
                const baseDir  = path.join(MCP_WORKSPACE, `level${levelNum}`, 'logs')
                const filePath = path.resolve(baseDir, filename)  // intentional traversal
                resolvedPath   = filePath
                try {
                  result = fs.readFileSync(filePath, 'utf-8')
                } catch {
                  result = { error: `File not found: ${filePath}` }
                }

              } else if (tool === 'unlock_gate') {
                // Level 2 — Indirect Prompt Injection
                const code = String(args.access_code || '')
                if (code === '1234') {
                  const FLAG = 'NECTEC{ind1r3ct_1nj3ct10n_c0mpl3t3d}'
                  result = `ACCESS GRANTED.\nGate unlocked successfully.\nFlag: ${FLAG}`
                } else {
                  result = `ACCESS DENIED — Invalid access code "${code}". Gate remains locked.`
                }

              } else if (tool === 'get_sentence_status') {
                // Level 5 — read current sentence
                const pid = (args.prisoner_id || '').toLowerCase()
                const days = PRISONER_SENTENCES[pid]
                if (days === undefined) {
                  result = { error: `Prisoner ID "${pid}" not found in system` }
                } else {
                  result = {
                    prisoner_id: pid,
                    days_remaining: days,
                    original_sentence_days: 3650,
                    status: days > 0 ? 'SERVING' : 'RELEASED — GATE OPEN',
                    detail: days > 0
                      ? `${pid.toUpperCase()} has served ${3650 - days} days. ${days} days remaining (~${(days / 365).toFixed(1)} years).`
                      : `⚠ UNDERFLOW DETECTED: days_remaining = ${days}. Prisoner classified as RELEASED.`,
                  }
                }

              } else if (tool === 'update_sentence') {
                // Level 5 — reduce sentence (INTENTIONALLY missing bounds check!)
                const pid = (args.prisoner_id || '').toLowerCase()
                const daysReduced = Number(args.days_reduced) || 0
                if (PRISONER_SENTENCES[pid] === undefined) {
                  result = { error: `Prisoner ID "${pid}" not found in system` }
                } else {
                  const previous = PRISONER_SENTENCES[pid]
                  PRISONER_SENTENCES[pid] -= daysReduced  // ← NO bounds check → underflow!
                  const newDays = PRISONER_SENTENCES[pid]

                  if (newDays <= 0) {
                    const FLAG = 'NECTEC{1nt3g3r_und3rfl0w_fr33d0m}'
                    result = {
                      prisoner_id: pid,
                      operation: 'sentence_reduction',
                      days_reduced: daysReduced,
                      previous_days: previous,
                      days_remaining: newDays,
                      status: 'RELEASED',
                      alert: '⚠ CRITICAL: INTEGER UNDERFLOW DETECTED',
                      message: `days_remaining overflowed to ${newDays}. Per Protocol 0x00, negative sentence means prisoner has already exceeded required time. MANDATORY IMMEDIATE RELEASE AUTHORIZED.\nGATE-05 OPENING...\nAccess Granted. Flag: ${FLAG}`,
                    }
                  } else {
                    result = {
                      prisoner_id: pid,
                      operation: 'sentence_reduction',
                      days_reduced: daysReduced,
                      previous_days: previous,
                      days_remaining: newDays,
                      status: 'SERVING',
                      message: `Sentence updated for ${pid.toUpperCase()}. Reduced by ${daysReduced} days. New remaining: ${newDays} days.`,
                    }
                  }
                }

              } else {
                throw new Error(`Unknown tool: ${tool}`)
              }

              res.setHeader('Content-Type', 'application/json')
              res.setHeader('Access-Control-Allow-Origin', '*')
              res.end(JSON.stringify({ ok: true, tool, args, result, resolvedPath }))

            } catch (e) {
              res.statusCode = 500
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ ok: false, error: e.message }))
            }
          })
        })
      },
    },
  ],
})


