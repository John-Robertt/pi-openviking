# pi-openviking

面向 [Pi Coding Agent](https://github.com/earendil-works/pi) 的长期记忆扩展。

Pi 压缩旧上下文或切换 branch 后，扩展向任务模型提供一小份历史线索；模型可以根据线索取回对应的完整事实。

## 当前状态

仓库提供新架构的最小 Pi 扩展入口。架构由 [`docs/design.md`](./docs/design.md) 定义，具体记忆能力按该设计逐步实现。

## 开发

需要 Node.js 22.19.0 或更高版本。

```bash
npm ci
npm test
```

在真实 Pi 中加载当前扩展入口：

```bash
npx pi -e ./src/index.ts
```

## 架构

项目文档和当前开发入口见 [`docs/README.md`](./docs/README.md)。

## 许可证

Apache-2.0，见 [`LICENSE`](./LICENSE)。
