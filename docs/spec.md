# OpenViking 上下文管理规范

## 文档职责

**架构定位**：目标系统的唯一权威规范。

**核心目标**：任何人或代理据此判断“系统应当是什么样”——产品职责、目标机制、协议、状态模型、
配置语义和质量边界。

**职责边界**：本文只描述目标系统，全文不含进度、阶段划分和下一步。实施路径与当前位置由
[`docs/roadmap.md`](./roadmap.md) 维护；证据标准由 [`docs/verification.md`](./verification.md) 维护；
当前代码的实际结构由 [`docs/design.md`](./design.md) 维护。本文变更只应由架构或产品目标的决定触发。

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
- OpenViking recall、profile、overview 的读取或注入；
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
  payload: JsonValue;
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
    system: "pi-openviking";
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

Pi message/custom-message 的 string 或数组 content 按原索引投影。payload 保存删除该 content 字段后的
完整 entry envelope，并以 `{ container, form, count, value }` 保存原始 part；tool result 的 part 类型
固定为 `toolResult`，其 message envelope 原样保留 `isError`、details 和状态。没有可分 part 的 entry
使用 `partType="opaque"`、`partIndex=0`，payload 保存完整 entry。`occurredAt` 原样使用 Pi JSONL
entry timestamp，不在投影时生成时间。

同一 entry 的 part 按索引连接，首个 part 连接父 entry 的最后一个事件。user entry 建立
`turn_<sha256(["pi-openviking/turn", 1, sessionId, entryId])>`；其后的当前分支事件沿用该 turn。
assistant entry 建立 `step_<sha256(["pi-openviking/step", 1, sessionId, entryId])>`，后续并行或顺序
tool results 沿用最近 assistant step，下一 assistant entry 开始新 step。上述关系只表达来源和执行
边界，不改写 Pi 的 `id/parentId` 事实。

### 2. 可靠增量同步

持久化 Pi session 的 append-only JSONL 是 Pi 来源事件及其 payload 的唯一事实源；同步层只
持久化最小 `SyncAck`。OpenViking 确认接受事件后推进 ACK frontier，发送失败时保持原
frontier。ACK 状态丢失时从 Pi JSONL 幂等重放。

OpenViking `0.4.15` 的公开 Content API 是 OpenViking `RecordedEvent` 投影的物理持久化边界。扩展
通过 `POST /api/v1/content/batch-write` 在 OpenViking VikingFS 内实现事件兼容层，不修改
OpenViking 核心，也不建立第二套物理长期 event store。`sessionScopedMemory=true` 时，存储用户是
`sanitize(configuredUser || "default") + "--pi-" + sanitize(sessionId)`；否则使用配置用户或服务解析的
当前用户。`sessionKey` 是规范数组
`["pi-openviking/recorded-event-storage", 1, "session", sessionId]` 的 SHA-256 小写十六进制。
事件命名空间为：

```text
viking://user/{storageUser}/resources/.pi-openviking/recorded-events/v1/
└── {sessionKey}/
    └── {eventId 中 evt_ 后 digest 的前两位}/
        └── .{eventId}.json
```

`sanitize` 将不属于 `[A-Za-z0-9._-]` 的每个字符替换为 `-`。两位十六进制形成固定 256 个逻辑
shards，避免目录数随事件数线性增长；目录由 adapter 按需幂等创建。
原始事件文件使用隐藏名称；OpenViking 0.4.15 的普通 `ls` 会过滤 dot files，但仍可能展示 dot
directories，因此 `.pi-openviking` 目录可见不构成事件泄露。语义 DAG 同样过滤 dot file names，
不直接索引 raw event。该命名空间由 adapter 独占，其他功能不得对事件对象执行 replace、append、
WebDAV PUT 或删除。append-only 是 adapter 所有权约束而非
OpenViking ACL；具有相同凭证的外部写入不在信任边界内，回读或重放发现字节变化时按完整性冲突处理。

不超过 8 MiB 的事件将完整 `RecordedEventV1` 规范字节作为一个对象，以
`create_if_absent` 和 `wait=false` 写入。每个 request 的 `root_uri` 是 session root，operation URI
位于已创建的 shard 子目录；adapter 按最多 128 个对象和最多 16 MiB 内容拆分请求，单文件不超过
8 MiB。只有响应中每个目标 URI 都明确出现在 `created` 或
`unchanged` 时才确认对应事件；语义队列状态不构成事件 ACK。相同 URI 的不同字节返回
`409 CONFLICT`，作为完整性错误停止该事件的 ACK 推进并通过 raw download 诊断。请求失败、响应丢失
或底层 I/O 部分落盘时不推进 ACK，随后整组重放；已落盘的相同字节在重放时返回 `unchanged`。

超过 8 MiB 的事件采用同一分片目录内的以下隐藏对象：

```text
.{eventId}.claim.json
.{eventId}.chunk-{六位十进制索引}.bin
.{eventId}.commit.json
```

claim 和 commit marker 采用以下规范 JSON：

```ts
interface StoredEventClaimV1 {
  schemaVersion: 1;
  type: "recorded-event-claim";
  eventId: string;
  eventHash: string;
  byteLength: number;
  chunks: Array<{
    index: number;
    uri: string;
    byteLength: number;
    contentHash: string;
  }>;
}

interface StoredEventCommitV1 {
  schemaVersion: 1;
  type: "recorded-event-commit";
  eventId: string;
  claimHash: string;
}
```

`eventHash` 对完整事件规范字节计算，chunk `contentHash` 对原始 chunk bytes 计算，`claimHash` 对
claim 规范字节计算；均使用 `sha256:<小写十六进制>`。每个 chunk 最多 4 MiB，按六位十进制
索引排序。adapter 先创建 claim，再按服务限制批量创建 chunks，回读并验证全部 chunks、重组长度和
event hash 后最后创建 commit marker。claim、chunk 或 marker 冲突都是完整性错误；没有有效
commit marker 的大事件不属于已接受事件，不能推进 ACK 或进入 Archive。同一 event ID 只能具有
direct 或 chunked 一种表示；两种表示同时存在是完整性冲突。

ACK frontier 是已确认叶节点的最小前沿集合：

```ts
interface SyncAck {
  acknowledgedLeaves: string[];
}
```

`acknowledgedLeaves` 保存 Pi entry ID；只有一个 entry 的全部投影事件都被接受后，该 entry 才能
进入 frontier。

持久 ACK 文件位于 `~/.pi/openviking/sync-ack/{targetKey}.json`；`targetKey` 是规范数组
`["pi-openviking/sync-ack", 1, { endpoint, account, user }, sessionId]` 的 SHA-256。文件内容只有
`SyncAck`，以同目录临时文件和 rename 原子替换。endpoint、account 或绑定用户变化时使用新的
ACK 文件。该文件不是事件事实源；损坏或丢失时清空 frontier 并从 Pi JSONL 重放。
任一前沿叶节点的祖先都视为已确认；一个已确认叶节点成为另一个的祖先时从集合移除。
切换分支后从最近的已确认祖先继续发送；无法确认的事件使用稳定 event ID 幂等重放。

持久 source 读取 JSONL 中的完整 entry tree，并按 parent-before-child 顺序同步所有未确认 entry；当前
leaf 用于恢复活动分支，但不会排除 sibling branch 的事实。ACK frontier 覆盖进程重启、等长分支
切换、较短分支和从已同步祖先产生的新分支，每个源事件都有可追踪的确认结果。

未持久化的 Pi session 在进程存活期间提供 best-effort 同步。新消息形式以不透明 payload
保留；tool call/result 保留 Pi 身份和真实的完成、错误状态。

### 3. Archive 是一个原子对象

Archive 是一段已确认事件的原子绑定。事件本身已由同步层持久化为 immutable 对象，因此 Archive 只
持久化一份 manifest：

```ts
interface ArchiveManifestV1 {
  schemaVersion: 1;
  type: "archive-manifest";
  sessionId: string;
  archiveId: string;
  firstEventId: string;
  lastEventId: string;
  eventCount: number;
  contentHash: string;
}
```

`archiveId` 为 `arc_` 加规范数组
`["pi-openviking/archive", 1, sessionId, firstEventId, lastEventId, eventCount]` 的 SHA-256 小写十六进制；
`contentHash` 是 `sha256:<hex>`，对规范数组
`["pi-openviking/archive", 1, "content", 逐事件完整规范字节的 sha256 列表]` 计算，因而同时绑定事件身份、
内容和顺序。manifest 保持常数大小：事件序列不写入 manifest，读取时从 `lastEventId` 沿事件自身的
`parentId` 回溯 `eventCount` 步得到，并以到达 `firstEventId` 和复算 `contentHash` 证明完整。

manifest 位于：

```text
viking://user/{storageUser}/resources/.pi-openviking/archives/v1/
└── {sessionKey}/
    └── {archiveId 中 arc_ 后 digest 的前两位}/
        └── .{archiveId}.json
```

`sessionKey` 是规范数组 `["pi-openviking/archive-storage", 1, "session", sessionId]` 的 SHA-256。

OpenViking Content API 不提供多对象原子可见性，单对象写入在进程崩溃后也可能留下不完整字节，因此
Archive 的原子性不依赖服务端写入语义，而由三条规则共同提供：

1. **唯一提交点**——manifest 是 Archive 唯一持久化的对象，只在全部引用事件已被接受后写入；不得把
   一次 `batch-write` 或客户端先后写入直接当作 Archive 已提交。
2. **接受证明**——写入 manifest 前逐项回读被引用事件，复算 event identity、规范字节与聚合
   `contentHash`；事件对象的 commit marker 不能代替该证明。
3. **内容自证**——只有能解析、能复算出同一 `archiveId` 且规范字节与读到的字节完全一致的内容才是
   Archive。崩溃残留因此等价于不存在：它从来不是已接受对象，恢复时按其实际 hash 就地替换；已自证
   但绑定不同内容的 manifest 才是完整性冲突，保留原对象并返回可诊断失败。

同一 event 范围重复提交得到同一 `archiveId` 与同一字节，不产生第二个逻辑对象。完整性冲突只排除对应
Archive；暂时性传输失败保留上一 checkpoint 消费范围并等待重试。两类失败都不改变已经持久化的事件和 ACK。

Archive 创建由 token 压力驱动，支持单个超长用户轮次，并保持 Pi entry 与 assistant/tool call/result step
边界完整。压力轴是分支事件自身的上下文权重之和——度量对象是事件进入
上下文的内容，不是一次 provider 请求的累计 usage（后者含 system prompt 与工具定义，与事件范围不同
尺度）。首次 Archive 的目标压力为
`archive.rawTailTokenBudget + archive.chunkTokenBudget`，之后每累计一个
`archive.chunkTokenBudget` 形成下一 Archive，同时保留 `archive.rawTailTokenBudget`。边界落在压力轴的
绝对位置上，因而后续事件不会移动已固定的边界；候选边界若会拆开一个 entry 或 step，则退回该原子范围起点之前。

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
`taskId`、`archiveId` 和提交时间；明确失败追加稳定错误分类、错误码与代码拥有的通用消息，外部
provider/task 错误正文保留在受管 OpenViking 边界内。checkpoint 只有在 parent 指向当前 Archive 与前一
checkpoint 下连续 attempt 中存在、匹配且没有 failure 的 request 时才表示消费完成；来源 Archive 身份和
hash 必须同时匹配。并发进程写入同一事实身份时采用首个通过该完整事实链校验的已提交对象。
多模态输入只有在每个媒体对象都得到非空语义摘要后才提交 VLM；终态 request/failure/checkpoint 跨重启
派生临时 Session 与 attempt 媒体根的清理义务，二者都确认不存在才算清理完成。每次协调调度从既有 request
事实发现一次失效 task，随后只重试已发现的正向义务，不形成第二份持久队列。

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

隐藏 raw event 对象是检索派生物的数据源，但不直接进入普通 Resource 的语义刷新。检索从
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
    "rawTailTokenBudget": 30000,
  },

  "takeover": {
    "enabled": true,
    "contextTokenThreshold": 0,
    "checkpointTokenBudget": 16000,
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
  "logLevel": "error",
}
```

其中：

- `archive.chunkTokenBudget` 控制每次 Archive 的目标增量；
- `archive.rawTailTokenBudget` 控制 Archive 后保留的最近原始上下文预算；
- `takeover.contextTokenThreshold` 是任务模型上下文高水位，`0` 表示按当前模型容量自动确定；
- `takeover.checkpointTokenBudget` 控制接管时装载的 VLM checkpoint 上限；
- `takeover.enabled` 控制任务模型上下文替换，事件记录和 Archive 独立持续运行。

Archive 与 takeover 预算是端到端预算校准（见 [`docs/roadmap.md`](./roadmap.md)）的候选值。预算根据 Archive step 边界、raw-tail 完整性和
接管后上下文大小验证。开发和真实验收统一使用 [`docs/development.md`](./development.md#开发模型身份与凭证桥接)
定义的开发模型身份；凭证桥接和持续调用授权边界也以该处为准。
VLM 消费能力必须针对该固定模型形成真实证据，不能在运行时静默选择其他模型。

`contextTokenThreshold=0` 使用“任务模型上下文容量减去 system、工具、provider 安全余量、
checkpoint 和 raw tail”计算高水位。高水位必须为正且能够容纳目标上下文；容量不匹配时
保持 takeover inactive，并由 `/viking` 报告。先调整候选预算并重新通过端到端预算校准；如果固定模型仍
无法提供安全余量，则保持 inactive。改变 provider 或 model 属于新的战略决定，必须重新获得用户决定并重跑
相关阶段。可外置的大型 payload 使用完整存储和可追溯引用；非外置原子输入的支持上限由固定任务模型的
剩余容量决定，超出时拒绝接管或缩小源输入。
Pi compaction 仍由 Pi 的运行时条件触发。

上述对象是扩展配置的完整 schema。配置加载器对未知字段返回包含字段路径的校验错误；开发
环境从当前模板生成 `~/.pi/pi-openviking.jsonc`。OpenViking 服务地址、凭证和
`managedServer.proxy` 属于服务连接配置，与扩展的事件、Archive 和上下文策略分离。事件 URI、
规范编码、分片、precondition 和 ACK 规则是系统完整性约束，不提供用户可变配置。

受管服务固定使用已通过集成探针的 OpenViking `0.4.15`。远端服务在首次真实 Content 操作中探测
batch-write、raw download、mkdir 和严格响应语义；路由缺失、请求 schema 不兼容或响应结构不匹配
标记 capability mismatch，网络不可用保持 unknown。隐藏文件不进入普通语义处理是支持版本的安装/
集成验收项，不在每次启动创建额外探针对象。0.4.15 在 namespace 删除后会由目录语义管线物化空目录骨架（不含任何文件）；live gate 的清理以逐 URI 持久 404 为准，骨架再现只是服务端行为观察。两类失败都保持事件待重放和 Pi 主任务 fail-open，并由 `/viking` 报告。

## 准确性与可用性边界

严格校验范围是机械完整性：

- 持久化 Pi JSONL 中的每个源事件具有已确认或待重放状态；
- 小事件只有在确定性 URI 返回 `created`/`unchanged`，大事件只有在全部 chunks 验证且 commit
  marker 创建后，才属于 OpenViking 已接受事件；
- ACK frontier 只在 OpenViking 确认接受后推进，queue status、请求已发送或本地 pending payload
  均不构成 ACK；
- Archive 只有在 manifest 自证成立且回读证明全部引用事件有效后才可见；
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
