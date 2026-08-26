# 实施路线与当前状态

## 文档职责

**架构定位**：[`docs/design.md`](./design.md) 定义的目标架构与实现现状之间的路径。

**核心目标**：接手工作的人立即知道三件事——现在在哪、下一步做什么、这一步做完的判定标准是什么。

**职责边界**：本文维护阶段划分、实施状态、各阶段验收判定和下一实施入口。目标架构、模块职责与数据契约由
`docs/design.md` 维护，本文只引用不复制；证据类型与 live gate 契约由
[`docs/verification.md`](./verification.md) 维护。本文随每次
工作推进更新，因而与架构规范分离——使进度变化与架构变化在评审中始终可区分。

## 实施状态

当前处于「Pi 原生记忆接入」阶段。「运行边界与观察」已关闭：unit、repo checks 与 run-boundary live gate
全部通过，真实 Pi 中确认了 active/inert 原子启用、lifecycle callback 沿 Pi 原生错误路径报告、callback 在
manifest 声明的时间上限内返回，以及 observer sink 失败后降级并停止后续写入；各项判定与实测数值固定在
`test/live/run-boundary/workloads.json`。

本阶段要落地 Pi Adapter 的四项工作（读取来源 entries、处理 `session_compact`、保存 `CueSet` custom entry、
临时加入 context），所需的 tree、context 和 compaction 行为已由真实探针确认。第一步是按「阶段执行闭环」
建立本阶段 manifest，以固定 `CueSet` 驱动真实 Pi 边界。
## 阶段路径

每个阶段以它交付的结果命名，并完成 `docs/design.md` 中一个模块的全部或部分职责。依赖的阶段通过验收后，下一阶段
才开始。模块目标、业务需求和职责边界只在 `docs/design.md` 中修改；下表的「系统保证」只列出本阶段必须交付的
那部分结果，`docs/design.md` 的全局保证变化时同步检查对应行。

阶段按依赖顺序推进：

1. 「运行边界与观察」先保证扩展失败不会拖住 Pi，并为后续阶段留下诊断证据；
2. 「Pi 原生记忆接入」读取 Pi 已接受的 entries，并复用 Pi 的 session tree、compaction 和 context；
3. 「OpenViking 出站端口」用真实调用确定 ingestion、search 和 read 的接口行为；
4. 「会话事实同步」把 Pi entries 可靠地交给 OpenViking；
5. 「Compaction 记忆线索」只使用已经保存的事实生成 `CueSet`；
6. 「历史细节恢复」在已有线索之后提供模型真正需要的 search/read 工具。

每个阶段都复用「运行边界与观察」建立的降级规则。

| 阶段 | 建立的系统保证 | 落地的模块责任 |
| --- | --- | --- |
| 运行边界与观察 | 扩展运行实例原子启用，Pi callback 与诊断 sink 不阻塞主任务，每次运行留下可关联证据 | Observation、Configuration & Credentials、Composition Root |
| Pi 原生记忆接入 | 来源 entries 和 Memory Cues 都随 Pi 当前 session tree 保存和切换 | Pi Adapter（entries、compaction、context） |
| OpenViking 出站端口 | ingest、search 和 read 都经过 OpenViking Client，每次调用携带不可变 `OperationScope` | OpenViking Client、`OperationScope` |
| 会话事实同步 | 每个 Pi 已接受事实最终被 OpenViking 接受且可重放 | Fact Synchronizer |
| Compaction 记忆线索 | compaction 期间用上一份线索和新保存的事实生成下一份线索 | Cue Provider、Pi Adapter（compaction 时序、custom entry 与 context） |
| 历史细节恢复 | 模型可取回精确历史细节，且参数无法越权 | Pi Adapter（模型工具） |
| 本地服务托管 | 本地 OpenViking endpoint 可安全、可重建地提供 | Managed OpenViking Service |

### 运行边界与观察

**系统保证**：扩展 factory 返回时，所有 callback 要么都 active 并执行扩展工作，要么都 inert 并直接返回。Pi
按原生方式报告 callback 异常；每个 callback 在自己的时间上限内返回；Observer 写入 sink 不延长产品 callback；
每次运行留下可以按 runId、session 和 operation 关联的脱敏记录。

**交付**

- 完成 `docs/design.md`「Observation」「Configuration & Credentials」与「运行边界」的责任，包括 Composition Root
  的 activation 和 Pi Adapter callback 边界；
- 最小 `package.json` 与构建配置：只声明当前扩展入口、运行时要求与实际使用的依赖；
- [`docs/verification.md`](./verification.md)：证据类型、测试组织与 live gate 契约；
- `docs/development.md`：开发环境、开发循环与清理，含其余阶段所需 OpenViking endpoint 的获得方式。

**验收**

- 真实 Pi 中，装配成功的运行实例完整进入 active；注入装配失败时 Pi 正常启动，已注册 callback 全部保持 inert；
- 在 lifecycle callback 中注入异常后，Pi 发出原生扩展错误，会话继续到正常 shutdown；
- 同一次运行的观察记录可按 operation 关联出完整调用序列；未请求 observation 时不访问 sink，也不产生记录；
- observer 输出符合 schema 的记录；sink 延迟或失败不延长产品 callback，失败后本次 observer 保持 degraded；
- 观察记录中不出现用户正文、图片 base64、凭证与未脱敏 URI；

### Pi 原生记忆接入

**系统保证**：Pi Adapter 把 Pi 已接受的来源 entries 原样交给 Fact Synchronizer。compaction 完成后，它把收到的
`CueSet` 保存到 Pi 当前 tree 路径，并只在普通 provider 请求中加入简短线索；后续 compaction 不读取这些线索。

**交付**

- 完成 `docs/design.md`「1. Pi Adapter」中的四项工作：读取来源 entries、处理 `session_compact`、保存 `CueSet`
  custom entry，以及把线索临时加入 context；
- 建立本阶段 Pi live gate，以固定 `CueSet` 驱动真实 Pi tree、context 与 compaction 边界。

**验收**（对应 `docs/design.md`「验证责任」的 Pi 契约）

- 持久 session 与 in-memory session 中，Pi Adapter 取得的来源 entries 保持 Pi 已接受的原始值与顺序，扩展自身的
  `CueSet` custom entry 保持在来源事实集合之外；
- 真实 Pi compaction 完成后，测试驱动提供的固定 `CueSet` 作为 custom entry 保存在当前 tree 路径，普通 provider
  payload 可见其文本；
- 后续 compaction 的 preparation 中没有既有 `CueSet` 文本，新 compaction 后的普通 provider payload 只呈现 Pi
  当前 context entries 中有效的 `CueSet`；
- `/tree` 导航、session 重开与扩展重载后，provider context 中的 `CueSet` 与 Pi 当前 context entries 所属路径一致；
- 以上读取、保存或投影 callback 只做有界本地工作；失败沿 Pi 原生扩展错误路径报告，Pi agent loop、原生 context
  与 compaction 继续运行。

### OpenViking 出站端口

**系统保证**：ingest、search 和 read 都通过 OpenViking Client 调用。每次调用都可取消并返回可诊断结果；调用
开始后，本次 `OperationScope` 中的 principal、workspace 和 session 不再改变。

**交付**

- **边界调查先行**：在真实 OpenViking 实例上确定 ingestion、search 和 read 使用的公开能力，确认 ingestion 结果
  如何表示“已经保存”以及以后如何找到同一事实，并确定各调用的幂等条件；
- 完成 `docs/design.md`「4. OpenViking Client」与「OperationScope」的责任；有界重试只用于调查已证明幂等的
  调用。

**验收**

- ingestion、search 与 read 的接受语义和幂等条件由真实实例的运行记录确定；
- 同一来源事实按调查确定的机制重复 ingest 得到明确接受结果，不产生第二个逻辑对象；
- ingestion 成功时返回以后找到同一事实所需的信息；Fact Synchronizer 公开该信息，OpenViking 继续按请求 scope
  限制访问；
- search 返回结果保留服务端排名与服务端提供的 title/abstract 等价字段；read 按 canonical URI 与分页边界
  返回，越界请求被拒绝；
- 服务不可用、超时与取消各自返回有界失败结果并保留可区分的 cause，调用方不阻塞；
- 凭证不出现在观察记录、错误消息、状态输出与任何 artifact 中；
- 请求构造完成后其 scope 不可变。

### 会话事实同步

**系统保证**：每个 Pi 已接受的会话事实最终被 OpenViking 接受；外部失败保持在扩展边界内。

**交付**

- 完成 `docs/design.md`「2. Fact Synchronizer」的责任。

**验收**（对应 `docs/design.md`「验证责任」的 ingestion 契约）

- 一次真实会话结束后，Pi Adapter 提供的每个来源 entry 都有明确的接受或待重放结果；
- 从 OpenViking 读回的对象保留原始 Pi entry 的全部字段、parent 关系与未知 payload，结构上与来源值等价；
- 交付进度只在 OpenViking 明确接受后推进；接受结果丢失时该事实保持待重放；
- 进程重启或可重建交付进度缺失后，Fact Synchronizer 从 Pi 来源 entries 重新确定 pending，并使用相同来源身份提交；
- OpenViking 不可用期间 Pi 主任务、compaction 与 shutdown 时长不受影响，服务恢复后未交付事实完成交付。

### Compaction 记忆线索

**系统保证**：每次 Pi compaction 最多保存一份新 `CueSet`。生成开始前，Pi Adapter 取得当前路径的上一份
`CueSet`，再收集它之后已经保存到 OpenViking 的新 entries。Pi session tree 保存生成结果；普通 provider context
只看到其中的简短线索，后续 compaction 不读取这些线索。

**交付**

- 完成 `docs/design.md`「3. Cue Provider」的责任；
- 完成「1. Pi Adapter」的 compaction 前后时序、CueSet custom entry 提交与普通 provider context 投影。

**验收**（对应 `docs/design.md`「验证责任」的 Cue 契约）

- 使用固定延迟的 cue workload 时，真实 Pi 的 `session_before_compact` 在 cue 仍在生成时返回；观察记录显示 cue 生成
  与 Pi compaction 的执行时间发生重叠，`session_compact` 不等待并取消仍未完成的 cue 任务；
- 与相同身份、相同 workload 的 Pi 原生 compaction baseline 相比，加入 cue 后的实际总耗时满足 manifest 根据基线
  确定的增量阈值；
- 每次成功压缩要么保存一份新 `CueSet`，要么在观察记录中写明未保存的原因：生成未完成、取消、失败或路径变化；
- 固定 workload 中，在 Pi compaction 结束前生成并保存新 `CueSet` 的比例达到 manifest 根据基线确定的阈值；
- 第一份 `CueSet` 使用 session 开始后已保存的 entries；以后每份 `CueSet` 只使用上一份已经用到的最后一条 entry
  之后新保存的 entries，并记住本次用到的最后一条 entry；
- manifest 列出的重要事件都有对应线索；模型使用该线索调用 search/read 时可以找到目标事实；
- 每条线索只包含事件时间或区间、用于识别事件的短句，以及找到完整事实所需的信息；
- provider 可见的线索带有覆盖时间与采样说明，覆盖时间与本次已经用到的最后一条 entry 一致；
- `CueSet` 的线索数量与 provider 可见字符数落在固定上限内；
- 每个新的 `CompactionEntry` 最多保存一份新 `CueSet`；Pi tree 导航、session 重开与扩展重载后，provider context
  使用当前路径中已保存的 `CueSet`；
- 后续 compaction 的 preparation 排除既有 `CueSet` 文本，完成后的普通 provider payload 呈现当前有效的
  `CueSet`；
- 生成失败、超时、取消或路径变化时保留上一份 `CueSet`；下次生成继续处理它之后已经保存但还没有生成线索的
  entries，Pi 原生 context、compaction 与 agent loop 继续。

### 历史细节恢复

**系统保证**：模型可通过 search 与 read 取回精确历史细节；工具参数无法越过当前 Pi 与授权身份形成的调用范围。

**交付**

- 完成 `docs/design.md`「1. Pi Adapter」的模型工具注册、scope 组合与 tool result 映射。

**验收**（对应 `docs/design.md`「验证责任」的工具契约与安全契约）

- 真实 Pi 中模型调用 search 与 read 得到可用结果；文本与图片分别映射为 Pi 的 TextContent 与 ImageContent
  并进入 Pi 原生上下文；
- read 的分页与读取范围受上限约束，越界请求被拒绝；
- 工具参数中携带的 session identity 或授权范围字段不改变实际调用范围，以真实越界尝试证明；
- 工具调用失败返回可诊断的工具结果，agent loop 继续；
- 注册的工具集合只有 search 与 read。

### 本地服务托管

**系统保证**：需要本地托管的用户可以安全、可重建地获得 OpenViking endpoint。

本阶段不进入核心链路顺序。核心链路各阶段所需的 endpoint 由开发环境提供，见
[`docs/development.md`](./development.md)。

**交付**

- 完成 `docs/design.md`「Managed OpenViking Service」的责任；
- `docs/usage.md`：面向最终用户和服务操作者的产品说明。

**验收**（对应 `docs/design.md`「验证责任」的 Managed Service 契约）

- 在未预装依赖的机器上按声明工具链完成 setup，并启动到 OpenViking 官方 readiness；
- status 与 doctor 报告的进程、端点与数据位置与实际一致；
- stop 后由 ownership marker、state、PID 与进程身份共同证明本模块启动的进程与临时状态已清理；
- 非本模块启动的同名进程不被停止；
- 凭证不出现在日志、状态文件与观察记录中。

## 阶段执行闭环

每个阶段的实现依据由真实运行结果建立，并按同一循环执行：

1. 记录当前可重现现象与目标差距，并建立阶段 manifest；manifest 的字段与 hash 要求见
   [`docs/verification.md`](./verification.md)「live gate 契约」；
2. 对真实边界运行最小基线探针，用观察记录收集足以区分候选机制的证据，把实测 baseline 与预期变化写回
   manifest；
3. 找出当前最妨碍阶段验收的问题，实现能够完整解决它的最小改动，再运行直接覆盖该改动的 unit、contract 或
   repo checks；
4. 运行本阶段 live gate，把结果逐项与 baseline 和预期变化比较；结果不符时回到第 1 步，重新收集证据并找出当前
   最大差距；
5. unit、contract、repo checks、live gate 与文档自检全部通过后，关闭阶段出口并更新本文的实施状态。

证据类型与 live gate 契约见 [`docs/verification.md`](./verification.md)。只有阶段出口关闭后，下一阶段才能使用
本阶段交付的结果。

## 下一实施入口

「Pi 原生记忆接入」阶段的入口是建立本阶段 manifest：以固定 `CueSet` 驱动真实 Pi，验证来源 entries 的
读取、compaction 前后时序、`CueSet` custom entry 的保存与 provider context 投影。manifest 的字段与 hash 要求
见 [`docs/verification.md`](./verification.md)「live gate 契约」，验收判定见上文「Pi 原生记忆接入」一节。
