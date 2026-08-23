# Token 消耗与额外开销（COST）

## 结论

- bridge 自身不发起任何模型调用，不增加模型 API 的“每一 token”单价。
- 额外 token 只有：每次真实 Raft 事件转发时前置的固定上下文块（实测约
  0.6–0.8 KB，中文模型下粗估 150–250 tokens/次）。
- `anchored-standard` 没有合成锚定调用；`zero-anchored-standard` 每个新 DSH
  会话多 1 次锚定模型调用（本仓库默认使用 anchored-standard）。
- Raft 自己的历史不会重复进入 DSH，所以不会按 Raft 历史长度重复计费。

## 开销拆解

| 来源 | 是否额外消耗 | 说明 |
|---|---|---|
| bridge 本地 SSE/HTTP | 否 | 不经过模型 |
| 固定 Raft 上下文块 | 是，很小 | 每条真实事件约 150–250 tokens |
| 脚本化 Start/空回复 | 否 | 不调用模型 |
| zero-anchored 锚定轮 | 是 | 每次新 DSH 会话 +1 请求 |
| 重复 inbox notice | 已消除 | `DEDUP_NOTICES` 只转发一次 |
| Raft 历史消息 | 否 | bridge 丢弃 Raft 侧历史，只取最后事件 |
| DSH 工具结果回传 | 是，主要成本 | 工具输出留在 DSH 上下文并参与 cache read |
| DSH reasoning 回流 Raft | 否 | 只走本地网络/UI |

## 实测量级（本实验环境）

### zero-anchored 会话（4 turns，16 steps，短任务/通知轮）

| 指标 | 值 |
|---|---|
| uncached input | 16,213 tokens |
| output | 3,713 tokens |
| cache read | 252,416 tokens |

### anchored-standard 会话（收口时 4 turns，104 steps；含一个运行中的长任务 turn）

| 指标 | 值 |
|---|---|
| uncached input | 121,616 tokens |
| output | 86,288 tokens |
| cache read | 11,311,744 tokens |

说明：anchored 会话的 cache read 高，主要是长任务中反复读取大型工具结果
（磁盘目录清单、文件清单、命令输出）进入上下文缓存。这是长 agent 任务的
正常成本，不是 bridge 引入的协议开销。DSH preset 自带 compaction 与
tool-result pruner；如要降本，优先调这两项，而不是换 bridge。

## 降本建议

1. 保持 `anchored-standard`，避免 zero-anchored 的 +1 调用。
2. 保持 `DEDUP_NOTICES=1`。
3. 对超大命令输出优先 `head/tail`、`du -sh` 而不是全量 `find`。
4. 定期 `session.compact` 或依赖 DSH preset 的 compaction epoch。
5. 对 Raft 侧：Raft 只保存 DSH 的最终回复与 reasoning，不保存 DSH 工具过程，
   Raft 本地上下文增长也小于原生工具循环。
