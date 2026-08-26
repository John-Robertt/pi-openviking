# 验证标准与测试组织

## 文档职责

**架构定位**：证明系统满足 [`docs/design.md`](./design.md) 所定义保证的证据标准。

**核心目标**：任何验证工作据此判断"什么证据算数"——证据的种类、测试的组织方式，以及真实边界验证必须
遵守的契约。

**职责边界**：本文定义证据标准、测试组织与 gate 契约。各阶段验收哪些结果由
[`docs/roadmap.md`](./roadmap.md) 维护；模块职责与系统保证由 `docs/design.md` 维护；隔离服务与开发循环由
[`docs/development.md`](./development.md) 提供，本文只消费其能力。

## 证据类型

两类证据按**是否接触真实外部服务**区分。这个区别决定测试能在什么环境运行、需不需要凭证、失败后要不要
清理远端对象。

**Deterministic 证据**：固定输入产生固定结果，不接触真实 Pi 会话或 OpenViking 服务。它证明本仓库拥有的
逻辑——契约值的构造、边界判定、格式化与失败分类。它不能证明外部接口的实际行为。

**真实边界证据**：在真实 Pi lifecycle 与真实 OpenViking 上运行，证明外部接口的实际语义、时序与失败模式。
`docs/design.md`「外部责任边界」所述的机制只由这类证据确定，不由代码或文档转述推断。

任何断言外部行为的结论都需要真实边界证据，deterministic 证据不能替代。反之，能由 deterministic 证据
覆盖的逻辑不放进 live gate——真实边界运行成本高、可重复性弱，只承担它独有的部分。

`docs/design.md`「验证责任」列出的运行测量作为观察结果记录，不构成确定性断言。

## 测试组织

```text
test/
├── unit/        单个模块的公开结果
├── contract/    跨模块协作链路
├── repo/        仓库自身的事实：文档、清单、开发工具、gate manifest
├── live/        需要真实 Pi 或真实 OpenViking
│   ├── helpers/     live 专用共享骨架
│   └── <gate>/      verifier、workload manifest 与其固定 hash
├── fixtures/    测试输入数据
└── helpers/     deterministic 测试的共享代码
```

任意测试文件的归属由两个问题确定：

```text
需要真实 Pi 或 OpenViking？
├─ 是 → test/live/<gate>/
└─ 否 → 验证对象是什么？
        ├─ 单个模块的公开结果 → test/unit/<module>.test.mjs
        ├─ 多个模块的协作     → test/contract/<链路>.test.mjs
        └─ 仓库自身           → test/repo/<主题>.test.mjs
```

`unit/` 的文件名取自 `docs/design.md` 的模块名，`contract/` 取自「核心业务链路」的名字，使测试与架构
文档可双向对照。目录随第一个属于它的文件出现时创建。

`test/repo/` 同时承载 `docs/design.md`「源码组织」所述的依赖边界检查。

## live gate 契约

每条系统保证交付一个 live gate，以它验证的保证命名。全部 gate 遵守同一契约：

- **身份先行**：运行前核对 Pi 版本与 CLI、OpenViking 版本与 endpoint、模型身份；任一项不符时明确拒绝
  运行，不降级到其他 provider、账户或 endpoint；
- **manifest 固定**：workload、seed、输入与观察点、成功标准、预期变化、证伪条件与阈值写入
  `<gate>/workloads.json` 并固定其 hash，运行时不可临时改变；baseline 与阈值由基线探针的实测结果确定；
- **隔离运行**：使用 `docs/development.md` 提供的隔离服务与随机测试 namespace，不触碰用户数据；凭证只从
  环境读取，不写入输入、artifact 或 summary；
- **所有权证明**：远端写入前确认 namespace 不存在，写入含 run ID 与随机 nonce 的 ownership marker 并逐
  字节回读；删除前复核 marker 与写入一致，只删除该精确根路径；
- **清理即断言**：成功与失败都删除远端对象与本地运行目录，清理失败使 gate 失败；仓库长期保留 verifier
  与 manifest，不提交单次运行记录；
- **summary 可对照**：逐项记录 expected/actual/delta、实际身份与证据 hash；`passed` 只由全部必要断言与
  清理共同派生，退出码与之一致。

mock、内存 transport 与人工检查不构成 live gate 的替代品。workload 内部可以用确定性脚本输入驱动被测
行为，前提是被测行为经过的真实边界不因此被替换，且驱动方式在 manifest 中声明。
