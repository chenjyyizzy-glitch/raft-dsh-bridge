#!/usr/bin/env node
/**
 * raft-dsh-console manager — local web control plane for one or more
 * Raft builtin agents bridged into DeepSeek Harness.
 *
 * Binds 127.0.0.1 only. No auto-start: the user starts this process when
 * they want the console (a start script/bat is provided in deployments).
 */
import { createServer } from 'node:http'
import { spawn, execFileSync, execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  existsSync, mkdirSync, readFileSync, readdirSync, copyFileSync, writeFileSync,
  openSync, closeSync, readSync, statSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createConnection } from 'node:net'

// ----------------------------------------------------------------- config ---
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.CONSOLE_PORT ?? 8970)
const HOST = process.env.CONSOLE_HOST ?? '127.0.0.1'
const DATA_DIR = process.env.CONSOLE_DATA_DIR ?? join(homedir(), '.raft-dsh-console')
const SLOCK_ROOT = process.env.SLOCK_ROOT ?? join(homedir(), '.slock')
const DSH_BASE = (process.env.DSH_BASE ?? 'http://127.0.0.1:3080').replace(/\/+$/, '')
const BRIDGE_SCRIPT = process.env.BRIDGE_SCRIPT ?? join(ROOT, 'scripts', 'raft-dsh-bridge.mjs')
const NODE = process.execPath
const BRIDGE_PORT_BASE = Number(process.env.BRIDGE_PORT_BASE ?? 8901)
const OFFICIAL_DEEPSEEK_BASE = process.env.OFFICIAL_DEEPSEEK_BASE ?? 'https://api.deepseek.com'
const CONFIG_FILE = join(DATA_DIR, 'config.json')
const SERVICE_COMMANDS_FILE = join(DATA_DIR, 'service-commands.json')
const CHECK_RAFT = process.env.RAFT_CHECK !== '0'
const RAFT_EXE = process.env.RAFT_EXE ?? 'raft-computer.exe'
let raftInfoCache = { at: 0, map: {} }
let raftApiCache = { at: 0, map: {} }
const dshStatsCache = new Map()
const builtinSettingsCache = new Map()
let raftApiRefreshBackoffUntil = 0
let raftApiRefreshBackoffToken = ''
let raftProxyCache = { at: 0, map: {} }
let raftProxyContextCache = { at: 0, value: null }

const STATIC_PRESETS = [
  { id: 'standard', trust: 'system', name: 'Standard' },
  { id: 'code', trust: 'system', name: 'PTC' },
  { id: 'minimal', trust: 'system', name: 'Minimal' },
  { id: 'cordis', trust: 'system', name: 'Cordis' },
  { id: 'anchored-standard', trust: 'user', name: 'Anchored Standard' },
  { id: 'zero-anchored-standard', trust: 'user', name: 'Zero-Anchored Standard' },
  { id: 'whoami-standard', trust: 'user', name: 'Whoami Standard' },
  { id: 'prefab-anchored-standard', trust: 'user', name: 'Prefab Anchored Standard' },
  { id: 'eternal-minimal', trust: 'user', name: 'Eternal Minimal' },
  { id: 'wire-think-standard', trust: 'user', name: 'Wire Think-Execute Standard' },
  { id: 'combo-anchored', trust: 'user', name: 'Combo Anchored' },
]
const EFFORTS = ['follow', 'minimal', 'low', 'medium', 'high', 'max']

// ------------------------------------------------------------------ util ---
function log(msg) {
  console.error(`[${new Date().toISOString()}] ${msg}`)
}

function readJson(path, fallback = null) {
  try {
    if (!existsSync(path)) return fallback
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    log(`readJson failed ${path}: ${error.message}`)
    return fallback
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2))
}

function defaultPolicyFor(modelId) {
  if (/v4[-_. ]?pro/i.test(modelId)) {
    return { mode: 'dsh', preset: 'anchored-standard', effort: 'follow' }
  }
  return { mode: 'direct', preset: null, effort: 'follow' }
}

function portOpen(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host })
    socket.setTimeout(500)
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('timeout', () => { socket.destroy(); resolve(false) })
    socket.once('error', () => resolve(false))
  })
}

async function httpGetText(url, timeoutMs = 2000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal })
    return { ok: response.ok, status: response.status, text: await response.text() }
  } catch (error) {
    return { ok: false, status: 0, text: String((error && error.message) || error) }
  } finally {
    clearTimeout(timer)
  }
}

async function dshPresets() {
  try {
    const response = await fetch(`${DSH_BASE}/api/agentPreset.list`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: randomUUID(),
        method: 'agentPreset.list',
        payload: {},
      }),
    })
    if (!response.ok) return STATIC_PRESETS
    const envelope = await response.json()
    const presets = envelope?.result?.ok ? envelope.result.value?.presets : null
    if (!Array.isArray(presets) || presets.length === 0) return STATIC_PRESETS
    return presets.map((preset) => ({
      id: preset.id,
      trust: preset.trust ?? 'user',
      name: preset.name ?? preset.id,
      description: preset.description ?? '',
    }))
  } catch {
    return STATIC_PRESETS
  }
}

function runtimeFromRunnerLogs() {
  const map = {}
  const serversRoot = join(SLOCK_ROOT, 'computer', 'servers')
  if (!existsSync(serversRoot)) return map
  for (const entry of readdirSync(serversRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const logPath = join(serversRoot, entry.name, 'runner.log')
    if (!existsSync(logPath)) continue
    let tail = ''
    try {
      const stat = statSync(logPath)
      const len = Math.min(stat.size, 256 * 1024)
      const fd = openSync(logPath, 'r')
      const buf = Buffer.alloc(len)
      readSync(fd, buf, 0, len, stat.size - len)
      closeSync(fd)
      tail = buf.toString('utf8')
    } catch {
      continue
    }
    for (const line of tail.split(/\r?\n/)) {
      const m = line.match(/Received agent:start \(agent=([^,]+), runtime=([^,]+), model=([^,]*)/)
      if (m) map[m[1]] = { runtime: m[2], model: m[3] }
    }
  }
  return map
}

function raftAgentInfoMap() {
  const now = Date.now()
  if (now - raftInfoCache.at < 10000) return raftInfoCache.map
  const map = {}
  try {
    const out = execFileSync(RAFT_EXE, ['runners', 'list'], { encoding: 'utf8', timeout: 8000, windowsHide: true })
    for (const raw of out.split(/\r?\n/)) {
      const line = raw.trim()
      const head = line.match(/^(\S+)\s+(active|inactive|stopped)\s+(\S+)\s+(.*)$/)
      if (!head) continue
      const id = head[1]
      let rest = (head[4] ?? '').trim()
      let model = ''
      let name = ''
      for (const prefix of ['deepseek/deepseek-v4-pro', 'deepseek/deepseek-v4-flash', 'gpt-5.5', 'gpt-5.6-sol']) {
        if (rest.startsWith(prefix)) {
          model = prefix
          name = rest.slice(prefix.length).trim()
          break
        }
      }
      if (!model) {
        const sep = rest.match(/^(\S+)\s+(.*)$/)
        model = sep ? sep[1] : rest
        name = sep ? sep[2].trim() : ''
      }
      map[id] = { status: head[2], runtime: head[3], model, name }
    }
    raftInfoCache = { at: now, map }
  } catch (error) {
    log('raftAgentInfoMap failed, falling back to runner logs: ' + error.message)
    const fallback = runtimeFromRunnerLogs()

    raftInfoCache = { at: now, map: fallback }
  }
  return raftInfoCache.map
}

function isRaftRunning() {
  if (!CHECK_RAFT) return false
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist.exe', ['/FI', 'IMAGENAME eq raft-computer.exe'], { encoding: 'utf8', timeout: 5000, windowsHide: true })
      return out.includes('raft-computer.exe')
    }
    const out = execSync("pgrep -f raft-computer || true", { encoding: 'utf8', timeout: 5000 })
    return String(out).trim().length > 0
  } catch (error) {
    log(`isRaftRunning failed: ${error.message}`)
    return false
  }
}

// ---------------------------------------------------------------- config ---
let config = readJson(CONFIG_FILE, { version: 1, globalModels: {}, agents: {} })
if (!config.globalModels) config.globalModels = {}
if (!config.agents) config.agents = {}
if (typeof config.autoConnectAll !== 'boolean') config.autoConnectAll = true
function saveConfig() {
  writeJson(CONFIG_FILE, config)
}

// ------------------------------------------------------------ agent scan ---
function scanAgents() {
  const root = join(SLOCK_ROOT, 'agents')
  if (!existsSync(root)) return []
  const out = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const agentDir = join(root, entry.name)
    const storePath = join(agentDir, '.builtin-runtime', 'models-store.json')
    if (!existsSync(storePath)) continue
    let name = null
    const memoryPath = join(agentDir, 'MEMORY.md')
    if (existsSync(memoryPath)) {
      const first = readFileSync(memoryPath, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).find((line) => line.startsWith('# '))
      name = first ? first.slice(2).trim() : null
    }
    out.push({ id: entry.name, name, dir: agentDir, builtin: true, storePath })
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

function modelsOfAgent(agent) {
  const store = readJson(agent.storePath, {})
  const models = []
  for (const provider of Object.values(store)) {
    for (const model of provider.models ?? []) {
      models.push({ id: model.id, baseUrl: model.baseUrl ?? '', provider: provider.id ?? 'unknown' })
    }
  }
  return models
}

function agentConfig(agentId) {
  if (!config.agents[agentId]) {
    config.agents[agentId] = { enabled: false, port: 0, models: {}, connected: false, pid: null, autoConnect: true }
    saveConfig()
  }
  if (typeof config.agents[agentId].autoConnect !== 'boolean') {
    config.agents[agentId].autoConnect = true
    saveConfig()
  }
  return config.agents[agentId]
}

function effectivePolicy(agentId, modelId) {
  const agent = config.agents[agentId] ?? {}
  return agent.models?.[modelId] ?? config.globalModels[modelId] ?? defaultPolicyFor(modelId)
}

// ---------------------------------------------------------- bridge proc ---
function agentDataDir(agentId) {
  return join(DATA_DIR, 'agents', agentId)
}

function startBridge(agentId, agentDir, port, preset) {
  const dataDir = agentDataDir(agentId)
  mkdirSync(dataDir, { recursive: true })
  const outFd = openSync(join(dataDir, 'bridge.out.log'), 'a')
  const errFd = openSync(join(dataDir, 'bridge.err.log'), 'a')
  const child = spawn(NODE, [BRIDGE_SCRIPT], {
    detached: true,
    stdio: ['ignore', outFd, errFd],
    env: {
      ...process.env,
      BRIDGE_PORT: String(port),
      DSH_BASE,
      DSH_PRESET: preset,
      DSH_CWD: agentDir,
      RAFT_AGENT_ID: agentId,
      SLOCK_ROOT,
      BRIDGE_DATA_DIR: dataDir,
      DSH_REASONING_EFFORT: 'follow',
      DEDUP_NOTICES: '1',
      TURN_TIMEOUT_MS: String(process.env.TURN_TIMEOUT_MS ?? 7200000),
    },
  })
  closeSync(outFd)
  closeSync(errFd)
  child.unref()
  return child.pid
}

function bridgeLogStatus(agentId) {
  const state = { phase: 'idle', turn: null, step: null, lastEventAt: null, reasoningChars: null, textChars: null, toolCalls: null, lastTool: null, stalled: false }
  const logPath = join(agentDataDir(agentId), 'raft-dsh-bridge.log')
  if (!existsSync(logPath)) return state
  try {
    const stat = statSync(logPath)
    const len = Math.min(stat.size, 128 * 1024)
    const fd = openSync(logPath, 'r')
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, stat.size - len)
    closeSync(fd)
    const lines = buf.toString('utf8').split(String.fromCharCode(10)).map((line) => line.replace(String.fromCharCode(13), ''))
    let turn = null
    let toolCalls = 0
    for (const line of lines) {
      const tsText = line.slice(0, 24)
      const looksLikeIso = tsText.length === 24 && tsText[0] === '2' && tsText[4] === '-' && tsText[10] === 'T' && tsText[23] === 'Z'
      const eventTime = looksLikeIso ? Date.parse(tsText) : NaN
      if (!Number.isNaN(eventTime)) state.lastEventAt = eventTime
      if (line.includes('chat/completions model=')) {
        state.phase = 'starting'
      } else if (line.includes('DSH turn started:')) {
        const idx = line.indexOf('turn=')
        if (idx >= 0) {
          let endIdx = idx + 5
          while (endIdx < line.length && line[endIdx] >= '0' && line[endIdx] <= '9') endIdx++
          turn = Number(line.slice(idx + 5, endIdx))
        }
        state.turn = turn
        state.phase = 'thinking'
      } else if (line.includes('DSH tool call:')) {
        state.phase = 'tool'
        const tail = line.slice(line.indexOf('DSH tool call:') + 15).trim()
        state.lastTool = tail.split(' ').filter(Boolean)[0] || null
        toolCalls++
        state.toolCalls = toolCalls
      } else if (line.includes('turn streamed:')) {
        const rIdx = line.indexOf('reasoning=')
        const tIdx = line.indexOf(' chars, text=')
        if (rIdx >= 0 && tIdx > rIdx) {
          state.reasoningChars = Number(line.slice(rIdx + 10, tIdx))
          const textStart = tIdx + 12
          const textEnd = line.indexOf(' chars,', textStart)
          if (textEnd > textStart) state.textChars = Number(line.slice(textStart, textEnd))
        }
        state.phase = 'idle'
      } else if (line.includes('DSH turn failed') || line.includes('timed out')) {
        state.phase = 'error'
      }
    }
    if (state.phase !== 'idle' && state.lastEventAt) {
      const age = Date.now() - state.lastEventAt
      state.lastEventAgeMs = age
      state.stalled = age > 120000
    }
    return state
  } catch {
    return state
  }
}

async function bridgeIdentity(port) {
  if (!port) return null
  try {
    const response = await fetch(`http://127.0.0.1:${port}/__bridge/status`)
    if (!response.ok) return null
    const json = await response.json()
    if (json && typeof json.raftAgentId === 'string') return json
  } catch {}
  return null
}

async function ensureBridge(agentId, agentDir, port, preset) {
  const agent = agentConfig(agentId)
  const existing = await bridgeIdentity(port)
  if (existing && existing.raftAgentId === agentId) {
    agent.pid = agent.pid ?? null
    agent.port = port
    agent.connected = true
    saveConfig()
    return agent
  }
  if (existing) {
    throw new Error(`端口 ${port} 已被 agent ${existing.raftAgentId} 占用`)
  }
  const pid = startBridge(agentId, agentDir, port, preset)
  agent.pid = pid
  agent.port = port
  agent.enabled = true
  saveConfig()
  for (let i = 0; i < 40; i++) {
    await new Promise((resolve) => setTimeout(resolve, 250))
    const identity = await bridgeIdentity(port)
    if (identity && identity.raftAgentId === agentId) {
      agent.connected = true
      saveConfig()
      return agent
    }
  }
  throw new Error('bridge did not become ready')
}

async function stopBridge(agentId) {
  const agent = config.agents[agentId]
  if (!agent) return
  if (agent.port) {
    const identity = await bridgeIdentity(agent.port)
    if (identity && identity.raftAgentId !== agentId) {
      log(`stopBridge skipped: port ${agent.port} belongs to ${identity.raftAgentId}`)
    } else if (agent.pid) {
      try { process.kill(agent.pid, 'SIGTERM') } catch {}
    }
  }
  agent.connected = false
  agent.pid = null
  saveConfig()
}

function backupPath(agent) {
  return join(agent.dir, '.builtin-runtime', 'models-store.json.raft-dsh.bak')
}

function applyPolicyToStore(agent, port, policies) {
  const storePath = agent.storePath
  const store = readJson(storePath, {})
  if (!existsSync(backupPath(agent))) copyFileSync(storePath, backupPath(agent))
  for (const provider of Object.values(store)) {
    for (const model of provider.models ?? []) {
      const policy = policies[model.id] ?? defaultPolicyFor(model.id)
      model.baseUrl = policy.mode === 'dsh'
        ? `http://127.0.0.1:${port}`
        : OFFICIAL_DEEPSEEK_BASE
    }
  }
  writeJson(storePath, store)
}

function restoreStore(agent) {
  const bak = backupPath(agent)
  if (existsSync(bak)) {
    copyFileSync(bak, agent.storePath)
    return true
  }
  return false
}

function parseRaftWrapperEnv(file) {
  try {
    const lines = readFileSync(file, 'utf8').split(/\n/).map((line) => line.trimEnd())
    let proxyUrl = ''
    let tokenFile = ''
    for (const line of lines) {
      if (line.includes('SLOCK_AGENT_PROXY_URL=')) {
        const parts = line.split("'")
        if (parts[1]) proxyUrl = parts[1]
      }
      if (line.includes('SLOCK_AGENT_PROXY_TOKEN_FILE=')) {
        const parts = line.split("'")
        if (parts[1]) tokenFile = parts[1]
      }
    }
    if (!proxyUrl || !tokenFile || !existsSync(tokenFile)) return null
    const token = readFileSync(tokenFile, 'utf8').trim()
    if (!token) return null
    return { proxyUrl: proxyUrl.endsWith('/') ? proxyUrl.slice(0, -1) : proxyUrl, token }
  } catch { return null }
}

function raftProxyCandidates() {
  const files = new Set()
  for (const agent of scanAgents()) {
    const stable = join(DATA_DIR, 'agents', agent.id, 'cli', 'raft.ps1')
    if (existsSync(stable)) files.add(stable)
    const root = join(SLOCK_ROOT, 'cli-transport', agent.id)
    if (!existsSync(root)) continue
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const file = join(root, entry.name, 'raft.ps1')
      if (existsSync(file)) files.add(file)
    }
  }
  return [...files].sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
}

function localPortOpen(urlText) {
  return new Promise((resolve) => {
    try {
      const url = new URL(urlText)
      const socket = createConnection({ host: url.hostname, port: Number(url.port || 80) })
      socket.setTimeout(700)
      socket.once('connect', () => { socket.destroy(); resolve(true) })
      socket.once('timeout', () => { socket.destroy(); resolve(false) })
      socket.once('error', () => resolve(false))
    } catch { resolve(false) }
  })
}

async function raftProxyContext() {
  const now = Date.now()
  if (now - raftProxyContextCache.at < 60000) return raftProxyContextCache.value
  for (const file of raftProxyCandidates()) {
    const context = parseRaftWrapperEnv(file)
    if (!context) continue
    if (!await localPortOpen(context.proxyUrl)) continue
    const auth = { Authorization: `Bearer ${context.token}` }
    const server = await fetchJsonWithTimeout(`${context.proxyUrl}/internal/agent-api/server`, auth, 2500)
    if (server && Array.isArray(server.agents)) {
      raftProxyContextCache = { at: now, value: context }
      return context
    }
  }
  raftProxyContextCache = { at: now, value: null }
  return null
}

async function fetchJsonWithTimeout(url, headers, timeoutMs = 4000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { headers, signal: controller.signal })
    if (!response.ok) return null
    return await response.json()
  } catch { return null } finally { clearTimeout(timer) }
}

// The local daemon agent-proxy is the reliable name source: it uses the
// runner's own credential, so it keeps working even when the user-session
// access/refresh token is expired. It also exposes Raft's current displayName.
async function raftProfilesViaProxy() {
  const now = Date.now()
  if (now - raftProxyCache.at < 20000) return raftProxyCache.map
  const context = await raftProxyContext()
  if (!context) return {}
  try {
    const auth = { Authorization: `Bearer ${context.token}` }
    const server = await fetchJsonWithTimeout(`${context.proxyUrl}/internal/agent-api/server`, auth)
    if (!server || !Array.isArray(server.agents)) {
      raftProxyContextCache = { at: 0, value: null }
      return {}
    }
    const handles = [...new Set(server.agents.map((agent) => agent.name).filter(Boolean))]
    const map = {}
    await Promise.all(handles.map(async (handle) => {
      const profile = await fetchJsonWithTimeout(
        `${context.proxyUrl}/internal/agent-api/profile?target=${encodeURIComponent('@' + handle)}`,
        auth,
      )
      if (!profile?.id) return
      map[profile.id] = {
        name: profile.name ?? handle,
        displayName: profile.displayName ?? null,
        model: profile.model ?? null,
        reasoningEffort: profile.reasoningEffort ?? null,
      }
    }))
    raftProxyCache = { at: now, map }
    return map
  } catch {
    raftProxyCache = { at: now, map: {} }
    raftProxyContextCache = { at: 0, value: null }
    return {}
  }
}

async function raftApiContext() {
  try {
    const sessionPath = join(SLOCK_ROOT, 'computer', 'user-session.json')
    let userSession = readJson(sessionPath, {})
    if (!userSession.accessToken) return null
    // A failed refresh gets a backoff so the console does not hammer auth with
    // an invalidated refresh token. Editing the session file clears the wait.
    if (Date.now() < raftApiRefreshBackoffUntil && userSession.refreshToken === raftApiRefreshBackoffToken) {
      try {
        const claims = JSON.parse(Buffer.from(userSession.accessToken.split('.')[1], 'base64url').toString())
        if (claims.exp && claims.exp * 1000 > Date.now()) return continueWithToken(userSession)
      } catch {}
      return null
    }
    raftApiRefreshBackoffUntil = 0
    raftApiRefreshBackoffToken = ''
    try {
      const claims = JSON.parse(Buffer.from(userSession.accessToken.split('.')[1], 'base64url').toString())
      const expiresAt = claims.exp ? claims.exp * 1000 : 0
      if (expiresAt && expiresAt < Date.now() + 60_000 && userSession.refreshToken) {
        try {
          const response = await fetch('https://api.raft.build/api/auth/refresh', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ refreshToken: userSession.refreshToken }),
          })
          const refreshed = await response.json()
          if (response.ok && refreshed.accessToken) {
            userSession = { ...userSession, ...refreshed }
            writeFileSync(sessionPath, JSON.stringify(userSession, null, 2))
          } else {
            raftApiRefreshBackoffUntil = Date.now() + 5 * 60_000
            raftApiRefreshBackoffToken = userSession.refreshToken
          }
        } catch {
          raftApiRefreshBackoffUntil = Date.now() + 60_000
          raftApiRefreshBackoffToken = userSession.refreshToken
        }
        // A failed refresh is not fatal: keep using the still-valid access token.
        if (expiresAt <= Date.now()) return null
      }
    } catch {}
    return continueWithToken(userSession)
  } catch {}
  return null
}

function continueWithToken(userSession) {
  const serversRoot = join(SLOCK_ROOT, 'computer', 'servers')
  if (!existsSync(serversRoot)) return null
  for (const entry of readdirSync(serversRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const state = readJson(join(serversRoot, entry.name, 'runner.state.json'), {})
    if (state.serverId) return { accessToken: userSession.accessToken, serverId: state.serverId }
    // server directory name is the Raft server id (X-Server-Id)
    if (existsSync(join(serversRoot, entry.name, 'runner.connected'))) return { accessToken: userSession.accessToken, serverId: entry.name }
  }
  return null
}

async function raftAgentApiInfo() {
  const now = Date.now()
  if (now - raftApiCache.at < 15000) return raftApiCache.map
  const ctx = await raftApiContext()
  if (!ctx) return {}
  try {
    const ids = scanAgents().map((agent) => agent.id)
    const map = {}
    await Promise.all(ids.map(async (id) => {
      const response = await fetch(`https://api.raft.build/api/agents/${id}`, {
        headers: { Authorization: `Bearer ${ctx.accessToken}`, 'X-Server-Id': ctx.serverId },
      })
      if (!response.ok) return
      const json = await response.json().catch(() => null)
      if (!json) return
      map[id] = { name: json.name || json.displayName || null, model: json.model || null, reasoningEffort: json.reasoningEffort || null }
    }))
    raftApiCache = { at: now, map }
  } catch {
    raftApiCache = { at: now, map: {} }
  }
  return raftApiCache.map
}

async function dshSessionStats(sessionId) {
  if (!sessionId) return null
  const cached = dshStatsCache.get(sessionId)
  if (cached && Date.now() - cached.at < 15000) return cached.value
  try {
    const response = await fetch(`${DSH_BASE}/api/session.list`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'session.list', payload: {} }),
    })
    const envelope = await response.json()
    const items = envelope?.result?.ok ? envelope.result.value?.items : []
    const item = items.find((entry) => entry.sessionId === sessionId)
    if (!item) return null
    const values = item.projections?.values ?? {}
    const stats = values.sessionStats ?? {}
    const tokens = values.tokenUsage ?? {}
    const ttftSteps = stats.ttftSteps || 1
    const decodeMs = stats.decodeMs || 1
    const inputTokens = (tokens.uncachedInputTokens ?? 0) + (tokens.cacheReadTokens ?? 0)
    const value = {
      ttftAvgMs: stats.ttftMs ? stats.ttftMs / ttftSteps : null,
      tokPerSec: stats.decodeTokens ? stats.decodeTokens / (decodeMs / 1000) : null,
      cacheHitPct: inputTokens ? (tokens.cacheReadTokens ?? 0) / inputTokens * 100 : null,
      inputTokens,
      outputTokens: tokens.outputTokens ?? 0,
      turns: stats.turns ?? 0,
      steps: stats.steps ?? 0,
    }
    dshStatsCache.set(sessionId, { at: Date.now(), value })
    return value
  } catch {
    return null
  }
}

// ---------------------------------------------------- live DSH mux tail ---
// One lightweight mux connection gives the console real-time turn state and a
// short reasoning tail for every session, independently of bridge versions.
let muxTurnStates = new Map()
let muxSocket = null
let muxTimer = null

function emptyLiveTurn() {
  return {
    phase: 'idle', turn: null, step: null, startedAt: null, endedAt: null,
    lastEventAt: 0, reasoningChars: 0, textChars: 0, toolCalls: 0,
    lastTool: null, firstReasoningAt: null, lastReasoningTail: '', error: null,
  }
}

function touchLiveTurn(sessionId, sessionEvent) {
  const type = sessionEvent?.type
  const data = sessionEvent?.data ?? {}
  let turn = muxTurnStates.get(sessionId) ?? emptyLiveTurn()
  turn.lastEventAt = Date.now()
  if (type === 'turn/start') {
    turn = emptyLiveTurn()
    turn.phase = 'starting'
    turn.turn = data.turn
    turn.startedAt = Date.now()
    turn.lastEventAt = Date.now()
  } else if (type === 'assistant/chunk') {
    turn.step = data.step ?? turn.step
    const chunk = data.chunk
    if (chunk?.type === 'reasoning-delta') {
      turn.phase = 'thinking'
      if (turn.firstReasoningAt === null) turn.firstReasoningAt = Date.now()
      turn.reasoningChars += chunk.text?.length ?? 0
      if (typeof chunk.text === 'string' && chunk.text) turn.lastReasoningTail = (turn.lastReasoningTail + chunk.text).slice(-240)
    } else if (chunk?.type === 'text-delta') {
      turn.phase = 'text'
      turn.textChars += chunk.text?.length ?? 0
    }
  } else if (type === 'assistant/message') {
    turn.step = data.step ?? turn.step
    turn.phase = 'text'
  } else if (type === 'tool/call') {
    turn.phase = 'tool'
    turn.toolCalls += 1
    turn.lastTool = data.name ?? null
  } else if (type === 'tool/result') {
    turn.phase = 'continuing'
  } else if (type === 'turn/end') {
    turn.phase = 'idle'
    turn.endedAt = Date.now()
  } else if (type === 'turn/error' || type === 'stream/error') {
    turn.phase = 'error'
    turn.error = data?.message ?? data?.reason ?? 'error'
  }
  muxTurnStates.set(sessionId, turn)
}

function connectLiveMux() {
  if (typeof WebSocket !== 'function') return
  if (muxSocket && (muxSocket.readyState === 0 || muxSocket.readyState === 1)) return
  try {
    const base = new URL(DSH_BASE)
    const protocol = base.protocol === 'https:' ? 'wss:' : 'ws:'
    muxSocket = new WebSocket(`${protocol}//${base.host}/api/events.mux`)
  } catch {
    muxSocket = null
    return
  }
  muxSocket.onopen = () => log('live mux connected for realtime thinking tail')
  muxSocket.onmessage = (event) => {
    try {
      const frame = JSON.parse(String(event.data))
      if (frame.type !== 'server-request') return
      const payload = frame.payload
      if (payload?.type === 'session/event' && payload.sessionId && payload.event) {
        touchLiveTurn(payload.sessionId, payload.event)
      }
    } catch {}
  }
  muxSocket.onclose = () => {
    muxSocket = null
    muxTimer = setTimeout(connectLiveMux, 2000)
  }
  muxSocket.onerror = () => {}
}

function liveTurnFor(sessionId) {
  const turn = muxTurnStates.get(sessionId)
  if (!turn) return null
  return {
    ...turn,
    firstTokenMs: turn.firstReasoningAt && turn.startedAt ? turn.firstReasoningAt - turn.startedAt : null,
    lastEventAgeMs: turn.lastEventAt ? Date.now() - turn.lastEventAt : null,
    stalled: turn.phase !== 'idle' && turn.lastEventAt > 0 && Date.now() - turn.lastEventAt > 120_000,
  }
}

const serviceTransitions = {
  dsh: { action: null, since: 0, error: null },
  raft: { action: null, since: 0, error: null },
}

function normalizeServiceCommand(value) {
  if (typeof value === 'string' && value.trim()) return { command: value }
  if (value && typeof value === 'object') {
    const cwd = typeof value.cwd === 'string' && value.cwd.trim() ? value.cwd : undefined
    if (typeof value.bat === 'string' && value.bat.trim()) {
      return { bat: value.bat, args: Array.isArray(value.args) ? value.args.map(String) : [], cwd }
    }
    if (typeof value.exe === 'string' && value.exe.trim()) {
      return { exe: value.exe, args: Array.isArray(value.args) ? value.args.map(String) : [], cwd }
    }
    if (typeof value.command === 'string' && value.command.trim()) return { command: value.command, cwd }
  }
  return {}
}

function serviceCommands() {
  const file = readJson(SERVICE_COMMANDS_FILE, {})
  return {
    dsh: {
      start: normalizeServiceCommand(process.env.DSH_START_CMD ?? file.dsh?.start),
      stop: normalizeServiceCommand(process.env.DSH_STOP_CMD ?? file.dsh?.stop),
    },
    raft: {
      start: normalizeServiceCommand(process.env.RAFT_START_CMD ?? file.raft?.start),
      stop: normalizeServiceCommand(process.env.RAFT_STOP_CMD ?? file.raft?.stop),
    },
  }
}

async function watchServiceStart(service) {
  const transition = serviceTransitions[service]
  const deadline = Date.now() + 150_000
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1500))
    if (transition.action !== 'start') return
    if (service === 'dsh') {
      const dsh = await httpGetText(`${DSH_BASE}/`, 2500)
      if (dsh.ok) { transition.action = null; transition.error = null; return }
    } else if (isRaftRunning()) {
      transition.action = null
      transition.error = null
      return
    }
  }
  if (transition.action === 'start') {
    transition.action = null
    transition.error = '启动超时（150 秒未检测到运行状态），请检查桌面 bat'
  }
}

function runServiceAction(service, action) {
  const entry = serviceCommands()[service]?.[action]
  if (!entry || (!entry.bat && !entry.exe && !entry.command)) {
    return { ok: false, error: `${service} ${action} 命令未配置：编辑 ${SERVICE_COMMANDS_FILE} 或设置环境变量` }
  }
  const comspec = process.env.ComSpec ?? 'cmd.exe'
  const options = entry.cwd ? { cwd: entry.cwd } : {}
  let file = entry.exe ?? comspec
  let args = entry.exe ? [...(entry.args ?? [])] : ['/d', '/s', '/c']
  if (entry.bat) args.push('call', entry.bat, ...(entry.args ?? []))
  else if (!entry.exe) args.push(entry.command)
  const transition = serviceTransitions[service]
  transition.action = action
  transition.since = Date.now()
  transition.error = null
  try {
    if (action === 'start') {
      const child = spawn(file, args, {
        detached: true, stdio: 'ignore', windowsHide: true, ...options,
      })
      child.unref()
      void watchServiceStart(service)
      return { ok: true, service, action, started: true, transition: 'starting' }
    }
    execFileSync(file, args, {
      stdio: 'ignore', timeout: 120_000, windowsHide: true, ...options,
    })
    transition.action = null
    transition.error = null
    return { ok: true, service, action, transition: 'done' }
  } catch (error) {
    transition.action = null
    transition.error = error.message
    return { ok: false, service, action, error: error.message, transition: 'failed' }
  }
}

// ------------------------------------------------------------- API state ---
function builtinSessionSettings(agent, runnerModel) {
  const cached = builtinSettingsCache.get(agent.id)
  if (cached && Date.now() - cached.at < 30000) return cached.value
  let value = null
  try {
    const dir = join(agent.dir, '.builtin-sessions')
    if (existsSync(dir)) {
      const files = readdirSync(dir).filter((name) => name.endsWith('.jsonl'))
        .map((name) => join(dir, name))
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
      for (const file of files) {
        let text = ''
        const fd = openSync(file, 'r')
        const size = 64 * 1024
        const buffer = Buffer.alloc(size)
        try { text = buffer.toString('utf8', 0, readSync(fd, buffer, 0, size, 0)) } finally { closeSync(fd) }
        let modelId = null
        let level = null
        for (const raw of text.split(/\n/)) {
          if (!raw.startsWith('{')) continue
          let entry
          try { entry = JSON.parse(raw) } catch { continue }
          if (entry.type === 'model_change') modelId = entry.modelId ?? modelId
          if (entry.type === 'thinking_level_change') level = entry.thinkingLevel ?? level
          if (modelId && level) break
        }
        if (!modelId || !level) continue
        const shortRunner = String(runnerModel ?? '').replace('deepseek/', '')
        if (shortRunner && modelId !== shortRunner) continue
        const levels = { off: 'default', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', max: 'xhigh' }
        value = { modelId, effort: levels[level] ?? level }
        break
      }
    }
  } catch (error) { log('builtinSessionSettings failed: ' + error.message) }
  builtinSettingsCache.set(agent.id, { at: Date.now(), value })
  return value
}

async function buildState() {
  const dsh = await httpGetText(`${DSH_BASE}/`)
  const raftRunning = isRaftRunning()
  const runtimeMap = raftAgentInfoMap()
  const proxyMap = await raftProfilesViaProxy()
  const apiMap = await raftAgentApiInfo()
  const candidates = scanAgents().filter((agent) => {
    const runtime = runtimeMap[agent.id]?.runtime
    if (runtime) return runtime === 'builtin'
    // Raft stopped / detection unavailable: show all builtin-capable agents
    return true
  })
  const agents = await Promise.all(candidates.map(async (agent) => {
    const agentCfg = config.agents[agent.id] ?? { enabled: false, port: 0, models: {}, connected: false, pid: null }
    const port = agentCfg.port ?? 0
    const identity = port > 0 ? await bridgeIdentity(port) : null
    const connected = agentCfg.connected === true && identity !== null && identity.raftAgentId === agent.id
    const info = runtimeMap[agent.id] ?? {}
    const proxy = proxyMap[agent.id] ?? {}
    const api = apiMap[agent.id] ?? {}
    const builtinSettings = builtinSessionSettings(agent, info.model)
    const stats = connected && identity.dshSessionId ? await dshSessionStats(identity.dshSessionId) : null
    const liveTurn = connected && identity.dshSessionId ? liveTurnFor(identity.dshSessionId) : null
    const effortKnown = 'reasoningEffort' in proxy || 'reasoningEffort' in api
    const effort = proxy.reasoningEffort ?? api.reasoningEffort
    return {
      ...agent,
      // Local agent-proxy profile is authoritative for Raft displayName,
      // then user-session API, then the runner list.
      name: proxy.displayName || proxy.name || api.name || info.name || agent.name || null,
      currentModel: proxy.model || api.model || info.model || agent.models?.[0]?.id || null,
      reasoningEffort: effort || (effortKnown ? 'default' : builtinSettings?.effort ?? null),
      port,
      enabled: agentCfg.enabled ?? false,
      connected,
      autoConnect: agentCfg.autoConnect !== false,
      pid: agentCfg.pid ?? null,
      backupExists: existsSync(backupPath(agent)),
      currentRuntime: info.runtime ?? null,
      currentStatus: info.status ?? null,
      stats,
      bridge: identity
        ? {
            preset: identity.dshPreset ?? null,
            sessionId: identity.dshSessionId ?? null,
            busy: identity.busy ?? false,
            turnState: liveTurn ?? identity.turnState ?? bridgeLogStatus(agent.id),
          }
        : null,
    }
  }))
  const commands = serviceCommands()
  return {
    console: { port: PORT, dataDir: DATA_DIR },
    autoConnectAll: config.autoConnectAll === true,
    dsh: { base: DSH_BASE, ok: dsh.ok, status: dsh.status },
    raft: { running: raftRunning },
    services: {
      dsh: {
        ok: dsh.ok,
        status: dsh.status,
        startConfigured: Boolean(commands.dsh.start?.bat || commands.dsh.start?.exe || commands.dsh.start?.command),
        stopConfigured: Boolean(commands.dsh.stop?.bat || commands.dsh.stop?.exe || commands.dsh.stop?.command),
        transition: { ...serviceTransitions.dsh },
      },
      raft: {
        running: raftRunning,
        startConfigured: Boolean(commands.raft.start?.bat || commands.raft.start?.exe || commands.raft.start?.command),
        stopConfigured: Boolean(commands.raft.stop?.bat || commands.raft.stop?.exe || commands.raft.stop?.command),
        transition: { ...serviceTransitions.raft },
      },
    },
    agents,
  }
}

async function connectAgent(agent) {
  if (!agent?.builtin) return { ok: false, error: 'agent does not have a builtin runtime' }
  const runtimeMap = runtimeFromRunnerLogs()
  if (Object.keys(runtimeMap).length > 0 && runtimeMap[agent.id] && runtimeMap[agent.id].runtime !== 'builtin') {
    return { ok: false, error: `当前 runtime 是 ${runtimeMap[agent.id].runtime}，桥只对 builtin runtime 生效` }
  }
  if (isRaftRunning()) return { ok: false, error: '请先退出 Raft，再接入或切换 agent' }
  const agentCfg = agentConfig(agent.id)
  agentCfg.autoConnect = true
  let port = 0
  if (agentCfg.port && agentCfg.port > 0) {
    const existing = await bridgeIdentity(agentCfg.port)
    if (!existing || existing.raftAgentId === agent.id) port = agentCfg.port
    if (existing && existing.raftAgentId === agent.id && agentCfg.connected === true) {
      return { ok: true, already: true, port, preset: agentCfg.preset ?? 'anchored-standard' }
    }
  }
  if (!port) {
    const used = new Set(Object.values(config.agents).map((item) => item.port).filter(Boolean))
    for (let candidate = BRIDGE_PORT_BASE; candidate < BRIDGE_PORT_BASE + 50; candidate++) {
      if (used.has(candidate)) continue
      const existing = await bridgeIdentity(candidate)
      if (!existing) { port = candidate; break }
    }
  }
  if (!port) return { ok: false, error: 'no free bridge port' }
  const policies = Object.fromEntries(
    modelsOfAgent(agent).map((model) => [model.id, effectivePolicy(agent.id, model.id)]),
  )
  const dshPolicies = Object.entries(policies).filter(([, policy]) => policy.mode === 'dsh')
  const preset = dshPolicies[0]?.[1].preset ?? 'anchored-standard'
  agentCfg.port = port
  agentCfg.preset = preset
  agentCfg.enabled = true
  saveConfig()
  const started = await ensureBridge(agent.id, agent.dir, port, preset)
  applyPolicyToStore(agent, port, policies)
  return { ok: true, port, pid: started.pid, preset }
}

let autoConnectBusy = false
async function autoConnectAllAgents() {
  if (!config.autoConnectAll || autoConnectBusy) return
  if (isRaftRunning()) return
  autoConnectBusy = true
  try {
    for (const agent of scanAgents().filter((item) => item.builtin)) {
      const cfg = config.agents[agent.id] ?? { autoConnect: true, connected: false, port: 0 }
      if (cfg.autoConnect === false) continue
      if (cfg.connected === true && cfg.port > 0) {
        const identity = await bridgeIdentity(cfg.port)
        if (identity && identity.raftAgentId === agent.id) continue
      }
      const result = await connectAgent(agent)
      if (result.ok) log(`auto-connect ${agent.id}: port=${result.port} already=${Boolean(result.already)}`)
      else log(`auto-connect ${agent.id} skipped: ${result.error}`)
    }
  } catch (error) {
    log('auto-connect pass failed: ' + error.message)
  } finally {
    autoConnectBusy = false
  }
}

async function dshRpcManager(method, payload) {
  const response = await fetch(`${DSH_BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload }),
  })
  if (!response.ok) throw new Error(`DSH ${method} HTTP ${response.status}`)
  const envelope = await response.json().catch(() => null)
  if (!envelope?.result?.ok) throw new Error(`DSH ${method} rejected`)
  return envelope.result.value
}

async function cancelAgentTurn(agent) {
  const cfg = config.agents[agent.id]
  if (!cfg?.port) return { ok: false, error: 'agent is not connected' }
  const identity = await bridgeIdentity(cfg.port)
  if (!identity || identity.raftAgentId !== agent.id) return { ok: false, error: 'bridge identity mismatch' }
  let cancelledByBridge = false
  try {
    const response = await fetch(`http://127.0.0.1:${cfg.port}/__bridge/cancel`, { method: 'POST' })
    if (response.ok) {
      const body = await response.json().catch(() => ({}))
      cancelledByBridge = Boolean(body.ok)
    }
  } catch {}
  if (!cancelledByBridge && identity.dshSessionId) {
    await dshRpcManager('session.cancel', { sessionId: identity.dshSessionId })
  }
  return { ok: true, cancelled: true }
}

// ------------------------------------------------------------- HTTP app ---
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`)
  res.setHeader('content-type', 'application/json; charset=utf-8')

  const send = (status, value) => {
    res.statusCode = status
    res.end(JSON.stringify(value))
  }

  const readBody = async () => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return {} }
  }

  if (req.method === 'GET' && url.pathname === '/') {
    const html = readFileSync(join(ROOT, 'console', 'web', 'index.html'), 'utf8')
    res.statusCode = 200
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.end(html)
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/state') {
    send(200, await buildState())
    return
  }

  let serviceAction = null
  if (url.pathname.startsWith('/api/system/')) {
    const parts = url.pathname.split('/')
    if (parts.length === 5 && (parts[3] === 'dsh' || parts[3] === 'raft') && (parts[4] === 'start' || parts[4] === 'stop')) serviceAction = [parts[3], parts[4]]
  }
  if (serviceAction && req.method === 'POST') {
    const result = runServiceAction(serviceAction[0], serviceAction[1])

    send(result.ok ? 200 : 400, result)
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/presets') {
    send(200, { presets: await dshPresets(), efforts: EFFORTS })
    return
  }

  if (req.method === 'PUT' && url.pathname === '/api/global-policy') {
    const body = await readBody()
    if (!body.modelId || typeof body.policy !== 'object') return send(400, { error: 'modelId and policy are required' })
    config.globalModels[body.modelId] = {
      mode: body.policy.mode === 'dsh' ? 'dsh' : 'direct',
      preset: body.policy.mode === 'dsh' ? String(body.policy.preset ?? 'standard') : null,
      effort: EFFORTS.includes(body.policy.effort) ? body.policy.effort : 'follow',
    }
    saveConfig()
    send(200, { ok: true })
    return
  }

  const agentMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/([a-z-]+)$/)
  if (agentMatch && req.method === 'POST' && agentMatch[2] === 'cancel') {
    const agentId = decodeURIComponent(agentMatch[1])
    const agent = scanAgents().find((item) => item.id === agentId)
    if (!agent) return send(404, { error: 'agent not found' })
    try {
      send(200, await cancelAgentTurn(agent))
    } catch (error) {
      send(500, { error: error.message })
    }
    return
  }

  if (agentMatch && req.method === 'PUT' && agentMatch[2] === 'policy') {
    const agentId = decodeURIComponent(agentMatch[1])
    const body = await readBody()
    if (!body.modelId || typeof body.policy !== 'object') return send(400, { error: 'modelId and policy are required' })
    const agent = agentConfig(agentId)
    agent.models = agent.models ?? {}
    agent.models[body.modelId] = {
      mode: body.policy.mode === 'dsh' ? 'dsh' : 'direct',
      preset: body.policy.mode === 'dsh' ? String(body.policy.preset ?? 'anchored-standard') : null,
      effort: EFFORTS.includes(body.policy.effort) ? body.policy.effort : 'follow',
    }
    saveConfig()
    send(200, { ok: true, agent })
    return
  }

  if (agentMatch && req.method === 'POST' && agentMatch[2] === 'connect') {
    const agentId = decodeURIComponent(agentMatch[1])
    const agent = scanAgents().find((item) => item.id === agentId)
    if (!agent) return send(404, { error: 'agent not found' })
    try {
      const result = await connectAgent(agent)
      send(result.ok ? 200 : 400, result)
    } catch (error) {
      send(500, { error: error.message })
    }
    return
  }

  if (agentMatch && req.method === 'POST' && agentMatch[2] === 'disconnect') {
    const agentId = decodeURIComponent(agentMatch[1])
    const agent = scanAgents().find((item) => item.id === agentId)
    if (!agent) return send(404, { error: 'agent not found' })
    if (isRaftRunning()) return send(409, { error: '请先退出 Raft，再断开 agent' })
    await stopBridge(agentId)
    restoreStore(agent)
    const cfg = agentConfig(agentId)
    cfg.autoConnect = false
    saveConfig()
    send(200, { ok: true })
    return
  }

  send(404, { error: 'not found' })
})

mkdirSync(DATA_DIR, { recursive: true })
server.listen(PORT, HOST, () => {
  log(`raft-dsh-console listening on http://${HOST}:${PORT} (data=${DATA_DIR})`)
  console.log(`raft-dsh-console: http://${HOST}:${PORT}`)
  connectLiveMux()
  void autoConnectAllAgents()
  setInterval(() => void autoConnectAllAgents(), 8000)
})
