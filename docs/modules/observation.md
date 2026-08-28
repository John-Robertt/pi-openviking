# Observation（运行观测）模块架构

## 文档职责

本文是 Observation 模块设计的唯一来源。它规定 Observation 接收什么事件、保存什么脱敏记录、写入失败怎样与业务隔离，以及这些结果怎样验证。

系统交付的产品结果、模块划分和依赖方向由[系统设计](../design.md)规定。本文负责事件契约、记录状态和存储边界；Pi 当前状态、记忆范围、线索、完整事实和运行装配分别由 Pi Boundary、Cue Provider、Retriever 和 Assembly 负责。

事件含义、调用方依赖的记录结果或失败隔离边界改变时更新本文。记录编码、文件拆分和资源控制方式由实现维护。

## 架构定位与核心目标

Observation 把运行结果写成脱敏记录。“脱敏”表示记录去掉用户正文、图片、凭证和找回凭据，只留下定位一次操作所需的固定字段。

Pi Boundary 调用 Observation；维护者和验证代码读取本地记录。每条记录直接回答：哪次运行、哪个记忆范围、哪项操作、耗时多久、得到什么结果。

> 记录能力独立于记忆能力。记录可以停止，线索准备、事实找回和 Pi 原生流程继续运行。

公共入口只写入记录。模型和运行模块没有读取这些记录的入口，记录也不参与 `MemoryScope`、CueSet 或 RecallResult 的业务判断。

## 交付结果

| 结果 | 使用者得到什么 |
| --- | --- |
| 脱敏事件 | 一次受观测操作对应一条只含允许字段的结构化记录 |
| 范围关联 | 不可逆的范围快照引用准确区分本次操作使用的 `MemoryScope` |
| 失败隔离 | 首次写入失败会关闭本次运行的记录通道，调用方业务结果保持不变 |

调用方提交事件后立即继续工作。记录是否最终写入存储，不参与任何业务结果或完成判断。

## 事件与公共入口

```text
record({ runId, scopeRef, operation, duration, result }) → void
```

`record` 校验并接收事件后立即把控制权还给 Pi Boundary。存储工作在调用返回后继续；输入和写入异常留在 Observation 内。实现限制一次调用和待处理记录占用的资源，具体方式由实现维护。

### 事件内容

每条记录恰好包含以下五类值：

| 值 | 含义 | 来源与限制 |
| --- | --- | --- |
| 运行实例 | 区分 session 替换、扩展 reload 前后的运行 | Pi Boundary 创建、与用户内容无关的内部代号 |
| 记忆范围 | 标识本次操作实际使用的完整 `MemoryScope` 快照 | Pi Boundary 创建的 `scopeRef` |
| 操作 | 本次记录描述哪类动作 | Observation 定义的固定分类 |
| 耗时 | 操作从开始到得到最终分类的时长 | 调用方用单调时钟（只向前累计、不受系统时间调整影响）测得的非负有限毫秒数 |
| 结果分类 | 操作最终得到的正常、失败、取消或失效结果 | Observation 定义分类，Pi Boundary 选择具体值 |

`scopeRef` 由范围标识、session ID 和当前可见 entry ID 集合共同确定。三项值完全相同的快照使用相同引用；任一项变化，引用随之变化。例如，同一 branch 追加一条 entry 后，范围标识保持不变，可见 entry 集合发生变化，因此 `scopeRef` 也发生变化。

`scopeRef` 只用于比较两个快照是否相同。原始 session ID 和 entry ID 保留在 Pi Boundary，不进入引用，也不能从引用中还原。

Observation 按五项允许字段重新构造记录。用户正文、图片、外部服务凭证、`RecallHandle`、原始异常和附加字段禁止进入记录。

### 操作分类

| 操作 | 含义 |
| --- | --- |
| 线索准备 | 一次 `CueProvider.prepare` 调用 |
| 线索展示 | 一次普通 `context` 中的线索读取与消息构造 |
| 完整事实找回 | 一次 `recall_memory` 工具执行 |
| Pi compaction 失败 | Pi 报告的一次 compaction 失败 |

### 结果分类

| 分类 | 含义 |
| --- | --- |
| 成功 | 操作产生合法且可以交付的结果 |
| 空结果 | 当前范围没有可展示线索，原上下文保持不变 |
| 未找到 | 当前范围没有 handle 对应的完整事实 |
| 拒绝 | handle 或调用参数不合法 |
| 不可用 | 本次无法完整返回事实，调用可以继续 |
| 无效结果 | 下游返回值不符合公共结果契约 |
| 超过预算 | 结果不能在调用预算内完整交付 |
| 失败 | 操作产生未归入其他分类的失败 |
| 超时 | 操作期限到达 |
| 取消 | Pi、shutdown、reload 或当前调用明确取消操作 |
| 被替代 | 同一范围的新线索准备取代旧准备 |
| 失效 | 运行实例或记忆范围已经改变，完成值不能交付 |

Observation 负责分类名称和含义。Pi Boundary 拥有操作状态和调用有效性，因此负责把每次具体结果转换成这些分类。事件契约只使用 Observation 分类，Cue Provider 和 Retriever 各自维护内部结果类型。

## 写入结果

Observation 按以下顺序处理事件：

```text
校验 runId
  → 校验 scopeRef、operation、duration 和 result
  → 按允许字段构造记录
  → 提交存储
```

无法识别所属运行的事件直接结束，不产生记录。对合法 `runId`，其他字段无效、事件带有附加字段或记录无法完整写入时，对应运行进入“停止写入”状态。

“停止写入”状态把同一 `runId` 的后续事件变成无操作：调用立即返回，不再访问存储。每个运行实例拥有独立状态，因此其他运行仍可写入。Observation 不重试，也不记录自身失败。

写入状态只影响脱敏记录。CueSet、RecallResult、Pi 工具结果、期限、取消和关闭流程继续由原负责模块决定。

## 保存位置

本地记录保存在仓库内被忽略的 `.dev/observation/`，属于可删除运行产物。文件路径来自仓库位置和模块配置；用户正文、session ID、entry ID、handle 和外部响应禁止进入路径。记录编码和文件命名由实现维护。

Assembly 创建 Observation、提供仓库相对输出配置，并把事件出口交给 Pi Boundary。Observation 接管输出打开、写入和运行记录状态；Pi Boundary 始终面对同一个 `record` 契约。

## 职责分工与依赖

| 结果或状态 | 所有者 |
| --- | --- |
| 事件字段、分类含义、脱敏记录和每个运行的写入状态 | Observation |
| 运行实例、`MemoryScope`、范围快照引用、操作耗时和具体结果分类 | Pi Boundary |
| 线索内容和准备状态 | Cue Provider |
| handle 解释和完整事实 | Retriever |
| 实现创建、配置和组合 | Assembly |

Observation 的生产依赖只有仓库相对输出配置。Assembly 使用创建入口，Pi Boundary 使用事件入口；Cue Provider 和 Retriever 保持独立。Observation 事件属于本模块公共入口，不进入 `src/contracts/` 的业务数据契约。

记录状态保留在当前扩展进程内，不写入 Pi session。reload 后的新实例根据新事件建立自己的记录状态。

## 验证要求

### 模块行为检查

在 `test/modules/observation/` 通过公共入口和受控输出证明：

- 每条合法记录恰好包含运行实例、范围快照引用、操作、耗时和结果分类；
- 字段白名单排除用户正文、图片、凭证、handle、异常和附加字段；
- 无效事件和不完整写入不会产生可用记录；
- `record` 立即返回，输入和写入异常停留在 Observation 内；
- 首次写入失败关闭同一运行的后续写入，其他运行保持可写；
- 保存位置位于 `.dev/`，路径使用仓库相对配置且不含敏感值。

### 跨模块检查

[Pi Boundary](./pi-boundary.md) 的模块行为检查证明范围快照引用和结果分类映射符合双方契约。跨模块集成证明 Observation 拒绝事件或写入失败时，已经确定的 CueSet、RecallResult 和 Pi 工具结果保持不变。

Observation 的输入限制和首次失败状态由模块行为检查证明。真实 Pi 检查确认 Observation 失败后，Pi 的模型请求、compaction、branch 导航、session 切换、reload 和关闭仍按 [Pi Boundary](./pi-boundary.md) 的要求完成。

全部检查按 [Verification](./verification.md) 规定的层次、命令、结果状态和完成条件执行。
