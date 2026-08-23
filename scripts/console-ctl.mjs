#!/usr/bin/env node
// console-ctl.mjs — PowerShell-free control/self-check for the local console.
// Commands: status | start | stop | restart
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createConnection } from 'node:net'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CONSOLE_JS = join(ROOT, 'console', 'manager.mjs')
const DATA_DIR = process.env.CONSOLE_DATA_DIR ?? join(homedir(), '.raft-dsh-console')
const CONSOLE_PORT = Number(process.env.CONSOLE_PORT ?? 8970)
const CHECK_PORTS = [
  [3080, 'DSH web'],
  [8901, 'bridge 8901'],
  [8902, 'bridge 8902'],
  [CONSOLE_PORT, 'console'],
]

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: '127.0.0.1' })
    socket.setTimeout(700)
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('timeout', () => { socket.destroy(); resolve(false) })
    socket.once('error', () => resolve(false))
  })
}

function consolePid() {
  try {
    const out = execFileSync('netstat.exe', ['-ano', '-p', 'TCP'], { encoding: 'utf8', timeout: 5000, windowsHide: true })
    for (const line of out.split(/\r?\n/)) {
      if (line.includes(`127.0.0.1:${CONSOLE_PORT}`) && line.includes('LISTENING')) {
        const m = line.trim().split(/\s+/)
        const pid = Number(m.at(-1))
        if (Number.isFinite(pid)) return pid
      }
    }
  } catch {}
  return null
}

async function fetchJson(url) {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 2000)
    const response = await fetch(url, { signal: controller.signal })
    clearTimeout(timer)
    if (!response.ok) return null
    return await response.json()
  } catch { return null }
}

async function status() {
  const checks = []
  for (const [port, label] of CHECK_PORTS) checks.push({ port, label, open: await portOpen(port) })
  let state = await fetchJson(`http://127.0.0.1:${CONSOLE_PORT}/api/state`)
  for (let i = 0; i < 3 && !state; i++) {
    await new Promise((resolve) => setTimeout(resolve, 900))
    state = await fetchJson(`http://127.0.0.1:${CONSOLE_PORT}/api/state`)
  }
  const raftRunning = state ? state.raft.running : null
  const agents = state ? state.agents.map((agent) => ({
    id: agent.id, name: agent.name, runtime: agent.currentRuntime,
    model: agent.currentModel ?? null, reasoningEffort: agent.reasoningEffort ?? null,
    connected: agent.connected, port: agent.port,
    phase: agent.bridge?.turnState?.phase ?? null,
    turn: agent.bridge?.turnState?.turn ?? null,
    lastTool: agent.bridge?.turnState?.lastTool ?? null,
    reasoningTail: (agent.bridge?.turnState?.lastReasoningTail ?? '').slice(-120) || null,
    stalled: agent.bridge?.turnState?.stalled ?? false,
    stats: agent.stats ?? null,
  })) : []
  return { consolePort: CONSOLE_PORT, checks, raftRunning, agents }
}

async function start() {
  const pid = consolePid()
  if (pid) return { started: false, pid, reason: 'already running' }
  mkdirSync(DATA_DIR, { recursive: true })
  const child = spawn(process.execPath, [CONSOLE_JS], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      CONSOLE_PORT: String(CONSOLE_PORT),
      CONSOLE_DATA_DIR: DATA_DIR,
      DSH_BASE: process.env.DSH_BASE ?? 'http://127.0.0.1:3080',
      SLOCK_ROOT: process.env.SLOCK_ROOT ?? join(homedir(), '.slock'),
      RAFT_EXE: process.env.RAFT_EXE ?? 'raft-computer.exe',
    },
  })
  child.unref()
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 250))
    if (await portOpen(CONSOLE_PORT)) return { started: true, pid: child.pid }
  }
  return { started: false, pid: child.pid, reason: 'port did not open' }
}

async function stop() {
  const pid = consolePid()
  if (!pid) return { stopped: false, reason: 'not running' }
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill.exe', ['/PID', String(pid), '/F'], { windowsHide: true, stdio: 'ignore' })
    } else {
      process.kill(pid, 'SIGTERM')
    }
  } catch {}
  return { stopped: true, pid }
}

const cmd = process.argv[2] ?? 'status'
if (cmd === 'status') {
  console.log(JSON.stringify(await status(), null, 2))
} else if (cmd === 'start') {
  console.log(JSON.stringify(await start(), null, 2))
} else if (cmd === 'stop') {
  console.log(JSON.stringify(await stop(), null, 2))
} else if (cmd === 'restart') {
  console.log(JSON.stringify({ stop: await stop(), start: await start() }, null, 2))
} else {
  console.error('usage: node scripts/console-ctl.mjs status|start|stop|restart')
  process.exit(1)
}
