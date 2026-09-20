# 快速上手

这份指南帮助你从零启动 Open Pet Office，并完成第一次单 Agent 对话和多 Agent Mission。

## 1. 准备环境

- Windows 10 或 Windows 11（x64）
- Codex CLI 0.155 或更高版本，并已完成登录
- 可选：[OpenCodex](https://github.com/lidge-jun/opencodex)，用于在 Codex 中路由 DeepSeek、GLM 等第三方模型

## 2. 安装

从 [最新 Release](https://github.com/Gu-kai-lei/Open-Pet-Office/releases/latest) 下载 `Pet-Office-*-portable.exe` 并运行。应用启动后，主管桌宠会出现在桌面上；右键桌宠可隐藏、召唤工作者或退出应用。

当前公开构建尚未配置 Windows 签名证书，SmartScreen 可能显示“未知发布者”。可在 Release 页面核对 SHA-256。

## 3. 完成第一次对话

1. 将鼠标移到主管桌宠上。
2. 点击输入图标，输入框会从按钮原位展开。
3. 保持“分工”关闭并发送消息。
4. 主管桌宠显示任务摘要和实时阶段；点击任务卡可打开对应 Codex 任务。

## 4. 创建多 Agent Mission

1. 打开输入框并开启“分工”。
2. 选择或创建项目工作区。
3. 选择参与的 Agent 与模型，也可以先使用“智能推荐”。
4. 主管生成依赖计划后，确认分波次任务。
5. 工作成员在隔离工作区执行，主管在每个波次结束后检查结果。
6. 最终变更在集成区复核；冲突、删除或计划外写入会等待你的处理。

## 5. 拖入文件

把文件直接拖到桌宠或已展开的输入框。Pet Office 会把文件复制到当前项目的 `inbox/`，并以相对路径加入消息。源文件不会被移动或删除。

## 6. 常用入口

| 操作 | 入口 |
| --- | --- |
| 查看任务、审批和提问 | 主管桌宠下方的铃铛 |
| 切换模型和查看额度 | 左键桌宠 → 概览 |
| 管理项目和会话 | 左键主管 → 工作 |
| 选择桌宠形象 | 左键桌宠 → 形象 |
| 显示器、全屏和通知设置 | 左键主管 → 设置 |
| 隐藏但继续运行任务 | 右键主管 → 隐藏到托盘 |

## 7. 从源码运行

```powershell
git clone https://github.com/Gu-kai-lei/Open-Pet-Office.git
cd Open-Pet-Office
npm install
npm test
npm start
```

构建 Windows portable：

```powershell
npm run dist
```

## 常见问题

### 桌宠没有显示 Codex Desktop 的任务

确认 Codex Desktop 会话目录可读，并在主管设置页运行“连接诊断”。Pet Office 只读监听 `~/.codex/sessions`，不会修改会话日志。

### 第三方模型没有显示额度

不同供应商的计费 API 不统一。支持的供应商会显示余额或额度；无法查询时会明确显示“供应商未提供可用额度接口”，不会用本地 token 估算冒充余额。

### 点击任务卡无法打开原会话

`codex://threads/<id>` 仍属于实验性深链。请确认 Codex Desktop 已安装并完成协议注册；也可以从任务中心复制任务信息后在 Codex 中继续。

### 哪里可以找更多桌宠形象

在“形象”页点击“发现形象”前往 [Petdex](https://petdex.dev/)。导入和使用第三方形象前请确认其授权范围。
