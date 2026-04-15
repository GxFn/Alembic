# 飞书远程编程接入指南

用手机飞书发消息，Mac 上的 VS Code Copilot Agent Mode 自动执行编程任务，结果推送回飞书。

## 架构

```
手机 (飞书)  →  飞书云端 (WSS 长连接)  →  本地 API Server  →  SQLite 队列
                                                                      ↓
飞书通知  ←  回写结果  ←  VSCode 扩展轮询  ←  注入 Copilot Chat  ←  ─┘
```

**零端口暴露**：WSClient 是出站连接（你的机器主动连飞书云），不需要开放任何入站端口，不需要公网 IP 或域名。

## 前置条件

- Node.js ≥ 22
- VS Code + GitHub Copilot（Agent Mode）
- Alembic 已安装（`npm install -g alembic`，然后在项目里 `asd setup`）
- 飞书开放平台账号

## 第一步：创建飞书自建应用

1. 打开 [飞书开放平台](https://open.feishu.cn/)，创建一个**自建应用**
2. 进入**凭证与基础信息**，记录 `App ID` 和 `App Secret`
3. 进入**事件与回调**：
   - 订阅方式选择 **「使用长连接接收事件」**
   - 添加事件：`im.message.receive_v1`（接收消息）
4. 进入**权限管理**，开通以下权限：
   - `im:message`（获取与发送单聊、群聊消息）
   - `im:message:send_as_bot`（以机器人身份发送消息）
   - `im:resource`（上传图片资源，截图功能需要）
5. 发布应用版本（创建版本 → 提交审核 → 审核通过后生效）

## 第二步：配置环境变量

在项目根目录的 `.env` 文件中添加：

```env
# 飞书 Bot 凭证
ASD_LARK_APP_ID=cli_xxxxxxxx
ASD_LARK_APP_SECRET=xxxxxxxxxxxx

# 安全白名单（强烈建议设置）
# 只允许指定飞书用户发送指令，逗号分隔
# 第一次不设也行，发一条消息后从数据库查 user_id 再填
ASD_LARK_ALLOWED_USERS=ou_xxxxxxxxxxxx
```

### 获取你的 user_id

首次不设白名单，启动服务后从飞书给机器人发一条消息，然后查数据库：

```bash
node -e "
const Database = require('better-sqlite3');
const db = new Database('.asd/alembic.db');
const rows = db.prepare('SELECT user_id, command FROM remote_commands ORDER BY created_at DESC LIMIT 3').all();
rows.forEach(r => console.log(r.user_id, '|', r.command));
"
```

把看到的 `ou_xxxx` 填入 `ASD_LARK_ALLOWED_USERS`。

## 第三步：启动服务

```bash
cd your-project
asd start          # 或 node bin/api-server.js
```

API Server 启动后会自动：
1. 加载 `.env` 中的飞书凭证
2. 建立 WSS 长连接到飞书云端
3. 开始接收消息

验证连接状态：

```bash
curl -s http://localhost:3000/api/v1/remote/lark/status | python3 -m json.tool
```

应该看到 `"connected": true`。

## 第四步：安装 VS Code 扩展

如果 `asd setup` 没有自动安装扩展，手动安装：

```bash
cd your-project
ls .asd/*.vsix  # 找到扩展文件
code --install-extension .asd/alembic-*.vsix --force
```

扩展会自动探测 API Server 和飞书连接状态，自动启动远程指令轮询。状态栏会显示 `$(radio-tower) Remote: ON`。

## 使用方式

### 编程指令

在飞书中直接发送文字消息，消息内容会被注入 Copilot Agent Mode：

```
帮我在 UserService 里增加一个 getProfile 方法，参数是 userId: string
```

```
修复 src/utils/date.ts 中 formatDate 函数的时区问题
```

```
重构 OrderController，把 create 和 update 逻辑抽到 OrderService 里
```

### 系统命令

| 命令 | 说明 |
|------|------|
| `/status` | 连接诊断 + 队列状态（飞书→API→IDE→队列→通知通道） |
| `/queue` | 查看待执行队列 |
| `/cancel` | 取消所有待执行指令 |
| `/clear` | 清理已完成记录 |
| `/ping` | 测试连通性 |
| `/screen` | 截取 IDE 当前画面并发送到飞书 |
| `/help` | 显示帮助 |

### 自动审批模式

远程编程指令注入 Copilot 后，扩展会 **自动开启** VSCode 的全局 Auto-Approve 设置，确保 Copilot Agent Mode 可以不受中断地执行工具调用、文件编辑和终端命令。

停止轮询后会自动恢复原始设置。

涉及的设置项：
- `chat.tools.global.autoApprove` — 全局工具自动审批
- `chat.tools.edits.autoApprove` — 文件编辑自动审批
- `chat.agent.terminal.autoApprove` — 终端命令自动审批

## 任务通知

如果你使用了 Alembic 的 TaskGraph 任务系统，任务状态变化会自动推送到飞书：

- 📋 任务创建
- 🚀 任务认领
- ✅ 任务完成
- ❌ 任务失败
- ⏸️ 任务延期
- 📊 进度更新

任务通知还会附带 IDE 窗口截图，便于在手机上直观查看代码变更。

## IDE 截图

通过 `/screen` 命令或 HTTP API 可以随时截取 IDE 窗口画面。底层实现：

1. 通过 macOS CGWindowListCopyWindowInfo 定位 VS Code 窗口
2. 使用 `screencapture -l<windowID>` 截取窗口截图
3. 上传至飞书图片 API（需要 `im:resource` 权限）
4. 以图片消息发送到当前活跃会话

> 注意：截图功能仅支持 macOS，且需要飞书应用开通 `im:resource` 权限。

## 安全性

### 传输安全

- **WSS 加密** — 全程 TLS 加密传输
- **飞书 SDK 签名验证** — 消息来源可信
- **零端口暴露** — 连接由本机发起，无入站端口

### 访问控制

- **`ASD_LARK_ALLOWED_USERS`** — 发送者白名单，未授权用户的消息被拒绝并收到"🔒 权限不足"提示
- **localhost 绑定** — API Server 默认只监听 `localhost:3000`，外网无法直接访问

### 信任边界

这套系统的信任等同于 "你的 Mac + 你的飞书账号"。只要两者不被攻破，没有其他攻击入口。

### Copilot 内置防护

注入到 Copilot 的指令仍受 Copilot 自身安全限制：
- 远程模式自动开启 Auto-Approve，停止轮询后自动恢复原始设置
- 内置内容安全策略

## HTTP API

除了飞书消息入口，也可以通过 HTTP 调用：

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/v1/remote/lark/status` | GET | 查看飞书连接状态 |
| `/api/v1/remote/lark/start` | POST | 手动启动飞书连接 |
| `/api/v1/remote/lark/stop` | POST | 停止飞书连接 |
| `/api/v1/remote/pending` | GET | 查看待执行指令 |
| `/api/v1/remote/send` | POST | 手动发送指令到队列 |
| `/api/v1/remote/history` | GET | 查看历史记录 |
| `/api/v1/remote/notify` | POST | 发送飞书通知 |
| `/api/v1/remote/screenshot` | POST | 截取 IDE 窗口并发送到飞书 |
| `/api/v1/remote/wait` | GET | Long-poll 等待新指令（扩展端使用） |

## 故障排除

### 飞书连接失败

```bash
# 检查凭证
echo $ASD_LARK_APP_ID
echo $ASD_LARK_APP_SECRET

# 手动触发连接
curl -s -X POST http://localhost:3000/api/v1/remote/lark/start | python3 -m json.tool
```

常见原因：
- App ID / App Secret 错误
- 应用未发布（需要在开放平台创建版本并审核通过）
- 事件订阅未选择「长连接」模式

### 消息发了没反应

1. 检查 API Server 是否在运行：`curl http://localhost:3000/api/v1/health`
2. 检查飞书连接：`curl http://localhost:3000/api/v1/remote/lark/status`
3. 检查白名单：你的 user_id 是否在 `ASD_LARK_ALLOWED_USERS` 里
4. 查看服务端日志（终端输出）

### VS Code 扩展没有轮询

1. 检查状态栏是否显示 `Remote: ON`
2. 如果显示 `Remote: OFF`，点击切换或运行命令 `Alembic: Start Remote Poller`
3. 确认 API Server 端口 3000 正常
