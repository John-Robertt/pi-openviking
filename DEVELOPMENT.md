# Pi OpenViking 开发环境手册

## 文档职责

本文是本仓库开发环境的权威手册：安装依赖、运行隔离服务、进入开发循环、安全清理。

- 产品职责、目标架构、阶段顺序和验收标准以 [`SPEC.md`](./SPEC.md) 为唯一权威来源；
- 当前代码职责和数据流见 [`DESIGN.md`](./DESIGN.md)；
- 最终用户的安装、配置和故障排查见 [`USAGE.md`](./USAGE.md)。

本文只定义环境本身，不复制协议字段、存储规则或阶段验收标准。精确依赖版本由机器可验证的
lock 和安装常量维护，不在本文建立第二份版本清单。

## 环境边界

开发环境只负责三件事：

1. **装得出来**：把固定版本的 uv、Python、OpenViking wheel 安装到仓库内 `.dev/`；
2. **起得来**：启动与用户服务完全隔离的 OpenViking 开发服务；
3. **调得通**：进入隔离 Pi，加载仓库扩展，模型凭证可用。

探针、workload manifest、live verifier、summary 和阶段清理断言是开发工作，不是环境依赖；
其契约由 [`SPEC.md`](./SPEC.md) 的“真实验收门禁”定义，实现时消费本文的服务生命周期能力。

## 当前可执行基线

```bash
npm ci
npm test
npm exec -- pi -e ./index.ts
node scripts/cli.mjs server status
```

`npm test` 是当前 deterministic 自动化入口。`npm exec -- pi -e ./index.ts` 使用 lock 中的 Pi
快速加载仓库扩展，但没有隔离开发服务，不能替代 SPEC 定义的 live gate。`server status`
只读检查当前用户服务，不属于隔离开发流程。

`scripts/cli.mjs setup` 面向最终用户安装，会管理 `~/.pi/openviking`、默认服务端口和 Pi 包注册。
它不是仓库开发 bootstrap；活动的 `~/.pi/openviking/data` 不能用于破坏性测试或阶段门禁。

## 标准流程概览

标记为“待实现”的入口当前不可执行，实现后删除该标记并直接描述现行流程。

```bash
clone
  → npm ci

# 建立仓库内开发环境：安装 uv/Python/OpenViking 到 .dev/，幂等，不启动服务
npm run dev -- bootstrap

# 待实现：启动、检查和停止隔离开发服务
npm run dev -- up
npm run dev -- status
npm run dev -- down

# 待实现：进入隔离 Pi，加载仓库扩展
npm run dev -- pi

# 当前唯一 deterministic 检查
npm test
```

完整参数以 `npm run dev -- help` 为准；本文只保留工作流和安全边界，不复制全部 CLI flags。

## 目录与数据边界

```text
dev/                         # tracked：机器事实
└── model-profile.json       # 开发与验证模型身份的唯一事实源

.dev/                        # gitignored：全部运行时产物
├── toolchain/               # 固定 uv、托管 Python、wheel venv
├── runs/openviking/         # 开发服务的 workspace、ov.conf、PID、日志、状态
└── pi/                      # 隔离 PI_CODING_AGENT_DIR 与扩展 wrapper
```

`dev/` 只提交机器事实文件；`.dev/` 可整体删除，由 bootstrap 重建。凭证不进入上述目录或 Git。

## 权威来源与版本管理

| 事实 | 权威来源 |
|---|---|
| 最低 Node 版本 | `package.json#engines` |
| Node/Pi 依赖解析 | `package-lock.json` |
| 发布时 Pi 兼容边界 | `package.json#peerDependencies` |
| OpenViking/uv/Python 安装版本 | `shared/toolchain.mjs` 的 pin；Content API 协议值由 `test/recorded-event-adapter.test.mjs` 固定 |
| 开发 task/VLM 与本地 embedding 身份 | `dev/model-profile.json` |
| 阶段 workload 与成功标准 | `SPEC.md` 和对应 `test/live/*.workloads.json` |

版本号变化时更新其权威机器文件，并让静态检查验证需要保持一致的副本；不手工维护版本表。

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
4. 下载并校验固定 uv（环境存在 HTTP(S)_PROXY 时自动经代理下载），安装托管 Python，创建 wheel venv；
5. 安装固定 OpenViking wheel 与 `xxhash<4`，并验证服务二进制可执行且版本与 pin 一致；
6. 本地 embedding 模型由 OpenViking 在首次 `dev up` 时自动下载，bootstrap 不预取；
7. 以不输出凭证的 `pi auth check` 报告开发模型凭证是否就绪，不发起模型推理，不就绪不失败。
## 服务生命周期合同

每个隔离服务必须具有：

- loopback 地址和无竞争端口，不复用 `~/.pi/openviking` 的活动进程、端口或数据目录；
- 独立 `ov.conf`、workspace、PID、日志和状态文件；
- 包含 run ID、配置身份和随机 nonce 的 ownership marker；
- 启动后的 `/health` 版本与进程身份检查。

`up` 不接管身份不匹配的残留进程；`down` 不能只依赖 PID，终止前必须同时核对 PID 启动时间、
命令、状态文件和 marker，跨平台停止完整进程树。无 marker 的递归删除或“强制清理兜底”不属于
支持行为。`down` 只停止并确认所属进程，不删除 workspace 或 toolchain；环境损坏时由 bootstrap
修复或重建，不提供 `restart`/`clean` 子命令。

## 开发模型身份与凭证桥接

凭证桥接是服务与 Pi 启动动作的一部分：`dev up` 和 `dev pi` 在 spawn 子进程时从 Pi 已登录凭证
解析并注入 `apiKeyEnv` 指定的变量；本地 embedding 不需要凭证。

[`dev/model-profile.json`](./dev/model-profile.json) 是开发模型身份的唯一机器事实源，由
`test/dev-bootstrap.test.mjs` 校验。字段职责：`taskVlm` 描述任务模型与 OpenViking VLM 共用的
provider/model/apiBase/凭证类型/凭证环境变量名；`embedding.dense` 描述本地 embedding 的
provider/model/dimension。其他文档、命令示例和阶段 gate 只引用“开发模型身份”，不得复制具体值。

任务模型与 OpenViking VLM 共同读取 `taskVlm`；OpenViking 本地 dense embedding 读取
`embedding.dense`。`<profile.path>` 表示读取 profile 对应字段；Pi runner、OpenViking 配置生成器
和凭证桥接禁止保存字段副本。

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
- 调用超出本仓库开发与 `SPEC.md` 阶段 gate。

`node scripts/cli.mjs server doctor` 会真实探测 embedding/VLM，只能作为上述授权边界内的显式诊断；
它不是无副作用 bootstrap。

## Pi 扩展开发循环

计划中的 `dev pi` 使用本地锁定的 Pi CLI，并显式隔离：

- `PI_CODING_AGENT_DIR`；
- `PI_CODING_AGENT_SESSION_DIR`；
- OpenViking endpoint、user 和 peer；
- 自动发现的其他扩展与包；
- 使用[开发模型身份](#开发模型身份与凭证桥接)。

开发 runner 可在 `.dev/pi/extensions/` 生成只负责加载仓库 `index.ts` 的 wrapper，以支持 Pi
`/reload`。reload 会先触发 `session_shutdown`，再重载扩展并触发 `session_start`，因此它同时是
连接释放、同步尾部、ACK 恢复和状态重建的实时观察点。

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

## 验证分层

| 层级 | 入口 | 证明范围 |
|---|---|---|
| 静态与 deterministic | `npm test` | 配置、事件、树、ACK、边界和模拟故障 |
| 阶段 live gate | 按 `SPEC.md` 顺序增加（待实现） | `SPEC.md` 定义的阶段出口 |

提交前的检查序列是：

```bash
npm test
npm run verify:phase0:live   # 待实现

git diff --check
npm pack --dry-run
```

在 live gate 尚未实现期间，只能报告 deterministic 结果和未闭合的真实证据，不能宣称 Phase 0 已通过。

## 安全清理

开发环境内只有以下条件全部成立才能停止进程或删除数据：

1. 路径位于 `.dev/runs` 允许根目录；
2. 状态文件中的根路径与实际路径完全一致；
3. 本地 marker 的 run ID、配置身份和 nonce 逐字节匹配；
4. PID 的启动身份、命令和状态记录匹配。

阶段 gate 的远端 namespace、逐字节回读和 cleanup 断言以 `SPEC.md` 为权威，本文不复制。

## 当前缺口与下一执行入口

当前尚未实现：

- `scripts/dev.mjs` 的 up/down/status/pi（隔离服务生命周期与 Pi runner）。

下一执行入口是实现上述环境最小集；live verifier 及 `test/live/phase0.workloads.json` 是随后的
开发工作，契约见 `SPEC.md`。环境实现不提前包含 probe 矩阵、source 模式或 Archive 相关能力。

## 维护规则

- 开发命令变化时，同一变更更新本文；
- 架构、阶段或验收标准变化时先更新 `SPEC.md`，本文只调整执行方式和引用；
- 当前代码职责变化时更新 `DESIGN.md`；
- 最终用户安装、配置或排障变化时更新 `USAGE.md`；
- 本文不保留版本历史、已完成任务流水或单次运行结果；
- 精确版本只在 manifest、lock、源码身份和安装元数据中维护；
- 不存在的命令必须标为“待实现”，实现后删除缺口说明，直接描述当前标准流程；
- 新增工具或文档前必须能够说明当前消费者、独立责任和验证方式，避免形成第二套流程来源。
