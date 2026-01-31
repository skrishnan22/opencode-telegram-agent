import { Telegraf } from 'telegraf';
import { config } from '../config.js';
import { sessionManager } from './session.js';
import { jobQueue } from './queue.js';

const bot = new Telegraf(config.TELEGRAM_BOT_TOKEN);

const LOG_PREFIX = 'telegram';

function logInfo(message, meta) {
  if (meta) {
    console.info(`[${LOG_PREFIX}] ${message}`, meta);
  } else {
    console.info(`[${LOG_PREFIX}] ${message}`);
  }
}

function logError(message, meta) {
  if (meta) {
    console.error(`[${LOG_PREFIX}] ${message}`, meta);
  } else {
    console.error(`[${LOG_PREFIX}] ${message}`);
  }
}

export async function setupTelegramWebhook() {
  const webhookUrl = `${config.PUBLIC_BASE_URL}/webhook`;
  
  await bot.telegram.setWebhook(webhookUrl, {
    secret_token: config.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ['message', 'callback_query']
  });
  
  console.log(`Webhook set to: ${webhookUrl}`);
}

export async function handleTelegramUpdate(update) {
  // Handle callback queries (inline buttons)
  if (update.callback_query) {
    await handleCallbackQuery(update.callback_query);
    return;
  }
  
  // Handle messages
  if (!update.message || !update.message.text) {
    return;
  }
  
  const msg = update.message;
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();
  const text = msg.text;
  
  // Check user allowlist
  if (!config.TELEGRAM_ALLOWED_USER_IDS.includes(userId)) {
    await bot.telegram.sendMessage(chatId, '⛔ You are not authorized to use this bot.');
    return;
  }
  
  // Check private chat
  if (msg.chat.type !== 'private') {
    await bot.telegram.sendMessage(chatId, '🤖 Please use this bot in a private chat.');
    return;
  }
  
  // Parse command or treat as message to agent
  if (text.startsWith('/')) {
    await handleCommand(chatId, userId, text);
  } else {
    await handleAgentMessage(chatId, userId, text, msg.message_id);
  }
}

async function handleCommand(chatId, userId, text) {
  const parts = text.split(' ');
  const command = parts[0].toLowerCase();
  const args = parts.slice(1).join(' ').trim();
  
  switch (command) {
    case '/new':
      logInfo('command /new', { chatId, userId });
      await sessionManager.createNewSession(chatId);
      await bot.telegram.sendMessage(chatId, '✨ New session created! Workspace is ready.');
      break;
      
    case '/end':
      logInfo('command /end', { chatId, userId });
      await sessionManager.endSession(chatId);
      await bot.telegram.sendMessage(chatId, '👋 Session ended. Workspace cleaned up.');
      break;
      
    case '/model':
      if (!args) {
        await bot.telegram.sendMessage(chatId, '❌ Please provide a model ID. Example: /model kimi/kimi-k2.5-free');
        return;
      }
      await sessionManager.setSessionModel(chatId, args);
      await bot.telegram.sendMessage(chatId, `✅ Model set to: ${args}`);
      break;
      
    case '/models':
      logInfo('command /models', { chatId, userId });
      await handleModelsCommand(chatId);
      break;
      
    case '/login':
      if (args === 'openai') {
        logInfo('command /login openai', { chatId, userId });
        await handleLoginOpenAI(chatId);
      } else {
        await bot.telegram.sendMessage(chatId, '❌ Usage: /login openai');
      }
      break;
      
    case '/cancel':
      logInfo('command /cancel', { chatId, userId });
      await handleCancel(chatId);
      break;
      
    case '/help':
      logInfo('command /help', { chatId, userId });
      await bot.telegram.sendMessage(chatId, getHelpText());
      break;
      
    default:
      logInfo('command unknown', { chatId, userId, command });
      await bot.telegram.sendMessage(chatId, '❓ Unknown command. Use /help for available commands.');
  }
}

async function handleAgentMessage(chatId, userId, text, messageId) {
  // Queue the job
  const jobId = await jobQueue.add(chatId, userId, text, async (progressCallback) => {
    const session = await sessionManager.getOrCreateSession(chatId);
    let lastProgressLogAt = 0;
    
    // Acknowledge with initial message
    const ackMsg = await bot.telegram.sendMessage(
      chatId, 
      `🔄 Processing...\nJob ID: ${jobId}\nSession: ${session.id}`,
      { reply_to_message_id: messageId }
    );

    logInfo('job started', { chatId, jobId, sessionId: session.id, model: session.model });
    
    try {
      // Import opencode runner
      const { runOpenCode } = await import('./opencode.js');
      
      const result = await runOpenCode({
        session,
        message: text,
        onProgress: async (data) => {
          // Update message with progress
          const progressText = formatProgress(data);
          const now = Date.now();
          if (now - lastProgressLogAt > 5000) {
            logInfo('job progress', {
              chatId,
              jobId,
              elapsed: data.elapsed,
              outputLength: data.output.length,
              eventType: data.event?.type
            });
            lastProgressLogAt = now;
          }
          try {
            await bot.telegram.editMessageText(
              chatId,
              ackMsg.message_id,
              undefined,
              progressText,
              { parse_mode: 'Markdown' }
            );
          } catch (e) {
            logError('progress update failed', { chatId, jobId, error: e.message });
          }
        },
        onApproval: async (permissionData) => {
          logInfo('permission request', {
            chatId,
            jobId,
            permissionId: permissionData.id,
            tool: permissionData.tool
          });
          // Send approval request with inline buttons
          const keyboard = {
            inline_keyboard: [[
              { text: '✅ Approve once', callback_data: `approve:${jobId}:${permissionData.id}` },
              { text: '❌ Deny', callback_data: `deny:${jobId}:${permissionData.id}` },
              { text: '✅✅ Approve all', callback_data: `approve_all:${jobId}:${permissionData.id}` }
            ]]
          };
          
          await bot.telegram.sendMessage(
            chatId,
            `⚠️ *Permission Request*\n\nTool: \`${permissionData.tool}\`\nInput: \`${JSON.stringify(permissionData.input).slice(0, 200)}\`\n\nPlease approve or deny:`,
            { parse_mode: 'MarkdownV2', reply_markup: keyboard }
          );
          
          // Wait for approval (will be handled by callback)
          return new Promise((resolve) => {
            session.pendingApprovals = session.pendingApprovals || {};
            session.pendingApprovals[permissionData.id] = resolve;
          });
        }
      });
      
      // Send final result
      if (result.output.length > 3500) {
        // Send as file
        await bot.telegram.sendDocument(
          chatId,
          { source: Buffer.from(result.output), filename: `output-${jobId}.txt` },
          { caption: `✅ Job completed\nDuration: ${result.duration}s`, reply_to_message_id: messageId }
        );
        logInfo('job completed (file)', { chatId, jobId, duration: result.duration });
      } else {
        await bot.telegram.editMessageText(
          chatId,
          ackMsg.message_id,
          undefined,
          `✅ *Completed*\n\n${result.output.slice(0, 3500)}`,
          { parse_mode: 'Markdown' }
        );
        logInfo('job completed', { chatId, jobId, duration: result.duration });
      }
      
    } catch (error) {
      logError('job failed', { chatId, jobId, error: error.message });
      await bot.telegram.editMessageText(
        chatId,
        ackMsg.message_id,
        undefined,
        `❌ *Error*\n\n${error.message.slice(0, 500)}`,
        { parse_mode: 'Markdown' }
      );
    }
  });
  
  // Notify about queue position if not immediate
  const position = jobQueue.getPosition(jobId);
  if (position > 0) {
    await bot.telegram.sendMessage(
      chatId,
      `⏳ Queued (position: ${position + 1})\nJob ID: ${jobId}`,
      { reply_to_message_id: messageId }
    );
  }
}

function formatProgress(data) {
  const lines = data.output.split('\n').slice(-12);
  const truncated = lines.join('\n').slice(-3500);
  
  return `🔄 *Running* • ${data.elapsed}s elapsed\n\n\`\`\`\n${truncated}\n\`\`\``;
}

async function handleCallbackQuery(callbackQuery) {
  const data = callbackQuery.data;
  const [action, jobId, permissionId] = data.split(':');
  const chatId = callbackQuery.message.chat.id;
  
  const session = await sessionManager.getSession(chatId);
  if (!session || !session.pendingApprovals || !session.pendingApprovals[permissionId]) {
    await bot.telegram.answerCbQuery(callbackQuery.id, 'Request expired');
    return;
  }
  
  const resolve = session.pendingApprovals[permissionId];
  
  switch (action) {
    case 'approve':
      resolve({ approved: true, remember: false });
      await bot.telegram.answerCbQuery(callbackQuery.id, 'Approved once');
      break;
    case 'deny':
      resolve({ approved: false });
      await bot.telegram.answerCbQuery(callbackQuery.id, 'Denied');
      break;
    case 'approve_all':
      resolve({ approved: true, remember: true });
      await bot.telegram.answerCbQuery(callbackQuery.id, 'Approved for session');
      break;
  }
  
  // Clean up
  delete session.pendingApprovals[permissionId];
  await sessionManager.saveSession(chatId, session);
}

async function handleModelsCommand(chatId) {
  const loadingMsg = await bot.telegram.sendMessage(chatId, '🔍 Fetching available models...');
  
  try {
    const { listModels } = await import('./opencode.js');
    const models = await listModels();
    
    const modelList = models.map(m => `• ${m.id} - ${m.name || 'Unknown'}`).join('\n');
    
    await bot.telegram.editMessageText(
      chatId,
      loadingMsg.message_id,
      undefined,
      `📋 *Available Models*\n\n${modelList}\n\nUse /model <id> to set a model`,
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    await bot.telegram.editMessageText(
      chatId,
      loadingMsg.message_id,
      undefined,
      `❌ Failed to fetch models: ${error.message}`
    );
  }
}

async function handleLoginOpenAI(chatId) {
  const loadingMsg = await bot.telegram.sendMessage(chatId, '🔐 Starting OpenAI login...\nPlease wait for the login URL.');
  
  try {
    const { performLogin } = await import('./login.js');

    logInfo('starting OpenAI login flow', { chatId });

    performLogin({
      provider: 'openai',
      onUrl: async (url) => {
        logInfo('sending login url to user', { chatId });
        await bot.telegram.editMessageText(
          chatId,
          loadingMsg.message_id,
          undefined,
          `🔐 *OpenAI Login*\n\n1. Click this link to open the login page:\n${url}\n\n2. Complete the login in your browser\n\n3. The bot will automatically detect when you're done`,
          { parse_mode: 'Markdown', disable_web_page_preview: true }
        );
      }
    })
      .then(async (result) => {
        if (result.success) {
          logInfo('login flow completed successfully', { chatId });
          await bot.telegram.editMessageText(
            chatId,
            loadingMsg.message_id,
            undefined,
            '✅ Successfully logged in to OpenAI!\n\nYou can now start using the agent.'
          );
        } else {
          logError('login flow failed', { chatId, error: result.error });
          await bot.telegram.editMessageText(
            chatId,
            loadingMsg.message_id,
            undefined,
            `❌ Login failed: ${result.error}`
          );
        }
      })
      .catch(async (error) => {
        logError('login flow error', { chatId, error: error.message });
        await bot.telegram.editMessageText(
          chatId,
          loadingMsg.message_id,
          undefined,
          `❌ Login error: ${error.message}`
        );
      });
  } catch (error) {
    logError('login flow setup error', { chatId, error: error.message });
    await bot.telegram.editMessageText(
      chatId,
      loadingMsg.message_id,
      undefined,
      `❌ Login error: ${error.message}`
    );
  }
}

async function handleCancel(chatId) {
  const cancelled = await jobQueue.cancelSessionJobs(chatId);
  
  if (cancelled > 0) {
    await bot.telegram.sendMessage(chatId, `🛑 Cancelled ${cancelled} running job(s).`);
  } else {
    await bot.telegram.sendMessage(chatId, 'ℹ️ No running jobs to cancel.');
  }
}

function getHelpText() {
  return `
🤖 *OpenCode Agent Bot*

*Commands:*
/new - Start a new session
/end - End current session and cleanup
 /model <id> - Set the model (e.g., /model kimi/kimi-k2.5-free)
/models - List available models
/login openai - Login with OpenAI subscription
/cancel - Cancel running jobs
/help - Show this help

*Usage:*
Simply type a message to send it to the agent. Each chat maintains its own session and workspace.

 Default model: kimi/kimi-k2.5-free
`;
}

export { bot };
