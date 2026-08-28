# Pi 长期记忆扩展架构总纲

## 文档职责

本文是系统目标、模块职责、公共数据契约、运行链路和依赖方向的唯一说明。维护者可以从本文确认系统交付什么、每个模块负责什么，以及模块之间交接什么。

本文只规定稳定边界。数据从哪里来、以哪份数据为准，以及如何存储、索引、同步、生成和缓存，由负责这些工作的模块实现维护；外部 SDK、配置和凭证也留在对应实现内。

## 系统目标

本扩展为 Pi 的长期会话提供以下结果：

> **Pi 压缩旧上下文或切换 branch 后，任务模型仍能看到一小份历史线索；模型需要细节时，可以根据线索取回对应的完整事实。**

compaction 是 Pi 用摘要替换旧上下文的过程。session 是一段会话，branch 是同一 session 中的一条工作路径。

模型看到三层内容：

```text
Pi 当前上下文：模型现在正在处理什么
Memory Cues：以前发生过哪些值得回看的事情
Retrieved Content：某条线索对应的完整事实
```

Pi 管理 session 生命周期、当前上下文和模型工具入口。本扩展以当前 session 和 branch 为工作范围，在这个范围内准备线索和找回事实。

## 架构总览

```text
                         ┌──────────────┐
                         │      Pi      │
                         └──────┬───────┘
                                │ 生命周期 / 上下文 / 工具
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
| Pi Boundary | 把当前 Pi 状态转换成记忆操作，并把有效结果交回 Pi |
| Cue Provider | 返回当前范围内可展示的历史线索 |
| Retriever | 根据线索中的凭据返回完整事实 |

装配代码把配置、凭证和外部客户端交给使用它们的实现；这些内部依赖不会进入公共数据契约。

## 模块交接契约

公共契约只描述模块交付什么。模块通过下列数据和入口交接内容，通过预算和取消信号控制一次调用。

### MemoryScope

`MemoryScope` 表示一次操作可以访问哪一段记忆。Pi Boundary 根据当前 session、branch 和扩展运行实例创建它，Cue Provider 和 Retriever 用它限定结果。

用户切换 branch 后，Pi Boundary 创建新的 `MemoryScope`。旧 branch 中尚未完成的结果不能进入新 branch。

`MemoryScope` 只由 Pi Boundary 确定。模型参数不能创建、替换或扩大它。

### ScopedFacts

`ScopedFacts` 是 Pi Boundary 交给 Cue Provider 和 Retriever 的事实读取入口。Cue Provider 用它读取生成线索所需的会话内容，Retriever 用它读取线索指向的完整事实，两者都不需要接触 Pi SDK。

它交付当前 `MemoryScope` 内的来源事实。来源事实指会话中已经产生的对话和工具结果，不包括 Pi 生成的摘要，也不包括扩展自己写入的内容。每条事实带有在当前 `MemoryScope` 内稳定的标识，并用项目自己的内容块表示。

它提供两种读取方式：按会话顺序分段读取，每次返回预算内的一段并指明下次从哪里继续；按标识读取单条事实。两种方式都接受取消信号，返回结果都落在调用预算内。

`ScopedFacts` 是可选输入。使用它的模块可以全部使用、部分使用，也可以使用自己的来源。

### CueSet

`CueSet` 是准备加入模型上下文的线索集。它包含一组线索，以及一项说明模型如何理解这组线索：它是完整清单，还是预算内的采样结果。

每条线索包含：

- 一句用于识别事件的简短内容；
- 事件时间或时间区间，可无；
- 一个 `RecallHandle`。

调用方给出线索数量和展示字符预算，Cue Provider 返回的 `CueSet` 必须落在预算内。线索如何生成、保存和更新，由 Cue Provider 自己维护。

### RecallHandle

`RecallHandle` 是可序列化的找回凭据。它像取件码：Cue Provider 生成，Pi Boundary 原样传递，Retriever 负责解释。

同一装配中的 Cue Provider 和 Retriever 使用相互兼容的凭据格式。两者可以分别演进内部实现，但装配在一起时必须保持这种兼容性。系统其他部分只保存和传递凭据，不读取它的内部格式。

### RetrievedContent

`RetrievedContent` 用项目自己的文本块和图片块表示一条完整事实。Pi Boundary 把这些内容块转换成 Pi 支持的工具结果。

Retriever 返回四种结果：

| 结果 | 含义 |
| --- | --- |
| `found` | 返回完整的 `RetrievedContent` |
| `notFound` | 当前 `MemoryScope` 中没有对应事实 |
| `rejected` | 凭据或调用参数不合法 |
| `unavailable` | 当前无法完成找回 |

一次找回有固定的结果预算。事实能完整放入预算时，Retriever 返回 `found`；事实不能完整放入预算时，Retriever 返回 `unavailable`，不会把截断内容当作完整事实。

## 核心模块

### Pi Boundary

**架构定位**：Pi 与记忆能力之间的运行边界，也是唯一使用 Pi SDK 的模块。

**核心目标**：

> 根据 Pi 当前状态调用线索和找回能力，并把当前范围内的有效结果安全地交回 Pi。

Pi Boundary 负责：

- 从当前 session、branch 和运行实例建立 `MemoryScope`，并为每次模块调用建立同范围的 `ScopedFacts`；
- 在 Pi 生命周期允许准备线索时启动 `Cue Provider.prepare`；
- 在普通模型请求中读取 `Cue Provider.current`，把可用的 `CueSet` 加入上下文；
- 注册根据 `RecallHandle` 找回事实的模型工具；
- 调用 `Retriever.recall`，把 `RetrievedContent` 转换成 Pi 工具结果；
- 为后台调用设置期限和取消信号；
- 范围改变时取消旧调用并拒绝晚到结果；
- `shutdown`（关闭）或 `reload`（重载）时停止接收结果并取消后台工作。

Pi Boundary 管理 Pi 生命周期和结果呈现，Cue Provider 管理线索内容，Retriever 管理事实找回。Pi SDK 类型只存在于 Pi Boundary 内。

### Cue Provider

**架构定位**：当前范围内历史线索的提供者。

**核心目标**：

> 让 Pi 在构造模型上下文时无需等待生成，直接读取已经可用且符合预算的历史线索。

**公共接口**：

```text
prepare(scope, facts, budget, signal) → Promise<void>
current(scope, budget)                → CueSet | empty
```

`prepare` 为当前 `MemoryScope` 准备线索。它在 Pi 回调（callback）之外运行，并接受取消信号。线索来源和准备方法属于 Cue Provider 内部实现。

`current` 返回当前已经可用的 `CueSet`。它只处理本地已有结果，不等待新的生成过程，所以 Pi 构造模型上下文时不会被线索生成阻塞。

Cue Provider 负责：

- 为当前 `MemoryScope` 准备线索；
- 让每条线索保持简短并带有 `RecallHandle`；
- 按调用预算返回 `CueSet`；
- 准备失败时保留仍然有效的线索；
- 在模块内部管理线索来源、生成、保存、缓存和进度。

Pi Boundary 决定何时准备和展示线索，Retriever 根据线索找回完整事实。

### Retriever

**架构定位**：线索所指完整事实的提供者。

**核心目标**：

> 在当前记忆范围内解释找回凭据；能够返回时给出完整事实，不能返回时明确说明本次结果。

**公共接口**：

```text
recall(scope, facts, handle, budget, signal) → Promise<RecallResult>
```

Retriever 解释 `RecallHandle`，在 `MemoryScope` 内查找事实，并返回 `found`、`notFound`、`rejected` 或 `unavailable`。

Retriever 负责：

- 接受同一装配中 Cue Provider 产生的 `RecallHandle`；
- 把找回范围限定在 Pi Boundary 提供的 `MemoryScope`；
- 在期限到达或收到取消信号时结束本次调用；
- 返回完整且符合预算的 `RetrievedContent`；
- 在模块内部管理事实来源、保存、索引、读取、搜索和缓存。

Pi Boundary 决定实际的 `MemoryScope` 并呈现工具结果。模型参数只能提交找回凭据，不能改变找回范围。

## 核心运行链路

### 准备和展示线索

```text
Pi 到达线索准备时机
  → Pi Boundary 建立当前 MemoryScope
  → Pi Boundary 在回调之外调用 Cue Provider.prepare

Pi 构造普通模型请求
  → Pi Boundary 建立当前 MemoryScope
  → Pi Boundary 调用 Cue Provider.current
  → 有可用 CueSet：按预算加入上下文
  → 没有可用 CueSet：保持 Pi 原始上下文
```

### 找回完整事实

```text
模型提交线索中的 RecallHandle
  → Pi Boundary 建立当前 MemoryScope
  → Pi Boundary 调用 Retriever.recall
  → found：转换成包含完整事实的 Pi 工具结果
  → 其他结果：转换成简短的 Pi 工具结果，说明为什么没有返回事实
  → Pi 继续原来的模型与工具调用流程
```

### 范围改变与关闭

```text
session、branch 或运行实例改变
  → Pi Boundary 取消旧范围内的后台调用
  → 新调用使用新的 MemoryScope
  → 旧范围的晚到结果被丢弃

shutdown 或 reload
  → Pi Boundary 停止接收结果
  → Pi Boundary 取消后台调用
  → Pi 按原生流程继续关闭
```

## 运行支撑

### 装配

宿主加载扩展时，装配代码创建 Cue Provider、Retriever 和 Pi Boundary，并把配置、凭证与外部客户端交给使用它们的实现。

装配在启用记忆能力前确认：

1. 三个模块提供完整的公共接口；
2. Cue Provider 产生的 `RecallHandle` 可以由 Retriever 找回；
3. 三个模块都已准备完成。

全部确认完成后，扩展才开始向 Pi 提供记忆能力。任何一项失败时，扩展不启用记忆能力，Pi 继续正常启动。

### Observation

Observation 是单向的运行事件出口。它接收模块发出的事件，只记录运行实例、记忆范围、操作、耗时和结果分类，不记录用户正文、图片内容、外部服务凭证或 `RecallHandle`。

Observation 写入失败后，本次运行不再写入后续事件。线索准备、事实找回和 Pi 主流程继续运行。

## 状态与依赖

每项运行状态只有一个所有者：

| 状态 | 所有者 |
| --- | --- |
| session、branch、上下文（context）和工具宿主状态 | Pi |
| `MemoryScope`、后台调用、期限、取消和晚到结果判定 | Pi Boundary |
| 线索准备、当前 `CueSet` 及其内部状态 | Cue Provider |
| 凭据解释、事实来源和找回状态 | Retriever |
| 脱敏运行记录 | Observation |

依赖方向固定为：

1. Pi Boundary 使用 Pi SDK，并通过公共接口调用 Cue Provider 和 Retriever；
2. Cue Provider 与 Retriever 通过 `RecallHandle` 配合，各自维护内部状态；
3. 外部服务、数据库、模型和 SDK 位于使用它们的实现内部；
4. Observation 只接收事件；
5. 模块之间只用 `MemoryScope`、`ScopedFacts`、`CueSet`、`RecallHandle` 和 `RetrievedContent` 交接业务内容。

## 全局系统保证

- compaction、branch 导航、session 重开或扩展重载后，Pi Boundary 根据 Pi 当前状态重新建立 `MemoryScope`；线索和找回结果只属于当前范围。
- 展示给模型的每个 `RecallHandle` 都与当前 Retriever 兼容。如果对应事实位于当前 `MemoryScope`、当前可用并且能完整放入结果预算，Retriever 返回完整的 `RetrievedContent`。
- 线索准备、事实找回、Observation 或装配失败时，Pi 原生上下文（context）、compaction、主任务和关闭流程继续运行。
- 取消、超时或晚到的结果不能进入 Pi；只有当前范围内的有效结果可以进入上下文或工具结果。

## 演进规则

只有用户可观察结果、模块职责或公共数据契约发生变化时，才修改本总纲。模块内部变化不影响这些稳定边界时，本总纲保持不变。

一项新结果同时满足以下条件时，建立新模块：

1. 当前调用方已经需要这项结果；
2. 现有模块承担它会混合两种职责；
3. 输入和输出可以独立说明；
4. 调用方只需要依赖它的公共接口；
5. 成功、失败和边界行为可以单独验证。

只有模块内部存在两个实际实现时，才从它们共同使用的输入和结果中提取私有接口。
