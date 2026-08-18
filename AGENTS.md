# 编码代理开发地图

## 文档职责

本文是编码代理的仓库导航入口，负责连接任务、权威事实、代码位置和验证方式。产品规范、实现设计、
开发环境和用户行为由下表列出的权威文档分别维护，本文通过引用消费这些事实。

## 快速开始

1. 阅读 [`docs/roadmap.md`](./docs/roadmap.md) 的“实施状态”和“下一实施入口”，确认当前阶段及前置 gate。
2. 按“任务定位”找到当前任务的权威文档、生产代码和聚焦测试。
3. 以对应测试建立基线；阶段工作同时核对 `package.json` 中实际存在的 live gate。
4. 需要 OpenViking 或隔离 Pi 时，按 [`docs/development.md`](./docs/development.md) 使用 `.dev/` 环境。

## 权威事实路径

| 事实                                                   | 维护位置                                                                                 | 验证位置                                            |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------- | --------------------------------------------------- |
| 产品职责、目标架构、协议、配置语义、质量边界           | [`docs/spec.md`](./docs/spec.md)                                                         | `docs/verification.md` 定义的证据与阶段 gate        |
| 阶段划分、每阶段范围与验收、实施状态、下一实施入口     | [`docs/roadmap.md`](./docs/roadmap.md)                                                   | 对应阶段的 deterministic checks 与 live gate        |
| 证据种类、live verifier 契约、各阶段门禁必须断言的结果 | [`docs/verification.md`](./docs/verification.md)                                         | `test/live/` 的 verifier 与其 summary               |
| 当前模块职责和数据流                                   | [`docs/design.md`](./docs/design.md)                                                     | 生产代码及对应测试                                  |
| 观察点契约、记录形状、关联字段、脱敏边界、完成门       | [`docs/observability.md`](./docs/observability.md)                                       | `docs/verification.md`“观察证据”定义的检查          |
| 开发环境、隔离服务、凭证桥接、调试和安全清理           | [`docs/development.md`](./docs/development.md)                                           | `test/dev-*.test.mjs` 与 `npm run dev -- <command>` |
| 最终用户安装、配置、命令和故障排查                     | [`docs/usage.md`](./docs/usage.md)                                                       | CLI、配置和服务管理测试                             |
| 项目简介和文档入口                                     | [`README.md`](./README.md)                                                               | 本地链接检查与 `npm pack --dry-run`                 |
| npm 命令、发布文件、Node 和 peer 边界                  | [`package.json`](./package.json)                                                         | `package-lock.json`、npm 命令和打包检查             |
| Node/Pi 依赖解析                                       | [`package-lock.json`](./package-lock.json)                                               | `npm ci`                                            |
| OpenViking/uv/Python 安装 pin                          | [`shared/toolchain.mjs`](./shared/toolchain.mjs)                                         | `test/toolchain.test.mjs` 与开发 bootstrap          |
| 配置默认值和运行时接受字段                             | [`config.json`](./config.json)、[`shared/config-schema.mjs`](./shared/config-schema.mjs) | `test/config-schema.test.mjs`                       |
| 开发模型身份                                           | [`dev/model-profile.json`](./dev/model-profile.json)                                     | `test/dev-bootstrap.test.mjs`                       |
| 可执行行为                                             | 生产代码                                                                                 | 对应测试与真实运行证据                              |

本文持续维护指向上述来源的导航。版本、阶段状态、已完成工作和下一实施入口随各自权威来源更新，使
每项当前事实始终具有一条明确的维护与验证路径。

## 最小系统心智模型

当前实现的主干是两条独立链路；更完整的职责和数据流见 [`docs/design.md`](./docs/design.md)。

```text
Pi JSONL / in-memory entries
  → pi-session-source
  → RecordedEventV1 projection
  → Content adapter
  → OpenViking Content API
  → minimal SyncAck frontier

user prompt
  → recall search
  → profile / recall block
  → Pi context hook
  → provider-visible messages
```

`index.ts` 绑定 Pi 生命周期并协调健康检查、同步、召回和工具；`sync.ts` 是来源、事件写入和 ACK 的唯一
协调者；`client.ts` 只负责 OpenViking transport。
Archive、Checkpoint、`ActiveContext` 和上下文接管的当前可用范围由 `docs/roadmap.md` 的实施状态及对应阶段
gate 共同证明；配置字段只表达其权威文档定义的策略。

## 必须保持的系统保证

以下保证直接保护事实完整性、可用性和安全性；修改相关代码前先回到 `docs/spec.md` 核对完整契约。

- 持久 Pi JSONL 保持为 Pi 来源事件及 payload 的唯一事实源；同步层只持久化最小 `SyncAck` 并从来源重建待同步内容。
- 同步覆盖完整 entry tree，包括活动 leaf、祖先和所有 sibling branch；同步进度由已确认的 entry 前沿表达。
- 投影逐项保留原始 JSON payload；事件身份和 hash 由规范字节确定。
- 一个 Pi entry 的全部事件得到明确接受后推进 `SyncAck`；每个已确认 entry 都有可追踪的接受证据。
- 网络、recall、VLM 或 OpenViking 降级时，Pi 主任务继续运行；完整性冲突保留原对象并返回可诊断失败。
- Pi 独立控制 compaction；扩展通过生命周期钩子观察结果并提供上下文。
- Archive、Checkpoint 和 `ActiveContext` 依次消费前一阶段已经通过 deterministic checks 与 live gate 的状态。
- session-scoped 模式下，所有接收或返回 `viking://` URI 的工具执行绑定用户与会话边界校验。
- 凭证只在已授权进程的内存和环境中传递，仓库、日志、状态文件、测试输入和 artifact 保持无凭证。
- 删除和远端破坏性测试只作用于通过精确根路径、ownership marker 与随机 nonce 验证的所属资源。

## 任务定位

| 任务                                    | 先读                                          | 主要代码                                                                                       | 聚焦验证                                                                       |
| --------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Pi 生命周期、启动、shutdown、状态或命令 | `docs/design.md`、Pi 相关接口                 | `index.ts`、`shared/status-refresh.mjs`、`shared/viking-status.mjs`                            | `test/status-refresh.test.mjs`、`test/viking-status.test.mjs`、相关 live gate  |
| JSONL、分支或 session 恢复              | `docs/spec.md`“完整记录事件/可靠增量同步”     | `shared/pi-session-source.mjs`、`sync.ts`                                                      | `test/pi-session-runtime.test.mjs`、`test/session-source-ack.test.mjs`         |
| 事件身份、payload、turn/step            | `docs/spec.md`“完整记录事件”                  | `shared/canonical-json.mjs`、`shared/recorded-event.mjs`                                       | `test/recorded-event.test.mjs`、`test/generated-session-invariants.test.mjs`   |
| ACK、重放、并发或 fail-open             | `docs/spec.md`“可靠增量同步”                  | `sync.ts`、`shared/sync-ack.mjs`                                                               | `test/sync-manager.test.mjs`、`test/session-source-ack.test.mjs`               |
| Content API、批次、大对象或冲突         | `docs/spec.md` 存储契约                       | `client.ts`、`shared/recorded-event-adapter.mjs`                                               | `test/client-content.test.mjs`、`test/recorded-event-adapter.test.mjs`         |
| recall、profile 或 provider context     | `docs/spec.md` 检索/上下文边界                | `recall.ts`、`shared/recall-core.mjs`、`shared/profile-inject.mjs`                             | `test/recall.test.mjs`、阶段 provider payload gate                             |
| `viking_*` 工具及 URI 权限              | `docs/usage.md`“会话隔离与数据位置”、“工具”   | `tools.ts`、`lib/uri-guard-adapter.mjs`、`shared/uri-guard.mjs`                                | `test/tools-boundary.test.mjs`                                                 |
| 配置、用户空间、peer 或凭证解析         | `docs/spec.md`“目标配置”、`docs/usage.md`     | `config.ts`、`shared/config-schema.mjs`、`shared/credentials.mjs`、`shared/workspace-peer.mjs` | `test/config-schema.test.mjs` 及对应新增测试                                   |
| 最终用户安装和服务管理                  | `docs/usage.md`                               | `scripts/cli.mjs`、`shared/toolchain.mjs`、`shared/managed-server-*.mjs`                       | `test/server-status-cli.test.mjs`、`test/toolchain.test.mjs`、相关 server 测试 |
| 仓库开发环境和隔离 Pi                   | `docs/development.md`                         | `scripts/dev.mjs`、`dev/model-profile.json`                                                    | `test/dev-bootstrap.test.mjs`、`test/dev-lifecycle.test.mjs`                   |
| 阶段 gate、workload 或 artifact         | `docs/verification.md`、`docs/development.md` | `test/live/` 与 `package.json` 中实际存在的 gate                                               | 对应 `verify:<phase>:live` 结果；建设中的 gate 以“真实边界待验证”记录阶段状态  |
| 文档                                    | 本表“权威事实路径”                            | 对应维护位置中的文档                                                                           | 链接检查、`git diff --check`、从新维护者视角复核                               |

`shared/` 由本仓库维护，没有外部生成源：直接修改文件并用对应测试验证。其中只保留在本仓库有当前
消费者的职责。

## 验证入口

“任务定位”表中的测试是各责任边界的聚焦入口：

```bash
node --test test/<target>.test.mjs
npm test
npm pack --dry-run   # 发布文件、入口或 package 元数据变化时
```

`npm test` 提供 deterministic 证据；阶段完成由 `package.json` 已暴露且 `docs/spec.md` 要求的对应 live gate
提供证据。gate 处于建设中、服务尚待启动或身份仍需匹配时，相应范围记录为“真实边界待验证”。

## 仓库开发环境

仓库开发只使用 [`docs/development.md`](./docs/development.md) 定义的 `.dev/` 隔离环境：

```bash
npm run dev -- bootstrap
npm run dev -- up
npm run dev -- status
npm run dev -- pi
npm run dev -- down
```

- `.dev/` 保存可重建运行态并由 Git 忽略；`dev/` 只保存已声明和验证的机器事实。
- 仓库测试使用 `.dev/` 隔离环境。
- `dev pi` 使用持久 session 提供 JSONL、分支和重启证据；`--no-session` 适用于进程内 best-effort 场景。
- live verifier 最后加载 `scripts/e2e-probe.ts` 并通过私有 FD 采集 payload；普通交互开发保持常规扩展链路。

## 文档维护规则

- 产品目标、架构、协议、配置语义或质量边界变化：更新 `docs/spec.md`。
- 阶段划分、每阶段验收、实施进展或下一入口变化：更新 `docs/roadmap.md`。
- 证据种类、live verifier 契约或门禁断言变化：更新 `docs/verification.md`。
- 当前模块职责或数据流变化：更新 `docs/design.md`。
- 观察点契约、记录形状、脱敏边界或完成门变化：更新 `docs/observability.md`。
- 开发命令、环境、调试、凭证桥接或清理变化：更新 `docs/development.md`。
- 用户可见安装、配置、行为或排障变化：更新 `docs/usage.md`，必要时同步 `README.md` 的入口说明。
- 导航、任务路由或本文承担的仓库专属边界变化时更新本文。

### 文档位置与命名

文档按“消费者能否自动发现”分居两处：

- **根目录**只放不需要被告知路径就能找到的文件：`README.md`（npm 与 GitHub 自动渲染）、`LICENSE`、
  `CLAUDE.md` 与 `AGENTS.md`（编码代理按约定读取根目录）。这四个文件沿用大写命名，使其在代码文件
  中可辨识。
- **`docs/`** 放其余全部文档，一律小写命名。大写的作用是在代码文件中制造区分度，而 `docs/` 内没有
  代码文件，该信号没有作用对象。
- `docs/` 保持扁平。出现需要分组的多份同层文档时再引入子目录。

新增文档仍须满足上文的建档三要件；满足后放入 `docs/`，并在“权威事实路径”表登记维护与验证位置。

### 引用与同步

- 正文引用文档使用仓库根相对路径（`docs/spec.md`），与代码路径的书写方式一致，便于检索。
- 代码中的文档引用只写文件路径与小节标题，**不写小节编号**：编号会随文档演进漂移，且静态检查无法
  验证自由文本中的编号。
- 移动或新增文档时同步以下五处：`package.json` 的 `files`、文档之间的相对链接、本文“权威事实路径”
  表与本节规则、代码中的用户可见字符串、`README.md` 的项目结构与文档入口。
- 发布清单逐份显式列出，不使用 `docs/` 通配：是否随包发布是每份文档各自的决定，因而需要各自的动作。

以上规则由 `test/docs.test.mjs` 静态验证。

## 功能日志、运行追踪与问题调查

### 目标

每次新增、修改或修复功能，都要同时交付能够调查该功能实际运行情况的日志和追踪记录。出现问题时，开发者应当
能够打开这些记录，看到一次执行经过了哪些步骤、每一步的实际状态和数值是什么，以及实际结果从哪一步开始偏离
预期，这是充分调查的第一步，也是最重要的一步。

### 为什么必须在开发时完成

代码只能说明运行时可能发生什么，不能证明某次执行实际发生了什么。判断真实问题需要运行时产生的状态、数量、
耗时、分支选择、调用结果和错误信息。

如果等到问题发生后才添加日志和追踪记录，就需要增加一次修改、验证和重新复现问题的过程，浪费前期开发、审查
和后期识别主要矛盾的时间。因此，日志和追踪记录必须和功能代码一起设计、一起实现、一起验证。

### 行动规范

项目使用统一的行动规范标准，避免按问题位置临时增加零碎日志。运行日志、执行追踪、关联字段、代码放置、启停、安全与完成门的唯一规范是[全局可观测性标准](./docs/observability.md)。

新增、修改或修复功能时，必须同步满足该标准的“完成门”：成功路径与每条降级路径都有符合分类和必带字段的
点位、附一次真实运行产生的记录、相关测试与该标准“验证”一节的检查同时通过。问题调查先读取实际记录，
证据不足时按任务授权边界补充点位再复现。

如果发现统一观察点之外的第二套独立观察点，或者其他名为“诊断结果”但本质仍是观察点的内容，必须报告并清理。
项目中不允许存在多套观察点；清理后必须确认没有留下与旧观察点有关的代码、文档、配置、测试或运行记录。
