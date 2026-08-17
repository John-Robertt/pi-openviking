# Pi OpenViking 扩展使用说明

本文是本扩展的详细使用文档，描述当前版本的安装、配置、运行边界和故障排查。

相关文档：

- [`README.md`](README.md)：项目概览与快速开始
- [`DESIGN.md`](DESIGN.md)：捕获、召回与同步设计
- [`TAKEOVER.md`](TAKEOVER.md)：上下文接管状态机与失败处理

## 1. 当前行为

扩展在一个 Pi 会话中维护两类上下文：

- **工作上下文**：会话历史达到阈值后提交给 OpenViking，本地上下文保留最近若干用户轮次，其余内容由 `[OpenViking Session Context]` 归档概览替代。
- **抽取后的长期记忆**：OpenViking 提交会话后异步抽取实体、事件和偏好，扩展在后续提示词中进行语义召回。

默认配置 `sessionScopedMemory: true`。扩展将长期记忆用户命名空间绑定为：

```text
<user>--pi-<piSessionId>
```

因此：

- `pi -c` 或 `pi -p` 继续同一个 Pi 会话时沿用原命名空间；
- 新会话和 fork 使用新的长期记忆命名空间；
- 将 `sessionScopedMemory` 设为 `false` 后，同一 OpenViking 用户的会话恢复共享长期记忆。

该命名空间约束针对 `viking://user/<user>` 下的长期记忆。`viking_archive_expand` 按调用方明确提供的 OpenViking session ID 读取 `viking://session/<id>` 会话归档，不使用上述用户记忆命名空间。

## 2. 前置条件

### 2.1 客户端

- Pi Coding Agent
- Node.js 20.18.1 或更高版本
- 可访问的 OpenViking HTTP 服务

扩展通过 HTTP 调用 OpenViking，不包含服务端。

### 2.2 本地服务

本地安装还需要 Python 3.10 或更高版本。一键安装脚本当前固定安装：

```text
openviking[local-embed]==0.4.13
xxhash<4
```

不要在脚本管理的虚拟环境中单独升级这两个依赖；重新运行 setup 会恢复上述版本组合。

### 2.3 记忆模型

OpenViking 服务端必须配置可用的 `vlm`。没有可用的 VLM 时，服务可能通过健康检查，但不会生成记忆抽取结果和归档概览，上下文接管边界也无法推进。

一键安装会在启动前运行：

```bash
npx pi-openviking@latest server doctor
```

## 3. 安装与管理

### 3.1 一键安装

```bash
npx pi-openviking@latest setup
```

setup 当前执行以下操作：

1. 创建 `~/.pi/openviking/venv`；
2. 安装固定版本的 OpenViking 服务端依赖；
3. 可选安装 Ollama；
4. 生成 `~/.pi/openviking/ov.conf`；
5. 运行 doctor；
6. 后台启动服务并等待 `/health`；
7. 执行 `pi install npm:pi-openviking`。

已有配置文件不会被覆盖。修改 `ov.conf` 后重新运行 setup，doctor 会再次检查配置；服务已经运行时，setup 会提示手动重启。

### 3.2 服务管理

```bash
npx pi-openviking@latest server start
npx pi-openviking@latest server stop
npx pi-openviking@latest server restart
npx pi-openviking@latest server status
npx pi-openviking@latest server doctor
```

服务数据均位于 `~/.pi/openviking/`：

```text
venv/          Python 虚拟环境
ov.conf        OpenViking 服务端配置
ovcli.conf     客户端地址与凭证
server.pid     后台服务 PID
server-state.json  脱敏的运行配置快照
server.log     服务日志
data/          长期记忆和索引数据
```

### 3.3 仅安装扩展

已有 OpenViking 服务时：

```bash
pi install npm:pi-openviking
```

首次加载会生成 `~/.pi/pi-openviking.jsonc`。

从仓库临时加载：

```bash
pi -e /path/to/pi-openviking/index.ts
```

### 3.4 更新

更新扩展包：

```bash
pi update --extensions
```

更新脚本管理的服务端版本组合：

```bash
npx pi-openviking@latest setup
```

### 3.5 卸载

```bash
npx pi-openviking@latest uninstall
```

确认后会：

- 停止后台服务；
- 删除 `~/.pi/openviking/` 及其中的配置、日志和长期记忆数据；
- 删除 `~/.pi/pi-openviking.jsonc`；
- 执行 `pi remove npm:pi-openviking`。

不会删除上游共享目录 `~/.openviking/`，也不会卸载系统级 Ollama。

## 4. 地址与凭证

按以下顺序解析，先命中者生效：

1. `OPENVIKING_*` 环境变量；
2. `~/.pi/openviking/ovcli.conf`；
3. `~/.pi/openviking/ov.conf`。

常用环境变量：

| 环境变量 | 作用 |
|---|---|
| `OPENVIKING_URL` | OpenViking 服务地址 |
| `OPENVIKING_API_KEY` / `OPENVIKING_BEARER_TOKEN` | Bearer token |
| `OPENVIKING_ACCOUNT` | trusted 模式 account |
| `OPENVIKING_USER` | OpenViking 基础用户标识 |
| `OPENVIKING_PEER_ID` | actor peer 标识 |
| `OPENVIKING_WORKSPACE_PEER` | 是否按当前工作目录派生 peer；设为 `0` 可关闭 |
| `OPENVIKING_RECALL_PEER_SCOPE` | `actor` 或 `all` |
| `OPENVIKING_RECALL_LIMIT` | 召回配额输入 |
| `OPENVIKING_RECALL_QUERY_EXPANSION` | `auto` 或 `off` |

配置远端服务或 API key：

```bash
npx pi-openviking@latest credentials
```

本地默认地址：

```bash
export OPENVIKING_URL=http://127.0.0.1:1933
```

本地 setup 生成的配置和扩展会自动使用该地址，通常不需要额外设置环境变量。

## 5. OpenViking 服务端配置

`~/.pi/openviking/ov.conf` 是严格 JSON，不支持注释。默认模板包含：

- `storage.workspace`: `~/.pi/openviking/data`
- `server.host`: `127.0.0.1`
- `server.port`: `1933`
- 本地 dense embedding
- 需要用户补充凭证的 `vlm`

### 5.1 关键字段

| 字段 | 当前作用 |
|---|---|
| `storage.workspace` | 长期记忆和向量索引目录 |
| `server.host` / `server.port` | HTTP 监听地址 |
| `server.root_api_key` | 非本机监听时使用的服务端 API key |
| `embedding.dense` | dense embedding provider、模型、地址和维度 |
| `vlm` | 记忆抽取和归档概览使用的模型 |

修改 embedding 的 `dimension` 后，已有向量索引与新维度不兼容。

### 5.2 `embedding.dense` 配置

`embedding.dense` 只负责生成检索使用的向量，与 `vlm` 是两条独立配置。更换其中一个不会自动修改另一个。

setup 当前生成的本地 embedding：

```json
{
  "embedding": {
    "dense": {
      "provider": "local",
      "model": "bge-small-zh-v1.5-f16",
      "dimension": 512
    }
  }
}
```

OpenAI embedding：

```json
{
  "embedding": {
    "dense": {
      "provider": "openai",
      "model": "text-embedding-3-small",
      "api_key": "<KEY>",
      "api_base": "https://api.openai.com/v1",
      "dimension": 1536
    }
  }
}
```

Ollama embedding：

```json
{
  "embedding": {
    "dense": {
      "provider": "ollama",
      "model": "qwen3-embedding:0.6b",
      "api_base": "http://localhost:11434/v1",
      "dimension": 1024
    }
  }
}
```

当前固定服务端版本的 dense embedding provider 包括：`local`、`openai`、`azure`、`volcengine`、`vikingdb`、`jina`、`ollama`、`gemini`、`voyage`、`dashscope`、`minimax`、`cohere` 和 `litellm`。

### 5.3 `vlm` 配置

`vlm` 只负责记忆抽取和归档概览。它可以使用与 embedding 不同的 provider、模型和凭证。

setup 模板当前生成火山引擎配置：

```json
{
  "vlm": {
    "provider": "volcengine",
    "model": "doubao-seed-2-0-code-preview-260215",
    "api_key": "<ARK_API_KEY>",
    "api_base": "https://ark.cn-beijing.volces.com/api/v3",
    "temperature": 0.0,
    "max_retries": 2
  }
}
```

OpenAI VLM：

```json
{
  "vlm": {
    "provider": "openai",
    "model": "<MODEL>",
    "api_key": "<KEY>",
    "api_base": "https://api.openai.com/v1"
  }
}
```

复用已登录的 Codex CLI：

```json
{
  "vlm": {
    "provider": "openai-codex",
    "model": "<MODEL>",
    "api_base": "https://chatgpt.com/backend-api/codex"
  }
}
```

Codex OAuth 缓存位于 `~/.pi/openviking/codex_auth.json`。

Kimi 编程订阅：

```json
{
  "vlm": {
    "provider": "kimi",
    "model": "kimi-code",
    "api_key": "<订阅 KEY>",
    "api_base": "https://api.kimi.com/coding"
  }
}
```

GLM 编程订阅：

```json
{
  "vlm": {
    "provider": "glm",
    "model": "glm-4.6v",
    "api_key": "<订阅 KEY>",
    "api_base": "https://api.z.ai/api/coding/paas/v4"
  }
}
```

通过 LiteLLM 使用 Ollama：

```json
{
  "vlm": {
    "provider": "litellm",
    "model": "ollama/<模型名>",
    "api_key": "no-key",
    "api_base": "http://localhost:11434"
  }
}
```

当前固定服务端版本为 `volcengine`、`openai`、`azure`、`openai-codex`、`kimi` 和 `glm` 提供专用 VLM 后端；其他 provider 值由 LiteLLM 后端处理。

## 6. 扩展配置

用户配置位于：

```text
~/.pi/pi-openviking.jsonc
```

包内 `config.json` 只是扩展出厂默认值。扩展配置与包内默认值合并，修改后重启 Pi 生效；受管服务代理由 CLI 单独读取，修改后重启 OpenViking 服务。首次生成的 JSONC 模板包含当前支持的可调项和注释。

### 6.1 当前关键默认值

| 配置 | 默认值 | 作用 |
|---|---:|---|
| `enabled` | `true` | 扩展总开关 |
| `sessionScopedMemory` | `true` | 按 Pi 会话绑定长期记忆用户命名空间 |
| `syncTurns` | `true` | 同步会话内容 |
| `recallTokenBudget` | `2000` | 每轮召回注入预算 |
| `recallMaxContentChars` | `500` | 单条召回内容字符上限 |
| `recallPreferAbstract` | `true` | 优先使用摘要 |
| `recallLimit` | `10` | 服务端分类配额的缩放输入 |
| `recallQueryExpansion` | `auto` | 服务端查询扩展模式 |
| `scoreThreshold` | `0.35` | 最低召回相关度 |
| `minQueryLength` | `3` | 触发召回的最短提示词长度 |
| `profileTokenBudget` | `10000` | 用户画像注入预算 |
| `resumeContextBudget` | `32000` | 恢复会话时的归档上下文预算 |
| `commitTokenThreshold` | `20000` | 客户端提交阈值 |
| `commitKeepRecentCount` | `10` | 提交时保留的最近消息数 |
| `takeover.enabled` | `true` | 启用上下文接管 |
| `takeover.tokenThreshold` | `20000` | 接管提交和边界推进阈值 |
| `takeover.keepRecentTurns` | `3` | 本地保留的最近用户轮数 |
| `takeover.overviewBudget` | `16000` | 归档概览请求预算 |
| `takeover.overviewPollMs` | `2000` | 概览轮询间隔 |
| `takeover.overviewPollMax` | `15` | 单次边界推进的最大轮询次数 |
| `captureMode` | `semantic` | `semantic` 或 `keyword` |
| `captureMaxLength` | `24000` | 单条捕获文本上限 |
| `captureToolMaxChars` | `1000000` | 单个工具内容部分的字符上限 |
| `captureAssistantTurns` | `true` | 捕获助手侧内容 |
| `bypassPatterns` | `[]` | 按当前工作目录跳过整个扩展处理 |
| `logLevel` | `error` | `silent`、`error` 或 `info` |

`bypassPatterns` 匹配 `process.cwd()`：普通值匹配该目录及其子目录；以 `*` 开头时匹配路径后缀；以 `*` 结尾时匹配路径前缀。

### 6.2 受管 OpenViking 服务代理

`managedServer.proxy` 只控制本包执行 `openviking-server doctor` 以及启动后台服务时传给 OpenViking 子进程的环境，不修改当前 shell、Pi 进程或其他子进程：

```json
{
  "managedServer": {
    "proxy": {
      "http": "",
      "https": "",
      "noProxy": "127.0.0.1,localhost,::1"
    }
  }
}
```

`http` 和 `https` 默认均为空，即不使用代理。启动脚本会先从子进程环境副本中移除大小写形式的 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 和 `NO_PROXY`，再按本配置写入 `HTTP_PROXY`、`HTTPS_PROXY` 和 `NO_PROXY`，因此不会意外继承用户环境中的代理。代理 URL 仅支持 `http://` 和 `https://`。

该设置为 OpenViking 服务进程中遵循标准代理环境变量的请求提供代理；当前固定版本的 embedding、VLM 客户端以及首次本地模型下载使用该机制。OpenViking 的部分内部回环或安全校验请求会显式绕过环境代理。embedding 与 VLM 不能分别指定不同的正向代理；该设置也不代理 `uv`、`pip`、`pi` 等安装命令。若代理 URL 含凭证，应确保本文件只有当前用户可读。

修改后重启受管服务：

```bash
npx pi-openviking@latest server restart
```

JSONC 无法解析或代理字段无效时，`setup` 的 doctor、`server start`、`server restart` 和 `server doctor` 会拒绝继续，避免静默绕过代理。

### 6.3 上下文接管

默认组合为：

```json
{
  "takeover": {
    "enabled": true,
    "tokenThreshold": 20000,
    "keepRecentTurns": 3,
    "overviewBudget": 16000,
    "overviewPollMs": 2000,
    "overviewPollMax": 15
  }
}
```

达到阈值后，扩展提交当前 OpenViking 会话并轮询归档概览。取得概览后，`context` 事件用一条 `[OpenViking Session Context]` 消息替换已覆盖的较早历史，同时保留最近用户轮次。

在概览尚未生成、请求失败或预算不足时，本轮保持原上下文，不推进覆盖边界。

### 6.4 捕获和召回

接管开启时，捕获路径保留用于恢复工作上下文的会话内容，包括受 `captureToolMaxChars` 限制的工具部分。写入前会删除扩展自己注入的 OpenViking 上下文块，避免召回内容被再次捕获。

召回使用当前用户提示词，并在同一轮 `context` 事件中注入。服务端支持 context 搜索时使用 `/api/v1/search/search`；不支持时回退到 `/api/v1/search/recall`。

## 7. 状态与诊断

### 7.1 基本状态

```bash
npx pi-openviking@latest server status
npx pi-openviking@latest server doctor
pi list
```

`server status` 是无外部模型调用的快速检查，展示受管进程、结构化 `/health` 结果、运行时模型、代理、存储和日志。服务启动后修改 `ov.conf` 或 `managedServer.proxy` 时，状态会保留运行中的配置并提示执行 `server restart`；由旧版 CLI 启动且没有运行快照时，会将当前地址检查标记为 `PROBE` 并返回非零，执行一次 `server restart` 即可建立可确认的运行快照。

`server doctor` 使用与受管服务相同的 `ov.conf`、代理和 Codex OAuth 路径执行 OpenViking 完整诊断，包括 Embedding、VLM、认证、运行环境和磁盘。

Pi 页脚状态：

- `OV ✓`：OpenViking 可达；
- `OV ✗`：OpenViking 不可达；
- `ctx K`：已经由归档概览覆盖的用户轮数；
- `~N/T`：当前同步 token 估算与接管阈值。

在 Pi 中输入 `/viking` 可查看连接和会话信息，输入 `/viking commit` 可手动提交。

### 7.2 调试日志

设置日志文件后再启动 Pi：

```bash
export OV_DEBUG_LOG="$PWD/ov-pi.log"
pi
```

扩展以 best-effort 方式写日志，日志写入失败不会中断 Pi。

## 8. 故障排查

| 现象 | 当前检查入口 |
|---|---|
| 页脚显示 `OV ✗` | `server status`、`/health`、`OPENVIKING_URL` 和凭证 |
| 本地 curl 可用但扩展无法连接 | 升级到 0.3.2 或更高版本；loopback 请求会绕过 Pi HTTP 代理 |
| 提交后没有归档概览 | 检查 `server doctor` 的 VLM 结果和 `server.log` |
| 日志反复出现 `overview not ready` | 检查 VLM 和 `takeover.overviewBudget` |
| recall 一直没有结果 | 检查服务端版本组合、embedding、xxhash 和当前会话命名空间 |
| 扩展没有加载 | 使用 `pi list` 检查安装状态，检查用户配置中的 `enabled` |
| 扩展配置未生效 | 确认修改的是 `~/.pi/pi-openviking.jsonc`，然后重启 Pi |
| 受管服务代理未生效 | 检查 `managedServer.proxy`、代理 URL 和 `NO_PROXY`，然后执行 `server restart`；配置错误会直接阻止启动 |

## 9. 当前边界

- `sessionScopedMemory` 隔离的是抽取后的用户长期记忆命名空间，不会把历史会话记忆迁移到新命名空间。
- `viking_archive_expand` 使用调用方提供的 OpenViking session ID 读取会话归档。
- OpenViking 记忆抽取和归档概览依赖服务端 VLM，扩展不会在客户端替代该模型能力。
- 修改 embedding 维度后，已有向量索引不能直接沿用。
- 本扩展按 Apache-2.0 发布；OpenViking 服务端使用其自身许可证。