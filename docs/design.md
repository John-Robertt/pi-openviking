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
- 在 `session_start` 初始化会话来源和 ACK；
- 在 `turn_end`、`session_compact` 非阻塞调度会话来源检查或同步；
- `session_shutdown` 给予同步 500ms grace 后取消 transport，未确认内容留在 Pi 来源；观察已启用时只用该期限的
  剩余时间完成独立记录；
- recall 实际注入时追加 `ov-observation` custom entry，再由同一事件链同步；
- OpenViking 不可用时只更新待重放诊断，不阻塞 Pi 主任务；
- 不触发 Pi compaction，不构造 Archive，不替换 provider 上下文。

### `shared/observe.mjs`

- 维护唯一 active stage registry、版本化记录与字段白名单；
- 未请求观察时提供固定 no-op，调用不读取时钟、不序列化、不散列也不分配操作号；
- 启用时将职责模块提供的既有安全值写入单个私有 JSONL sink；有界队列、schema 或 sink 失败只把观察状态转为
  `incomplete`；
- 不读取产品状态，不写 Pi JSONL、ACK 或 OpenViking，也不向任何业务路径提供决策输入。

### `shared/pi-session-source.mjs`

- 解析持久 Pi JSONL；
- 校验 session header、entry ID 和 parent tree；
- 根据 leaf 恢复活动分支，同时返回完整 entry tree 和 parent map；
- 同步层处理完整 tree，活动分支不排除 sibling branch 事实。

非持久化 session 不经过该模块，由 `SyncManager` 在进程内维护已观察 parent map。

### `shared/recorded-event.mjs`

- 将 Pi entry/content part 投影为 `RecordedEventV1`；
- 保留 message envelope、原始 part、错误和终止状态；
- 生成 event/turn/step identity、parent 关系和内容 hash；
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

### `shared/archive.mjs`

- 生成 `archiveId`、聚合 `contentHash` 与 manifest 规范字节；
- 从字节复原 manifest 并要求其自证（复算 `archiveId`、拒绝未知字段与非规范编码）；
- 按事件自身的上下文权重确定 Archive 边界，并把候选边界退回 step 起点之前；
- 不接触传输，也不持久化任何状态。

### `shared/archive-store.mjs`

- 维护 Archive manifest 的存储位置与身份版本；
- 提交前逐项回读被引用事件并复算聚合 hash，作为 Archive 的接受证明；
- 以单个 manifest 对象为唯一提交点，按残留/已提交/冲突三种情形决定写入方式；
- 按 `archiveId` 确定性读取，并沿事件 `parentId` 链 materialize 与重新验证；
- 发布 Archive 提交状态；失败只转为待重试，不改变事件与 ACK。

### `shared/sync-ack.mjs`

- 保存最小 `acknowledgedLeaves`；
- 根据完整 parent map 判断祖先是否已确认；
- 在分支产生共同祖先或 sibling leaves 时保持最小 frontier；
- 维护 ACK 文件键的确定性身份版本；
- 原子替换 ACK 文件。

ACK 文件不包含 transcript 或事件 payload。丢失 ACK 只会触发幂等重放。

### `sync.ts`

`SyncManager` 是唯一协调者：

1. 获取持久 JSONL source 或进程内 branch；
2. 计算当前未确认 entry；
3. 投影该 entry 的全部事件；
4. 调用 Content adapter；
5. 只有全部事件确认后推进 entry ACK；
6. 在当前分支已确认的事件前缀上驱动 Archive 形成；
7. 发布 source、capability、pending、Archive 和 failure 状态。

它只持久化 `SyncAck`，不持久化待发送事件副本；Archive 由来源事件重算，同样没有第二份本地状态。
Archive 只取当前分支：跨 sibling branch 的范围没有对应的上下文。

### `shared/openviking-api.mjs`

- 唯一维护 OpenViking API 版本前缀；
- 只把职责模块提供的相对路径组合为版本化路径，不拥有 HTTP 方法、payload 或业务决策。

### `client.ts`

- 提供认证、account/user/peer header 和 loopback proxy 隔离；
- 提供 Content batch-write、raw download、stat 和 mkdir transport；
- 不决定 event identity、ACK 或重放策略。

### `config.ts` 与 `shared/config-schema.mjs`

- `config-schema` 是扩展策略字段的运行时校验器；
- `config.ts` 合并包内默认值和用户覆盖，再解析外部服务凭证；
- `managedServer.proxy` 与扩展策略共享 JSONC 文件，但由服务管理模块消费；
- 未知字段和损坏 JSONC 不静默回退。

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
        │ committed archive manifests
        ▼
/viking diagnostics
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
- `test/client-content.test.mjs`：HTTP transport；
- `test/openviking-api.test.mjs`：版本前缀与相对路径组合；
- `test/sync-manager.test.mjs`：重启、ACK 丢失、分支和 fail-open；
- `test/config-schema.test.mjs`：唯一配置 schema；
- `test/package-metadata.test.mjs`：manifest/lock 一致与 peer 最低兼容基线；
- `test/observe.test.mjs`：registry、记录 schema、关闭零工作、sink 失败和字节一致性；
- `test/observability-integration.test.mjs`：职责模块接点、脱敏及 fail-open 产品等价性；
- `test/observation-evidence.test.mjs`、`test/observability-live-verifier.test.mjs`：完整 run 与 manifest 契约；
- `test/viking-status.test.mjs`：运行诊断。

真实边界由 `npm run verify:observability:live` 覆盖成功 recall/同步、断线、409 冲突、URI 拒绝与持久清理，
由 `npm run verify:phase1:live` 覆盖真实 Archive 形成、崩溃残留恢复、受管重启幂等与完整性冲突 fail-open。
阶段 gate 的 Pi 驱动、身份核对、ownership、清理与 summary 骨架由 `test/live/live-support.mjs` 统一承担。
