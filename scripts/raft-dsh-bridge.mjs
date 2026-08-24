#!/usr/bin/env node
/**
 * raft-dsh-bridge.mjs — let a Raft (Slock) builtin agent talk to a DeepSeek
 * Harness (DSH) session instead of calling api.deepseek.com directly.
 *
 * Raft side  : an OpenAI-compatible `/chat/completions` endpoint (SSE).
 * DSH side   : DSH web API (session.create / session.prompt) + the mux
 *              WebSocket stream. The DSH session runs the installed
 *              `anchored-standard` (or `zero-anchored-standard`) preset, so the
 *              first real model request is assembled under DSH's minimal
 *              bootstrap conditions instead of Raft's fixed 4-tool surface.
 *
 * Architecture (v1, "DSH is the brain, DSH keeps the hands"):
 *
 *   raft-computer --/chat/completions--> this bridge
 *   this bridge  --session.prompt------> DSH web (127.0.0.1:3080)
 *   this bridge  <--events.mux WS------- DSH assistant/reasoning chunks
 *   this bridge  --SSE reasoning/content--> raft-computer
 *
 * Raft therefore sees the DSH-produced reasoning (reasoning_content) and the
 * final DSH text, while DSH executes its own tools. Raft platform operations
 * (inbox/messages/tasks) are reachable from DSH through the generated
 * `raft.ps1` wrapper whose path is injected into every bridged prompt.
 *
 * No npm dependencies. Node >= 22 (global fetch + WebSocket).
 */

import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, copyFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

// ---------------------------------------------------------------- config ---

// All defaults are intentionally host-agnostic. Point the environment at
// YOUR DSH web endpoint and YOUR Raft agent workspace before starting.
const PORT = Number(process.env.BRIDGE_PORT ?? 8899)
const DSH_BASE = (process.env.DSH_BASE ?? 'http://127.0.0.1:3080').replace(/\/+$/, '')
const DSH_PRESET = process.env.DSH_PRESET ?? 'anchored-standard'
const DSH_CWD = process.env.DSH_CWD ?? ''
const DSH_PROVIDER = process.env.DSH_PROVIDER ?? 'deepseek-official'
const DSH_MODEL = process.env.DSH_MODEL ?? 'deepseek-v4-pro'
const DSH_REASONING_EFFORT = process.env.DSH_REASONING_EFFORT ?? 'follow'
const RAFT_AGENT_ID = process.env.RAFT_AGENT_ID ?? ''
const SLOCK_ROOT = process.env.SLOCK_ROOT ?? join(homedir(), '.slock')
const RAFT_CLI_PATTERN = process.env.RAFT_CLI_PATTERN
  ?? (RAFT_AGENT_ID ? join(SLOCK_ROOT, 'cli-transport', RAFT_AGENT_ID) : '')
const BRIDGE_DATA_DIR = process.env.BRIDGE_DATA_DIR ?? join(homedir(), '.raft-dsh-bridge')
const RAFT_WRAPPER_DIR = process.env.RAFT_WRAPPER_DIR ?? join(BRIDGE_DATA_DIR, 'cli')
const RAFT_WRAPPER = join(RAFT_WRAPPER_DIR, 'raft.ps1')
const TURN_TIMEOUT_MS = Number(process.env.TURN_TIMEOUT_MS ?? 120 * 60 * 1000)
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS ?? 10_000)
const DRY_RUN = process.env.DRY_RUN === '1'
const LOG_FILE = process.env.LOG_FILE ?? join(BRIDGE_DATA_DIR, 'raft-dsh-bridge.log')
const STATE_FILE = process.env.STATE_FILE ?? join(BRIDGE_DATA_DIR, 'dsh-session.json')
const DEBUG = process.env.DEBUG === '1'

const DEFAULT_MODEL = 'deepseek-v4-pro'
const CLIENT_TZ = process.env.CLIENT_TZ ?? 'Asia/Shanghai'
const DEDUP_NOTICES = process.env.DEDUP_NOTICES !== '0'
const MEMORY_POLICY = process.env.MEMORY_POLICY ?? 'raft'
const AUTO_APPROVE = process.env.AUTO_APPROVE !== '0'
const AUTO_ANSWER_QUESTIONS = process.env.AUTO_ANSWER_QUESTIONS !== '0'
const answeredRpcIds = new Set()
let currentReasoningEffort = DSH_REASONING_EFFORT === 'follow' ? null : DSH_REASONING_EFFORT

// ------------------------------------------------------------------ log ---

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}`
  try {
    appendFileSync(LOG_FILE, line + '\n')
  } catch {}
  if (DEBUG) console.error(line)
}

function jsonBlock(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`
}

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const out = []
  const walk = (parts) => {
    for (const part of parts ?? []) {
      if (typeof part === 'string') { out.push(part); continue }
      if (!part || typeof part !== 'object') continue
      if (typeof part.text === 'string') out.push(part.text)
      else if (Array.isArray(part.content)) walk(part.content)
      else if (part.content && typeof part.content === 'string') out.push(part.content)
    }
  }
  walk(content)
  return out.join(String.fromCharCode(10))
}

function lastMessageOf(bodyObj) {
  const messages = bodyObj?.messages
  if (!Array.isArray(messages) || messages.length === 0) return null
  return messages[messages.length - 1]
}

function isBareStartTurn(bodyObj) {
  const last = lastMessageOf(bodyObj)
  if (!last || last.role !== 'user') return false
  const text = textOf(last.content).trim()
  return text === 'Start.' || text === 'Start' || text.startsWith('Start.')
}

function isFreshStartTurn(bodyObj) {
  return isBareStartTurn(bodyObj)
    && Array.isArray(bodyObj?.messages)
    && bodyObj.messages.length <= 3
}

function memoryPolicyBlock() {
  if (MEMORY_POLICY === 'off') return ''
  return [
    '[Memory policy - aligned with Raft builtin]',
    '- MEMORY.md is the index and recovery point; keep it scan-friendly.',
    '- notes/channels.md: one section per channel (name, purpose, members, ongoing tasks, latest decision).',
    '- notes/work-log.md: important decisions and completed work; notes/user-preferences.md and notes/<domain>.md as needed.',
    '- Before a long task, write a brief Active Context into MEMORY.md; after completing work, update the relevant note and MEMORY.md index.',
    '- If context was compacted or you resume mid-task, re-read MEMORY.md and the relevant notes before acting.',
    '',
  ].join('\n')
}

// ------------------------------------------------------------ raft CLI ---

/** Copy the newest generated raft.ps1 for this agent into a stable path. */
function refreshRaftWrapper() {
  try {
    if (!existsSync(RAFT_CLI_PATTERN)) return false
    const entries = readdirSync(RAFT_CLI_PATTERN, { withFileTypes: true })
    let best = null
    let bestTime = -1
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const candidate = join(RAFT_CLI_PATTERN, entry.name, 'raft.ps1')
      if (!existsSync(candidate)) continue
      const time = statSync(candidate).mtimeMs
      if (time > bestTime) {
        bestTime = time
        best = candidate
      }
    }
    if (!best) return false
    mkdirSync(RAFT_WRAPPER_DIR, { recursive: true })
    // Harden the copied wrapper: without this line PowerShell 5.1 decodes
    // UTF-8 piped stdin (raft message send <<'RAFTMSG') using the system ANSI
    // code page on Chinese Windows, which mojibakes the message in Raft.
    let wrapper = readFileSync(best, 'utf8')
    if (!wrapper.includes('[Console]::InputEncoding')) {
      const marker = '[Console]::OutputEncoding = $utf8NoBom'
      wrapper = wrapper.replace(marker, marker + String.fromCharCode(10) + '[Console]::InputEncoding = $utf8NoBom')
    }
    if (!existsSync(RAFT_WRAPPER) || readFileSync(RAFT_WRAPPER, 'utf8') !== wrapper) {
      log(`raft wrapper refreshed from ${best}`)
    }
    return true
  } catch (error) {
    log(`raft wrapper refresh failed: ${error.message}`)
    return existsSync(RAFT_WRAPPER)
  }
}

function raftContextBlock() {
  const hasWrapper = refreshRaftWrapper()
  const cli = hasWrapper
    ? `& '${RAFT_WRAPPER}' <subcommand>`
    : '(no raft.ps1 wrapper found; set RAFT_CLI_PATTERN and restart the bridge)'
  return [
    '[Raft bridge context]',
    `You are the reasoning brain of Raft agent ${RAFT_AGENT_ID}.`,
    `Raft workspace: ${DSH_CWD}`,
    `Raft CLI wrapper (PowerShell): ${cli}`,
    'Examples:',
    `  & '${RAFT_WRAPPER}' inbox check`,
    `  & '${RAFT_WRAPPER}' message check`,
    `  & '${RAFT_WRAPPER}' message read <target>`,
    `  & '${RAFT_WRAPPER}' message send --target "<target>" "<text>"`,
    'MEMORY.md is in the Raft workspace root; read and maintain it as the recovery point.',
    '',
  ].join('\n')
}

// ------------------------------------------------------------ DSH client ---

let dshSessionId = null
let lastInboxNotice = null

function loadSessionState() {
  try {
    if (!existsSync(STATE_FILE)) return null
    const state = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    if (state && typeof state.sessionId === 'string' && state.preset === DSH_PRESET && state.cwd === DSH_CWD) {
      dshSessionId = state.sessionId
      log(`DSH session restored from state: ${dshSessionId}`)
      return state
    }
  } catch (error) {
    log(`session state load failed: ${error.message}`)
  }
  return null
}

function saveSessionState() {
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true })
    writeFileSync(STATE_FILE, JSON.stringify({ sessionId: dshSessionId, preset: DSH_PRESET, cwd: DSH_CWD }, null, 2))
  } catch (error) {
    log(`session state save failed: ${error.message}`)
  }
}

function clearSessionState() {
  try {
    if (existsSync(STATE_FILE)) writeFileSync(STATE_FILE, JSON.stringify({ sessionId: null, preset: DSH_PRESET, cwd: DSH_CWD }, null, 2))
  } catch {}
}

async function dshRpc(method, payload) {
  const url = `${DSH_BASE}/api/${method}`
  const body = JSON.stringify({
    type: 'client-request',
    rpcId: randomUUID(),
    method,
    payload,
  })
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body,
  })
  const envelope = await response.json().catch(() => null)
  if (!response.ok || !envelope || envelope.type !== 'server-response') {
    throw new Error(`DSH ${method} carrier failed: HTTP ${response.status} ${String(envelope).slice(0, 200)}`)
  }
  if (!envelope.result?.ok) {
    throw new Error(`DSH ${method} error: ${JSON.stringify(envelope.result?.error ?? envelope.result)}`)
  }
  return envelope.result.value
}

async function respondDsh(rpcId, value) {
  if (answeredRpcIds.has(rpcId)) return true
  answeredRpcIds.add(rpcId)
  try {
    const response = await fetch(`${DSH_BASE}/api/respond`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ type: 'client-response', rpcId, result: { ok: true, value } }),
    })
    const receipt = await response.json().catch(() => null)
    if (receipt?.accepted !== true) {
      log(`respond not accepted for ${rpcId}: ${JSON.stringify(receipt)}`)
      answeredRpcIds.delete(rpcId)
      return false
    }
    return true
  } catch (error) {
    log(`respond failed for ${rpcId}: ${error.message}`)
    answeredRpcIds.delete(rpcId)
    return false
  }
}

async function createDshSession() {
  const value = await dshRpc('session.create', {
    cwd: DSH_CWD,
    agentPreset: DSH_PRESET,
  })
  dshSessionId = value.sessionId
  saveSessionState()
  log(`DSH session created: ${dshSessionId} (preset=${value.agentPreset ?? DSH_PRESET})`)
  if (DSH_PROVIDER && DSH_MODEL && DSH_REASONING_EFFORT !== 'follow') {
    const selected = await dshRpc('session.selectModel', {
      sessionId: dshSessionId,
      provider: DSH_PROVIDER,
      model: DSH_MODEL,
      ...DSH_REASONING_EFFORT ? { reasoningEffort: DSH_REASONING_EFFORT } : {},
    })
    currentReasoningEffort = selected.selected.reasoningEffort ?? DSH_REASONING_EFFORT
    log(`DSH model selected: ${selected.selected.provider}/${selected.selected.model} effort=${currentReasoningEffort ?? '-'}`)
  }
  return dshSessionId
}

async function promptDsh(text) {
  const sessionId = await ensureDshSession()
  const value = await dshRpc('session.prompt', {
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text }],
    clientTimeZone: CLIENT_TZ,
  })
  log(`DSH prompt accepted: session=${sessionId} turnPending`)
  return sessionId
}

async function ensureModelSelection(sessionId, bodyObj) {
  if (DSH_REASONING_EFFORT !== 'follow') return
  const requested = bodyObj?.reasoning_effort ?? bodyObj?.reasoningEffort ?? bodyObj?.thinking_level
  if (!requested || requested === currentReasoningEffort) return
  const selected = await dshRpc('session.selectModel', {
    sessionId,
    provider: DSH_PROVIDER,
    model: DSH_MODEL,
    reasoningEffort: requested,
  })
  currentReasoningEffort = requested
  log(`DSH reasoning effort changed: ${currentReasoningEffort}`)
}

async function ensureDshSession() {
  if (!dshSessionId) await createDshSession()
  return dshSessionId
}

// ----------------------------------------------------- DSH mux WebSocket ---

/** Active waiter for the one serialized bridge turn. */
let activeTurn = null
let muxOpen = false
const STALL_MS = Number(process.env.STALL_MS ?? 120_000)
let turnState = emptyTurnState()

function emptyTurnState() {
  return {
    phase: 'idle',
    turn: null,
    step: null,
    startedAt: null,
    endedAt: null,
    lastEventAt: 0,
    reasoningChars: 0,
    textChars: 0,
    firstReasoningAt: null,
    lastReasoningTail: '',
    toolCalls: 0,
    lastTool: null,
    lastToolStartedAt: null,
    error: null,
  }
}

function touchTurnState(event) {
  const type = event?.type
  const data = event?.data ?? {}
  turnState.lastEventAt = Date.now()
  if (type === 'turn/start') {
    turnState = emptyTurnState()
    turnState.phase = 'starting'
    turnState.turn = data.turn
    turnState.startedAt = Date.now()
    turnState.lastEventAt = Date.now()
  } else if (type === 'assistant/chunk') {
    turnState.step = data.step ?? turnState.step
    const chunk = data.chunk
    if (chunk?.type === 'reasoning-delta') {
      turnState.phase = 'thinking'
      if (turnState.firstReasoningAt === null) turnState.firstReasoningAt = Date.now()
      turnState.reasoningChars += chunk.text?.length ?? 0
      if (typeof chunk.text === 'string' && chunk.text) {
        turnState.lastReasoningTail = (turnState.lastReasoningTail + chunk.text).slice(-240)
      }
    } else if (chunk?.type === 'text-delta') {
      turnState.phase = 'text'
      turnState.textChars += chunk.text?.length ?? 0
    }
  } else if (type === 'assistant/message') {
    turnState.step = data.step ?? turnState.step
    turnState.phase = 'text'
  } else if (type === 'tool/call') {
    turnState.phase = 'tool'
    turnState.toolCalls += 1
    turnState.lastTool = data.name ?? null
    turnState.lastToolStartedAt = Date.now()
  } else if (type === 'tool/result') {
    turnState.phase = 'continuing'
  } else if (type === 'turn/end') {
    turnState.phase = data.reason?.kind === 'completed' ? 'idle' : 'idle'
    turnState.endedAt = Date.now()
  } else if (type === 'turn/error' || type === 'stream/error') {
    turnState.phase = 'error'
    turnState.error = data?.message ?? data?.reason ?? 'error'
  }
}

function connectMux() {
  if (DRY_RUN) return
  const host = new URL(DSH_BASE).host
  const protocol = new URL(DSH_BASE).protocol === 'https:' ? 'wss:' : 'ws:'
  const ws = new WebSocket(`${protocol}//${host}/api/events.mux`)
  ws.onopen = () => { muxOpen = true; log(`mux connected: ${host}/api/events.mux`) }
  ws.onmessage = (event) => {
    try {
      let frame
      try {
        frame = JSON.parse(event.data.toString())
      } catch {
        return
      }
      if (frame.type !== 'server-request') return
      const payload = frame.payload
      if (payload?.type === 'approval/requested' && payload.sessionId === dshSessionId) {
        log(`approval requested: tool=${payload.toolName} reason=${payload.reason ?? ''}`)
        if (AUTO_APPROVE) {
          void respondDsh(frame.rpcId, { sessionId: payload.sessionId, approvalId: payload.approvalId, outcome: 'allowed-once' })
        } else if (activeTurn) {
          activeTurn.fail(new Error(`DSH approval required for ${payload.toolName}; set AUTO_APPROVE=1 to auto-allow`))
        }
        return
      }
      if (payload?.type === 'question/requested' && payload.sessionId === dshSessionId) {
        log(`question requested: ${String(JSON.stringify(payload.questions)).slice(0, 500)}`)
        if (AUTO_ANSWER_QUESTIONS) {
          const answers = (payload.questions ?? []).map((question) => ({
            id: question.id,
            selected: question.options?.length ? [question.options[0].label] : [],
          }))
          void respondDsh(frame.rpcId, { sessionId: payload.sessionId, answer: { answers } })
        } else if (activeTurn) {
          activeTurn.fail(new Error('DSH ask_user_question requires an answer; set AUTO_ANSWER_QUESTIONS=1'))
        }
        return
      }
      if (payload?.type !== 'session/event') return
      if (payload.sessionId !== dshSessionId) return
      const sessionEvent = payload.event
      touchTurnState(sessionEvent)
      if (DEBUG) log(`mux event: ${sessionEvent?.type} turn=${sessionEvent?.data?.turn} active=${activeTurn !== null}`)
      if (activeTurn) activeTurn.onEvent(sessionEvent)
    } catch (error) {
      log('mux handler error: ' + (error && error.stack ? error.stack : String(error)))
    }
  }
  ws.onclose = (event) => {
    muxOpen = false
    log(`mux closed code=${event.code}; reconnecting in 2s`)
    if (activeTurn && !activeTurn.settled) {
      activeTurn.fail(new Error(`DSH event stream closed (${event.code})`))
    }
    setTimeout(connectMux, 2000)
  }
  ws.onerror = () => {
    log('mux socket error')
  }
}

// ------------------------------------------------------------ SSE writer ---

function makeChunk(model, delta, finishReason = null) {
  return {
    id: randomUUID(),
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  }
}

function writeSse(res, text) {
  if (!res.destroyed && !res.writableEnded) res.write(text)
  return !res.destroyed && !res.writableEnded
}

function scriptedResponse(res, bodyObj, reasoning, content) {
  const model = bodyObj?.model ?? DEFAULT_MODEL
  if (bodyObj?.stream !== true) {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({
      id: randomUUID(),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        message: { role: 'assistant', content, reasoning_content: reasoning },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    }))
    return
  }
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  if (reasoning) writeSse(res, jsonBlock(makeChunk(model, { role: 'assistant', reasoning_content: reasoning })))
  writeSse(res, jsonBlock(makeChunk(model, { content })))
  writeSse(res, jsonBlock(makeChunk(model, {}, 'stop')))
  writeSse(res, 'data: [DONE]\n\n')
  res.end()
}

function streamedResponse(res, bodyObj, waiter) {
  const model = bodyObj?.model ?? DEFAULT_MODEL
  const includeUsage = bodyObj?.stream_options?.include_usage === true
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })

  let streamedText = ''
  let streamedReasoning = ''
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 }
  let sawReasoning = false
  let sawContent = false
  let finished = false
  let sentRole = false

  const heartbeat = setInterval(() => {
    if (!res.destroyed && !res.writableEnded) res.write(': keep-alive' + '\n' + '\n')
  }, HEARTBEAT_MS)

  const finish = (finalText) => {
    if (finished) return
    finished = true
    clearInterval(heartbeat)
    if (!sentRole) {
      writeSse(res, jsonBlock(makeChunk(model, { role: 'assistant', content: '' })))
      sentRole = true
    }
    if (!sawContent && finalText) {
      writeSse(res, jsonBlock(makeChunk(model, { content: finalText })))
      streamedText = finalText
    }
    if (!sawReasoning) {
      writeSse(res, jsonBlock(makeChunk(model, { reasoning_content: '' })))
    }
    writeSse(res, jsonBlock(makeChunk(model, {}, 'stop')))
    if (includeUsage) {
      const promptTokens = (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0)
      writeSse(res, jsonBlock({
        id: randomUUID(),
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: usage.outputTokens ?? 0,
          total_tokens: promptTokens + (usage.outputTokens ?? 0),
          prompt_tokens_details: { cached_tokens: usage.cacheReadTokens ?? 0 },
          completion_tokens_details: { reasoning_tokens: usage.reasoningTokens ?? 0 },
        },
      }))
    }
    writeSse(res, 'data: [DONE]\n\n')
    res.end()
    log(`turn streamed: reasoning=${streamedReasoning.length} chars, text=${streamedText.length} chars, usage=${JSON.stringify(usage)}`)
  }

  waiter.onEvent = (event) => {
    waiter.touch()
    if (event.type === 'turn/start' && waiter.turn === null && event.data?.turn !== undefined) {
      waiter.turn = event.data.turn
      log(`DSH turn started: session=${waiter.sessionId} turn=${waiter.turn}`)
      return
    }
    if (event.type === 'assistant/chunk' && event.data?.turn === waiter.turn) {
      const chunk = event.data.chunk
      if (!chunk) return
      if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
        sawReasoning = true
        streamedReasoning += chunk.text
        const delta = sentRole ? { reasoning_content: chunk.text } : { role: 'assistant', reasoning_content: chunk.text }
        if (writeSse(res, jsonBlock(makeChunk(model, delta)))) sentRole = true
      } else if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        sawContent = true
        streamedText += chunk.text
        const delta = sentRole ? { content: chunk.text } : { role: 'assistant', content: chunk.text }
        if (writeSse(res, jsonBlock(makeChunk(model, delta)))) sentRole = true
      }
    } else if (event.type === 'assistant/message' && event.data?.turn === waiter.turn) {
      const content = event.data?.message?.content
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === 'reasoning') waiter.lastReasoning = block.text
          if (block?.type === 'text') waiter.lastText = block.text
        }
      }
      if (event.usage) {
        usage.inputTokens += event.usage.inputTokens ?? 0
        usage.outputTokens += event.usage.outputTokens ?? 0
        usage.cacheReadTokens += event.usage.cacheReadTokens ?? 0
        usage.reasoningTokens += event.usage.reasoningTokens ?? 0
        if (DEBUG) log(`DSH message usage: ${JSON.stringify(event.usage)}`)
      }
    } else if (event.type === 'tool/call') {
      log(`DSH tool call: ${event.data?.name} ${String(event.data?.arguments ?? '').slice(0, 120)}`)
    } else if (event.type === 'tool/result') {
      const text = textOf(event.data?.message?.content)
      log(`DSH tool result: ${text.slice(0, 240)}`)
    } else if (event.type === 'turn/end' && event.data?.turn === waiter.turn) {
      waiter.resolve()
    }
  }

  waiter.promise.then(() => {
    finish(waiter.lastText ?? (streamedText || '(DSH finished without visible text)'))
  }).catch((error) => {
    clearInterval(heartbeat)
    if (!finished) {
      finished = true
      const message = `DSH turn failed: ${error.message}`
      writeSse(res, jsonBlock(makeChunk(model, { role: 'assistant', reasoning_content: '', content: message }, 'stop')))
      writeSse(res, 'data: [DONE]\n\n')
      res.end()
      log(message)
    }
  })

  res.on('close', () => {
    if (!finished) {
      log('Raft disconnected before turn completion; cancelling DSH turn')
      if (dshSessionId) dshRpc('session.cancel', { sessionId: dshSessionId }).catch(() => {})
    }
  })
}

function makeWaiter(sessionId) {
  let resolveFn, rejectFn
  const waiter = {
    sessionId,
    turn: null,
    lastText: '',
    lastReasoning: '',
    settled: false,
    onEvent: null,
    timer: null,
    promise: new Promise((resolve, reject) => {
      resolveFn = resolve
      rejectFn = reject
    }),
    resolve() {
      if (this.settled) return
      this.settled = true
      clearTimeout(this.timer)
      activeTurn = null
      resolveFn()
    },
    fail(error) {
      if (this.settled) return
      this.settled = true
      clearTimeout(this.timer)
      activeTurn = null
      rejectFn(error)
    },
    touch() {
      if (this.settled) return
      clearTimeout(this.timer)
      this.timer = setTimeout(() => this.fail(new Error('DSH turn timed out')), TURN_TIMEOUT_MS)
    },
  }
  waiter.timer = setTimeout(() => waiter.fail(new Error('DSH turn timed out')), TURN_TIMEOUT_MS)
  waiter.onEvent = (event) => {
    if (event.type === 'turn/start' && waiter.turn === null && event.data?.turn !== undefined) {
      waiter.turn = event.data.turn
      log(`DSH turn started: session=${sessionId} turn=${waiter.turn}`)
    }
  }
  return waiter
}

// --------------------------------------------------------- bridge server ---

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')

  if (req.method === 'GET' && (url.pathname === '/models' || url.pathname === '/v1/models')) {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({
      object: 'list',
      data: [
        { id: 'deepseek-v4-pro', object: 'model', created: 0, owned_by: 'raft-dsh-bridge' },
        { id: 'deepseek-v4-flash', object: 'model', created: 0, owned_by: 'raft-dsh-bridge' },
      ],
    }))
    return
  }

  if (req.method === 'GET' && url.pathname === '/__bridge/status') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({
      ok: true,
      dryRun: DRY_RUN,
      port: PORT,
      dshBase: DSH_BASE,
      dshPreset: DSH_PRESET,
      dshCwd: DSH_CWD,
      dshSessionId,
      muxOpen,
      busy: activeTurn !== null,
      turnState: {
        ...turnState,
        firstTokenMs: turnState.firstReasoningAt && turnState.startedAt ? turnState.firstReasoningAt - turnState.startedAt : null,
        lastEventAgeMs: turnState.lastEventAt ? Date.now() - turnState.lastEventAt : null,
        stalled: turnState.phase !== 'idle' && turnState.lastEventAt > 0 && Date.now() - turnState.lastEventAt > STALL_MS,
      },
      raftAgentId: RAFT_AGENT_ID,
      raftWrapper: existsSync(RAFT_WRAPPER) ? RAFT_WRAPPER : null,
    }))
    return
  }

  if (req.method === 'POST' && url.pathname === '/__bridge/cancel') {
    const hadActive = activeTurn !== null
    if (activeTurn) {
      activeTurn.fail(new Error('cancelled from console'))
      log('DSH turn cancelled from console')
    }
    if (dshSessionId) void dshRpc('session.cancel', { sessionId: dshSessionId }).catch(() => {})
    turnState.phase = 'idle'
    turnState.error = null
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: true, cancelled: hadActive }))
    return
  }

  if (req.method === 'POST' && url.pathname === '/__bridge/reset') {
    dshSessionId = null
    lastInboxNotice = null
    clearSessionState()
    log('bridge reset requested')
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: true, dshSessionId: null }))
    return
  }

  const isChatPath = url.pathname === '/chat/completions' || url.pathname === '/v1/chat/completions'
  if (req.method !== 'POST' || !isChatPath) {
    res.writeHead(404)
    res.end('not found')
    return
  }

  if (activeTurn) {
    res.writeHead(409, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: { message: 'bridge is busy with a DSH turn' } }))
    log('rejected concurrent chat/completions request (busy)')
    return
  }

  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', async () => {
    let bodyObj = null
    try {
      bodyObj = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      res.writeHead(400)
      res.end('invalid JSON')
      return
    }

    log(`chat/completions model=${bodyObj.model} stream=${bodyObj.stream} messages=${bodyObj.messages?.length} last=${lastMessageOf(bodyObj)?.role}`)

    if (!dshSessionId || isFreshStartTurn(bodyObj)) {
      if (DRY_RUN) {
        dshSessionId = `dry-session-${randomUUID()}`
      } else {
        try {
          await createDshSession()
        } catch (error) {
          res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: { message: error.message } }))
          log(`session create failed: ${error.message}`)
          return
        }
      }
    }

    if (isBareStartTurn(bodyObj)) {
      log('bare Start turn -> scripted Ready response')
      scriptedResponse(
        res,
        bodyObj,
        'We need to stay ready for incoming Raft messages. No tools are required for this turn.',
        'Ready.',
      )
      return
    }

    const last = lastMessageOf(bodyObj)
    const lastText = textOf(last?.content).trim()
    if (DEDUP_NOTICES && last?.role === 'user' && lastText.startsWith('[Slock inbox')) {
      if (lastInboxNotice === lastText) {
        log('duplicate inbox notice ignored')
        scriptedResponse(res, bodyObj, 'No new Raft inbox content; duplicate platform notice.', 'Ready.')
        return
      }
      lastInboxNotice = lastText
    }
    if (!lastText) {
      log('no usable user text -> scripted empty response')
      scriptedResponse(res, bodyObj, 'No actionable Raft event was present in this request.', 'Waiting for a message.')
      return
    }

    let dshPrompt
    if (last?.role === 'user') {
      const eventLabel = lastText.startsWith('[Slock inbox notice') || lastText.startsWith('[Slock inbox')
        ? '[Platform event: inbox notice]'
        : '[Raft message]'
      dshPrompt = `${raftContextBlock()}\n${memoryPolicyBlock()}\n${eventLabel}\n${lastText}`
    } else if (last?.role === 'tool') {
      dshPrompt = `${raftContextBlock()}\n${memoryPolicyBlock()}\n[Raft tool result]\n${lastText}`
    } else {
      log(`unexpected last role ${last?.role} -> scripted empty response`)
      scriptedResponse(res, bodyObj, 'No actionable Raft event was present in this request.', 'Waiting for a message.')
      return
    }

    if (DRY_RUN) {
      log(`DRY_RUN would prompt DSH (${dshPrompt.length} chars): ${dshPrompt.slice(0, 160).replace(/\n/g, ' | ')}`)
      await new Promise((resolve) => setTimeout(resolve, 50))
      scriptedResponse(res, bodyObj, 'We need to verify the bridge path. In production this is DSH reasoning.', 'DSH dry-run response.')
      return
    }

    let waiter
    try {
      waiter = makeWaiter(dshSessionId)
      activeTurn = waiter
      await ensureModelSelection(dshSessionId, bodyObj)
      await promptDsh(dshPrompt)
    } catch (error) {
      if (waiter) waiter.fail(error)
      log(`DSH prompt failed: ${error.message}`)
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: { message: error.message } }))
      return
    }

    streamedResponse(res, bodyObj, waiter)
  })
})

server.requestTimeout = 0
server.on('error', (error) => log(`server error: ${error.message}`))

if (!DRY_RUN && !DSH_CWD) {
  console.error('DSH_CWD is required: set it to the Raft agent workspace (e.g. %USERPROFILE%/.slock/agents/<agent-id>)')
  process.exit(1)
}
if (!RAFT_AGENT_ID) {
  log('RAFT_AGENT_ID is not set; raft.ps1 auto-discovery is disabled')
}

server.listen(PORT, '127.0.0.1', () => {
  refreshRaftWrapper()
  loadSessionState()
  connectMux()
  log(`raft-dsh-bridge listening on 127.0.0.1:${PORT} dryRun=${DRY_RUN} dsh=${DSH_BASE} preset=${DSH_PRESET} cwd=${DSH_CWD}`)
  console.error(`raft-dsh-bridge listening on http://127.0.0.1:${PORT} (dryRun=${DRY_RUN})`)
})
