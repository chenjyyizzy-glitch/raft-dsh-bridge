// Aggregate trajectory fingerprints from a DSH session export (session.jsonl).
// Privacy: prints aggregates only, never reasoning text.
import { readFileSync } from 'node:fs'
const file = process.argv[2]
if (!file) { console.error('usage: node analyze-dsh-session.mjs <session.jsonl>'); process.exit(1) }

const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
const turns = new Map()
let currentTurn = null
let title = null

function turnOf(t) {
  if (!turns.has(t)) turns.set(t, {
    turn: t, reasoning: [], firstLines: [], texts: 0, toolCalls: 0,
    we: 0, letMe: 0, lets: 0, i: 0, im: 0, ill: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0,
  })
  return turns.get(t)
}

function countWords(text, stats) {
  for (const m of text.matchAll(/\bwe\b/gi)) stats.we++
  for (const m of text.matchAll(/\blet me\b/gi)) stats.letMe++
  for (const m of text.matchAll(/\blet's\b/gi)) stats.lets++
  for (const m of text.matchAll(/\bI\b|\bI'm\b|\bI'll\b/gi)) stats.i++
  for (const m of text.matchAll(/\bI'm\b/gi)) stats.im++
  for (const m of text.matchAll(/\bI'll\b/gi)) stats.ill++
}

function firstLineFamily(text) {
  const first = text.split('\n')[0].trim()
  if (/^we\b/i.test(first)) return 'we'
  if (/^let me\b/i.test(first)) return 'let me'
  if (/^let's\b/i.test(first)) return "let's"
  if (/^i\b|^i'/i.test(first)) return 'I'
  return 'other'
}

for (const line of lines) {
  let j
  try { j = JSON.parse(line) } catch { continue }
  const t = j.type
  if (t === 'session/title' && j.data?.title) title = j.data.title
  if (t === 'turn/start') { currentTurn = j.data?.turn; continue }
  if (t === 'turn/end') { currentTurn = null; continue }
  if (t === 'tool/call') {
    if (currentTurn != null) turnOf(currentTurn).toolCalls++
    continue
  }
  if (t === 'assistant/message') {
    const turn = j.data?.turn ?? currentTurn
    if (turn == null) continue
    const st = turnOf(turn)
    const content = j.data?.message?.content ?? []
    for (const part of content) {
      if (part?.type === 'reasoning' && typeof part.text === 'string' && part.text.trim()) {
        st.reasoning.push(part.text.trim())
        st.firstLines.push(firstLineFamily(part.text))
        countWords(part.text, st)
      }
      if (part?.type === 'text' && typeof part.text === 'string' && part.text.trim()) st.texts++
    }
    if (j.usage) {
      st.inputTokens += j.usage.inputTokens ?? 0
      st.outputTokens += j.usage.outputTokens ?? 0
      st.cacheReadTokens += j.usage.cacheReadTokens ?? 0
      st.reasoningTokens += j.usage.reasoningTokens ?? 0
    }
  }
}

console.log(`file: ${file}`)
console.log(`title: ${title ?? '(none)'}`)
console.log('')
console.log('turn blocks p50 we letMe lets I Im Ill texts tools in out cache reason')
for (const st of [...turns.values()].sort((a, b) => a.turn - b.turn)) {
  const len = st.reasoning.map(x => x.length).sort((a, b) => a - b)
  const p50 = len.length ? len[Math.floor(len.length / 2)] : 0
  const fl = {}
  for (const x of st.firstLines) fl[x] = (fl[x] ?? 0) + 1
  console.log(`${String(st.turn).padEnd(4)} ${String(st.reasoning.length).padEnd(6)} ${String(p50).padEnd(4)} ${String(st.we).padEnd(3)} ${String(st.letMe).padEnd(6)} ${String(st.lets).padEnd(5)} ${String(st.i).padEnd(3)} ${String(st.im).padEnd(3)} ${String(st.ill).padEnd(4)} ${String(st.texts).padEnd(5)} ${String(st.toolCalls).padEnd(5)} ${st.inputTokens} ${st.outputTokens} ${st.cacheReadTokens} ${st.reasoningTokens} firstLines=${JSON.stringify(fl)}`)
}
