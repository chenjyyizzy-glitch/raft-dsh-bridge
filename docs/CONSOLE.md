# 本地网页控制台（CONSOLE）

`console/manager.mjs` 是面向日常使用的本地网页控制台，绑定
`127.0.0.1:8970`，不注册开机自启。

## 页面内容

- 每张 agent 卡片只显示 **Raft 中的 agent 名称**（不显示 id/代码），
  名称以 Raft API 为准，API 不可用时回退到 `raft-computer runners list`；
- 卡片显示 Raft 中该 agent 的 **当前模型 + 推理深度**，不再展示
  Pro/Flash 每模型覆盖策略；
- 实时思考状态：控制台直接连接 DSH `events.mux`，显示当前阶段
  （空闲/思考/输出/工具/继续）与最近 1–2 行思考内容（最多保留 240 字符）；
- token 统计：首 token 平均耗时、解码 tok/s、缓存命中率、累计输入 token，
  数据来自 DSH `session.list` 的 projections（约 15 秒刷新一次）；
- “本地服务”卡：可按本机配置命令启动/停止 DSH 与 Raft；
- 接入/断开按钮：写 Raft `models-store.json` 前检测 Raft 是否运行；
  运行中拒绝写，需要先退出 Raft。

## 模型策略（内部默认）

网页不再提供单独覆盖模型策略的控件。桥内部仍按以下默认策略工作：

- `deepseek-v4-pro`：DSH `anchored-standard` 预设，`effort=follow`；
- `deepseek-v4-flash`：直连官方 API；
- 已有的 `~/.raft-dsh-console/config.json` 策略仍会被兼容读取。

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/state` | 全量状态（agent 名称/模型/推理深度/实时思考/token 统计） |
| POST | `/api/system/dsh/start` / `stop` | 按本机配置命令启动/停止 DSH |
| POST | `/api/system/raft/start` / `stop` | 按本机配置命令启动/停止 Raft |
| POST | `/api/agents/:id/connect` | 启动桥 + 按默认策略写 models-store |
| POST | `/api/agents/:id/disconnect` | 停桥 + 恢复备份 |

以下策略接口保留但网页不再使用：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/presets` | DSH presets / effort 列表 |
| PUT | `/api/global-policy` | 更新全局默认模型策略 |
| PUT | `/api/agents/:id/policy` | 更新单 agent 模型策略（记忆） |

## 数据目录


```

~/.raft-dsh-console/
  config.json
  agents/<agent-id>/
    bridge.out.log
    bridge.err.log
    dsh-session.json
    cli/raft.ps1
```


- `raft.ps1` 包装器已强制 stdin UTF-8：agent 用 `message send` 管道发送中文时，不会再被 PowerShell 5.1 按系统 ANSI(GBK) 解码成乱码。
## 备注


- Raft agent 改名后，控制台最长 15 秒内更新显示；
- 控制台状态查询不会泄露完整思维链，思考 tail 只保留最后 240 个字符；
- `scripts/console-ctl.mjs status` 提供无 PowerShell 的本地自检。
