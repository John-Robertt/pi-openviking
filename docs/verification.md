# 验证策略与门禁契约

## 文档职责

**架构定位**：证明系统满足 [`docs/spec.md`](./spec.md) 所需证据的标准。

**核心目标**：任何验证工作据此判断“什么证据算数”——证据的种类、live verifier 必须遵守的契约，以及
各阶段门禁必须由机器断言的结果。

**职责边界**：本文只定义证据标准与门禁契约，不含阶段进度和下一步——那些由
[`docs/roadmap.md`](./roadmap.md) 维护。观察记录的形状与脱敏由
[`docs/observability.md`](./observability.md) 定义，本文只消费其产出。

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

固定轨迹承担回归基线职责；输入分布覆盖由生成场景、边界矩阵和真实样本共同提供。凡是断言模型上下文
容量、吞吐或安全余量的证据，token 数使用 Pi 或 provider 的实际计量，不以字符数估算替代；产品自身用于
划定事件范围的上下文权重是确定性策略量，由 `docs/spec.md` 定义，不属于该证据类别。模型输出允许非确定，
但事件对应、step 原子性、hash、容量和时序预算使用确定不变量验收。每个阶段只有在其四类适用证据共同通过
后才完成；实践结果改变理解时，先更新当前约束与验收场景，再继续实施。

Phase 3 使用多个彼此独立的真实 100k+ 工作负载完成固定模型组合的端到端验收，至少覆盖：多轮长工具循环与
并行成功/失败、单轮超长原子输入及大型 payload、分支/重启/Pi compaction。任务模型和 VLM 均使用
开发模型身份，每个 workload 至少独立重复三次。各工作负载均走 Archive、checkpoint 和
takeover 链路；固定 golden 回放只提供结果对照。

## 观察证据

观察记录支持上述四类证据，但不构成新的产品事实。其完整性与安全性按 `docs/observability.md` 判定，验证方法
固定如下：

- deterministic checks 以固定时钟、run/session/op 和输入向量校验 active stage registry 的 stage 唯一性、owner、kind、
  必需/允许字段及版本化 record；未知字段、原始 URI/path/error message、凭证和会话正文必须使记录被拒绝且不得出现
  在输出或错误状态；
- 两个观察变量均未设置时，以文件系统、时钟、序列化、hash、op 分配和逐记录构造依赖的调用计数证明初始化后均为 0；
  配置冲突、非法 FD、打开失败、队列满、部分写、stalled writer/close 和关闭错误只能产生 `incomplete`，并逐项比较
  产品返回值、状态和调用顺序与未观察基线一致；生产者未在 shutdown 期限内停止时不得生成完整 end；
- 同一组固定记录分别通过新文件和继承 FD 写出，规范 JSONL 字节必须一致；文件创建、FD owner/mode/size 与路径
  不可复用条件分别验证；
- 当前 observability manifest 引用 registry 的全部 active stage，并为成功和受控失败 workload 声明预期 branch/outcome
  与必要状态快照；verifier 逐 run 校验 start/end、accepted/dropped、连续 seq、boundary op/session 配对、观察状态和原始记录
  hash。子进程退出后由父进程同步并关闭其保留的 artifact FD，再读取最终字节；缺失、丢弃、写入、同步或关闭错误都使
  gate 失败；
- verifier 同时断言观察记录未进入 Pi JSONL 和 OpenViking 事件命名空间，并按 `docs/observability.md`“代码放置与唯一性”
  的边界检查生产运行路径没有第二套观察点。

原始观察 JSONL 只存在于 `test/.artifacts/live/{runId}`。summary 的 `observationRuns` 仅保留每个观察 run 的
schema version、run、seq 范围、stage/kind/outcome 计数、accepted/dropped、完整性结论与原始文件 hash，不保留
完整记录、URI、错误正文或会话内容；成功后原始文件随 verifier run 目录删除，失败诊断遵守下文相同的白名单与
清理规则。`scripts/e2e-probe.ts` 的原始 provider payload 是另一类验证输入，沿用自己的受限采集与清理契约，
不作为观察记录。

## 真实验收门禁

每个实施阶段交付一个由 `package.json` 暴露的 live verifier：`verify:phase0:live`、`verify:phase1:live`、
`verify:phase2a:live`、`verify:phase2b:live`、`verify:phase2c:live`、`verify:phase3:live` 和
`verify:phase4:live`；横切能力使用常驻的 `verify:observability:live`，其当前 manifest 覆盖 active stage 全集。阶段 gate
引用同一 registry，只增加本阶段 workload 的预期，不复制观察 schema；产品责任变化时更新当前 observability manifest，
已关闭阶段仍验证其现行产品保证，但不得要求已被替换或删除的观察点。一个入口可以组合多个聚焦脚本，但每个出口只
引用自己的入口。live verifier 是相应实现的一部分，mock、内存 transport、合成模型输出和人工检查不构成门禁替代品。
workload 内部允许以确定性脚本输入驱动被测行为（例如由脚本化 provider 固定触发一次工具调用），前提是被测
行为经过的真实边界——Pi lifecycle、hook 接线、OpenViking 与观察链路——不因此被替换，且驱动方式在 manifest
中声明。

所有 live verifier 使用同一契约：

manifest 中的精确依赖、服务和模型身份是可重放的最近验证快照，不是后续版本的支持上限。最低兼容边界由
`package.json` 等对应权威契约维护；后续版本默认向前兼容，实际 gate 发现破坏时再隔离和适配。

- 每个阶段和横切 observability gate 先提交 `test/live/{gate}.workloads.json` manifest，固定 workload/seed、适用版本与真实进程/
  端点身份、成功标准、证伪条件、证据提取方式和阈值决策规则；基线探针完成后，将 baseline、数值阈值
  与预期变化写入 manifest 并在实现前固定其 hash，运行时不能临时改变；
- 启动前连接并校验 manifest 声明的真实 Pi、OpenViking、provider/model、VLM、prompt 和协议身份，并核对
  运行中服务配置、状态指纹与开发模型 profile 一致；身份或配置不匹配时明确拒绝运行；
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
  均匹配同一精确根路径和 marker 字节时删除该 namespace；删除后越过服务端目录物化窗口，全部已写对象必须持续
  不存在；OpenViking 0.4.15 重建的无文件目录骨架只记录，不作为产品对象残留；
- 受管环境可执行中断/重启；远端破坏性测试需要显式 opt-in。清理前先生成脱敏测量与证据 hash，随后
  成功或失败都删除远端对象；清理失败使 gate 失败；
- 完成测量后，成功时删除整个本地 run 目录；失败时删除全部 raw payload，只保留字段白名单式脱敏诊断。
  任一本地删除失败同样使 gate 失败。仓库长期保留 verifier、workload manifest 和断言，不提交单次运行日志；
  需要跨阶段消费的 summary 作为同一 release run 的 CI artifact；
- 任一必要断言、观察点或清理失败即保持对应出口未通过，并由 expected/actual/delta 重新定位主导约束。
  各出口先实现自己的入口；出现第二个真实消费者后才提取共享 verifier 代码。

阶段 live gate 的职责如下：

| Gate     | 真实边界                                                                                                    | 必须由机器断言的结果                                                                                                        |
| -------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Observe  | 当前 Pi lifecycle、真实同步、受支持 OpenViking，以及受控断线、拒绝和冲突                                  | run 完整、op 配对、分支/状态/失败可还原、无敏感值和丢弃、记录不进入事实源且清理成立                                         |
| Phase 0  | 当前 Pi CLI/lifecycle、真实 `SessionManager`、受支持 OpenViking Content API；涉及模型调用时使用开发模型身份 | Pi JSONL → 全部 `RecordedEvent` → direct/chunked 对象 → entry ACK 逐项对应；重放、409、断线、shutdown 和清理成立            |
| Phase 1  | 受管 OpenViking 的 Archive 发布中断/客户端重启，以及多个真实 Pi workload 形成的 Archive                     | 原子可见、幂等恢复、确定 expand、event/step 边界和每种真实样本的 Archive 完整性成立                                         |
| Phase 2A | Phase 1 的各真实 Archive 与开发模型身份中的 VLM                                                             | checkpoint 来源/hash、失败重试、重启恢复和积压派生正确；实际 VLM 吞吐满足 manifest 阈值                                     |
| Phase 2B | 真实 Pi session、候选 checkpoint/raw tail 和开发模型身份中的 task-model 元数据；takeover 保持 inactive      | 候选 payload 可由源事件逐项重算，step/anchor 完整；Pi 报告容量在边界两侧分别 fit/mismatch                                   |
| Phase 2C | 真实 Pi `context` hook、开发模型身份中的 task provider、可控 OpenViking/VLM 降级及 Pi compaction            | 实际 provider 请求与 Phase 2B 候选 payload 一致；每个高水位只切换一次；分支/重启成立；降级时使用完整 Pi 上下文              |
| Phase 3  | 固定 task/VLM 组合和多个彼此独立的真实 100k+ workload；每个 workload 至少重复三次                           | 源事件到实际 provider 请求全链一致；实际 token、吞吐、延迟和容量安全余量满足 manifest 阈值，重复运行结论一致                |
| Phase 4  | 同一 release run 的 Phase 3 summary，以及在本次 namespace 重建的对应 events/Archive/checkpoint              | summary/manifest hash 匹配；索引就绪及重启后 search/browse/expand 返回预期身份和来源链；过滤、隐藏 raw event 隔离及清理成立 |
