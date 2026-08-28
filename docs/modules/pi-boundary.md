# Pi Boundary 模块架构

## 文档职责

本文是 Pi Boundary 模块设计的唯一来源。它规定 Pi Boundary 如何解释 Pi 当前状态、建立记忆范围、挂接生命周期与模型工具、接收记忆结果，以及在范围变化、取消、失败、重载和关闭时保护 Pi 原生流程。

系统交付的产品结果、模块划分和公共业务数据由[系统设计](../design.md)规定。本文只细化 Pi Boundary 的目标机制和实现边界；线索怎样生成、事实怎样存储与搜索、模块怎样装配，分别由 Cue Provider、Retriever 和 Assembly 的设计负责。

Pi 的 lifecycle（生命周期）、context（上下文）、session（会话）、branch（分支）、compaction（上下文压缩）和工具行为以项目支持的 Pi 公开接口与真实 Pi 检查为准。Pi 行为变化而本模块目标不变时，更新实现和验证；本模块交付结果或职责变化时，更新本文，并按 [Documentation 的系统设计更新门槛](./documentation.md#系统设计更新门槛)判断是否更新系统设计。

## 架构定位与核心目标

Pi Boundary 是 Pi 与记忆模块之间的运行边界，也是唯一解释 Pi 运行状态并把记忆结果交回 Pi 的模块。

> 根据 Pi 当前 session 和 branch 建立不可由模型扩大的记忆范围；在不阻塞、不污染且不改变 Pi 原生流程的前提下展示线索、找回事实，并拒绝取消、过期或属于旧范围的结果。

## 交付结果

| 结果 | 使用者得到什么 |
| --- | --- |
| 当前记忆范围 | Cue Provider 和 Retriever 得到由 Pi 当前状态确定、模型不能修改的 `MemoryScope` |
| 事实读取入口 | Cue Provider 和 Retriever 通过 `ScopedFacts` 读取当前范围内的来源事实，不接触 Pi SDK |
| 线索准备调度 | Cue Provider 在 Pi 空闲后的后台任务中准备当前范围的线索，不阻塞 Pi 回调 |
| 临时线索上下文 | 普通模型请求得到预算内的当前 `CueSet`，session 不保存这条临时消息 |
| 完整事实工具 | 模型只提交 `RecallHandle`，Retriever 在当前范围内给出完整事实或明确的非成功结果 |
| 调用有效性保护 | 同一 branch 继续追加时仍可接收有效结果；branch、session 或运行实例变化后拒绝旧结果 |
| 失败隔离 | 记忆模块失败、超时或取消时，Pi 原生上下文、compaction、任务、切换和关闭流程继续运行 |

当前范围没有可用线索或完整事实时，Pi 继续原有流程。进入 Pi 的记忆结果必须属于当前范围、符合预算，并且在交付时仍然有效。

## 输入、输出与公共入口

### 输入

Pi Boundary 接收两类输入。

第一类来自 Pi：

- 当前 session ID；
- 当前 `getBranch()` 返回的完整祖先路径；
- 生命周期、branch 导航、compaction、普通模型上下文和工具执行事件；
- 工具执行的取消信号；
- Pi 支持的上下文消息和工具结果类型。

第二类由 Assembly 注入：

- Cue Provider 公共接口；
- Retriever 公共接口；
- Observation 单向事件出口；
- 线索数量、线索字符数和完整事实结果预算；
- 线索准备与事实找回的期限。

Pi Boundary 只通过 Pi 的公开上下文接口读取状态，不直接读取或修改 session JSONL 文件。

### 输出

Pi Boundary 只向 Pi 输出：

- 一条为当前普通模型请求临时构造的 Memory Cues 消息；
- `recall_memory` 工具的文本块和图片块结果。

Pi 扩展入口调用 Pi Boundary 的公共入口，传入 Pi API 和 Assembly 创建的依赖；Pi Boundary 随后注册生命周期处理器和事实找回工具。

## 当前记忆范围

### Pi 原生路径是范围依据

Pi 的 session tree 是追加式树。`getBranch()` 返回当前叶节点到根节点之间的完整祖先路径；它包含消息、compaction、branch summary 和 custom entry，不等同于 Pi 为下一次模型请求整理的精简上下文。

Pi Boundary 固定使用 `getBranch()` 的完整路径判断事实权限。`buildContextEntries()` 只负责整理下一次模型请求；compaction 后它会省略已有摘要覆盖的旧 entry，因此不参与事实权限判断。

以下变化具有不同语义：

- 同一 branch 追加消息、工具结果或 custom entry：当前路径增长，仍属于同一运行范围；
- compaction：当前路径增加 compaction entry，旧 entry 仍在完整祖先路径中，记忆范围没有切换；
- 成功导航到另一条 branch：当前祖先路径改变，运行范围切换；
- session 替换或扩展 reload：运行实例改变，运行范围切换。

当前 `getBranch()` 路径是 Pi Boundary 使用的 branch 表示。Pi Boundary 不另建 branch ID。

### Branch summary 是当前路径内容

用户进行 branch 导航并选择生成 summary 时，Pi 会把一个 `branch_summary` entry 写入新路径。这条 entry 自身属于当前祖先路径，因此可以作为当前历史；它总结的旧路径 entry 仍然属于被放弃的 branch。

Pi Boundary 不沿 `branch_summary.fromId` 扩大 `MemoryScope`。模型需要的历史线索只能来自当前完整祖先路径；Pi 已写入当前路径的 summary 可以提供摘要，但不能授权找回旧路径中的完整事实。

compaction entry 不需要额外规则，因为被压缩的旧 entry 仍属于当前完整祖先路径。

### MemoryScope

`MemoryScope` 是一次模块调用使用的不可变访问快照，包含：

| 值 | 含义 |
| --- | --- |
| 范围标识 | 用来区分运行实例以及 branch 导航前后结果的内部代号 |
| session ID | Pi 当前 session 的稳定 ID |
| 可见 entry ID 集合 | 当前 `getBranch()` 完整祖先路径中全部 entry 的 ID |

范围标识在同一 branch 正常追加和 compaction 时保持，在成功 branch 导航、session 替换或扩展 reload 后更换。每次调用重新取得当前可见 entry，因此同一范围标识下的集合可以随当前路径增长。

`MemoryScope` 只能由 Pi Boundary 建立。它不进入模型上下文或工具参数；模型不能提供 session ID、entry ID 或范围标识，也不能请求扩大范围。

Cue Provider 和 Retriever 使用 `session ID + entry ID` 判断线索或事实来源是否属于当前范围。entry ID 本身不够：Pi fork 新 session 时会复制当前路径中的 entry ID，但会生成新的 session ID。旧 session 的 `RecallHandle` 不能只因 entry ID 相同而在新 session 获得权限。

同一持久化 session reopen 后保留 session ID 和 entry；扩展运行实例会建立新的范围标识并重新准备线索。新建、fork、clone 或切换到另一个 session 后使用新 session ID；复制到新 session 的旧 handle 在重新生成兼容 handle 前不可用。

## 事实读取入口

`ScopedFacts` 是 Pi Boundary 为一次模块调用建立的来源事实读取入口。它与 `MemoryScope` 同时建立，读取范围等于该 `MemoryScope` 的可见 entry 集合。[系统设计](../design.md)要求每条事实带有在当前范围内稳定的标识，Pi Boundary 使用 Pi 的 entry ID 作为这个标识。

### 来源事实

当前路径中记录会话实际发生内容的 entry 是来源事实：用户与模型的消息、工具调用及其结果。

Pi 的 compaction entry 和 branch summary entry 是对事实的摘要，扩展写入的 custom entry 是扩展自己的产出。`ScopedFacts` 只交付来源事实。

### 读取方式

| 方式 | 交付什么 |
| --- | --- |
| 顺序读取 | 按当前路径顺序返回预算内的一段来源事实，并指明下次继续的 entry ID |
| 按标识读取 | 返回指定 entry ID 对应的单条来源事实 |

标识指向不可见 entry、非来源事实或不存在的 entry 时返回未找到。

Pi Boundary 把 Pi 的 entry 转换成项目自己的内容块后交付。

`ScopedFacts` 只提供读取能力，范围在建立时固定。使用它的模块通过它读取当前范围内的事实；写入 session、改变范围和访问其他 session 都不在这个入口的能力范围内。

## 异步调用有效性

范围回答“哪些事实可以访问”，调用有效性回答“某个异步结果现在还能不能交付”。两者必须分别检查。

Pi Boundary 在每次启动线索准备或事实找回时保存一份调用快照，其中至少包括：

- 当前扩展运行实例是否仍有效；
- 调用开始时的范围标识；
- 调用开始时的 session ID；
- 调用开始时当前路径的叶 entry ID，没有 entry 时记录空路径；
- 操作自己的 `AbortController` 和期限；
- 工具执行时 Pi 提供的取消信号。

异步结果只有同时满足以下条件才可交付：

1. 扩展运行实例仍在接收结果；
2. 当前范围标识和 session ID 与调用开始时相同；
3. 调用开始时的叶 entry 仍在当前祖先路径中；调用从空路径开始时，当前路径仍为空；
4. 操作没有被 Pi、范围切换、shutdown、reload、替代任务或期限取消；
5. 返回值满足当前业务预算和公共结果契约。

叶节点只要求仍是当前路径祖先，不要求等于当前叶节点。因此同一 branch 后续追加不会使准备结果失效。范围标识在每次成功 branch 导航后更换，因此用户切走后又切回原路径时，切换前尚未完成的结果仍然无效。

Pi Boundary 在交付前总是重新检查调用快照。`AbortSignal` 可能在下游已经完成工作后才生效，因此取消信号不能代替这次检查。范围隔离由 [Cue Provider 的范围隔离规定](./cue-provider.md#范围隔离)保证。

## 生命周期挂载

Pi Boundary 对 Pi 事件执行以下动作：

| Pi 时机 | Pi Boundary 动作 |
| --- | --- |
| 扩展 factory 执行 | 注册事件和 `recall_memory` 工具；不开始读取用户历史 |
| `session_start` | 激活新的运行实例和范围标识，根据当前路径调度一次后台线索准备 |
| `agent_settled` | 在一次 agent 运行及其工具、重试和自动处理全部稳定后，为最新路径调度线索准备 |
| `session_before_tree` | 不取消当前范围，不等待线索工作；导航仍可能被其他扩展取消 |
| `session_tree` | 确认导航成功后取消旧任务、更换范围标识、按新路径调度准备 |
| `session_before_compact` | 不注入线索、不阻塞或修改 Pi 的 compaction 请求 |
| `session_compact` | 保持当前范围标识，根据压缩后的当前状态调度准备 |
| `session_compact_failed` | 保持当前范围和已有线索，只记录失败分类 |
| `context` | 同步读取当前 `CueSet` 并构造临时消息；不等待 `prepare` |
| 工具 `execute` | 建立当前范围并在期限和取消信号内调用 Retriever |
| `session_before_switch`、`session_before_fork` | 不提前使当前范围失效；切换仍可能被取消 |
| `session_shutdown` | 先停止接收结果，再取消所有后台任务；不无限等待外部工作 |

reload 时，旧实例先收到 `session_shutdown(reason="reload")`，资源随后重新加载，新实例再收到 `session_start(reason="reload")`。session 替换由旧实例 shutdown 和新实例 start 划分边界；Pi Boundary 不自行猜测切换是否已经成功。

生命周期处理器只保存快照和安排任务，随后立即把控制权还给 Pi；`CueProvider.prepare` 在处理器返回后独立执行。同一范围只运行最新的准备任务；新任务取消被替代的任务，已有且仍符合当前范围的 `CueSet` 可以继续使用。

## 线索准备与上下文展示

### 准备

一次准备按以下顺序进行：

```text
取得当前 Pi 状态
  → 建立 MemoryScope、ScopedFacts 和调用快照
  → 合并实例取消、任务取消和期限
  → 在 Pi 回调返回后调用 CueProvider.prepare
  → 完成时检查调用仍有效
  → 记录结果分类，不向 Pi 写入正文
```

准备失败、超时或取消不清空仍然有效的旧线索。是否保留以及怎样缓存由 Cue Provider 负责；Pi Boundary 只通过新的 `MemoryScope` 调用 `current`。

### 展示

`context` 事件必须保持同步、只读和有界：

1. 根据事件发生时的 Pi 状态建立 `MemoryScope`；
2. 使用固定的线索数量和字符预算调用 `CueProvider.current`；
3. 没有线索、调用失败或结果超过预算时，原样返回 Pi 的消息；
4. 有合法 `CueSet` 时，把它格式化成一条 Pi 支持的隐藏 custom message，放在普通消息序列之前；
5. 返回本次请求的新消息数组，不向 session tree 追加 entry。

Pi 会把这条 custom message 转换为 provider 可见的 user message。消息必须明确标示以下内容是历史参考而不是当前用户指令，并保留 `CueSet` 的完整清单或预算采样说明。每条线索只展示简短内容、时间信息和原样编码的 `RecallHandle`；Pi Boundary 不解释或改写 handle。

线索正文属于不可信历史数据。格式化器必须用固定边界包裹数据，不能让线索内容改变消息结构、工具参数、预算或范围。无法安全编码的 `CueSet` 不进入上下文。

普通模型请求以及工具完成后的后续模型请求都会经过这条链路。Pi 的 compaction 摘要请求不经过普通 `context` 注入，Pi Boundary 不另行把线索加入 compaction。

## 完整事实工具

Pi Boundary 注册一个稳定模型工具：

```text
recall_memory({ handle })
```

工具参数只包含系统设计定义的 `RecallHandle`。模型不能提交范围、session、branch、预算、期限或结果格式。输入结构和大小在调用 Retriever 前受限；结构无效时返回 `rejected` 对应的简短说明。

一次工具调用按以下顺序进行：

```text
接收 handle
  → 建立当前 MemoryScope、ScopedFacts 和调用快照
  → 合并 Pi 工具 AbortSignal、实例取消、任务取消和期限
  → 调用 Retriever.recall(scope, facts, handle, budget, signal)
  → 检查调用仍有效及结果符合预算
  → 转换成 Pi 工具结果
```

Pi Boundary 对 Retriever 结果作以下转换：

| Retriever 结果 | Pi 工具结果 |
| --- | --- |
| `found` | 完整转换所有文本块和图片块；不能完整转换时返回 `unavailable` 说明 |
| `notFound` | 简短说明当前记忆范围没有对应事实 |
| `rejected` | 简短说明凭据或参数无效，不暴露内部解析细节 |
| `unavailable` | 简短说明当前无法完成找回，可以继续原任务 |

`notFound`、`rejected` 和 `unavailable` 都是正常工具结果。Retriever 抛错、返回未知结果或超过预算时，只要调用仍然有效，Pi Boundary 就返回 `unavailable`。Pi 已取消工具或范围已经改变时，Pi Boundary 结束这次执行，不返回 Retriever 的正文。

Pi Boundary 不截断 `RetrievedContent`。任一文本块或图片块无法在预算和 Pi 支持格式内完整交付时，本次结果为 `unavailable`。

## 失败、安全与边界行为

| 情况 | 必须产生的结果 |
| --- | --- |
| 当前路径读取失败 | 本次不提供记忆内容，Pi 原流程继续 |
| `prepare` 失败、超时或取消 | 不向 Pi 抛错；仍有效的旧 CueSet 可以保留 |
| `current` 失败或 CueSet 超预算 | 不注入线索，原始模型上下文保持不变 |
| 上下文格式化失败 | 不注入部分消息，原始模型上下文保持不变 |
| `recall` 失败或返回值无效 | 当前工具调用返回简短 `unavailable` 结果 |
| branch、session 或运行实例变化 | 先使旧调用失效并取消；晚到结果不能进入 Pi |
| shutdown 或 reload | 先停止接收结果，再发出取消；Pi 不等待无期限外部工作 |

对模型和用户显示的失败信息不包含异常堆栈、内部存储位置、凭证解析细节或下游原始响应。

Pi Boundary 不修改 Pi 的 session、branch、compaction 或工具调度策略。记忆能力没有准备好时，Pi 保持没有该项增强时的原生行为。

## Observation 事件

Pi Boundary 通过 [Observation](./observation.md) 的公共接口，把每项完成的操作发送成一条脱敏事件。事件恰好包含运行实例、范围快照引用、操作、耗时和结果分类。

发送前，Pi Boundary 把当前 `MemoryScope` 转换成 [Observation 事件契约](./observation.md#事件内容)定义的范围快照引用。这个引用保留完整快照的身份，只向 Observation 提供用于比较的内部代号。

Pi Boundary 知道操作怎样结束，也知道结果在交付时是否仍然有效，因此按下表选择分类：

| 操作 | 结果分类 |
| --- | --- |
| 线索准备 | 正常完成为成功；抛错、期限、取消、新任务替代和交付前失效分别为失败、超时、取消、被替代和失效 |
| 线索展示 | 合法 CueSet 已注入为成功；没有线索为空结果；结构不合法、超预算或读取与格式化抛错分别为无效结果、超过预算和失败 |
| 完整事实找回 | 完整 `found` 已转换为成功；`notFound`、`rejected` 和 `unavailable` 分别为未找到、拒绝和不可用；返回值不合法、超预算或调用抛错分别为无效结果、超过预算和失败；期限、取消和交付前失效使用对应分类 |
| Pi compaction 失败 | `session_compact_failed` 为失败 |

事件结构、分类表示、保存方式和写入失败后的状态由 Observation 负责。Observation 调用失败不改变已经确定的记忆结果，也不阻塞 Pi 流程。

## 职责与依赖边界

### Pi Boundary 负责

- 解释 Pi 当前 session tree 和生命周期；
- 建立 `MemoryScope` 和 `ScopedFacts`；
- 维护运行实例、范围代次、后台任务、期限、取消和晚到结果检查；
- 调度 Cue Provider 并把当前 CueSet 安全加入普通模型请求；
- 注册并执行 `recall_memory`；
- 把 Retriever 业务结果完整转换成 Pi 工具结果；
- 发出不含正文和 handle 的 Observation 事件；
- 使任何记忆失败都不改变 Pi 原生流程。

### Pi Boundary 不负责

- 生成、排序、保存、同步或缓存线索；
- 解释、生成或改写 `RecallHandle`；
- 保存、索引、搜索或裁剪完整事实；
- 生成 Pi 的 compaction 或 branch summary；
- 决定 Pi 何时切换 session、branch、模型或工具；
- 创建第二套 session tree、branch ID 或 session 持久化格式；
- 创建外部服务客户端、读取外部凭证或决定实现组合。

Cue Provider 负责线索内容和准备状态；Retriever 负责 handle 解释和完整事实；Pi 负责 session tree、当前上下文和工具宿主；Observation 只接收脱敏事件；Assembly 创建并检查兼容实现。

依赖方向由[系统设计](../design.md)规定。Pi Boundary 运行时直接使用 Pi SDK、公共业务数据、Cue Provider、Retriever 和 Observation；源码位置与导入规则由 [Project Structure](./project-structure.md) 规定。Pi SDK 对象不能进入模块间公共业务数据。

## 状态所有权

Pi Boundary 在一个扩展运行实例内拥有：

- 当前范围标识和当前 session ID；
- 当前后台准备任务及其取消控制器；
- 当前工具调用的快照和取消控制器；
- 实例是否仍接收结果；
- 期限计时。

Pi Boundary 不把这些运行状态作为事实存入 session tree。需要跨 reload 恢复的线索、事实和进度由对应模块保存；新实例根据 Pi 当前状态重新建立范围并准备结果。

## 验证要求

### 模块行为检查

使用受控 Cue Provider、Retriever、Observation 和时间能力，至少证明：

- MemoryScope 只能由 Pi Boundary 建立，工具参数不能改变 session、可见 entry 或预算；
- 顺序读取只按当前路径顺序交付可见 entry 集合内的来源事实，结果不含 Pi SDK 类型；
- 按标识读取对不可见 entry、摘要 entry、扩展写入的 entry 和不存在的标识都返回未找到；
- `MemoryScope` 转换结果符合 [Observation 的范围快照引用契约](./observation.md#事件内容)，事件不暴露原始 ID；
- 线索准备、线索展示、完整事实找回和 Pi compaction 失败按本文规定产生 Observation 操作与结果分类；
- 同一 branch 追加 entry 后，旧叶节点仍为祖先，有效准备结果可以交付；
- 成功 branch 导航后范围标识改变，旧任务被取消，晚到结果被拒绝；
- 切走再切回相同路径时，切换前任务仍被拒绝；
- 无 summary 的 branch 导航不授权被放弃路径；
- branch summary entry 可以作为当前路径内容，其 `fromId` 指向的旧路径 entry 仍不属于当前范围；
- compaction 不删除当前完整祖先路径中的事实权限；
- context 只读取当前 CueSet，不等待准备，不把临时线索写入 session；
- CueSet 为空、失败、失效或超预算时，原始上下文逐项保持不变；
- 每种 RecallResult 都转换成规定的完整工具结果；
- 任何无法完整交付的 RetrievedContent 都不会以截断后的 `found` 返回；
- prepare、current、recall、格式化和 Observation 各自失败时，其他链路继续；
- shutdown 先使实例失效，再取消任务，并拒绝取消后的完成值。

### 跨模块检查

至少证明：

- Cue Provider 为当前 MemoryScope 生成的每个 handle 都能由装配中的 Retriever 解释；
- handle 指向当前 `session ID + entry ID` 时可以找回，来自其他 session 或不可见 entry 时不能找回；
- Cue Provider 的晚到准备结果不会通过 `current(newScope)` 出现在新范围；
- 预算从 Pi Boundary 传入后，CueSet 和 RetrievedContent 都不能绕过限制。

### 真实 Pi 检查

真实 Pi 检查使用本地、确定性 provider，不访问外部模型，至少确认：

- `context` 注入对 provider 可见、不会写入 session，并覆盖工具完成后的后续普通模型请求；
- compaction 摘要请求不接收普通 Memory Cues 注入；
- `getBranch()` 在同一 branch 追加、compaction、导航和 reopen 后具有本文规定的祖先语义；
- Pi 实际产生的 compaction entry 和 branch summary entry，以及扩展写入的 custom entry，都不作为来源事实通过 `ScopedFacts` 交付；
- branch summary entry 进入新路径，而 `fromId` 指向的旧路径 entry 不会因此进入当前祖先路径；
- fork 产生新 session ID，即使复制了原 entry ID 也不能沿用旧 session handle；
- 工具 `execute` 收到 Pi 当前调用的取消信号；
- reload、session 替换和正常退出的 shutdown/start 顺序能触发本文规定的失效与重建；
- 记忆模块抛错、超时或取消后，Pi 的模型请求、compaction、branch 导航、session 切换和关闭仍可完成。

检查按 [Verification](./verification.md) 规定的层次、命令、结果状态和完成条件执行。真实 Pi 行为只能由 `test/pi/` 的实际运行结果证明，不能由模块替身推断。
