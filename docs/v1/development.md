# Pi OpenViking 开发环境手册

## 文档职责

**架构定位**：本仓库开发环境的权威手册。

**核心目标**：在任意一台机器上克隆仓库后，能安装依赖、运行隔离服务、进入开发循环并安全清理。

**职责边界**：本文只定义环境本身。产品职责、目标架构和配置语义以 [`docs/v1/spec.md`](./spec.md) 为准，
阶段顺序与验收以 [`docs/v1/roadmap.md`](./roadmap.md) 为准，当前代码职责见
[`docs/v1/design.md`](./design.md)，最终用户操作见 [`docs/v1/usage.md`](./usage.md)。本文不复制协议字段、
存储规则或阶段验收标准；精确依赖版本由机器可验证的 lock 与安装常量维护，不在此建立第二份版本清单。

## 环境边界

开发环境只负责三件事：

1. **装得出来**：把固定版本的 uv、Python、OpenViking wheel 安装到仓库内 `.dev/`；
2. **起得来**：启动与用户服务完全隔离的 OpenViking 开发服务；
3. **调得通**：进入隔离 Pi，加载仓库扩展，模型凭证可用。

探针、workload manifest、live verifier、summary 和阶段清理断言的契约由
[`docs/v1/verification.md`](./verification.md) 定义，其实现消费本文的服务生命周期能力。

## 标准流程概览

```bash
clone
  → npm ci

# 建立仓库内开发环境：安装 uv/Python/OpenViking 到 .dev/，幂等，不启动服务
npm run dev -- bootstrap

# 启动、检查、真实调用 VLM 和停止隔离开发服务
npm run dev -- up
npm run dev -- status
npm run dev -- vlm-probe
npm run dev -- down

# 进入隔离 Pi（自动加载仓库扩展，支持 /reload；追加参数透传给 pi）
npm run dev -- pi
```

完整参数以 `npm run dev -- help` 为准；本文只保留工作流和安全边界，不复制全部 CLI flags。

## 升级外部版本

`shared/toolchain.mjs` 的 `TOOLCHAIN` 唯一维护 OpenViking、uv、托管 Python 和 zstandard 的当前
受管选择；`package.json` 维护 Node 最低版本、npm 依赖与 peer 最低兼容基线。peer 不设置预防性上限：
当前 lock 记录本仓库安装解析快照，live manifest 记录各 gate 最近一次通过时的证据身份；当前兼容边界、
运行时身份与历史证据的关系以 [`docs/v1/verification.md`](./verification.md) 为准。`npm test` 先以
`tsconfig.json` 对仓库内全部 TypeScript 源执行严格的 `noEmit` 类型检查，再运行 deterministic tests；
`skipLibCheck` 只跳过声明文件内部检查。

```bash
# 1. 修改唯一权威源
#    OpenViking / uv / Python / zstandard → shared/toolchain.mjs 的 TOOLCHAIN
#    Node / npm dependency / peer 最低基线           → package.json

# 2. 检查权威源、当前安装的宿主兼容性及受影响引用
npm test

# 3. 按报告更新当前契约；不要仅因宿主 Pi 精确版本变化改写历史 manifest
#    只有完整重跑 gate 并将结果采纳为新基线时，才更新 manifest 及对应 .sha256

# 4. 重建隔离环境并验证服务身份
npm run dev -- bootstrap
npm run dev -- up
npm run dev -- status

# 5. 重跑受影响保证的 live gate
npm run verify:sync:live
npm run verify:checkpoint:live
npm run verify:takeover:live
npm run verify:budget:live
npm run verify:observability:live
```

manifest 更新不是版本同步手续。OpenViking 等受管服务变化时，gate preflight 会用真实 `/health` 逐字核对，
因此新基线必须按 [`docs/v1/roadmap.md`](./roadmap.md)“实施顺序”的调查闭环重新建立。宿主 Pi 则由
`package.json` 的 peer range 定义当前兼容边界；manifest 继续保留建立历史证据时的 Pi 版本和 CLI 路径，
summary 记录本次实际解析并启动的 Pi 身份。只有重新执行完整 live gate 并明确采纳新结果时，才改写该历史
身份和固定 hash。完整规则见 [`docs/v1/verification.md`](./verification.md)。

`shared/toolchain.mjs` 中记录特定版本缺陷的注释需要人工判断该缺陷在新版本是否仍然存在，不由检查覆盖；
缺陷修复后同步移除仅为绕开它而存在的约束与逻辑。

## 目录与数据边界

```text
dev/                         # tracked：机器事实
└── model-profile.json       # 开发与验证模型身份的唯一事实源

.dev/                        # gitignored：全部运行时产物
├── toolchain/               # 固定 uv、托管 Python、wheel venv
├── runs/openviking/         # 开发服务的 workspace、ov.conf、PID、日志、状态、embedding 模型缓存
└── pi/                      # 隔离 PI_CODING_AGENT_DIR 与扩展 wrapper
```

`dev/` 只提交机器事实文件；`.dev/` 可整体删除，由 bootstrap 重建。凭证不进入上述目录或 Git。

## Bootstrap 合同

用户安装与开发安装是两个独立脚本，不共享流程：`scripts/cli.mjs setup` 保留面向最终用户的交互与配置项；
`dev bootstrap` 的所有参数（版本、路径、embedding、配置）在仓库内预先确定，是一键安装全部依赖的
零交互脚本，不接受覆盖选项，不读取用户配置，不注册 Pi 包，不自动 start。

两个脚本只允许共享无决策的底层机制原语（固定 uv 下载与校验和、托管 Python、venv 创建、pinned
wheel 安装与 fingerprint 校验），各自独立演化；任何脚本级参数、提示或状态机不得互相引用。

`dev bootstrap` 幂等且不启动服务，依次执行：

1. 校验 Git、OS、arch、Node（对照 `package.json#engines`）和 npm；
2. 验证本地依赖已按 lock 安装（否则提示先运行 `npm ci`）；
3. 校验 `dev/model-profile.json`（快速失败，避免无效下载）；
4. 下载并校验固定 uv（环境存在 HTTP(S)\_PROXY 时自动经代理下载），安装托管 Python，创建 wheel venv；
5. 安装固定 OpenViking wheel，并验证服务二进制可执行且版本与 pin 一致；
6. 本地 embedding 模型由 OpenViking 在首次 `dev up` 时自动下载，bootstrap 不预取；
7. 以不输出凭证的 `pi auth check` 分别报告任务模型与 VLM 凭证是否就绪，不发起模型推理，不就绪不失败。

## 服务生命周期合同

每个隔离服务必须具有：

- loopback 地址和无竞争端口，不复用 `~/.pi/openviking` 的活动进程、端口或数据目录；
- 独立 `ov.conf`、workspace、PID、日志和状态文件；
- ownership marker（随机 nonce）与状态文件（pid、endpoint、启动时间、配置指纹），两者 nonce 一致；
- 启动后的 `/health` 版本与进程身份检查。

`up` 不接管身份不匹配的残留进程；`down` 在终止前同时核对进程命令行（Linux `/proc`、macOS `ps`；
win32 退化为 marker/状态核对）、状态文件和 marker，并停止完整进程树（POSIX 进程组 / Windows
`taskkill /T`）。无 marker 的递归删除或“强制清理兜底”不属于支持行为。`down` 只停止并确认所属
进程，不删除 workspace 或 toolchain；环境损坏时由 bootstrap 修复或重建，不提供 `restart`/`clean`
子命令。

## 开发模型身份与凭证桥接

凭证解析是服务与 Pi 启动动作的一部分：`dev up` 为 OpenViking VLM 准备凭证，`dev pi` 为任务模型准备凭证；
本地 embedding 不需要凭证。provider、完整字段矩阵、认证方式、模型枚举和变更步骤统一见
[`docs/v1/models.md`](./models.md)，本文只维护环境边界。

[`dev/model-profile.json`](../../dev/model-profile.json) 是开发模型身份的唯一机器事实源，由
`test/dev-bootstrap.test.mjs` 校验。`taskModel`、`vlm` 和 `embedding.dense` 只由各自消费者读取；字段值
相等时仍保持独立职责和凭证流。`dev pi` 显式传入 `taskModel` 的 provider/model，并把可选模型集合限制为
同一身份；命令行不得覆盖这些字段或通过 `--api-key` 绕过 profile。`dev up`、`status`、`dev pi` 和 live
preflight 同时核对状态指纹、实际 `ov.conf` 与 profile 生成配置，漂移时 fail-fast 并要求受管重启。

两类凭证保持不同边界：

- `credentialKind=api_key`：父进程以 stdout pipe 执行 `pi auth print-api-key`，只在内存确认非空单行，清除
  继承的全部凭证形态环境变量后，仅向对应子进程的 `apiKeyEnv` 注入值；
- Pi `credentialKind=oauth`：OAuth 不能降级为 API key，隔离 Pi 的 `auth.json` 只建立对用户 Pi auth store
  的同文件引用；创建前验证来源属于当前用户且权限私有，不复制 token，不覆盖目标已有独立 auth 文件；
- OpenViking `credentialKind=oauth`：可用 provider 由 [`shared/openviking-oauth.mjs`](../../shared/openviking-oauth.mjs) 注册表承载；`ov.conf` 省略 `api_key`，开发服务 store 固定在 `~/.openviking/pi-openviking-dev/`，从注册项声明的 CLI auth bootstrap，不读取或覆盖上游默认 OpenViking store；
- readiness 不输出凭证：任务模型使用 `pi auth check`，VLM OAuth 使用锁定 OpenViking 的本地 credential
  probe；任一身份未就绪都停止，不回退到其他 provider、model、账户或 endpoint。

不得通过 shell command substitution、命令回显、调试日志或 `pi auth check --credentials` 获取凭证。配置、
状态文件、日志和 artifact 不保存凭证，也不记录凭证 hash。

用户为 `taskModel` 或 `vlm` 身份完成 API-key/OAuth 登录，即构成该身份用于本仓库开发和验证的明确授权。
以下任一变化必须重新取得用户决定：

- `taskModel` 的 provider 或 model 改变；
- `vlm` 的 provider、model 或 API base 改变；
- 本地 embedding 的 provider、model 或 dimension 改变；
- 调用超出本仓库开发与 `docs/v1/roadmap.md` 阶段 gate。

## Pi 扩展开发循环

`dev pi` 使用本地锁定的 Pi CLI，并显式隔离：

- `PI_CODING_AGENT_DIR=.dev/pi`（auth、settings、sessions、extensions 全部由它派生隔离）；
- OpenViking endpoint（`OPENVIKING_BASE_URL=http://127.0.0.1:19331`）、account/user（`dev`）；
- 自动发现的其他扩展与包（隔离 agent dir 只含下述 wrapper）；
- 使用[开发模型身份](#开发模型身份与凭证桥接)中的 `taskModel`，按 credential kind 使用环境桥接或 OAuth auth 引用。

`dev pi` 在 `.dev/pi/extensions/pi-openviking-dev/index.ts` 生成只负责加载仓库 `index.ts` 的
wrapper，使 Pi `/reload` 可用。reload 会先触发 `session_shutdown`，再重载扩展并触发
`session_start`，因此它同时是连接释放、同步尾部、ACK 恢复和状态重建的实时观察点。
推荐循环：

```text
修改 TypeScript
  → /reload
  → /viking
  → /viking sync
  → 检查隔离 Pi JSONL、ACK、OpenViking 对象和服务日志
```

交互调试必须使用持久 session；`--no-session` 不能替代 JSONL、分支和重启验证。

`scripts/e2e-probe.ts` 是供 live verifier 使用的 payload 采集扩展，必须最后加载，只向 verifier
预开的私有 FD 写入；普通交互开发不启用 payload 采集。

## 统一观察调查

观察默认关闭；普通开发不设置 `OV_OBSERVE` 或 `OV_OBSERVE_FD`。需要调查单次 Pi 进程时，先建立仓库内私有
artifact 目录，再选择一种去向：

```bash
mkdir -p test/.artifacts/manual-observation
OV_OBSERVE=test/.artifacts/manual-observation/run.jsonl npm run dev -- pi
```

文件必须尚不存在；另一种方式由父进程预开 `0600` 空文件并只向子进程继承 `OV_OBSERVE_FD`。两种变量不得同时
设置。`/viking` 只读显示 `disabled`、`ready` 或 `incomplete` 以及 accepted/dropped；观察失败不改变 Pi、同步或
recall 结果。记录 schema、脱敏、完整 run 与清理条件只由 [`docs/v1/observability.md`](./observability.md) 定义。

`npm run verify:checkpoint:live` 使用真实 Content/Session/Task API 和开发 VLM，覆盖文本、嵌入图片、明确失败后的真实
VLM 重试、request/task 恢复与双 Archive 积压；配套 deterministic checks 覆盖完整事实链、并发首写、每个 Archive
三次 attempt、媒体失败、外部错误脱敏和终态清理恢复；多模态 workload 分别计量媒体语义处理与其后的 checkpoint
生成，避免用一个墙钟阈值混合两个外部 VLM 边界。受管服务必须已启动且 VLM credential 为 ready。gate 只写
随机所属 namespace；生产协调器先从终态事实清理所属 Session/媒体根，gate 最后再取消仍在途的测试 task，并按
ownership marker 契约删除全部临时对象和 checkpoint 事实。

`npm run verify:takeover:live` 使用真实 Pi context/compaction hook、开发 task provider、受管 OpenViking 与真实 VLM
checkpoint，覆盖稳定 provider 前缀与 cache key、重启、根级 sibling 分支、断线、容量不匹配及 ActiveContext/native
compaction。它同时采集一段完整 compaction 观察 run；原始 provider payload 和观察 JSONL 仅存在于 run 私有目录，
通过后连同 session 一并删除。

`npm run verify:budget:live` 使用发布默认 Archive/checkpoint 预算和显式高水位驱动，对长工具循环、单轮超长原子输入、
sibling branch/重启/compaction 三类 100k+ 来源各独立重复三次。它采集真实 task/VLM token、墙钟、provider payload 与完整
观察 run；性能结论只适用于 manifest 固定的模型组合，运行时 eligibility 仍读取 Pi 当前模型容量。成功后远端所属对象、
provider payload、观察记录和本地 session 全部删除，summary 作为同一 release run 的后续 gate 输入。

`npm run verify:observability:live` 是常驻横切 gate。它要求隔离服务已由 `dev up` 启动，并会使用开发模型、随机
session namespace、受控 409 对象及 URI 拒绝 workload；执行前必须取得真实模型调用和所属测试 namespace 写入/删除
授权。verifier 在删除前逐字节复核 marker 与写入一致，随后按构造的精确根路径删除，且在 OpenViking 目录骨架物化窗口后再次核对全部已写对象不存在。

## 安全清理

`dev down` 只停止进程、不删除数据，停止前必须同时满足：marker 与状态文件 nonce 一致、状态文件
pid 与 `server.pid` 一致、进程命令行包含本 run 目录的 `ov.conf`（win32 无法核对命令行，存在 PID
复用时误杀无关进程树的残余风险，操作前留意 status 输出）。

任何删除数据的操作（如 namespace 清理）必须满足：路径位于允许根目录、状态
文件根路径与实际路径完全一致、远端 ownership marker 逐字节回读匹配。阶段 gate 的远端 namespace、
逐字节回读和 cleanup 断言以 `docs/v1/verification.md` 为权威，本文不复制。

## 维护规则

- 开发命令变化时，同一变更更新本文；
- 架构变化先更新 `docs/v1/spec.md`，阶段或验收变化先更新 `docs/v1/roadmap.md`，本文只调整执行方式和引用；
- 当前代码职责变化时更新 `docs/v1/design.md`；
- 最终用户安装、配置或排障变化时更新 `docs/v1/usage.md`；
- 本文不保留版本历史、已完成任务流水或单次运行结果；
- 精确版本只在 manifest、lock、源码身份和安装元数据中维护；
- 不存在的命令必须标为“待实现”，实现后删除缺口说明，直接描述当前标准流程；
- 新增工具或文档前必须能够说明当前消费者、独立责任和验证方式，避免形成第二套流程来源。
