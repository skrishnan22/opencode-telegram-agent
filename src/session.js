import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { config } from '../config.js';

const SESSIONS_DIR = path.join(config.DATA_DIR, 'sessions');
const AUTH_FILE = path.join(config.XDG_DATA_HOME, 'opencode', 'auth.json');

class SessionManager {
  constructor() {
    this.sessions = new Map(); // In-memory cache
  }

  async init() {
    await fs.mkdir(SESSIONS_DIR, { recursive: true });
    await fs.mkdir(path.dirname(AUTH_FILE), { recursive: true });
    
    // Load existing sessions
    try {
      const files = await fs.readdir(SESSIONS_DIR);
      for (const file of files) {
        if (file.endsWith('.json')) {
          const chatId = file.replace('.json', '');
          const data = await fs.readFile(path.join(SESSIONS_DIR, file), 'utf8');
          this.sessions.set(chatId, JSON.parse(data));
        }
      }
    } catch (error) {
      console.log('No existing sessions to load');
    }
  }

  async getOrCreateSession(chatId) {
    let session = this.sessions.get(chatId.toString());
    
    if (!session || session.status === 'ended') {
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
      await this.cleanupSession(existing);
    }

    const sessionId = randomUUID();
    const workspacePath = path.join(config.WORKSPACE_BASE, sessionId, 'workspace');
    const dataDir = path.join(config.WORKSPACE_BASE, sessionId, 'data');
    const logsDir = path.join(config.WORKSPACE_BASE, sessionId, 'logs');

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
        session.serverProcess.kill();
      }

      // Clean up workspace
      const baseDir = path.dirname(session.workspacePath);
      await fs.rm(baseDir, { recursive: true, force: true });
    } catch (error) {
      console.error('Failed to cleanup session:', error);
    }
  }

  async copyAuthToSession(dataDir) {
    try {
      await fs.access(AUTH_FILE);
      const targetDir = path.join(dataDir, 'opencode');
      await fs.mkdir(targetDir, { recursive: true });
      await fs.copyFile(AUTH_FILE, path.join(targetDir, 'auth.json'));
    } catch (error) {
      // Auth file doesn't exist yet
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
