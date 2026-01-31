# OpenCode Telegram Agent

A Telegram bot that runs OpenCode CLI with OpenAI subscription login, hosted on Railway.

## Features

- Multi-message sessions with isolated workspaces
- OpenAI subscription login (ChatGPT Plus/Pro)
- Per-session model selection (default: openai/gpt-5.2-codex)
- Permission approvals via Telegram inline buttons
- Automatic cleanup after 3 hours of inactivity
- Max 2 concurrent jobs

## Setup

### 1. Create Telegram Bot

1. Message [@BotFather](https://t.me/botfather) on Telegram
2. Create a new bot with `/newbot`
3. Save the bot token
4. Set webhook secret with `/setwebhook` (or we'll set it via API)

### 2. Get Your Telegram User ID

1. Message [@userinfobot](https://t.me/userinfobot)
2. Save your user ID

### 3. Deploy to Railway

1. Fork/clone this repository
2. Create a new project on [Railway](https://railway.app)
3. Add a volume mounted at `/data`
4. Add environment variables:
   - `TELEGRAM_BOT_TOKEN` - from BotFather
   - `TELEGRAM_WEBHOOK_SECRET` - generate a random secret
   - `TELEGRAM_ALLOWED_USER_IDS` - your user ID (comma-separated for multiple)
   - `PUBLIC_BASE_URL` - Railway will provide this

5. Deploy!

### 4. Set Webhook

Railway will automatically set the webhook on startup using `PUBLIC_BASE_URL`.

## Usage

### Commands

- `/new` - Start a new session
- `/end` - End current session and cleanup
- `/model <id>` - Set the model (e.g., `/model openai/gpt-5.2-codex`)
- `/models` - List available models
- `/login openai` - Login with OpenAI subscription
- `/cancel` - Cancel running jobs
- `/help` - Show help

### Workflow

1. Start with `/login openai` to authenticate
2. (Optional) Set a model with `/model openai/gpt-5.2-codex`
3. Start a new session with `/new`
4. Send messages to chat with the agent
5. Continue the conversation - context is preserved
6. End with `/end` when done

## Architecture

- **Node.js + Fastify** - Web server and Telegram webhook handler
- **PQueue** - Job queue with concurrency control (max 2)
- **OpenCode SDK** - Integration with OpenCode CLI
- **Railway Volume** - Persistent storage for auth tokens and sessions
- **Per-session isolation** - Each chat gets its own workspace at `/tmp/agent/<uuid>/`

## Permissions

The agent uses a moderate allowlist:

- **Auto-allow**: git, npm, pnpm, yarn, pip, python, node, grep, cat, ls, find
- **Ask**: curl, wget, edit, most other commands
- **Deny**: sudo, docker, kubectl, rm, dangerous commands

Approvals are requested via Telegram inline buttons.

## Cleanup

- Sessions idle for >3 hours are automatically cleaned up
- Workspaces are deleted on `/end` or failure
- Job history is kept for 24 hours then purged

## Development

```bash
# Install dependencies
npm install

# Copy environment template
cp .env.example .env
# Edit .env with your values

# Run locally
npm run dev
```

## License

MIT
