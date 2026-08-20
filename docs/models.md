# 模型配置与变更手册

## 文档职责

**架构定位**：Pi 任务模型与 OpenViking embedding/VLM 的配置方式、凭证边界和变更流程的权威手册。

**核心目标**：维护者只依赖仓库、本机 CLI 和本文即可选择、配置、切换并验证模型，不再为同类变更重新搜索外部资料。

**职责边界**：本文维护 provider、配置字段、认证方式、动态枚举方法和执行流程；当前开发模型身份只由
[`dev/model-profile.json`](../dev/model-profile.json) 维护，外部版本只由 `package-lock.json` 与
`shared/toolchain.mjs` 维护，阶段是否通过只由 [`docs/roadmap.md`](./roadmap.md) 和对应 live gate 维护。
模型市场目录、账户授权和 deployment ID 是动态事实，不复制为静态清单。

## 基本原则

1. **provider 配置是稳定结构，model ID 是动态输入。** 本文完整列出当前 Pi/OpenViking 支持的配置方式；具体模型必须从本机目录或供应商账户 inventory 取得，不能猜测。
2. **一个当前身份只有一个事实源。** 仓库开发使用 `dev/model-profile.json`；生成的 `.dev/runs/openviking/ov.conf` 不手工修改。
3. **任务模型和 VLM 是独立职责。** 即使 provider/model 相同，也分别验证 Pi 调用和 OpenViking 调用。
4. **不通过参数绕过 profile。** `npm run dev -- pi` 禁止覆盖 `--provider`、`--model`、`--models` 和 `--api-key`。
5. **凭证不进入 Git、日志、状态文件、测试输入或 artifact。** readiness 使用不输出 secret 的命令；API key 只经子进程环境桥接；Pi OAuth 只引用用户 auth store；OpenViking OAuth 使用自身受管 store。
6. **配置检查不等于模型能力检查。** schema、doctor 和 health 通过后仍须执行最小真实请求；涉及阶段结论时继续运行对应 live gate。

## 一次完整的仓库模型变更

常见变更的最短路径：

| 变更 | 最短路径 |
| --- | --- |
| 换任务模型（ID、provider 或凭证方式） | 用户提出变更 → `pi auth check` 核对可用 → 改 `dev/model-profile.json` 并重启 `dev pi`；不可用即提示用户自行 `/login <provider-id>`，仓库不代为登录、不回退 |
| 换 VLM provider/model/apiBase | 核对凭证可用（未就绪提示用户按第 4 步完成认证）→ 改 profile → `down` → `bootstrap` → `up` → `status` + `vlm-probe` |
| 换 embedding | 改 profile 并决定既有向量是否重建 → `down` → `up` → 真实召回验证 |

细节不确定时回到下面的完整流程。

### 1. 确定本地版本与目标身份

```bash
npm exec -- pi --version
node -p "require('./node_modules/@earendil-works/pi-coding-agent/package.json').version"
node -e "import('./shared/toolchain.mjs').then(({TOOLCHAIN}) => console.log(TOOLCHAIN.openvikingVersion))"
```

版本不一致时先按 [`docs/development.md`](./development.md) 的依赖升级流程处理；模型配置必须与当前 lock/pin 对应。

### 2. 枚举 Pi 模型，不猜 model ID

```bash
# 只列当前 agent dir 中已认证 provider 的可用模型
PI_OFFLINE=1 npm exec -- pi --list-models
PI_OFFLINE=1 npm exec -- pi --list-models <provider-id>

# 不受凭证过滤：静态目录 + models-store.json overlay + models.json
PI_OFFLINE=1 node --input-type=module -e '
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
const runtime = await ModelRuntime.create({ allowModelNetwork: false });
for (const model of runtime.getModels()) console.log(`${model.provider}\t${model.id}`);
'
```

需要刷新动态目录时执行：

```bash
npm exec -- pi update --models
```

该命令联网并更新 `$PI_CODING_AGENT_DIR/models-store.json`。`--list-models` 是 fuzzy search，输出列依次为
`provider model context max-out thinking images`。SDK 枚举不加载 extension-only provider；`llama.cpp` 必须从正常 Pi
运行时读取当前 router 已加载模型。

### 3. 从账户 inventory 取得 OpenViking 模型参数

OpenViking 不维护完整云模型目录。按 provider 取得精确值：

- OpenAI-compatible：优先调用账户 endpoint 的 `/models`；不支持时由账户控制台提供；
- Azure：使用 deployment name，而不是基础模型展示名；
- VolcEngine/VikingDB：使用当前账户、region 的 endpoint/model/version；
- Ollama：`ollama list`；
- LiteLLM：使用当前安装版本可解析的 route，如 `bedrock/...`、`vertex_ai/...`；
- Codex、Kimi、GLM：使用当前订阅实际允许的 model ID；
- embedding：同时确认输出 dimension、输入类型和 query/document 语义。

### 4. 核对可用性；认证是用户的动作

录入 API key 和 `/login` OAuth 都由用户在自己的 Pi 中完成；仓库流程不代为登录、不获取凭证、未就绪时不回退到其他身份，只执行只读核对：

```bash
npm exec -- pi auth check \
  --provider <provider-id> \
  --model <exact-model-id> \
  --json --no-refresh
```

check 未通过即停止，提示用户自行 `/login <provider-id>` 后重试。`--no-refresh` 不更新 OAuth，需要正常刷新时去掉它；`--credentials` 会输出 secret，禁止使用。

OpenViking API-key provider 复用同一 Pi 登录态经 `print-api-key` 桥接，因此用户的一次登录同时覆盖任务模型与 VLM；Codex OAuth 的 store 隔离与 bootstrap 边界见下文 Codex OAuth 一节。

### 5. 修改唯一身份源

`dev/model-profile.json` 形状：

```json
{
  "taskModel": {
    "provider": "<pi-provider>",
    "model": "<exact-model-id>",
    "credentialKind": "api_key",
    "apiKeyEnv": "<PROVIDER_API_KEY_ENV>"
  },
  "vlm": {
    "provider": "<openviking-provider>",
    "model": "<exact-model-or-deployment-id>",
    "apiBase": "<endpoint>",
    "credentialKind": "api_key",
    "apiKeyEnv": "<PROVIDER_API_KEY_ENV>"
  },
  "embedding": {
    "dense": {
      "provider": "local",
      "model": "<local-model>",
      "dimension": 512
    }
  }
}
```

OAuth 身份把 `credentialKind` 改为 `oauth` 并省略 `apiKeyEnv`。任务模型可使用 Pi 支持的 OAuth provider；OpenViking 侧的 OAuth 能力边界见下文 VLM 配置参考的凭证路径。变更 embedding 时必须同时决定现有向量是否重建。

### 6. 应用、验证与回退

```bash
node --test test/dev-bootstrap.test.mjs test/dev-lifecycle.test.mjs test/sync-live-verifier.test.mjs
npm run dev -- down
npm run dev -- bootstrap
npm run dev -- up
npm run dev -- status
npm test
git diff --check
```

重启范围由消费者决定：`taskModel` 只被 `dev pi` 读取，改动后重启隔离 Pi 即可；`vlm` 与 `embedding` 进入 `ov.conf`，改动后必须
`down`/`up`，否则 `status`、`dev pi` 与 live preflight 的配置指纹核对会 fail-fast。

最小真实任务模型请求：

```bash
npm run dev -- pi -- --no-session --no-tools -p 'Reply with exactly OK.'
```

VLM 的 doctor 只证明配置和 credential 可用，不发送 completion。最小真实 Session/Task 请求使用随机身份，
证明 task 完成且 working-memory overview 非空后，确认 Task 已终止并删除所属 Session：

```bash
npm run dev -- vlm-probe
```

模型变更影响阶段结论时，运行该阶段对应的 live gate；阶段与 gate 的对应关系由 [`docs/roadmap.md`](./roadmap.md) 维护。

模型身份改变会使既有 accepted baseline 失去适用性。先比较新实测与原阈值，再更新 live manifest/hash 和
`docs/roadmap.md`；不能为了让新模型通过而先放宽门限。失败时恢复 `dev/model-profile.json`，执行 `down`/`up`，并再次
核对 `status`。

## Pi 模型配置参考

### 认证存储与优先级

默认 agent dir 是 `~/.pi/agent`，由 `PI_CODING_AGENT_DIR` 覆盖：

```text
$PI_CODING_AGENT_DIR/auth.json          # API key / OAuth
$PI_CODING_AGENT_DIR/models-store.json  # 动态目录缓存
$PI_CODING_AGENT_DIR/models.json        # 自定义 provider/model
```

凭证优先级：

1. CLI `--api-key` runtime override；
2. `auth.json`；
3. 环境变量或 AWS/Google ambient credential；
4. `models.json` provider 的 `apiKey`。

API-key credential 可在 `auth.json` 使用 literal、`$ENV`/`${ENV}`、`!command` 和 provider-scoped `env`。OAuth credential
由 `/login` 管理 access/refresh/expiry；不要手工构造或复制 token。

### Pi 内建 provider 与认证

下表覆盖当前 `pi-ai` 内建 provider；`llama.cpp` 由 Pi 内建扩展提供。provider 的具体模型用前述本地命令枚举。

| Provider | 认证方式 | 环境/ambient 配置 |
| --- | --- | --- |
| `amazon-bedrock` | API/bearer 或 AWS ambient | `AWS_BEARER_TOKEN_BEDROCK`；或 profile、access/secret、ECS、IRSA；配套 `AWS_REGION` |
| `ant-ling` | API key | `ANT_LING_API_KEY` |
| `anthropic` | API key 或 Claude OAuth | `ANTHROPIC_API_KEY`、`ANTHROPIC_OAUTH_TOKEN`、`ANTHROPIC_AUTH_TOKEN` |
| `azure-openai-responses` | Azure API key | `AZURE_OPENAI_API_KEY`；`AZURE_OPENAI_BASE_URL` 或 `AZURE_OPENAI_RESOURCE_NAME`；可选 version/deployment map |
| `baseten` | API key | `BASETEN_API_KEY` |
| `cerebras` | API key | `CEREBRAS_API_KEY` |
| `cloudflare-ai-gateway` | Cloudflare key | `CLOUDFLARE_API_KEY`、`CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_GATEWAY_ID` |
| `cloudflare-workers-ai` | Cloudflare key | `CLOUDFLARE_API_KEY`、`CLOUDFLARE_ACCOUNT_ID` |
| `deepseek` | API key | `DEEPSEEK_API_KEY` |
| `fireworks` | API key | `FIREWORKS_API_KEY` |
| `github-copilot` | token 或 OAuth | `COPILOT_GITHUB_TOKEN` 或 `/login` |
| `google` | Gemini API key | `GEMINI_API_KEY` |
| `google-vertex` | API key 或 ADC | `GOOGLE_CLOUD_API_KEY`；或 `GOOGLE_APPLICATION_CREDENTIALS`、project、location |
| `groq` | API key | `GROQ_API_KEY` |
| `huggingface` | token | `HF_TOKEN` |
| `kimi-coding` | API key 或 OAuth | `KIMI_API_KEY` 或 Kimi Code OAuth |
| `minimax` | API key | `MINIMAX_API_KEY` |
| `minimax-cn` | API key | `MINIMAX_CN_API_KEY` |
| `mistral` | API key | `MISTRAL_API_KEY` |
| `moonshotai` / `moonshotai-cn` | API key | `MOONSHOT_API_KEY` |
| `nvidia` | API key | `NVIDIA_API_KEY` |
| `openai` | API key | `OPENAI_API_KEY` |
| `openai-codex` | ChatGPT Plus/Pro OAuth | `/login openai-codex`；无普通 API-key fallback |
| `opencode` / `opencode-go` | API key | `OPENCODE_API_KEY` |
| `openrouter` | API key 或 OAuth-minted key | `OPENROUTER_API_KEY` |
| `qwen-token-plan` / `qwen-token-plan-individual` | API key | `QWEN_TOKEN_PLAN_API_KEY` |
| `qwen-token-plan-cn` | API key | `QWEN_TOKEN_PLAN_CN_API_KEY` |
| `radius` | API key 或 OAuth、动态目录 | `RADIUS_API_KEY` |
| `together` | API key | `TOGETHER_API_KEY` |
| `vercel-ai-gateway` | API key | `AI_GATEWAY_API_KEY` |
| `xai` | API key 或 OAuth | `XAI_API_KEY` 或 Grok/X subscription OAuth |
| `xiaomi` | API key | `XIAOMI_API_KEY` |
| `xiaomi-token-plan-cn` | API key | `XIAOMI_TOKEN_PLAN_CN_API_KEY` |
| `xiaomi-token-plan-ams` | API key | `XIAOMI_TOKEN_PLAN_AMS_API_KEY` |
| `xiaomi-token-plan-sgp` | API key | `XIAOMI_TOKEN_PLAN_SGP_API_KEY` |
| `zai` | API key | `ZAI_API_KEY` |
| `zai-coding-cn` | API key | `ZAI_CODING_CN_API_KEY` |
| `llama.cpp` | 本地 endpoint，可选 key | `LLAMA_BASE_URL`、`LLAMA_API_KEY`；模型由 router 实时提供 |

### Pi 选择参数

| 参数 | 作用 |
| --- | --- |
| `--provider <id>` | 约束 `--model` 的 provider；推荐始终显式给出 |
| `--model <id>` | 支持 exact ID、`provider/id`、模糊匹配和 `:<thinking>` 后缀 |
| `--models <patterns>` | 限定 `/model` 与模型循环范围；逗号分隔，支持 glob |
| `--api-key <secret>` | 最高优先级、仅当前进程；会进入 argv，仓库流程禁止使用 |
| `--thinking <level>` | `off minimal low medium high xhigh max`；高于 model/scope/settings 默认 |

模型匹配顺序是 exact、部分匹配、别名/日期偏好。裸 ID 跨 provider 歧义时必须显式 provider。显式 provider 配合未知 model
可能被当作 custom ID 延迟到请求才失败，所以必须先枚举并执行真实请求。非 reasoning 模型会把 thinking 强制为 `off`；
不支持的 level 会被模型能力映射/clamp。

### `pi auth` 边界

```bash
pi auth check --provider P --model M --json --no-refresh
pi auth print-api-key --provider P --model M
pi auth print-bearer-token --provider P --model M --min-expiry 30m
```

- `check` 不推理；默认可能刷新 OAuth并写 `auth.json`，只读检查加 `--no-refresh`；
- `print-api-key` 只适用于 API-key credential；
- `print-bearer-token` 只适用于 OAuth，必要时刷新；
- 两个 `print-*` 的 stdout 都是 secret，只能由受控父进程 pipe 捕获，不能在终端、日志或 artifact 输出；
- `check --credentials` 会输出 secret，仓库流程禁止使用。

### 仓库隔离 Pi 的 OAuth 边界

`npm run dev -- pi` 仍使用 `.dev/pi` 隔离 settings、sessions、packages 和 extensions。API key 从用户 Pi 登录态导出到子进程
环境；OAuth 不能降级为 API key，因此运行器只在 `.dev/pi/auth.json` 建立指向用户 Pi `auth.json` 的文件引用，并先验证来源
属于当前用户且权限不向 group/other 开放。引用不复制 token；目标已存在独立 auth 文件时拒绝覆盖。live gate 对自己的隔离 Pi
目录采用同一规则。

## OpenViking embedding 配置参考

当前 pin 的 schema 至少要求 `dense`、`sparse`、`hybrid` 之一；全缺省时使用本地 dense 默认。外层字段：

```text
dense, sparse, hybrid,
max_concurrent=10, max_retries=3,
text_source=content_only|summary_first|summary_only,
max_input_tokens=4096, allow_metadata_override=false,
circuit_breaker.failure_threshold=5,
circuit_breaker.reset_timeout=60,
circuit_breaker.max_reset_timeout=600
```

单模型字段：

```text
provider, model, api_key, api_base, api_version,
dimension, batch_size, input, query_param, document_param,
version, ak, sk, region, host, extra_headers, encoding_format, extra_body,
model_path, cache_dir, enable_fusion, res_level, max_video_frames,
credentials, failback_timeout_seconds, failback_request_count
```

未知字段会被拒绝。`batch_size` 虽在 schema 中，但当前 factory 未传入具体 embedder，不能作为已验证调优项。

| Provider | 类型与认证 | 关键配置 |
| --- | --- | --- |
| `openai` | dense；通常 API key；有 `api_base` 时允许本地兼容服务无 key | `encoding_format`、`extra_body`、`extra_headers`、query/document 参数 |
| `azure` | dense；`api_key`、`api_base` 必选 | `model` 是 deployment；`api_version` 默认 `2025-01-01-preview` |
| `volcengine` | dense/sparse/hybrid；API key | 默认 Ark base；`input=text|multimodal` |
| `vikingdb` | dense/sparse/hybrid；`ak/sk/region` | 可选 `host`，`version` 表示模型版本 |
| `jina` | dense；API key | 默认 Jina base；query/document task；支持 MRL dimension |
| `ollama` | dense；无认证 | 默认 `http://localhost:11434/v1`；未知模型必须显式 dimension |
| `gemini` | dense；API key | 仅文本；dimension `1..3072`；合法 Gemini task type |
| `voyage` | dense；API key | 默认 Voyage base；dimension 作为 `output_dimension` |
| `dashscope` | dense；API key | text/原生多模态路径；fusion、resolution、video frame 配置 |
| `minimax` | dense；API key | 默认 query/document=`query`/`db`；GroupId 放 `extra_headers` |
| `cohere` | dense；API key | query/document 映射为 `search_query`/`search_document` |
| `litellm` | dense；key 可选或 ambient | dimension 必须显式；model 使用 LiteLLM route |
| `local` | dense；无认证 | registry GGUF；`model_path`/`cache_dir`；dimension 必须精确匹配 |

embedding `credentials` 按数组顺序 failover，每项可覆盖：

```text
id, provider, model, api_key, api_base, api_version,
ak, sk, region, host, extra_headers
```

所有 credential 必须返回同一 dimension 和同一向量语义空间。dimension 相同不证明语义兼容。更换 embedding 模型后：dimension
变化必须重建；dimension 不变但模型变化通常也应重新 ingest，`allow_metadata_override` 不能修复语义漂移。

## OpenViking VLM 配置参考

当前 pin 的 canonical provider：

```text
volcengine, openai, azure, kimi, glm, litellm, openai-codex
```

凭证只有两条路径：

- `api_key`：`volcengine`/`openai`/`azure`/`kimi`/`glm` 必填，`litellm` 可用 ambient 环境变量。仓库流程从同一 Pi 登录态经 `print-api-key` 桥接进子进程环境，`ov.conf` 只写 `${ENV}` 占位；
- OAuth 订阅凭证 store：**仅 `openai-codex` 提供**，store 由 OpenViking 自己维护（见下节）。kimi/glm 是 Coding endpoint 的 API key，不是 OAuth；embedding 没有任何 OAuth 机制。

其他供应商使用显式 `provider: "litellm"` 和 LiteLLM route，不依赖未知 provider 的隐式 fallback。通用字段：

```text
provider, model, api_key, api_base, api_version,
temperature=0.0, max_retries=3, timeout=600, max_tokens,
thinking=false, max_concurrent=32, forward_api_key,
extra_headers, extra_request_body, stream, media,
credentials, failback_timeout_seconds=600, failback_request_count=50,
providers, default_provider
```

一旦有任何 VLM 配置，顶层 `model` 必填。`ov.conf` 是严格 JSON，但加载前执行环境变量展开，因此 secret 使用
`"api_key": "${ENV_NAME}"`；未定义变量不会自动变成空值。

| Provider | 认证 | endpoint/模型语义 |
| --- | --- | --- |
| `volcengine` | API key | 默认 Ark base；支持 thinking；唯一原生音视频 backend |
| `openai` | API key | OpenAI 或兼容 endpoint；支持 headers/body/stream |
| `azure` | API key，运行时 base 必选 | model 是 deployment；API version 默认值同上 |
| `kimi` | API key | 默认 Kimi Coding base；自动 User-Agent |
| `glm` | API key | 默认 Z.AI Coding base |
| `litellm` | key 可选、环境或 AWS/GCP ambient | 使用可解析 route；`forward_api_key` 控制 key 转发 |
| `openai-codex` | 显式 bearer 或 Codex OAuth | 默认 `https://chatgpt.com/backend-api/codex`；走 Responses adapter |

VLM `credentials` 按顺序调用，每项可覆盖：

```text
id, provider, model, api_key, api_base, api_version,
forward_api_key, extra_headers, extra_request_body, stream, max_tokens
```

`401/403`、quota、retry 耗尽的 transient/unknown 可切换；请求参数、输入过大、内容安全等请求级错误不切换。到达
`failback_timeout_seconds` 或 `failback_request_count` 后逐级尝试主 credential。多凭证配置统一使用 `credentials`。

### 图片与媒体

统一 vision 接口不证明模型支持图片，必须真实调用确认。`vlm.media`：

```text
enabled=false, max_concurrent=2,
file_processing_timeout=1800, file_poll_interval=3,
video_fps=1.0 (0.2..5.0)
```

当前 pin 只有 VolcEngine 提供原生音视频处理；图片路径可由其他 VLM backend 支持，但取决于具体模型。

### Codex OAuth

OpenViking store：

```text
~/.openviking/codex_auth.json
```

默认导入源：

```text
${CODEX_HOME:-~/.codex}/auth.json
```

环境覆盖：

```text
OPENVIKING_CODEX_AUTH_PATH
OPENVIKING_CODEX_BOOTSTRAP_PATH
OPENVIKING_CODEX_BASE_URL
OPENVIKING_CODEX_OAUTH_ISSUER
OPENVIKING_CODEX_OAUTH_TOKEN_URL
OPENVIKING_CODEX_OAUTH_CLIENT_ID
CODEX_HOME
```

首次使用：

```bash
openviking-server init
openviking-server doctor
```

导入的 credential 标记为 external，token 即将过期时优先重新读取 Codex CLI auth；OpenViking 自建 credential 会自行 refresh。
显式 `vlm.api_key` 高于 OAuth。仓库开发服务不把 OAuth token 写进 `.dev/ov.conf` 或进程环境；它使用独立的
`~/.openviking/pi-openviking-dev/codex_auth.json`，并显式从 `${CODEX_HOME:-~/.codex}/auth.json` bootstrap，
避免读取或覆盖用户默认的 `~/.openviking/codex_auth.json`。

## 最终用户服务模型变更

最终用户配置路径由 [`docs/usage.md`](./usage.md) 维护。通用顺序：

```bash
$EDITOR ~/.pi/openviking/ov.conf
npx pi-openviking@latest server doctor
npx pi-openviking@latest server restart
npx pi-openviking@latest server status
```

`doctor` 会真实调用非 local embedding 并核对向量长度；VLM 只检查配置和 credential availability，不发送 completion。
因此变更 VLM 后仍需执行真实 Session/Task 或等价 completion。`status` 必须显示运行配置与当前配置指纹一致。

## 常见失败诊断

1. `credentials_not_configured`：先确认实际 `PI_CODING_AGENT_DIR`；默认用户已登录不代表另一个隔离目录自动可用。
2. `provider_not_found`：provider 拼写错误、扩展未加载或当前 lock 不支持。
3. model 不可见：先离线枚举，再检查 `models-store.json`、`PI_OFFLINE`、代理和账户授权；不要猜 ID。
4. OpenViking schema 失败：检查未知字段、API base、deployment、dimension 和 `${ENV}` 是否实际展开。
5. doctor 通过但请求失败：doctor 不验证 VLM completion；检查模型权限、视觉能力、上下文、stream/body 兼容和 endpoint。
6. 延迟长尾：从 OpenViking 日志与统一观察记录区分供应商错误、重试等待和模型计算；不先放宽门限。
7. embedding 更换后召回异常：检查 collection 是否与当前 embedding 身份和向量语义一致。
8. OAuth 过期：Pi 使用正常 `auth check` 触发刷新；Codex external owner 先让 Codex CLI 刷新，再重启/重试 OpenViking。

## 维护规则

- Pi provider/auth 结构变化：以当前 lock 中 `pi-ai` 的 `dist/types.d.ts`（`KnownProvider`）与 `dist/providers/all.js`（各 provider 的 `oauth` 定义）、Pi `docs/providers.md`/`docs/models.md` 和本地 CLI 重新核对本文；注意 Pi 自带文档可能滞后于 registry，以代码为准；
- OpenViking provider/schema 变化：以 `shared/toolchain.mjs` pin 对应安装中的 `models/vlm/registry.py`（`VALID_PROVIDERS`）、`models/vlm/backends/codex_auth.py` 与 `openviking_cli/utils/config/`（`vlm_config.py`、`embedding_config.py`）重新核对本文；
- OpenViking 新增 OAuth provider 时：在 [`shared/openviking-oauth.mjs`](../shared/openviking-oauth.mjs) 注册表新增一条注册项（label、store 文件名、pin/bootstrap 环境变量、bootstrap 源、就绪探测），消费方无需改动；同步聚焦测试、本文与 `docs/development.md`。注册表镜像的是上游能力边界，不是仓库偏好；
- 只替换 model ID：仅修改当前身份源和 live evidence，不修改 provider 章节；
- 新增 provider/credential kind 或改变凭证边界：同步 `scripts/dev.mjs`、聚焦测试、本文和 `docs/development.md`；
- 不把一次运行结果、用户账户 inventory 或凭证写进本文。
