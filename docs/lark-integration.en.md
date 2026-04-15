# Lark (Feishu) Remote Programming Guide

Send messages from your phone via Lark — VS Code Copilot Agent Mode executes them automatically — results are pushed back to Lark.

## Architecture

```
Phone (Lark)  →  Feishu Cloud (WSS)  →  Local API Server  →  SQLite Queue
                                                                     ↓
Lark Notification  ←  Write Result  ←  VSCode Extension Polls  ←  Inject Copilot Chat
```

**Zero port exposure**: The WSClient makes an outbound connection to Feishu Cloud. No inbound ports, no public IP, no domain required.

## Prerequisites

- Node.js ≥ 22
- VS Code + GitHub Copilot (Agent Mode)
- Alembic installed (`npm install -g alembic`, then `asd setup` in your project)
- Feishu Open Platform account

## Step 1: Create a Feishu Custom App

1. Go to [Feishu Open Platform](https://open.feishu.cn/), create a **Custom App**
2. Go to **Credentials & Basic Info**, note the `App ID` and `App Secret`
3. Go to **Events & Callbacks**:
   - Subscription mode: select **"Receive events via persistent connection"**
   - Add event: `im.message.receive_v1`
4. Go to **Permissions**, enable:
   - `im:message` (read & send messages in chats)
   - `im:message:send_as_bot` (send messages as bot)
   - `im:resource` (upload image resources, required for screenshots)
5. Publish the app (create version → submit for review → approved)

## Step 2: Configure Environment Variables

Add to your project's `.env` file:

```env
# Feishu Bot credentials
ASD_LARK_APP_ID=cli_xxxxxxxx
ASD_LARK_APP_SECRET=xxxxxxxxxxxx

# Security whitelist (strongly recommended)
# Only allow specific Feishu users to send commands, comma-separated
# You can skip this initially, send a message, then look up your user_id
ASD_LARK_ALLOWED_USERS=ou_xxxxxxxxxxxx
```

### Finding Your user_id

Start the server without a whitelist first, send a message in Lark, then query the database:

```bash
node -e "
const Database = require('better-sqlite3');
const db = new Database('.asd/alembic.db');
const rows = db.prepare('SELECT user_id, command FROM remote_commands ORDER BY created_at DESC LIMIT 3').all();
rows.forEach(r => console.log(r.user_id, '|', r.command));
"
```

Copy the `ou_xxxx` value into `ASD_LARK_ALLOWED_USERS`.

## Step 3: Start the Server

```bash
cd your-project
asd start          # or: node bin/api-server.js
```

The API server will automatically:
1. Load Feishu credentials from `.env`
2. Establish a WSS connection to Feishu Cloud
3. Start receiving messages

Verify connection:

```bash
curl -s http://localhost:3000/api/v1/remote/lark/status | python3 -m json.tool
```

You should see `"connected": true`.

## Step 4: Install the VS Code Extension

If `asd setup` didn't install it automatically:

```bash
cd your-project
ls .asd/*.vsix
code --install-extension .asd/alembic-*.vsix --force
```

The extension auto-detects the API server and Lark connection, and starts polling. The status bar shows `$(radio-tower) Remote: ON`.

## Usage

### Programming Commands

Send plain text messages in Lark — they get injected into Copilot Agent Mode:

```
Add a getProfile method to UserService, parameter userId: string
```

```
Fix the timezone issue in formatDate function in src/utils/date.ts
```

```
Refactor OrderController, extract create and update logic into OrderService
```

### System Commands

| Command | Description |
|---------|-------------|
| `/status` | Connection diagnostics + queue status (Lark→API→IDE→Queue→Notification) |
| `/queue` | View pending queue |
| `/cancel` | Cancel all pending commands |
| `/clear` | Clear completed records |
| `/ping` | Test connectivity |
| `/screen` | Capture IDE screenshot and send to Lark |
| `/help` | Show help |

### Auto-Approve Mode

When a remote command is injected into Copilot, the extension **automatically enables** VSCode's global Auto-Approve settings, allowing Copilot Agent Mode to execute tool calls, file edits, and terminal commands without interruption.

When the poller stops, original settings are automatically restored.

Settings managed:
- `chat.tools.global.autoApprove` — Global tool auto-approve
- `chat.tools.edits.autoApprove` — File edit auto-approve
- `chat.agent.terminal.autoApprove` — Terminal command auto-approve

## Task Notifications

If you use Alembic's TaskGraph system, task status changes are automatically pushed to Lark:

- 📋 Task created
- 🚀 Task claimed
- ✅ Task completed
- ❌ Task failed
- ⏸️ Task deferred
- 📊 Progress updated

Task notifications also include an IDE window screenshot for convenient visual review of code changes on your phone.

## IDE Screenshots

Capture the IDE window anytime via the `/screen` command or HTTP API. Under the hood:

1. Locate the VS Code window via macOS CGWindowListCopyWindowInfo
2. Capture using `screencapture -l<windowID>`
3. Upload to Feishu Image API (requires `im:resource` permission)
4. Send as an image message to the active chat

> Note: Screenshots are macOS-only and require the `im:resource` permission on your Feishu app.

## Security

### Transport Security

- **WSS encryption** — Full TLS-encrypted transport
- **Feishu SDK signature verification** — Trusted message origin
- **Zero port exposure** — Connection initiated from your machine, no inbound ports

### Access Control

- **`ASD_LARK_ALLOWED_USERS`** — Sender whitelist; unauthorized users get a "🔒 Access denied" response
- **localhost binding** — API server listens on `localhost:3000` only, not reachable from the network

### Trust Boundary

The system's trust level equals "your Mac + your Feishu account". As long as neither is compromised, there is no attack surface.

### Copilot Built-in Protection

Commands injected into Copilot are still subject to Copilot's own security:
- Remote mode automatically enables Auto-Approve; original settings are restored when the poller stops
- Built-in content safety policies

## HTTP API

In addition to Lark messages, you can also use the HTTP API directly:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/v1/remote/lark/status` | GET | Check Lark connection status |
| `/api/v1/remote/lark/start` | POST | Manually start Lark connection |
| `/api/v1/remote/lark/stop` | POST | Stop Lark connection |
| `/api/v1/remote/pending` | GET | View pending commands |
| `/api/v1/remote/send` | POST | Manually queue a command |
| `/api/v1/remote/history` | GET | View command history |
| `/api/v1/remote/notify` | POST | Send a Lark notification |
| `/api/v1/remote/screenshot` | POST | Capture IDE window and send to Lark |
| `/api/v1/remote/wait` | GET | Long-poll for new commands (extension use) |

## Troubleshooting

### Lark Connection Failed

```bash
# Check credentials
echo $ASD_LARK_APP_ID
echo $ASD_LARK_APP_SECRET

# Manually trigger connection
curl -s -X POST http://localhost:3000/api/v1/remote/lark/start | python3 -m json.tool
```

Common causes:
- Incorrect App ID / App Secret
- App not published (needs a version created and approved on the open platform)
- Event subscription not set to "persistent connection" mode

### Messages Not Working

1. Check if API server is running: `curl http://localhost:3000/api/v1/health`
2. Check Lark connection: `curl http://localhost:3000/api/v1/remote/lark/status`
3. Check whitelist: is your user_id in `ASD_LARK_ALLOWED_USERS`?
4. Check server logs (terminal output)

### VS Code Extension Not Polling

1. Check if status bar shows `Remote: ON`
2. If it shows `Remote: OFF`, click to toggle or run `Alembic: Start Remote Poller`
3. Confirm API server port 3000 is responding
