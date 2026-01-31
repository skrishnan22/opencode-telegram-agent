import { sessionManager } from './session.js';
import { jobQueue } from './queue.js';
import { config } from '../config.js';

/**
 * Start the cleanup worker
 * Runs every 30 minutes to clean up idle sessions and old jobs
 */
export function startCleanupWorker() {
  const intervalMs = 30 * 60 * 1000; // 30 minutes

  console.log(`Starting cleanup worker (interval: ${intervalMs}ms)`);

  // Run immediately on start
  runCleanup();

  // Schedule recurring runs
  setInterval(runCleanup, intervalMs);
}

async function runCleanup() {
  console.log('Running cleanup...');

  try {
    // Cleanup idle sessions
    await sessionManager.cleanupIdleSessions(config.SESSION_IDLE_TIMEOUT_HOURS);

    // Cleanup old jobs
    jobQueue.cleanupOldJobs(24); // Keep jobs for 24 hours

    console.log('Cleanup completed');
  } catch (error) {
    console.error('Cleanup error:', error);
  }
}
