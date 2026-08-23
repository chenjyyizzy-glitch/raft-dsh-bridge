// Minimal DSH web mock for exercising raft-dsh-bridge streaming without model cost.
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { WebSocketServer } from 'ws'

const PORT = Number(process.env.MOCK_PORT ?? 3099)
const sockets = new Set()
let turn = 0

function sendFrame(ws, payload) {
  if (ws.readyState !== 1) return
  const frame = { type: 'server-request', rpcId: randomUUID(), method: payload.type, payload }
  ws.send(JSON.stringify(frame))
}

function broadcast(payload) {
  for (const ws of sockets) sendFrame(ws, payload)
}

const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname
  let body = ''
  for await (const chunk of req) body += chunk
  const message = body ? JSON.parse(body) : null

  if (req.method === 'POST' && path === '/api/session.create') {
    const reply = { type: 'server-response', rpcId: message.rpcId, result: { ok: true, value: { sessionId: 'mock-session', agentPreset: message.payload?.agentPreset ?? 'anchored-standard' } } }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(reply))
    return
  }

  if (req.method === 'POST' && path === '/api/session.prompt') {
    const reply = { type: 'server-response', rpcId: message.rpcId, result: { ok: true, value: { accepted: true } } }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(reply))
    const t = ++turn
    setTimeout(() => {
      broadcast({ type: 'session/event', sessionId: 'mock-session', event: { type: 'turn/start', seq: t * 100 + 1, time: Date.now(), data: { turn: t } } })
      broadcast({ type: 'session/event', sessionId: 'mock-session', event: { type: 'assistant/chunk', seq: t * 100 + 2, time: Date.now(), data: { turn: t, step: 1, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } } } })
      const parts = ['We need', ' to check', ' the Raft inbox', ' and act.']
      let seq = t * 100 + 3
      for (const part of parts) {
        setTimeout(() => broadcast({ type: 'session/event', sessionId: 'mock-session', event: { type: 'assistant/chunk', seq: seq++, time: Date.now(), data: { turn: t, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: part } } } }), 120)
      }
      setTimeout(() => {
        broadcast({ type: 'session/event', sessionId: 'mock-session', event: { type: 'assistant/chunk', seq: seq++, time: Date.now(), data: { turn: t, step: 1, chunk: { type: 'text-delta', index: 1, text: 'Mock task done.' } } } })
        broadcast({ type: 'session/event', sessionId: 'mock-session', event: { type: 'assistant/message', seq: seq++, time: Date.now(), data: { turn: t, step: 1, message: { role: 'assistant', content: [{ type: 'reasoning', text: parts.join('') }, { type: 'text', text: 'Mock task done.' }] }, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, reasoningTokens: 4 } } } })
        broadcast({ type: 'session/event', sessionId: 'mock-session', event: { type: 'turn/end', seq: seq++, time: Date.now(), data: { turn: t } } })
      }, 500)
    }, 20)
    return
  }

  if (req.method === 'POST' && path === '/api/session.selectModel') {
    const reply = { type: 'server-response', rpcId: message.rpcId, result: { ok: true, value: { selected: { provider: message.payload?.provider ?? 'deepseek-official', model: message.payload?.model ?? 'deepseek-v4-pro', reasoningEffort: message.payload?.reasoningEffort ?? 'max' } } } }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(reply))
    return
  }

  if (req.method === 'POST' && path === '/api/session.cancel') {
    const reply = { type: 'server-response', rpcId: message.rpcId, result: { ok: true, value: { accepted: true } } }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(reply))
    return
  }

  res.writeHead(404)
  res.end('not found')
})

const wss = new WebSocketServer({ noServer: true })
wss.on('connection', (ws) => {
  sockets.add(ws)
  ws.on('close', () => sockets.delete(ws))
})
server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
})

server.listen(PORT, '127.0.0.1', () => console.error(`mock-dsh listening on ${PORT}`))
