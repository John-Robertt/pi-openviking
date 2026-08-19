# Pi OpenViking 开发环境手册

## 文档职责

**架构定位**：本仓库开发环境的权威手册。

**核心目标**：在任意一台机器上克隆仓库后，能安装依赖、运行隔离服务、进入开发循环并安全清理。

**职责边界**：本文只定义环境本身。产品职责、目标架构和配置语义以 [`docs/spec.md`](./spec.md) 为准，
阶段顺序与验收以 [`docs/roadmap.md`](./roadmap.md) 为准，当前代码职责见
[`docs/design.md`](./design.md)，最终用户操作见 [`docs/usage.md`](./usage.md)。本文不复制协议字段、
存储规则或阶段验收标准；精确依赖版本由机器可验证的 lock 与安装常量维护，不在此建立第二份版本清单。

## 环境边界

开发环境只负责三件事：

1. **装得出来**：把固定版本的 uv、Python、OpenViking wheel 安装到仓库内 `.dev/`；
2. **起得来**：启动与用户服务完全隔离的 OpenViking 开发服务；
3. **调得通**：进入隔离 Pi，加载仓库扩展，模型凭证可用。

探针、workload manifest、live verifier、summary 和阶段清理断言的契约由
[`docs/verification.md`](./verification.md) 定义，其实现消费本文的服务生命周期能力。

## 标准流程概览

```bash
clone
  → npm ci

# 建立仓库内开发环境：安装 uv/Python/OpenViking 到 .dev/，幂等，不启动服务
npm run dev -- bootstrap

# 启动、检查和停止隔离开发服务
npm run dev -- up
npm run dev -- status
npm run dev -- down

# 进入隔离 Pi（自动加载仓库扩展，支持 /reload；追加参数透传给 pi）
npm run dev -- pi
```

完整参数以 `npm run dev -- help` 为准；本文只保留工作流和安全边界，不复制全部 CLI flags。

## 升级外部版本

`shared/toolchain.mjs` 的 `TOOLCHAIN` 唯一维护 OpenViking、uv、托管 Python、xxhash 和 zstandard 的当前
受管选择；`package.json` 维护 Node 最低版本、npm 依赖与 peer 最低兼容基线。peer 不设置预防性上限：
当前 lock 和 live manifest 记录最近验证快照，后续版本默认向前兼容，只有实际 gate 证明存在破坏时才临时
隔离并适配。文档中的版本号由 `npm test` 检查与权威源一致。

```bash
# 1. 修改唯一权威源
#    OpenViking / uv / Python / xxhash / zstandard → shared/toolchain.mjs 的 TOOLCHAIN
#    Node / npm dependency / peer 最低基线           → package.json

# 2. 由检查列出全部待同步位置（文档正文、live manifest 身份）
npm test

# 3. 按报告逐条更新，直到 npm test 通过
#    manifest 变更后重新固定 test/live/<gate>.workloads.sha256

# 4. 重建隔离环境并验证服务身份
npm run dev -- bootstrap
npm run dev -- up
npm run dev -- status

# 5. 重跑受影响阶段的 live gate
npm run verify:phase0:live
npm run verify:observability:live
```

第 3 步的 manifest 更新不是形式手续。manifest 声明的是“该阶段的结论在哪一组真实身份上成立”，
gate 的 preflight 会用真实 `/health` 逐字核对；服务版本变化意味着该阶段的基线需要按
[`docs/roadmap.md`](./roadmap.md)“实施顺序”的调查闭环重新建立，其规则见
[`docs/verification.md`](./verification.md)。固定 hash 使这一步必须是有意识的动作。该精确身份只表示最近一次
已经通过的证据快照，不构成对后续版本的支持上限。

`shared/toolchain.mjs` 中记录特定版本缺陷的注释（如 `xxhash<4` 的约束）需要人工判断该缺陷在新版本
是否仍然存在，不由检查覆盖。

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
5. 安装固定 OpenViking wheel 与 `xxhash<4`，并验证服务二进制可执行且版本与 pin 一致；
6. 本地 embedding 模型由 OpenViking 在首次 `dev up` 时自动下载，bootstrap 不预取；
7. 以不输出凭证的 `pi auth check` 报告开发模型凭证是否就绪，不发起模型推理，不就绪不失败。

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

凭证桥接是服务与 Pi 启动动作的一部分：`dev up` 和 `dev pi` 在 spawn 子进程时从 Pi 已登录凭证
解析并注入 `apiKeyEnv` 指定的变量；本地 embedding 不需要凭证。

[`dev/model-profile.json`](./dev/model-profile.json) 是开发模型身份的唯一机器事实源，由
`test/dev-bootstrap.test.mjs` 校验。字段职责：`taskVlm` 描述任务模型与 OpenViking VLM 共用的
provider/model/apiBase/凭证类型/凭证环境变量名；`embedding.dense` 描述本地 embedding 的
provider/model/dimension。其他文档、命令示例和阶段 gate 只引用“开发模型身份”，不得复制具体值。

任务模型与 OpenViking VLM 共同读取 `taskVlm`；OpenViking 本地 dense embedding 读取
`embedding.dense`。`dev pi` 显式传入 profile 的 provider/model，并把可选模型集合限制为同一身份；命令行
不得覆盖这些字段或通过 `--api-key` 绕过凭证桥接。`dev up`、`status`、`dev pi` 和 live preflight 同时核对
状态指纹、实际 `ov.conf` 与 profile 生成配置，漂移时 fail-fast 并要求受管重启。Pi runner、OpenViking
配置生成器和凭证桥接禁止保存字段副本。

桥接动作按以下顺序执行：

1. 以 stdout pipe 执行
   `npm exec -- pi auth print-api-key --provider <profile.taskVlm.provider> --model <profile.taskVlm.model>`；
2. 去除唯一的行尾换行，在内存中确认结果非空；该命令已负责模型解析和 API-key 类型校验；
3. 只向本次隔离 Pi 和 OpenViking 子进程注入 `taskVlm.apiKeyEnv` 指定的变量；
4. 子进程退出后释放内存引用，不持久化、不回显、不记录 hash。

`status` 可以使用不输出凭证的 `npm exec -- pi auth check` 报告 readiness，启动路径不重复执行。

不得通过 shell command substitution、命令回显、调试日志或 `pi auth check --credentials` 获取凭证。
凭证缺失或失效时停止并提示用户执行 `/login <profile.taskVlm.provider>`，不得回退到其他
provider、model、账户或 endpoint。配置、状态文件、artifact 不保存凭证。

用户在 Pi 中为 `taskVlm` 身份手动录入 key，即构成项目开发和验证的明确授权；为同一身份手动替换
key 本身也构成授权。以下任一变化必须重新取得用户决定：

- `taskVlm` 的 provider、model 或 API base 改变；
- 本地 embedding 的 provider、model 或 dimension 改变；
- 调用超出本仓库开发与 `docs/roadmap.md` 阶段 gate。

## Pi 扩展开发循环

`dev pi` 使用本地锁定的 Pi CLI，并显式隔离：

- `PI_CODING_AGENT_DIR=.dev/pi`（auth、settings、sessions、extensions 全部由它派生隔离）；
- OpenViking endpoint（`OPENVIKING_BASE_URL=http://127.0.0.1:19331`）、account/user（`dev`）；
- 自动发现的其他扩展与包（隔离 agent dir 只含下述 wrapper）；
- 使用[开发模型身份](#开发模型身份与凭证桥接)（`apiKeyEnv` 经环境注入，不落盘）。

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
recall 结果。记录 schema、脱敏、完整 run 与清理条件只由 [`docs/observability.md`](./observability.md) 定义。

`npm run verify:observability:live` 是常驻横切 gate。它要求隔离服务已由 `dev up` 启动，并会使用开发模型、随机
session namespace、受控 409 对象及 URI 拒绝 workload；执行前必须取得真实模型调用和所属测试 namespace 写入/删除
授权。verifier 只在 marker 与精确根匹配时删除，且在 OpenViking 目录骨架物化窗口后再次核对全部已写对象不存在。

## 安全清理

`dev down` 只停止进程、不删除数据，停止前必须同时满足：marker 与状态文件 nonce 一致、状态文件
pid 与 `server.pid` 一致、进程命令行包含本 run 目录的 `ov.conf`（win32 无法核对命令行，存在 PID
复用时误杀无关进程树的残余风险，操作前留意 status 输出）。

任何删除数据的操作（如 namespace 清理）必须满足：路径位于允许根目录、状态
文件根路径与实际路径完全一致、远端 ownership marker 逐字节回读匹配。阶段 gate 的远端 namespace、
逐字节回读和 cleanup 断言以 `docs/verification.md` 为权威，本文不复制。

## 维护规则

- 开发命令变化时，同一变更更新本文；
- 架构变化先更新 `docs/spec.md`，阶段或验收变化先更新 `docs/roadmap.md`，本文只调整执行方式和引用；
- 当前代码职责变化时更新 `docs/design.md`；
- 最终用户安装、配置或排障变化时更新 `docs/usage.md`；
- 本文不保留版本历史、已完成任务流水或单次运行结果；
- 精确版本只在 manifest、lock、源码身份和安装元数据中维护；
- 不存在的命令必须标为“待实现”，实现后删除缺口说明，直接描述当前标准流程；
- 新增工具或文档前必须能够说明当前消费者、独立责任和验证方式，避免形成第二套流程来源。
