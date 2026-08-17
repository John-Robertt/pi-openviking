# Pi OpenViking 记忆扩展

这是一个面向 [Pi Coding Agent](https://github.com/earendil-works/pi) 的 [OpenViking](https://github.com/volcengine/OpenViking) 客户端扩展。它在当前 Pi 会话中自动同步对话、召回相关长期记忆，并在上下文增长后用 OpenViking 归档概览替代较早的完整历史。

默认开启 `sessionScopedMemory`：抽取后的长期记忆按 Pi 会话隔离。继续同一个会话（例如 `pi -c` 或 `pi -p`）会沿用原命名空间；新会话和 fork 使用新的命名空间，不会自动召回旧会话的长期记忆。将该配置设为 `false` 才会恢复同一 OpenViking 用户下的跨会话共享。

## 前置条件

- Pi Coding Agent
- Node.js 20.18.1 或更高版本
- 可访问的 OpenViking HTTP 服务
- Python 3.10 或更高版本（仅本地安装 OpenViking 服务时需要）

## 快速开始

### 一键安装

```bash
npx pi-openviking@latest setup
```

该命令会在 `~/.pi/openviking/` 下安装并配置本地 OpenViking 服务，运行 doctor 检查，启动服务，然后通过 `pi install npm:pi-openviking` 安装扩展。

本地服务管理：

```bash
npx pi-openviking@latest server start
npx pi-openviking@latest server stop
npx pi-openviking@latest server restart
npx pi-openviking@latest server status
npx pi-openviking@latest server doctor
```

`server status` 快速展示运行进程、健康信息、生效的模型和受管代理；`server doctor` 执行 OpenViking 的完整环境、模型与认证诊断。

卸载：

```bash
npx pi-openviking@latest uninstall
```

卸载会删除 `~/.pi/openviking/`、`~/.pi/pi-openviking.jsonc` 以及其中由本工具管理的长期记忆数据，并从 Pi 中移除该扩展。

### 仅安装扩展

已有 OpenViking 服务时可以只安装扩展：

```bash
pi install npm:pi-openviking
```

从当前仓库临时加载：

```bash
pi -e /path/to/pi-openviking/index.ts
```

## 配置

首次加载扩展时会生成用户配置：

```text
~/.pi/pi-openviking.jsonc
```

包内 `config.json` 是扩展出厂默认值，不应作为用户配置文件修改。扩展配置会在包内默认值之上合并，修改后重启 Pi 生效；`managedServer.proxy` 只控制本包启动的 OpenViking 服务进程，修改后执行 `npx pi-openviking@latest server restart`。

OpenViking 地址与凭证按以下顺序解析：

1. `OPENVIKING_*` 环境变量
2. `~/.pi/openviking/ovcli.conf`
3. `~/.pi/openviking/ov.conf`

配置远端服务或 API key：

```bash
npx pi-openviking@latest credentials
```

关键出厂默认值：

| 配置 | 默认值 | 作用 |
|---|---:|---|
| `sessionScopedMemory` | `true` | 抽取后的长期记忆按 Pi 会话隔离 |
| `syncTurns` | `true` | 自动同步会话内容 |
| `recallTokenBudget` | `2000` | 每轮召回上下文的 token 预算 |
| `takeover.enabled` | `true` | 启用 OpenViking 上下文接管 |
| `takeover.tokenThreshold` | `20000` | 新同步内容累计到该值时触发归档 |
| `takeover.retainedTokenBudget` | `30000` | OpenViking 归档后原始消息的保留预算 |
| `takeover.keepRecentTurns` | `3` | 接管后优先保留的最近逻辑用户轮数 |
| `takeover.overviewBudget` | `16000` | 注入模型上下文的 archive overview 最大预算 |
| `logLevel` | `"error"` | 扩展日志级别 |

完整配置、服务端模型配置和故障排查见 [`USAGE.md`](./USAGE.md)。

## 当前运行机制

扩展入口是 `index.ts`，通过 Pi 生命周期事件驱动：

| Pi 事件 | 当前行为 |
|---|---|
| `session_start` | 检查服务、绑定会话记忆命名空间、创建或恢复 OpenViking 会话，并启动连接状态刷新 |
| `before_agent_start` | 为继续会话补做幂等初始化，并记录当前提示词 |
| `context` | 使用当前提示词召回记忆，注入召回内容和归档概览 |
| `turn_end` | 捕获并同步分支；按目标 archive 身份推进边界 |
| `session_before_compact` | 精确归档当前 live 内容；未就绪时让 Pi 默认 compaction 接管 |
| `session_compact` | 重置已被 Pi compaction 取代的本地边界 |
| `session_shutdown` | 保存接管状态或执行非接管模式的最终提交 |

当前提示词的召回发生在同一模型轮次的 `context` 事件中，不使用上一轮提示词的预取结果。写入前会清除已注入的 `<openviking-context>` 等上下文块，避免召回内容再次进入长期记忆。

在启用且未被 bypass 的会话中，Pi 页脚只显示连接健康状态：`OV ✓` 表示最近一次检查确认服务可达，`OV ✗` 表示当前不可达。同步、上下文接管、archive 和会话诊断统一由 `/viking` 使用中文多行展示。扩展约每 5 秒自动刷新，并在执行 `/viking` 或每次用户提示开始处理前立即检查。

## 工具与命令

扩展注册以下 7 个工具：

| 工具 | 作用 |
|---|---|
| `viking_search` | 在当前允许的 OpenViking 范围内进行语义搜索 |
| `viking_read` | 按 abstract、overview 或 full 层级读取 `viking://` 内容 |
| `viking_browse` | 浏览或查看 `viking://` 路径元数据 |
| `viking_remember` | 向当前 OpenViking 会话写入待抽取的事实或记忆 |
| `viking_forget` | 删除指定记忆或搜索后删除高置信匹配 |
| `viking_add_resource` | 导入 HTTP URL 资源 |
| `viking_archive_expand` | 按 OpenViking session ID 读取已归档会话内容 |

在 Pi 中输入 `/viking` 会立即检查连接并显示当前会话信息；使用其 `commit` 子命令 `/viking commit` 可手动提交当前 OpenViking 会话。输入 `/viking ` 后可补全该子命令。

## 项目结构

```text
index.ts                     Pi 扩展入口与事件处理
config.ts / config.json      配置加载、用户模板与包内默认值
client.ts                    OpenViking HTTP 客户端
sync.ts                      会话同步、待处理队列与提交
recall.ts                    当前提示词召回
takeover.ts                  Pi 与接管状态机的适配层
tools.ts                     Viking 工具与 /viking 命令
lib/                         接管、捕获和 URI 防护适配器
shared/                      凭证、捕获、队列、召回等共享实现
scripts/cli.mjs              安装与服务管理 CLI
scripts/e2e-probe.ts         端到端探针
```

## 文档

- [`USAGE.md`](./USAGE.md)：安装、服务端配置、扩展配置和故障排查
- [`DESIGN.md`](./DESIGN.md)：捕获、召回与同步设计
- [`TAKEOVER.md`](./TAKEOVER.md)：上下文接管状态机与失败处理

## 许可证

扩展按 Apache-2.0 发布，见 [`LICENSE`](./LICENSE)。OpenViking 服务端使用其自身许可证。