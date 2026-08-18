# Pi OpenViking 使用说明

本文描述当前版本的安装、配置、运行边界和故障排查。目标架构和阶段验收以
[`HANDOFF.md`](./HANDOFF.md) 为唯一权威来源；当前代码职责见 [`DESIGN.md`](./DESIGN.md)。

## 1. 当前行为

扩展从 Pi 会话来源完整记录事件，并在 provider 请求前检索已有 OpenViking 记忆。

持久 session 使用 Pi JSONL；非持久化 session 仅提供进程内 best-effort。记录包含文本、图片、
thinking、tool call/result、真实错误和 aborted 状态、未知 part、custom entry 及 Pi compaction。
扩展不清洗、过滤或截断原始 payload。

当前阶段不创建目标 Archive、checkpoint 或 `ActiveContext`，也不替换 Pi 上下文。Pi 是 compaction
唯一触发方。

## 2. 前置条件

- Pi Coding Agent；
- Node.js 22.19.0 或更高版本（与当前 Pi 运行时要求一致）；
- OpenViking `0.4.13` 或通过相同 Content API 行为验收的服务；
- Python 3.10 或更高版本（仅本地服务需要）。

受管安装固定使用：

```text
openviking[local-embed]==0.4.13
xxhash<4
```

## 3. 安装与服务管理

一键安装：

```bash
npx pi-openviking@latest setup
```

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
`server doctor` 执行完整环境与模型诊断。

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

| 环境变量 | 作用 |
|---|---|
| `OPENVIKING_URL` | 服务地址 |
| `OPENVIKING_API_KEY` / `OPENVIKING_BEARER_TOKEN` | Bearer token |
| `OPENVIKING_ACCOUNT` | account header |
| `OPENVIKING_USER` | 基础用户标识 |
| `OPENVIKING_PEER_ID` | actor peer |
| `OPENVIKING_WORKSPACE_PEER` | 是否按工作目录派生 peer |
| `OPENVIKING_RECALL_PEER_SCOPE` | `actor` 或 `all` |
| `OPENVIKING_RECALL_LIMIT` | 召回条数覆盖 |
| `OPENVIKING_RECALL_QUERY_EXPANSION` | `auto` 或 `off` |

## 5. 扩展配置

首次加载生成：

```text
~/.pi/pi-openviking.jsonc
```

只写需要覆盖的字段。出厂默认值以包内 [`config.json`](./config.json) 为可执行来源；字段语义以
`HANDOFF.md` 的“目标配置”为准。损坏 JSONC、错误类型和未知字段都会报错，错误包含完整路径。

示例：

```jsonc
{
  "syncTurns": true,
  "recallTokenBudget": 3000,
  "bypassPatterns": ["/workspace/generated"],
  "logLevel": "error"
}
```

`archive` 和 `takeover` 当前用于固定后续阶段的目标策略；在有效 Archive 和 `ActiveContext` 实现并
通过验收前，不会触发归档或上下文替换。

### 受管服务代理

代理只注入本包启动的 OpenViking 子进程，不修改 Pi 或当前 shell：

```jsonc
{
  "managedServer": {
    "proxy": {
      "http": "http://127.0.0.1:7890",
      "https": "http://127.0.0.1:7890",
      "noProxy": "127.0.0.1,localhost,::1"
    }
  }
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

原始 event files 使用 dot-prefixed 名称，普通 shard 列表不返回这些文件；上层 dot directory 仍可能
可见。语义处理过滤 dot event files。客户端仅持久化最小 ACK：

```text
~/.pi/openviking/sync-ack/<target-and-session-hash>.json
```

ACK 文件不包含 transcript。删除 ACK 只会使下一次从 Pi JSONL 幂等重放。

## 7. 状态与手动重放

页脚：

- `OV ✓`：最近一次健康检查可达；
- `OV ✗`：当前不可达。

`/viking` 显示：

- `persistent-jsonl` 或进程内来源；
- Content adapter capability：待探测、可用或不兼容；
- ACK frontier leaves；
- 待重放 entry；
- 最近同步失败及 fail-open 状态。

立即重放：

```text
/viking sync
```

断线时，待重放内容始终从 Pi JSONL 重建。

## 8. 工具

| 工具 | 作用 |
|---|---|
| `viking_search` | 语义搜索 |
| `viking_read` | 按 abstract、overview 或 full 读取 |
| `viking_browse` | 浏览 URI 或查看元数据 |
| `viking_remember` | 显式提交一条待抽取记忆 |
| `viking_forget` | 删除 URI 或高置信匹配 |
| `viking_add_resource` | 导入 HTTP URL |
| `viking_archive_expand` | 展开服务中已有的 session Archive |

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

### 配置错误

错误会指出路径，例如：

```text
未知配置字段：takeover.foo
```

修复 `~/.pi/pi-openviking.jsonc` 后重启 Pi；配置不会静默降级。
