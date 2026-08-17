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
原始事件采用 append-only 持久化。

### 2. 可靠增量同步

持久化 Pi session 的 append-only JSONL 是 Pi 来源事件及其 payload 的唯一事实源；同步层只
持久化最小 `SyncAck`。OpenViking 确认接受事件后推进 ACK frontier，发送失败时保持原
frontier。ACK 状态丢失时从 Pi JSONL 幂等重放。

ACK frontier 是已确认叶节点的最小前沿集合：

```ts
interface SyncAck {
  acknowledgedLeaves: string[];
}
```

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
  events: RecordedEvent[];
}
```

Archive 的 manifest 定义收录范围。OpenViking 归档操作选定事件，并将事件内容和 manifest
作为一个 Archive 原子持久化；扩展以 `archiveId` 消费该对象。具有完整 manifest 的 Archive
可以进入 VLM 处理和上下文接管。

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

语义索引的数据源是 raw events 和 checkpoint，并标明原始记录或 VLM 理解、时间、模型和
来源 URI。Archive manifest 提供范围过滤、browse、expand 和完整性校验。每个搜索结果都能
展开到原始事件。

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
`managedServer.proxy` 属于服务连接配置，与扩展的事件、Archive 和上下文策略分离。

## 准确性与可用性边界

严格校验范围是机械完整性：

- 持久化 Pi JSONL 中的每个源事件具有已确认或待重放状态；
- ACK frontier 在 OpenViking 确认接受后推进；
- Archive 事件和 manifest 原子持久化；
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

当前执行 Phase 0；阶段出口是聚焦测试覆盖并通过完整事件投影、稳定 event identity、Pi JSONL
幂等重放和最小 `SyncAck`。

## 实施顺序

### Phase 0：完整记录与最小可靠同步

- 实现“目标配置”定义的唯一配置 schema 和未知字段校验；
- 用 session ID、Pi entry ID、part 类型和索引生成稳定 event identity；
- 以持久 Pi JSONL 提供待同步事件，并在服务端确认后推进 ACK frontier；
- 根据 `id/parentId` 树恢复当前分支和共同祖先；
- 使用稳定 event ID 幂等重放，ACK 丢失后仍完整确认每个事件；
- 完整捕获不透明或大型 payload，并保留 tool result 错误状态；
- 以最小 `SyncAck` 增量更新同步状态。

### Phase 1：原子 Archive

- 由 OpenViking 归档操作将 Archive 事件和 manifest 原子绑定；
- manifest 记录 event/step 边界、数量和内容 hash；
- 根据单个用户轮次内的 token/step 压力生成有效 Archive；
- 跨重启恢复已接受的 Archive task，并复用相同 `archiveId` 完成处理。

### Phase 2：单一 checkpoint 与上下文接管

- 每个 Archive 异步生成一个统一的结构化 checkpoint；
- checkpoint 保存模型版本、prompt 版本、输入 Archive 身份和 hash；
- 以 checkpoint 事件表示 VLM 完成，并从未消费 Archive 派生处理中、落后和恢复状态；
- 选择已确认 checkpoint 和原子的 raw-tail 边界，形成最小 `ActiveContext`；
- 通过 `context` hook 切换 provider 可见上下文，并冻结到下一次接管；
- 跨重启恢复 `ActiveContext`，分支变化时复用来源边界仍在当前祖先链上的上下文；
- Pi 原生 compaction 提供运行时 fail-open。

### Phase 3：端到端预算验证与模型选型

- 在 Phase 0–2 完成后，使用同一条真实 100k+ token 长轨迹验证候选预算、容量边界和 VLM；
- 对照原始事件检查 Archive 边界、raw tail、checkpoint 和接管上下文；
- 使用 Pi 报告的任务模型容量验证高水位公式两侧的 fit 与 capacity mismatch 行为；
- 根据 step 原子性、raw-tail 完整性和上下文容量调整候选预算并重跑；
- 选择能在下一个 Archive 产生前完成前一个 checkpoint 的 VLM；
- 预算和 VLM 通过端到端验证后确认为出厂默认值，容量边界确认为 takeover eligibility 规则。

### Phase 4：检索和可操作状态

- 语义搜索 raw events 与 checkpoint，并显示来源类型；
- Archive manifest 支持按 session、branch、Archive 和 event ID 过滤、browse 和 expand；
- `/viking` 默认显示连接、Archive/VLM 积压、takeover 状态及 capacity mismatch/fallback；
- 详细诊断输出 checkpoint ID、raw-tail 边界和内部状态字段。
## 验收要求

验证覆盖目标职责和公开边界：

- 配置模板与“目标配置”schema 一致，未知字段返回包含字段路径的校验错误；
- 真实 100k+ token 轨迹证明候选预算满足 step 原子性、raw-tail 完整性和上下文容量；
- 高水位公式结果为正时，当前任务模型能够在安全余量内完整装载目标上下文；
- 高水位公式结果非正时保持 takeover inactive，并由 `/viking` 给出可操作诊断；
- 同一轨迹证明所选 VLM 能在下一个 Archive 产生前完成前一个 checkpoint；
- 单个用户指令后的长工具循环能够安全归档和接管；
- 持久 Pi JSONL 中的每个源事件在服务端确认后推进 ACK frontier；
- ACK 丢失、等长分支替换、较短分支和进程重启后，每个事件均得到确认；
- 持久同步状态为最小 `SyncAck`，非持久化 Pi session 提供进程内 best-effort 同步；
- 相同 event ID 重试保持幂等，相同内容的不同事件分别记录；
- Archive manifest 的身份和 hash 与原子存储的事件一致；
- tool call/result 在 Archive 和 raw-tail 边界保持原子；
- VLM 降级时事件记录和 raw Archive 保持可用；
- 持久化且来源 Archive 身份和 hash 匹配的 checkpoint 表示消费完成；
- 一个未消费 Archive 显示处理中，第二个产生时通知消费落后，恢复到至多一个在途 Archive
  时通知一次；
- Archive、request、checkpoint 和失败事件能够完整派生 VLM 状态及积压 token；
- 每次接管原子替换一次 `ActiveContext`，并保持到下一次上下文高水位；
- raw events 与 checkpoint 可语义检索，Archive manifest 可确定性 browse/expand；
- OpenViking 降级时 Pi 执行保持可用；
- Pi 自身触发 compaction 且 `ActiveContext` 不可用时执行原生 split-turn compaction；
- Pi 是 compaction 的唯一触发方并管理运行中的 agent，扩展只提供生命周期钩子结果。

先运行相关的聚焦测试，再运行完整 `npm test` 和 `git diff --check`。

## 下一实施入口

Phase 0 从 `sync.ts`、`lib/capture-adapter.mjs` 和 `shared/capture-utils.mjs` 开始，交付稳定
event identity、完整事件投影、Pi JSONL 幂等重放和最小 `SyncAck`。Phase 0 验证通过后进入
原子 Archive、checkpoint 和 takeover 实现；配置候选值在 Phase 3 做端到端验证。
