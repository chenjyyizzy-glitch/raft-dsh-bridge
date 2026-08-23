# 架构与工作方式（ARCHITECTURE）

## 组件

```
Raft builtin runtime
  |  POST /chat/completions (OpenAI/DeepSeek 方言, stream=true, 4 tools)
  v
raft-dsh-bridge (本仓库脚本)
  |  session.create / session.prompt / session.selectModel
  v
DeepSeek Harness web (127.0.0.1:3080, anchored-standard preset)
  |  /api/events.mux (WebSocket)
  |  -> turn/start, assistant/chunk, assistant/message, tool/call, turn/end
  v
api.deepseek.com (DeepSeek 官方 API)
```

## 数据流

1. Raft 发送模型请求；bridge 只读取最后一条 `user` 文本，忽略 Raft 自己的
   完整历史（该历史只属于 Raft 本地状态，不重复计费）。
2. 裸 `Start.` 轮由 bridge 本地回复 `Ready.`，不调用模型。
3. 真实平台事件被包上固定 Raft 上下文块后，以 `session.prompt` 送入 DSH 会话。
4. DSH preset 组装真正的模型请求：anchored-standard 首请求只暴露 Minimal 双工具、
   默认拒绝自动注入；首个 durable 事件后提升到 resident 目录。
5. DSH 执行自己的工具；模型产生的 `reasoning_content` 与最终 `text` 经 mux WS
   实时映射成 DeepSeek 风格 SSE 返回 Raft。
6. Raft 平台操作（收件箱/消息/任务）由 DSH 通过自动发现的 `raft.ps1` wrapper 调用。

## 关键设计

- **会话持久化**：DSH session id 存在 `<BRIDGE_DATA_DIR>/dsh-session.json`，
  bridge 重启后续接同一 DSH 会话；Raft 重置会话（新 `Start.`）才新建。
- **raft.ps1 自动发现**：扫描 `<SLOCK_ROOT>/cli-transport/<agent-id>/*/raft.ps1`，
  选择 mtime 最新者复制到稳定路径。Raft 重启后 wrapper 端口会轮换，下一条
  消息自动刷新。
- **notice 去重**：完全相同的 `[Slock inbox ...` 文本只转发一次。
- **超时策略**：默认 120 分钟；turn 内收到任何 DSH 事件都续期。超时只结束
  Raft 侧 HTTP 流，不调用 `session.cancel`，避免误杀长任务。
- **审批/提问**：默认自动批准工具审批并选择 `ask_user_question` 第一选项；
  可通过 `AUTO_APPROVE=0` / `AUTO_ANSWER_QUESTIONS=0` 关闭。
- **SSE 保活**：工具执行期间每 10 秒发送 SSE 注释 `: keep-alive`。

## 为什么不用 DSH 端口直接当 baseUrl

DSH web 是 Agent/会话 API（`/api/*`），不是 OpenAI `/chat/completions` 端点。
必须有一个协议适配层；本仓库的 bridge 就是这一层。
