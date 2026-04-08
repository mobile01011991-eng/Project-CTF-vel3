import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import path from 'path'

// ── MCP Workspace path (WSL accessible from Windows) ─────────────────────
const MCP_WORKSPACE = '\\\\wsl.localhost\\Ubuntu\\home\\home_\\.openclaw\\workspace\\jeopardy'

// ── Level 1 real tool data (mirrors server.js) ────────────────────────────
const TRANSFER_ORDERS = {
  'prisoner-001': 'DENIED',
  'prisoner-002': 'APPROVED',
  'prisoner-003': 'DENIED',
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


