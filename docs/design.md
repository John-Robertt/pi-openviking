# 当前实现设计

## 文档职责

**架构定位**：当前代码实际形态的说明。

**核心目标**：修改代码前先知道“现在的职责边界和数据流是什么”，据此判断改动落在哪个模块。

**职责边界**：本文只描述已经存在的实现，不描述目标形态、阶段路径和验收标准——那些分别由
[`docs/spec.md`](./spec.md)、[`docs/roadmap.md`](./roadmap.md) 和
[`docs/verification.md`](./verification.md) 维护。本文不复制 wire/storage 协议，随代码变化更新。

## 责任边界

### `index.ts`

- 绑定 Pi 生命周期；
- 在 `session_start` 初始化会话来源和 ACK，并启动一次会话同步；首个 `context` 或 `session_before_compact` hook 在消费
  ActiveContext 前等待该同步收敛，普通 UI 启动不等待；
- 在 `turn_end`、`session_compact`、`session_tree`、`session_info_changed`、`model_select`、`thinking_level_select` 非阻塞调度会话来源检查或同步；
- `session_shutdown` 仅在 Pi leaf 尚未被最近同步观察时调度最终 snapshot；随后给予既有同步 500ms grace 并取消
  transport，未确认内容留在 Pi 来源；观察已启用时只用同一期限的剩余时间完成独立记录；
- `before_agent_start` 把 profile block 注入 system prompt 并排队 recall；`context` hook 首次用完整 Pi context usage 判定高水位，
  provider epoch 建立后始终渲染同一 ActiveContext，并只在该 ActiveContext payload 再次越过高水位时原子推进 checkpoint；
  recall 在最终 messages 上注入；profile/recall 的实际注入追加 `ov-observation` custom entry，再由同一事件链同步；takeover 本身只进入私有观察记录，不追加 Pi entry；
- `tool_call` 阻止通用文件与 shell 工具直接处理 `viking://` URI，并引导使用对应 `viking_*` 工具；
- 在调度同步和接管判定时提供 Pi 报告的任务模型容量、输出预留、system prompt、活动工具定义与当前 context usage；
- OpenViking 不可用、无有效 `ActiveContext`、容量不匹配、来源事实不可读或未达到高水位时只更新诊断，保持完整 Pi 上下文并不阻塞 Pi 主任务；
- `session_before_compact` 在 eligible ActiveContext 可读时提供 checkpoint 正文与其 hash、Archive 身份、raw-tail
  边界；不可用时不返回结果，让 Pi 使用原生 compaction；
- 不触发 Pi compaction，不构造 Archive。

### `shared/observe.mjs`

- 维护唯一 active stage registry、版本化记录与字段白名单；
- 未请求观察时提供固定 no-op，调用不读取时钟、不序列化、不散列也不分配操作号；
- 启用时将职责模块提供的既有安全值写入单个私有 JSONL sink；有界队列、schema 或 sink 失败只把观察状态转为
  `incomplete`；
- 不读取产品状态，不写 Pi JSONL、ACK 或 OpenViking，也不向任何业务路径提供决策输入。

### `shared/pi-session-source.mjs`

- 解析持久 Pi JSONL，校验 session header、entry ID 和 parent tree；
- 根据 leaf 恢复活动分支，同时返回完整 entry tree 和 parent map；
- 持久 session 快照保留是否已产生 assistant entry 的事实，用于识别 Pi 首次写入 JSONL 前的等待状态；
- 为非持久化 session 在同步触发时分别冻结完整 entry tree 与当前分支，保持触发时刻状态；
- 同步层处理完整 tree，Archive 只处理当前分支，活动分支不排除 sibling branch 的同步事实。

### `shared/recorded-event.mjs`

- 将 Pi entry/content part 投影为 `RecordedEventV1`；
- 保留 message envelope、原始 part、错误和终止状态，并从一个 entry 的完整有序事件重建原始 Pi entry；
- 生成 Pi event/turn/step identity，以及自产 request/failure/checkpoint event identity、parent 关系和内容 hash；
- 以独立常量维护事件 schema 与 identity 版本，普通依赖升级不改变协议身份；
- 不清洗、过滤、截断或解释 payload。

### `shared/canonical-json.mjs`

- 校验 JSON 值域；
- 生成 RFC 8785 规范 JSON 和 UTF-8 字节；
- 拒绝非有限数字、孤立 surrogate、稀疏数组、循环和非 JSON 类型。

### `shared/content-objects.mjs`

- 维护 OpenViking Content API 的请求限制、批次拆分与目录链准备；
- 严格核对 `batch-write` 响应形状，并返回按 created/updated/unchanged 分组的 URI；
- 把 409 区分为不可覆盖的字节冲突与可重试的路径占用；
- 不拥有任何收录规则：是否允许 `updated`、用哪种 precondition 由调用方决定。

### `shared/recorded-event-adapter.mjs`

- 将规范事件映射到绑定用户下的 dot-prefixed event files；
- 处理 direct 或 claim/chunks/commit 表示，并按 event ID 回读校验到规范字节；
- 独立维护存储身份、claim/commit schema 与路径版本；
- 以“任何 `updated` 都是既有事件被改写”表达事件命名空间的 append-only 约束；
- 将冲突、transport failure 和 capability mismatch 返回同步层。

adapter 不读取 Pi session、不持久化 ACK，也不决定 Archive 范围。

### `shared/context-weight.mjs`

- 维护"内容进入任务模型上下文的权重"这一条策略量，供 Archive 压力轴与 `ActiveContext` 容量判定共同使用；
- 不读取产品状态，也不决定任何边界。

### `shared/archive.mjs`

- 生成 `archiveId`、聚合 `contentHash` 与 manifest 规范字节；
- 从字节复原 manifest 并要求其自证（复算 `archiveId`、拒绝未知字段与非规范编码）；
- 按事件自身的上下文权重确定 Archive 边界，并把候选边界退回完整 Pi entry 与 step 之前；
- 从边界统一构造 manifest、tokenCount 与索引范围，供提交和分支候选链共同使用；
- 不接触传输，也不持久化任何状态。

### `shared/archive-store.mjs`

- 维护 Archive manifest 的存储位置与身份版本；
- 提交前逐项回读被引用事件并复算聚合 hash，作为 Archive 的接受证明；
- 以单个 manifest 对象为唯一提交点，按残留/已提交/冲突三种情形决定写入方式；
- 按 `archiveId` 确定性读取，并沿事件 `parentId` 链 materialize 与重新验证；
- 发布 Archive 提交状态；暂时性传输失败只保留待重试并禁止替换 checkpoint 消费范围，完整性冲突只排除对应 Archive；
- 失败不改变事件与 ACK。

### `shared/checkpoint.mjs`

- 维护 checkpoint、attempt task 及 request/failure/checkpoint 事件的版本化身份和严格解析；failure 只接受代码拥有的稳定分类、错误码与通用消息；
- 把 OpenViking Working Memory 正向投影为 narrative、completed、openItems、nextEntry 与 retrievalCues；
- 构造绑定来源 Archive、前一 checkpoint 与媒体摘要的 VLM 输入；嵌入图片正文只在临时媒体处理边界使用。

### `shared/checkpoint-processor.mjs`

- 使用 OpenViking 公开 Session/Task API 提交或恢复一次 VLM 处理，不接触 VLM 凭证；
- 将嵌入图片写入 attempt 专属临时 Resource；每个媒体获得非空 abstract 后才把摘要交给 checkpoint 输入，否则保持 pending；
- 只把 OpenViking task 的明确终态作为成功或失败；网络与进程中断保留 pending，供相同 task 恢复；
- 对终态 attempt 幂等删除所属 Session 与媒体根，并分别回读确认二者不存在；清理结果不成为产品事实。

### `shared/checkpoint-store.mjs`

- 按当前分支的已提交 Archive 顺序派生未消费范围、积压 Archive/token 与 caught-up/processing/lagging/failed 状态；
- 在 VLM 前追加 request，明确失败时追加 failure，成功时追加唯一 checkpoint；回读时验证 Archive、前一 checkpoint、连续 attempt、parent 与无 failure 的完整链，并在并发冲突时采用首个通过该校验的事实；
- 每个 Archive 最多执行三个确定性 attempt；每次协调调度从 request 事实与全部 Pi 分支可重算的 Archive 链发现一次失效 task，Archive 消费循环不重复穷举，后续只重试已发现的清理义务；
- 顺序驱动一个在途 Archive；当前分支范围变化时停止尚未开始的旧 checkpoint 写入，并清理其临时 task；
- 已进入追加事实写入的首写者可以完成，但当前状态只从新范围扫描并派生；
- 发布失败、落后与恢复通知；失败不改变 raw event、ACK 或 Archive。

### `shared/active-context.mjs`

- 从当前分支上最后一个已消费 checkpoint 选择 `ActiveContext`，并以最小两字段对象原子替换写入本地文件；
- 同步更新候选事实但保持当前两字段边界；来源边界离开当前分支时失效，高水位接管时只在新候选可渲染、eligible
  且持久化成功后原子推进；旧候选容量不匹配而更新 checkpoint 可用时，直接用更新候选重新判定以避免冻结在失配边界；
- 从 raw tail 起点的 `turnId` 重算原始用户指令 anchor，因而 anchor 不是持久化字段；
- materialize `system + checkpoint + anchor + raw tail` 四段候选 payload，段内直接引用不可变来源；checkpoint 正文
  受 `checkpointTokenBudget` 约束，其实际权重仍统一计入 payload；
- 用 Pi 报告的任务模型容量与输出预留计算 takeover eligibility，高水位配置不改变容量判定；
- 用 recorded-event 的逆投影重建原始 entry，并调用 Pi 的 `sessionEntryToContextMessages` 生成 provider messages；
  ActiveContext 不复制 Pi message 语义，事件不完整或事实不可读时返回空并保持完整 Pi 上下文；
- 从同一 ActiveContext 生成 Pi compaction summary、first-kept entry 与自证 details，不触发 compaction。

### `shared/task-model-context.mjs`

- 从 Pi lifecycle 读取模型容量、system prompt 和当前活动工具定义；
- system/tools API 任一缺失或抛错时显式返回 `factsAvailable=false`，空字符串不代表读取成功；
- 只向 lifecycle 协调层提供事实，不拥有 takeover 策略或状态。

### `shared/state-file.mjs`

- 维护本地最小状态文件的键派生与原子写入：私有目录/文件权限、同目录临时文件 rename、失败不留残件；
- 由 `SyncAck` 与 `ActiveContext` 共同消费；不拥有任何读路径语义——损坏内容如何处置属于各自模块。

### `shared/sync-ack.mjs`

- 保存最小 `acknowledgedLeaves`；
- 根据完整 parent map 判断祖先是否已确认；
- 在分支产生共同祖先或 sibling leaves 时保持最小 frontier；
- 维护 ACK 文件键的确定性身份版本；
- 原子替换 ACK 文件。

ACK 文件不包含 transcript 或事件 payload。丢失 ACK 只会触发幂等重放。

### `sync.ts`

`SyncManager` 是唯一协调者：

1. 获取持久 JSONL、等待 Pi 首次持久化，或读取进程内 branch；
2. 计算当前未确认 entry；
3. 投影该 entry 的全部事件；
4. 调用 Content adapter；
5. 只有全部事件确认后推进 entry ACK；
6. 分支不再延续上一 leaf 时，在 Archive I/O 前使旧 checkpoint scope 失效；
7. 以统一 descriptor 规划在当前分支已确认前缀上形成 Archive；暂时性传输失败不提交新的消费范围；
8. 把当前分支已提交 Archive 交给 checkpoint manager 异步消费，并提供全树 Archive 候选链恢复失效 request 清理；
9. 在同一轮同步内用当前分支事件、已提交 Archive 与 checkpoint 消费状态推进 `ActiveContext`，并在异步消费完成后再收敛一次；
10. 发布 source、capability、pending、Archive、checkpoint、活动上下文和 failure 状态。

`SyncManager` 自身只持久化 `SyncAck`，不持久化待发送事件副本；Archive 由来源事件重算。checkpoint manager
把 request/failure/checkpoint 写成现有 event namespace 内的追加事实，积压与通知状态均从这些事实和当前 Archive 重建，
没有第二份本地队列状态。
Archive 只取当前分支：跨 sibling branch 的范围没有对应的上下文。

### `shared/openviking-api.mjs`

- 唯一维护 OpenViking API 版本前缀；
- 只把职责模块提供的相对路径组合为版本化路径，不拥有 HTTP 方法、payload 或业务决策。

### `client.ts`

- 提供认证、account/user/peer header 和 loopback proxy 隔离；
- 提供 Content batch-write、raw download、stat、mkdir，以及 checkpoint 使用的 Session/Task transport；
- 不决定 event identity、ACK 或重放策略。

### `config.ts` 与 `shared/config-schema.mjs`

- `config-schema` 是扩展策略字段的运行时校验器；
- `config.ts` 合并包内默认值和用户覆盖，再解析外部服务凭证；
- `managedServer.proxy` 与扩展策略共享 JSONC 文件，但由服务管理模块消费；
- 未知字段和损坏 JSONC 不静默回退。

### `recall.ts` 与 `shared/recall-core.mjs`

- `RecallManager` 在 `before_agent_start` 收到用户 prompt 时排队检索，同一次 provider 请求的 `context` hook 等待结果并注入消息；
- 检索 body 只声明意图（coding purpose、session、预算上限），quota 配比、分层降级与跨轮去重留给服务端默认值；
- 会话内跨轮去重与查询扩展由服务端账本承担，扩展只在显式配置时覆盖；
- recall 失败不阻塞 prompt：注入被跳过，诊断进入 `/viking`。

### `shared/profile-inject.mjs`

- 在 `session_start` 从 `viking://user/<space>/memories/` 的 profile、preferences、entities 装配 `<user-profile>` 上下文块，供 `before_agent_start` 注入 system prompt；
- 读取失败时返回空块，不改变 provider 上下文。

### `tools.ts` 与 `lib/uri-guard-adapter.mjs`

- `tools.ts` 对每个输入只构造一次 canonical URI：保留 OpenViking path 字节，仅展开 current-user shorthand，归属判断与 transport 共用该值；所有模式都拒绝非法 URI；
- Resource API 不能绑定会话用户命名空间，因而隔离模式在请求前拒绝资源导入，非隔离模式按服务身份执行；
- `uri-guard-adapter` 在 `tool_call` hook 阻止通用文件与 shell 工具直接处理 `viking://` URI，并返回对应 `viking_*` 工具提示；
- session 隔离关闭时不施加跨用户命名空间边界；所有模式都禁止记忆删除工具修改用户空间中 adapter 独占的 `.pi-openviking` 内部事实。

### `shared/viking-status.mjs` 与 `shared/status-refresh.mjs`

- `viking-status` 维护 `/viking` 命令与页脚的只读诊断视图；
- `status-refresh` 只拥有 status 刷新的并发与生命周期，状态数据归调用方。
## 数据流

```text
Pi JSONL / in-memory branch
        │
        ▼
pi-session-source
        │ complete entry tree + parent map
        ▼
recorded-event
        │ canonical RecordedEventV1
        ▼
recorded-event-adapter ───► content-objects ───► OpenViking Content API
        │ accepted event IDs
        ▼
sync-ack
        │ acknowledged entry leaves
        ▼
archive ──► archive-store ───► content-objects ───► OpenViking Content API
        │ committed archive descriptors
        ▼
checkpoint-store ───► checkpoint-processor ───► OpenViking Session/Task API
        │                    │ embedded image semantic processing
        │                    └──────────────────► temporary Content Resource
        │ request / failure / checkpoint RecordedEventV1
        ▼
recorded-event-adapter ────────────────────────► OpenViking Content API
        │ derived checkpoint/backlog state
        ▼
active-context ──► ~/.pi/openviking/active-context/<target-and-session>.json
        │ checkpoint + raw-tail 边界、候选 payload、takeover eligibility 与 provider messages 渲染
        ▼
context hook ──► 首次完整上下文越过高水位时建立 epoch；随后复用 ActiveContext，下一高水位或失配候选的更新 checkpoint 才推进
        │
        └──────► session_before_compact：提供自包含 checkpoint；不可用时由 Pi 原生 compaction 继续
        ▲
        │
user prompt
        │
        ▼
before_agent_start: profile-inject（system prompt）+ recall.queueSearch
        │
        ▼
recall-core ───► OpenViking search API
        │ recall block（失败时为空，不阻塞 prompt）
        └────────► context hook: recall.injectRecall（作用于接管或完整上下文的最终 messages）
```
观察链与上述产品链正交：各责任模块在实际 boundary、decision、state 或 failure 处调用固定 no-op/observer，统一写入
私有 JSONL；该 JSONL 没有返回产品链的依赖边。

## 失败语义

失败、冲突、重放和可用性边界由 [`docs/spec.md`](./spec.md) 的“准确性与可用性边界”统一定义；
当前实现不建立第二份规则。

## 验证

验证证据分类、live gate 契约与阶段出口由 [`docs/verification.md`](./verification.md)
统一定义；开发环境的安装、运行和清理见 [`docs/development.md`](./development.md)。
当前 deterministic 自动化入口为：

- `test/recorded-event.test.mjs`：规范字节、投影、身份和合成 100k+ golden 基线；
- `test/generated-session-invariants.test.mjs`：版本化 seed、源 entry 重建、树/上下文/ACK 不变量和长工具循环；
- `test/pi-session-runtime.test.mjs`：真实 Pi `SessionManager` 的持久 JSONL、分支、重启和投影；
- `test/session-source-ack.test.mjs`：JSONL golden 分支恢复和树形 ACK；
- `test/content-objects.test.mjs`：协议限制、批次拆分、目录链与 409 分类；
- `test/recorded-event-adapter.test.mjs`：127/128/129 项、8/16 MiB、冲突和 chunk/commit 边界；
- `test/archive.test.mjs`：Archive 身份、manifest 自证、边界选择、提交/恢复/冲突与 expand；
- `test/checkpoint.test.mjs`、`test/checkpoint-processor.test.mjs`：checkpoint 身份/事实链、结构化投影、并发首写、三次重试、恢复清理、媒体失败与 Session/Task 边界；
- `test/active-context.test.mjs`：活动上下文身份与持久化、候选选择、分支复用与失效、anchor 重算、dry-run payload 与容量判定两侧；
- `test/budget-live-verifier.test.mjs`：发布默认预算、三类 100k+ workload 的三次重复、manifest/hash 与 live 入口；
- `test/client-content.test.mjs`：HTTP transport；
- `test/openviking-api.test.mjs`：版本前缀与相对路径组合；
- `test/sync-manager.test.mjs`：重启、ACK 丢失、分支和 fail-open；
- `test/config-schema.test.mjs`：唯一配置 schema；
- `test/package-metadata.test.mjs`：manifest/lock 一致与 peer 最低兼容基线；
- `test/observe.test.mjs`：registry、记录 schema、关闭零工作、sink 失败和字节一致性；
- `test/observability-integration.test.mjs`：职责模块接点、脱敏及 fail-open 产品等价性；
- `test/observation-evidence.test.mjs`、`test/observability-live-verifier.test.mjs`：完整 run 与 manifest 契约；
- `test/viking-status.test.mjs`：运行诊断。

真实边界由各 live gate 覆盖，各 gate 的断言范围见
[`docs/verification.md`](./verification.md)。sync、archive、checkpoint、context、takeover、budget 与 observability gate 共用
`test/live/live-support.mjs` 的身份核对、ownership、清理与 summary 骨架；Pi 驱动由需要 lifecycle 的 gate 使用，
observability gate 的 Pi 观察采集经骨架的 capture 选项接入，checkpoint gate 直接为 Archive/VLM 边界建立同一 schema 的完整 run；
tool-uri-rejection 的 guard 触发由 `test/live/scripted-provider.mjs` 的确定性脚本 provider 承担。
