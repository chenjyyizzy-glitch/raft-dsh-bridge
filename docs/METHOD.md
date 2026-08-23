# 轨迹指纹统计方法（METHOD）

口径对齐 [DEEPSEEK_V4_TRAJECTORY_ANALYSIS_20260814.md](https://github.com/lscatfish/modeltest/blob/main/docs/v4.1/DEEPSEEK_V4_TRAJECTORY_ANALYSIS_20260814.md)。

## 数据来源

- DSH 会话导出：`GET /api/session.export?sessionId=<id>`（ZIP，内含 `session.jsonl`）。
- 只统计**完成态 `assistant/message`** 中的 `reasoning` / `text` / `tool-call` 块；
  不统计 `assistant/chunk` 流式增量，避免重复计算。
- `tool/call` 事件数 = 工具调用次数。

## 指标定义

| 指标 | 定义 |
|---|---|
| reasoning 块 | `assistant/message.content` 中 `type:"reasoning"` 且非空的条目数 |
| p50 字符 | 全部 reasoning 块字符数的中位数 |
| we / let me / let's / I | reasoning 全文词频，大小写不敏感、词边界匹配；`I` 含 `I'm`、`I'll` |
| 首行风格 | 块首行以 we / let me / let's / I 开头的块数（辅助口径） |
| 阶段回复 | `assistant/message` 中非空 `text` 块数量 |
| 工具调用 | `tool/call` 事件数 |
| token 用量 | DSH `session.list` 投影中的 `tokenUsage`（uncached input / output / cache read） |

## 工具

```bash
# 会话级指纹（无需 API key）
node scripts/analyze-dsh-session.mjs <session.jsonl>

# 尝试从 history API 逐 turn 读取 usage（live 会话可能不带 usage 字段）
node scripts/fetch-dsh-usage.mjs <sessionId> [DSH_BASE]
```

## 已知偏差

- 不同 harness 的消息切分不一致；本口径用于轨迹画像，不直接评价 token 效率。
- 桥接场景中，`user/message` 里包含固定 Raft 上下文块；它不属于模型原生任务文本，
  统计时未剔除，对 we/let me 词频影响可忽略（该块是命令式说明，不含第一人称叙事）。
- DSH live history 的 `assistant/message` 可能不携带 `usage`；token 用量以
  `session.list` 投影为准。

## 隐私

- 仓库只公开聚合指纹与脚本；原始思维链、绝对路径、system prompt、频道名、任务正文
  一律不进入仓库。
- 分析完导出后立即删除原始 `session.jsonl` / ZIP。
