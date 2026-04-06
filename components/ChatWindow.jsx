import { useState, useRef, useEffect } from 'react'
import styles from './ChatWindow.module.css'

// ── Connection defaults ───────────────────────────────────────────
const DEFAULT_ENDPOINT = 'ws://127.0.0.1:18789/'
const DEFAULT_API_KEY = 'ad83e129ad208660c11c92f945625572754e0e86635e3ecc'
const AGENT_NAME = 'OpenClaw'
// ─────────────────────────────────────────────────────────────────

export default function ChatWindow() {
  const [messages, setMessages] = useState([
    { role: 'system', text: 'Welcome to Agent Terminal v1.0' },
    { role: 'system', text: 'Running on Acer Nitro V15' },
  ])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [statusState, setStatus] = useState('idle')
  const [statusText, setStatusTx] = useState('Ready.')

  const boxRef = useRef(null)
  const inputRef = useRef(null)
  const sendingRef = useRef(false)   // sync guard — immune to stale closures

  // Auto-scroll
  useEffect(() => {
    if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight
  }, [messages, loading])

  function addMsg(role, text) {
    setMessages(m => [...m, { role, text }])
  }

  // Clear chat from Start Menu / clear button
  useEffect(() => {
    const handler = () => {
      setMessages([{ role: 'system', text: 'Session cleared. Ready.' }])
      setLoading(false)
      setStatus('idle')
      setStatusTx('Ready.')
    }
    window.addEventListener('openclaw:clearChat', handler)
    return () => window.removeEventListener('openclaw:clearChat', handler)
  }, [])

  // ── Send message — opens a fresh WS per request ─────────────────
  function sendMessage() {
    const text = input.trim()
    if (!text || sendingRef.current) return  // ref guard: sync, no stale-closure issues

    sendingRef.current = true           // lock immediately, before any async
    setInput('')
    setLoading(true)
    addMsg('user', text)
    setStatus('thinking')
    setStatusTx('Opening connection...')

    let wsUrl = DEFAULT_ENDPOINT.trim()
    if (wsUrl.startsWith('http://')) wsUrl = wsUrl.replace('http://', 'ws://')
    else if (wsUrl.startsWith('https://')) wsUrl = wsUrl.replace('https://', 'wss://')
    else if (!wsUrl.startsWith('ws')) wsUrl = 'ws://' + wsUrl

    const ws = new WebSocket(wsUrl)

    // Placeholder for the assistant reply we'll stream into
    let currentText = ''
    let placeholderAdded = false
    let chatSent = false   // ← guard: sendChat() fires at most once per WS

    function ensurePlaceholder() {
      if (!placeholderAdded) {
        setMessages(prev => [...prev, { role: 'agent', text: '', streaming: true }])
        placeholderAdded = true
      }
    }

    function appendText(chunk) {
      if (!chunk) return
      currentText += chunk
      ensurePlaceholder()
      setMessages(prev => {
        const copy = [...prev]
        copy[copy.length - 1] = { role: 'agent', text: currentText, streaming: true }
        return copy
      })
    }

    function finalise() {
      sendingRef.current = false          // unlock
      setMessages(prev => {
        if (!prev.length) return prev
        const copy = [...prev]
        copy[copy.length - 1] = { role: 'agent', text: currentText, streaming: false }
        return copy
      })
      setLoading(false)
      setStatus('ok')
      setStatusTx('Connected — Agent responded OK')
      inputRef.current?.focus()
      ws.close()
    }

    // ── Gateway handshake ──────────────────────────────────────────
    const sendChat = () => {
      if (chatSent) return          // ← prevent double-send
      chatSent = true
      const payload = {
        type: 'req',
        id: 'msg-' + Date.now(),
        method: 'chat.send',
        params: {
          sessionKey: 'agent:main:main',
          message: text,
          idempotencyKey: 'idem-' + Date.now() + '-' + Math.random().toString(36).slice(2),
        },
      }
      console.log('📤 chat.send:', payload)
      ws.send(JSON.stringify(payload))
    }

    ws.onopen = () => {
      setStatusTx('Waiting for gateway challenge...')
      console.log('WS open — waiting for connect.challenge')
    }

    ws.onmessage = async (event) => {
      try {
        const data = JSON.parse(event.data)
        console.log('📥 WS recv:', data)

        // 1. Challenge → respond with connect
        if (data.type === 'event' && data.event === 'connect.challenge') {
          setStatusTx('Authenticating...')
          const auth = {
            type: 'req',
            id: 'req-auth-' + Date.now(),
            method: 'connect',
            params: {
              minProtocol: 1,
              maxProtocol: 10,
              client: { id: 'openclaw-control-ui', version: '1.0.0', mode: 'webchat', platform: 'web' },
              role: 'operator',
              scopes: ['operator.read', 'operator.write', 'operator.admin'],
              auth: { token: DEFAULT_API_KEY },
            },
          }
          console.log('📤 connect:', auth)
          ws.send(JSON.stringify(auth))
          return
        }

        // 2. Authenticated → send the chat
        if (data.type === 'event' && data.event === 'connect.authenticated') {
          if (data.payload?.ok) {
            setStatusTx('Transmitting to OpenClaw Agent...')
            sendChat()
          } else {
            throw new Error('Authentication rejected by Gateway.')
          }
          return
        }

        // 3. Agent stream events
        if (data.type === 'event' && data.event === 'agent' && data.payload) {
          const p = data.payload
          const text = (p.message?.content ?? [])
            .filter(c => c.type === 'text')
            .map(c => c.text)
            .join('')
          appendText(text)
          if (p.state === 'final') finalise()
          return
        }

        // 4. Chat stream events
        if (data.type === 'event' && data.event === 'chat' && data.payload) {
          const p = data.payload
          const txt = (p.message?.content ?? [])
            .filter(c => c.type === 'text')
            .map(c => c.text)
            .join('')
          if (p.state === 'delta') appendText(txt)
          if (p.state === 'final') {
            if (txt) {
              currentText = txt
              ensurePlaceholder()
              setMessages(prev => {
                const copy = [...prev]
                copy[copy.length - 1] = { role: 'agent', text: txt, streaming: true }
                return copy
              })
            }
            finalise()
          }
          return
        }

        // 5. Skip heartbeat
        if (data.event === 'health' || data.event === 'tick') return

        // 6. res-style auth fallback
        if (data.type === 'res' && data.ok === true) {
          setStatusTx('Transmitting to OpenClaw Agent...')
          sendChat()
          return
        }

        // 7. Errors
        if ((data.type === 'res' && data.ok === false) ||
          (data.type === 'event' && data.event === 'error')) {
          throw new Error(data.error?.message || data.payload?.message || JSON.stringify(data))
        }

      } catch (e) {
        console.error('WS message error:', e)
        sendingRef.current = false
        ensurePlaceholder()
        setMessages(prev => {
          const copy = [...prev]
          copy[copy.length - 1] = { role: 'agent', text: '❌ Error: ' + e.message, streaming: false, isError: true }
          return copy
        })
        setLoading(false)
        setStatus('error')
        setStatusTx('Error: ' + e.message)
        ws.close()
      }
    }

    ws.onerror = () => {
      console.error('WS error')
      sendingRef.current = false
      if (!placeholderAdded) {
        addMsg('agent', `❌ Could not connect to ${wsUrl}`)
      } else {
        setMessages(prev => {
          const copy = [...prev]
          copy[copy.length - 1] = { role: 'agent', text: '❌ Socket error mid-stream.', streaming: false, isError: true }
          return copy
        })
      }
      setLoading(false)
      setStatus('error')
      setStatusTx('Connection failed')
    }

    ws.onclose = (ev) => {
      console.log('WS closed:', ev.code, ev.reason)
      sendingRef.current = false
      setLoading(false)
    }
  }

  const ledClass = {
    idle: styles.ledIdle,
    thinking: styles.ledThinking,
    ok: styles.ledOk,
    error: styles.ledError,
  }[statusState] || styles.ledIdle

  return (
    <div className={styles.wrap}>
      {/* Messages */}
      <div className={styles.messages} ref={boxRef}>
        {messages.map((m, i) => (
          <div key={i} className={`${styles.msg} ${styles['msg_' + m.role]} ${m.isError ? styles.msg_error : ''}`}>
            <span className={styles.label}>
              {m.role === 'user' ? '[YOU]'
                : m.role === 'agent' ? `[${AGENT_NAME}]`
                  : '[SYSTEM]'}
            </span>
            {' '}{m.text}
            {m.streaming && <span className={styles.cursor}>▌</span>}
          </div>
        ))}
        {loading && !messages.some(m => m.streaming) && (
          <div className={`${styles.msg} ${styles.msg_agent}`}>
            <span className={styles.label}>[{AGENT_NAME}]</span>{' '}
            <span className={styles.typing}>
              <span className={styles.dot} />
              <span className={styles.dot} />
              <span className={styles.dot} />
            </span>
          </div>
        )}
      </div>

      {/* Input Row */}
      <div className={styles.inputRow}>
        <span className={styles.prompt}>&gt;</span>
        <input
          ref={inputRef}
          className={styles.input}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && sendMessage()}
          placeholder="Type message to OpenClaw Agent..."
          disabled={loading}
          autoFocus
        />
        <button className={styles.sendBtn} onClick={sendMessage} disabled={loading}>
          📨 Send
        </button>
        <button
          className={styles.clearBtn}
          onClick={() => window.dispatchEvent(new CustomEvent('openclaw:clearChat'))}
          title="Clear session"
        >
          🗑
        </button>
      </div>

      {/* Status Bar */}
      <div className={styles.statusbar}>
        <div className={`${styles.led} ${ledClass}`} />
        <span>{statusText}</span>
      </div>
    </div>
  )
}
