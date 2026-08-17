# OpenViking 上下文管理规范

## 文档职责

本文档是 OpenViking 上下文管理的权威实施规范，定义产品职责、目标架构、配置、实施顺序和
验收标准。实施进展只更新“实施状态”和“下一实施入口”，其余章节始终描述目标系统。

## 产品定位

扩展是一个追加式观察器和上下文管理器：

1. 记录实际发生的事件；
2. 将持久事件范围归入 Archive；
3. 使用 VLM 形成对 Archive 有用的理解；
4. 在必要时用 VLM checkpoint 替换任务模型中已归档的 raw 上下文；
5. 保留完整 Pi 原始历史，使所有理解都可以追溯和检查。

扩展不裁决记录中的陈述是否真实，也不根据生成的理解改写历史。

## 系统设计

### 1. 完整记录事件

记录所有实际发生的事件：

- user 和 assistant 消息；
- tool call 和 tool result，包括真实错误状态；
- OpenViking recall、overview 的读取或注入；
- VLM 归档输出；
- Pi compaction 和 OpenViking 上下文接管事件。

Pi 来源事件的稳定身份由 Pi session ID、entry ID、part 类型和 part 索引组成，`parentId`
表达事件关系，内容 hash 执行完整性校验。扩展和 OpenViking 自产事件采用来源系统已经持久化
的稳定 ID。相同 event ID 的重复传输保持幂等；相同内容在不同时间产生时仍形成不同事件。
原始事件采用 append-only 持久化，并使用以下版本化契约：

```ts
interface RecordedEventBaseV1 {
  schemaVersion: 1;
  eventId: string;
  parentId: string | null;
  contentHash: string;
  occurredAt: string;
  turnId?: string;
  stepId?: string;
  payload: unknown;
}

interface PiRecordedEventV1 extends RecordedEventBaseV1 {
  source: {
    system: "pi";
    sessionId: string;
    entryId: string;
    parentEntryId: string | null;
    entryType: string;
    partType: string;
    partIndex: number;
  };
}

interface ProducedRecordedEventV1 extends RecordedEventBaseV1 {
  source: {
    system: "pi-openviking" | "openviking";
    sourceId: string;
    sourceType: string;
  };
}

type RecordedEventV1 = PiRecordedEventV1 | ProducedRecordedEventV1;
```

规范字节采用 RFC 8785 canonical JSON 的 UTF-8 编码。Pi 事件身份的唯一输入是规范数组
`["pi-openviking/recorded-event", 1, "pi", sessionId, entryId, partType, partIndex]`；自产事件
使用 `["pi-openviking/recorded-event", 1, system, sourceId, sourceType]`。`eventId` 为 `evt_` 加
对应数组规范字节的 SHA-256 小写十六进制。`contentHash` 为 `sha256:<hex>`，其中 `<hex>` 是
完整 payload 规范字节的 SHA-256。内容不参与事件身份；相同 event ID 的不同完整事件规范字节
是完整性冲突。

同一 entry 的 part 按索引连接，首个 part 连接父 entry 的最后一个事件；没有 message/part 的 entry
投影为 `partType="opaque"`、`partIndex=0` 的事件。assistant entry 建立 step，后续对应 tool result
沿用该 step。上述关系只表达来源和执行边界，不改写 Pi 的 `id/parentId` 事实。

### 2. 可靠增量同步

持久化 Pi session 的 append-only JSONL 是 Pi 来源事件及其 payload 的唯一事实源；同步层只
持久化最小 `SyncAck`。OpenViking 确认接受事件后推进 ACK frontier，发送失败时保持原
frontier。ACK 状态丢失时从 Pi JSONL 幂等重放。

OpenViking `0.4.13` 的公开 Content API 是 OpenViking `RecordedEvent` 投影的物理持久化边界。扩展
通过 `POST /api/v1/content/batch-write` 在 OpenViking VikingFS 内实现事件兼容层，不修改
OpenViking 核心，也不建立第二套物理长期 event store。事件命名空间属于绑定用户的 Resource：

```text
viking://user/{user}/resources/.pi-openviking/recorded-events/v1/
└── {sha256(sessionId)}/
    └── {eventId digest 前四位}/
        └── .{eventId}.json
```

目录由 adapter 幂等创建。命名空间根和原始事件对象使用隐藏名称；普通目录视图不暴露它们，OpenViking
语义处理也不直接索引隐藏事件文件。该命名空间由 adapter 独占，其他扩展功能不得使用 replace、
append、WebDAV PUT 或删除操作修改已创建的事件对象。

不超过 8 MiB 的事件将完整 `RecordedEventV1` 规范字节作为一个对象，以
`create_if_absent` 和 `wait=false` 写入。单次请求最多 128 个对象、单文件最多 8 MiB、总内容
最多 16 MiB，并按共同父目录分组。只有响应中每个目标 URI 都明确出现在 `created` 或
`unchanged` 时才确认对应事件；语义队列状态不构成事件 ACK。相同 URI 的不同字节返回
`409 CONFLICT`，作为完整性错误停止该事件的 ACK 推进并通过 raw download 诊断。请求失败、响应丢失
或底层 I/O 部分落盘时不推进 ACK，随后整组重放；已落盘的相同字节在重放时返回 `unchanged`。

超过 8 MiB 的事件采用同一分片目录内的以下隐藏对象：

```text
.{eventId}.claim.json
.{eventId}.chunk-{六位十进制索引}.bin
.{eventId}.commit.json
```

claim 首先固定 event ID、完整事件规范字节 hash、总长度，以及按顺序排列的 4 MiB chunk URI、
长度和 SHA-256；claim 自身也采用规范 JSON。chunks 分批使用 `create_if_absent` 写入，每批继续
满足 128 项和 16 MiB 限制。adapter 回读并验证全部 chunks、重组长度和完整 hash 后，最后创建
只包含 schema version、event ID 和 claim hash 的规范 commit marker。claim、chunk 或 marker
冲突都是完整性错误；没有有效 commit marker 的大事件不属于已接受事件，不能推进 ACK 或进入
Archive。同一 event ID 只能具有 direct 或 chunked 一种表示；两种表示同时存在是完整性冲突。

ACK frontier 是已确认叶节点的最小前沿集合：

```ts
interface SyncAck {
  acknowledgedLeaves: string[];
}
```
`acknowledgedLeaves` 保存 Pi entry ID；只有一个 entry 的全部投影事件都被接受后，该 entry 才能
进入 frontier。

任一前沿叶节点的祖先都视为已确认；一个已确认叶节点成为另一个的祖先时从集合移除。
切换分支后从最近的已确认祖先继续发送；无法确认的事件使用稳定 event ID 幂等重放。

分支恢复完全由 Pi entry 的 `id/parentId` 树确定当前分支及共同祖先。同步覆盖进程重启、
等长分支切换、较短分支和从已同步祖先产生的新分支，每个源事件都有可追踪的确认结果。

未持久化的 Pi session 在进程存活期间提供 best-effort 同步。新消息形式以不透明 payload
保留；tool call/result 保留 Pi 身份和真实的完成、错误状态。

### 3. Archive 是一个原子对象

Archive 由事件及其 manifest 共同组成：

```ts
interface Archive {
  manifest: {
    archiveId: string;
    firstEventId: string;
    lastEventId: string;
    eventCount: number;
    contentHash: string;
  };
  events: RecordedEventV1[];
}
```

Archive 的 manifest 定义收录范围。物理表示引用已经由 OpenViking 确认的 immutable event URI
及其 hash；确定性读取时 materialize 为上述 `events`。归档 adapter 先验证全部事件，再以
`create_if_absent` 写入 immutable manifest，最后创建绑定 manifest hash 和事件范围的 Archive
commit marker。只有具有有效 commit marker 且所有引用均可回读验证的 Archive 才存在；崩溃留下
的 manifest 或其他未提交对象不可进入 VLM 处理和上下文接管。相同 `archiveId` 重放保持幂等，
同 ID 不同字节是完整性冲突。

Archive 创建由 token/step 压力驱动，支持单个超长用户轮次，并保持
assistant/tool call/result step 边界完整。首次 Archive 的目标压力为
`archive.rawTailTokenBudget + archive.chunkTokenBudget`，之后每累计一个
`archive.chunkTokenBudget` 形成下一 Archive，同时保留 `archive.rawTailTokenBudget`。

### 4. Checkpoint 生成与消费状态

raw Archive 持久化后，异步 VLM 任务读取当前 Archive、多模态输入、外置工具结果和之前的
working checkpoint，并为该 Archive 生成一个结构化 checkpoint 事件：

```ts
interface Checkpoint {
  checkpointId: string;
  sourceArchiveId: string;
  sourceArchiveHash: string;
  narrative: string;
  completed: string[];
  openItems: string[];
  nextEntry?: string;
  retrievalCues: string[];
  model: string;
  promptVersion: string;
}
```

narrative、已完成工作、未解决问题、下一执行入口和 retrieval cues 共同组成一个
checkpoint。checkpoint 作为新事件追加，来源 Archive 和之前的 checkpoint 始终保持不可变。
VLM 失败由后台异步重试，raw Archive 的持久状态保持有效。

VLM 运行事实由 Archive manifest、request、checkpoint 和失败事件共同表达。request 记录
`taskId`、`archiveId` 和提交时间；checkpoint 表示消费完成；task 明确失败时追加原始错误。
持久化且来源 Archive 身份和 hash 匹配的 checkpoint 表示对应 Archive 已消费。

VLM 消费状态由上述事实派生。最新 checkpoint 之后没有 Archive 时表示已经赶上；只有
一个 Archive 时表示正常处理中；已有两个或更多 Archive 时表示消费落后。积压 token 是
未消费 Archive manifest 的 token 总和。

通知状态在运行时从消费事实派生：进入消费落后时通知一次，恢复到至多一个在途 Archive
时通知一次，task 明确失败时立即通知。进程重启后仍存在的状态可以再次提示。`/viking`
展示已赶上、正在处理、消费落后或失败及积压 Archive/token；footer 只显示 OpenViking
连接状态。上下文高水位时的 checkpoint 可用性由 takeover 处理。

VLM 验收以 checkpoint 的持久状态、来源 Archive 身份和 hash 为准。

### 5. 归档与上下文接管分离

后台归档期间，任务模型保持当前上下文；任务模型上下文达到独立高水位时执行 OpenViking
上下文接管。

接管时，`context` hook 将 provider 可见上下文从：

```text
system + 已归档的 raw 前缀 + 最近 raw tail
```

切换为：

```text
system + active VLM checkpoint + 原始用户指令 anchor + 最近 raw tail
```

持久化 Pi session 的 JSONL 始终保持完整。checkpoint 标明其 Archive 输入，raw-tail 边界
保持完整 tool call/result step。有效 `ActiveContext` 就绪后执行接管；首次接管就绪前继续使用
完整 Pi 上下文。Pi 自身触发压缩时按“与 Pi compaction 协作”执行。

### 6. 活动上下文与 prompt cache 稳定性

checkpoint 接管会建立新的任务模型 token 前缀和 provider cache epoch；接管后的第一次请求
填充新前缀缓存，后续请求复用稳定前缀。

活动上下文持久化当前选定的 checkpoint 和 raw-tail 起点：

```ts
interface ActiveContext {
  checkpointId: string;
  rawTailStartEventId: string;
}
```

`ActiveContext` 在下一次上下文高水位到达前保持固定，新产生的 assistant/tool 事件追加在该
稳定前缀之后。下一次接管原子替换 checkpoint 和 raw-tail 起点。cache epoch 是
`ActiveContext` 稳定期间的运行时视图。

因此，Archive 频率和接管频率相互独立：后台可以频繁归档，但 provider 上下文替换应有意
保持低频。

### 7. 与 Pi compaction 协作

OpenViking takeover 负责正常的上下文增长，Pi compaction 负责运行时 fail-open。Pi 独立决定
何时触发 compaction：有效 `ActiveContext` 已就绪时，compaction entry 内嵌 checkpoint 正文、
checkpoint hash、Archive 身份和 raw-tail 边界；`ActiveContext` 不可用时，Pi 执行原生
split-turn compaction。扩展通过生命周期钩子提供可用上下文，不主动调用 compaction，也不
中止正在运行的 agent。

### 8. 检索与恢复

隐藏 raw event 对象是检索派生物的数据源，但不直接进入普通 Resource 的语义刷新。Phase 4 从
已确认 raw events 和 checkpoint 建立独立派生索引，标明原始记录或 VLM 理解、时间、模型、
event ID、内容 hash 和来源 URI；删除索引不影响权威事件，并可从事件对象重建。Archive manifest
提供范围过滤、browse、expand 和完整性校验。每个搜索结果都能按来源 URI 展开到原始事件。

当前任务按 `checkpointId` 确定性装载续接 checkpoint；语义搜索负责发现相关历史。任务模型
判断记录的含义、范围和适用性。checkpoint 链表达跨 Archive 的长期理解。

## 最小权威状态

长期状态由五类具有当前消费者的对象组成：

1. Pi `SessionEntry` 及其 OpenViking `RecordedEvent` 投影，表示原始事实；
2. `SyncAck`，表示 OpenViking 已接受的最小 entry 前沿集合；
3. `Archive`，原子绑定 manifest 和事件范围；
4. `Checkpoint`，表示有来源的 VLM 理解；
5. `ActiveContext`，表示任务模型当前使用的 checkpoint 和 raw-tail 起点。

VLM request 和明确失败是追加式 `RecordedEvent`。summary、索引、通知和运行状态均从上述
权威对象派生。

## 目标配置

用户配置表达可安全选择的产品策略；事件身份、ACK 推进、Archive 完整性、step 原子性和
`ActiveContext` 冻结由系统保证。扩展接受以下配置：

```jsonc
{
  "enabled": true,
  "syncTurns": true,

  "archive": {
    "chunkTokenBudget": 20000,
    "rawTailTokenBudget": 30000
  },

  "takeover": {
    "enabled": true,
    "contextTokenThreshold": 0,
    "checkpointTokenBudget": 16000
  },

  "recallTokenBudget": 2000,
  "recallMaxContentChars": 500,
  "recallPreferAbstract": true,
  "recallLimit": 10,
  "recallQueryExpansion": "auto",
  "scoreThreshold": 0.35,
  "minQueryLength": 3,
  "profileTokenBudget": 10000,

  "sessionScopedMemory": true,
  "workspacePeer": true,
  "recallPeerScope": "all",
  "bypassPatterns": [],
  "logLevel": "error"
}
```

其中：

- `archive.chunkTokenBudget` 控制每次 Archive 的目标增量；
- `archive.rawTailTokenBudget` 控制 Archive 后保留的最近原始上下文预算；
- `takeover.contextTokenThreshold` 是任务模型上下文高水位，`0` 表示按当前模型容量自动确定；
- `takeover.checkpointTokenBudget` 控制接管时装载的 VLM checkpoint 上限；
- `takeover.enabled` 控制任务模型上下文替换，事件记录和 Archive 独立持续运行。

Archive 与 takeover 预算是 Phase 3 的候选值。预算根据 Archive step 边界、raw-tail 完整性和
接管后上下文大小验证；VLM 消费能力通过候选模型选型解决。

`contextTokenThreshold=0` 使用“任务模型上下文容量减去 system、工具、provider 安全余量、
checkpoint 和 raw tail”计算高水位。高水位必须为正且能够容纳目标上下文；容量不匹配时
保持 takeover inactive，并由 `/viking` 报告。解决方式是选择更大上下文窗口的任务模型，
或调整候选预算并重新通过 Phase 3 验证。可外置的大型 payload 使用完整存储和可追溯引用；
非外置原子输入的支持上限由任务模型剩余容量决定，超出时需要更大模型或更小的源输入。
Pi compaction 仍由 Pi 的运行时条件触发。

上述对象是扩展配置的完整 schema。配置加载器对未知字段返回包含字段路径的校验错误；开发
环境从当前模板生成 `~/.pi/pi-openviking.jsonc`。OpenViking 服务地址、凭证和
`managedServer.proxy` 属于服务连接配置，与扩展的事件、Archive 和上下文策略分离。事件 URI、
规范编码、分片、precondition 和 ACK 规则是系统完整性约束，不提供用户可变配置。

受管服务固定使用具备 Content API batch-write、raw read/download、user Resource mkdir，以及
隐藏文件不进入普通语义处理等已验收行为的 OpenViking `0.4.13`。远端服务只有通过相同 capability
和行为探测才视为兼容；能力缺失时保持事件待重放和 Pi 主任务 fail-open，并由 `/viking` 报告
adapter capability mismatch。

## 准确性与可用性边界

严格校验范围是机械完整性：

- 持久化 Pi JSONL 中的每个源事件具有已确认或待重放状态；
- 小事件只有在确定性 URI 返回 `created`/`unchanged`，大事件只有在全部 chunks 验证且 commit
  marker 创建后，才属于 OpenViking 已接受事件；
- ACK frontier 只在 OpenViking 确认接受后推进，queue status、请求已发送或本地 pending payload
  均不构成 ACK；
- Archive 只有在 immutable events、manifest 和 final commit marker 相互验证后才原子可见；
- Archive 的事件身份、顺序和 hash 可复现；
- 上下文接管包含完整 raw tail 和所有待归档事件；
- 持久化 Pi session 支持崩溃恢复，未持久化 session 提供进程内 best-effort 同步。

VLM 理解、recall 排序和 provider KV cache 按 best-effort 工作；事件记录、raw Archive 和
coding agent 主任务在这些能力降级时保持可用。

运行状态依次推进：

```text
recorded -> archived -> VLM-enriched -> active-for-takeover
```

每个已经持久化的状态独立成立，后续阶段的结果不改变之前的状态。

## 实施状态

当前执行 Phase 0A；阶段出口是完整事件投影、稳定 event identity 和可重复 100k+ token 长轨迹
通过聚焦测试。

## 实施顺序

各阶段复用同一条可重复的 100k+ token 长轨迹。Phase 0 建立确定性回放基线，Phase 1–2 验证
对应持久状态，Phase 3 在真实 provider 和 VLM 环境中完成最终端到端校准。每个状态在所属阶段
同时提供确定性读取、运行诊断和独立验收；下一阶段消费已经通过验收的状态。

每个实施步骤按对应验收项先运行聚焦测试；步骤完成时运行完整 `npm test` 和 `git diff --check`。

### Phase 0：完整记录与最小可靠同步

#### Phase 0A：事件投影与身份

- 实现“目标配置”定义的唯一配置 schema 和未知字段校验；
- 完整捕获不透明或大型 payload，并保留 tool result 的真实完成和错误状态；
- 固定 user、assistant、tool call/result 和未知 part 的 `RecordedEvent` 投影及 step 边界；
- 用 RFC 8785 规范字节固定 event identity、content hash 和完整事件字节；
- 建立覆盖长工具循环、分支替换和进程重启的可重复 100k+ token 轨迹，逐事件校验投影和身份。

**验收**：

- 配置模板与“目标配置”schema 一致，未知字段返回包含字段路径的校验错误；
- 长轨迹逐事件保留 payload、part 类型与索引、step 边界以及 tool result 的真实完成和错误状态；
- 同一源事件重复投影得到相同 event ID、规范字节和 content hash，相同内容的不同事件得到不同
  event ID；event/parent/source/part/turn/step 字段与 Pi JSONL 可逐项重算。

#### Phase 0B：确认前沿与重放

- 以持久 Pi JSONL 提供待同步事件，并根据 `id/parentId` 树恢复当前分支和共同祖先；
- 实现 OpenViking Content API adapter：探测 capability、幂等建立绑定用户的隐藏 Resource、
  按确定性 URI/共同父目录/服务限制组织 `batch-write`，并严格核对每个响应 URI；
- 小事件使用 immutable 单对象，大事件使用 claim/chunks/commit marker，在服务存储容量内完整
  保留 payload；
- 使用稳定 event ID 处理 ACK/响应丢失、部分落盘和重放，将 `409 CONFLICT` 作为不可覆盖的
  完整性错误；
- 仅在一个 Pi entry 的全部事件被 OpenViking 接受后，以最小 `SyncAck` 增量更新 ACK frontier；
- 删除 add-message payload pending store；待同步内容始终从 Pi JSONL 重建；
- `/viking` 提供连接、adapter capability、ACK frontier、待重放和同步失败状态，使 ACK 推进和
  fail-open 可直接观察。

**验收**：

- 在受支持 OpenViking 实例上验证首次写入为 `created`、同字节重放为 `unchanged`、不同字节为
  `409 CONFLICT`、raw download byte-exact，且隐藏事件不进入普通目录视图或普通 Resource 语义索引；
- 持久 Pi JSONL 中的每个源事件都有确认结果，entry 仅在全部投影事件确认后推进 ACK frontier；
- ACK 丢失、响应丢失、同批部分落盘、等长分支替换、较短分支、从已同步祖先创建分支和进程
  重启后，每个事件均得到确认；
- 相同 event ID 的重试保持幂等，同 ID 不同规范字节停止 ACK 并给出完整性诊断；
- 超过 8 MiB 的事件跨多个请求重放后，只能在 chunks 完整、hash 一致和 commit marker 有效时
  确认；
- 持久同步状态仅包含最小 `SyncAck`，非持久化 Pi session 提供进程内 best-effort 同步；
- OpenViking 不可用或 capability 不匹配时，未确认事件保持待重放，Pi 主任务保持可用。

### Phase 1：原子 Archive 与可行性预检

- 从已经确认的 immutable event 对象选择完整 event/step 范围，生成确定性 `archiveId`；
- 回读事件并重算 event identity、顺序和内容 hash，manifest 记录 event/step 边界、数量和聚合
  hash；
- 通过同一 Content API adapter 写入 immutable manifest，并在全部引用验证后最后创建 Archive
  commit marker；未提交对象不构成 Archive；
- 提供按 `archiveId` 的确定性读取和 expand，按 manifest materialize 事件并重新验证全部 hash；
- 根据单个用户轮次内的 token/step 压力生成有效 Archive；
- 跨重启恢复未完成的 Archive，复用相同 `archiveId` 幂等补齐 manifest 或 commit marker；
- 用 Phase 0 长轨迹验证 Archive 边界、单个超长用户轮次、step 原子性和重启恢复；
- 用真实 Archive 样本测量候选 VLM 吞吐以及 checkpoint、raw tail 与任务模型容量的 fit；
- `/viking` 展示 Archive 身份、提交状态、处理状态和边界诊断。

**验收**：

- 只有 final commit marker、manifest hash、event/step 边界、数量和引用事件全部一致时 Archive
  才可见；
- 响应丢失、部分落盘和进程重启后复用相同 `archiveId`，不会产生重复或半可见 Archive；
- 按 `archiveId` 回读和 expand 得到确定且完整的源事件序列；
- tool call/result 在 Archive 边界保持原子，单个用户轮次内的 token/step 压力能够生成有效
  Archive；
- 真实 Archive 样本证明至少一个候选 VLM 满足吞吐要求，且候选 checkpoint 与 raw tail 能装入
  任务模型；
- VLM 预检失败时，事件记录和 raw Archive 保持可用。

### Phase 2：单一 checkpoint 与上下文接管

#### Phase 2A：checkpoint 生产

- 每个 Archive 异步生成一个统一的结构化 checkpoint；
- checkpoint 保存模型版本、prompt 版本、输入 Archive 身份和 hash；
- 以 request、checkpoint 和失败事件表达 VLM 运行事实；
- 从未消费 Archive 派生处理中、落后、恢复和积压 token，并实现对应通知；
- `/viking` 展示 VLM 积压、失败、checkpoint ID 和来源 Archive；
- 校验 checkpoint 身份、hash、重试和跨重启恢复，并将有效 checkpoint 作为 Phase 2B 输入。

**验收**：

- 持久化且来源 Archive 身份和 hash 匹配的 checkpoint 表示该 Archive 消费完成；
- 同一 Archive 的重试和进程重启恢复至多产生一个有效 checkpoint；
- 一个未消费 Archive 显示处理中，第二个产生时通知消费落后，恢复到至多一个在途 Archive 时
  通知一次；
- Archive、request、checkpoint 和失败事件能够完整派生 VLM 状态、失败原因及积压 token；
- VLM 失败不改变已经持久化的事件和 raw Archive。

#### Phase 2B：活动上下文构造

- 选择已确认 checkpoint 和原子的 raw-tail 边界，形成并持久化最小 `ActiveContext`；
- 跨重启恢复 `ActiveContext`，分支变化时只复用来源边界仍在当前祖先链上的上下文；
- dry-run 捕获目标 provider payload，对照原始事件验证 checkpoint、原始用户指令 anchor、raw
  tail 和 tool call/result step 完整性；
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
- 用同一长轨迹验证接管、分支变化、进程重启和 Pi compaction 后的 provider payload。

**验收**：

- 每次上下文高水位原子替换一次 `ActiveContext`，并保持到下一次上下文高水位；
- provider 实际 payload 与 Phase 2B 验证的构造一致，后续事件追加在稳定前缀之后；
- 无有效 `ActiveContext`、OpenViking/VLM 降级或容量不匹配时，provider 使用完整 Pi 上下文；
- 单个用户指令后的长工具循环能够安全归档和接管；
- Pi 是 compaction 的唯一触发方；`ActiveContext` 不可用时执行原生 split-turn compaction，扩展
  仅返回生命周期钩子结果并保持运行中的 agent 可用。

### Phase 3：端到端预算校准与模型定型

- 在 Phase 0–2 的逐阶段验证通过后，在真实 provider 和 VLM 环境中回放同一条 100k+ token
  长轨迹；
- 对照原始事件检查 Archive 边界、raw tail、checkpoint 和接管上下文；
- 使用 Pi 报告的任务模型容量验证高水位公式两侧的 fit 与 capacity mismatch 行为；
- 根据 step 原子性、raw-tail 完整性和上下文容量调整候选预算并重跑；
- 确认所选 VLM 能在下一个 Archive 产生前完成前一个 checkpoint；
- 预算和 VLM 通过端到端验证后确认为出厂默认值，容量边界确认为 takeover eligibility 规则。

**验收**：

- 真实 100k+ token 轨迹中的 Archive、raw tail、checkpoint 和 provider payload 与源事件逐项对应，
  没有遗漏、重复或破坏 step 原子性；
- 候选 Archive、checkpoint 和 raw-tail 预算满足完整性及任务模型安全余量；
- 所选 VLM 能在下一个 Archive 产生前完成前一个 checkpoint；
- 任务模型容量在 eligibility 边界两侧分别得到 active 和 capacity mismatch 结果；
- 通过上述验收的预算、VLM 和 eligibility 规则写入出厂配置。

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

Phase 0A 的下一实施入口是 `lib/capture-adapter.mjs` 和 `shared/capture-utils.mjs`：实现
`RecordedEventV1` 完整投影、RFC 8785 规范字节、event/content hash、part/step/parent 边界，并以
可重复长轨迹逐事件验证。
