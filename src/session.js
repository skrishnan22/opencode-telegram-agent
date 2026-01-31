import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { config } from '../config.js';

const SESSIONS_DIR = path.join(config.DATA_DIR, 'sessions');
const AUTH_FILE = path.join(config.XDG_DATA_HOME, 'opencode', 'auth.json');

const LOG_PREFIX = 'session';

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

class SessionManager {
  constructor() {
    this.sessions = new Map(); // In-memory cache
  }

  async init() {
    logInfo('initializing session manager', { sessionsDir: SESSIONS_DIR });
    await fs.mkdir(SESSIONS_DIR, { recursive: true });
    await fs.mkdir(path.dirname(AUTH_FILE), { recursive: true });
    
    // Load existing sessions
    try {
      const files = await fs.readdir(SESSIONS_DIR);
      let loaded = 0;
      for (const file of files) {
        if (file.endsWith('.json')) {
          const chatId = file.replace('.json', '');
          const data = await fs.readFile(path.join(SESSIONS_DIR, file), 'utf8');
          this.sessions.set(chatId, JSON.parse(data));
          loaded += 1;
        }
      }
      logInfo('loaded sessions', { count: loaded });
    } catch (error) {
      logInfo('no existing sessions to load');
    }
  }

  async getOrCreateSession(chatId) {
    let session = this.sessions.get(chatId.toString());
    
    if (!session || session.status === 'ended') {
      logInfo('creating new session', { chatId: chatId.toString() });
      session = await this.createNewSession(chatId);
    }
    
    // Update last active
    session.lastActive = Date.now();
    await this.saveSession(chatId, session);
    
    return session;
  }

  async createNewSession(chatId) {
    // End existing session if any
    const existing = this.sessions.get(chatId.toString());
    if (existing) {
      logInfo('ending existing session', { chatId: chatId.toString(), sessionId: existing.id });
      await this.cleanupSession(existing);
    }

    const sessionId = randomUUID();
    const workspacePath = path.join(config.WORKSPACE_BASE, sessionId, 'workspace');
    const dataDir = path.join(config.WORKSPACE_BASE, sessionId, 'data');
    const logsDir = path.join(config.WORKSPACE_BASE, sessionId, 'logs');

    logInfo('creating session directories', {
      chatId: chatId.toString(),
      sessionId,
      workspacePath,
      dataDir,
      logsDir
    });

    // Create directories
    await fs.mkdir(workspacePath, { recursive: true });
    await fs.mkdir(dataDir, { recursive: true });
    await fs.mkdir(logsDir, { recursive: true });

    // Copy auth file if exists
    await this.copyAuthToSession(dataDir);

    const session = {
      id: sessionId,
      chatId: chatId.toString(),
      workspacePath,
      dataDir,
      logsDir,
      model: config.DEFAULT_MODEL,
      opencodeSessionId: null,
      lastActive: Date.now(),
      status: 'active',
      pendingApprovals: {},
      serverPort: null,
      permissions: {} // Cached permissions for "approve all"
    };

    this.sessions.set(chatId.toString(), session);
    await this.saveSession(chatId, session);

    logInfo('session created', {
      chatId: chatId.toString(),
      sessionId,
      model: session.model
    });

    return session;
  }

  async getSession(chatId) {
    return this.sessions.get(chatId.toString());
  }

  async setSessionModel(chatId, modelId) {
    const session = await this.getOrCreateSession(chatId);
    session.model = modelId;
    await this.saveSession(chatId, session);
  }

  async endSession(chatId) {
    const session = this.sessions.get(chatId.toString());
    if (session) {
      logInfo('ending session', { chatId: chatId.toString(), sessionId: session.id });
      await this.cleanupSession(session);
      session.status = 'ended';
      await this.saveSession(chatId, session);
      this.sessions.delete(chatId.toString());
    }
  }

  async saveSession(chatId, session) {
    const filePath = path.join(SESSIONS_DIR, `${chatId}.json`);
    await fs.writeFile(filePath, JSON.stringify(session, null, 2));
  }

  async cleanupSession(session) {
    try {
      // Kill any running server
      if (session.serverProcess) {
        logInfo('stopping session server process', { sessionId: session.id });
        session.serverProcess.kill();
      }

      // Clean up workspace
      const baseDir = path.dirname(session.workspacePath);
      logInfo('removing session workspace', { sessionId: session.id, baseDir });
      await fs.rm(baseDir, { recursive: true, force: true });
    } catch (error) {
      logError('failed to cleanup session', { sessionId: session.id, error: error.message });
    }
  }

  async copyAuthToSession(dataDir) {
    try {
      await fs.access(AUTH_FILE);
      const targetDir = path.join(dataDir, 'opencode');
      await fs.mkdir(targetDir, { recursive: true });
      await fs.copyFile(AUTH_FILE, path.join(targetDir, 'auth.json'));
      logInfo('copied auth to session', { targetDir });
    } catch (error) {
      // Auth file doesn't exist yet
      logInfo('no auth file to copy', { authPath: AUTH_FILE });
    }
  }

  async syncAuthFromSession(dataDir) {
    try {
      const sessionAuth = path.join(dataDir, 'opencode', 'auth.json');
      await fs.access(sessionAuth);
      await fs.copyFile(sessionAuth, AUTH_FILE);
    } catch (error) {
      // No auth to sync
    }
  }

  getAllSessions() {
    return Array.from(this.sessions.values());
  }

  async cleanupIdleSessions(maxAgeHours = config.SESSION_IDLE_TIMEOUT_HOURS) {
    const now = Date.now();
    const maxAgeMs = maxAgeHours * 60 * 60 * 1000;

    for (const [chatId, session] of this.sessions) {
      if (now - session.lastActive > maxAgeMs) {
        console.log(`Cleaning up idle session: ${chatId}`);
        await this.endSession(chatId);
      }
    }
  }
}

export const sessionManager = new SessionManager();
