# Pi 长期记忆扩展架构总纲

## 文档职责

**架构定位**：项目目标架构与稳定边界的唯一说明。

**核心目标**：维护者能够从本文确认系统交付的结果、模块分工、交接数据和依赖方向。

**职责边界**：本文维护系统目标、模块职责、公共数据契约、运行链路和全局保证。每个模块的实现自行维护数据来源、存储、索引、同步、算法、外部 SDK 和配置。

## 系统目标

本扩展依附于 Pi，为一次长期会话提供以下结果：

> **Pi 压缩旧上下文或切换 branch 后，任务模型仍能看到一小份历史线索；模型需要细节时，可以根据线索取回对应的完整事实。**

compaction 是 Pi 用摘要替换旧上下文的过程。branch 是同一 session 中的一条工作路径。

模型看到三层内容：

```text
Pi 当前上下文：模型现在正在处理什么
Memory Cues：以前发生过哪些值得回看的事情
Retrieved Content：某条线索对应的完整事实
```

Pi 管理会话生命周期、当前上下文和模型工具入口。本扩展以当前 session 和 branch 为工作范围，在这个范围内准备线索和找回事实。

## 架构总览

```text
                         ┌──────────────┐
                         │      Pi      │
                         └──────┬───────┘
                                │ lifecycle / context / tools
                         ┌──────▼───────┐
                         │ Pi Boundary  │
                         └───┬──────┬───┘
                             │      │
                    ┌────────▼─┐  ┌─▼─────────┐
                    │   Cue    │  │ Retriever │
                    │ Provider │  │           │
                    └──────────┘  └───────────┘
```

运行结构由三个模块组成：

| 模块 | 交付的结果 |
| --- | --- |
| Pi Boundary | 把当前 Pi 状态转换成记忆操作，并把结果交回 Pi |
| Cue Provider | 返回当前范围内可展示的历史线索 |
| Retriever | 根据线索中的凭据返回完整事实 |

保存、同步、索引和缓存服务于线索或找回结果，由对应实现维护。Cue Provider 和 Retriever 可以采用不同方案，也可以由装配代码向两者提供同一个内部数据客户端。

## 模块交接契约

公共契约像模块之间的交接单：它只写交付什么，模块内部做法由对应实现维护。业务内容有四种公共数据值；预算和取消信号只控制一次调用。

### MemoryScope

`MemoryScope` 表示“这次操作可以使用哪一段记忆”。Pi Boundary 根据当前 session、branch 和扩展运行实例创建它，Cue Provider 和 Retriever 用它限定结果。

例如，用户切换 branch 后，Pi Boundary 会创建新的 `MemoryScope`；旧 branch 上尚未完成的结果不能进入新 branch。

`MemoryScope` 由 Pi Boundary 确定。模型参数不能创建、替换或扩大它。

### CueSet

`CueSet` 是准备加入模型上下文的线索集，包含：

- 一组线索；
- 一项说明，告诉模型这些线索是完整清单还是采样结果。

每条线索包含：

- 一句用于识别事件的简短内容；
- 事件时间或时间区间，可无；
- 一个 `RecallHandle`。

调用方给出线索数量和展示字符预算，Cue Provider 返回的 `CueSet` 落在预算内。生成进度和内部保存状态由 Cue Provider 自己维护。

### RecallHandle

`RecallHandle` 是可序列化的找回凭据。它像取件码：Cue Provider 生成，Pi Boundary 原样传递，Retriever 负责解释。

Cue Provider 与 Retriever 的当前实现共同约定凭据内部格式。装配验证用一次完整的“生成凭据—找回事实”链路确认两者能够配合。系统其他部分只保存和传递这个值。

### RetrievedContent

`RetrievedContent` 用项目自己的文本和图片内容块表示一条完整事实。Pi Boundary 把这些内容块转换成 Pi 支持的工具结果。

Retriever 返回四种结果：

| 结果 | 含义 |
| --- | --- |
| `found` | 返回完整的 `RetrievedContent` |
| `notFound` | 当前 `MemoryScope` 中没有对应事实 |
| `rejected` | 凭据或调用参数不合法 |
| `unavailable` | 当前无法完成找回 |

一次找回有固定结果预算。事实能完整放入预算时返回 `found`；无法完整放入时返回 `unavailable`，避免把截断内容误称为完整事实。

## 核心模块

### Pi Boundary

**架构定位**：Pi 与记忆能力之间的运行边界，也是唯一使用 Pi SDK 的模块。

**核心目标**：

> 根据 Pi 当前状态调用线索和找回能力，并把有效结果安全地交回 Pi。

Pi Boundary 负责：

- 从当前 session、branch 和运行实例建立 `MemoryScope`；
- 在 Pi 生命周期允许准备线索时启动 `Cue Provider.prepare`；
- 在普通模型请求中读取 `Cue Provider.current`，把可用 `CueSet` 加入上下文；
- 注册按 `RecallHandle` 找回事实的模型工具；
- 调用 `Retriever.recall`，把 `RetrievedContent` 转成 Pi 工具结果；
- 为后台调用设置期限和取消信号；
- 范围改变时取消旧调用并拒绝晚到结果；
- shutdown 或 reload 时停止接收结果并取消后台工作。

Cue Provider 负责线索内容，Retriever 负责事实找回，Pi Boundary 负责 Pi 生命周期和结果呈现。Pi SDK 类型停留在本模块内。

### Cue Provider

**架构定位**：当前历史线索的提供者。

**公共接口**：

```text
prepare(scope, budget, signal) → Promise<void>
current(scope, budget)         → CueSet | empty
```

`prepare` 让 Cue Provider 为当前范围准备线索。实现可以生成新线索，也可以读取自己已经准备好的结果。调用在 Pi callback 之外运行，并接受取消信号。

`current` 返回当前已经可用的 `CueSet`。这个调用只做有界本地工作，因此 Pi 在构造模型上下文时无需等待新的生成过程。

Cue Provider 负责：

- 为当前 `MemoryScope` 准备线索；
- 让每条线索保持简短并带有 `RecallHandle`；
- 按调用预算返回 `CueSet`；
- 准备失败时保留当前仍然有效的线索；
- 在实现内部管理来源、生成、保存、缓存和进度。

### Retriever

**架构定位**：线索所指完整事实的提供者。

**公共接口**：

```text
recall(scope, handle, budget, signal) → Promise<RecallResult>
```

Retriever 解释 `RecallHandle`，在 `MemoryScope` 内查找事实，并返回 `found`、`notFound`、`rejected` 或 `unavailable`。

Retriever 负责：

- 接受当前 Cue Provider 产生的 `RecallHandle`；
- 把找回范围限定在 Pi Boundary 提供的 `MemoryScope`；
- 在期限到达或收到取消信号时结束本次调用；
- 返回完整且符合预算的 `RetrievedContent`；
- 在实现内部管理来源、保存、索引、读取、搜索和缓存。

模型参数只描述要找回的内容，实际范围始终来自 `MemoryScope`。

## 核心运行链路

### 准备和展示线索

```text
Pi 到达线索准备时机
  → Pi Boundary 建立当前 MemoryScope
  → 在 callback 外调用 Cue Provider.prepare

Pi 构造普通模型请求
  → Pi Boundary 建立当前 MemoryScope
  → 调用 Cue Provider.current
  → 有 CueSet：按预算加入上下文
  → empty：保持 Pi 原始上下文
```

### 找回完整事实

```text
模型提交线索中的 RecallHandle
  → Pi Boundary 建立当前 MemoryScope
  → 调用 Retriever.recall
  → found：转换成 Pi 工具结果
  → 其他结果：返回对应的有界工具结果
  → Pi agent loop 继续
```

### 范围改变与关闭

```text
session、branch 或运行实例改变
  → Pi Boundary 取消旧范围内的后台调用
  → 新调用使用新的 MemoryScope
  → 旧范围的晚到结果被丢弃

shutdown 或 reload
  → Pi Boundary 停止接收结果
  → 取消后台调用
  → Pi 按原生流程继续关闭
```

## 运行支撑

### 装配

宿主加载扩展时，装配代码创建 Cue Provider、Retriever 和 Pi Boundary，并把配置、凭证与外部客户端交给使用它们的实现。

装配依次确认：

1. 三个模块的公共接口完整；
2. Cue Provider 产生的 `RecallHandle` 可以由 Retriever 找回；
3. 全部模块准备完成。

确认完成后，扩展一次性开始工作。装配失败时，扩展入口直接返回，Pi 正常启动。

### Observation

Observation 单向接收模块发出的运行事件，记录运行实例、记忆范围、操作、耗时和结果分类。记录内容不含用户正文、图片内容、凭证和 `RecallHandle`。

写入失败后，Observation 停止本次运行的后续写入；线索准备、事实找回和 Pi 主流程继续运行。

## 状态与依赖

| 状态 | 所有者 |
| --- | --- |
| session、branch、context 和工具宿主状态 | Pi |
| `MemoryScope`、后台调用、期限、取消和晚到结果判定 | Pi Boundary |
| 线索准备、当前 `CueSet` 及其内部状态 | Cue Provider |
| 凭据解释、事实来源和找回状态 | Retriever |
| 脱敏运行记录 | Observation 目标 |

依赖方向固定为：

1. Pi Boundary 使用 Pi SDK，并通过公共接口调用 Cue Provider 和 Retriever；
2. Cue Provider 与 Retriever 通过 `RecallHandle` 配合，各自维护内部状态；
3. 外部服务、数据库、模型和 SDK 位于使用它们的实现内部；
4. Observation 只接收事件；
5. 模块间业务内容使用 `MemoryScope`、`CueSet`、`RecallHandle` 和 `RetrievedContent`。

## 全局系统保证

- compaction、branch 导航、session 重开或扩展重载后，Pi Boundary 重新建立 `MemoryScope`，线索和找回结果都对应当前范围；
- 每个展示给模型的 `RecallHandle` 都能通过当前 Retriever 得到完整的 `RetrievedContent`；
- 线索准备、事实找回、Observation 或装配发生失败、取消或晚到结果时，Pi 原生 context、compaction、主任务和关闭继续运行，只有当前有效结果能够进入 Pi。

## 演进规则

系统架构随用户可观察结果变化。来源、权威关系、存储、索引、同步、模型、生成算法和找回方法属于模块实现，可以独立演进。

一项新结果满足以下条件时建立新模块：

1. 当前调用方已经需要这项结果；
2. 现有模块承担它会混合两种职责；
3. 输入和输出可以独立说明；
4. 实现通过公共接口工作；
5. 成功、失败和边界行为可以单独验证。

模块内部出现两个当前实现时，从它们已经使用的输入和结果中提取私有接口。
