# Pi 长期记忆扩展架构总纲

## 文档职责

**架构定位**：项目目标架构与稳定边界的总纲。

**核心目标**：维护者能够确认系统的唯一目标、外部责任边界、模块职责与依赖方向，并知道每类变化应该修改哪个
模块。文档入口见 [`docs/documentation.md`](./documentation.md)。

**职责边界**：本文维护战略目标、外部责任边界、目标架构、模块职责与数据契约、支撑能力、状态所有权、核心业务
链路、依赖方向、全局系统保证与演进规则。模块内部的算法与预算由各模块实现表达。CueSet 作为模块间交接值，形状
以「模块协作契约」为准。如何证明这些保证，由 [`docs/verification.md`](./verification.md) 维护。

## 系统战略目标

本扩展依附于 Pi。系统唯一目标是：

> **让任务模型在 Pi 长期会话经过 compaction 或切换 branch 后，仍能看到一小份“以前发生过什么”的线索；需要具体内容时，再按线索里的引用从 Pi session tree 找回完整事实。**

compaction 指 Pi 把旧对话移出模型上下文、换成一份摘要，腾出位置；按本文依赖，原文仍留在 session tree 里。
branch 指同一棵 session tree 上的一条祖先链；切换 branch 就是把当前工作位置换到另一条链。

模型能看到三层信息：

```text
Pi 自己的 summary：我现在在做什么（Pi 的压缩摘要，不是本扩展生成的线索）
Memory Cues：历史上发生过哪些事件、从哪条 entry 继续找
Pi session tree：这些事件的完整事实是什么
```

Pi 管理会话、模型上下文和全部已接受事实。扩展不另存一份历史：它只把滚出上下文的事实压成有界线索，并让模型
按 entry ID 读回同一棵 tree 里的原文。线索写在 Pi 的 custom entry 里——custom entry 是扩展写入、不进入对话
正文的条目，不是第二份事实库。

本目标覆盖一次 Pi 长期会话内的 compaction 与 branch 切换。跨 session、跨 workspace 的记忆，以及按语义探索
没有线索覆盖的历史，都不在当前目标内。

## 外部责任边界

### Pi

Pi 拥有：

- SessionEntry、session tree、branch 和 leaf（一条祖先链上最新的那条 entry）；
- 全部已接受 entries 的持久化，包括已被 compaction 滚出模型上下文的条目；
- entry 到模型消息的映射；
- system、tools 和 provider payload；
- 模型能力、上下文计量和 cache usage；
- compaction 触发、边界、summary 和 CompactionEntry；
- tool result 持久化及文本、图片的 provider 映射。

本架构依赖这些公开语义：

- session 只追加，不删除已接受的 entries；
- compaction 只改变模型上下文，不从 tree 移除原始 entries；
- 对同一棵 tree 有三种看法：上下文视图（模型当前能看到的条目）；全量 tree（含被滚出上下文的原文，也含被放弃
  支路上的条目）；当前路径（当前 leaf 到根的祖先链，不含被放弃的支路）；
- 普通模型请求使用上下文视图；compaction 用来写摘要的请求不注入 CueSet。

扩展只使用 Pi 公开接口：读取已接受的原始 entries，在 compaction 前后接收通知，用 custom entry 保存线索，
通过 context 与工具把线索和按 ID 读取提供给模型。Pi 捕获这些入口的异常，走原生扩展错误路径报告；本扩展不替换
这条路径。

## 最小目标架构

```text
Pi 已接受的 entries + compaction 前后通知
        → Pi Adapter → Cue Provider → CueSet → Pi Adapter
                                                ├─ 保存为 custom entry
                                                └─ 普通模型请求里临时注入线索

任务模型拿线索里的引用
        → Pi Adapter → 当前 session 全量 tree 按 ID 读取 → 来源事实
```

核心运行架构由两个模块组成：

1. Pi Adapter：唯一与 Pi 对话的运行模块；
2. Cue Provider：唯一的线索生成模块，不接触 Pi。

Composition Root 在启动时使用 Configuration 读成的值装配模块，Observation 写入运行事件。模块之间交接的扩展
自有数据值只有 `CueSet`；来源事实使用 Pi 已接受的原始条目，不另建一层事实模型。

## 模块协作契约

| 数据 | 由谁产生 | 谁使用 | 包含什么 |
| --- | --- | --- | --- |
| `CueSet` | Cue Provider | Pi Adapter 与下一次生成 | 有界线索，以及本次已经用到的最后一条来源事实 |

每条线索写出三件事：事件时间或区间、用于识别事件的短句、以后按 ID 读回完整事实所需的引用。投影时，Pi Adapter
根据「最后用到的那条来源事实」补上覆盖到哪个时间为止，并说明这是采样而不是完整清单。

## 路径、来源事实与有效性

这些是判定标准，按动作归属使用。Pi Adapter 在收集输入、保存、投影、按 ID 读取时使用本节全部条款。Cue Provider
只使用「来源事实」和「上一份 CueSet」作为生成输入的含义；不执行、不解释有效 CueSet、保存条件和读取范围。

**当前路径**：从当前 leaf 到根的祖先链。

**来源事实**：Pi 已接受的原始会话条目，即对话与工具结果。不包括扩展自己的 CueSet custom entry，也不包括 Pi 的
CompactionEntry。

**上一份 CueSet**（生成用）：当前路径上最后一份 CueSet custom entry。没有则为首次生成，输入是本次 session
开始以来的全部来源事实；有则输入是该份已经用到的最后一条来源事实之后的来源事实。

**有效 CueSet**（投影用）：当前上下文视图里的最后一份 CueSet。不在该视图里的旧 CueSet 不注入模型。

**保存条件**：在本次压缩提交结果时必须同时满足：本次扩展运行尚未结束；该结果对应的那次 compaction 仍是当前
leaf。满足则把 CueSet custom entry 追加为当时 leaf 的后继，因此每次 compaction 最多挂一份 CueSet。不满足则
不写入，并由 Pi Adapter 发出停止本次生成的信号。来源事实是否仍出现在祖先链上，不影响能否保存。

**读取范围**：按 ID 读取在当前 session 的全量 tree 上进行，可以读到已被滚出上下文的来源事实，也可以读到被放弃
支路上的来源事实。不能读其他 session。ID 指向非来源事实时视为未找到。

## 核心运行模块

### 1. Pi Adapter

**架构定位**

唯一与 Pi 对话的运行模块。它连接 Pi 生命周期、来源事实、compaction、context 和模型工具。它不是宿主加载扩展时
的装配入口。

**核心目标**

> 把 Pi 的生命周期、来源事实和模型上下文接到扩展上：该收集输入就收集，该保存就写入 CueSet，该投影就临时注入，该读取就按 ID 返回来源事实。不把来源事实写成线索。

**业务需求**

- 支持持久 session 和 in-memory session；
- 用 Pi 公开给出的三种看法工作，不另建一份 tree 模型；来源事实与 CueSet、CompactionEntry 的区分按
  「路径、来源事实与有效性」执行；
- 压缩开始时按「上一份 CueSet」收集来源事实，交给 Cue Provider 启动生成，立即返回，不等待生成结束；
- 压缩提交结果时取已经生成的结果；尚未完成则发出停止信号。按保存条件写入；不满足则不写入。没有本次提交则
  不保存；
- 只在普通模型请求中，把上下文视图里的有效 CueSet 临时注入，并补上覆盖时间与采样说明；
- 向任务模型提供按 entry ID 读取来源事实的工具，按「读取范围」解析，把来源事实映射为 Pi 支持的工具结果；
- session 重开、tree 导航和扩展重载后，原样使用 Pi 当前给出的 session 与 context；
- 接到 Pi 的入口只做有界本地工作，不等待后台任务完成；异常沿 Pi 原生扩展错误路径报告，未产生有效结果时保持
  Pi 原始输入不变；
- 写入 CueSet 前确认本次运行仍在工作（由 Composition Root 持有）；不在工作则不提交。

**职责边界**

- SessionEntry、session tree、branch、leaf、compaction 和模型上下文的解释与重建归 Pi。本模块使用 Pi 公开给出
  的三种看法，保持 Pi 对会话、tree 和模型上下文的完整所有权；
- 不把来源事实写成线索；如何生成 CueSet 由 Cue Provider 决定；
- CueSet 向模型的呈现由本模块决定；
- 工具能力限于当前目标所需的按 ID 读取；
- 只在接到 Pi 的入口里发出「可以停了」，不负责生成任务内部如何收尾；
- 不是宿主加载时的装配入口。

### 2. Cue Provider

**架构定位**

唯一的线索生成模块。它在 Pi Adapter 内侧工作，不接触 Pi。

**核心目标**

> 用已经拿到的“上一份 CueSet + 其后的来源事实”生成下一份有界 CueSet。

**业务需求**

- 输入由 Pi Adapter 提供：上一份 CueSet（可无）和一批来源事实，含义以「路径、来源事实与有效性」为准；
- 每条线索写出事件时间或区间、识别短句、以及按 ID 读回所需的引用；并记下本次已经用到的最后一条来源事实；
- 线索有界；选择哪些来源事实写成线索，由本模块内部决定；
- 生成可被停止；完成则交出 CueSet，失败或被停止则交出「没有新 CueSet」。不自己写入 Pi。

**职责边界**

- 只负责从来源事实里挑选条目、把正文写成短句、产出 CueSet 或明确没有结果；
- 不接收 Pi 的入口，不判断保存条件，不写入 custom entry，不向模型投影，不按 ID 读取；
- 不决定何时该停；停止信号来自 Pi Adapter 或 Composition Root；
- CueSet custom entry 是扩展状态，不作为来源事实再次生成线索。

## 支撑能力

### Configuration

**架构定位**

装配阶段使用的配置解析能力。

**核心目标**

> 把配置读成可注入的值。

**业务需求**

- 把配置读成可注入的值。

**职责边界**

- 不负责注入，不负责决定谁在运行期使用这些值；
- 不负责 cue 预算的含义，不负责 Pi 的模型与 compaction 配置，不负责运行期改配置。

### Observation

**架构定位**

单向接收运行事件的记录能力。

**核心目标**

> 留下可按 session 和操作关联、且不含用户正文和图片的运行证据。

**业务需求**

- 为事件添加关联、去掉敏感内容、写入记录目标；
- 不能挡住产品路径，不能抛异常；
- 写入失败或得不到合法记录时，当前运行实例的观察降级，之后不再写入。

**职责边界**

- 不负责决定何时发出什么业务事件（事件由 Pi Adapter、Cue Provider 或 Composition Root 在自己的流程里发出）；
- 不负责解释 CueSet 或来源事实，不负责判定业务成功或失败。

### Composition Root

**架构定位**

宿主加载扩展时的装配入口：使用 Configuration 读成的值创建依赖、把入口交给 Pi。

**核心目标**

> 装配全部成功后一次性进入工作；任一步骤失败则已交给 Pi 的入口保持不工作，Pi 仍可启动。

**业务需求**

- 宿主加载时同步完成装配；
- 装配完成前，已交给 Pi 的入口收到事件后直接返回，不执行扩展工作；
- 全部步骤成功后一次性开始工作；失败时保持不工作，不中断 Pi 启动；
- 持有本次运行是否在工作，以及向整实例发出的停止。

**职责边界**

- 不负责生成 CueSet、投影、按 ID 读取或解释来源事实；
- 不解释某一次 compaction 的提交，不负责生成任务内部如何收尾；
- 运行结束时只向整实例发出停止，不等待后台任务完成。

## 状态所有权

| 状态 | 所有者 | 生命周期 |
| --- | --- | --- |
| 本次运行是否在工作，以及整实例停止 | Composition Root | 当前扩展运行实例 |
| SessionEntry、tree、branch、leaf、summary、完整事实 | Pi | Pi session |
| 运行中的生成任务（可停止、产出 CueSet 或没有结果） | Cue Provider | 当前扩展运行实例 |
| 已生成的 CueSet custom entry | Pi（内容由 Cue Provider 产生） | 对应 compaction 所在 tree 路径 |
| 运行证据 | Observation 的记录目标 | 诊断与验证保留周期 |

何时发出「可以停了」由 Pi Adapter（接到 Pi 的入口）或 Composition Root（整实例结束）决定，不是一份独立状态。

## 核心业务链路

### Compaction 时更新线索

模块之间只交接两个结果：Pi Adapter 交出输入，Cue Provider 交出 CueSet 或没有结果，Pi Adapter 再按保存条件
写入并按投影规则注入。

例如，上一份 CueSet 已经用到来源事实 `e4`：

1. 压缩开始：Pi Adapter 收集 `e4` 之后的来源事实，交给 Cue Provider 后立即返回；
2. Cue Provider 用这些来源事实生成线索，与 Pi 压缩并行；
3. 压缩提交结果：若已有结果且保存条件成立，Pi Adapter 把新 CueSet 追加为当前 leaf 的后继；否则发出停止信号，
   继续使用停在 `e4` 的旧 CueSet。下一次生成仍从 `e4` 之后开始，因此不会漏掉事实。

```text
Pi Adapter：上一份 CueSet + 其后的来源事实
  → Cue Provider：新的 CueSet 或没有结果
  → Pi Adapter：按保存条件写入，并按投影规则加入普通模型请求
```

### 历史细节恢复

```text
任务模型认出一条线索
  → 按 entry ID 读取来源事实的工具
  → Pi Adapter 在当前 session 全量 tree 上按 ID 读取
  → 来源事实 → Pi 工具结果
  → 非来源事实或未找到 → 有界失败的工具结果
  → Pi 原生上下文
```

### 降级

```text
装配失败                 → 入口不工作
接到 Pi 的入口失败       → Pi 原生扩展错误路径
线索生成失败             → 没有新 CueSet；保留上一份
按 ID 读取未找到或失败   → 有界失败的工具结果
观察写入失败             → 本实例观察降级
所有路径                 → Pi 原生上下文、compaction、主任务和关闭继续
```

## 依赖规则

1. Pi Adapter 是所有 Pi 生命周期、来源事实、compaction、context 和工具接入的唯一边界；
2. Cue Provider 只使用 Pi Adapter 提供的上一份 CueSet 和其后的来源事实，不接触 Pi；
3. 按 ID 读取在当前 session 的全量 tree 上进行，不按祖先链过滤，也不返回非来源事实；
4. Observation 单向接收事件；
5. 运行期产品数据只交接「模块协作契约」表中的 CueSet 以及来源事实。停止信号、观察事件、装配时的配置值按各模块
   边界传递，不写入协作契约表。每个模块只为自己“职责边界”中的工作修改代码。

模块划分决定代码归属。源码目录如何对应模块，见 [`docs/source.md`](./source.md)。对不进现有模块的新文件，按「新模块准入」上报。

## 演进与扩展边界

### 可演进方向

| 变化 | 责任位置 |
| --- | --- |
| Pi 生命周期、读取与写入 session 的接口变化 | Pi Adapter |
| 保存条件与 CueSet custom entry 挂接 | Pi Adapter |
| CueSet 向模型的呈现方式 | Pi Adapter |
| 按 ID 读取的工具映射变化 | Pi Adapter |
| 挑选哪些来源事实、正文写成短句 | Cue Provider |
| CueSet 作为交接值的形状 | 「模块协作契约」，由 Cue Provider 的需求驱动 |
| 配置如何读入 | Configuration |
| 运行证据写到哪里 | Observation |
| 装配与是否开始工作 | Composition Root |

如果变化不改变模块在本文中的目标，只修改该模块内部的函数和局部数据结构。

### 稳定战略边界

本项目只负责在一次 Pi 长期会话内，用 Memory Cues 提示“以前发生过什么”，并按 entry ID 从同一棵 session tree
读回完整事实。替换 Pi、引入第二个事实库、由扩展接管 Pi compaction，或在扩展内建立检索系统，都会改变产品目标；
开始这类工作前必须由用户重新决定系统边界。

若 Pi 不再通过公开接口保留被压缩的 entries，本架构的前提不再成立，同样需要由用户重新决定系统边界。

### 新模块准入

新增模块同时满足：

1. 当前已有代码需要调用它；
2. 它对一项可明确说出的结果负责，而且该结果会因自身需求变化；
3. 现有模块都无法在不扩大自身职责的情况下完成这项工作；
4. 测试可以单独检查它产生的结果。

同一项职责实际需要第二种实现时，再从现有模块已经使用的输入和结果中提取共同接口。

### 接口稳定性

下列内容发生变化时，只修改箭头右侧的位置：

- Pi 的生命周期、compaction 或 context 入口 → Pi Adapter；
- 来源事实正文如何写成线索 → Cue Provider；
- CueSet 向模型的呈现方式 → Pi Adapter；
- 按 ID 读取的工具如何把结果交给 Pi → Pi Adapter。

## 全局系统保证

跨模块、且不在单一模块职责里写完的保证：

- 完整事实只留在 Pi session tree，扩展不引入第二个事实库；
- 来源事实、当前路径、上一份 / 有效 CueSet、保存条件和读取范围以「路径、来源事实与有效性」为准，并按该节的
  动作归属使用；
- 线索生成与 Pi 压缩并行；只在本次压缩提交结果且满足保存条件时写入；
- 失败不改变 Pi 原生上下文、compaction 与主任务。

线索如何写成短句见 Cue Provider，投影与按 ID 读取见 Pi Adapter，装配见 Composition Root，运行证据见
Observation。如何证明以上保证，见 [`docs/verification.md`](./verification.md)。
