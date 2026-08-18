# 全局可观测性标准

## 文档职责

**架构定位**：观察点是系统运行过程的诊断证据接口；本文是该接口的唯一权威契约。

**核心目标**：对一次边界明确的真实运行，调查者能够回答三件事——发生了什么、为什么走到该结果、证据是否
完整可信——并找到实际结果最早偏离预期的位置。

**职责边界**：本文定义观察记录的语义、关联、安全、输出和完成条件，不定义产品事实、业务决策或阶段进度。
持久事实由 Pi JSONL 与产品对象承载，实施进度由 [`docs/roadmap.md`](./roadmap.md) 维护，证据方法与 live gate
由 [`docs/verification.md`](./verification.md) 维护，调查命令由 [`docs/development.md`](./development.md) 维护。

## 架构边界

观察只说明过程如何流转，不说明产品事实是什么：

|                    | 产品事实与状态                         | 观察记录                         |
| ------------------ | -------------------------------------- | -------------------------------- |
| 回答的问题         | 系统接受了什么、下一步应当做什么       | 某次运行实际经过了什么           |
| 载体               | Pi JSONL、`SyncAck`、OpenViking 对象等 | 独立 JSONL                       |
| 是否参与业务决策   | 是                                     | 否                               |
| 生命周期           | 由产品契约决定                         | 与一次调查或 live run 同寿       |
| 删除后的系统行为   | 可能改变                               | 必须不变                         |

观察记录不得写入 Pi JSONL 或 OpenViking，不得被同步、召回、上下文构造或权限判断读取。观察失败只会使诊断
证据不完整，不得改变 Pi 主任务的控制流、返回值和产品状态。

## 最小观察模型

统一模型只有两层：一次 `ObservationRun` 包含一组有序记录；需要进入/返回配对的操作使用本地 `op` 关联。
这不是分布式追踪，不设置 trace/span 体系，也不传播本地操作身份到外部服务。

### `ObservationRun`

每次成功打开观察去向时创建新的随机 `run`；同一 Pi 进程内的扩展重载复用进程级观察实例，不重新打开去向。
Pi session 可以跨进程恢复，因此 `run` 区分不同观察实例，`session` 只负责把相关记录关联到活动会话。

一个完整 run 的第一条记录是 `kind=state, stage=observe_run_start`，最后一条记录是
`kind=state, stage=observe_run_end`；两者使用 `mode=snapshot`，结束记录带 accepted/dropped 数量和写出该记录前
已知的 sink 状态，但不声称自身已经 flush/close。最终写入确认由进程退出后的 verifier 或读取者完成。进程崩溃、
写入失败、队列丢弃或缺少结束记录都表示证据不完整；不完整记录仍可提供线索，但其中
“没有出现某事件”不能作为结论。一个 run 可以先后观察多个 Pi session；每条记录的 `session` 只标识该记录发生时
的活动会话。

### 版本化记录

每行是一个 JSON 对象：

```json
{
  "schemaVersion": 1,
  "ts": "2026-08-18T14:31:02.187Z",
  "run": "a9a15e83-72da-4f6b-a2c3-2fcf87f4236e",
  "seq": 42,
  "session": "84c89b86012a6b77d7915f74d73cd305f60690e18bb5d1d765f77e11f9a82b86",
  "kind": "boundary",
  "stage": "client_http",
  "op": 7,
  "parentOp": 3,
  "data": {
    "phase": "begin",
    "method": "POST",
    "route": "/api/v1/content/batch-write"
  }
}
```

| 字段            | 契约                                                                                     |
| --------------- | ---------------------------------------------------------------------------------------- |
| `schemaVersion` | 正整数；记录形状或字段语义不兼容变化时递增                                               |
| `ts`            | 观察调用发生时的 ISO-8601 毫秒时间；只用于跨 run 的墙钟定位                              |
| `run`           | 本次观察 run 的随机 UUID                                                                 |
| `seq`           | run 内从 1 连续递增的写出顺序；只表达全序，不声称并发操作之间存在因果                    |
| `session`       | Pi session id 的域分隔 SHA-256；会话尚未建立时为 `null`                                  |
| `kind`          | `boundary`、`decision`、`state`、`failure` 之一                                          |
| `stage`         | 稳定的源码点位名，采用 `module_action`；重构行号不得改变其语义                           |
| `op`            | run 内操作号；`boundary` 必带，其他记录在属于某操作时携带                                |
| `parentOp`      | 可选的直接父操作号；只表达本进程内已知的调用关系                                         |
| `data`          | 由 `kind` 与 `stage` 的可执行白名单 schema 接受的诊断量                                  |

`session` 使用 `sha256(canonicalJsonBytes(["pi-openviking/observation-session", 1, piSessionId]))` 计算，使同一
会话可跨 run 关联而不落盘原始 session id。操作耗时使用单调时钟计算，不由两个 `ts` 相减得到。

## 四类必要记录

分类只保留四个彼此不能替代的调查问题：

| `kind`       | 回答的问题                     | 最小契约                                                                                         |
| ------------ | ------------------------------ | ------------------------------------------------------------------------------------------------ |
| `boundary`   | 与 Pi 或外部服务实际交互了什么 | `begin`/`end` 使用同一 `op`；`end` 必带 `outcome` 与 `durationMs`                                |
| `decision`   | 为什么选择了该后续路径         | 同时记录影响选择的安全输入量和选中的 `branch`                                                    |
| `state`      | 长生命周期状态是什么、何时变化 | `mode=change` 时带 `from`/`to`，`mode=snapshot` 时带当前值                                      |
| `failure`    | 哪个错误被内部吸收或转换       | 带安全的错误分类及 `disposition`：`degrade`、`retry`、`ignore` 或 `abort_operation`              |

### `boundary`

- OpenViking HTTP 请求和 Pi 生命周期 hook 分别使用自己的 stage schema，不共享不存在的字段。
- HTTP `begin` 记录固定 method、无参数 route 模板和超时；HTTP `end` 记录 outcome、耗时及实际存在的 status。
- OpenViking `traceId` 只在响应确实提供且符合长度和字符集约束时原样记录；网络失败时允许缺失。
- 每个 `begin` 至多有一个 `end`。正常关闭的完整 run 中不得留下未结束操作；崩溃 run 可以留下并据此定位在途步骤。

### `decision`

只观察会改变产品后续路径的判断：命名空间与 URI 边界、Content capability、ACK 推进或停止、recall 来源、
fail-open 选择及阶段规范明确要求的其他分支。普通循环条件、格式选择和不会改变结果的局部分支不设点位。

### `state`

只观察调查者必须跨步骤理解的长生命周期状态：连接、Content capability、ACK frontier、绑定命名空间以及后续
阶段引入的 Archive/checkpoint/`ActiveContext` 状态。状态变化时记录 `change`；会话就绪、`turn_end` 和正常
shutdown 各记录一次 `snapshot`，使单个 run 不依赖此前历史即可解释。

### `failure`

`failure` 的边界由错误语义决定，不由 `catch` 语法决定：异常或错误结果被吞掉、转换、重试或用于降级时，由承担
该决定的模块记录一次；原样向上抛出的错误由最终处理边界记录，途中不得重复。观察实现自身的失败只进入观察状态，
不得递归产生 `failure`。

## 覆盖规则

点位覆盖只从当前产品责任推导，不另建路径矩阵：

1. `AGENTS.md`“必须保持的系统保证”中涉及外部交互、拒绝、冲突、降级或状态推进的保证必须可由上述四类记录解释；
2. `verify:observability:live` 的 manifest 声明既有路径的预期 stage/outcome；后续 phase manifest 只声明该阶段新增
   或改变的观察责任，不追改已经关闭阶段的 manifest；
3. 新增或改变运行时路径时，同时观察成功结果和每条会改变产品行为的失败结果；
4. 同一事实只在承担该职责的模块观察一次，调用方不得从返回值反推被调用方内部过程。

## 字段与脱敏

脱敏采用可执行白名单，而不是对任意对象做黑名单过滤：

- `shared/observe.mjs` 为每个 `kind`/`stage` 声明允许的字段、类型、枚举、长度和可空性；未声明字段不得输出。
- 允许的数据只有有限数值、布尔、`null`、代码拥有的枚举、无参数 route 模板、协议已有 hash、计数/长度，以及
  通过格式校验的 OpenViking `traceId`。
- 原始 session/entry/user id、URI、HTTP path/query/header/body、prompt、模型输出、事件 payload、凭证和外部
  error message 一律禁止。必要身份使用域分隔 hash，URI 只记录 scope、归属判断和已有对象 hash。
- 错误只记录代码拥有的 `errorClass`/`errorCode`；未知外部错误归为 `other`，只附消息字节数，不附正文或摘要。
- 不为观察单独读取、复制或散列大型正文；只复用产品路径已经计算出的长度和 hash。
- 任一字段不符合 schema 时整条记录不写出，run 标记为不完整；原值不得出现在替代文本、错误信息或观察状态中。

顶层字段由统一实现生成并校验，调用点不能覆盖。上述限制同时适用于文件和 FD 去向。

## 去向、启停与失败语义

观察默认关闭，只接受一个去向：

| 去向             | 配置                      | 契约                                                                                 |
| ---------------- | ------------------------- | ------------------------------------------------------------------------------------ |
| 新文件           | `OV_OBSERVE=<path>`       | 父目录必须已存在；以 `wx`/`0600` 独占创建；不跟随已有文件或链接，不自动创建目录      |
| 继承文件描述符   | `OV_OBSERVE_FD=<3..999>`  | 必须指向大小为 0、属主为当前用户且 group/other 权限位为 0 的可写常规文件；进程不解析其路径 |

两个变量同时设置、配置非法或打开失败时，观察保持关闭并把原因保存为无敏感值的内存状态；不得抛出、回退到另一
去向或改变 Pi 行为。一个 sink 只承载一个 run，因此无需轮转、追加到旧文件或在记录中猜测进程边界。

统一实现使用单个有界队列和单个顺序 writer。运行时观察调用不得 `await`、抛出或同步写文件；队列满、序列化失败、
部分写或 writer 错误时立即停止接受新记录，并把 run 标记为不完整。正常 shutdown 只在产品已有的 shutdown 期限内
排空队列，不得新增独立等待预算。

关闭状态只执行一次启用判断，不触碰文件系统、不序列化、不散列，也不构造观察实现内部对象。调用点只能传递产品
路径已经拥有的值，不得在调用前执行仅供观察使用的昂贵计算。

统一实现暴露只读观察状态，供 `/viking` 与 live verifier 显示 `disabled`、`ready`、`incomplete` 及无敏感值的
reason code、accepted/dropped 数量。该状态只服务诊断和验收，任何产品决策不得读取它。

## 完整证据

只有同时满足下列条件的 run 才能证明某事件没有发生：

1. `observe_run_start` 与 `observe_run_end` 使用同一 schema 和 run，结束记录声明 dropped 为 0 且此前无 sink 错误；
2. `seq` 连续，所有非崩溃场景的 `boundary begin` 都有同 op 的唯一 `end`；
3. 读取者在进程退出后能完整解析 artifact；live verifier 从进程外确认 sink 写入、flush 与 close 没有错误；
4. workload 声明的预期 stage、branch、outcome 与状态快照全部出现；
5. 原始记录 hash 与 verifier summary 中保存的证据 hash 一致。

任一条件失败时，调查结论必须标为“证据不完整”，补足点位或修复去向后重新运行，不得从缺失记录推断业务原因。

## 代码放置与唯一性

- `shared/observe.mjs` 只负责 run、记录 schema、脱敏、队列、sink 和观察状态，不读取或推断业务状态。
- 点位位于承担该职责的模块内部并紧邻实际边界、判断或状态更新；观察调用不得成为条件、返回值或时序依赖。
- `OV_DEBUG_LOG` 等自由文本调试日志属于第二套观察点，统一实现落地时必须删除。
- `ov-observation` Pi entry 记录实际注入内容，是产品事实，不属于本标准。
- `scripts/e2e-probe.ts` 捕获原始 provider payload，是受 `docs/verification.md` 约束的测试证据，不得套用观察记录
  schema 或脱敏规则；它与观察实现只能共享无业务语义的私有 JSONL sink 能力。
- verifier 的 expected/actual/check 结果是断言产物，不是运行过程观察。

## 完成门

新增或改变运行时边界、路径判断、长生命周期状态或失败处置时，必须同时满足：

1. 相关 manifest 的成功标准与证伪条件能映射到最小必要 stage，没有为历史实现保留冗余点位；
2. 记录 schema、脱敏、禁用路径、sink 失败和关联规则通过 deterministic checks；
3. 相关 live gate 的成功与受控失败 workload 都产生完整 run，summary 保存允许的阶段/outcome 计数和证据 hash；
4. 观察记录没有进入 Pi JSONL 或 OpenViking，仓库中没有第二套运行过程观察。

纯文档、机械修改或不改变上述责任的重构不制造虚假点位和专用 live run；它们只需证明既有观察责任未被破坏。
问题调查先读取完整的实际记录；现有记录不足或不完整时，在任务授权范围内补点或修复输出后重新复现。
