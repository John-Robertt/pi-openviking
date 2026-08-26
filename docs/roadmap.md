# 实施路线与当前状态

## 文档职责

**架构定位**：[`docs/design.md`](./design.md) 定义的目标架构与实现现状之间的路径。

**核心目标**：接手工作的人立即知道三件事——现在在哪、下一步做什么、这一步做完的判定标准是什么。

**职责边界**：本文维护阶段划分、实施状态、各阶段验收判定和下一实施入口。目标架构、模块职责与数据契约由
`docs/design.md` 维护，本文只引用不复制；证据类型与 live gate 契约由
[`docs/verification.md`](./verification.md) 维护。本文随每次
工作推进更新，因而与架构规范分离——使进度变化与架构变化在评审中始终可区分。

## 实施状态

「运行边界与观察」出口已关闭：扩展在真实 Pi 完成加载、会话与 shutdown；fail-open 边界、结构化
observation 与 config 首个消费者（观察请求）已落地；deterministic 测试与 run-boundary live gate 全部
通过。当前阶段为「Pi 原生记忆接入」，主导约束与下一步动作见「下一实施入口」。

## 阶段路径

每个阶段以它建立的系统能力命名，落地 `docs/design.md` 中一个模块的完整责任或该模块的一部分责任。阶段只
消费已通过验收的上游结果；模块的架构定位、核心目标、业务需求与职责边界由 `docs/design.md` 维护，阶段不
重新定义。各阶段的「系统保证」是 `docs/design.md`「全局系统保证」在该阶段的切片，随后者变化同步核对。

顺序由依赖决定：运行边界与观察是横切能力，先于其余阶段建立并被它们共同消费；Pi Adapter 先接入 Pi 已接受的
来源 entries、compaction 与当前 context，使后续模块直接复用 Pi 的 session tree；OpenViking Client 是唯一出站
端口，其真实调用语义决定同步机制；同步产生已接受历史，是 cue 与工具的共同前提；cue 是本项目身份所在，先于
工具建立，使工具的参数面由真实消费者驱动。降级由运行边界与观察建立，并作为其后每个阶段的验收项。

| 阶段 | 建立的系统保证 | 落地的模块责任 |
| --- | --- | --- |
| 运行边界与观察 | 扩展失败不影响 Pi 主任务，每次运行留下可关联证据 | Observation、Configuration & Credentials、Composition Root |
| Pi 原生记忆接入 | 来源事实与 Memory Cues 复用 Pi 原生 session tree 和 context 语义 | Pi Adapter（entries、compaction、context） |
| OpenViking 出站端口 | ingest/search/read 通过窄接口完成，每次调用绑定不可变范围 | OpenViking Client、`OperationScope` |
| 会话事实同步 | 每个 Pi 已接受事实最终被 OpenViking 接受且可重放 | Fact Synchronizer |
| Compaction 记忆线索 | compaction 后模型上下文出现少量稳定的相关历史线索 | Cue Provider、Pi Adapter（custom entry 与 context） |
| 历史细节恢复 | 模型可取回精确历史细节，且参数无法越权 | Pi Adapter（模型工具） |
| 本地服务托管 | 本地 OpenViking endpoint 可安全、可重建地提供 | Managed OpenViking Service |

### 运行边界与观察

**系统保证**：扩展在真实 Pi 中加载与卸载；任一扩展链路失败时 Pi 主任务继续运行；每次运行留下可关联、
已脱敏的结构化证据。

**交付**

- 完成 `docs/design.md`「Observation」与「Configuration & Credentials」的责任、「状态所有权」定义的
  Composition Root 装配，以及「1. Pi Adapter」的 fail-open 保证；
- 最小 `package.json` 与构建配置：只声明当前扩展入口、运行时要求与实际使用的依赖；
- [`docs/verification.md`](./verification.md)：证据类型、测试组织与 live gate 契约；
- `docs/development.md`：开发环境、开发循环与清理，含其余阶段所需 OpenViking endpoint 的获得方式。

**验收**

- 真实 Pi 加载扩展、完成一次会话并正常 shutdown；
- 在扩展各注册点分别注入失败后，Pi 的 agent loop、context 与 compaction 行为与未加载扩展时一致；
- 同一次运行的观察记录可按 operation 关联出完整调用序列；未请求观察时初始化后不产生时钟、序列化与
  文件系统调用；
- sink 或 schema 失败只使观察状态降级，产品返回值与调用顺序不变；
- 观察记录中不出现用户正文、图片 base64、凭证与未脱敏 URI；
- 仓库中不存在第二套运行过程观察。

### Pi 原生记忆接入

**系统保证**：Pi 已接受的来源 entries 直接进入事实交付边界；每次 compaction 产生的 `CueSet` 由 Pi session tree
保存，并在普通 provider context 中呈现，同时保持在后续 compaction 输入之外。

**交付**

- 完成 `docs/design.md`「1. Pi Adapter」的来源 entry 读取、`session_compact` 消费、CueSet custom entry 保存与
  context 临时投影责任；
- 建立本阶段 Pi live gate，以固定 `CueSet` 驱动真实 Pi tree、context 与 compaction 边界。

**验收**（对应 `docs/design.md`「验证责任」的 Pi 契约）

- 持久 session 与 in-memory session 中，Pi Adapter 取得的来源 entries 保持 Pi 已接受的原始值与顺序，扩展自身的
  `CueSet` custom entry 保持在来源事实集合之外；
- 真实 Pi compaction 完成后，`CueSet` 作为 custom entry 保存在当前 tree 路径，普通 provider payload 可见其文本；
- 后续 compaction 的 preparation 中没有既有 `CueSet` 文本，新 compaction 后的普通 provider payload 只呈现 Pi
  当前 context entries 中有效的 `CueSet`；
- `/tree` 导航、session 重开与扩展重载后，Pi Adapter 直接使用 Pi 当前构造的 context entries，tree 导航本身不
  生成或改写 `CueSet`；
- 以上读取、保存或投影失败时 Pi agent loop、原生 context 与 compaction 继续运行。

### OpenViking 出站端口

**系统保证**：ingest、search 与 read 通过一个稳定、可诊断、可取消的窄接口完成，每次调用绑定不可变
`OperationScope`。

**交付**

- **边界调查先行**：在真实 OpenViking 实例上确定 ingestion、search 与 read 各自使用的公开能力、接受语义与
  幂等条件，把结论固定为本阶段的实现依据；
- 完成 `docs/design.md`「4. OpenViking Client」与「OperationScope」的责任；有界重试只用于调查已证明幂等的
  调用。

**验收**

- ingestion、search 与 read 的接受语义与幂等条件由真实实例上的运行记录固定，不由代码推断；被证伪的候选
  机制一并记录；
- 同一来源事实按调查确定的机制重复 ingest 得到明确接受结果，不产生第二个逻辑对象；
- search 返回结果保留服务端排名与服务端提供的 title/abstract 等价字段；read 按 canonical URI 与分页边界
  返回，越界请求被拒绝；
- 服务不可用、超时与取消各自返回有界失败结果并保留可区分的 cause，调用方不阻塞；
- 凭证不出现在观察记录、错误消息、状态输出与任何 artifact 中；
- 请求构造完成后其 scope 不可变。

### 会话事实同步

**系统保证**：每个 Pi 已接受的会话事实最终被 OpenViking 接受；外部失败保持在扩展边界内。

**交付**

- 完成 `docs/design.md`「2. Fact Synchronizer」的责任。

**验收**（对应 `docs/design.md`「验证责任」的 ingestion 契约）

- 一次真实会话结束后，Pi Adapter 提供的每个来源 entry 都有明确的接受或待重放结果；
- 从 OpenViking 读回的对象可逐字节还原为原始 Pi entry；
- 交付进度只在 OpenViking 明确接受后推进；接受结果丢失时该事实保持待重放；
- 进程重启、交付状态删除与重复提交后重放，OpenViking 侧不产生重复或半可见对象；
- OpenViking 不可用期间 Pi 主任务、compaction 与 shutdown 时长不受影响，服务恢复后未交付事实完成交付。

### Compaction 记忆线索

**系统保证**：每次 Pi compaction 对应一份提交后保持不变的 `CueSet`；Pi session tree 保存它，普通 provider
context 呈现它，后续 compaction 输入排除它。

**交付**

- 完成 `docs/design.md`「3. Cue Provider」的责任；
- 完成「1. Pi Adapter」的 CueSet custom entry 提交与普通 provider context 投影。

**验收**（对应 `docs/design.md`「验证责任」的 Cue 契约）

- 真实 Pi compaction 完成后只执行一次成功的 OpenViking search，产生一个 `CueSet` custom entry，provider 实际
  收到的 payload 中出现其文本；
- 同一 compaction 下重复触发 context 不再搜索，两次得到逐字节相同的 `CueSet`；
- Pi tree 导航、session 重开与扩展重载复用当前路径中的既有 `CueSet`，这些动作不触发搜索；只有新的
  `CompactionEntry` 产生新的搜索与 `CueSet`；
- 后续 compaction 的 preparation 不含既有 `CueSet` 文本，完成后普通 provider payload 只呈现当前有效的
  `CueSet`；
- 候选顺序与 OpenViking 返回顺序一致；候选数量与总字符落在固定上限内；
- 每条线索的文本非空，服务端摘要缺失时返回可诊断失败；
- `CueSet` 中不含正文、URI、entry ID 与分数；
- 无相关候选提交空 `CueSet`；OpenViking 失败返回可诊断空结果，Pi 原生上下文与 agent loop 继续。

### 历史细节恢复

**系统保证**：模型可通过 search 与 read 取回精确历史细节；工具参数无法越过当前 Pi 与授权身份形成的调用范围。

**交付**

- 完成 `docs/design.md`「1. Pi Adapter」的模型工具注册、scope 组合与 tool result 映射。

**验收**（对应 `docs/design.md`「验证责任」的工具契约与安全契约）

- 真实 Pi 中模型调用 search 与 read 得到可用结果；文本与图片分别映射为 Pi 的 TextContent 与 ImageContent
  并进入 Pi 原生上下文；
- read 的分页与读取范围受上限约束，越界请求被拒绝；
- 工具参数中携带的 session identity 或授权范围字段不改变实际调用范围，以真实越界尝试证明；
- 工具调用失败返回可诊断的工具结果，agent loop 继续；
- 注册的工具集合只有 search 与 read。

### 本地服务托管

**系统保证**：需要本地托管的用户可以安全、可重建地获得 OpenViking endpoint。

本阶段不进入核心链路顺序。核心链路各阶段所需的 endpoint 由开发环境提供，见
[`docs/development.md`](./development.md)。

**交付**

- 完成 `docs/design.md`「Managed OpenViking Service」的责任；
- `docs/usage.md`：面向最终用户和服务操作者的产品说明。

**验收**（对应 `docs/design.md`「验证责任」的 Managed Service 契约）

- 在未预装依赖的机器上按声明工具链完成 setup，并启动到 OpenViking 官方 readiness；
- status 与 doctor 报告的进程、端点与数据位置与实际一致；
- stop 后由 ownership marker、state、PID 与进程身份共同证明本模块启动的进程与临时状态已清理；
- 非本模块启动的同名进程不被停止；
- 凭证不出现在日志、状态文件与观察记录中。

## 阶段执行闭环

每个阶段的实现依据由真实运行结果建立，并按同一循环执行：

1. 记录当前可重现现象与目标差距，并建立阶段 manifest；manifest 的字段与 hash 要求见
   [`docs/verification.md`](./verification.md)「live gate 契约」；
2. 对真实边界运行最小基线探针，用观察记录收集足以区分候选机制的证据，把实测 baseline 与预期变化写回
   manifest；
3. 选择当前主导约束，实现能闭合该约束的最小结构，先运行聚焦 deterministic checks；
4. 运行阶段 live gate，把结果与 baseline 和预期变化逐项比较；结果偏离预期时回到第 1 步重新调查并重新
   识别主导约束；
5. deterministic checks、live gate 与文档自检共同通过后关闭阶段出口，并更新本文的实施状态。

证据类型与 live gate 契约见 [`docs/verification.md`](./verification.md)。阶段出口关闭后，下一阶段才可
消费其结果。

## 下一实施入口

当前主导约束是：Pi Adapter 目前只建立了 session lifecycle 与 fail-open 边界；来源 entry 读取、compaction 后
CueSet custom entry 保存和普通 provider context 投影尚未进入当前实现与阶段 gate。真实 Pi 探针已经确认 custom
entry 由 session tree 保存、普通 context 临时投影可见且后续 compaction preparation 排除该内容。

后续动作按以下顺序执行：

1. 建立本阶段 manifest，以真实 Pi 覆盖持久与 in-memory session、manual/threshold/overflow compaction、tree 导航、
   session 重开和扩展重载；
2. 实现 Pi Adapter 的来源 entry 读取与过滤、`session_compact` 消费、CueSet custom entry 保存和 context 临时投影；
3. 建立聚焦 deterministic checks 并运行本阶段 live gate，按「Pi 原生记忆接入」验收项逐项取证。
