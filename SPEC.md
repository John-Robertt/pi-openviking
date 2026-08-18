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

OpenViking `0.4.13` 的公开 Content API 是 OpenViking `RecordedEvent` 投影的物理持久化边界。扩展
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
原始事件文件使用隐藏名称；OpenViking 0.4.13 的普通 `ls` 会过滤 dot files，但仍可能展示 dot
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

Archive manifest 定义收录范围并绑定 immutable event identity、顺序和 hash。Phase 0 Content adapter
只证明单个事件对象的字节幂等，不提供 Archive 多对象原子绑定；不得把一次 `batch-write` 或客户端
先后写入直接当作 Archive 已提交。Phase 1 必须通过真实 OpenViking 操作调查，选择能够提供崩溃恢复、
幂等身份和原子可见性的最小机制。只有该机制的独立验收证明 manifest 与全部引用同时有效后，Archive
才存在并可进入 VLM 处理和上下文接管。

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

受管服务固定使用已通过集成探针的 OpenViking `0.4.13`。远端服务在首次真实 Content 操作中探测
batch-write、raw download、mkdir 和严格响应语义；路由缺失、请求 schema 不兼容或响应结构不匹配
标记 capability mismatch，网络不可用保持 unknown。隐藏文件不进入普通语义处理是支持版本的安装/
集成验收项，不在每次启动创建额外探针对象。两类失败都保持事件待重放和 Pi 主任务 fail-open，并由
`/viking` 报告。

## 准确性与可用性边界

严格校验范围是机械完整性：

- 持久化 Pi JSONL 中的每个源事件具有已确认或待重放状态；
- 小事件只有在确定性 URI 返回 `created`/`unchanged`，大事件只有在全部 chunks 验证且 commit
  marker 创建后，才属于 OpenViking 已接受事件；
- ACK frontier 只在 OpenViking 确认接受后推进，queue status、请求已发送或本地 pending payload
  均不构成 ACK；
- Archive 只有在 Phase 1 验证的原子机制同时证明 manifest 和全部引用有效后才可见；
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

Phase 0A/0B 实现已完成。自动化验证包含合成 100k+ golden、固定协议向量、版本化 seed 生成的有效
Pi entry/树拓扑与 forward-compatible part、三个独立长工具循环、真实 Pi `SessionManager` 持久化/重启、
sibling branches、entry `SyncAck`、确认顺序、ACK 丢失/持久化失败、并发调度、127/128/129 项、
8/16 MiB 前一值/边界值/后一值、chunk/commit、capability 和 fail-open。OpenViking 0.4.13 兼容验收
覆盖 created、unchanged、409、byte-exact、direct/chunked、dot-file 与语义隔离；
`scripts/e2e-probe.ts` 提供真实 provider payload 采集；统一的 `verify:phase0:live` 入口、JSON summary
和隔离清理断言是 Phase 0 当前剩余的阶段出口。Phase 1 尚未开始。

## 验证策略

验证由四类相互独立的证据组成：

1. **Golden 回归基线**：固定的合成 100k+ 负载用于逐字节比较协议、对象身份和跨阶段状态，证明相同输入保持确定结果。
2. **确定性生成与不变量**：版本化 seed 生成不同 entry 类型、payload、树拓扑和长工具循环；测试从源 entry
   重建 payload，并验证身份唯一性、parent/turn/step、分支恢复、ACK 最小性和确认顺序无关性。失败报告
   seed，使任何场景都能稳定重放。
3. **边界矩阵**：按协议边界的前一值、边界值和后一值验证操作数、对象大小、批次总量、容量、失败、
   响应丢失及重启组合；边界数据独立构造，不从 golden 轨迹截取。
4. **真实运行证据**：使用真实 Pi JSONL/lifecycle、OpenViking 和所属阶段的 provider/VLM 工作负载验证
   运行时格式、存储语义、模型容量和吞吐。真实样本保留来源类型、Pi/provider/model/prompt 版本和可重放
   输入，敏感内容脱敏。

固定轨迹承担回归基线职责；输入分布覆盖由生成场景、边界矩阵和真实样本共同提供。模型 token 数使用 Pi
或 provider 的实际计量，不以字符数估算替代。模型输出允许非确定，但事件对应、step 原子性、hash、容量
和时序预算使用确定不变量验收。每个阶段只有在其四类适用证据共同通过后才完成；实践结果改变理解时，
先更新当前约束与验收场景，再继续实施。

Phase 3 使用多个彼此独立的真实 100k+ 工作负载完成模型级端到端验收，至少覆盖：多轮长工具循环与
并行成功/失败、单轮超长原子输入及大型 payload、分支/重启/Pi compaction，并覆盖多个真实
provider/VLM 组合。各工作负载均走 Archive、checkpoint 和 takeover 链路；固定 golden 回放只提供
结果对照。

## 真实验收门禁

每个实施阶段交付一个由 `package.json` 暴露的 live verifier：`verify:phase0:live`、
`verify:phase1:live`、`verify:phase2a:live`、`verify:phase2b:live`、`verify:phase2c:live`、
`verify:phase3:live` 和 `verify:phase4:live`。一个入口可以组合多个聚焦脚本，但阶段出口只引用该入口。
live verifier 是阶段实现的一部分，mock、内存 transport、合成模型输出和人工检查不构成该门禁的替代品。

所有 live verifier 使用同一契约：

- 每个阶段先提交 `test/live/{gate}.workloads.json` manifest，固定 workload/seed、适用版本与真实进程/
  端点身份、成功标准、证伪条件、证据提取方式和阈值决策规则；基线探针完成后，将 baseline、数值阈值
  与预期变化写入 manifest 并在实现前固定其 hash，运行时不能临时改变；
- 启动前连接并校验 manifest 声明的真实 Pi、OpenViking、provider/model、VLM、prompt 和协议身份；
  支持矩阵或端点身份不匹配时明确拒绝运行；
- 输入使用脱敏 fixture 或可重放生成参数；live verifier 在专用测试 workspace 和测试用户 namespace
  运行，凭证只从环境读取，不写入输入、payload artifact 或 summary；
- summary 使用一个版本化 JSON 结构，记录 phase、run ID、manifest hash、版本/端点身份、逐项 expected/
  actual/delta、证据文件 hash、实际 token/时长和 cleanup。`passed` 只由全部必要断言与 cleanup 派生，
  退出码与之保持一致；
- 本地数据位于仓库 `test/.artifacts/live/{runId}` 并由 `.gitignore` 排除。verifier 以 exclusive create
  建立含 run ID、manifest hash 和随机 nonce 的本地 ownership marker；Pi 每次启动使用一个新的 `0600`
  segment file，verifier 先以 `wx` 打开并把继承 FD 交给探针。探针只写 FD，不接触路径；重启复用 run
  目录前重新核对 marker、owner 和权限；
- 捕获 provider payload 时，manifest 固定扩展加载顺序且探针最后加载；summary 记录顺序和 segment。
  verifier 根据 Pi 请求观察点确定预期捕获数，逐条校验 JSONL 和 segment hash，并检查 extension-error
  通道；缺失、序列化/写入错误或后续 payload 修改均使 gate 失败；
- 原始 provider payload 只在专用 workload 中临时保存。summary 和跨阶段 CI artifact 仅保留白名单
  脱敏测量、身份与证据 hash；
- OpenViking 写入前确认本次随机 namespace 不存在或为空，以 create-if-absent 写入包含 run ID、
  manifest hash 和随机 nonce 的 ownership marker，并逐字节回读。verifier 只在写入前检查与删除前复核
  均匹配同一精确根路径和 marker 字节时删除该 namespace；
- 受管环境可执行中断/重启；远端破坏性测试需要显式 opt-in。清理前先生成脱敏测量与证据 hash，随后
  成功或失败都删除远端对象；清理失败使 gate 失败；
- 完成测量后，成功时删除整个本地 run 目录；失败时删除全部 raw payload，只保留字段白名单式脱敏诊断。
  任一本地删除失败同样使 gate 失败。仓库长期保留 verifier、workload manifest 和断言，不提交单次运行日志；
  需要跨阶段消费的 summary 作为同一 release run 的 CI artifact；
- 任一必要断言、观察点或清理失败即保持阶段出口未通过，并由 expected/actual/delta 重新定位主导约束。
  各阶段先实现自己的入口；出现第二个真实消费者后才提取共享 verifier 代码。

阶段 live gate 的职责如下：

| Gate | 真实边界 | 必须由机器断言的结果 |
| --- | --- | --- |
| Phase 0 | 当前 Pi CLI/lifecycle、真实 `SessionManager`、受支持 OpenViking Content API；模型输出可受控 | Pi JSONL → 全部 `RecordedEvent` → direct/chunked 对象 → entry ACK 逐项对应；重放、409、断线、shutdown 和清理成立 |
| Phase 1 | 受管 OpenViking 的 Archive 发布中断/客户端重启，以及多个真实 Pi workload 形成的 Archive | 原子可见、幂等恢复、确定 expand、event/step 边界和每种真实样本的 Archive 完整性成立 |
| Phase 2A | Phase 1 的各真实 Archive 与候选 VLM | checkpoint 来源/hash、失败重试、重启恢复和积压派生正确；实际 VLM 吞吐满足 manifest 阈值 |
| Phase 2B | 真实 Pi session、候选 checkpoint/raw tail 和拟进入 Phase 3 的 task-model 元数据；takeover 保持 inactive | 候选 payload 可由源事件逐项重算，step/anchor 完整；Pi 报告容量在边界两侧分别 fit/mismatch |
| Phase 2C | 真实 Pi `context` hook、全部 Phase 3 候选 task provider、可控 OpenViking/VLM 降级及 Pi compaction | 实际 provider 请求与 Phase 2B 候选 payload 一致；每个高水位只切换一次；分支/重启成立；降级时使用完整 Pi 上下文 |
| Phase 3 | 多个拟出厂 provider/VLM 组合和多个彼此独立的真实 100k+ workload；每个拟出厂组合至少重复三次 | 源事件到实际 provider 请求全链一致；实际 token、吞吐、延迟和容量安全余量满足 manifest 阈值，重复运行结论一致 |
| Phase 4 | 同一 release run 的 Phase 3 summary，以及在本次 namespace 重建的对应 events/Archive/checkpoint | summary/manifest hash 匹配；索引就绪及重启后 search/browse/expand 返回预期身份和来源链；过滤、隐藏 raw event 隔离及清理成立 |

## 实施顺序

Phase 0 建立事件与同步事实；Phase 1 建立原子 Archive；Phase 2 依次建立 checkpoint、`ActiveContext`
和真实上下文切换；Phase 3 校准多 workload/model 组合；Phase 4 建立检索与诊断。下一阶段只消费
已通过上一阶段 deterministic checks 与 live gate 的状态。

每个阶段按同一调查闭环执行：

1. 在实现前建立 manifest，固定阶段成功标准、当前可重现现象、与目标的差距、证伪条件、输入和机器
   观察点；
2. 对真实边界运行最小基线探针，收集足以区分候选机制的日志/trace，把 baseline、阈值和预期变化写回
   manifest 并固定 hash；Phase 1 的原子机制选择必须先完成该调查；
3. 选择当前主导约束，实施能闭合该约束的最小结构，并先运行聚焦 deterministic checks；
4. 运行阶段 live verifier，把结果与基线和预期变化逐项比较；结果偏离时回到步骤 1，重新调查并识别
   主导约束；
5. deterministic checks、live gate、完整 `npm test`、`git diff --check` 和文档自检共同通过后关闭阶段出口。

Phase 0 的 production 实现先于统一 live gate 存在，因此当前按补建门禁处理：先用独立协议向量和真实
Pi/OpenViking 探针建立 reference baseline 并固定 manifest，再实现 verifier；verifier 失败即重新打开
对应的 Phase 0 实现约束。Phase 1 起完整按上述 1–5 顺序执行。

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
  真实 Archive 工作负载分别经过候选 VLM。

**验收**：

- 持久化且来源 Archive 身份和 hash 匹配的 checkpoint 表示该 Archive 消费完成；
- 同一 Archive 的重试和进程重启恢复至多产生一个有效 checkpoint；
- 一个未消费 Archive 显示处理中，第二个产生时通知消费落后，恢复到至多一个在途 Archive 时
  通知一次；
- Archive、request、checkpoint 和失败事件能够完整派生 VLM 状态、失败原因及积压 token；
- VLM 失败不改变已经持久化的事件和 raw Archive；
- Phase 1 的各真实 Archive 工作负载均产生来源和 hash 可核验的 checkpoint，并分别满足候选 VLM
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
- 用 golden 回归和独立生成场景验证切换不变量；用全部 Phase 3 候选 task provider 的真实请求验证
  高水位、分支、重启、compaction 和 fail-open payload。

**验收**：

- 每次上下文高水位原子替换一次 `ActiveContext`，并保持到下一次上下文高水位；
- provider 实际 payload 与 Phase 2B 验证的构造一致，后续事件追加在稳定前缀之后；
- 无有效 `ActiveContext`、OpenViking/VLM 降级或容量不匹配时，provider 使用完整 Pi 上下文；
- 单个用户指令后的长工具循环能够安全归档和接管；
- Pi 是 compaction 的唯一触发方；`ActiveContext` 不可用时执行原生 split-turn compaction，扩展
  仅返回生命周期钩子结果并保持运行中的 agent 可用。

### Phase 3：端到端预算校准与模型定型

- 在 Phase 0–2 逐阶段通过后，于真实 provider 和 VLM 环境中运行“验证策略”定义的多个独立 100k+
  工作负载；token 数取自 Pi/provider 实际计量；
- 对照原始事件检查 Archive 边界、raw tail、checkpoint 和接管上下文；
- 使用 Pi 报告的任务模型容量验证高水位公式两侧的 fit 与 capacity mismatch 行为；
- 根据 step 原子性、raw-tail 完整性和上下文容量调整候选预算并重跑；
- 确认所选 VLM 能在下一个 Archive 产生前完成前一个 checkpoint；
- 预算和 VLM 通过端到端验证后确认为出厂默认值，容量边界确认为 takeover eligibility 规则。

**验收**：

- 各真实 100k+ 工作负载中的 Archive、raw tail、checkpoint 和 provider payload 与各自源事件逐项对应，
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

当前入口是补建并运行 `verify:phase0:live`：先固定 Phase 0 manifest/reference baseline，再在真实 Pi 和
OpenViking 0.4.13 上建立统一 summary、ownership namespace、逐事件/ACK 和清理断言。
`scripts/e2e-probe.ts` 作为最后加载的扩展向 verifier 预开的 segment FD 写最终 payload；verifier 必须
核对预期捕获数量/hash 和 extension-error 通道。该门禁通过后，Phase 1 从 Archive 原子绑定与崩溃语义的
真实基线探针开始；获得
原子可见性、幂等恢复和确定性读取证据后再实现 Archive。
