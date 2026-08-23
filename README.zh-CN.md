# raft-dsh-bridge

> 语言：**中文** · [English（README.md）](README.md)

让 Raft（Slock）builtin agent 直接与 DeepSeek Harness（DSH）会话对话，
从而把模型请求的首请求条件从“Raft 固定 4 工具 + 强注入”改写成 DSH 的
`anchored-standard` 预设（Minimal 双工具 bootstrap + 默认拒绝自动注入）。

社区研究项目，不是 Raft/Slock 或 DeepSeek 官方产品。

## 为什么需要桥

Raft builtin 运行时没有 system prompt / 工具目录 / 扩展配置入口，且
收件箱通知轮前置。直接改 baseUrl 只能到 OpenAI 兼容端点，而 DSH web
提供的是 Agent/会话 API（`/api/*`），不是 `/chat/completions`。
本仓库在两者之间做协议适配。

```
Raft builtin --/chat/completions--> raft-dsh-bridge
                                      |  session.create/prompt
                                      v
                                 DSH web (anchored-standard)
                                      |  mux WS: reasoning/text/tool events
                                      v
                             api.deepseek.com
```

Raft 只负责：触发平台事件、显示 DSH 的 `reasoning_content` 与最终回复、
落盘会话。真正的工具执行在 DSH 会话内完成；DSH 通过自动发现的
`raft.ps1` wrapper 调用 Raft 平台命令。

## 实验结果摘要

| 条件 | let me / 任务 | we（锚定/长任务 turn） |
|---|---:|---:|
| Raft 原生长任务（历史基线） | 6–31 | 低 |
| 桥接 zero-anchored（短任务） | 2 | 0 |
| **桥接 anchored-standard（3 个真实长任务 turn）** | **0** | **326** |

详细数据、指标口径与隐私说明见：

- [docs/RESULTS.md](docs/RESULTS.md)
- [docs/EXPERIMENT.md](docs/EXPERIMENT.md)
- [docs/METHOD.md](docs/METHOD.md)
- [docs/PROCESS.md](docs/PROCESS.md)
- [docs/COST.md](docs/COST.md)
- [docs/MEMORY.md](docs/MEMORY.md)
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## 前置

- Raft computer（builtin runtime），且已拿到受试 agent id。
- DSH web 运行中，并已安装 `anchored-standard` 预设。
- Node.js ≥ 22。
- DeepSeek API key 已在 DSH 侧配置。

## 本地网页控制台（推荐）

```bash
npm run console
# 打开 http://127.0.0.1:8970
```

控制台功能：

- 自动扫描所有 builtin agent，只显示 Raft 中的 agent 名称；
- 每个 agent 一键接入 / 断开 / 恢复；
- 显示 Raft 中该 agent 的当前模型与推理深度；
- 实时显示 DSH turn 状态与最近 1–2 行思考内容；
- 显示首 token 平均耗时、解码 tok/s、缓存命中率、累计输入 token；
- v4 Pro 默认 `anchored-standard`，所有 reasoning effort 跟随 Raft；
- Flash 默认直连官方 API。

接入 / 断开会写 Raft 的 `models-store.json`，控制台会要求 Raft 处于退出状态。
网页不再提供单独覆盖模型策略的控件；已有
`~/.raft-dsh-console/config.json` 中的策略仍被兼容读取。

无 PowerShell 的自检/启停：

```bash
node scripts/console-ctl.mjs status
node scripts/console-ctl.mjs stop
node scripts/console-ctl.mjs start
node scripts/console-ctl.mjs restart
```

桥在复制 `raft.ps1` 时会自动注入 `[Console]::InputEncoding = $utf8NoBom`，避免中文消息经 PowerShell 5.1 的 stdin 管道被按系统 ANSI/GBK 解码成乱码。

## 快速开始（命令行）

### 1. 启动桥

PowerShell：

```powershell
$env:DSH_BASE = "http://127.0.0.1:3080"
$env:DSH_PRESET = "anchored-standard"
$env:DSH_CWD = "C:\Users\<you>\.slock\agents\<agent-id>"   # Raft agent workspace
$env:RAFT_AGENT_ID = "<agent-id>"
$env:BRIDGE_PORT = "8899"
node scripts/raft-dsh-bridge.mjs
```

Bash：

```bash
DSH_BASE=http://127.0.0.1:3080 \
DSH_PRESET=anchored-standard \
DSH_CWD="$HOME/.slock/agents/<agent-id>" \
RAFT_AGENT_ID=<agent-id> \
BRIDGE_PORT=8899 \
node scripts/raft-dsh-bridge.mjs
```

自检：

```bash
curl http://127.0.0.1:8899/__bridge/status
```

### 2. 让 Raft 指向桥

**先完全退出 Raft**，然后：

```bash
node scripts/point-raft-to-bridge.mjs --port 8899
```

需要环境变量 `RAFT_AGENT_ID`（`SLOCK_ROOT` 默认 `<home>/.slock`）。
脚本会备份 `models-store.json.bridge.bak`。

### 3. 重启 Raft

Raft 会照常发送 `/chat/completions`。裸 `Start.` 轮由桥本地回复 `Ready.`
（零模型调用）；第一条真实平台事件才会创建/续用 DSH 会话并进入模型。

### 4. 回滚

```bash
# 先退出 Raft
node scripts/restore-raft-endpoint.mjs
# 再重启 Raft；桥可停可不停
```

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `BRIDGE_PORT` | `8899` | Raft 看到的 OpenAI 端点端口 |
| `DSH_BASE` | `http://127.0.0.1:3080` | DSH web 地址 |
| `DSH_PRESET` | `anchored-standard` | 会话预设 |
| `DSH_CWD` | 无（必填） | DSH 会话 cwd，通常为 Raft agent workspace |
| `RAFT_AGENT_ID` | 无（建议填） | 用于自动发现 raft.ps1 |
| `SLOCK_ROOT` | `<home>/.slock` | Slock home |
| `BRIDGE_DATA_DIR` | `<home>/.raft-dsh-bridge` | 日志 / 状态 / CLI 副本 |
| `TURN_TIMEOUT_MS` | `7200000` | turn 上限；turn 内有事件会自动续期 |
| `DEDUP_NOTICES` | `1` | 相同 Raft inbox notice 只转发一次 |
| `MEMORY_POLICY` | `raft` | 注入对齐 Raft 原生的记忆策略；`off` 关闭 |
| `AUTO_APPROVE` | `1` | 自动批准 DSH 工具审批 |
| `AUTO_ANSWER_QUESTIONS` | `1` | 自动选 ask_user_question 第一选项 |
| `DRY_RUN` | `0` | `1` 时只验证格式，不调用模型 |

## 管理端点

- `GET /__bridge/status`：会话 id、预设、cwd、busy、wrapper 状态。
- `POST /__bridge/reset`：丢弃当前 DSH 会话绑定；下一次 Raft 重置或 Start 会新建。
- `GET /models`、`GET /v1/models`：给 Raft 模型发现的占位响应。

## Token 消耗

bridge 不产生模型调用，主要额外成本是每条真实事件前置的约 0.6–0.8 KB
Raft 上下文块。anchored-standard 无合成锚定调用；重复通知已被去重。
长任务主要成本来自 DSH 工具结果的 cache read，属于 agent 正常开销。
详见 [docs/COST.md](docs/COST.md)。

## 已知限制

1. **v1：DSH 当脑，DSH 也当手**。Raft 原生工具 UI 不再出现；任务由 DSH 的
   bash/pwsh/editor 执行，Raft 平台操作走 `raft.ps1`。
2. 一次 Raft 模型请求横跨整个 DSH turn；桥用 SSE 心跳保活。
3. 同一桥进程同时只服务一个 DSH turn；并发请求返回 409。
4. `raft.ps1` 自动发现依赖 Raft 在 turn 启动时生成 wrapper；若 wrapper 缺失，
   DSH 将无法使用 Raft CLI（bridge 日志会提示）。
5. 若需要保留 Raft 原生工具循环，需要 v2：在 DSH 内注册 Raft 工具的 executor
   回执通道（本仓库未实现）。

## 测试

```bash
npm install
npm run check   # 语法检查
npm test        # 零模型调用的 mock 端到端 smoke
```

## 目录

```
console/
  manager.mjs                本地网页控制台
  web/index.html             控制台页面
scripts/
  raft-dsh-bridge.mjs       核心桥
  console-ctl.mjs           控制台启停/自检（无 PowerShell）
  point-raft-to-bridge.mjs  修改 Raft models-store
  restore-raft-endpoint.mjs 回滚 models-store
  mock-dsh.mjs              零成本 mock DSH
  analyze-dsh-session.mjs   轨迹指纹聚合
  fetch-dsh-usage.mjs       DSH usage 抓取
test/
  smoke.test.mjs            端到端 smoke
docs/                       架构 / 实验 / 结果 / 成本 / 过程
```

## 隐私

仓库只公开脚本、聚合指标与任务类别；原始思维链、绝对路径、频道名、
system prompt、API key 一律不公开。分析后立即删除会话导出。

## License

MIT，见 [LICENSE](LICENSE)。见 [NOTICE](NOTICE) 的商标/归属说明。
