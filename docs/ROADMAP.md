# 路线图

Open Pet Office 目前处于 Windows 早期预览阶段。路线图按“可恢复的协作内核 → 项目工作台 → 桌面可靠性 → 生态扩展”的顺序推进。

## 已完成

### v0.11 — 主管 Agent

- Mission 持久化与依赖图
- 依赖波次、阶段检查和失败重派
- 工作者隔离 worktree / 快照
- 结构化 Agent 消息和主管最终复核
- 完成、部分成功、失败、取消和中断状态

### v0.12 — 项目与会话

- 新建、继续和重置上下文
- 项目重命名、归档、恢复、移除和附件清理
- 项目级任务筛选与固定任务卡
- 模型能力标签和参与 Agent 推荐

### v0.13 — 桌面体验

- 多显示器与全屏避让
- 安静、标准和详细通知模式
- 字体、附件区、键盘与无障碍优化
- 本地崩溃报告、更新检查和可选代码签名

### v0.16 — 轻量优先（转向）

- 内置协调器成为默认分工引擎，Ruflo 改为可选实验性引擎
- 隔离工作区遵循 `.gitignore` 并设置规模上限
- IPC、CSP、全局配置写入与进程启动的安全加固

转向理由见 [评审与转向](PIVOT.md)。

## 下一阶段

- 发布 v0.16 portable，并在真实 Codex 上完成内置引擎端到端验收
- 工作区 git / 哈希 / 复制操作异步化，解除主进程阻塞
- Mission 快速模式：单工作者、跳过阶段复核
- 渲染层逐步移除 `innerHTML`；测试迁移到 `node:test`
- 统一单 Agent 与 Mission 的 App Server 任务模型
- 项目级共享记忆检索与可视化
- 更直观的 Agent 消息、依赖和阶段复核视图
- 更多模型供应商额度适配器与预算策略
- 自动化可信构建、Windows 代码签名和安装包
- 在 Windows 稳定后评估 macOS 与 Linux

路线图会根据真实使用反馈调整。请通过 [Feature request](https://github.com/Gu-kai-lei/Open-Pet-Office/issues/new?template=feature_request.yml) 描述具体场景，而不只是功能名称。
