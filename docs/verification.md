# 验证标准与测试组织

## 文档职责

**架构定位**：证明系统满足 [`docs/design.md`](./design.md) 所定义保证的证据标准。

**核心目标**：任何验证工作据此判断"什么证据算数"——证据的种类、测试的组织方式，以及真实边界验证必须
遵守的契约。

**职责边界**：本文说明证据如何取得、测试放在哪里，以及 live gate 必须记录什么。阶段验收结果见
[`docs/roadmap.md`](./roadmap.md)，模块职责和系统保证见 [`docs/design.md`](./design.md)，启动隔离服务与开发环境的方法见
[`docs/development.md`](./development.md)。

## 证据类型

验证分成两类，区别是测试是否真的启动 Pi 会话或调用 OpenViking。这个区别直接决定测试需要哪些环境、凭证和清理：

**不接触真实服务的检查**使用固定输入，只检查本仓库能够决定的逻辑，例如构造契约值、判断边界、格式化结果和
分类失败。它不能证明 Pi 或 OpenViking 实际会怎样响应。

**真实 Pi/OpenViking 运行**直接经过外部接口，用来确认 lifecycle、API、时序和失败时的实际行为。
`docs/design.md`「外部责任边界」中的事实只能由这类运行确认。

结论只要依赖 Pi 或 OpenViking 的实际行为，就必须经过真实运行；只依赖仓库自身逻辑的结果，放在 unit、contract
或 repo checks 中，不放进成本更高、重复性更弱的 live gate。

`docs/design.md`「验证责任」列出的运行测量记录本次实际数值，不把某一次结果当作永远不变的断言。
要证明两件事确实同时执行，同一次运行必须用单调时钟记录各自的开始和结束时间，并检查两个时间区间是否重叠。
要知道扩展增加了多少时间，先运行相同身份、相同 workload 的基线，再与目标运行比较；允许的差值写在对应 live
gate manifest 中。

## 测试组织

```text
test/
├── unit/        单个模块的返回值和状态
├── contract/    跨模块协作链路
├── repo/        仓库自身的事实：文档、清单、开发工具、gate manifest
├── live/        需要真实 Pi 或真实 OpenViking
│   ├── helpers/     live 专用共享骨架
│   └── <gate>/      verifier、workload manifest 与其固定 hash
├── fixtures/    测试输入数据
└── helpers/     不接触真实服务的测试共享代码
```

任意测试文件的归属由两个问题确定：

```text
需要真实 Pi 或 OpenViking？
├─ 是 → test/live/<gate>/
└─ 否 → 验证对象是什么？
        ├─ 单个模块的返回值或状态 → test/unit/<module>.test.mjs
        ├─ 多个模块的协作     → test/contract/<链路>.test.mjs
        └─ 仓库自身           → test/repo/<主题>.test.mjs
```

`unit/` 的文件名取自 `docs/design.md` 的模块名，`contract/` 取自「核心业务链路」的名字，使测试与架构
文档可双向对照。目录随第一个属于它的文件出现时创建。

`test/repo/` 同时承载 `docs/design.md`「源码组织」所述的依赖边界检查。

## live gate 契约

只有真实 Pi 或 OpenViking 才会表现出的 API 行为、时序和失败方式，由 live gate 验证；仓库自身能够决定的逻辑，
由 unit、contract 或 repo checks 验证。每个 live gate 以它要证明的行为命名，并遵守以下规则：

- **身份先行**：运行前列出 workload 实际接触的外部边界并逐一核对身份；Pi 边界核对版本与 CLI，OpenViking
  边界核对版本与 endpoint，发生模型调用时核对 provider 与 model。只接触 Pi 的 gate 不要求 OpenViking 就绪；任一
  所需身份不符时明确拒绝运行，不降级到其他 provider、账户或 endpoint；
- **manifest 固定**：把 gate 使用的输入、要检查的事件或结果、成功条件和失败条件写入 `<gate>/workloads.json`，
  并固定文件 hash；gate 运行期间不得修改这些内容。使用随机输入时记录 seed。需要与 baseline 比较时，再记录实测
  baseline、预期差异和通过阈值；baseline 与阈值必须来自基线探针的实际结果；
- **有界执行**：manifest 为每个进程、外部请求和等待点声明 timeout 与取消方式；超时形成明确失败并进入同一清理
  路径，gate 不依赖 Pi 为 extension factory、callback 或工具提供超时；
- **隔离运行**：使用 `docs/development.md` 提供的隔离服务与随机测试 namespace，不触碰用户数据；凭证只从
  环境读取，不写入输入、artifact 或 summary；
- **所有权证明**：远端写入前确认 namespace 不存在，写入含 run ID 与随机 nonce 的 ownership marker 并逐
  字节回读；删除前复核 marker 与写入一致，只删除该精确根路径；
- **清理即断言**：成功与失败都删除远端对象与本地运行目录，清理失败使 gate 失败；仓库长期保留 verifier
  与 manifest，不提交单次运行记录；
- **summary 可对照**：每项断言记录 expected 与 actual；数值比较再记录 delta。summary 还记录实际身份和证据 hash。
  只有全部必要断言通过且清理成功时，`passed` 才设为 true。`passed` 为 true 时进程退出码为 0，否则退出码非 0。

mock、内存 transport 和人工检查不能替代 live gate。workload 可以用固定脚本提供输入，但被测调用仍必须经过真实
Pi 或 OpenViking，并在 manifest 中写明脚本如何驱动调用。
