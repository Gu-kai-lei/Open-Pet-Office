# 项目评审与转向（v0.16）

> 评审日期：2026-10-24 · 基线：`main@899c84d`（v0.15.1）

## 结论

Open Pet Office 最有价值、也最难被替代的部分，是**看得见的 Codex 桌面伴侣**：实时任务卡、审批与提问收件箱、截图提问、拖放附件，以及一套做得很扎实的**安全回写引擎**（隔离工作区、日志式回写与自动回滚）。

v0.15 把第三方 npm 运行时 Ruflo 变成了分工功能的硬依赖，代价远大于收益：前置条件变成 Windows + Codex + Node.js ≥ 20 + npm ≥ 9 + 联网安装，每次状态变化都要和外部 MCP 进程同步，任何同步失败都会暂停 Mission，而作者自己的真实端到端验收也没有通过。

因此本次转向为：

**从“重型多 Agent 编排器”转为“轻量 Codex 桌面伴侣 + 可选的安全并行工作台”。**

1. 默认路径只依赖 Codex CLI，不需要额外安装。
2. 分工默认使用内置协调器；Ruflo 降级为设置中可选的实验性引擎。
3. 任何重型功能都必须是可选的，并且在大项目上也不能拖垮应用。

## 现状数据

| 指标 | 数值 | 说明 |
| --- | --- | --- |
| Star | 90 | 关注度不低 |
| 公开版本 | 仅 v0.13.0（v0.13.3 是草稿） | README 宣传的 v0.14 / v0.15 功能都不在可下载版本里 |
| 下载量 | 6 | v0.13.0 portable 的累计下载 |
| 源码规模 | `main.js` 1751 行，`renderer/app.js` 3432 行 | 两个“上帝文件” |

关注和实际使用之间差了一个数量级，问题出在**获取与上手**这一段，而不是功能不够多。

## 使用者视角

| # | 问题 | 影响 | 本次处理 |
| --- | --- | --- | --- |
| U1 | 可下载版本落后两个小版本；v0.14.9 才修复严格 JSON Schema 导致的规划失败 | 下载后分工大概率直接失败 | 未处理：需要作者发布 v0.16 portable |
| U2 | 分工的前置条件过重：Node、npm、联网安装 Ruflo 和它的模型依赖 | 大多数桌宠用户卡在安装这一步 | **已修复**：内置协调器成为默认引擎，零额外依赖 |
| U3 | 脏 Git 仓库和非 Git 项目会被整树复制给每个工作者的每次尝试，回写前还要再整树备份一次 | 带数据集或权重的项目（例如 YOLO 训练项目）会卡死应用或占满磁盘 | **已修复**：遵循 `.gitignore`、设置规模上限、只备份要覆盖的文件 |
| U4 | 每次和桌宠对话都会在项目里写入 `HIVE.md`、`MEMORY.md`、`tasks/`、`messages/` | 污染用户仓库 | **已修复**：删除遗留代码路径 |
| U5 | v0.15.1 的真实工作者写文件验收被 Codex Windows 沙箱 ACL 故障阻断 | 核心卖点没有闭环 | 未处理：需要在真实环境复验，见下一步 |
| U6 | 一个 Mission 至少要调用主管 4 次（规划、阶段复核、最终复核、总结） | 简单任务又慢又贵 | 未处理：建议加“快速模式” |
| U7 | 任务中心的交付文件列表是浅灰字配米白底 | 几乎看不清 | 未处理：样式问题，记录在案 |
| U8 | 界面只有中文 | 限制了“Open”的受众 | 未处理 |

## 工程视角

### 安全

| 问题 | 位置 | 本次处理 |
| --- | --- | --- |
| `shell:open` 接受任意路径；`shell.openPath` 会直接运行可执行文件 | `main.js` IPC | **已修复**：只允许受信目录内的文件夹和文档，拒绝可执行扩展名，并逐级校验 junction |
| 渲染层用 24 处 `innerHTML` 拼接模型输出和第三方皮肤元数据，且没有 CSP | `renderer/app.js`、`index.html` | **部分修复**：加入严格 CSP（`script-src 'self'`、`connect-src 'none'`）兜底；`innerHTML` 仍待逐步替换 |
| `settings:set` / `ui:set` 把渲染层补丁原样 `Object.assign` 进状态 | `main.js` | **已修复**：按白名单过滤键 |
| 桥接目录里的任意 JSON 可以在任意绝对路径创建项目 | `main.js` `onBridgeOrder` | **已修复**：绝对路径只能指向已添加的项目 |
| 启动时直接改写全局 `~/.codex/config.toml`，没有备份 | `codex-transport.js` | **已修复**：改写前生成带时间戳的备份，并原子写入 |
| 所有 Codex 进程都经 `cmd.exe /d /s /c codex …` 启动 | appserver / dispatcher / planner / diagnostics | **已修复**：直接启动 `codex.exe`，或解析 npm shim 后运行 `node codex.js`，参数原样传递 |
| AppServer 用 `clientInfo.name = 'Codex Desktop'` 冒充桌面端 | `appserver.js` | 未处理：依赖未公开行为，Codex 升级后可能失效 |

### 架构与可靠性

- **Ruflo 是硬依赖却只做镜像**：Pet Office 本来就是计划、状态和消息的唯一事实来源，Ruflo 主要负责复制一份任务状态和存储记忆；swarm、拓扑、raft 共识这些概念对本地单进程编排没有实际作用。每个工作者还会额外启动一个 Ruflo MCP 进程。`completeTask` / `retryTask` 未被保护，镜像失败会让已经通过复核的 Mission 整体失败。**已修复**：引入内置协调器；按 Mission 记录引擎；镜像失败不再丢弃已接受的成果。
- **主线程阻塞**：`spawnSync git`、全树同步 SHA-256、同步复制都跑在 Electron 主进程上；全屏检测每 6 秒新启一次 PowerShell 并编译 C#。**已修复一部分**：全屏检测改为常驻进程（实测每次从 400–600 ms 降到 0–9 ms）；哈希加入按 size / mtime / ctime 的缓存；文件枚举遵循 `.gitignore`，工作量大幅减少；Ruflo 健康检查缓存 `node` / `npm` 版本。git 与文件操作仍是同步的，见下一步。
- **死代码**：遗留的批处理流程（`batches`）从未被写入，`planner.splitTask` 也没有调用方，但仍然参与项目占用判断、状态快照和桥接状态。**已删除**。
- **测试阻碍重构**：测试按版本号命名（`v0131-test.js`…），大量断言源码里是否包含某段字符串（例如 `'duration + 90'`），还会按字符串下标从 `main.js` / `app.js` 里截取函数放进 vm 运行。未处理，建议迁移到 `node:test` 并测试行为。
- **四份不同的脱敏实现**（`main.js`、`session-monitor.js`、`mission-store.js`、Ruflo），规则互不一致。本次把协调器相关的合并进 `coordination-utils.js`，其余待统一。
- **忽略 `CODEX_HOME`**：用户设置 `CODEX_HOME` 后，会话监听会看错目录。**已修复**。

## 本次改动

| 改动 | 主要文件 | 验证 |
| --- | --- | --- |
| 内置协调器，默认分工引擎；Ruflo 改为可选的实验性引擎 | `local-coordinator.js`、`coordination-utils.js`、`mission-manager.js`、`mission-store.js`、设置界面 | `local-engine-test.js`：完整 Mission 不依赖 Ruflo、关键词记忆、命名空间隔离、重启后可恢复 |
| 大项目隔离：遵循 `.gitignore`、2 万文件 / 2 GB 上限、只备份被覆盖的文件、哈希缓存 | `mission-workspace.js` | `isolation-test.js`：数据集与权重不会被复制，被忽略的输出不会被收集 |
| IPC 与配置安全加固、CSP | `path-safety.js`、`ipc-guards.js`、`codex-transport.js`、`index.html` | `security-test.js`（含 junction 越界） |
| 直接启动 Codex，不经过 `cmd.exe` | `codex-launcher.js` | `launcher-test.js`：`& | ^ % "` 和换行原样到达 Codex；在本机真实安装上解析成功 |
| 常驻全屏检测进程 | `fullscreen-probe.js` | `probe-test.js`：超时替换、退避与崩溃处理 |
| 删除遗留批处理和项目污染路径；截图脚本移出 `main.js` | `main.js`、`dispatcher.js`、`planner.js`、`capture-views.js` | `main.js` 从 1751 行降到 1626 行 |
| `PET_OFFICE_HOME` 隔离开发运行（含 Electron 配置目录） | `config.js`、`main.js` | 在隔离目录中以截图模式启动应用，计划、任务中心、诊断、附件四个界面正常 |

`npm test` 从 18 组增加到 23 组，全部通过。

## 下一步（按优先级）

1. **发布 v0.16.0 portable**，让 README 描述的就是可下载的版本（解决 U1）。
2. **真实环境端到端验收**：用 `scripts/mission-real-e2e.js` 在真实 Codex 上跑一遍内置引擎，先确认 Windows 沙箱 ACL 故障是否仍然存在（U5）。本次只做了模拟和截图验证，没有调用真实模型。
3. **工作区操作异步化**：把 git、哈希和复制移到异步子进程或 `worker_threads`，彻底解除主进程阻塞。
4. **渲染层去掉 `innerHTML`**：CSP 只是兜底，逐步改用 DOM API 或一个极小的转义模板函数。
5. **Mission 快速模式**：单工作者、跳过阶段复核，只保留最终复核和安全回写（U6）。
6. **测试迁移到 `node:test`**，删除源码字符串断言，按功能而不是版本组织。
7. **统一脱敏实现**，并继续拆分 `main.js`（对话服务、截图服务、IPC 注册）。
8. **确认 Ruflo 的模型下载**：本次运行 Ruflo 契约测试时，日志里出现了从 huggingface.co 下载嵌入模型的记录，与“阻止隐式下载”的注释不一致，需要单独确认下载是否真的发生。
