# Pi—OpenViking 长期记忆扩展架构总纲

## 文档职责

**架构定位**：项目目标架构与稳定边界的总纲。

**核心目标**：维护者能够确认系统的唯一目标、外部责任边界、模块职责与依赖方向，并知道每类变化应该修改哪个
模块或文档。

**职责边界**：本文维护架构层面的全部内容——战略目标、外部责任边界、目标架构、模块职责与数据契约、支撑
能力、状态所有权、核心业务链路、依赖方向、源码组织、全局系统保证、演进规则，以及需要被证明的验证契约
清单；具体字段、算法与预算由各模块实现表达，证据类型、测试组织与 gate 契约由
[`docs/verification.md`](./verification.md) 维护。

## 系统战略目标

本扩展依附于 Pi，并使用 OpenViking 的完整历史能力。系统唯一目标是：

> **让任务模型在 Pi 长期会话经过 compaction 或切换 branch 后，仍能看到一小份“以前发生过什么”的线索；需要具体内容时，再从 OpenViking 找回完整事实。**

三方关系是：

```text
Pi summary：我现在在做什么
Memory Cues：历史上发生过哪些事件、从哪里继续查找
OpenViking：这些事件的完整事实是什么
```

Pi 管理会话和模型上下文，OpenViking 保存并检索完整历史，扩展负责把 Pi 中的事实交给 OpenViking，并把简短线索
带回 Pi。

## 外部责任边界

### Pi

Pi 拥有：

- SessionEntry、session tree、branch 和 leaf；
- entry 到模型消息的映射；
- system、tools 和 provider payload；
- 模型能力、上下文计量和 cache usage；
- compaction 触发、边界、summary 和 `CompactionEntry`；
- tool result 持久化及文本、图片的 provider 映射。

扩展只使用 Pi 公开接口：读取 Pi 已接受的原始 entries，在 compaction 前后接收 callback，通过 custom entry 保存
扩展生成的线索，并通过 context hook 和工具接口把线索与历史读取能力提供给模型。

Pi 捕获 lifecycle、context 和工具 callback 的异常，并通过原生扩展错误路径报告；Pi Adapter 不替换这条路径。
`Composition Root` 是创建全部依赖并注册 callback 的装配入口。装配期间 callback 保持 inert，即收到事件后直接返回，
不执行扩展工作；全部依赖创建成功且 callback 注册完成后，Composition Root 才一次性切换到 active，让 callback
开始执行扩展工作。任一步骤失败时，运行实例保持 inert。

### OpenViking

OpenViking 拥有：

- 内容存储；
- 索引和语义搜索；
- URI、读取和分页；
- 服务端模型、身份、权限与存储协议。

扩展通过 OpenViking 公开的 ingestion、search 和 read 能力完成长期历史写入与恢复。

OpenViking 的语义索引、搜索结果与服务端摘要由其服务端模型产生，模型配置与凭证由部署方在服务端提供，不经过
扩展进程。扩展只把 OpenViking 已确认保存的 Pi entries 用于生成 Memory Cues；任务模型需要细节时，再通过
OpenViking 的 search/read 取得完整事实。

## 最小目标架构

```text
Pi entries → Pi Adapter → Fact Synchronizer → OpenViking Client → OpenViking
                         │
                         └─ 已保存的新 entries ─┐
Pi compaction 前后事件 ─────────────────────────┼→ Cue Provider → CueSet → Pi Adapter
任务模型的 search/read → Pi Adapter → OpenViking Client → OpenViking
```

核心运行架构由四个模块组成：

1. Pi Adapter；
2. Fact Synchronizer；
3. Cue Provider；
4. OpenViking Client。

每次 OpenViking 调用还携带一个 `OperationScope`，其中保存本次调用的 principal、workspace 和 session。
Composition Root 在启动时读取配置，Observer 写入运行事件。需要本地 OpenViking 时，再启用 Managed OpenViking Service。

## 模块协作契约

模块通过少量数据值协作：

| 数据 | 由谁产生 | 谁使用 | 包含什么 |
| --- | --- | --- | --- |
| `OperationScope` | Pi Adapter 与授权身份来源 | OpenViking Client | 绑定一次调用所需的 principal、workspace 和 session 范围 |
| `AcceptedDelivery` | OpenViking Client | Fact Synchronizer | 确认一条 Pi entry 已保存，并给出以后找到它所需的信息 |
| `CueSet` | Cue Provider | Pi Adapter 与下一次生成 | 保存有界线索，以及本次已经用到的最后一条 Pi entry |

Pi Adapter 把 Pi 已接受的每条原始 `SessionEntry` 原样交给 Fact Synchronizer。Fact Synchronizer 通过
OpenViking Client 保存这些 entries，并只在 OpenViking 接受后报告保存成功。每次 compaction 开始前，Pi Adapter
把当前路径中的上一份 `CueSet`，以及它之后已保存的新 entries 交给 Cue Provider。模块之间只传递表中的三个值；
OpenViking Client 不改写服务端返回结果的含义。

## 核心运行模块

### 1. Pi Adapter

**架构定位**

Pi 扩展入口与唯一 Pi 边界适配模块。它连接 Pi 生命周期、来源事实、compaction、context 和模型工具。

**核心目标**

> 以 Pi 已完成的生命周期事实驱动长期记忆链路，同时保持 Pi 对会话、tree 和模型上下文的完整所有权。

**业务需求**

- 支持持久 session 和 in-memory session；
- 从 Pi 公开接口读取其已接受的原始 `SessionEntry`，不解释或重建 tree、branch 与 leaf；
- 接收 Pi 在 compaction 前后发出的 callback，并使用 Pi 构造的当前 context entries 呈现对应 `CueSet`；
- 将已生成的 `CueSet` 保存为不参与 conversation 的 Pi custom entry；
- 只在普通 provider context 中临时呈现 `CueSet`，使其不进入后续 compaction；
- 向任务模型提供 OpenViking search 和 read 工具；
- 将 OpenViking 文本和图片结果映射为 Pi 支持的 tool result content；
- session 重开、tree 导航和扩展重载后，原样使用 Pi 当前给出的 session 与 context；
- Pi lifecycle 与 context callback 只执行有界本地工作；`session_before_compact` 启动 cue 任务后立即返回；
  `session_compact` 只提交已经生成的结果，并取消仍未完成的 cue 任务；
- callback 异常沿 Pi 原生扩展错误路径报告，未产生有效结果时保持 Pi 原始输入不变；
- extension runtime 结束后取消本实例创建的后台操作，过期操作不再提交状态。

**运行步骤**

- 注册 Pi 生命周期、compaction、context hook、命令和工具；
- 将 Pi 已接受的来源 entries 交给 Fact Synchronizer，并排除扩展自身的 `CueSet` custom entry；
- 在 `session_before_compact` 中找到当前路径的上一份 `CueSet`，收集它之后已经保存到 OpenViking 的新 entries，
  启动受 runtime cancellation 约束的 cue 任务后立即返回；
- 在 `session_compact` 中取得 Pi 当前路径最后一个 `CompactionEntry`，接收已经生成的 cue 结果并取消仍未完成的
  cue 任务；只有成功结果引用的 entries、compaction 与 runtime 仍有效时，才将 `CueSet` 追加为 custom entry；
- 从 Pi 当前 context entries 取得有效 `CueSet`，临时加入本次 provider context；
- 将 search/read 工具参数与 Pi session identity、授权 principal 组合为 `OperationScope`；
- 将 OpenViking Client 结果映射为 Pi 工具结果；
- 状态查询读取各模块当前状态，并把结果合并后返回。

**职责边界**

- SessionEntry、session tree、branch、leaf、compaction 和 provider context 的解释与重建归 Pi；
- 历史交付由 Fact Synchronizer 决定；
- 如何用上一份 `CueSet` 和新 entries 生成下一份 `CueSet`，以及线索预算，由 Cue Provider 决定；
- OpenViking transport 与响应解析由 OpenViking Client 决定；
- 工具能力限于当前目标所需的 search 和 read。

### 2. Fact Synchronizer

**架构定位**

Pi 已接受的来源 entries 到 OpenViking Client 的可靠历史交付模块。

**核心目标**

> 将每个 Pi 已接受的会话事实最终交给 OpenViking，并使外部失败保持在扩展边界内。

**业务需求**

- 接收 Pi Adapter 从公开接口取得的全部来源 entries；
- 一个 Pi entry 作为一个不透明来源事实提交，原始 parent 关系随 payload 保留；
- 扩展自身的 `CueSet` custom entry 不属于来源事实；
- OpenViking 明确接受后记录 `AcceptedDelivery`，并告诉调用者哪条 Pi entry 已保存、以后如何找到它；
- 网络、服务和进程失败后可以从 Pi 原始 entries 重放；
- session 重开和重复提交保持幂等；
- 交付在 Pi callback 之外执行，每次尝试均可取消、有时间上限，且 shutdown 不等待交付完成；
- 增量机制只表达可重建的交付进度。

**运行步骤**

- 比较 Pi 来源 entries 与已接受交付状态；
- 按 Pi entry 的来源依赖顺序选择待交付 entries；
- 通过 OpenViking Client 提交来源身份和原始 entry；
- 只根据 `AcceptedDelivery` 更新交付进度；
- 向调用者公开本次 pending、accepted 和 failure 结果。

交付状态的具体结构、持久化方式和批次策略由 OpenViking 幂等契约与真实会话规模共同决定。该状态可以从 Pi 权威来源和 OpenViking 接受结果重建。

**职责边界**

- Pi entry 的语义、tree 关系和有效性由 Pi 决定；
- 内容存储、索引和去重由 OpenViking 决定；
- 本模块保持 entry payload 完整，不派生 turn、step、role 或第二套事件标准；
- Cue Provider 使用本模块报告的已保存 entries。

### 3. Cue Provider

**架构定位**

在每次 Pi compaction 时更新一份简短的历史线索。

**核心目标**

> Pi 开始压缩前，Cue Provider 用“上一份 `CueSet` + 后来成功保存的新 entries”生成下一份 `CueSet`。
> Cue 生成与 Pi 压缩同时进行；模型只看到简短线索，需要细节时再读取 OpenViking。

例如，上一份 `CueSet` 已经用到 entry `e4`：

1. `session_before_compact` 到达时，OpenViking 已保存 `e5`、`e6`、`e7`，正在保存 `e8`；
2. cue 任务先等待这次保存结束：`e8` 成功时使用 `e5` 至 `e8`，`e8` 失败时使用 `e5` 至 `e7`，然后生成线索；
3. `session_compact` 到达时，生成已经完成就保存新 `CueSet`，并记住最后用到的 entry；生成仍未完成就取消任务，
   继续使用停在 `e4` 的旧 `CueSet`。下一次生成仍会从 `e5` 开始，因此不会漏掉事实。

**业务需求**

- 每个 `CompactionEntry` 最多保存一份新 `CueSet`，并把它留在 Pi 当前 tree 路径上；
- 第一次生成使用 session 开始后已保存的 entries；以后每次从上一份 `CueSet` 已经用到的最后一条 entry 之后继续；
- `session_before_compact` 启动 cue 任务后立即返回，让 Pi 压缩与 cue 生成同时进行；
- cue 任务可以在 Pi 压缩期间等待当前事实交付结束，但只使用 OpenViking 已确认保存的 entries；
- `session_compact` 到达时只接收已经生成的结果，并取消仍未完成的 cue 任务；未生成线索的 entries 留给下一次；
- 每条线索只写事件时间或区间、用于识别事件的短句，以及以后找到完整事实所需的信息；
- 线索交给模型时一并说明覆盖到哪个时间为止，以及这是重要事件的采样、不是完整清单，需要具体内容时用 search
  取回。覆盖时间来自本次已经用到的最后一条 entry 的 timestamp，不需要新字段。没有这两句说明时，一份清单会被
  读成“历史上只发生过这些”，而线索受固定预算约束，本来就装不下全部事件；
- 新 `CueSet` 同时保存线索和本次已经用到的最后一条 Pi entry；
- 线索数量和总字符数使用固定保守上限；实际运行需要调整某个上限时，再把该上限加入配置；
- session 重开、tree 导航和扩展重载后，Pi 当前路径上的 `CueSet` 继续生效；
- 生成失败、超时、取消或路径已经变化时不保存新 `CueSet`，Pi 原生 context 与主任务继续。

**运行步骤**

```text
session_before_compact
  → previous CueSet + entries saved after its last-used entry
  → start cue task and return
  → cue task: wait for pending entries and generate within the compaction window
  → Pi compaction || cue task
session_compact
  → ready + runtime and Pi path still valid: save the new CueSet
  → not ready: cancel the cue task
  → no saved result: keep the previous CueSet; unused entries go to the next generation
context
  → add the short clues, their coverage time and the sampling notice to the provider request
```

Pi session tree 保存整个 `CueSet`：简短线索供模型使用，“已经用到的最后一条 Pi entry”供下一次生成使用。Pi Adapter
只把线索临时加入普通 provider 请求；`CueSet` custom entry 不会变成 conversation message，也不会进入下一次 compaction。

**职责边界**

- Pi 保存当前工作、compaction summary、session tree 和当前路径上的 `CueSet`；
- Fact Synchronizer 告诉 Cue Provider 哪些 Pi entries 已经保存，以及以后如何找到它们；
- Cue Provider 更新简短线索；完整正文、事件细节、索引、搜索与读取留在 OpenViking；
- `CueSet` custom entry 是扩展状态，不作为会话事实再次写入 OpenViking；
- 任务模型根据当前上下文选择线索，并通过 search/read 取得精确历史。

### 4. OpenViking Client

**架构定位**

核心运行模块访问 OpenViking 的唯一出站端口。

**核心目标**

> 只通过 ingestion、search 和 read 访问 OpenViking；每次调用都可取消，并返回可诊断的结果。

**业务需求**

- 为一个不透明 Pi 来源事实执行 ingestion；
- 为任务模型工具按查询与范围执行 search；
- 按 canonical URI 与分页边界执行 read；
- 每次请求携带不可变 `OperationScope`；
- 工具参数不能覆盖 Pi Adapter 提供的 session identity 与授权范围；
- 响应以成功、失败或取消结果返回，并保留诊断 cause；
- 凭证只在授权进程内存和请求环境中传递；
- OpenViking 不可用时调用者获得有界失败结果。

**运行步骤**

- 映射 OpenViking 公开 API 或 MCP 参数；
- 处理连接、超时与取消；
- 对已证明幂等的调用执行有界重试；
- 解析 ingestion 接受结果、搜索候选与读取结果；
- 产生结构化、脱敏的调用 observation。

**职责边界**

- 存储、索引、搜索排名、分页和权限判断归 OpenViking；
- 交付进度归 Fact Synchronizer；
- Pi tool result 映射归 Pi Adapter；
- 本模块只实现 Fact Synchronizer 与 Pi Adapter 当前需要的 ingestion、search 和 read 调用。

## 支撑能力

### OperationScope

每次请求前都新建一个 `OperationScope`，请求构造完成后不再修改。系统不保存可被后续请求改写的“当前 scope”。

```text
Pi session identity + authorized OpenViking principal
  → OperationScope
  → one OpenViking request
```

调用类型决定所需范围：

- ingestion 绑定 authorized principal、workspace 和 session，entry 身份及 parent 关系随来源事实交付；
- 模型 search/read 使用 Pi 当前 session identity 与工具允许的读取范围。

模型输入只表达查询、canonical URI 和读取范围。
OpenViking 服务端继续拥有认证和权限判断；扩展负责确保请求不会越过当前 Pi 与授权身份形成的调用范围。

### Configuration & Credentials

配置与凭证解析是装配阶段使用的纯能力。目标配置面包括：

- OpenViking endpoint；
- credential reference；
- 必要的连接超时与安全上限；
- 可选 Managed OpenViking Service 的启动配置。

凭证从授权来源进入进程内存。Pi 模型与 compaction 配置由 Pi 管理；OpenViking 的存储、索引与服务端模型配置
由 OpenViking 管理，其配置值与模型凭证由部署方提供，不经过扩展进程。

### Observation

每个核心流程都会产生结构化事件。Observer 只做三件事：为事件添加关联字段、移除敏感内容、把记录写入 sink
（记录输出目标）。每条记录包含 session、operation、阶段、结果和耗时，不包含用户正文、图片 base64、凭证或
未脱敏 URI。

Observer 接收事件时必须在固定时间内返回且不能抛出异常，写入 sink 也不能延长产品 callback。如果 sink 写入失败
或记录缺少必需字段，当前运行实例的 Observer 进入 degraded；之后收到事件时直接返回，不再写入。

状态查询读取各模块的当前状态和最近失败。Observer 只写运行证据，不决定重试，也不保存另一份业务状态。

### 运行边界

Composition Root 控制 factory 装配和 active/inert 切换；Pi Adapter 处理 Pi callback 与 event，并决定何时保存
`CueSet` 或临时加入 context；每个创建工具调用或后台外部操作的模块，负责该操作的 timeout、取消和最终结果。
这些代码遵守以下规则：

- factory 同步创建全部依赖并注册 callback。装配期间 callback 保持 inert；全部步骤成功后一次性切换为 active，
  任一步骤失败则保持 inert，Pi 仍可启动；
- Pi callback 沿用 Pi 原生的异常报告与隔离，只执行有界本地工作，并且不等待后台外部任务完成；
- 工具与后台外部操作各自携带调用超时和 runtime cancellation signal；后台任务脱离 Pi 调度后由创建它的模块接收
  最终结果，shutdown 与 reload 发出取消但不等待完成；
- 外部操作先把结果保存在局部变量中。写入交付进度、`CueSet` 或 Pi context 前，再确认本次 runtime 尚未结束，
  而且 Pi 当前路径仍与操作启动时相同；两项都成立才提交一次。失败、超时、取消和过期结果均不写入。

### Managed OpenViking Service

Managed OpenViking Service 为本地托管用户启动 OpenViking，并把 endpoint 交给 OpenViking Client。使用外部
endpoint 时跳过本模块，其余记忆链路不变。

**核心目标**

> 安全、可重建地提供本地 OpenViking 服务生命周期。

其责任包括：

- 声明并固定工具链；
- setup、start、status、doctor 和 stop；
- 用户可发现的配置与数据位置；
- 授权环境中的凭证传递，包括 OpenViking 服务端模型所需的凭证；
- 基于 ownership marker、state、PID 和进程身份的停止与清理证明；
- OpenViking 官方 readiness 检查。

该模块只提供 endpoint 和部署状态，不读取 Pi session，也不参与同步、cue 选择或模型工具调用。

## 状态所有权

| 状态 | 所有者 | 生命周期 |
| --- | --- | --- |
| extension activation 与 runtime cancellation | Composition Root | 当前扩展运行实例 |
| SessionEntry、tree、branch、leaf、summary | Pi | Pi session |
| 内容、索引、URI、搜索结果 | OpenViking | OpenViking 服务 |
| 已接受交付进度 | Fact Synchronizer | 可从权威来源重建 |
| 运行中的外部操作 | 创建该操作的核心模块 | 当前扩展运行实例；shutdown 或 reload 时取消 |
| 已生成的 `CueSet` custom entry | Pi（内容由 Cue Provider 产生） | 对应 compaction 所在 tree 路径 |
| credential value | 授权进程内存 | 当前进程或请求 |
| 托管进程与 ownership state | Managed OpenViking Service | 本地服务生命周期 |
| observation records | Observer sink | 诊断与验证保留周期 |

Composition Root 只在 Pi Adapter 入口创建并连接依赖，同时保存本次运行的 activation 与 cancellation。全部装配
成功后，它一次性启用所有 callback；失败时，已经注册的 callback 仍保持 inert。状态命令读取上表各所有者的当前状态。

## 核心业务链路

### 会话事实同步

```text
Pi lifecycle
  → Pi Adapter reads accepted source entries
  → Fact Synchronizer selects pending entries
  → OpenViking Client ingest with OperationScope
  → OpenViking accepted result
  → Fact Synchronizer records which Pi entries OpenViking has saved
```

### Compaction 时更新线索

完整时序见「3. Cue Provider」的“运行步骤”。模块之间只交接三个结果：

```text
Fact Synchronizer：哪些新 entries 已保存
  → Cue Provider：新的 CueSet
  → Pi Adapter：保存 CueSet，并只把简短线索加入 provider request
```

### 历史细节恢复

```text
Task model recognizes a Memory Cue
  → Pi search/read tool
  → Pi Adapter derives OperationScope
  → OpenViking Client search/read
  → Pi TextContent / ImageContent tool result
  → Pi native context
```

### 降级

```text
factory assembly failure → inert extension runtime
Pi callback failure      → Pi native extension error path
external operation fault → bounded failure → pending fact / absent CueSet / error tool result
observer sink fault       → degraded observer
all paths                → Pi native context, compaction, agent loop and shutdown continue
```

## 依赖规则

1. Pi Adapter 是所有 Pi 生命周期、来源 entry、compaction、context 和工具接入的唯一边界；
2. OpenViking Client 是核心运行链路访问 OpenViking 的唯一出站端口；
3. Fact Synchronizer 报告 OpenViking 已保存的 entries，Cue Provider 只使用这份报告；
4. `OperationScope` 在每次操作时从 Pi 权威身份和授权 principal 构造；
5. Observer 单向接收事件；
6. Managed OpenViking Service 只向装配阶段提供 endpoint 与部署状态；
7. 模块之间只传递「模块协作契约」表中的值；每个模块只为自己“职责边界”中的工作修改代码。

## 源码组织

模块划分决定源码划分。每个模块在 `src/` 下拥有以其职责命名的目录。`contracts/` 只保存「模块协作契约」表中的
数据值；新增契约值时先更新该表。

```text
src/
├── index.ts              Composition Root：唯一装配点与 Pi 扩展入口
├── contracts/            「模块协作契约」表中的三个数据值
├── pi-adapter/
├── fact-synchronizer/
├── cue-provider/
├── openviking-client/
├── observation/
├── config/
└── managed-service/
```

新文件必须落在某个模块目录内。找不到归属时只有两种情况：它属于某个模块而该模块的责任表述不清，回到本文
核对；或者它需要一个新模块，按「新模块准入」上报。

目录边界使上述依赖规则成为可静态检查的事实。

## 演进与扩展边界

### 可演进方向

| 变化 | 责任位置 |
| --- | --- |
| Pi 生命周期、hook 或 content 接口变化 | Pi Adapter |
| ingestion 批次、重放或交付进度变化 | Fact Synchronizer |
| cue 增量规则、格式或固定上限变化 | Cue Provider |
| OpenViking API、MCP 或响应变化 | OpenViking Client |
| session、workspace 或 principal 字段变化 | `OperationScope` 构造边界 |
| observation sink 变化 | Observer |
| 本地 OpenViking 工具链变化 | Managed OpenViking Service |

如果变化不改变模块在本文中的目标，只修改该模块内部的函数和局部数据结构。

### 稳定战略边界

本项目只负责用 Memory Cues 连接 Pi 会话与 OpenViking 历史。替换 Pi、同时支持多种存储后端、由扩展接管 Pi
compaction，或在扩展内建立检索系统，都会改变产品目标；开始这类工作前必须由用户重新决定系统边界。

### 新模块准入

新增模块同时满足：

1. 当前已有代码需要调用它；
2. 它对一项可明确说出的结果负责，而且该结果会因自身需求变化；
3. 现有模块都无法在不扩大自身职责的情况下完成这项工作；
4. 测试可以单独检查它产生的结果。

同一项职责实际需要第二种实现时，再从现有模块已经使用的输入和结果中提取共同接口。

### 接口稳定性

下列内容发生变化时，只修改箭头右侧的位置：

- Pi lifecycle、entry、compaction 或 context API → Pi Adapter；
- session、workspace、principal 或调用参数 → `OperationScope` 的构造位置；
- OpenViking 如何确认 ingestion 已接受 → `AcceptedDelivery`；
- cue 的生成格式或向 Pi context 的呈现方式 → `CueSet`；
- OpenViking 请求和响应格式 → OpenViking Client。

## 全局系统保证

- Pi 已接受的来源 SessionEntry 是唯一会话事实标准；
- Pi 独立拥有 context、compaction、branch 和模型能力；
- OpenViking 独立拥有存储、索引、搜索、读取、服务端模型和权限；
- 一个 Pi 来源 entry 对应一个不透明来源事实；
- OpenViking 明确接受后才记录交付完成；
- Memory Cues 使用固定预算提示“历史上发生过什么、如何找到完整事实”，并说明覆盖到哪个时间为止、自身是采样而
  不是完整清单；任务模型结合当前上下文决定使用哪些线索；
- 每次 compaction 最多保存一份新 `CueSet`；新结果使用上一份 `CueSet` 和它之后已保存的新 entries，并记住本次
  已经用到的最后一条 Pi entry；
- `session_before_compact` 启动 cue 任务；`session_compact` 只保存已经生成的结果，并取消仍未完成的任务；
- Pi session tree 保存 `CueSet` custom entry，并决定 tree 导航后当前有效的 cues；
- Memory Cues 只在普通 provider context 中临时呈现，不进入后续 compaction；
- 模型工具只提供当前目标所需的 search 和 read；
- 文本、图片和未知 Pi payload 按 Pi 已接受的原值传递；
- 每次 OpenViking 操作使用由 Pi 与授权 principal 形成的不可变 scope；
- Pi callback 各自有明确完成边界，外部操作具有调用超时与取消边界；失败不改变 Pi 原生 context、compaction
  与主任务；
- 凭证保持在授权进程内存和请求环境中；
- observation 是扩展运行证据入口，并保持业务正文与凭证在记录之外。

## 验证责任

测试分别检查以下主流程，以及各模块交给下一模块的结果：

- Pi 契约验证原始来源 entries、compaction 事件、CueSet custom entry 与临时 context 投影遵守 Pi 的公开语义，
  并验证 factory、callback 异常和 callback 完成时序的真实宿主边界；
- ingestion 契约验证不透明交付、明确接受、幂等重放、取消以及失败时保持 pending；
- Cue 契约验证每次生成只使用上一份 `CueSet` 和它之后已保存的新 entries，并在新 `CueSet` 中记录最后用到的
  Pi entry；验证呈现给模型的线索带有覆盖时间与采样说明，且覆盖时间与最后用到的 entry 一致；同时验证 cue 生成
  与 Pi compaction 重叠，每个 `CompactionEntry` 最多保存一次，未保存时记录明确原因并取消未完成任务，以及 tree
  复用和后续 compaction 排除；
- 工具契约验证 search/read 参数、scope、分页以及文本和图片结果；
- 安全契约验证模型参数无法覆盖 Pi session identity 与授权范围，凭证与用户正文保持在记录之外；
- Managed Service 契约验证工具链、ownership、readiness 和安全生命周期；
- observation 契约验证成功与降级路径具有可关联的实际运行记录；
- live gate 验证真实 Pi、扩展与 OpenViking 可以完成 ingest、cue 和 search/read 链路；
- 固定 workload 测量有多少次 compaction 能及时保存新 `CueSet`、重要事件是否都有线索、模型能否用线索找到目标
  事实，以及线索占用的字符数；阈值写入对应 live gate manifest。模型是否实际采用线索、OpenViking 返回结果的质量
  作为运行观察。
