# 开发环境

## 文档职责

**架构定位**：本仓库开发环境的权威手册。

**核心目标**：在任意一台机器上克隆仓库后，能安装依赖、获得可用的 OpenViking endpoint、进入隔离 Pi、
切换模型身份并安全清理。

**职责边界**：本文只定义环境本身及其运行方式。目标架构与模块职责见 [`docs/design.md`](./design.md)，
阶段顺序与验收见 [`docs/roadmap.md`](./roadmap.md)，证据类型与 live gate 契约见
[`docs/verification.md`](./verification.md)。
精确版本由 `package.json`、`package-lock.json` 与 `scripts/toolchain.mjs` 的 `TOOLCHAIN` 维护，本文不建立
第二份版本清单；供应商目录与可用 model ID 由本机 CLI 与供应商账户按需取得，本文不维护静态清单。

## 环境边界

开发环境只负责三件事：

1. **装得出来**：把固定版本的 uv、托管 Python 与 OpenViking 安装到仓库内 `.dev/toolchain`；
2. **起得来**：运行与用户服务完全隔离的 OpenViking 开发服务；
3. **调得通**：进入隔离 Pi，任务模型与服务端模型凭证可用。

## 标准流程

```bash
npm ci                        # 安装 Node 依赖，含 Pi CLI
npm run dev -- bootstrap      # 安装受管工具链，幂等，不启动服务
npm run dev -- up             # 启动隔离 OpenViking 服务
npm run dev -- status         # 工具链、服务与凭证状态
npm run dev -- pi             # 进入隔离 Pi，附加参数透传给 pi
npm run dev -- down           # 停止服务，保留数据
```

`status` 显示当前 endpoint、进程身份与凭证就绪情况，是环境问题的第一诊断入口。

## 目录与数据边界

```text
dev/                      # tracked：机器事实
└── model-profile.json    # 开发与验证的模型身份

.dev/                     # gitignored：全部运行时产物
├── toolchain/            # 固定 uv、托管 Python、venv
├── openviking/           # workspace、ov.conf、ownership marker、PID、日志、状态、embedding 缓存
├── pi/                   # 隔离 PI_CODING_AGENT_DIR
└── gates/                # live gate 运行目录（gate 结束时断言清理）
```

`.dev/` 可整体删除，由 `bootstrap` 与 `up` 重建；重建会重新下载 embedding 模型。凭证不写入上述任一目录。

## 仓库工具

`scripts/` 只放仓库开发与维护使用的可执行工具及其原语：

| 文件 | 职责 |
| --- | --- |
| `dev.mjs` | 开发环境入口 |
| `toolchain.mjs` | 受管工具链的安装原语，按 home 参数化且不做决策 |
| `openviking-oauth.mjs` | 服务端模型的 OAuth provider 注册表 |

面向最终用户的产品命令随其所属模块放置，见 [`docs/design.md`](./design.md)「源码组织」；测试探针与
gate 设施放在 `test/live/helpers/`，见 [`docs/verification.md`](./verification.md)。

这三个文件都用于安装、启动或配置开发环境，因此直接放在 `scripts/` 下。某组脚本需要单独入口并独立修改时，再按
这组脚本负责的工作建立子目录。

## 开发模型身份

`dev/model-profile.json` 是模型身份的唯一事实源。三个字段分别交给不同程序，即使当前值相同，也可能分别修改：

| 字段 | 使用它的程序 | 用途 |
| --- | --- | --- |
| `taskModel` | 隔离 Pi | agent loop 的任务模型 |
| `vlm` | OpenViking 服务端 | 生成服务端内容理解、记忆提取与语义摘要，供 OpenViking 索引、搜索和读取使用 |
| `embedding.dense` | OpenViking 服务端 | 向量索引与语义检索 |

`vlm` 与 `embedding` 是 [`docs/design.md`](./design.md)「外部责任边界」所述部署前提的具体配置：它们写入
`ov.conf` 由服务端使用，不经过扩展进程。

`dev pi` 显式传入 `taskModel` 的 provider 与 model，并拒绝命令行覆盖——`--provider`、`--model`、
`--models` 与 `--api-key` 都会被拒绝。

## 凭证边界

两类凭证保持不同路径，都不进入仓库、日志与状态文件：

- **任务模型**（Pi）：使用 OAuth 时，隔离 Pi 的 `auth.json` 与用户 Pi auth store 引用同一个凭证文件，因此不复制
  token。创建引用前，先确认源文件属于当前用户且只有当前用户可以访问；如果隔离 Pi 已有独立的 `auth.json`，
  则拒绝覆盖。
- **服务端模型**（OpenViking）：`ov.conf` 不写凭证值；服务进程通过环境变量获得 store 路径与 bootstrap
  源，provider 注册项见 `scripts/openviking-oauth.mjs`。OAuth store 位于
  `~/.openviking/pi-openviking-dev`（0700），是唯一有意位于仓库外的运行时状态（凭证不进入仓库），由
  OpenViking 服务按 bootstrap 源填充。就绪探测由受管 Python 执行，stdout 不输出凭证。

用户为某个身份完成登录，即构成该身份用于本仓库开发与验证的授权。以下变化需要重新取得用户决定：
`taskModel` 的 provider 或 model 改变、`vlm` 的 provider、model 或 api base 改变、`embedding` 的 provider、
model 或 dimension 改变、`taskModel` 或 `vlm` 的 `credentialKind` 或 `apiKeyEnv` 改变，以及超出本仓库开发与
`docs/roadmap.md` 阶段验证范围的调用。

## 模型切换

变更前先按「凭证边界」确认该变更是否需要重新取得用户决定。

**1. 枚举可用 model ID**

```bash
PI_OFFLINE=1 PI_CODING_AGENT_DIR=.dev/pi npm exec -- pi --list-models [provider]
```

输出列依次为 `provider model context max-out thinking images`。需要刷新动态目录时先执行
`npm exec -- pi update --models`，它联网并写入 `$PI_CODING_AGENT_DIR/models-store.json`。

**2. 核对可用性**

```bash
PI_CODING_AGENT_DIR=.dev/pi npm exec -- pi auth check --provider <id> --model <id> --json --no-refresh
```

`status` 非 `ready` 时停止，并提示用户自行 `/login <provider>`；仓库流程不代为登录，也不回退到其他
provider 或账户。`--no-refresh` 保持只读；`--credentials` 会输出凭证值，不使用。

**3. 修改 `dev/model-profile.json`**

`credentialKind` 为 `api_key` 时必须给出 `apiKeyEnv`。`vlm` 使用 `oauth` 时，provider 必须在
`scripts/openviking-oauth.mjs` 的注册表中——OpenViking 的订阅凭证 store 按 provider 各自定义，注册表之外的
provider 没有可用的 store 路径，`dev` 的任一命令都会在加载 profile 时拒绝。

**4. 按生效路径决定重启范围**

| 变更字段 | 生效路径 | 重启范围 |
| --- | --- | --- |
| `taskModel` | `dev pi` 的启动参数 | 退出后重新 `npm run dev -- pi` |
| `vlm`、`embedding` | `up` 生成的 `.dev/openviking/ov.conf` | `npm run dev -- down` 后 `npm run dev -- up` |

变更 `embedding` 的 provider、model 或 dimension 时，一并决定 `.dev/openviking/data` 中的既有向量是否重建。

**5. 验证**

`npm run dev -- status` 报告的模型身份与凭证状态应与 profile 一致，再用一次真实请求确认任务模型可用：

```bash
npm run dev -- pi --no-session --no-tools -p 'Reply with exactly OK.'
```

## 隔离与所有权

开发服务绑定 loopback，使用独立 workspace、`ov.conf`、PID、日志与状态文件，不复用用户 `~/.openviking`
的数据或进程。

`up` 使用随机 nonce 创建 ownership marker 和状态文件。`down` 停止进程前必须依次确认：

1. marker 与状态文件中的 nonce 一致；
2. PID 文件与状态文件中的 PID 一致；
3. 该进程的命令行指向本次 run 目录中的 `ov.conf`。

三项全部通过后，`down` 才停止整个进程组；任一项失败时，拒绝停止并报告原因。不支持在缺少 marker 时强制清理。

`down` 只停止进程，不删除数据；环境损坏时删除 `.dev/` 后重新 bootstrap。

隔离 Pi 使用 `PI_CODING_AGENT_DIR=.dev/pi`，session、settings 与扩展全部由它派生，用户 `~/.pi` 的会话
数据不受影响。

## 扩展开发循环

扩展入口 `src/index.ts`（见 [`docs/design.md`](./design.md)「源码组织」）存在时，`dev pi` 在
`.dev/pi/extensions/` 下生成加载它的 wrapper，使 Pi 的 `/reload` 可用；不存在时跳过生成，并在启动信息中
标明扩展状态。

```text
修改扩展源码 → /reload → 观察 Pi 行为与 .dev/openviking/server.log
```

`/reload` 先触发 `session_shutdown`，再重载扩展并触发 `session_start`，因此它同时是连接释放与状态重建
的观察点。交互调试使用持久 session，其 JSONL 位于 `.dev/pi/sessions/`。

扩展的结构化运行证据按需开启：`PI_OPENVIKING_OBSERVE=<绝对路径>` 时每次运行追加 JSONL 记录（runId、ts、
session、operation、stage、outcome、durationMs、error）；未设置时扩展不产生观察副作用。相对路径会被拒绝
并使本次扩展装配失败（callback 全部保持 inert），因为相对路径会解析到 Pi 进程的 cwd，落点不可控。

验证入口：`npm test` 运行 typecheck，以及不接触真实服务的 unit 和 repo checks；需要真实 Pi 或 OpenViking 的
检查通过 `npm run verify:<gate>:live` 运行，当前 gate 为 `run-boundary`，规则见
[`docs/verification.md`](./verification.md)。

## 升级外部版本

- OpenViking、uv、Python：`scripts/toolchain.mjs` 的 `TOOLCHAIN`；
- Node 下限与 npm 依赖：`package.json` 与 `package-lock.json`。

修改后重新 `bootstrap` 与 `up`，用 `status` 核对实际生效的版本。真实边界的行为变化按
[`docs/roadmap.md`](./roadmap.md)「阶段执行闭环」重新建立证据。
