# v0.5.0 当前开发计划

## 文档职责

本文是本分支当前开发计划的唯一来源。它只保留当前交付目标、尚未解决的差距、剩余阶段和下一行动入口；计划怎样建立、更新和结束，由 [Development Planning](./modules/development-planning.md) 规定。

## 当前交付目标与范围

当前版本交付 [系统设计](./design.md) 定义的 Pi 长期记忆扩展：Pi 在上下文压缩或切换 branch 后仍能看到历史线索，并能按线索找回当前记忆范围内的完整事实。

计划的文档、文件和验证边界来自：

- [Documentation](./modules/documentation.md) 规定长期设计与当前计划的文档边界；
- [Project Structure](./modules/project-structure.md) 规定代码、测试、配置和产物的位置；
- [Verification](./modules/verification.md) 规定检查层次和完成条件。

当前范围只交付系统设计已经确定的产品结果。各模块在自己的设计边界内决定数据来源、存储、索引、同步和生成算法；发布到远端或外部环境需要另行授权。

## 剩余差距

- Observation、Cue Provider、Retriever 和 Assembly 还没有各自能够独立指导实现的模块设计。
- `src/index.ts` 只有 Pi 扩展函数入口，尚未建立公共契约、运行模块和装配行为。
- `test/` 尚未建立；`npm test` 目前只运行类型检查，真实 Pi 验证入口尚未实现。
- 系统设计规定的线索准备、上下文展示、完整事实找回、范围切换、关闭处理和失败隔离尚未由运行代码交付。

## 剩余阶段

| 阶段 | 前置条件 | 交付结果 | 进入下一阶段的条件 |
| --- | --- | --- | --- |
| 完成功能与支撑模块设计 | 系统设计、[Pi Boundary](./modules/pi-boundary.md)、Documentation、Project Structure、Verification 和 Development Planning 已确定 | 依次完成 Observation、Cue Provider、Retriever 和 Assembly 的独立设计 | 每份设计回答 Documentation 规定的问题，模块交接和依赖方向与系统设计一致 |
| 建立公共契约与模块入口 | 全部模块设计完成 | 公共数据类型、各源码模块公共入口和对应验证结构 | 静态检查通过，公共入口只暴露调用方需要的结果 |
| 交付模块行为 | 公共契约和入口稳定 | Observation、Cue Provider、Retriever 和 Pi Boundary 分别交付设计规定的正常与失败结果 | 模块行为检查通过，模块之间只通过公共入口依赖 |
| 完成装配与跨模块链路 | 各模块行为能够独立验证 | Assembly 组合兼容实现，线索展示与事实找回链路完整 | 跨模块集成检查通过，失败不影响 Pi 原生流程 |
| 通过真实 Pi 验证并收尾 | 集成链路通过 | 生命周期、上下文、session、branch、工具、关闭和重载行为得到真实运行确认 | Verification 的全部完成条件满足，剩余差距和临时内容清零 |

## 当前阶段与下一行动

当前阶段是“完成功能与支撑模块设计”。剩余顺序是 Observation、Cue Provider、Retriever、Assembly。每份设计直接使用系统设计和已完成模块设计中的边界，只说明本模块交付什么、接收什么和负责什么。

下一行动是建立 `docs/modules/observation.md`。设计根据系统设计和 [Pi Boundary](./modules/pi-boundary.md) 的单向事件边界，说明 Observation 接收什么、记录什么、禁止记录什么、首次写入失败后怎样停止后续写入，以及怎样验证这些结果。

## 计划完成条件

本计划按 [Development Planning 的完成条件](./modules/development-planning.md#完成条件与生命周期)和 [Verification 的完成条件](./modules/verification.md#完成条件与依赖)结束。全部条件满足后，没有下一项已经确认的版本目标就删除本文；有下一项目标就直接替换为新的当前计划。
