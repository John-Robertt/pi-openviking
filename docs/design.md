# Pi—OpenViking 长期记忆扩展架构总纲

## 文档职责

本文定义扩展及其功能模块的架构总纲。每个模块以相同章程说明：

- **架构定位**：模块在系统中的存在理由和依赖位置；
- **核心目标**：模块长期保持不变的战略目标；
- **业务需求**：实现战略目标必须满足的产品行为；
- **战术执行**：模块可以自主决定和实施的职责；
- **职责边界**：模块不得拥有或替代的外部职责。

具体数据结构、接口字段、算法、预算和测试用例由后续模块设计维护，但不得改变本总纲规定的战略目标与责任边界。

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

扩展只消费 Pi 已接受和已提交的事实。

### OpenViking

OpenViking 拥有：

- 内容存储；
- 索引和语义搜索；
- URI、读取和分页；
- memory、profile 和 resource；
- 服务端模型、身份、权限与存储协议。

扩展只调用 OpenViking 对外能力，不复制其内部实现。

## 模块地图

```text
                         ┌──────────────────────────┐
                         │ Extension Composition Root│
                         └─────────────┬────────────┘
                                       │ Pi lifecycle
                 ┌─────────────────────┼─────────────────────┐
                 ▼                     ▼                     ▼
        Pi Session Source       Fact Synchronization    Memory Cues
                 │                     │                     │
                 └──────────────┐      ▼      ┌──────────────┘
                                │ OpenViking  │
        Scope Binding ──────────┼── Gateway ──┼──────── Tool Bridge
                                │             │
                                └──────┬──────┘
                                       ▼
                                  OpenViking

Configuration & Credentials ── supplies validated assembly facts
Managed Service ─────────────── supplies an optional OpenViking endpoint
Observation & Status ───────── observes extension-owned integration facts
```

依赖方向只从编排模块指向边界适配模块。业务模块之间通过明确结果协作，不读取彼此内部状态。

# 核心运行模块

## 1. Extension Composition Root

**架构定位**

Pi 扩展入口和运行时装配层。它连接 Pi 生命周期与各独立模块，不承载领域行为。

**核心目标**

> 按 Pi 已完成的生命周期事实，以确定顺序协调各模块，同时保持 Pi 主任务独立可运行。

**业务需求**

- 扩展加载时完成配置、依赖、工具和生命周期注册；
- session 启动、turn 完成、compaction、branch 变化和 shutdown 均有明确调度；
- compaction 后先形成可搜索的历史事实，再建立当前 Memory Cues；
- session 替换或重载后不复用失效的 Pi 上下文对象；
- 任一子模块失败不阻断 Pi 主任务。

**战术执行**

- 创建模块实例并注入依赖；
- 将 Pi lifecycle event 路由给对应模块；
- 管理启动、取消、串行化和 shutdown 顺序；
- 汇总模块公开状态供命令和 UI 使用。

**职责边界**

- 不解释 SessionEntry；
- 不执行存储、搜索或结果排序；
- 不生成 Memory Cues；
- 不替换 Pi context 或 compaction；
- 不保存模块私有业务状态。

## 2. Pi Session Source

**架构定位**

Pi SessionManager 到扩展内部接口的来源适配层。

**核心目标**

> 原样暴露 Pi 已接受的会话事实，使所有下游功能基于同一个 Pi 权威来源运行。

**业务需求**

- 支持持久 session 和 in-memory session；
- 暴露完整 entry tree、当前 branch、leaf 和 session identity；
- 生命周期处理使用触发时刻的一致快照；
- 任意 Pi 已接受字符串、custom entry、compaction entry 和多模态 payload 均可通过；
- session 重开和 branch 切换后继续使用 Pi 当前事实。

**战术执行**

- 调用 SessionManager 的公开读取接口；
- 创建触发时刻的只读来源快照；
- 向同步和 Memory Cues 模块提供所需的 Pi entry、branch 与 summary；
- 标识来源当前是否持久化。

**职责边界**

- 不重新解析或裁决 Pi session tree；
- 不拒绝 Pi 已接受的 payload；
- 不推导扩展自己的 turn、step、role 或 content-part 事实；
- 不修改 SessionEntry、branch 或 leaf；
- 不承担 Pi JSONL 的持久化职责。

## 3. Scope Binding

**架构定位**

Pi 身份与 OpenViking 调用范围之间的安全绑定层，由同步、Memory Cues 和工具桥共同使用。

**核心目标**

> 确保每次 OpenViking 操作都绑定正确的用户、workspace、Pi session 和当前 branch 事实。

**业务需求**

- 从当前 Pi runtime 取得不可伪造的 session 与 workspace 身份；
- 从授权来源取得 OpenViking 用户身份；
- session-scoped 操作不能由模型参数覆盖当前 session；
- branch-scoped Memory Cues 只使用当前 branch；
- 跨 session memory/resource 只通过 OpenViking 明确授权能力访问。

**战术执行**

- 生成不可变的 operation scope；
- 为 ingestion、search、read 和其他工具请求附加 scope；
- 在 session 或 branch 变化时更新绑定；
- 拒绝与当前绑定冲突的调用参数。

**职责边界**

- 不实现 OpenViking 服务端认证与权限；
- 不决定 OpenViking namespace 结构；
- 不保存用户凭证正文；
- 不根据语义相关性扩大访问范围。

## 4. OpenViking Gateway

**架构定位**

所有运行时模块访问 OpenViking 的唯一出站端口。

**核心目标**

> 以稳定、可诊断、可取消的接口消费 OpenViking 对外能力，而不泄漏传输细节给业务模块。

**业务需求**

- 支持 ingestion、search、read、browse、memory/resource 和 health 能力；
- 所有请求携带 Scope Binding 提供的身份；
- 响应明确区分成功、服务错误、协议错误、超时和取消；
- 凭证只在授权进程内存和请求环境中传递；
- OpenViking 不可用时返回可诊断失败。

**战术执行**

- 映射 OpenViking API 或 MCP 参数；
- 处理连接、超时、取消和有界重试；
- 解析公开响应并返回类型稳定的结果；
- 提供服务健康状态。

**职责边界**

- 不实现 OpenViking 存储、索引、搜索和分页算法；
- 不重新计算或调整搜索排名；
- 不创建扩展私有内容协议；
- 不决定业务重试、同步前沿或 cue 选择。

## 5. Fact Synchronization

**架构定位**

Pi Session Source 到 OpenViking Gateway 的可靠增量交付协调器。

**核心目标**

> 将每个 Pi 已接受的会话事实最终交给 OpenViking，并且任何外部失败都不反向改变 Pi。

**业务需求**

- 同步完整 Pi entry tree，包括当前 branch、祖先和 sibling branch；
- 一个 Pi entry 作为一个不透明来源事实提交；
- 只有 OpenViking 明确接受后才推进同步进度；
- 网络、服务和进程失败后可以从 Pi 来源重放；
- session 重开、branch 切换和重复提交保持幂等；
- 同步不阻断 Pi 主任务。

**战术执行**

- 比较 Pi 来源与最小 `SyncFrontier`；
- 按依赖顺序选择尚未确认的 entries；
- 通过 Gateway 提交 Pi 来源身份和原 entry；
- 根据明确接受结果推进并持久化 frontier；
- 暴露 pending、accepted 和 failure 状态。

**职责边界**

- 不创建 Archive、Checkpoint 或第二套事件语义；
- 不拆分或重写 Pi payload；
- 不实现 OpenViking 存储与索引；
- 不生成 Memory Cues；
- 不因派生能力失败回退已确认进度。

## 6. Memory Cues

**架构定位**

Pi compaction summary 与 OpenViking 长期历史之间的识别记忆层，是扩展的核心语义功能。

**核心目标**

> 在每次 Pi compaction 后提供少量与当前工作相关的线索，使任务模型意识到“我记得这个”，并能在需要时通过 OpenViking 找回精确细节。

**业务需求**

- 使用当前 branch 的 Pi `CompactionEntry` summary 表达当前工作语义；
- 只消费 OpenViking 已接受历史的搜索候选；
- 使用 OpenViking 原有排名，不建立本地索引或重新计算相关性；
- 只呈现少量自然语言主题线索，不呈现历史正文；
- 不承诺覆盖全部历史；
- 没有相关候选时不注入内容；
- 同一 compaction 周期内 cues 保持稳定；
- 新 compaction 或 branch 变化后重新选择；
- cues 不进入下一次 Pi compaction summary。

**战术执行**

- 从 Pi Session Source 取得当前 summary；
- 通过 Gateway 在当前 Scope Binding 内执行一次相关历史搜索；
- 按 OpenViking 顺序选择有界候选；
- 从 OpenViking 已提供的 title、abstract 或等价字段形成 cues；
- 通过 Pi system-context 扩展点加入当前 cues；
- 在 provider context 中保持当前周期 cues 不变。

**职责边界**

- 不生成第二份任务 summary；
- 不复制完整历史、搜索结果正文、URI、entry ID 或分数；
- 不生成全量主题目录；
- 不实现检索、重排或内容摘要；
- 不创建模型可见 conversation entry；
- 不替换 Pi context、recent tail 或 compaction；
- 不保证概率模型一定使用某条 cue。

## 7. OpenViking Tool Bridge

**架构定位**

任务模型调用 OpenViking 能力的 Pi 工具适配层。

**核心目标**

> 让任务模型能够沿 Memory Cues 搜索、读取和使用历史来源，并执行明确授权的 OpenViking memory/resource 操作。

**业务需求**

- 提供历史搜索和精确来源读取；
- 提供 OpenViking browse、remember 和明确对象操作；
- 每次调用自动绑定当前 Scope Binding；
- 文本和图片结果能进入 Pi tool result；
- 大内容遵循 OpenViking 分页或有界读取接口；
- 破坏性操作只接受精确 canonical URI；
- 工具失败不阻断 Pi agent loop。

**战术执行**

- 注册薄 Pi 工具定义；
- 将工具参数转发给 Gateway；
- 将 OpenViking 文本映射为 Pi `TextContent`；
- 将 OpenViking 图片映射为 Pi `ImageContent`；
- 将失败映射为可诊断的 Pi tool result。

**职责边界**

- 不实现 OpenViking 搜索、读取、分页和对象管理；
- 不根据语义分数自动选择破坏性对象；
- 不自行解释图片或未知内容；
- 不临时改写 user/system message；
- 不主动执行模型未请求的历史恢复。

# 支撑模块

## 8. Configuration & Credentials

**架构定位**

向 Composition Root 提供经过验证的、可移植的运行装配事实。

**核心目标**

> 以最少配置安全地连接 Pi 与 OpenViking，并使同一仓库在不同机器上可重建运行。

**业务需求**

- 配置 schema 有明确默认值并拒绝未知字段；
- 配置只包含扩展集成策略；
- 凭证从授权来源进入进程内存，不写入仓库、状态和日志；
- 路径基于用户空间、workspace 或包位置推导；
- Memory Cues 只配置有界数量和字符预算；
- Pi 模型和 compaction 配置继续由 Pi 管理；
- OpenViking 存储、索引和模型配置继续由 OpenViking 管理。

**战术执行**

- 解析、验证和规范化扩展配置；
- 解析 endpoint、scope 策略、同步策略和 cue 预算；
- 在运行时解析凭证引用；
- 向 Composition Root 输出不可变配置。

**职责边界**

- 不保存凭证值；
- 不复制 Pi 或 OpenViking 的内部配置 schema；
- 不根据机器状态静默改变产品语义；
- 不承载运行时业务流程。

## 9. Managed OpenViking Service

**架构定位**

为需要本地托管的用户提供可选 OpenViking 服务生命周期，不参与记忆语义。

**核心目标**

> 安全、可重建地提供一个可由 Gateway 使用的 OpenViking endpoint。

**业务需求**

- 安装和启动使用声明并固定的工具链；
- setup、start、status、doctor 和 stop 提供明确结果；
- 服务配置和数据位于用户可发现的空间；
- 凭证只通过授权环境和 OpenViking 认证机制传递；
- stop 和清理必须验证 ownership marker、state、PID 和进程身份；
- 外部 OpenViking endpoint 可以完全绕过本模块。

**战术执行**

- 管理 OpenViking 工具链、配置和进程；
- 建立健康检查和状态摘要；
- 将可用 endpoint 提供给 Composition Root 和 OpenViking Gateway；
- 执行有 ownership 证明的停止和安全清理。

**职责边界**

- 不读取 Pi session；
- 不执行同步、cue 选择或工具调用；
- 不定义 OpenViking 存储和模型语义；
- 不把机器特定路径带入发布实现；
- 不管理外部 OpenViking 服务。

## 10. Observation & Status

**架构定位**

扩展自有集成链路的统一运行证据和状态投影层。

**核心目标**

> 让开发者能够定位 Pi—扩展—OpenViking 链路从哪一步开始偏离预期，而不建立第二套业务状态。

**业务需求**

- 同步、cue 选择、工具桥接、scope 和服务连接均有成功与降级点位；
- 一次操作具有可关联的 session、operation 和阶段字段；
- 状态只投影当前可执行事实和最近失败；
- 用户内容、图片 base64、凭证和未脱敏 URI 不进入记录；
- observation 失败不改变业务结果。

**战术执行**

- 维护唯一 observation registry；
- 接收各模块的结构化事件；
- 执行分类、关联、脱敏和 sink 输出；
- 向 `/viking`、CLI 和 live verifier 提供有界状态摘要。

**职责边界**

- 不复制 Pi 的 context、cache 或 compaction 观察；
- 不复制 OpenViking 的存储、索引或搜索内部观察；
- 不保存业务正文；
- 不生成独立“诊断事实”替代实际运行记录；
- 不参与业务决策和重试。

# 核心业务链路

## 会话事实同步

```text
Pi lifecycle
  → Composition Root
  → Pi Session Source
  → Fact Synchronization
  → Scope Binding
  → OpenViking Gateway
  → OpenViking
  → accepted result
  → SyncFrontier
```

## Compaction 后长期记忆线索

```text
Pi CompactionEntry
  → Pi Session Source
  → Fact Synchronization confirms accepted history
  → Memory Cues queries OpenViking Gateway with current summary
  → bounded OpenViking candidates
  → Memory Cues in Pi system context
```

## 历史细节恢复

```text
Task model recognizes a Memory Cue
  → OpenViking Tool Bridge
  → Scope Binding
  → OpenViking Gateway
  → OpenViking search/read
  → Pi TextContent / ImageContent tool result
  → Pi native context
```

## 降级

```text
any extension/OpenViking failure
  → Observation & Status
  → bounded diagnostic result
  → Pi native context and agent loop continue
```

# 模块依赖规则

1. Composition Root 只负责装配和时序，不承载模块业务；
2. Pi Session Source 是所有 Pi 会话事实的唯一扩展入口；
3. OpenViking Gateway 是所有 OpenViking 运行时调用的唯一出站端口；
4. Scope Binding 是同步、Memory Cues 和工具调用共享的身份来源；
5. Fact Synchronization、Memory Cues 和 Tool Bridge 彼此不读取私有状态；
6. Memory Cues 只消费 Pi summary 与 OpenViking 候选，不消费自建历史投影；
7. Observation & Status 只接收事件，不反向控制业务模块；
8. Managed Service 只提供 endpoint，不依赖任何会话业务模块；
9. Configuration 只向装配层输出事实，不调用运行时业务；
10. 任何新增模块必须具有独立消费者、独立战略目标和无法由现有模块承担的职责。

# 全局系统保证

- Pi 已接受的 SessionEntry 是唯一会话事实标准；
- Pi 独立拥有 context、compaction、branch 和模型能力；
- OpenViking 独立拥有存储、索引、搜索和读取；
- 一个 Pi entry 对应一个不透明来源事实；
- OpenViking 明确接受后才推进 SyncFrontier；
- Memory Cues 只提示少量相关历史存在，不复制详情或构建第二份 summary；
- Memory Cues 在同一 compaction 周期保持稳定且不进入下一次 compaction；
- 文本、图片和未知 payload 保持 Pi 已接受语义；
- 破坏性操作只接受精确 canonical URI；
- 外部失败不改变 Pi 原生上下文和主任务执行；
- 凭证不进入仓库、状态、日志、测试输入或 artifact；
- 统一 observation registry 是扩展运行证据的唯一入口。

# 验证责任

模块验证只证明扩展拥有的接口与协作行为：

- Pi Session Source 证明公开读取和快照适配，不重复验证 Pi 内部实现；
- Gateway 证明请求与响应适配，不重复验证 OpenViking 内部实现；
- Fact Synchronization 证明交付、frontier 和重放；
- Memory Cues 证明候选来源、边界、稳定注入和 fail-open；
- Tool Bridge 证明 scope、参数、结果类型和精确破坏性边界；
- Managed Service 证明工具链、ownership 和安全生命周期；
- Observation 证明点位、关联和脱敏；
- live gate 证明真实 Pi、扩展与 OpenViking 可以互操作；
- 任务模型是否采用 cue 与 OpenViking 搜索质量作为运行测量，不作为确定性机制断言。

# 后续设计入口

后续模块设计按本总纲分别确定：

- Pi Session Source 的最小来源接口；
- Scope Binding 的身份结构；
- OpenViking Gateway 的公开端口；
- SyncFrontier 的最小数据结构；
- Memory Cues 的候选字段、查询、数量、字符预算和呈现格式；
- Tool Bridge 的工具集合和结果映射；
- Managed Service 的 ownership 与清理协议；
- Observation registry 的点位契约；
- Composition Root 的生命周期时序。

任一详细设计如果需要改变模块的架构定位、核心目标或职责边界，必须回到本总纲重新决策。
