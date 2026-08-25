# 全局可观测性标准

## 文档职责

**架构定位**：观察点是系统运行过程的诊断证据接口；本文是该接口的唯一权威契约。

**核心目标**：对一次边界明确的真实运行，调查者能够回答三件事——发生了什么、为什么走到该结果、证据是否
完整可信——并找到实际结果最早偏离预期的位置。

**职责边界**：本文定义观察记录的语义、关联、安全、输出和完成条件，不定义产品事实、业务决策或阶段进度。
持久事实由 Pi JSONL 与产品对象承载，实施进度由 [`docs/v1/roadmap.md`](./roadmap.md) 维护，证据方法与 live gate
由 [`docs/v1/verification.md`](./verification.md) 维护，调查命令由 [`docs/v1/development.md`](./development.md) 维护。

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

每次成功打开观察去向时创建新的随机 `run`；同一 Pi 进程内的扩展实例复用进程级观察 runtime 和 sink，不重新打开去向。
每个扩展实例持有自己的 session producer，`bindSession` 只改变该 producer 后续记录的归属；boundary 在 begin 时固定
session。`session_shutdown` 只注销当前 producer；`new`、`resume`、`fork` 与 `reload` 保持 run 开放给随后绑定的新扩展
实例，`quit` 由最后一个 producer 通过进程 runtime 在 shutdown deadline 内封存，`beforeExit` 只为异常清理路径兜底。Pi session 可以跨进程恢复，
因此 `run` 区分不同观察实例，`session` 只负责把相关记录关联到对应会话。

一个完整 run 的第一条记录是 `kind=state, stage=observe_run_start`，最后一条记录是
`kind=state, stage=observe_run_end`；两者使用 `mode=snapshot`。结束记录中的 `accepted` 是从 start 到结束记录入队前
成功进入队列的记录数（包含 start、不包含 end），`dropped` 是从 run 创建到 finalization 开始前，因 schema、队列或
不完整状态而未能入队的记录尝试数；观察未启用时及 `finish` 完成后的调用位于该 run 边界之外，不计数。两者都是非负整数；end 成功入队后，只读状态中的 `accepted` 比该记录
携带的值大 1。结束记录同时带入队前已知的 sink 状态，但不声称自身已经 flush/close。最终写入确认由进程退出后的
verifier 或读取者完成。进程崩溃、写入失败、队列丢弃或缺少结束记录都表示证据不完整；不完整记录仍可提供线索，
但其中“没有出现某事件”不能作为结论。一个 run 可以先后观察多个 Pi session；每条记录的 `session` 只标识该记录
发生时的活动会话。

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
| `failure`    | 哪个错误被内部吸收或转换       | 带安全错误分类和 `disposition`（`degrade`/`retry`/`ignore`/`abort_operation`）；具体产品路径同记录带 `branch` |

### `boundary`

- OpenViking HTTP 请求和 Pi 生命周期 hook 分别使用自己的 stage schema，不共享不存在的字段。
- HTTP `begin` 记录固定 method、无参数 route 模板和超时；HTTP `end` 记录 outcome、耗时及实际存在的 status。
- OpenViking `traceId` 只在响应确实提供且符合长度和字符集约束时原样记录；网络失败时允许缺失。
- 每个 `begin` 至多有一个 `end`。正常关闭的完整 run 中不得留下未结束操作；崩溃 run 可以留下并据此定位在途步骤。

### `decision`

只观察会改变产品后续路径的判断：命名空间与 URI 边界、Content capability、ACK 推进或停止、recall 来源及阶段
规范明确要求的其他分支。错误处置已经由同一条 `failure` 的 `disposition`/`branch` 完整表达时不再记录 `decision`；只有
错误之外的安全输入共同决定分支时才增加 `decision`。普通循环条件、格式选择和不会改变结果的局部分支不设点位。
`active_context_eligibility` 同时记录 provider `payload`、完整来源 `pressure` 与省略事件/权重；
`active_context_takeover` 在 `branch` 之外记录替换前后的 provider payload、完整来源 `pressure` 与容量，
使“从哪一步开始偏离预期”可以沿 payload/pressure 重算；`branch=reference_context` 表示 provider 使用 checkpoint
身份引用，此时 `selectedPayload` 必须小于 `previousPayload`。`archive_retrieval` 只记录
`list/index/direct/chunk` 分支及 requested/emitted/total 计数，不记录查询、内容、事件或 URI。`retrieval_index` 只记录
`raw_event`/`checkpoint` 来源类型与成功记录数，没有新增记录时不发空点位；`retrieval_index_failure` 只记录安全错误分类、来源类型和下次同步重试分支。
`archive_failure` 的 `return_error` 分支表示显式回读（expand）失败已作为错误文本返回给调用方，不携带 committed/pending 计数。

### `state`

只观察调查者必须跨步骤理解的长生命周期状态：连接、Content capability、ACK frontier、绑定命名空间以及后续
阶段引入的 Archive/checkpoint/`ActiveContext` 状态。状态首次绑定时记录 `snapshot`，随后只记录 `change`，正常
session 结束或 shutdown 再记录最终 `snapshot`。`turn_end` 只有在当前 manifest 需要且该事实不能由初始值与 change
流推出时才增加快照。

### `failure`

`failure` 的边界由错误语义决定，不由 `catch` 语法决定：异常或错误结果被吞掉、转换、重试或用于降级时，由承担
该处置的模块记录一次；`disposition` 记录处理方式，处置选择具体产品路径时由同一记录的 `branch` 表达，不得再为同一事实
增加 `decision`。原样向上抛出的错误由最终处理边界记录，途中不得重复。观察实现自身的失败只进入观察状态，不得递归
产生 `failure`。

## 覆盖规则

点位覆盖只从当前产品责任推导，不另建路径矩阵。本文定义语义和推导规则，现行点位明细只保留一份：

1. 当前产品责任来自 `docs/v1/spec.md`；`docs/v1/roadmap.md` 的实施状态排除尚未落地的目标，`docs/v1/design.md` 与生产代码确认
   已存在的行为及其责任模块，`AGENTS.md` 只提供编码代理工作指引，不作为观察契约来源；
2. `shared/observe.mjs` 的 stage registry 是现行点位的唯一机器可读清单；每个 stage 只声明一个 owner、kind、必需/允许
   字段与有限 outcome，调用点和 verifier 都引用该清单，不另写一份 schema；
3. `verify:observability:live` 的当前 manifest 引用 registry 中全部现行 stage：稳定经过真实产品边界的 stage 由 workload
   `expectedRecords` 声明 branch/outcome，其余内部 failure stage 登记在 `deterministicStages` 并由实际记录测试覆盖；两类
   集合与 registry 双向一致且互不重叠。阶段 manifest 只增加该阶段 workload 的预期，不拥有完整点位清单；
4. 产品责任新增、改变、替换或删除时同步更新 registry 与当前 observability manifest；旧定义只留在版本历史和既有
   artifact，不得继续约束现行点位；
5. 新增或改变运行时路径时，同时观察成功结果和每条会改变产品行为的失败结果；
6. 同一事实只在承担该职责的模块观察一次，调用方不得从返回值反推被调用方内部过程。

## 字段与脱敏

脱敏采用可执行白名单，而不是对任意对象做黑名单过滤：

- stage registry 中的字段 schema 采用白名单，声明类型、枚举、长度和可空性；未声明字段不得输出。
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
| 继承文件描述符   | `OV_OBSERVE_FD=<整数>`     | 值必须为十进制整数且不小于 3；FD 必须指向大小为 0、属主为当前用户且 group/other 权限位为 0 的可写常规文件；进程不解析其路径 |

两个变量均未设置时状态为 `disabled`，reason 为 `not_requested`。进程初始化只判断一次变量是否存在并绑定 no-op；此后
观察调用不触碰文件系统，不读取时钟，不序列化、散列、分配 op 或构造逐记录数据。调用点只能传递产品路径已经拥有的
值，不得在调用前执行仅供观察使用的计算。固定的只读 disabled 状态不属于逐记录工作。

任一变量存在即表示请求观察。两个变量同时设置、值非法或打开失败时状态为 `incomplete`，只保存无敏感值的 reason；
一次性校验或打开可以执行该去向必需的系统调用，但不得抛出、回退到另一去向或改变 Pi 行为。成功打开后状态为
`ready` 并创建 run。一个 sink 只承载一个 run，因此无需轮转、追加旧文件或在记录中猜测进程边界。

统一实现使用单个有界队列和单个顺序 writer。运行时观察调用不得 `await`、抛出或同步写文件；队列满、序列化失败、
部分写或 writer 错误时转为 `incomplete`，停止接受新记录并按 `ObservationRun` 定义累计 dropped。writer 在产品 shutdown 工作期间
继续排空；调用方先停止会产生记录的健康检查、同步和 transport，再固定产品状态推进、取消与 close 结果。观察随后只能使用
既有 shutdown 期限的剩余时间写入 end、排空并关闭 sink，不得缩短或延长产品操作的期限，也不得改变其顺序、返回值或
结果。已知生产者未在期限内停止时不得写入 end；flush 或 close 时间不足同样只使观察状态不完整，不新增等待预算。

统一实现暴露只读观察状态，供 `/viking` 与 live verifier 显示 `disabled`、`ready`、`incomplete` 及无敏感值的
reason、accepted/dropped 数量。该状态只服务诊断和验收，任何产品决策不得读取它。

## 完整证据

只有同时满足下列条件的 run 才能证明某事件没有发生：

1. `observe_run_start` 与 `observe_run_end` 使用同一 schema 和 run；结束记录声明 `accepted=end.seq-1`、`dropped=0` 且此前无 sink 错误；
2. `seq` 连续，所有非崩溃场景的 `boundary begin` 都有同 op、同 session 的唯一 `end`；
3. 读取者在进程退出后能完整解析 artifact；live verifier 从进程外确认 sink 写入、flush 与 close 没有错误；
4. workload 声明的预期 stage、branch、outcome 与状态快照全部出现；
5. 原始记录 hash 与 verifier summary 中保存的证据 hash 一致。

任一条件失败时，调查结论必须标为“证据不完整”，补足点位或修复去向后重新运行，不得从缺失记录推断业务原因。

## 代码放置与唯一性

- `shared/observe.mjs` 只负责 active stage registry、run、记录 schema、脱敏、队列、sink 和观察状态，不读取或推断业务状态。
- 点位位于承担该职责的模块内部并紧邻实际边界、判断或状态更新；观察调用不得成为条件、返回值或时序依赖。
- 任何以复原运行过程为职责、写到统一 sink 之外的持久或进程外输出都是第二套观察点，包括 `OV_DEBUG_LOG`、自由文本
  文件日志、stderr debug 和 logger transport，统一实现落地时必须删除。只呈现当前产品结果且不承担过程复原的用户
  通知、配置错误和 `/viking` 状态不属于第二套观察点。
- `ov-observation` Pi entry 只记录注入发生的 provenance（类型、目标 entry、内容 hash 与字符数），是产品事实，不属于本标准；
  实际注入正文不回写 Pi 事件链。
- `scripts/e2e-probe.ts` 捕获原始 provider payload，是受 `docs/v1/verification.md` 约束的测试证据，不得套用观察记录
  schema 或脱敏规则；它与观察实现只能共享无业务语义的私有 JSONL sink 能力。
- verifier 的 expected/actual/check 结果是断言产物，不是运行过程观察。

## 完成门

新增或改变运行时边界、路径判断、长生命周期状态或失败处置时，必须同时满足：

1. 当前 observability manifest 的成功标准与证伪条件覆盖每个 active stage，registry 不含没有当前产品责任或消费者的点位；
2. 记录 schema、脱敏、禁用路径、sink 失败和关联规则通过 deterministic checks；
3. 相关 live gate 的成功与受控失败 workload 都产生完整 run，summary 保存允许的阶段/outcome 计数和证据 hash；
4. 观察记录没有进入 Pi JSONL 或 OpenViking，仓库中没有第二套运行过程观察。

纯文档、机械修改或不改变上述责任的重构不制造虚假点位和专用 live run；它们只需证明既有观察责任未被破坏。
问题调查先读取完整的实际记录；现有记录不足或不完整时，在任务授权范围内补点或修复输出后重新复现。
