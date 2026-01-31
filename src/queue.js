import PQueue from 'p-queue';
import { randomUUID } from 'crypto';
import { config } from '../config.js';

class JobQueue {
  constructor() {
    this.queue = new PQueue({ concurrency: config.MAX_CONCURRENT_JOBS });
    this.jobs = new Map();
    this.runningJobs = new Map(); // chatId -> jobId
  }

  async add(chatId, userId, message, executor) {
    const jobId = randomUUID().slice(0, 8);
    
    // Check if session already has a running job
    if (this.runningJobs.has(chatId.toString())) {
      // Queue it anyway, PQueue will handle concurrency
    }

    const job = {
      id: jobId,
      chatId: chatId.toString(),
      userId,
      message,
      status: 'queued',
      createdAt: Date.now(),
      startedAt: null,
      endedAt: null,
      error: null
    };

    this.jobs.set(jobId, job);

    // Add to queue
    const queuePromise = this.queue.add(async () => {
      job.status = 'running';
      job.startedAt = Date.now();
      this.runningJobs.set(chatId.toString(), jobId);

      try {
        const result = await executor((progressData) => {
          // Progress callback
        });

        job.status = 'completed';
        job.endedAt = Date.now();
        return result;
      } catch (error) {
        job.status = 'failed';
        job.error = error.message;
        job.endedAt = Date.now();
        throw error;
      } finally {
        this.runningJobs.delete(chatId.toString());
      }
    });

    return jobId;
  }

  getPosition(jobId) {
    // Get queue position (approximate since PQueue doesn't expose this directly)
    let position = 0;
    for (const [id, job] of this.jobs) {
      if (job.status === 'queued' && id !== jobId) {
        position++;
      } else if (id === jobId) {
        break;
      }
    }
    return position;
  }

  getJob(jobId) {
    return this.jobs.get(jobId);
  }

  async cancelSessionJobs(chatId) {
    const chatIdStr = chatId.toString();
    const runningJobId = this.runningJobs.get(chatIdStr);
    
    if (runningJobId) {
      const job = this.jobs.get(runningJobId);
      if (job && job.abortController) {
        job.abortController.abort();
        return 1;
      }
    }
    
    // Cancel queued jobs for this session
    let cancelled = 0;
    for (const [id, job] of this.jobs) {
      if (job.chatId === chatIdStr && job.status === 'queued') {
        job.status = 'cancelled';
        cancelled++;
      }
    }
    
    return cancelled;
  }

  getAllJobs() {
    return Array.from(this.jobs.values());
  }

  cleanupOldJobs(maxAgeHours = 24) {
    const now = Date.now();
    const maxAgeMs = maxAgeHours * 60 * 60 * 1000;

    for (const [id, job] of this.jobs) {
      if (job.endedAt && now - job.endedAt > maxAgeMs) {
        this.jobs.delete(id);
      }
    }
  }
}

export const jobQueue = new JobQueue();
