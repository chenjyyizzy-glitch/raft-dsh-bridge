# raft-dsh-bridge

> Language: **English** · [中文版（README.zh-CN.md）](README.zh-CN.md)

Bridge a Raft (Slock) builtin agent into a DeepSeek Harness session so the
model's first-request conditions are assembled by the DSH
`anchored-standard` preset (Minimal tool pair bootstrap, default-deny context
injection) instead of Raft's fixed 4-tool surface.

Community research project. Not affiliated with or endorsed by Raft/Slock or
DeepSeek.

```
Raft builtin --/chat/completions--> raft-dsh-bridge
                                      | session.create/prompt
                                      v
                                 DSH web (anchored-standard)
                                      | mux WebSocket
                                      v
                             api.deepseek.com
```

Raft keeps platform events, UI rendering of `reasoning_content`, and final
message persistence. DSH runs the actual agent turn with its own tools and
calls Raft platform commands through an auto-discovered `raft.ps1` wrapper.

## Results at a glance

| condition | let me / task | we (anchored long-task turns) |
|---|---:|---:|
| Raft native long tasks (historical baseline) | 6–31 | low |
| bridged zero-anchored (short task) | 2 | 0 |
| **bridged anchored-standard (3 real long-task turns)** | **0** | **326** |

Details: [docs/RESULTS.md](docs/RESULTS.md), [docs/EXPERIMENT.md](docs/EXPERIMENT.md),
[docs/METHOD.md](docs/METHOD.md), [docs/PROCESS.md](docs/PROCESS.md),
[docs/COST.md](docs/COST.md), [docs/MEMORY.md](docs/MEMORY.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Local web console (recommended)

```bash
npm run console   # http://127.0.0.1:8970
```

Scans builtin agents, shows the Raft agent name / current model / reasoning
effort, a live 1–2 line thinking tail from the DSH event stream, and per-session
token stats. Connect/disconnect buttons require Raft to be stopped because
they rewrite `models-store.json`.

PowerShell-free status/start/stop/restart:

```bash
node scripts/console-ctl.mjs status
node scripts/console-ctl.mjs restart
```

The bridge also hardens the copied `raft.ps1` with
`[Console]::InputEncoding = $utf8NoBom` so UTF-8 piped messages do not get
decoded as the system ANSI code page on Chinese Windows.

## Quick start

Requirements: Raft computer with a builtin agent, DSH web with
`anchored-standard` installed, Node.js >= 22.

```powershell
$env:DSH_BASE = "http://127.0.0.1:3080"
$env:DSH_PRESET = "anchored-standard"
$env:DSH_CWD = "C:\Users\<you>\.slock\agents\<agent-id>"
$env:RAFT_AGENT_ID = "<agent-id>"
$env:BRIDGE_PORT = "8899"
node scripts/raft-dsh-bridge.mjs
```

Stop Raft, point its model endpoint at the bridge, then start Raft again:

```bash
node scripts/point-raft-to-bridge.mjs --port 8899
```

Rollback:

```bash
node scripts/restore-raft-endpoint.mjs
```

Environment variables, admin endpoints, token-cost notes, limitations, and
privacy rules are documented in [README.zh-CN.md](README.zh-CN.md).

## Test

```bash
npm install
npm run check
npm test        # zero model-call mock end-to-end smoke
```

## License

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
