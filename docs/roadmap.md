# 实施路线与当前状态

## 文档职责

**架构定位**：从当前实现到 [`docs/spec.md`](./spec.md) 所定义目标架构之间的路径与位置。

**核心目标**：接手工作的人立即知道三件事——现在在哪、下一步做什么、这一步做完的判定标准是什么。

**职责边界**：本文只描述路径与位置。目标机制和契约引用 `docs/spec.md`，不在此复制；证据标准和门禁
契约引用 [`docs/verification.md`](./verification.md)，不在此复制；当前代码结构见
[`docs/design.md`](./design.md)。本文随每次工作推进更新，因而与架构规范分离——使进度变化与架构变化
在评审中始终可区分。

## 实施状态

**Phase 0 阶段出口已关闭。** 事件投影、身份、确认前沿与重放在真实 Pi lifecycle、真实
`SessionManager` 和受管 OpenViking 上成立：`npm test` 提供 deterministic 证据，`verify:phase0:live`
提供真实边界证据。该门禁断言的范围见 [`docs/verification.md`](./verification.md) 的阶段门禁表；
workload、身份与阈值由 `test/live/phase0.workloads.json` 及其固定 hash 承载。

**可观测性基线出口已关闭。** `shared/observe.mjs` 的 active stage registry 是现行点位唯一清单；关闭零工作、
sink/schema fail-open、字节一致性和职责模块接点由 deterministic checks 证明，`verify:observability:live` 在固定
manifest/hash 下覆盖成功 recall/同步、断线、409 冲突、URI 拒绝和持久清理。该 gate 此后作为每个阶段的常驻出口条件。

**Phase 1 的专有证据已齐备，阶段出口在常驻 gate 恢复前保持未关闭。** Archive 的原子机制由真实 0.4.15
上的基线调查选定，机制、实测证据与被证伪的候选记录在 `test/live/phase1.workloads.json` 的 `mechanism`。
`npm test` 提供 deterministic 证据，`verify:phase1:live` 在真实 Pi lifecycle 与受管 OpenViking 上覆盖
Archive 形成、崩溃残留恢复、受管重启幂等和完整性冲突 fail-open。

**阻塞出口的既有项**：常驻的 `verify:observability:live` 中 `tool-uri-rejection` workload 失败
（`pi-read-blocked`、`tool-uri-live.expected-records`）。该失败在 Phase 1 改动前的 `ad32ef4` 上同样复现：
该 workload 依赖模型按提示逐字调用内置 `read`，模型未照做时断言退化为环境噪声。修复方向是让该 workload
由确定性输入触发 guard，而不是依赖模型自由选择工具。

**待收敛项**：`test/live/observability-live.mjs` 仍保留自己的 Pi 驱动、身份核对、ownership 与清理实现，
未使用 `test/live/live-support.mjs` 的统一骨架；修复上述 workload 时一并收敛。

**当前工作是 Phase 2A 的基线调查；Phase 2A 实现尚未开始。**

## 实施顺序

Phase 0 建立事件与同步事实；Phase 1 建立原子 Archive；Phase 2 依次建立 checkpoint、`ActiveContext`
和真实上下文切换；Phase 3 校准多 workload/model 组合；Phase 4 建立检索与诊断。下一阶段只消费
已通过上一阶段 deterministic checks 与 live gate 的状态。

每个阶段按同一调查闭环执行：

1. 在实现前建立 manifest，固定阶段成功标准、当前可重现现象、与目标的差距、证伪条件、输入和机器
   观察点；观察点按 [`docs/observability.md`](./observability.md) 的分类和必带字段声明；
2. 对真实边界运行最小基线探针，用同一标准的观察记录收集足以区分候选机制的证据，把 baseline、
   阈值和预期变化写回 manifest 并固定 hash；Phase 1 的原子机制选择必须先完成该调查；
3. 选择当前主导约束，实施能闭合该约束的最小结构，并先运行聚焦 deterministic checks；
4. 运行阶段 live verifier，把结果与基线和预期变化逐项比较；结果偏离时回到步骤 1，重新调查并识别
   主导约束；
5. deterministic checks、live gate、完整 `npm test`、`git diff --check`、文档自检和
   `docs/observability.md` 的完成门共同通过后关闭阶段出口。

若某阶段的实现先于其 live gate 存在，则按补建处理：先用独立协议向量和真实探针建立 reference baseline
并固定 manifest，再实现 verifier；verifier 失败即重新打开对应的实现约束。

### 可观测性基线（横切）

观察点是横切能力，不是产品阶段，因此不进入 Phase 编号。它由两部分组成：一次性收敛既有代码路径，
以及成为此后每个阶段的常驻出口条件（见上文步骤 5）。

收敛先于 Phase 1 的基线调查完成，因为该调查是观察记录的第一个消费者：步骤 2 要求用观察记录区分
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

### Phase 0：完整记录与最小可靠同步

#### Phase 0A：事件投影与身份

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

#### Phase 0B：确认前沿与重放

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

### Phase 1：原子 Archive

- 调查 OpenViking 可用于 Archive 原子绑定的公开操作及崩溃语义，以实践结果选择最小机制；
- 从已经确认的 immutable event 对象选择完整 event/step 范围，生成确定性 `archiveId`；
- 回读事件并重算 event identity、顺序和内容 hash，manifest 记录 event/step 边界、数量和聚合
  hash；
- 固定所选原子机制的数据结构、接受证明、冲突和恢复规则；Phase 0 的事件 commit marker 不得代替
  Archive 接受证明；
- 提供按 `archiveId` 的确定性读取和 expand，按 manifest materialize 事件并重新验证全部 hash；
- 根据单个用户轮次内的 token/step 压力生成有效 Archive；
- 跨重启恢复未完成的 Archive，复用相同 `archiveId`，不产生第二个逻辑对象；
- 用 golden 基线验证确定结果；用独立生成的 Archive 边界、长工具循环、单轮超长输入和重启场景验证
  manifest/step 不变量；
- 用多个真实 Pi workload 形成 Archive，回读并验证各自事件顺序、step 边界、manifest 和 expand；
- `/viking` 展示 Archive 身份、提交状态、处理状态和边界诊断。

**验收**：

- 所选机制的接受证明、manifest hash、event/step 边界、数量和引用事件全部一致时 Archive 才可见；
- 响应丢失、部分落盘和进程重启后复用相同 `archiveId`，不会产生重复或半可见 Archive；
- 按 `archiveId` 回读和 expand 得到确定且完整的源事件序列；
- tool call/result 在 Archive 边界保持原子，单个用户轮次内的 token/step 压力能够生成有效
  Archive；
- 各真实 Pi workload 的 Archive 均满足 manifest、event/step 边界、hash 和 expand 完整性。

### Phase 2：单一 checkpoint 与上下文接管

#### Phase 2A：checkpoint 生产

- 每个 Archive 异步生成一个统一的结构化 checkpoint；
- checkpoint 保存模型版本、prompt 版本、输入 Archive 身份和 hash；
- 以 request、checkpoint 和失败事件表达 VLM 运行事实；
- 从未消费 Archive 派生处理中、落后、恢复和积压 token，并实现对应通知；
- `/viking` 展示 VLM 积压、失败、checkpoint ID 和来源 Archive；
- 校验 checkpoint 身份、hash、重试和跨重启恢复，并将有效 checkpoint 作为 Phase 2B 输入；
- 用 golden 固定输出回归身份，以独立生成的重试/失败/积压场景验证状态不变量，并让 Phase 1 的多种
  真实 Archive 工作负载分别经过固定 VLM。

**验收**：

- 持久化且来源 Archive 身份和 hash 匹配的 checkpoint 表示该 Archive 消费完成；
- 同一 Archive 的重试和进程重启恢复至多产生一个有效 checkpoint；
- 一个未消费 Archive 显示处理中，第二个产生时通知消费落后，恢复到至多一个在途 Archive 时
  通知一次；
- Archive、request、checkpoint 和失败事件能够完整派生 VLM 状态、失败原因及积压 token；
- VLM 失败不改变已经持久化的事件和 raw Archive；
- Phase 1 的各真实 Archive 工作负载均产生来源和 hash 可核验的 checkpoint，并分别满足固定 VLM
  吞吐要求。

#### Phase 2B：活动上下文构造

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
- 高水位公式结果为正时，任务模型能够在安全余量内完整装载 dry-run payload；
- 高水位公式结果非正时 takeover eligibility 为 inactive，`/viking` 给出 capacity mismatch 和
  fallback 诊断。

#### Phase 2C：上下文切换与 fail-open

- 通过 `context` hook 原子切换 provider 可见上下文，并冻结到下一次接管；
- 每次高水位只替换一次 `ActiveContext`，后续事件追加在稳定前缀之后；
- 无有效 `ActiveContext`、OpenViking/VLM 降级或容量不匹配时继续使用完整 Pi 上下文；
- Pi 原生 compaction 提供运行时 fail-open，扩展只提供生命周期钩子结果；
- 用 golden 回归和独立生成场景验证切换不变量；用开发模型身份中的 task provider 真实请求验证高水位、
  分支、重启、compaction 和 fail-open payload。

**验收**：

- 每次上下文高水位原子替换一次 `ActiveContext`，并保持到下一次上下文高水位；
- provider 实际 payload 与 Phase 2B 验证的构造一致，后续事件追加在稳定前缀之后；
- 无有效 `ActiveContext`、OpenViking/VLM 降级或容量不匹配时，provider 使用完整 Pi 上下文；
- 单个用户指令后的长工具循环能够安全归档和接管；
- Pi 是 compaction 的唯一触发方；`ActiveContext` 不可用时执行原生 split-turn compaction，扩展
  仅返回生命周期钩子结果并保持运行中的 agent 可用。

### Phase 3：固定模型端到端预算校准

- 在 Phase 0–2 逐阶段通过后，使用开发模型身份中的任务模型和 VLM 运行“验证策略”
  定义的多个独立 100k+ 工作负载，每个 workload 至少独立重复三次；token 数取自 Pi/provider 实际计量；
- 对照原始事件检查 Archive 边界、raw tail、checkpoint 和接管上下文；
- 使用 Pi 报告的固定任务模型容量验证高水位公式两侧的 fit 与 capacity mismatch 行为；
- 根据 step 原子性、raw-tail 完整性和上下文容量调整候选预算并重跑；
- 确认固定 VLM 能在下一个 Archive 产生前完成前一个 checkpoint；
- 固定模型身份、预算和 eligibility 规则通过端到端验证后写入发布配置。

**验收**：

- 各真实 100k+ 工作负载中的 Archive、raw tail、checkpoint 和 provider payload 与各自源事件逐项对应，
  没有遗漏、重复或破坏 step 原子性；
- 每个 workload 至少三次重复运行均保持身份、不变量和阈值结论一致；
- 候选 Archive、checkpoint 和 raw-tail 预算满足完整性及固定任务模型的安全余量；
- 固定 VLM 能在下一个 Archive 产生前完成前一个 checkpoint；
- 固定任务模型容量在 eligibility 边界两侧分别得到 active 和 capacity mismatch 结果；
- 通过上述验收的固定模型身份、预算和 eligibility 规则写入发布配置。

### Phase 4：检索与诊断体验

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

当前入口是 Phase 2A 的基线调查：按“实施顺序”的调查闭环建立 `test/live/phase2a.workloads.json` manifest，
用 Phase 1 已提交的真实 Archive 与开发模型身份中的 VLM，先实测 checkpoint 生成的吞吐、失败形态和重试
语义；把 baseline、数值阈值、预期变化和证伪条件固定后，再实现 checkpoint 生产。

进入该入口前需要一并处理的既有项：`verify:observability:live` 的 `tool-uri-rejection` workload 依赖模型
自由选择工具，当前失败（见“实施状态”）。它是常驻出口条件的一部分，Phase 2A 关闭前必须恢复为确定性可验。
