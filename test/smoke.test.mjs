/**
 * End-to-end smoke test without any model API call.
 *
 * Starts scripts/mock-dsh.mjs (a fake DSH web API) and
 * scripts/raft-dsh-bridge.mjs, then sends one OpenAI-style
 * `/chat/completions` request through the bridge and asserts that the
 * mock DSH reasoning/content stream is translated back as DeepSeek-style SSE.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('..', import.meta.url)))
const NODE = process.execPath
const MOCK_PORT = 32000 + (process.pid % 1000)
const BRIDGE_PORT = MOCK_PORT + 1
const DATA_DIR = mkdtempSync(join(tmpdir(), 'raft-dsh-bridge-smoke-'))

function run(script, env) {
  return spawn(NODE, [join(ROOT, script)], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

async function waitForUrl(url, attempts = 60) {
  let lastError
  for (let i = 0; i < attempts; i++) {
    try {
      const response = await fetch(url)
      if (response.ok) return response
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw lastError ?? new Error(`timeout waiting for ${url}`)
}

let mock
let bridge
try {
  mock = run('scripts/mock-dsh.mjs', { MOCK_PORT: String(MOCK_PORT) })
  bridge = run('scripts/raft-dsh-bridge.mjs', {
    BRIDGE_PORT: String(BRIDGE_PORT),
    DSH_BASE: `http://127.0.0.1:${MOCK_PORT}`,
    DSH_PRESET: 'anchored-standard',
    DSH_CWD: DATA_DIR,
    RAFT_AGENT_ID: 'test-agent',
    BRIDGE_DATA_DIR: DATA_DIR,
    TURN_TIMEOUT_MS: '10000',
    LOG_FILE: join(DATA_DIR, 'bridge.log'),
    STATE_FILE: join(DATA_DIR, 'state.json'),
  })

  await waitForUrl(`http://127.0.0.1:${BRIDGE_PORT}/__bridge/status`)
  for (let i = 0; i < 60; i++) {
    try {
      const status = await (await fetch(`http://127.0.0.1:${BRIDGE_PORT}/__bridge/status`)).json()
      if (status.muxOpen) break
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  const response = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4-pro',
      stream: true,
      messages: [
        { role: 'system', content: 'smoke' },
        { role: 'user', content: [{ type: 'text', text: 'check inbox' }] },
      ],
    }),
  })
  if (!response.ok) throw new Error(`bridge responded HTTP ${response.status}`)
  const body = await response.text()

  const required = ['reasoning_content', 'We need', 'Mock task done.', 'data: [DONE]']
  for (const token of required) {
    if (!body.includes(token)) {
      throw new Error(`smoke stream is missing ${JSON.stringify(token)}\n${body.slice(0, 2000)}`)
    }
  }
  console.log('smoke ok: mock DSH turn streamed through the bridge as DeepSeek SSE')
} finally {
  for (const child of [bridge, mock]) {
    if (child && !child.killed) child.kill()
  }
  rmSync(DATA_DIR, { recursive: true, force: true })
}
