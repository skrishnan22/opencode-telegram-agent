import { z } from 'zod';

const configSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1, 'TELEGRAM_BOT_TOKEN is required'),
  TELEGRAM_WEBHOOK_SECRET: z.string().min(1, 'TELEGRAM_WEBHOOK_SECRET is required'),
  TELEGRAM_ALLOWED_USER_IDS: z.string().transform((val) => 
    val.split(',').map(id => id.trim()).filter(Boolean)
  ),
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:3000'),
  PORT: z.string().default('3000'),
  NODE_ENV: z.enum(['development', 'production']).default('development'),
  XDG_DATA_HOME: z.string().default('/data'),
  DEFAULT_MODEL: z.string().default('kimi/kimi-k2.5-free'),
  MAX_CONCURRENT_JOBS: z.string().transform((val) => parseInt(val, 10)).default('2'),
  SESSION_IDLE_TIMEOUT_HOURS: z.string().transform((val) => parseInt(val, 10)).default('3'),
  DATA_DIR: z.string().default('/data'),
  WORKSPACE_BASE: z.string().default('/tmp/agent'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info')
});

const parsed = configSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid configuration:', parsed.error.format());
  process.exit(1);
}

export const config = parsed.data;
