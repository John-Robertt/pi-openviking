# 当前 Phase 0 实现设计

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
- 在 `turn_end`、`session_compact` 非阻塞调度观察或同步；
- `session_shutdown` 给予同步 500ms grace 后取消 transport，未确认内容留在 Pi 来源；
- recall 实际注入时追加 `ov-observation` custom entry，再由同一事件链同步；
- OpenViking 不可用时只更新待重放诊断，不阻塞 Pi 主任务；
- 不触发 Pi compaction，不构造 Archive，不替换 provider 上下文。

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
- 不清洗、过滤、截断或解释 payload。

### `shared/canonical-json.mjs`

- 校验 JSON 值域；
- 生成 RFC 8785 规范 JSON 和 UTF-8 字节；
- 拒绝非有限数字、孤立 surrogate、稀疏数组、循环和非 JSON 类型。

### `shared/recorded-event-adapter.mjs`

- 将规范事件映射到绑定用户下的 dot-prefixed event files；
- 幂等创建目录；
- 按 Content API 限制拆分 `batch-write`；
- 核对每个响应 URI；
- 处理 direct 或 claim/chunks/commit 表示；
- 将冲突、transport failure 和 capability mismatch 返回同步层。

adapter 不读取 Pi session、不持久化 ACK，也不创建 Archive。

### `shared/sync-ack.mjs`

- 保存最小 `acknowledgedLeaves`；
- 根据完整 parent map 判断祖先是否已确认；
- 在分支产生共同祖先或 sibling leaves 时保持最小 frontier；
- 原子替换 ACK 文件。

ACK 文件不包含 transcript 或事件 payload。丢失 ACK 只会触发幂等重放。

### `sync.ts`

`SyncManager` 是唯一协调者：

1. 获取持久 JSONL source 或进程内 branch；
2. 计算当前未确认 entry；
3. 投影该 entry 的全部事件；
4. 调用 Content adapter；
5. 只有全部事件确认后推进 entry ACK；
6. 发布 source、capability、pending 和 failure 状态。

它只持久化 `SyncAck`，不持久化待发送事件副本。

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
recorded-event-adapter ───► OpenViking Content API
        │ accepted event IDs
        ▼
sync-ack
        │ acknowledged entry leaves
        ▼
/viking diagnostics
```

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
- `test/recorded-event-adapter.test.mjs`：127/128/129 项、8/16 MiB、冲突和 chunk/commit 边界；
- `test/client-content.test.mjs`：HTTP transport；
- `test/sync-manager.test.mjs`：重启、ACK 丢失、分支和 fail-open；
- `test/config-schema.test.mjs`：唯一配置 schema；
- `test/viking-status.test.mjs`：运行诊断。
