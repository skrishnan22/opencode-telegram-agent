# Deployment Guide

## Railway Deployment

### Step 1: Prepare Your Code

1. Push the code to a GitHub repository:
```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/YOUR_USERNAME/opencode-telegram-agent.git
git push -u origin main
```

### Step 2: Create Railway Project

1. Go to [Railway](https://railway.app) and sign in
2. Click "New Project"
3. Select "Deploy from GitHub repo"
4. Choose your repository
5. Railway will automatically detect the Dockerfile

### Step 3: Add Volume

1. In your Railway project dashboard, click "New"
2. Select "Volume"
3. Mount path: `/data`
4. Size: 5GB (or your preferred size)

### Step 4: Configure Environment Variables

Add these environment variables in Railway dashboard:

| Variable | Value | Notes |
|----------|-------|-------|
| `TELEGRAM_BOT_TOKEN` | `__REPLACE__` | Get from @BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | `__REPLACE__` | Generate random string |
| `TELEGRAM_ALLOWED_USER_IDS` | `__REPLACE__` | Your Telegram user ID |
| `PUBLIC_BASE_URL` | Auto-generated | Railway provides this |
| `NODE_ENV` | `production` | |
| `XDG_DATA_HOME` | `/data` | Don't change |
| `DEFAULT_MODEL` | `openai/gpt-5.2-codex` | |
| `MAX_CONCURRENT_JOBS` | `2` | |
| `SESSION_IDLE_TIMEOUT_HOURS` | `3` | |
| `DATA_DIR` | `/data` | |
| `WORKSPACE_BASE` | `/tmp/agent` | |
| `LOG_LEVEL` | `info` | |

### Step 5: Get Required Values

#### Telegram Bot Token
1. Message [@BotFather](https://t.me/botfather)
2. Send `/newbot`
3. Follow prompts to create bot
4. Copy the token (looks like: `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`)

#### Telegram User ID
1. Message [@userinfobot](https://t.me/userinfobot)
2. It will reply with your ID (looks like: `123456789`)

#### Webhook Secret
Generate a random secret:
```bash
openssl rand -hex 32
```

### Step 6: Deploy

1. Click "Deploy" in Railway
2. Wait for build to complete
3. Check logs for any errors
4. The server will automatically set the webhook

### Step 7: Verify

1. Message your bot on Telegram with `/help`
2. You should see the help message
3. If not, check Railway logs for errors

## First Time Setup

After deployment, you need to authenticate with OpenAI:

1. Message your bot: `/login openai`
2. The bot will send you a login URL
3. Click the link and complete login with your ChatGPT Plus/Pro account
4. Once done, you're ready to use the agent!

## Troubleshooting

### Webhook not working
- Check that `PUBLIC_BASE_URL` is set correctly
- Verify `TELEGRAM_WEBHOOK_SECRET` matches
- Check Railway logs for webhook setup errors

### Login not working
- Ensure OpenCode CLI is installed (check Dockerfile build logs)
- Check that `/data` volume is writable
- Verify `XDG_DATA_HOME` is set to `/data`

### Permission errors
- Make sure the Railway service has write access to `/data`
- Check volume is properly mounted

### Model not found
- Run `/models` to see available models
- Use exact model ID from the list
- Default is `openai/gpt-5.2-codex`

## Updating

To update the deployment:

1. Make changes to code
2. Commit and push to GitHub
3. Railway will automatically redeploy

## Monitoring

- Check Railway dashboard for logs
- Health endpoint: `https://your-app.up.railway.app/health`
- The cleanup worker runs every 30 minutes

## Security Notes

- Keep `TELEGRAM_BOT_TOKEN` secret
- Only add trusted user IDs to `TELEGRAM_ALLOWED_USER_IDS`
- The webhook secret prevents spoofing
- Auth tokens are stored on the Railway volume (encrypted at rest by Railway)
