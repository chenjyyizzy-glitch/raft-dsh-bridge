# 过程记录（PROCESS）

按时间顺序记录关键迭代，作为“思考过程”的公开部分。

## 1. 扩展注入（失败）

假设 Raft 内嵌 Pi 运行时会加载扩展。放置探针扩展后重启，零日志输出。
结论：builtin 运行时是精简 fork，不加载扩展。

## 2. wire relay 锚定（机制通，效果不稳）

在 Raft 与 DeepSeek API 之间加透传 relay，首请求剥 tools 并插入锚定消息。
Raft 的请求条件被观测为固定 4 工具、max_tokens=384000。
问题：收件箱通知轮总在真实任务前发生，锚定无法稳定落在任务轮。

## 3. exe 等长文本补丁（首行锚定成功，全文未达标）

把启动序列第 3 步改写成零工具 "We need…" 锚定轮。机制复现成功，
但长任务全文 `let me=6–31`。原因定位：首请求条件（4 工具、通知前置、
MEMORY 注入）是根因，文本补丁无法改变。已回滚。

## 4. DSH bridge v1（zero-anchored）

用 DSH web API 驱动 DSH 会话，Raft 只做 UI/通知宿主：
- `session.create(agentPreset)` → `session.prompt` → mux WS → OpenAI SSE 回流。
- Start 轮本地回复，避免污染锚定；raft.ps1 自动发现并注入上下文。
- smoke 全链路通过。

观察：锚定轮干净，但平台通知轮仍有 let me=10；任务轮 let me=2。

## 5. 切到 anchored-standard + 真实长任务

- 预设改为 `anchored-standard`：首个真实事件以 Minimal 双工具进入。
- 真实长任务（磁盘审计清理）释放 20.28 GB，全程 50 次工具调用、
  29 个 reasoning 块，we=152、let me=0。
- 收尾与后续任务 turn 同样 let me=0。

## 6. 工程加固

- **重复通知去重**：`DEDUP_NOTICES=1`，相同 inbox notice 只投喂一次。
- **长 turn 超时**：默认 120 分钟；turn 内每收到事件续期。
- **超时不再 cancel DSH**：只结束 Raft 侧 HTTP 响应，避免长任务被误杀。
- **日志递归提取**：工具结果支持嵌套文本。
- **一键 bat**：本地部署提供连接/回滚脚本（模板见 `scripts/windows`）。

## 教训

1. 首请求条件是轨迹选择的根因，wire 层改写不充分。
2. 平台通知轮是真实场景的主要扰动，不是任务本身。
3. anchored-standard 的“真实首事件锚定”天然适配多频道。
4. 长任务必须按活动续期，不能只设绝对超时。
5. 发布前必须清洗默认路径、token、频道名与原始思维链。
