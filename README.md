# Pi OpenViking 扩展

面向 [Pi Coding Agent](https://github.com/earendil-works/pi) 的
[OpenViking](https://github.com/volcengine/OpenViking) 扩展。

系统目标：让任务模型在 Pi 长期会话中经过 compaction 和 branch 变化后，仍能意识到与当前任务相关的历史记忆
存在，并在需要精确细节时通过 OpenViking 找回。

## 文档

- [`docs/design.md`](./docs/design.md)：目标架构与稳定边界的总纲；
- [`docs/roadmap.md`](./docs/roadmap.md)：阶段路径、实施状态与下一实施入口；
- [`docs/documentation.md`](./docs/documentation.md)：文档规划与格式规范；
- [`AGENTS.md`](./AGENTS.md)：编码代理的仓库工作指引。

## 许可证

Apache-2.0，见 [`LICENSE`](./LICENSE)。OpenViking 服务端使用其自身许可证。
