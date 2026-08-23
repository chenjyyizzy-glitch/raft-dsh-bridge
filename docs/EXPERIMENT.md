# 实验设计（EXPERIMENT）

## 1. 背景与假设

Raft（Slock）builtin 运行时固定给模型发送：

- 固定 4 个工具（read / bash / edit / write）；
- 41KB 级 system prompt 与 MEMORY 强注入；
- 收件箱通知轮前置。

先前的 wire relay 与二进制等长补丁都无法改变这些首请求条件，长任务轨迹
`let me = 6–31/任务`，未复刻 DSH minimal/anchored 指纹。

DSH 的 `anchored-standard` preset 在首请求暴露 Minimal 双工具、抑制自动注入，
并在首个 durable 事件后提升到 resident 工具目录。

**H1（机制）**：若 Raft 的模型请求不直接发生，而是被桥接到一个 DSH 会话，
则真正进入模型的请求由 DSH 组装，轨迹指纹应迁移到 we 主导 / let me 极少。
**H2（预设选择）**：在真实多频道场景中，`anchored-standard` 的首个真实事件
锚定比 `zero-anchored-standard` 的固定锚定轮更稳，因为后者可能先锚在平台通知上。

## 2. 环境

| 项 | 值 |
|---|---|
| Raft | builtin runtime 1.0.15，单 agent，模型 `deepseek-v4-pro` |
| DSH | 0.1.0-rc.7（source checkout），web API + mux WS |
| DSH presets | `zero-anchored-standard`、`anchored-standard` |
| 桥 | Node.js ≥ 22，无运行时依赖 |
| 模型 | `deepseek-v4-pro`，`reasoningEffort=max`，thinkingFormat=deepseek |
| 观测 | bridge 日志 + DSH session export + `session.list` token 投影 |

## 3. 任务

1. **smoke**：收件箱通知 → 读取消息 → 回复固定 token。
2. **短任务 retest**：在指定目录写文件并回复固定 token。
3. **真实长任务 A**：审计磁盘并只清理安全白名单（缓存/日志/临时文件/旧备份/
   可再生缓存），写报告并回报。
4. **真实长任务 B**：检查两批模型实验运行状态、复核结果并输出结论到频道线程。

任务 B 的领域细节不进入公开仓库；只保留 turn 级聚合指纹。

## 4. 判定标准

- **主判定**：已完成任务 turn 全文 `let me ≤ 2`，且首行 let me ≤ 1。
- **轨迹判定（弱证据）**：we 明显高于 I/let me；阶段回复 ≤ 2/turn。
- **质量判定**：任务客观交付（磁盘释放量、报告文件、频道回报、运行产物）。
- **对照**：Raft 原生历史基线 6–31/任务；DSH minimal/anchored 公开数据 0–1。

## 5. 流程

```
1. 安装 DSH preset（本仓库假定已安装 anchored-standard）。
2. 启动 bridge，确认 /__bridge/status 返回预设与会话信息。
3. 将 Raft 受试 agent 的 models-store baseUrl 指向 bridge。
4. 重启 Raft；由真实频道消息触发 agent。
5. bridge 创建/复用 DSH 会话并转发首个真实事件。
6. turn 结束后导出 DSH session，运行 analyze-dsh-session.mjs。
7. 记录聚合指纹、token 投影与客观交付，删除原始导出。
```

## 6. 记录与复现

- 每轮结果只记录聚合表、任务类别与交付结论；不记录原始思维链。
- 复现需要：Raft computer、DSH web、DeepSeek API、Windows 或类 Unix 主机。
- 一次性冒烟测试（零模型调用）：`npm test`。
