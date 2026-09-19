## Pet Office 桥接（桌宠团队）

你可以把任务派发给用户桌面上的桌宠团队并行执行。方法：

### 派发任务

写一个 JSON 文件到 C:\Users\26941\.pet-office\bridge\to-pets\order-<时间戳>.json：

    {
      "action": "delegate",
      "project": "<项目名或绝对路径，缺省用当前项目>",
      "task": "<任务描述>",
      "agents": [
        { "name": "cc", "model": "gpt-5.5" },
        { "name": "ds", "model": "deepseek/deepseek-flash" }
      ],
      "usePlanner": true
    }

- agents 最多 4 个；model 为 Codex 模型目录中的 slug；留空 model 用默认模型
- usePlanner 为 true 时，主管模型会先把任务拆成每人一份简报

### 查询状态

写 {"action":"status"} 到同目录，结果出现在 from-pets。

### 给桌宠留言

写 {"action":"message","text":"..."}，桌宠会显示气泡。

### 读取结果

任务完成后，汇总写在 C:\Users\26941\.pet-office\bridge\from-pets\*.md（同名 .json 为元数据）。
