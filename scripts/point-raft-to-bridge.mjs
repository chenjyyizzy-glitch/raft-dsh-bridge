// Point a Raft builtin agent's model endpoint at the local DSH bridge.
// Usage:
//   node scripts/point-raft-to-bridge.mjs --port 8899
//   node scripts/point-raft-to-bridge.mjs --restore
//
// Environment:
//   RAFT_AGENT_ID  Raft agent id (required)
//   SLOCK_ROOT     Slock home (defaults to <home>/.slock)
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const AGENT = process.env.RAFT_AGENT_ID
const ROOT = process.env.SLOCK_ROOT ?? join(homedir(), '.slock')
if (!AGENT) {
  console.error('RAFT_AGENT_ID is required')
  process.exit(1)
}
const STORE = join(ROOT, 'agents', AGENT, '.builtin-runtime', 'models-store.json')
const BAK = STORE + '.bridge.bak'
const RESTORE = process.argv.includes('--restore')
let port = 8899
const pi = process.argv.indexOf('--port')
if (pi >= 0) port = Number(process.argv[pi + 1] ?? 8899)

if (RESTORE) {
  if (!existsSync(BAK)) { console.error('no bridge backup:', BAK); process.exit(1) }
  copyFileSync(BAK, STORE)
  console.log('restored', STORE)
  process.exit(0)
}

const j = JSON.parse(readFileSync(STORE, 'utf8'))
if (!existsSync(BAK)) copyFileSync(STORE, BAK)
for (const provider of Object.values(j)) {
  for (const model of provider.models ?? []) {
    model.baseUrl = `http://127.0.0.1:${port}`
  }
}
writeFileSync(STORE, JSON.stringify(j, null, 2))
console.log('models-store now points at bridge:')
for (const provider of Object.values(j)) for (const m of provider.models ?? []) console.log(' ', m.id, m.baseUrl)
console.log('backup:', BAK)
