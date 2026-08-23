# 对话记忆储存逻辑（MEMORY）

本文档定义 raft-dsh-bridge 的 agent 对话记忆储存规则。目标是对齐 Raft builtin
原生的记忆逻辑：**原始对话与长期记忆分离，`MEMORY.md` 是跨会话、跨频道的恢复入口。**

## 1. 存储分层

| 层 | 位置 | 内容 | 写者 |
|---|---|---|---|
| Raft 原始对话 | `<SLOCK_ROOT>/agents/<agent-id>/.builtin-sessions/*.jsonl` | Raft UI 可见的 assistant `thinking` / `text` | Raft builtin runtime |
| DSH 完整轨迹 | `<DSH_HOME>/sessions/<cwd-slug>/<session-id>/session.jsonl.zstd` | 完整 `turn/*`、`assistant/chunk`、`tool/call`、`tool/result` | DSH |
| 长期记忆 | `<agent-workspace>/MEMORY.md` 与 `notes/` | 索引、Active Context、频道/工作/偏好/领域笔记 | agent（通过文件工具） |

桥接后 Raft 侧只保存 DSH 返回的 reasoning 与最终文本；工具执行过程只存在于
DSH 侧。长期记忆文件位于 Raft agent workspace，因此 Raft 原生、DSH 会话、
bridge 三方看到的是同一套文件。

## 2. Raft 原生的记忆逻辑（对齐依据）

Raft builtin system prompt 规定的记忆模型：

### 2.1 MEMORY.md 模板

```markdown
# <Agent Name>

## Role
<角色定义，随协作不断演化>

## Key Knowledge
- Read notes/user-preferences.md for user preferences and conventions
- Read notes/channels.md for channel purposes and ongoing work
- Read notes/work-log.md for important decisions and completed work
- Read notes/<domain>.md for domain-specific knowledge

## Active Context
- Currently working on: <简短说明>
- Last interaction: <简短说明>
```

### 2.2 需要主动记忆的内容

1. **用户偏好**：沟通风格、编码规范、工具偏好、重复出现的请求模式。
2. **项目/世界上下文**：项目结构、技术栈、架构决策、团队约定、部署模式。
3. **领域知识**：术语、约定、最佳实践。
4. **工作历史**：已完成事项、决策与原因、成功/失败方案。
5. **频道上下文**：每个频道是什么、谁参与、在讨论什么、进行中的任务。
6. **其他 agent**：职责、专长、协作方式。

### 2.3 文件组织

```
<agent-workspace>/
  MEMORY.md                  # 总索引 + Active Context
  notes/
    user-preferences.md
    channels.md              # 每频道一个 section
    work-log.md
    <domain>.md              # 领域笔记，按需创建
```

### 2.4 压缩安全规则

- 上下文会被周期性压缩，压缩后 `MEMORY.md` 一定被重新读取。
- `MEMORY.md` 必须自包含：读完就能知道“我是谁、我知道什么、我正在做什么”。
- 长任务开始前写 `Active Context`。
- 任务完成后更新相关 notes 与 `MEMORY.md` 索引。

## 3. 多频道记忆规则

同一 agent 可能在多个频道工作。为避免频道上下文串线，规定：

### 3.1 `notes/channels.md` 每频道一节

```markdown
## #<channel-name>
- purpose: <频道用途>
- members: <主要成员>
- status: active / waiting / archived
- ongoing tasks: <任务号或主题>
- latest decision: <最近结论>
- last message: <seq 或 thread id，可选>
```

### 3.2 更新时机

1. 第一次进入新频道；
2. 频道任务状态变化；
3. 长任务开始前；
4. 任务完成后；
5. 上下文压缩后重新读取。

### 3.3 原则

- 一个频道一条轨迹，不与任务正文混写；
- `MEMORY.md` 只保存频道索引与 Active Context，不复制完整聊天；
- 归档频道保留结论，不清空历史。

## 4. bridge 中的实现

`scripts/raft-dsh-bridge.mjs` 新增 `MEMORY_POLICY`：

| 值 | 行为 |
|---|---|
| `raft`（默认） | 每条转发的 Raft 事件前注入对齐 Raft 原生的记忆策略块 |
| `off` | 不注入 |

注入的策略块：

```text
[Memory policy - aligned with Raft builtin]
- MEMORY.md is the index and recovery point; keep it scan-friendly.
- notes/channels.md: one section per channel
  (name, purpose, members, ongoing tasks, latest decision).
- notes/work-log.md: important decisions and completed work;
  notes/user-preferences.md and notes/<domain>.md as needed.
- Before a long task, write a brief Active Context into MEMORY.md;
  after completing work, update the relevant note and MEMORY.md index.
- If context was compacted or you resume mid-task,
  re-read MEMORY.md and the relevant notes before acting.
```

DSH 会话 cwd 是 Raft agent workspace，因此 agent 用文件工具读写上述文件即可，
无需额外存储服务。

## 5. 隐私

本仓库只公开规则与聚合结果；不公开任何原始思维链、`MEMORY.md` 内容、
频道名、绝对路径或 API key。部署环境的记忆文件属于用户私有数据。

## 6. 未来可选增强（暂未实现）

- 控制台按 turn 自动生成 work-log 摘要；
- 自动维护频道清单与最后消息 seq；
- 在 DSH 压缩事件后强制注入“重新读取 MEMORY.md”。

当前版本刻意保持与 Raft 原生一致的“模型自律式记忆”，避免双写冲突。
