# Pi OpenViking 扩展

这是面向 [Pi Coding Agent](https://github.com/earendil-works/pi) 的
[OpenViking](https://github.com/volcengine/OpenViking) 扩展。当前版本负责三件事：

1. 将 Pi 会话完整投影为稳定、可重放的原始事件并写入 OpenViking；
2. 把已确认事件形成原子 Archive，并由受管 VLM 异步生成可追溯的结构化 checkpoint；
3. 在模型请求前检索已有 OpenViking 记忆。

Pi JSONL 始终保留完整历史并是 Pi 事件的唯一事实源。OpenViking 不可用时，编码任务继续运行；
未确认事件留在 Pi 来源中，连接恢复后重放。

## 当前边界

- user、assistant、tool call/result、thinking、image、未知 part、错误、aborted、custom entry 和
  Pi compaction 均按原始 JSON 值记录；
- 事件使用 RFC 8785 规范字节、稳定 event ID 和内容 hash；
- OpenViking `0.4.15` Content API 以 dot-prefixed event files 保存投影；
- 小事件直接写入，超过 8 MiB 的事件使用 claim/chunks/commit marker；
- 服务端确认一个 Pi entry 的全部事件后才推进最小 `SyncAck`；
- 不持久化待发送 transcript payload，也不使用数组长度作为同步水位；
- 已确认事件按 token/step 边界形成自证 Archive，可按 `archiveId` 确定展开；
- 每个 Archive 异步生成来源/hash 可核验的 checkpoint，失败与重启从追加事实恢复；
- `/viking` 展示 checkpoint 处理、落后、失败和积压状态；
- Pi compaction 只由 Pi 触发，扩展在完成后记录该事件。

`ActiveContext` 与上下文接管属于后续阶段；当前 checkpoint 在后台形成，但 provider 仍使用完整 Pi 上下文。

## 前置条件

- Pi Coding Agent
- Node.js 22.19.0 或更高版本（与当前 Pi 运行时要求一致）
- OpenViking `0.4.15` 或通过相同 Content API 行为验收的服务

## 快速开始

一键安装本地服务和扩展：

```bash
npx pi-openviking@latest setup
```

已有 OpenViking 服务时只安装扩展：

```bash
pi install npm:pi-openviking
```

从仓库临时加载：

```bash
pi -e /path/to/pi-openviking/index.ts
```

服务管理：

```bash
npx pi-openviking@latest server start
npx pi-openviking@latest server stop
npx pi-openviking@latest server restart
npx pi-openviking@latest server status
npx pi-openviking@latest server doctor
```

## 配置

首次加载生成：

```text
~/.pi/pi-openviking.jsonc
```

包内 `config.json` 是经过 schema 测试的出厂默认值，生成的 JSONC 模板列出可覆盖字段；
`docs/spec.md` 定义策略语义。配置加载器拒绝未知字段并报告完整路径。用户文件只需写覆盖项，例如：

```jsonc
{
  "syncTurns": true,
  "bypassPatterns": [],
}
```

OpenViking 地址与凭证按以下顺序解析：

1. `OPENVIKING_*` 环境变量；
2. `~/.pi/openviking/ovcli.conf`；
3. `~/.pi/openviking/ov.conf`。

`managedServer.proxy` 是服务连接配置，只影响本包启动的 OpenViking 子进程。完整说明见
[`docs/usage.md`](./docs/usage.md)。

## 状态与命令

页脚只显示连接健康状态：

- `OV ✓`：最近一次检查可达；
- `OV ✗`：当前不可达。

`/viking` 显示来源类型、Content adapter capability、ACK frontier、待重放 entry、Archive/checkpoint/积压、
最近失败和独立观察状态。`/viking sync` 立即从当前 Pi 会话来源重放。

## 工具

扩展注册：

- `viking_search`
- `viking_read`
- `viking_browse`
- `viking_remember`
- `viking_forget`
- `viking_add_resource`
- `viking_archive_expand`

这些工具操作显式 OpenViking 记忆和资源；原始事件同步不依赖工具调用。

## 项目结构

```text
index.ts                     Pi 生命周期与 fail-open 接入
config.ts / config.json      统一配置加载与出厂默认值
client.ts                    OpenViking HTTP/Content transport
sync.ts                      JSONL、RecordedEvent、ACK、Archive 与 checkpoint 协调
recall.ts                    当前提示词召回
tools.ts                     Viking 工具与 /viking 命令
shared/recorded-event*.mjs   规范事件与 Content adapter
shared/archive*.mjs          Archive 身份、边界、提交与 expand
shared/checkpoint*.mjs       checkpoint 身份、VLM 处理、事实与状态派生
shared/pi-session-source.mjs 持久 Pi JSONL 分支恢复
shared/sync-ack.mjs          最小 ACK frontier
scripts/cli.mjs              安装与服务管理 CLI
docs/                        规范、设计、开发环境、用户文档与可观测性标准
```

## 文档

- [`docs/spec.md`](./docs/spec.md)：目标架构、协议和配置语义的唯一权威规范；
- [`docs/roadmap.md`](./docs/roadmap.md)：阶段划分、当前实施状态和下一实施入口；
- [`docs/verification.md`](./docs/verification.md)：证据标准与阶段门禁契约；
- [`docs/development.md`](./docs/development.md)：开发环境的安装、运行、开发循环和清理；
- [`docs/design.md`](./docs/design.md)：当前实现的职责与数据流；
- [`docs/usage.md`](./docs/usage.md)：安装、配置和故障排查；
- [`docs/observability.md`](./docs/observability.md)：观察点契约、记录形状与脱敏边界。
- [`AGENTS.md`](./AGENTS.md)：给编码代理的地图——需要答案时去哪里找。

## 许可证

Apache-2.0，见 [`LICENSE`](./LICENSE)。OpenViking 服务端使用其自身许可证。
