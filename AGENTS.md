# 编码代理入口

## 项目

本项目是面向 [Pi Coding Agent](https://github.com/earendil-works/pi) 的长期记忆扩展。系统目标、模块职责、公共数据契约和依赖方向由 [`docs/design.md`](./docs/design.md) 定义。

## 工作边界

开始工作前，先阅读 `docs/design.md` 中与任务相关的目标、模块和契约，再检查当前代码与测试。

运行结构由三个模块组成：

- Pi Boundary 连接 Pi；
- Cue Provider 提供历史线索；
- Retriever 根据线索找回完整事实。

数据来源、存储、索引、同步和算法属于对应模块实现。新增模块必须满足 `docs/design.md` 的演进规则。

Pi lifecycle、context、session 和工具行为以当前 Pi 官方文档、公开类型与真实运行结果为准。能够通过真实运行确认的外部行为，不从旧代码或转述推断。

## 改动与验证

- 每次改动只处理当前目标直接涉及的文件和职责；
- 变更的验证范围、检查命令、结果分类和完成条件遵循 [`Verification` 模块架构](./docs/modules/verification.md)；
- 代码、配置和测试只描述当前实现；
- 架构职责或公共契约变化时更新 `docs/design.md`；
- 代码、配置、测试和运行产物的落点与依赖边界遵循 [`Project Structure` 模块架构](./docs/modules/project-structure.md)；
- 文档设计、创建、更新和删除遵循 [`Documentation` 模块架构](./docs/modules/documentation.md)。
