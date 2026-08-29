# v0.5.0 当前开发计划

## 文档职责

本文是本分支当前开发计划的唯一来源。它只保留当前交付目标、尚未解决的差距、剩余阶段和下一行动入口；计划怎样建立、更新和结束，由 [Development Planning](./modules/development-planning.md) 规定。

## 当前交付目标与范围

当前版本交付 [系统设计](./design.md) 定义的 Pi 长期记忆扩展：Pi 在上下文压缩或切换 branch 后仍能看到历史线索，并能按线索找回当前记忆范围内的完整事实。

**交付单位是一个模块。** 一个阶段只做一个模块，把它的设计、实现和检查一次做完，再进入下一个模块。设计写不出机制的地方，正是实现会卡住的地方；两者放进同一阶段，每项设计决定都由紧随其后的实现和运行结果检验。

阶段内部按这个次序进行：

```text
设计达到 Documentation 的模块设计要求
  → 按设计实现模块公共入口
  → 运行该模块的必要检查
  → 运行结果与设计不一致时，先更新设计，再更新实现
```

计划的文档、文件和验证边界来自：

- [Documentation](./modules/documentation.md) 规定长期设计与当前计划的文档边界，以及[模块设计要求](./modules/documentation.md#模块设计要求)；
- [Project Structure](./modules/project-structure.md) 规定代码、测试、配置和产物的位置；
- [Verification](./modules/verification.md) 规定检查层次和完成条件。

当前范围交付系统设计已经确定的产品结果。各模块在自己的设计边界内决定数据来源、存储、索引、同步和生成算法，并把这些机制写进本模块设计；发布到远端或外部环境需要另行授权。

## 剩余差距

- **Pi Boundary**：已交付。`src/contracts/` 公共数据契约、`src/pi-boundary/index.ts`、`test/modules/pi-boundary/`（模块行为检查）与 `test/pi/`（真实 Pi 检查，`npm run test:pi`）全部通过；真实运行结果与设计一致，设计未改动。
- **Cue Provider**：需要交付 `docs/modules/cue-provider.md`、`src/cue-provider/index.ts` 和 `test/modules/cue-provider/`。设计要写明线索的来源、生成算法、保存形式、缓存、准备进度、预算不足时的取舍和 `RecallHandle` 的编码。
- **Retriever**：需要交付 `docs/modules/retriever.md`、`src/retriever/index.ts` 和 `test/modules/retriever/`。
- **Assembly**：需要交付 `docs/modules/assembly.md` 和 `src/assembly/index.ts`，并把 `src/index.ts` 接到装配结果上；`src/index.ts` 当前是一个空的 Pi 扩展入口函数。
- **验证**：`npm test` 运行类型检查与 `test/modules/` 下的模块行为检查；`npm run test:pi` 运行真实 Pi 检查。还需要建立两项：[Documentation](./modules/documentation.md#验证与演进) 要求的文档入口、覆盖与链接检查，以及 [Project Structure](./modules/project-structure.md#验证与演进) 要求的文件位置与导入边界检查。两项都不依赖运行模块，可以独立于模块阶段进行。

## 剩余阶段

| 阶段 | 前置条件 | 交付结果 | 进入下一阶段的条件 |
| --- | --- | --- | --- |
| Cue Provider | Pi Boundary 交付 `ScopedFacts` 和公共数据契约 | `docs/modules/cue-provider.md`；`src/cue-provider/index.ts`；`test/modules/cue-provider/` | Cue Provider 的模块行为检查全部 `passed`，影响交付结果和失败行为的机制都写在设计中 |
| Retriever | Cue Provider 确定 `RecallHandle` 的编码与事实来源 | `docs/modules/retriever.md`；`src/retriever/index.ts`；`test/modules/retriever/` | Retriever 的模块行为检查全部 `passed`，`found`、`notFound`、`rejected`、`unavailable` 各有产生条件和检查 |
| Assembly | 四个模块的公共入口稳定 | `docs/modules/assembly.md`；`src/assembly/index.ts`；`src/index.ts` 接线；`test/integration/` | [Pi Boundary 的跨模块检查](./modules/pi-boundary.md#跨模块检查)与真实 Pi 端到端全部 `passed`，扩展在真实 Pi 中完成线索展示与事实找回 |

Pi Boundary 阶段用 [Verification 规定的受控替身](./modules/verification.md#验证层次位置与命令)代替 Cue Provider 和 Retriever。替身留在 `test/`，产品代码只包含各阶段已经交付的实现。

## 当前阶段与下一行动

当前阶段是 **Cue Provider**。Pi Boundary 已经交付 `MemoryScope`、`ScopedFacts`、`CueSet`、`RecallHandle`、`RetrievedContent` 的公共数据契约和 `CueProvider`、`Retriever` 公共接口，Cue Provider 的前置条件齐备。

下一行动是编写 `docs/modules/cue-provider.md`：写明线索的来源、生成算法、保存形式、缓存、准备进度、预算不足时的取舍和 `RecallHandle` 的编码，达到 [Documentation 的模块设计要求](./modules/documentation.md#模块设计要求)；然后按设计交付 `src/cue-provider/index.ts` 与 `test/modules/cue-provider/`。

## 计划完成条件

本计划按 [Development Planning 的完成条件](./modules/development-planning.md#完成条件与生命周期)和 [Verification 的完成条件](./modules/verification.md#完成条件与依赖)结束。全部条件满足后，没有下一项已经确认的版本目标就删除本文；有下一项目标就直接替换为新的当前计划。
