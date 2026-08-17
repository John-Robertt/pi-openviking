# Pi 的 OpenViking 上下文接管

上下文接管让 OpenViking 成为 pi 会话长期上下文的权威存储。Pi 仍在本地保留近期的活跃轮次，但已提交的历史通过 pi 的 `context` 钩子，以 OpenViking 的归档概览形式呈现给模型。

## 模型

扩展跟踪以下字段：

| 字段 | 含义 |
|-------|---------|
| `coveredUserTurns` | 已确认归档概览所覆盖的真实用户轮次数量 |
| `overview` | 从其提交响应所标识的那个确切归档中读取的概览 |
| `confirmedArchive` | 拥有当前已注入概览的归档身份 |
| `pendingArchive` | 已被接受的提交身份及其边界快照，正等待自己的概览 |
| `fingerprint` | 最后一条被覆盖消息的稳定指纹，用于检测分支不匹配 |
| `pendingTokens` | 尚未被已确认归档覆盖的、已同步 token 压力的估算值 |
| `syncedEntryCount` | 跨 `pi -p` / `pi -c` 进程恢复的 Pi 分支水位线 |

状态以 pi 自定义条目的形式持久化：

```ts
pi.appendEntry("ov-takeover", state)
```

启动时，扩展从末尾开始扫描分支，恢复最新的条目，并恢复 `SyncManager` 的水位线，使 `pi -c` 不会把相同的分支条目重复发送给 OpenViking。

## 运行时流程

1. `turn_end` 把新的分支条目捕获进 OpenViking 会话。
2. 当 OpenViking 暂时不可达时，捕获路径改用磁盘上的待处理队列。
3. 当 `pendingTokens >= takeover.tokenThreshold` 时，接管尝试推进边界。
4. 推进首先排空当前会话中待处理的 `addMessage` 条目。
5. 提交会启用 OpenViking 的 `turn_budget` 保留策略，并且必须返回 `status=accepted`、`archived=true`、`task_id` 和 `archive_uri`。
6. 被接受的身份在轮询之前先行持久化。在其处于 pending 期间，自动、手动和压缩等所有入口都复用它，而不会再次提交。
7. 任务必须完成，且 `GET /sessions/{id}/archives/{archive_id}` 必须返回那个确切归档的非空概览，边界才能推进。
8. 完成时只扣减提交被接受当时存在的那部分 token 压力；等待期间新同步的 token 仍然处于待处理状态。
9. `context` 钩子把已确认覆盖的消息替换为一条以 `[OpenViking Session Context]` 开头的合成用户消息，然后把召回内容注入到剩余的最新一条用户轮次中。

概览消息的时间戳取自第一条被保留的消息，因此提交之间的 provider 载荷保持逐字节稳定，可以受益于提示词缓存。

## 压缩

压缩决策与安全的轮次中切分边界（包括工具调用/结果配对）由 pi 负责。当 pi 发出 `session_before_compact` 时，接管首先与任何已接受的归档对账。随后它以 `keep_recent_count=0` 提交剩余的 OpenViking 活跃消息，使那个确切的归档覆盖 Pi 即将替换掉的全部内容。若该归档能及时就绪，扩展返回：

```ts
{
  compaction: {
    summary: "[OpenViking Session Context]\\n...",
    firstKeptEntryId,
    tokensBefore,
    details: { source: "openviking", archiveUri }
  }
}
```

若其中任一步骤仍处于 pending 或失败，处理器返回 `undefined`，Pi 的默认压缩流程运行。该归档身份仍可重试，但 `session_compact` 会阻止它之后去推进压缩前的边界。

## 捕获保真度

接管模式会在 pi 适配器中启用忠实捕获。简短应答、只有标点的轮次以及其他低信号文本同样会被捕获，因为这些轮次日后可能从模型的活跃上下文中消失。空文本、斜杠命令和 OpenViking 状态消息仍然被过滤。被捕获的消息携带 Pi 用户条目 ID 作为 `turn_id`，并带有显式的 `message_kind`，使 OpenViking 能够在一个原子步骤中把一条助手回复及其工具传输保存在一起。

## 配置

```json
{
  "takeover": {
    "enabled": true,
    "tokenThreshold": 20000,
    "retainedTokenBudget": 30000,
    "keepRecentTurns": 3,
    "overviewBudget": 16000,
    "overviewPollMs": 2000,
    "overviewPollMax": 15
  }
}
```

| 字段 | 默认值 | 含义 |
|-------|---------|---------|
| `takeover.enabled` | `true` | 启用上下文接管 |
| `takeover.tokenThreshold` | `20000` | 开始归档所需的已同步 token 压力 |
| `takeover.retainedTokenBudget` | `30000` | 归档之后 OpenViking 保留的原始消息预算 |
| `takeover.keepRecentTurns` | `3` | 优先以完整保真度保留的最近逻辑用户轮次数 |
| `takeover.overviewBudget` | `16000` | 注入的归档概览的 token 预算 |
| `takeover.overviewPollMs` | `2000` | 概览轮询尝试之间的延迟 |
| `takeover.overviewPollMax` | `15` | 提交后概览轮询的最大尝试次数 |

## 失败模式

| 失败情形 | 行为 |
|---------|----------|
| OpenViking 健康检查失败 | 扩展保持断开；pi 正常运行 |
| 待处理的 addMessage 重放失败 | 不推进边界；完整的本地历史继续可见 |
| 提交失败或被跳过 | 不推进边界；待处理的 token 压力保留 |
| 第 1 阶段之后提交响应丢失 | 通过任务前/后的 task ID 恢复新任务；结果不明确时阻止后续提交 |
| 已接受的归档处于 pending | 身份被持久化并重试，不会再次提交 |
| 任务失败、被取消，或归档身份不匹配 | 清除 pending 身份；压力保留；边界不变 |
| 确切归档的概览为空 | 身份保持 pending；绝不用会话上下文概览作为回退 |
| 遗留状态没有已确认的归档身份 | 丢弃旧边界；活跃的遗留任务必须先排空才能发起新提交 |
| 分支指纹不匹配 | 边界重置为 0，在下一次成功推进之前显示完整历史 |
| 压缩接管失败 | 返回 `undefined`；Pi 默认压缩继续 |

## 验证

每次涉及接管的改动都要运行 `npm test` 和 `git diff --check`。实机门禁必须使用隔离的 Pi/OpenViking 会话，并验证以下各项身份彼此一致：

1. 提交响应中的 `archive_uri` 与 `task_id`；
2. 已完成任务结果中的 `archive_uri`；
3. 确切归档 API 返回的 `archive_id` 与非空概览；
4. 持久化的 `confirmedArchive` 与 `/viking` 显示的边界；
5. provider 载荷中包含已确认的概览，且仅省略被该归档覆盖的消息。

pending 路径还必须跨一次 Pi 重启做验证。由 Pi 触发的压缩必须至少包含一对工具调用/结果，并验证安全压缩边界没有留下孤立的工具结果。
