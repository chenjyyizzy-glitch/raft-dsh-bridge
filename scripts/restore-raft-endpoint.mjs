// Restore Raft models-store from the bridge backup.
// Usage: node scripts/restore-raft-endpoint.mjs
import { copyFileSync, existsSync } from 'node:fs'
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
if (!existsSync(BAK)) { console.error('no bridge backup:', BAK); process.exit(1) }
copyFileSync(BAK, STORE)
console.log('restored', STORE)
