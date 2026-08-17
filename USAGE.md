# OpenViking pi 扩展（会话隔离版）使用说明

本文是这份扩展的权威使用文档，覆盖前置条件、安装、配置、验证与已知边界。

机制本身（接管流程、归档分层、记忆抽取）由上游文档定义，本文不重复：
- [`TAKEOVER.md`](TAKEOVER.md) — 上下文接管的状态机与失败模式
- [`DESIGN.md`](DESIGN.md) — 捕获、召回、同步的设计
- [`README.md`](README.md) — 上游工具与配置总览

本文只描述与上游行为不同、或使用时必须知道的部分。

---

## 1. 它解决什么问题

在单个 pi 会话的长任务中自动维护两层记忆：

- **工作记忆**：会话历史增长到阈值后提交给 OpenViking，本地上下文只保留最近若干轮，其余由归档概览（`[OpenViking Session Context]`）代替。
- **长期记忆**：提交后由记忆模型异步抽取实体、事件、偏好，可通过 `viking_search` 按需召回。

与上游的关键差异：**长期记忆按 pi 会话隔离**，一个会话看不到另一个会话的记忆。

---

## 2. 前置条件

### 2.1 OpenViking 服务

扩展是客户端，实际工作由常驻的 OpenViking HTTP 服务完成。安装与启停由 §3 的一键脚本完成；必须先能访问：

```bash
curl http://127.0.0.1:1933/health
```

### 2.2 依赖约束：xxhash < 4

**这一条不是可选项。** openviking 0.4.13 声明 `xxhash>=3.0.0`，但 `openviking/storage/vectordb/utils/str_to_uint64.py` 向 `xxhash.xxh64()` 传入 `str`。xxhash 4.0 移除了隐式编码，抛出 `Strings must be encoded before hashing`；该异常落在 `VikingVectorIndexBackend.upsert(partial_update=True)` 内，被记录后直接 `return ""`，**向量记录被静默丢弃**。

后果：长期记忆能写进文件系统，但永远索引不上，`search/recall` 恒返回 0 候选，而日志只有一行 ERROR。

服务端安装时固定版本：

```
openviking[local-embed]==0.4.13
xxhash<4
```

xxhash 3.8.1 与 4.0.0 对同一输入产生相同摘要，降级不需要数据迁移。

### 2.3 记忆模型

服务端 `vlm` 需要配置一个可用模型，否则提交后不会生成归档概览，接管永远无法推进边界。用 `openviking-server doctor --config <配置文件>` 确认 `VLM` 一项为 `PASS`。

---

## 3. 安装

### 一键安装（推荐）

```bash
npx pi-openviking@latest setup
```

一条命令完成全链路：创建 `~/.pi/openviking/venv` → 固定版本安装服务端（`openviking[local-embed]==0.4.13`、`xxhash<4`）→ （可选）预装 Ollama（本地模型路线）→ 生成 `ov.conf` 模板并引导手工编辑（含 vlm 模型）→ `doctor` 验证 → 后台启动服务并等待 `/health` 就绪 → `pi install npm:pi-openviking`。幂等，可重复运行；任何一步失败会停止并给出修复指引。

服务启停（零依赖 Node 实现，跨平台后台运行）：

```bash
npx pi-openviking@latest server start|stop|restart|status
```

连接远端服务器或配置 API key：

```bash
npx pi-openviking@latest credentials
```

### 仅安装扩展

```bash
pi install npm:pi-openviking
```

首次启动自动生成 `~/.pi/pi-openviking.jsonc` 用户配置模板；之后用 `pi update --extensions` 随包更新。

### 从仓库直接加载（便于改动）

```bash
pi -e /path/to/pi-openviking/index.ts
```

调参写到用户配置 `~/.pi/pi-openviking.jsonc`（首次运行自动生成带全部配置项注释的模板），扩展目录内的 `config.json` 只是出厂默认值。

### 装入 pi 扩展目录（全局生效）

```bash
mkdir -p ~/.pi/agent/extensions
cp -r openviking ~/.pi/agent/extensions/openviking
pi install ~/.pi/agent/extensions/openviking
```

### 升级

- **扩展**：`pi update --extensions`。
- **服务端**：重跑 `npx pi-openviking@latest setup` 即可。脚本按内置常量固定服务端版本（当前 `openviking==0.4.13`、`xxhash<4`），检测到版本不符会自动修正安装。上游发布新版服务端后，本扩展验证兼容性并随新版本提升该常量；`xxhash<4` 的约束在上游修复 §2.2 的编码问题前不能放松。

### 卸载

```bash
npx pi-openviking@latest uninstall
```

停止服务后删除本工具管理的全部内容：`~/.pi/openviking/`（venv、服务端配置、日志、**全部长期记忆数据**）、`~/.pi/pi-openviking.jsonc`，并执行 `pi remove npm:pi-openviking`。操作前会逐项列出并等待确认。

两处不在清理范围：上游共享目录 `~/.openviking/`（可能被其他 OpenViking 客户端使用）与 Ollama（系统级安装，用系统包管理器移除）。

---

## 4. 凭证

按以下顺序解析，先命中者生效：

1. `OPENVIKING_*` 环境变量（`OPENVIKING_URL`、`OPENVIKING_API_KEY` 等）
2. `~/.pi/openviking/ovcli.conf`（`npx pi-openviking@latest credentials` 生成）
3. `~/.pi/openviking/ov.conf`（服务端配置，见 §4.1）

本地 dev 模式最简用法：

```bash
export OPENVIKING_URL=http://127.0.0.1:1933
```

### 4.1 服务端配置（ov.conf）

`~/.pi/openviking/ov.conf` 由 setup 生成，是**严格 JSON（不支持注释）**。编辑后重跑 `npx pi-openviking@latest setup`，doctor 会自动验证。

| 键 | 说明 |
|---|---|
| `storage.workspace` | 服务端数据目录（长期记忆、向量索引），默认 `~/.pi/openviking/data` |
| `server.host` / `server.port` | 监听地址，默认 `127.0.0.1:1933`（仅本机、dev 模式无认证） |
| `server.root_api_key` | 绑定 `0.0.0.0`（Docker/局域网）时必填，设置后自动切换为 API key 认证；本机模式不要设 |
| `embedding.dense` | 向量嵌入：`provider` / `model` / `api_key` / `api_base` / `dimension`。默认预填零依赖本地模型（`provider: "local"`，约 24MB，首次启动自动下载）。**改 `dimension` 会使已有向量索引失效，需重建数据** |
| `vlm` | 记忆模型（**必填**）：`provider` / `model` / `api_key` / `api_base` / `temperature` / `max_retries` / `timeout`。不配置则记忆抽取与上下文接管不生效（§2.3） |

**`vlm.provider` 完整取值**（对应服务端 `openviking/models/vlm/backends/` 的实现）：

| provider | 用途 | 凭证 |
|---|---|---|
| `volcengine` | 火山引擎 Ark / BytePlus | API key |
| `openai` | OpenAI API | API key |
| `openai-codex` | **复用 Codex CLI 订阅**（OAuth） | 无需 api_key，见下 |
| `kimi` | Kimi 编程订阅 | 订阅 API key |
| `glm` | GLM 编程订阅 | 订阅 API key |
| `litellm` | 任意 OpenAI 兼容端点（含 Ollama、OpenRouter、自部署网关） | 视端点而定 |

`embedding.dense.provider` 完整取值：`openai`、`volcengine`、`vikingdb`、`jina`、`ollama`、`gemini`、`voyage`、`dashscope`、`minimax`、`cohere`、`litellm`、`local`。

vlm 还支持多凭证故障转移：`providers: { "<名字>": { provider/model/api_key/api_base } }` + `default_provider: "<名字>"`，主凭证失败后按配置切换。

**火山引擎**（模板默认，只需填 `api_key`）：

```json
"vlm": { "provider": "volcengine", "model": "doubao-seed-2-0-code-preview-260215", "api_key": "<ARK_API_KEY>", "api_base": "https://ark.cn-beijing.volces.com/api/v3" }
```

**OpenAI**（embedding 也要换成 API 模式）：

```json
"embedding": { "dense": { "provider": "openai", "model": "text-embedding-3-small", "api_key": "<KEY>", "api_base": "https://api.openai.com/v1", "dimension": 1536 } },
"vlm": { "provider": "openai", "model": "gpt-5.4", "api_key": "<KEY>", "api_base": "https://api.openai.com/v1" }
```

**Ollama 本地**（先装 Ollama 并 `ollama pull` 对应模型）：

```json
"embedding": { "dense": { "provider": "ollama", "model": "qwen3-embedding:0.6b", "api_base": "http://localhost:11434/v1", "dimension": 1024 } },
"vlm": { "provider": "litellm", "model": "ollama/<模型名>", "api_key": "no-key", "api_base": "http://localhost:11434" }
```

**复用 Codex CLI 订阅**（已用 `codex` 登录过本机则零配置，服务端运行时自动导入 OAuth 并刷新）：

```json
"vlm": { "provider": "openai-codex", "model": "gpt-5.4", "api_base": "https://chatgpt.com/backend-api/codex" }
```

令牌缓存写在 `~/.pi/openviking/codex_auth.json`（由 setup 通过 `OPENVIKING_CODEX_AUTH_PATH` 固定在该位置；源凭证读取 `$CODEX_HOME/auth.json`，默认 `~/.codex/auth.json`）。

**Kimi 编程订阅**：

```json
"vlm": { "provider": "kimi", "model": "kimi-code", "api_key": "<订阅 KEY>", "api_base": "https://api.kimi.com/coding" }
```

**GLM 编程订阅**：

```json
"vlm": { "provider": "glm", "model": "glm-4.6v", "api_key": "<订阅 KEY>", "api_base": "https://api.z.ai/api/coding/paas/v4" }
```

**任意 OpenAI 兼容端点**：`provider: "litellm"` + 自定义 `api_base` / `api_key`（Ollama 见上例）。

---

## 5. 配置参考

包内 `config.json`（出厂默认）与上游默认值不同的三项；用户覆盖写到 `~/.pi/pi-openviking.jsonc`，优先级更高：

| 键 | 本文件取值 | 上游默认 | 原因 |
|---|---|---|---|
| `takeover.tokenThreshold` | `20000` | `30000` | 见 §5.1 |
| `takeover.overviewBudget` | `16000` | `3000` | 见 §5.2 |
| `sessionScopedMemory` | `true` | 无此键 | 见 §6.1 |

### 5.1 阈值与保留轮数

`tokenThreshold: 20000` + `keepRecentTurns: 3` 是针对**工具密集编程负载**实测得出的取值。

在 12 轮工具密集任务、每格重复 3 次的对照中：

| 配置 | 边界推进 | payload 均值 | 工具输出保真 |
|---|---|---|---|
| t30000-k3（上游默认） | 1 / 2 / 2 | 148,883 | 3/3 |
| t20000-k1 | 3 / 3 / 4 | 119,835 | **2/3** |
| t20000-k3（本取值） | 3 / 3 / 3 | 108,371 | 3/3 |

选择依据是**稳定性与保真，不是成本**：三者成本差异未达统计显著（上游默认的变异系数为 32%，样本量 n=3 支撑不了成本结论）。上游默认在同一负载下压缩次数在 1–2 次之间波动、峰值在 197K–292K 之间波动；本取值稳定压缩 3 次、峰值波动 ±7%。

**`keepRecentTurns` 不要调到 1。** 实测 3 次中有 1 次丢失了只出现在工具输出里的精确值，且模型给出的是一个格式正确但内容错误的答案，而非承认不知道。

对话为主、工具很少的负载下，两种配置差异在方差之内，不需要调整。

### 5.2 `overviewBudget` 必须足够大

`GET /sessions/{id}/context?token_budget=N` 对归档概览是**全有或全无**返回：概览放不进预算就返回空字符串，不会截断。

实测同一份 14,436 字符的概览：

| `token_budget` | 返回长度 |
|---|---|
| 1000 / 3000 / 4000 / 6000 / 8000 | 0 |
| 16000 | 14,435 |

上游默认 `3000` 在概览长大后会持续拿到空值，扩展据此判定「overview not ready」并 fail-open，**边界永不推进、上下文无界增长**，而日志只有一行 `overview not ready`，看起来与正常重试无异。

---

## 6. 相对上游的改动

共 7 个文件、103 行。分两类。

### 6.1 会话级记忆隔离（`sessionScopedMemory`）

上游把长期记忆写在 `viking://user/<user_id>` 下，同一用户的所有会话共享。开启本项后，扩展在 `session_start` 时把命名空间绑定为 `<user>--pi-<piSessionId>`。

隔离需要**两层**，缺一不可：

1. `client.ts` 的 `bindUser()` 改写 `X-OpenViking-User`，约束服务端的记忆语义操作（抽取写入、recall、profile 注入）。
2. `tools.ts` 的 `scopeSearch()` / `denyOutside()` 钳制工具层。**服务端的 user 头不约束对任意 `viking://` URI 的直接访问**——只改头的话，`viking_search` 默认仍在全局根搜索，会命中其它会话。

越界访问返回明确拒绝而非静默改写，避免模型误以为自己看到的是全局视图。

绑定发生在 `sync.ensureSession()` 之前。**时序不能改**：晚一步，前几个请求就落进共享空间。

行为后果：pi 会话 id 在 `pi -c` / `pi -p` 之间稳定，长任务持续累积到同一命名空间；**新会话或 fork 从空记忆开始**。

关闭方式：`"sessionScopedMemory": false`，恢复上游的跨会话共享行为。

### 6.2 工具结果捕获修复

上游在 pi 下**不会把工具结果同步到 OpenViking**。

`lib/capture-adapter.mjs` 的 `normalizeRole()` 只做小写化。pi 发出的 role 是 `toolResult`（camelCase），小写后为 `toolresult`，匹配不到任何分支，条目在进入捕获前即被丢弃。该函数已为 `toolcall` 特判过 camelCase，唯独漏了结果侧。这个共享模块同时服务 Claude Code / Codex / OpenCode（均为 snake_case），所以上游不会暴露此问题。

后果有三层：

1. 工具输出既不在归档、也在边界推进时被 `transformContext` 丢弃，只能靠重新执行命令找回。
2. `pendingTokens` 只统计已同步内容，在工具密集负载下低估约 5 倍，接管在编程场景中基本不触发。
3. `captureToolResults` 无法作为补救——它只在 `config.ts` 中声明了类型与默认值，逻辑代码从不读取，是个空开关。

修复后同一份 3 轮工具密集负载的实测：

| | 修复前 | 修复后 |
|---|---|---|
| 累计同步 token | 2,228 | 5,428 |
| 带 `tool_output` 的 tool 部件 | 0 / 6 | 4 / 8 |

`shared/capture-utils.mjs` 中 `normalizeType()` 的 camelCase 拆分修的是同一类问题在并行路径上的表现。**该处未单独隔离验证是否独立必需**；已证实必需的是 `lib/capture-adapter.mjs` 那一处。

---

## 7. 验证

### 7.1 确认压缩真的发生

```bash
export OV_DEBUG_LOG=/path/to/ov.log
```

关注三行，缺一说明未生效：

```
turn_end: synced N entries, ~M tokens      # 捕获在跑
commit: session=... ok=true                # 提交成功
takeover: boundary advanced to K user turns # 边界真的推进了
```

只有 `commit ok=true` 而没有 `boundary advanced`，通常是 §5.2 的 `overviewBudget` 问题。

### 7.2 确认隔离生效

新开一个会话，只放开 viking 工具：

```bash
pi -e .../pi-openviking/index.ts -t viking_search,viking_read,viking_browse \
   -p --session-id <新会话> "用 viking_search 查<另一会话里的内容>；再用 viking_browse 列出 viking:// 根目录"
```

预期：搜索返回 `No results found.`，浏览返回 `Refused: ... is outside this session's memory namespace (...)`。

---

## 8. 故障排查

| 现象 | 检查 |
|---|---|
| 页脚显示 `OV ✗` | `curl <endpoint>/health`；确认 `OPENVIKING_URL` |
| 日志反复 `overview not ready`，边界不推进 | 提高 `takeover.overviewBudget`（§5.2） |
| `search/recall` 恒为 0 候选 | 服务端 xxhash 版本（§2.2） |
| 提交后不生成概览 | `openviking-server doctor` 的 `VLM` 是否 PASS |
| 工具输出无法回忆 | 确认 §6.2 的修复在位 |
| 扩展未加载 | `pi list` 是否列出该扩展 |

---

## 9. 已知边界

- **成本结论依赖计价模型。** §5.1 的对照中，token 量为实测，任务侧成本是按较昂贵模型重新加权得到的，假设同族模型 token 数可迁移。
- **调参结论与负载绑定。** §5.1 的取值来自工具密集编程负载。同一套指标在助手文本密集的负载下曾得出相反的推荐，不要跨负载迁移。
- **许可证分层。** 本扩展源自上游 `examples/`（Apache-2.0），按 Apache-2.0 发布。OpenViking 服务端主程序自 0.3 起为 AGPL-3.0：自行部署自用不产生义务；对外提供网络服务时，义务由服务端部署者承担，与本扩展的分发无关。
