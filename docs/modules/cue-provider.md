# Cue Provider 模块架构

## 文档职责

本文是 Cue Provider 模块设计的唯一来源。它规定线索怎样为当前记忆范围准备、怎样在预算内同步返回、每条线索携带什么凭据，以及准备失败后哪些结果继续有效。

系统交付的产品结果、模块划分和公共业务数据由[系统设计](../design.md)规定。本文负责线索内容和准备状态。

模块交付结果、调用方依赖的行为或失败边界改变时更新本文。线索来源、生成算法、保存形式、缓存和进度表示由实现维护。

## 架构定位与核心目标

Cue Provider 是当前记忆范围内历史线索的提供者。

> 让 Pi 构造模型上下文时直接读取已经可用且符合预算的历史线索，不等待生成过程。

线索准备可能耗时，模型上下文构造必须立即返回。Cue Provider 用两个入口分开这两件事：`prepare` 承担耗时工作，`current` 只交付已有结果。

## 交付结果

| 结果 | 使用者得到什么 |
| --- | --- |
| 当前范围的线索 | Pi Boundary 得到属于当前 `MemoryScope`、可以直接展示的 `CueSet` |
| 同步读取 | 调用方立即得到结果或空，不受进行中的准备影响 |
| 可解释的凭据 | 每条线索携带同一装配中 Retriever 能够解释的 `RecallHandle` |
| 预算内交付 | `CueSet` 的线索数量和字符数落在调用预算内，并说明它是完整清单还是采样 |
| 失败保留 | 准备失败、超时或取消后，仍然有效的线索继续可用 |

## 输入、输出与公共入口

### 输入

第一类由 Pi Boundary 在每次调用时传入：

- 当前 `MemoryScope`；
- `ScopedFacts`，当前范围内来源事实的只读入口，按[系统设计](../design.md#scopedfacts)是可选输入；
- 线索数量与线索字符预算；
- 取消信号（`prepare`）。

第二类由 Assembly 在创建时注入：

- 生成线索所需的外部依赖和配置。

### 输出

```text
prepare(scope, facts, budget, signal) → Promise<void>
current(scope, budget)                → CueSet | empty
```

`prepare` 完成后，当前范围的线索可以被 `current` 读取。`current` 返回 `CueSet` 或空，不抛出异常。

## 线索与 CueSet

### 一条线索

线索的字段由[系统设计的 CueSet 契约](../design.md#cueset)规定。Cue Provider 决定这些字段的内容。

线索按事件划分，一条线索可以覆盖一条或多条来源事实。线索内容只用于让模型认出“以前发生过这件事”。

### RecallHandle

`RecallHandle` 让 Retriever 在当前 `MemoryScope` 内定位该线索对应的完整事实。它至少携带：

- 事实所属的 session ID；
- 该事件对应的来源事实标识。

session ID 是必需的：仅凭事实标识无法区分 session，原因见 [Pi Boundary 的记忆范围规定](./pi-boundary.md#memoryscope)。

编码形式由 Cue Provider 和 Retriever 在同一装配中约定，其他模块只保存和传递凭据。`RecallHandle` 不携带用户正文、图片内容或外部服务凭证。

### 完整性说明

每份 `CueSet` 携带一项说明，告诉模型这组线索是完整清单还是预算内采样，标记规则见[预算内选择](#预算内选择)。

模型据此判断“没有相关线索”是确实没发生过，还是本次没有展示。

## 准备线索

### 运行方式

`prepare` 可以耗时并全程接受取消信号，调用时机由 [Pi Boundary](./pi-boundary.md#生命周期挂载) 决定。它为传入的 `MemoryScope` 准备线索，完成后结果对 `current` 可用；收到取消信号后尽快结束。

### 范围隔离

每份 `CueSet` 属于建立它的 `MemoryScope`。`current(scope)` 只返回属于该 scope 的结果。

范围标识不变时（包括可见 entry 继续增长）已有结果继续可用，标识更换后新范围在自身准备完成前没有可用结果。范围标识何时保持、何时更换由 [Pi Boundary](./pi-boundary.md#memoryscope) 规定。

同一范围只保留最新一次准备的结果。被替代的准备任务完成得再晚，它的结果也不进入任何范围。

### 覆盖保证

`prepare` 失败、超时或取消时，准备进度不向前推进。下一次准备仍会处理本次未能完成的来源事实，因此中断不会造成事实被永久遗漏。进度用什么形式表示，由实现维护。

## 返回线索

### 同步保证

`current` 只从模块内已有结果构造 `CueSet`。它不读取 `ScopedFacts`，不访问外部服务，不等待进行中的 `prepare`，因此 Pi 构造模型上下文的路径不会被线索生成阻塞。

当前范围没有可用线索时，`current` 返回空。

### 预算内选择

调用方给出线索数量和字符预算。`current` 按以下规则构造结果：

1. 已有线索全部放得下时，返回全部线索，标记为完整清单；
2. 放不下时，返回预算内的一部分线索，标记为预算内采样；
3. 任何一条线索无法在预算内完整编码时，该线索不进入本次结果。

预算不足时保留哪些线索，由实现维护。

## 失败与边界行为

| 情况 | 必须产生的结果 |
| --- | --- |
| `prepare` 抛错、到达期限、`ScopedFacts` 读取失败或外部依赖不可用 | 本次准备结束为失败，已有 `CueSet` 保持不变 |
| `prepare` 被取消或被同范围的新任务替代 | 不产生部分结果，已有 `CueSet` 保持不变 |
| 当前范围没有线索、预算容不下任何一条线索，或已有结果无法构造合法 `CueSet` | `current` 返回空 |

`prepare` 通过 Promise 报告失败，由 Pi Boundary 决定结果分类和记录。`current` 用空结果表示没有可交付内容，因此上下文构造路径不需要处理异常。

## 职责与依赖边界

### Cue Provider 负责

- 为当前 `MemoryScope` 准备线索；
- 让每条线索保持简短并携带可解释的 `RecallHandle`；
- 按调用预算返回 `CueSet` 并说明它的完整性；
- 在准备失败、超时或取消后保留仍然有效的线索；
- 在模块内部管理线索来源、生成、保存、缓存和准备进度。

### Cue Provider 不负责

- 决定何时准备线索、何时展示线索；
- 建立、改变或扩大 `MemoryScope`；
- 把线索写入 Pi 上下文或 session；
- 解释 `RecallHandle` 或交付完整事实；
- 发出 Observation 事件。

Pi Boundary 负责调用时机、范围建立和结果呈现；Retriever 负责凭据解释和完整事实；Observation 只接收 Pi Boundary 的脱敏事件；Assembly 创建实现并确认凭据兼容。

依赖方向由[系统设计](../design.md)规定。Cue Provider 只使用 Pi Boundary 每次调用传入的值和 Assembly 注入的实现依赖；它不导入 Pi SDK，也不调用 Pi Boundary、Retriever 或 Observation。源码位置与导入规则由 [Project Structure](./project-structure.md) 规定。

## 状态所有权

Cue Provider 在一个扩展运行实例内拥有：

- 每个范围当前可用的 `CueSet`；
- 每个范围的准备进度；
- 进行中的准备任务及其取消处理。

这些状态不写入 Pi session。跨运行实例保存和复用线索属于实现选择；无论是否复用，`current` 只在当前范围已有结果时返回内容。

## 验证要求

### 模块行为检查

通过公共入口和受控 `ScopedFacts`、外部依赖与时间能力，至少证明：

- `prepare` 完成后，`current` 返回属于同一范围的 `CueSet`；
- `prepare` 进行中调用 `current` 立即返回已有结果或空，不等待准备完成；
- 范围标识更换后，`current` 不返回旧范围的 `CueSet`；
- 同一范围可见 entry 增长后，已有 `CueSet` 仍可返回；
- 被替代的准备任务完成后，它的结果不进入任何范围；
- 预算足够时结果标记为完整清单，预算不足时返回预算内的线索并标记为采样；
- 返回结果的线索数量和字符数落在传入预算内，线索内容不被截断后交付；
- 每条线索都携带 `RecallHandle`，且 handle 不含用户正文、图片内容或凭证；
- `prepare` 抛错、超时、取消或被替代后，已有 `CueSet` 逐项保持不变；
- 上一次准备失败后，下一次准备仍会处理失败期间的来源事实；
- `current` 不读取 `ScopedFacts`，不访问外部服务，且在任何已有状态下都不抛出异常。

跨模块检查由 [Pi Boundary 的跨模块检查](./pi-boundary.md#跨模块检查)负责，其中包含凭据兼容性、范围外 handle 的拒绝和预算约束。

全部检查按 [Verification](./verification.md) 规定的层次、命令、结果状态和完成条件执行。
