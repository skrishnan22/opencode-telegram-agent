import Fastify from 'fastify';
import { config } from '../config.js';
import { setupTelegramWebhook, handleTelegramUpdate } from './telegram.js';
import { startCleanupWorker } from './cleanup.js';
import { sessionManager } from './session.js';

const fastify = Fastify({
  logger: {
    level: config.LOG_LEVEL || 'info',
    transport: process.env.NODE_ENV !== 'production' 
      ? { target: 'pino-pretty' }
      : undefined
  }
});

// Health check endpoint
fastify.get('/health', async () => {
  return { status: 'ok', version: '1.0.0' };
});

// Telegram webhook endpoint
fastify.post('/webhook', async (request, reply) => {
  const secretToken = request.headers['x-telegram-bot-api-secret-token'];
  
  if (secretToken !== config.TELEGRAM_WEBHOOK_SECRET) {
    fastify.log.warn('Invalid webhook secret');
    return reply.status(401).send({ error: 'Unauthorized' });
  }
  
  const update = request.body;
  fastify.log.debug({ update }, 'Received Telegram update');
  
  void handleTelegramUpdate(update).catch((error) => {
    fastify.log.error({ error }, 'Failed to handle update');
  });

  return { ok: true };
});

async function start() {
  try {
    // Ensure data directory exists
    await import('fs/promises').then(fs => 
      fs.mkdir(config.DATA_DIR, { recursive: true })
    );
    
    // Initialize session manager
    await sessionManager.init();
    
    // Start cleanup worker
    startCleanupWorker();
    
    // Setup Telegram webhook
    await setupTelegramWebhook();
    
    // Start server
    const port = parseInt(config.PORT, 10);
    await fastify.listen({ port, host: '0.0.0.0' });
    fastify.log.info(`Server running on port ${port}`);
    
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

start();
