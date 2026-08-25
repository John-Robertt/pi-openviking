# Pi—OpenViking 长期记忆扩展架构总纲

## 文档职责

**架构定位**：项目目标架构与稳定边界的总纲；后续模块设计服从本文的战略目标与责任边界。

**核心目标**：维护者能够确认系统的唯一目标、外部责任边界、模块职责与依赖方向，并判断每类变化的归属位置。

**职责边界**：本文维护扩展的目标架构、外部边界、核心模块、支撑能力、依赖方向和演进规则；具体字段、算法、预算与测试用例由对应模块设计维护。

## 系统战略目标

本扩展依附于 Pi，并使用 OpenViking 的完整历史能力。系统唯一目标是：

> **让任务模型在 Pi 长期会话中经过 compaction 和 branch 变化后，仍能意识到与当前任务相关的历史记忆存在，并在需要精确细节时通过 OpenViking 找回。**

三方关系是：

```text
Pi summary：我现在在做什么
Memory Cues：我记得哪些相关事情
OpenViking：这些事情的完整历史是什么
```

Pi 是会话与模型上下文的权威，OpenViking 是存储与检索能力的提供者，扩展是二者之间的集成与语义桥。

## 外部责任边界

### Pi

Pi 拥有：

- SessionEntry、session tree、branch 和 leaf；
- entry 到模型消息的映射；
- system、tools 和 provider payload；
- 模型能力、上下文计量和 cache usage；
- compaction 触发、边界、summary 和 `CompactionEntry`；
- tool result 持久化及文本、图片的 provider 映射。

扩展消费 Pi 已接受和已提交的事实，并通过 Pi 提供的生命周期、system-context 和工具接口参与运行。

### OpenViking

OpenViking 拥有：

- 内容存储；
- 索引和语义搜索；
- URI、读取和分页；
- 服务端模型、身份、权限与存储协议。

扩展通过 OpenViking 公开的 ingestion、search 和 read 能力完成长期历史写入与恢复。

这些能力有部署前提：语义索引与摘要由 OpenViking 的服务端模型产生，其模型配置与凭证由部署方在服务端提供，
不经过扩展进程。前提不满足时 search 仍可返回结果标识，但 Memory Cues 缺少可读内容。

## 最小目标架构

```text
                              Pi
                               │
               lifecycle / snapshot / context / tools
                               ▼
                        ┌─────────────┐
                        │ Pi Adapter  │
                        └───┬─────┬───┘
                            │     │
             PiSnapshot     │     │ PiSnapshot + CompactionEntry
                            ▼     ▼
                  ┌────────────┐  ┌────────────┐
                  │    Fact    │  │    Cue     │
                  │Synchronizer│  │  Provider  │
                  └─────┬──────┘  └─────┬──────┘
                        │               │
                        └───────┬───────┘
                                ▼
                     ┌──────────────────┐
                     │ OpenViking Client│
                     │ ingest/search/read│
                     └─────────┬────────┘
                               ▼
                          OpenViking
```

核心运行架构由四个模块组成：

1. Pi Adapter；
2. Fact Synchronizer；
3. Cue Provider；
4. OpenViking Client。

逐操作 `OperationScope`、配置装配和结构化 observation 是跨模块支撑能力。Managed OpenViking Service 是核心记忆链路之外的可选部署模块。

## 模块协作契约

模块通过少量数据值协作：

| 契约 | 生产者 | 消费者 | 责任 |
| --- | --- | --- | --- |
| `PiSnapshot` | Pi Adapter | Fact Synchronizer、Cue Provider | 表达触发时刻的 Pi 权威来源视图 |
| `OperationScope` | Pi Adapter 与授权身份来源 | OpenViking Client | 绑定一次调用所需的 principal、workspace、session 及当前 branch 范围 |
| `AcceptedDelivery` | OpenViking Client | Fact Synchronizer | 表达一个来源事实已被明确接受 |
| `CueSet` | Cue Provider | Pi Adapter | 表达当前 compaction 周期的有界 Memory Cues |

这些契约只承载调用所需事实。Pi 原始 entry 作为不透明 payload 交付，OpenViking 公开结果保持其服务端语义。

## 核心运行模块

### 1. Pi Adapter

**架构定位**

Pi 扩展入口与唯一 Pi 边界适配模块。它连接 Pi 生命周期、会话快照、system-context 和模型工具。

**核心目标**

> 以 Pi 已完成的生命周期事实驱动长期记忆链路，同时保持 Pi 对会话和模型上下文的完整所有权。

**业务需求**

- 支持持久 session 和 in-memory session；
- 从 Pi 公开接口取得完整 entry tree、当前 branch、leaf、session identity 和 compaction summary；
- 每次生命周期处理使用触发时刻的一致 `PiSnapshot`；
- 任意 Pi 已接受字符串、custom entry、compaction entry 和多模态 payload 均可进入快照；
- 在 compaction 后通过不产生 SessionEntry 的 system-context 接口提供 `CueSet`；
- 向任务模型提供 OpenViking search 和 read 工具；
- 将 OpenViking 文本和图片结果映射为 Pi 支持的 tool result content；
- session 重开、branch 切换、扩展重载和 shutdown 均重新取得 Pi 当前事实；
- 任一扩展链路失败时 Pi 主任务继续运行。

**战术执行**

- 注册 Pi 生命周期、context hook、命令和工具；
- 从 SessionManager 公开读取接口构造只读 `PiSnapshot`；
- 先触发事实交付，再请求当前 compaction 的 cues；
- 将 `CueSet` 格式化为少量 system-context 文本；
- 将 search/read 工具参数与当前快照组合为 `OperationScope`；
- 将 OpenViking Client 结果映射为 Pi 工具结果；
- 在查询状态时组合各模块当前公开结果。

**职责边界**

- SessionEntry、session tree、branch、leaf 和 provider context 的解释权归 Pi；
- 历史交付由 Fact Synchronizer 决定；
- cue 查询与选择由 Cue Provider 决定；
- OpenViking transport 与响应解析由 OpenViking Client 决定；
- 工具能力限于当前目标所需的 search 和 read。

### 2. Fact Synchronizer

**架构定位**

PiSnapshot 到 OpenViking Client 的可靠历史交付模块。

**核心目标**

> 将每个 Pi 已接受的会话事实最终交给 OpenViking，并使外部失败保持在扩展边界内。

**业务需求**

- 覆盖完整 Pi entry tree，包括当前 branch、祖先和 sibling branch；
- 一个 Pi entry 作为一个不透明来源事实提交；
- OpenViking 明确接受后记录对应交付结果；
- 网络、服务和进程失败后可以从 PiSnapshot 重放；
- session 重开、branch 切换和重复提交保持幂等；
- 交付工作不阻断 Pi 主任务；
- 增量机制只表达可重建的交付进度。

**战术执行**

- 比较 PiSnapshot 与已接受交付状态；
- 按 Pi 来源依赖顺序选择待交付 entries；
- 通过 OpenViking Client 提交来源身份和原始 entry；
- 只根据 `AcceptedDelivery` 更新交付进度；
- 向调用者公开本次 pending、accepted 和 failure 结果。

交付状态的具体结构、持久化方式和批次策略由 OpenViking 幂等契约与真实会话规模共同决定。该状态可以从 Pi 权威来源和 OpenViking 接受结果重建。

**职责边界**

- Pi entry 的语义和有效性由 Pi 决定；
- 内容存储、索引和去重由 OpenViking 决定；
- 本模块保持 entry payload 完整，不派生 turn、step、role 或第二套事件标准；
- Cue Provider 独立消费交付完成结果。

### 3. Cue Provider

**架构定位**

Pi compaction summary 与 OpenViking 长期历史之间的最小识别记忆模块。

**核心目标**

> 在每次 Pi compaction 后提供少量与当前工作相关的线索，使任务模型意识到相关历史存在，并能在需要时主动读取精确细节。

**业务需求**

- 使用当前 branch 的 Pi `CompactionEntry.summary` 表达当前工作；
- 搜索范围只包含 OpenViking 已接受的历史；
- 每个新的 branch 与 compaction 组合执行一次相关历史搜索；
- 保持 OpenViking 原有排名；
- 使用 OpenViking 服务端产生的 title、abstract 或等价字段，不在扩展内生成或改写；
- 只呈现少量自然语言主题线索；
- 同一 branch 与 compaction 组合复用同一 `CueSet`；
- session 重开或扩展重载后，相同 branch 与 compaction 组合继续复用原 `CueSet`；
- 新 compaction 或 branch 变化形成新的 cue 周期；
- 没有相关候选时返回空结果；
- OpenViking 失败时返回可诊断的空结果。

**战术执行**

```text
CompactionEntry.summary
  → OpenViking search once
  → preserve server ranking
  → take bounded candidates
  → format title/abstract
  → CueSet
```

Cue Provider 只保存维持周期稳定性所需的最小派生 memo：

```text
session identity + branch identity + compaction identity + CueSet
```

该 memo 不形成 SessionEntry，也不参与 OpenViking 排名；其保存周期覆盖同一 session 的重开与扩展重载，并在 branch 或 compaction 身份变化后替换。

候选数量和总字符采用固定保守上限。出现需要运行时调整的明确消费者后，再将对应上限纳入配置。

**职责边界**

- 当前工作状态由 Pi summary 表达；
- 历史存储、召回、排序和摘要由 OpenViking 提供；
- CueSet 表达历史线索，不承载正文、URI、entry ID、分数或全量主题目录；
- CueSet 通过 system-context 提供，不形成 conversation entry；
- 概率模型是否采用某条 cue 属于运行测量。

### 4. OpenViking Client

**架构定位**

核心运行模块访问 OpenViking 的唯一出站端口。

**核心目标**

> 以稳定、可诊断、可取消的窄接口消费 OpenViking ingestion、search 和 read 能力。

**业务需求**

- 为一个不透明 Pi 来源事实执行 ingestion；
- 按查询与范围执行 search；
- 按 canonical URI 与分页边界执行 read；
- 每次请求携带不可变 `OperationScope`；
- 工具参数不能覆盖 Pi Adapter 提供的 session 或 branch 身份；
- 响应以成功、失败或取消结果返回，并保留诊断 cause；
- 凭证只在授权进程内存和请求环境中传递；
- OpenViking 不可用时调用者获得有界失败结果。

**战术执行**

- 映射 OpenViking 公开 API 或 MCP 参数；
- 处理连接、超时与取消；
- 对已证明幂等的调用执行有界重试；
- 解析 ingestion 接受结果、搜索候选与读取结果；
- 产生结构化、脱敏的调用 observation。

**职责边界**

- 存储、索引、搜索排名、分页和权限判断归 OpenViking；
- 交付进度归 Fact Synchronizer；
- cue 选择归 Cue Provider；
- Pi tool result 映射归 Pi Adapter；
- 客户端能力面由当前 ingestion、search 和 read 消费者驱动。

## 支撑能力

### OperationScope

`OperationScope` 是逐操作构造的不可变值，而不是维护当前绑定的运行模块。

```text
PiSnapshot identity + authorized OpenViking principal
  → OperationScope
  → one OpenViking request
```

调用类型决定所需范围：

- ingestion 绑定 authorized principal、workspace 和 session，entry 身份及 parent 关系随来源事实交付；
- cue search 额外绑定当前 branch；
- 模型 search/read 使用 Pi 当前运行身份与工具允许的读取范围。

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

各核心流程产生统一结构化事件，由无业务决策能力的 observer 完成关联、脱敏和 sink 输出。

必要关联字段覆盖 session、operation、阶段、结果和耗时。用户正文、图片 base64、凭证和未脱敏 URI 保持在 observation 边界之外。

状态查询在请求时组合各模块当前公开结果和最近失败事件。Observer 保存运行证据，不建立第二套业务状态，也不参与重试和决策。

### Managed OpenViking Service

Managed OpenViking Service 是可选部署模块，向需要本地托管的用户提供可由 OpenViking Client 使用的 endpoint。外部 OpenViking endpoint 使用同一核心记忆架构。

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
| SessionEntry、tree、branch、leaf、summary | Pi | Pi session |
| 内容、索引、URI、搜索结果 | OpenViking | OpenViking 服务 |
| 已接受交付进度 | Fact Synchronizer | 可从权威来源重建 |
| 当前 `CueSet` memo | Cue Provider | 同一 session + branch + compaction 周期 |
| credential value | 授权进程内存 | 当前进程或请求 |
| 托管进程与 ownership state | Managed OpenViking Service | 本地服务生命周期 |
| observation records | Observer sink | 诊断与验证保留周期 |

Composition Root 只在 Pi Adapter 入口装配依赖。状态命令按需组合以上所有者的公开结果。

## 核心业务链路

### 会话事实同步

```text
Pi lifecycle
  → Pi Adapter creates PiSnapshot
  → Fact Synchronizer selects pending entries
  → OpenViking Client ingest with OperationScope
  → OpenViking accepted result
  → accepted delivery progress
```

### Compaction 后长期记忆线索

```text
Pi CompactionEntry
  → Pi Adapter creates PiSnapshot
  → Fact Synchronizer confirms accepted history
  → Cue Provider searches with current summary
  → bounded CueSet
  → Pi Adapter system-context
  → provider-visible context
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
extension or OpenViking failure
  → structured observation
  → bounded failure or empty CueSet
  → Pi native context and agent loop continue
```

## 依赖规则

1. Pi Adapter 是所有 Pi 生命周期、会话快照、context 和工具接入的唯一边界；
2. OpenViking Client 是核心运行链路访问 OpenViking 的唯一出站端口；
3. Fact Synchronizer 与 Cue Provider 只通过公开结果协作；
4. `OperationScope` 在每次操作时从 Pi 权威身份和授权 principal 构造；
5. Observer 单向接收事件；
6. Managed OpenViking Service 只向装配阶段提供 endpoint 与部署状态；
7. 模块之间通过窄数据契约协作，并各自拥有一个变化原因。

## 演进与扩展边界

### 可演进方向

| 变化 | 责任位置 |
| --- | --- |
| Pi 生命周期、hook 或 content 接口变化 | Pi Adapter |
| ingestion 批次、重放或交付进度变化 | Fact Synchronizer |
| cue 查询、格式或固定预算变化 | Cue Provider |
| OpenViking API、MCP 或响应变化 | OpenViking Client |
| session、workspace 或 principal 字段变化 | `OperationScope` 构造边界 |
| observation sink 变化 | Observer |
| 本地 OpenViking 工具链变化 | Managed OpenViking Service |

模块内部可以通过纯函数和局部数据结构演进。相同战略目标下的内部步骤保持在所属模块内。

### 稳定战略边界

Pi 宿主、OpenViking 历史能力和 Memory Cues 语义共同定义本项目身份。替换宿主、引入通用多存储后端、接管 Pi compaction 或建立本地检索系统会改变项目战略目标，需要重新设计系统边界。

### 新模块准入

新增模块同时满足：

1. 具有独立消费者；
2. 具有独立战略目标；
3. 现有模块无法完整承担其职责；
4. 具有可独立验证的公开结果。

第二种实现方式本身不要求预先建立策略接口。出现真实替换需求后，从现有模块的窄边界提取对应策略。

### 接口稳定性

扩展性来自稳定责任和窄数据契约，而不是通用插件框架：

- `PiSnapshot` 隔离 Pi 读取变化；
- `OperationScope` 隔离身份与调用参数；
- `AcceptedDelivery` 隔离 OpenViking 接受语义；
- `CueSet` 隔离 cue 生成与 Pi context 呈现；
- OpenViking transport 保持在 Client 内部。

## 全局系统保证

- Pi 已接受的 SessionEntry 是唯一会话事实标准；
- Pi 独立拥有 context、compaction、branch 和模型能力；
- OpenViking 独立拥有存储、索引、搜索、读取、服务端模型和权限；
- 一个 Pi entry 对应一个不透明来源事实；
- OpenViking 明确接受后才记录交付完成；
- Memory Cues 只提示少量相关历史存在；
- Memory Cues 在同一 session、branch 与 compaction 周期保持稳定，包括 session 重开和扩展重载；
- Memory Cues 通过 system-context 提供，并保持在 Pi conversation entries 之外；
- 模型工具只提供当前目标所需的 search 和 read；
- 文本、图片和未知 Pi payload 保持 Pi 已接受语义；
- 每次 OpenViking 操作使用由 Pi 与授权 principal 形成的不可变 scope；
- 外部失败保持在扩展边界内，Pi 原生上下文和主任务继续运行；
- 凭证保持在授权进程内存和请求环境中；
- observation 是扩展运行证据入口，并保持业务正文与凭证在记录之外。

## 验证责任

验证围绕产品链路和边界结果组织：

- Pi 契约验证任意已接受 entry、branch、compaction 和多模态 payload 可以形成一致快照；
- ingestion 契约验证不透明交付、明确接受、幂等重放和 fail-open；
- Cue 契约验证候选来源、服务端排序、有界格式、周期稳定性和空结果；
- 工具契约验证 search/read 参数、scope、分页以及文本和图片结果；
- 安全契约验证模型参数无法覆盖 Pi session/branch，凭证与用户正文保持在记录之外；
- Managed Service 契约验证工具链、ownership、readiness 和安全生命周期；
- observation 契约验证成功与降级路径具有可关联的实际运行记录；
- live gate 验证真实 Pi、扩展与 OpenViking 可以完成 ingest、cue 和 search/read 链路；
- 模型是否采用 cue 与 OpenViking 搜索质量作为运行测量，不作为确定性机制断言。
