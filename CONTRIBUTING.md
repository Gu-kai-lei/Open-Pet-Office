# Contributing to Open Pet Office

感谢你愿意帮助完善 Open Pet Office。

开始前建议先阅读 [快速上手](docs/GETTING_STARTED.md)、[架构说明](docs/ARCHITECTURE.md) 和 [路线图](docs/ROADMAP.md)。它们分别描述用户流程、模块边界和当前优先级。

## 开始之前

- Bug 请使用 Bug report 模板，并尽量附上可复现步骤、Codex 版本和 Pet Office 日志摘要。
- 新功能请先提交 Feature request，说明使用场景和预期交互。
- 不要在 Issue、PR 或截图中提交 API Key、Authorization、个人会话内容或未经脱敏的日志。

## 本地开发

```powershell
npm install
npm test
npm start
```

当前主要支持 Windows 10/11。涉及 UI 的改动请同时验证普通动画和“减少动画”设置；涉及会话监听的改动应补充对应 JSONL 生命周期测试。

### 目录导航

| 目录 | 内容 |
| --- | --- |
| `src/` | Electron 主进程、Codex 接入、Session Monitor、Mission 与项目服务 |
| `renderer/` | 桌宠、输入框、任务中心和设置 UI |
| `scripts/` | 回归测试、状态机测试和本地验证脚本 |
| `docs/` | 用户指南、架构、路线图与产品截图 |

## Pull Request

1. 从 `main` 创建短分支。
2. 保持改动聚焦，并为行为变更补充测试。
3. 提交前运行 `npm test`。
4. 在 PR 中写明动机、实现方式、验证结果和可能的兼容性影响。

小而清晰的 PR 更容易审查和合并。
