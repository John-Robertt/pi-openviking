# Pi OpenViking 使用说明

## 文档职责

**架构定位**：面向最终用户的唯一说明。

**核心目标**：安装、配置、运行和排查故障所需的全部信息，读者不必了解内部实现即可完成这些事。

**职责边界**：本文只描述用户可见的行为与操作，不描述目标架构、阶段路径、内部数据流和验证方法——
那些分别由 [`docs/spec.md`](./spec.md)、[`docs/roadmap.md`](./roadmap.md)、
[`docs/design.md`](./design.md) 和 [`docs/verification.md`](./verification.md) 维护。
本文随用户可见行为的变化更新。

## 1. 当前行为

扩展从 Pi 会话来源完整记录事件，并在 provider 请求前检索已有 OpenViking 记忆。

持久 session 使用 Pi JSONL；非持久化 session 仅提供进程内 best-effort。记录包含文本、图片、
thinking、tool call/result、真实错误和 aborted 状态、未知 part、custom entry 及 Pi compaction。
扩展不清洗、过滤或截断原始 payload。

已确认事件按 `archive` 预算归入 Archive：一段事件与一份 manifest 原子绑定，可按 `archiveId`
确定性展开回原始事件。每个已提交 Archive 由受管 OpenViking 的 VLM 异步生成结构化 checkpoint；request、
明确 failure 与 checkpoint 都是可重放的追加事件；failure 只保存稳定分类、错误码和通用消息，有效 checkpoint 必须有连续且匹配的 request/failure parent 链。VLM 或网络失败不改变 raw event、ACK 或 Archive。
已消费的 checkpoint 与当前分支上的 raw-tail 起点形成 `ActiveContext` 候选，并按 Pi 当前任务模型报告的容量计算
eligibility。当前上下文到达高水位且候选 eligible 时，`context` hook 用 checkpoint、原始用户指令 anchor 与 raw tail
替换 provider messages；同一 provider epoch 保持该边界，下一次高水位可推进到最新有效 checkpoint。候选不可用、
容量不足或来源事实不可读时继续使用完整 Pi 上下文。Pi 是 compaction 的唯一触发方。

## 2. 前置条件

- Pi Coding Agent；
- Node.js 22.19.0 或更高版本（与当前 Pi 运行时要求一致）；
- OpenViking `0.4.15` 或通过相同 Content API 行为验收的服务；

受管安装固定使用 `openviking[local-embed]==0.4.15`。0.4.14 及更早版本在安装到 xxhash 4.x 的环境（如全新安装）中会静默丢失向量、导致内容无法召回，自建服务请勿使用该组合。

## 3. 安装与服务管理

一键安装：

```bash
npx pi-openviking@latest setup
```

首次 `setup` 生成的受管服务配置默认使用 `openai-codex/gpt-5.6-luna` 作为 VLM，OpenViking 自动使用
Codex CLI OAuth 登录态，凭证由 OpenViking OAuth store 管理。`setup` 在运行 doctor 前确认 Codex CLI
已登录；使用其他 provider 时，按 [docs/models.md](./models.md) 的“OpenViking VLM 配置参考”修改 `vlm` 段。
已存在的 `~/.pi/openviking/ov.conf` 保持原样。

仅安装扩展：

```bash
pi install npm:pi-openviking
```

本地仓库加载：

```bash
pi -e /path/to/pi-openviking/index.ts
```

服务命令：

```bash
npx pi-openviking@latest server start
npx pi-openviking@latest server stop
npx pi-openviking@latest server restart
npx pi-openviking@latest server status
npx pi-openviking@latest server doctor
```

受管服务文件位于 `~/.pi/openviking/`。`server status` 展示进程、健康、模型和代理摘要；
`server doctor` 执行完整环境与模型诊断。Pi/OpenViking 支持的 provider、认证方式、模型字段和完整切换流程见
[`docs/models.md`](./models.md)。

卸载：

```bash
npx pi-openviking@latest uninstall
```

该命令会停止受管服务，删除 `~/.pi/openviking/`、用户 JSONC 和受管数据，并从 Pi 移除扩展。

## 4. 地址与凭证

按以下顺序解析，先命中者生效：

1. `OPENVIKING_*` 环境变量；
2. `~/.pi/openviking/ovcli.conf`；
3. `~/.pi/openviking/ov.conf`。

配置远端服务或凭证：

```bash
npx pi-openviking@latest credentials
```

常用环境变量：

| 环境变量                                         | 作用                    |
| ------------------------------------------------ | ----------------------- |
| `OPENVIKING_URL`                                 | 服务地址                |
| `OPENVIKING_API_KEY` / `OPENVIKING_BEARER_TOKEN` | Bearer token            |
| `OPENVIKING_ACCOUNT`                             | account header          |
| `OPENVIKING_USER`                                | 基础用户标识            |
| `OPENVIKING_PEER_ID`                             | actor peer              |
| `OPENVIKING_WORKSPACE_PEER`                      | 是否按工作目录派生 peer |
| `OPENVIKING_RECALL_PEER_SCOPE`                   | `actor` 或 `all`        |
| `OPENVIKING_RECALL_LIMIT`                        | 召回条数覆盖            |
| `OPENVIKING_RECALL_QUERY_EXPANSION`              | `auto` 或 `off`         |

## 5. 扩展配置

首次加载生成：

```text
~/.pi/pi-openviking.jsonc
```

只写需要覆盖的字段。出厂默认值以包内 [`config.json`](./config.json) 为可执行来源；字段语义以
`docs/spec.md` 的“目标配置”为准。损坏 JSONC、错误类型和未知字段都会报错，错误包含完整路径。

示例：

```jsonc
{
  "syncTurns": true,
  "recallTokenBudget": 3000,
  "bypassPatterns": ["/workspace/generated"],
  "logLevel": "error",
}
```

`archive.chunkTokenBudget` 控制每次 Archive 的目标增量，`archive.rawTailTokenBudget` 控制归档后保留
最近原始上下文。`takeover.enabled` 控制是否允许 OpenViking 在 Pi `context` hook 中替换 provider 可见上下文；
`takeover.contextTokenThreshold` 控制触发接管的任务模型上下文高水位，`0` 时使用 Pi 报告容量与当前候选余量自动确定；
`takeover.checkpointTokenBudget` 限制接管和 ActiveContext compaction 可完整装载的 checkpoint 正文；超过上限时
保持 Pi 完整上下文与原生 compaction，不使用不完整 checkpoint。

只有存在 eligible `ActiveContext` 且当前 context usage 到达高水位时，provider messages 才会被替换为 checkpoint、
原始用户指令 anchor 与 raw tail；否则继续使用完整 Pi 上下文。已接管的候选容量不匹配或 checkpoint 超预算、且当前分支
已有更新 checkpoint 时，下一次请求直接改用更新候选重新判定；更新候选仍不适配时保留原边界并继续使用完整 Pi 上下文。
Pi 触发 compaction 时，扩展只在同一 ActiveContext 可读时提供自包含 checkpoint，不可用时保留 Pi 原生 compaction。
`recallTokenBudget` 直接限制服务端为一次检索装配的
上下文 token 预算。

### 受管服务代理

代理只注入本包启动的 OpenViking 子进程，不修改 Pi 或当前 shell：

```jsonc
{
  "managedServer": {
    "proxy": {
      "http": "http://127.0.0.1:7890",
      "https": "http://127.0.0.1:7890",
      "noProxy": "127.0.0.1,localhost,::1",
    },
  },
}
```

修改后执行：

```bash
npx pi-openviking@latest server restart
```

空的 `http`/`https` 表示明确不使用代理。只接受 HTTP(S) URL；未知字段、NUL 和错误类型会被拒绝。

## 6. 会话隔离与数据位置

默认 `sessionScopedMemory: true`。绑定用户为：

```text
sanitize(baseUser || "default")--pi-sanitize(piSessionId)
```

因此 `pi -c`、`pi -p` 沿用同一会话命名空间；新 session/fork 使用新命名空间。关闭该选项后使用
配置用户或服务解析的当前用户。

所有 `viking_*` URI 都先形成一次 canonical 值：工具不解码或改写 path 字节，`viking://user/<reserved>/...` shorthand 只展开到当前用户根；非法 URI 在所有模式下都被拒绝且不发出请求。开启隔离时，读取、删除和浏览只接受绑定根本身或其子路径；越界搜索范围夹回绑定根，返回结果按同一规则过滤。记忆删除工具在所有模式下
都拒绝 `.pi-openviking` 内部事实，raw event、Archive manifest 和 checkpoint 只能由各自职责模块管理。
OpenViking Resource API 不能把导入对象绑定到该会话用户命名空间，因此开启隔离时
`viking_add_resource` 在请求前拒绝；关闭隔离后按服务身份导入。`viking_archive_expand` 的 Archive 位置由当前
会话推导，跨会话展开在命名空间层面不可寻址，与该选项
无关。关闭该选项后不施加跨用户读取、删除和浏览边界。

原始 event files、Archive manifest 和 checkpoint 事实都使用 dot-prefixed 名称，普通 shard 列表不返回这些文件；
上层 dot directory 仍可能可见，语义处理过滤 dot files。嵌入图片仅在 checkpoint attempt 的临时 Resource 中进入
媒体语义处理；每个媒体得到非空摘要后才会提交 checkpoint 输入。终态事实跨重启重试删除所属 Session 和媒体根，二者都确认不存在才完成清理；长期 checkpoint 只保留 VLM 摘要与来源 hash。客户端仅持久化最小 ACK：

```text
~/.pi/openviking/sync-ack/<target-and-session-hash>.json
~/.pi/openviking/active-context/<target-and-session-hash>.json
```

ACK 文件不包含 transcript，活动上下文文件只包含 `checkpointId` 与 raw tail 起点的事件 ID。删除 ACK 只会使
下一次从 Pi JSONL 幂等重放；删除活动上下文只会使下一次同步从已消费 checkpoint 重新选择边界。

## 7. 状态与手动重放

页脚：

- `OV ✓`：最近一次健康检查可达；
- `OV ✗`：当前不可达。

`/viking` 显示：

- Pi JSONL、等待首个响应写入 Pi JSONL，或进程内 best-effort 来源；
- Content adapter capability：待探测、可用或不兼容；
- ACK frontier leaves；
- 待重放 entry；
- 当前分支本轮 Archive 已验证数、待验证数与最近 `archiveId`；
- checkpoint 的已赶上/处理中/消费落后/失败状态、已消费数、积压 Archive/token 与最近 `checkpointId`；
- 活动上下文：是否可接管、来源 `checkpointId`、raw tail 起点与事件数，以及 Pi 报告容量、输出预留、可用窗口和候选需求；
- 最近同步失败、最近 Archive/checkpoint/活动上下文失败及 fail-open 状态；
- 独立观察状态：未启用、就绪或不完整，以及 accepted/dropped 计数。

进入 checkpoint 消费落后、真正恢复到 processing/caught-up、或 VLM task 明确失败时会通知；第三次失败明确提示重试已耗尽，不把 failed 当作恢复。同一进程的同一
状态转换只通知一次，重启后可根据恢复出的当前状态再次提示。

立即重放：

```text
/viking sync
```

断线时，待重放内容始终从 Pi JSONL 重建。

## 8. 工具

| 工具                    | 作用                               |
| ----------------------- | ---------------------------------- |
| `viking_search`         | 语义搜索                           |
| `viking_read`           | 按 abstract、overview 或 full 读取 |
| `viking_browse`         | 浏览 URI 或查看元数据              |
| `viking_remember`       | 显式提交一条待抽取记忆             |
| `viking_forget`         | 删除普通记忆 URI 或高置信匹配      |
| `viking_add_resource`   | 导入 HTTP URL                      |
| `viking_archive_expand` | 按 `archiveId` 展开本会话 Archive  |

原始事件同步不经过这些工具。

## 9. 故障排查

### `OV ✗`

```bash
npx pi-openviking@latest server status
npx pi-openviking@latest server doctor
```

Pi 主任务继续执行。恢复服务后使用 `/viking sync` 或等待下一次 `turn_end`。

### capability 不兼容

确认远端服务提供：

- `POST /api/v1/content/batch-write`；
- `GET /api/v1/content/download`；
- `GET /api/v1/fs/stat`；
- `POST /api/v1/fs/mkdir`。

响应必须逐 URI 返回 `created` 或 `unchanged`。不同字节的同 URI 必须返回 409。

### 完整性冲突

冲突不会自动覆盖。使用 `/viking` 获取失败，再检查对应隐藏 URI 的 raw download。先判断是否有
其他调用方使用同一凭证修改了 adapter 独占命名空间。

### checkpoint 处理中、落后或失败

`/viking` 的积压数量和 token 来自尚无有效 checkpoint 的 Archive。处理中或断线时无需删除 Archive 或 ACK；
服务恢复后，下一次同步/状态轮询会复用已经持久化的 request 与 OpenViking task。task 明确失败时最多使用三个
确定性 attempt，失败事实不会被覆盖，也不会复制 provider/task 原始错误正文。持续失败或最近失败显示 `cleanup` 时，先运行 `server status` 和 `server doctor` 检查受管 VLM、Session 与媒体根；
raw event 与 Archive 仍可正常展开。

### 配置错误

错误会指出路径，例如：

```text
未知配置字段：takeover.foo
```

修复 `~/.pi/pi-openviking.jsonc` 后重启 Pi；配置不会静默降级。
