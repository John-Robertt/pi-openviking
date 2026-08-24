# 实施路线与当前状态

## 文档职责

**架构定位**：从当前实现到 [`docs/spec.md`](./spec.md) 所定义目标架构之间的路径与位置。

**核心目标**：接手工作的人立即知道三件事——现在在哪、下一步做什么、这一步做完的判定标准是什么。

**职责边界**：本文只描述路径与位置。目标机制和契约引用 `docs/spec.md`，不在此复制；证据标准和门禁
契约引用 [`docs/verification.md`](./verification.md)，不在此复制；当前代码结构见
[`docs/design.md`](./design.md)。本文随每次工作推进更新，因而与架构规范分离——使进度变化与架构变化
在评审中始终可区分。各阶段以所建立的系统保证命名，gate 命名契约见 `docs/verification.md`。

## 实施状态

**完整记录与可靠同步的出口已关闭。** 事件投影、身份、确认前沿与重放在真实 Pi lifecycle、真实
`SessionManager` 和受管 OpenViking 上成立：`npm test` 提供 deterministic 证据，`verify:sync:live`
提供真实边界证据。该门禁断言的范围见 [`docs/verification.md`](./verification.md) 的门禁表；
workload、身份与阈值由 `test/live/sync.workloads.json` 及其固定 hash 承载。

**可观测性的 deterministic 保证成立，当前 live 出口待验证。** `shared/observe.mjs` 的 active stage registry 是现行
点位唯一清单；关闭零工作、sink/schema fail-open、字节一致性、进程 run 下的 session producer 隔离与会话替换注销由
deterministic checks 证明。现行 manifest 已让 `active_context_compaction` 只由真实 `session_before_compact` hook 证明，
不再用非 owner 手工生成记录。当前 `verify:observability:live` 的成功 recall fixture 受 OpenViking semantic 队列积压影响，
在统一 deadline 内未变为可检索；其余断线、409 冲突和 URI 拒绝 workload 通过。队列恢复后必须按当前固定 hash 重跑，
通过前该常驻出口保持打开。

**原子 Archive 的出口已关闭。** Archive 的原子机制由真实 0.4.15 上的基线调查选定，机制、实测证据与
被证伪的候选记录在 `test/live/archive.workloads.json` 的 `mechanism`。`npm test` 提供 deterministic 证据，
`verify:archive:live` 在真实 Pi lifecycle 与受管 OpenViking 上通过 118/118，覆盖 Archive 形成、完整 Pi entry/step
边界、崩溃残留恢复、受管重启幂等和完整性冲突 fail-open；常驻 `verify:observability:live` 覆盖现行 registry。

**checkpoint 生产的出口已关闭。** checkpoint request、代码拥有的明确 failure 与结构化 checkpoint 作为自产
`RecordedEventV1` 进入既有 immutable event namespace；消费状态、完整 parent/attempt 链、积压和终态清理
义务只从 Archive 与这些事实派生。deterministic checks 证明孤立 checkpoint 拒绝、并发首写者收敛、逐 Archive
三次 attempt、媒体失败 pending、外部错误脱敏和跨重启清理。

`verify:checkpoint:live` 在当前开发模型身份和受管 OpenViking 上覆盖文本、多模态、明确失败后的真实 VLM 重试、
双 Archive 重启恢复及当前 Archive 范围失效，并分别以 480000ms 和 240000ms 约束媒体语义处理与 checkpoint 生成，
通过 138/138：跨代 Working Memory 保留上一代全局目标的精确标识并纳入当前 Archive 的新增约束，有效 128x128 PNG 的媒体
语义处理与其后的 checkpoint 生成分别落在各自阈值内。accepted baseline、身份、阈值和成功标准由
`test/live/checkpoint.workloads.json` 及其固定 hash 承载；`verify:observability:live` 覆盖现行 registry。


**活动上下文构造的 deterministic 保证成立，当前 live 出口待验证。** `ActiveContext` 只持久化
`docs/spec.md` 定义的两个字段，选自当前分支上最后一个已消费的 checkpoint；anchor 由 raw tail 起点的 turn 身份重算。
deterministic checks 证明候选选择、跨重启复用、来源边界离开祖先链后的失效、anchor 重算、dry-run payload、容量判定、
缺失 checkpoint 权重事实的 fail-open，以及同一两字段候选只 materialize 一次。现行 `verify:context:live` manifest 已收敛为
一份 eligibility 公式并固定新 hash，必须在真实 Pi、Archive 与 VLM checkpoint 上重跑后关闭出口。

**上下文切换与 fail-open 的 deterministic 保证成立，当前 live 出口待验证。** `context` hook 在 eligible
`ActiveContext` 到达高水位时原子替换 provider messages；`session_before_compact` 只在事实可读且 eligible 时提供自包含
checkpoint，否则由 Pi 使用完整上下文和原生 compaction。现行 `verify:takeover:live` 已加入 checkpoint 超预算的真实 provider
payload、owner 观察记录与 compaction 断言。当前受管 VLM 在部分 workload 返回了不满足统一 continuation 契约的 Working Memory，
使这些 workload 无法形成前置 checkpoint；能够形成 checkpoint 的 workload 通过既有重启、分支和 fail-open 断言。VLM 恢复后
必须按当前固定 hash 完整重跑，证明超预算、容量不匹配、稳定前缀、checkpoint 推进与 compaction 后再关闭出口。

**发布预算校准的出口已关闭。** 发布默认预算保持 Archive chunk 50000、raw tail 20000、checkpoint 16000。
`verify:budget:live` 在现行最小 checkpoint schema、统一 Working Memory 接受门和完整装载 fail-open 下，对 tool-loop、
单轮原子输入与 sibling branch 三类独立 100k+ workload 各重复三次并通过 748/748；session 启动先刷新已有 checkpoint
事实及对应 ActiveContext，shutdown 在同一 500ms grace 内停止 checkpoint 后台并动态排空派生更新，九次 provider/branch
compaction observation 均完整。accepted baseline、模型身份、实测阈值、结果及适用范围由
`test/live/budget.workloads.json` 及固定 hash 承载。

## 实施顺序

可靠同步建立事件与同步事实；原子 Archive 建立原子对象；checkpoint 与上下文接管依次建立 checkpoint、
`ActiveContext` 和真实上下文切换；预算校准校准多 workload/model 组合；检索与诊断建立检索与诊断体验。
每一阶段只消费已通过上一阶段 deterministic checks 与 live gate 的状态。

每个阶段按同一调查闭环执行：

1. 在实现前建立 manifest，固定阶段成功标准、当前可重现现象、与目标的差距、证伪条件、输入和机器
   观察点；观察点按 [`docs/observability.md`](./observability.md) 的分类和必带字段声明；
2. 对真实边界运行最小基线探针，用同一标准的观察记录收集足以区分候选机制的证据，把 baseline、
   阈值和预期变化写回 manifest 并固定 hash；原子 Archive 的机制选择必须先完成该调查；
3. 选择当前主导约束，实施能闭合该约束的最小结构，并先运行聚焦 deterministic checks；
4. 运行阶段 live verifier，把结果与基线和预期变化逐项比较；结果偏离时回到步骤 1，重新调查并识别
   主导约束；
5. deterministic checks、live gate、完整 `npm test`、`git diff --check`、文档自检和
   `docs/observability.md` 的完成门共同通过后关闭阶段出口。

若某阶段的实现先于其 live gate 存在，则按补建处理：先用独立协议向量和真实探针建立 reference baseline
并固定 manifest，再实现 verifier；verifier 失败即重新打开对应的实现约束。

### 可观测性基线（横切）

观察点是横切能力，不进入实施顺序编号。它由两部分组成：一次性收敛既有代码路径，
以及成为此后每个阶段的常驻出口条件（见上文步骤 5）。

收敛先于原子 Archive 的基线调查完成，因为该调查是观察记录的第一个消费者：步骤 2 要求用观察记录区分
候选的原子机制，缺少统一记录就只能依赖一次性探针。

- 建立 `shared/observe.mjs`：实现唯一 active stage registry（owner/kind/schema/outcome）、版本化 run/record、会话 hash、
  本地操作关联、字段白名单、单一有界 writer、两种互斥去向与只读观察状态；
- 把 `index.ts` 与 `sync.ts` 的 `OV_DEBUG_LOG` 自由文本日志收敛为职责模块内的结构化点位；
- 为 `client.ts` 的 HTTP 请求建立成对 `boundary`，只记录 route 模板，并在实际响应存在时透出合法 `traceId`；
- 为 Pi lifecycle 建立独立 boundary schema，接通 recall/tool/capability/ACK 的最小 `decision`，错误直接触发的 fail-open
  由同一条 `failure` 的 disposition/branch 表达，并按实际长生命周期状态补 `state`；
- `/viking` 只读展示观察状态；`scripts/e2e-probe.ts` 继续承担原始 provider payload 验证，不并入观察记录。

**验收**：

- deterministic checks 证明 active stage registry 唯一且无冗余、版本与 schema/脱敏成立、未请求观察时初始化后无
  文件系统/时钟/序列化/hash/op/逐记录构造调用、固定输入下路径与 FD 字节等价；sink 配置或写入失败只产生
  `incomplete`，产品返回值、状态和调用顺序与未观察基线一致，且观察记录不进入事实源；
- `verify:observability:live` 的当前 manifest 覆盖 registry 全部 active stage；真实 Pi 成功与受控降级 workload 各产生
  一个完整 run，能够按 op 复原 OpenViking 交互、分支选择、状态变化和失败处置，且无非法记录、丢弃或未配对
  boundary；
- 仓库内不存在第二套运行过程观察。

### 完整记录与可靠同步

#### 事件投影与身份

- 实现“目标配置”定义的唯一配置 schema 和未知字段校验；
- 完整捕获不透明或大型 payload，并保留 tool result 的真实完成和错误状态；
- 固定 user、assistant、tool call/result 和未知 part 的 `RecordedEvent` 投影及 step 边界；
- 用 RFC 8785 规范字节固定 event identity、content hash 和完整事件字节；
- 建立合成 100k+ golden 负载，并以独立 seed 生成多类型 entry、不同树拓扑和长工具循环；逐事件校验
  投影、身份以及可从事件无损重建源 entry。

**验收**：

- 配置模板与“目标配置”schema 一致，未知字段返回包含字段路径的校验错误；
- 当前 Pi `SessionManager` 真实持久化的 user/assistant/tool result、分支、custom、model change 和 compaction
  JSONL 可在重启后完整恢复并投影；
- golden 负载逐事件保留 payload、part 类型与索引、step 边界以及 tool result 状态；独立生成场景
  对多种 payload、树拓扑和长工具循环满足相同不变量；
- 同一源事件重复投影得到相同 event ID、规范字节和 content hash，相同内容的不同事件得到不同
  event ID；event/parent/source/part/turn/step 字段与 Pi JSONL 可逐项重算。

#### 确认前沿与重放

- 以持久 Pi JSONL 提供完整 entry tree，根据 `id/parentId` 同步所有未确认分支并恢复当前 leaf；
- 实现 OpenViking Content API adapter：探测 capability、幂等建立绑定用户的隐藏 Resource、
  按确定性 URI/共同父目录/服务限制组织 `batch-write`，并严格核对每个响应 URI；
- 小事件使用 immutable 单对象，大事件使用 claim/chunks/commit marker，在服务存储容量内完整
  保留 payload；
- 使用稳定 event ID 处理 ACK/响应丢失、部分落盘和重放，将 `409 CONFLICT` 作为不可覆盖的
  完整性错误；
- 仅在一个 Pi entry 的全部事件被 OpenViking 接受后，以最小 `SyncAck` 增量更新 ACK frontier；
- 同步层只持久化 `SyncAck`；待同步内容始终从 Pi JSONL 重建；
- `turn_end` 和 `session_compact` 只非阻塞调度同步；shutdown 调度最终 snapshot，最多等待 500ms
  后取消 transport；网络超时不得阻塞 Pi 主任务或 compaction；
- `/viking` 提供连接、adapter capability、ACK frontier、待重放和同步失败状态，使 ACK 推进和
  fail-open 可直接观察。

**验收**：

- 在受支持 OpenViking 实例上验证首次写入为 `created`、同字节重放为 `unchanged`、不同字节为
  `409 CONFLICT`、raw download byte-exact；普通 shard `ls` 不返回 dot event files，允许上层 dot
  directory 可见，raw events 不进入普通 Resource 语义索引；
- 持久 Pi JSONL 中的每个源事件都有确认结果，entry 仅在全部投影事件确认后推进 ACK frontier；
- golden 分支在 ACK 丢失、响应丢失、同批部分落盘、等长替换、短分支、从已确认祖先创建分支和
  进程重启后逐事件得到确认；生成树在不同拓扑与确认顺序下得到同一最小 ACK frontier；
- 相同 event ID 的重试保持幂等，同 ID 不同规范字节停止 ACK 并给出完整性诊断；
- 127/128/129 项、8 MiB 单对象及 16 MiB 批次边界按矩阵拆分；超过 8 MiB 的事件跨请求重放后，
  在 chunks 完整、hash 一致和 commit marker 有效时确认；
- 持久同步状态仅包含最小 `SyncAck`，非持久化 Pi session 提供进程内 best-effort 同步；
- OpenViking 不可用或 capability 不匹配时，未确认事件保持待重放，Pi 主任务保持可用；
- health 后网络退化或大事件传输仍在进行时，Pi lifecycle 不等待同步完成；shutdown 最多等待
  500ms 后取消 transport。

### 原子 Archive

- 调查 OpenViking 可用于 Archive 原子绑定的公开操作及崩溃语义，以实践结果选择最小机制；
- 从已经确认的 immutable event 对象选择完整 event 范围，且边界不拆开 Pi entry 或 step，生成确定性 `archiveId`；
- 回读事件并重算 event identity、顺序和内容 hash，manifest 记录 event/step 边界、数量和聚合
  hash；
- 固定所选原子机制的数据结构、接受证明、冲突和恢复规则；事件对象的 commit marker 不得代替
  Archive 接受证明；
- 提供按 `archiveId` 的确定性读取和 expand，按 manifest materialize 事件并重新验证全部 hash；
- 根据单个用户轮次内的 token/step 压力生成有效 Archive；
- 跨重启恢复未完成的 Archive，复用相同 `archiveId`，不产生第二个逻辑对象；
- 用 golden 基线验证确定结果；用独立生成的 Archive 边界、长工具循环、单轮超长输入和重启场景验证
  manifest/entry/step 不变量；
- 用多个真实 Pi workload 形成 Archive，回读并验证各自事件顺序、entry/step 边界、manifest 和 expand；
- `/viking` 展示 Archive 身份、提交状态、处理状态和边界诊断。

**验收**：

- 所选机制的接受证明、manifest hash、event 范围、entry/step 边界、数量和引用事件全部一致时 Archive 才可见；
- 响应丢失、部分落盘和进程重启后复用相同 `archiveId`，不会产生重复或半可见 Archive；
- 按 `archiveId` 回读和 expand 得到确定且完整的源事件序列；
- Pi entry 与 tool call/result step 在 Archive 边界保持原子，单个用户轮次内的 token 压力能够生成有效 Archive；
- 各真实 Pi workload 的 Archive 均满足 manifest、event 范围、entry/step 边界、hash 和 expand 完整性。

### checkpoint 与上下文接管

#### checkpoint 生产

- 每个 Archive 异步生成一个统一的结构化 checkpoint；
- checkpoint 保存模型版本、prompt 版本、输入 Archive 身份和 hash；
- 以 request、代码拥有的明确 failure 和 checkpoint 事件表达 VLM 运行事实，并验证完整 parent/attempt 链；
- 从未消费 Archive 派生处理中、落后、恢复和积压 token，并实现对应通知；
- `/viking` 展示 VLM 积压、失败、checkpoint ID 和来源 Archive；
- 校验 checkpoint 身份、hash、重试和跨重启恢复，并将有效 checkpoint 作为活动上下文构造的输入；
- 用 golden 固定输出回归身份，以独立生成的重试/失败/积压场景验证状态不变量，并让原子 Archive 阶段的
  多种真实工作负载分别经过固定 VLM。

**验收**：

- checkpoint 的来源 Archive 身份/hash 匹配，且 parent 指向连续 attempt 中存在、匹配、无 failure 的 request，才表示该 Archive 消费完成；
- 同一 Archive 的重试、响应不确定、进程重启与并发恢复采用首个有效事实，至多产生一个有效 checkpoint；
- 一个未消费 Archive 显示处理中，第二个产生时通知消费落后，恢复到至多一个在途 Archive 时
  通知一次；
- Archive、request、checkpoint 和失败事件能够完整派生 VLM 状态、失败原因、积压 token 及终态 attempt 的临时清理义务；
- 媒体未获得非空摘要时保持同一 request pending；终态 Session 与媒体根跨重启重试，二者都确认不存在才完成清理；
- VLM 失败不改变已经持久化的事件和 raw Archive；
- 原子 Archive 阶段的各真实工作负载均产生来源和 hash 可核验的 checkpoint，并分别满足固定 VLM
  吞吐要求。

#### 活动上下文构造

- 选择已确认 checkpoint 和原子的 raw-tail 边界，形成并持久化最小 `ActiveContext`；
- 跨重启恢复 `ActiveContext`，分支变化时只复用来源边界仍在当前祖先链上的上下文；
- dry-run 从 checkpoint、原始用户指令 anchor、raw tail 和未归档事件 materialize 候选 task payload，
  对照源事件验证内容与 tool call/result step；
- dry-run 期间 provider 使用完整 Pi 上下文；
- 使用 Pi 报告的任务模型容量计算 takeover eligibility；容量不匹配时保持 inactive，并由
  `/viking` 显示 capacity mismatch、checkpoint ID 和 raw-tail 边界。

**验收**：

- `ActiveContext` 固定来源 checkpoint、原始用户指令 anchor 和原子的 raw-tail 起点，并能跨重启
  恢复；
- 分支变化时，仅复用来源 Archive 边界仍在当前祖先链上的 `ActiveContext`；
- dry-run payload 完整包含 system、checkpoint、原始用户指令 anchor、raw tail 和全部未归档事件；
- tool call/result 在 raw-tail 边界保持原子；
- Pi 报告的 `contextWindow-maxTokens` 能在安全余量内完整装载候选 payload；
- 显式高水位配置不改变模型容量、候选 payload、headroom 或 eligibility。

#### 上下文切换与 fail-open

- 通过 `context` hook 原子切换 provider 可见上下文，并冻结到下一次接管；
- 每次高水位只替换一次 `ActiveContext`，后续事件追加在稳定前缀之后；
- 无有效 `ActiveContext`、OpenViking/VLM 降级或容量不匹配时继续使用完整 Pi 上下文；
- Pi 原生 compaction 提供运行时 fail-open，扩展只提供生命周期钩子结果；
- 用 golden 回归和独立生成场景验证切换不变量；用开发模型身份中的 task provider 真实请求验证高水位、
  分支、重启、compaction 和 fail-open payload。

**验收**：

- 每次上下文高水位原子替换一次 `ActiveContext`，并保持到下一次上下文高水位；
- provider 实际 payload 与活动上下文构造验证的构造一致，后续事件追加在稳定前缀之后；
- 无有效 `ActiveContext`、OpenViking/VLM 降级或容量不匹配时，provider 使用完整 Pi 上下文；
- 单个用户指令后的长工具循环能够安全归档和接管；
- Pi 是 compaction 的唯一触发方；`ActiveContext` 不可用时执行原生 split-turn compaction，扩展
  仅返回生命周期钩子结果并保持运行中的 agent 可用。

### 发布基线端到端预算校准

- 在可靠同步、原子 Archive、checkpoint 与上下文接管逐段通过后，使用开发模型身份中的 task/VLM 组合
  作为可重复的发布验收基线，运行“验证策略”定义的多个独立 100k+ 工作负载，每个 workload 至少独立重复
  三次；token 数取自 Pi/provider 实际计量；
- 对照原始事件检查 Archive 边界、raw tail、checkpoint 和接管上下文；
- 使用 Pi 为基线任务模型报告的容量验证通用高水位公式两侧的 fit 与 capacity mismatch 行为；
- 根据 step 原子性、raw-tail 完整性和上下文容量调整候选预算并重跑；
- 确认基线 VLM 能在下一个 Archive 产生前完成前一个 checkpoint；
- `verify:budget:live` manifest/summary 维护基线模型身份、实测阈值、结果及适用范围；发布配置维护通过验收的
  通用预算默认值，运行时 eligibility 按 Pi 当前任务模型报告的容量计算。

**验收**：

- 各真实 100k+ 工作负载中的 Archive、raw tail、checkpoint 和 provider payload 与各自源事件逐项对应，
  没有遗漏、重复或破坏 step 原子性；
- 每个 workload 至少三次重复运行均保持身份、不变量和阈值结论一致；
- 候选 Archive、checkpoint 和 raw-tail 预算满足完整性及基线任务模型的安全余量；
- 基线 VLM 能在下一个 Archive 产生前完成前一个 checkpoint；
- Pi 报告的基线任务模型容量在 eligibility 边界两侧分别得到 active 和 capacity mismatch 结果；
- gate manifest/summary 中的模型身份、实测证据和适用范围一致，发布配置中的通用预算默认值与验收结果一致；
  每个运行时任务模型按自身容量获得独立 eligibility 判定。

### 检索与诊断体验

- 语义搜索 raw events 与 checkpoint，并显示来源类型；
- 支持按 session、branch、Archive 和 event ID 的组合过滤、browse 和 expand；
- 每个检索结果都能展开到原始事件，并显示 checkpoint 的模型、prompt 版本和来源 Archive；
- 按 event → Archive → checkpoint → `ActiveContext` 来源链提供组合诊断，呈现对象身份、边界和
  派生关系。

**验收**：

- raw events 与 checkpoint 可语义检索，结果明确显示来源类型；
- Archive manifest 可按 session、branch、Archive 和 event ID 确定性过滤、browse 和 expand；
- 每个检索结果都能展开到原始事件，event → Archive → checkpoint → `ActiveContext` 来源链的
  身份、hash、边界和版本信息一致；
- 组合诊断能够定位当前 checkpoint、raw-tail 边界及对应的内部状态。

## 下一实施入口

当前入口是重新关闭现行 live 出口：OpenViking semantic 队列恢复后先运行 `verify:observability:live`；受管 VLM 能稳定生成
满足统一 continuation 契约的 Working Memory 后，按当前固定 hash 运行 `verify:context:live` 与 `verify:takeover:live`。三者通过后
继续检索与诊断体验：建立 `verify:retrieval:live` manifest，并验证语义搜索、过滤、browse/expand、来源链和所属资源清理。
