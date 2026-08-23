# 实验结果（RESULTS）

样本量小，结论为探索性证据。环境与协议见 [EXPERIMENT.md](EXPERIMENT.md)。

## 主结果：anchored-standard 是更适合桥接场景的预设

| session | preset | 已完成 turn | 说明 |
|---|---|---|---|
| A | zero-anchored-standard | 4 | 通知轮 + 短任务 smoke/retest |
| B | anchored-standard | 3（另有 1 个长任务 turn 在收口时仍在运行） | 真实长任务：磁盘治理 + 收尾 + 气象结果复核 |

### Session A — zero-anchored-standard

| turn | 内容 | blocks | p50 | we | let me | let's | I | 阶段回复 | 工具 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 固定零工具锚定轮 | 1 | 372 | 5 | 0 | 0 | 0 | 1 | 0 |
| 2 | Raft 收件箱通知（首次 smoke） | 7 | 311 | 1 | 10 | 1 | 10 | 7 | 9 |
| 3 | 重复通知处理 | 2 | 410 | 0 | 1 | 0 | 2 | 2 | 2 |
| 4 | 短任务 retest | 4 | 301 | 0 | 2 | 1 | 1 | 5 | 4 |

- 全 session token：uncached input 16,213 / output 3,713 / cache read 252,416。
- 观察：锚定轮本身干净（we=5, let me=0），但 Raft 的平台通知轮会把轨迹拉回
  I/let me 形态；任务轮比通知轮更接近目标轨迹。

### Session B — anchored-standard

| turn | 内容 | blocks | p50 | we | let me | let's | I | 阶段回复 | 工具 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 真实长任务：磁盘空间审计与白名单清理（30 步） | 29 | 1347 | 152 | 0 | 100 | 19 | 0 | 50 |
| 2 | 任务收尾：补报告、复核释放量、频道回报 | 31 | 529 | 70 | 0 | 67 | 3 | 1 | 34 |
| 3 | 真实任务：检查两批模型实验并输出结论（21 步） | 20 | 679 | 104 | 0 | 52 | 0 | 1 | 21 |
| 合计 | | 80 | | 326 | 0 | 219 | 22 | 2 | 105 |

- 三个 turn 覆盖三个不同功能域，**全程 let me = 0**；首行 let me = 0；
  可见阶段回复合计仅 2 次。
- 收口时 session 投影 token（含仍在运行的第 4 个 turn）：uncached input 121,616 /
  output 86,288 / cache read 11,311,744。
- 第 1 个 turn 实际效果：目标磁盘可用空间 10.30 GB → 30.58 GB（释放 20.28 GB），
  仅删除缓存/日志/临时文件/旧备份/可再生缓存白名单。

## 对照基线

| 条件 | let me / 任务 | 说明 |
|---|---:|---|
| Raft 原生长任务（历史实验） | 6–31 | 固定 4 工具 + 通知轮 + 强 MEMORY 注入 |
| DSH minimal / anchored（modeltest Project2） | 0–1 | 官方/两阶段锚定 |
| 本桥接 zero-anchored（短任务） | 2 | 通知轮仍会扰动 |
| **本桥接 anchored-standard（真实长任务）** | **0** | 3/3 turn |

## 结论

1. 机制成立：让 Raft agent 直接与 DSH 会话对接，能把模型请求的首请求条件从
   Raft 固定 4 工具改写成 DSH 的 Minimal 双工具 + 默认拒绝注入。
2. anchored-standard 比 zero-anchored-standard 更适合真实多频道场景：
   首个真实平台事件就是锚定轮，不再被通知轮抢走；任务轮持续 we 主导、零 let me。
3. 重复平台通知是主要扰动源；`DEDUP_NOTICES` 去重后该问题被工程化消除。
4. 小样本诚实：以上为 n=1 会话内的 turn 级观察，不是多会话 A/B。
