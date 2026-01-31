import { spawn as spawnChild } from 'child_process';
import * as pty from 'node-pty';
import { config } from '../config.js';

const LOG_PREFIX = 'login';

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

const PROVIDER_LABELS = {
  openai: 'OpenAI',
  google: 'Google',
  codex: 'codex'
};

const ANSI_REGEX = /\x1B\[[0-?]*[ -/]*[@-~]/g;

function stripAnsi(text) {
  return text.replace(ANSI_REGEX, '');
}

function extractUrl(text) {
  const match = text.match(/https?:\/\/[^\s'"\)\]]+/);
  return match ? match[0] : null;
}

/**
 * Perform interactive login using PTY
 */
export async function performLogin({ provider, onUrl }) {
  return new Promise((resolve) => {
    let outputBuffer = '';
    let urlFound = false;
    let resolved = false;
    let killed = false;
    let lastOutputLogAt = 0;

    const finalize = (result) => {
      if (resolved) {
        return;
      }
      resolved = true;
      resolve(result);
    };

    const providerKey = typeof provider === 'string' ? provider.toLowerCase() : '';
    const providerLabel = PROVIDER_LABELS[providerKey] || provider;

    const env = {
      ...process.env,
      XDG_DATA_HOME: config.XDG_DATA_HOME,
      TERM: 'xterm-256color'
    };

    logInfo('starting login process', { provider: providerLabel, XDG_DATA_HOME: config.XDG_DATA_HOME });

    const handleOutput = (data) => {
      const text = stripAnsi(data.toString());
      outputBuffer += text;

      const now = Date.now();
      if (now - lastOutputLogAt > 2000) {
        const snippet = text.replace(/\s+/g, ' ').trim().slice(0, 200);
        if (snippet) {
          logInfo('login output', { snippet });
        }
        lastOutputLogAt = now;
      }

      if (!urlFound) {
        const urlMatch = extractUrl(text);
        if (urlMatch) {
          urlFound = true;
          logInfo('login url detected', { url: urlMatch });
          onUrl(urlMatch);
        }
      }

      if (text.includes('Successfully') || text.includes('Done')) {
        logInfo('login completed successfully');
        finalize({ success: true });
      }
    };

    let processHandle = null;

    try {
      if (pty && typeof pty.spawn === 'function') {
        logInfo('using PTY for login');
        const opencode = pty.spawn('opencode', ['auth', 'login'], {
          name: 'xterm-256color',
          cols: 80,
          rows: 24,
          env,
          cwd: process.cwd()
        });

        processHandle = opencode;
        opencode.onData(handleOutput);
        opencode.onExit(({ exitCode }) => {
          logInfo('login process exited', { exitCode });
          if (exitCode === 0) {
            finalize({ success: true });
          } else {
            finalize({
              success: false,
              error: `Login process exited with code ${exitCode}. Output: ${outputBuffer.slice(-500)}`
            });
          }
        });

        setTimeout(() => {
          if (killed) {
            return;
          }

          if (providerLabel) {
            logInfo('sending provider selection', { provider: providerLabel });
            opencode.write(providerLabel);
            opencode.write('\r');
          } else {
            logInfo('sending default provider selection');
            opencode.write('\r');
          }
        }, 500);
      } else {
        logInfo('using stdio for login');
        const opencode = spawnChild('opencode', ['auth', 'login'], {
          env,
          stdio: ['pipe', 'pipe', 'pipe']
        });

        processHandle = opencode;
        opencode.stdout.on('data', handleOutput);
        opencode.stderr.on('data', handleOutput);

        opencode.on('close', (code) => {
          logInfo('login process closed', { code });
          if (code === 0) {
            finalize({ success: true });
          } else {
            finalize({
              success: false,
              error: `Login process exited with code ${code}. Output: ${outputBuffer.slice(-500)}`
            });
          }
        });

        opencode.on('error', (error) => {
          logError('login process error', { error: error.message });
          finalize({
            success: false,
            error: error.message
          });
        });

        setTimeout(() => {
          if (killed) {
            return;
          }

          if (providerLabel) {
            logInfo('sending provider selection', { provider: providerLabel });
            opencode.stdin.write(`${providerLabel}\n`);
          } else {
            logInfo('sending default provider selection');
            opencode.stdin.write('\n');
          }
        }, 500);
      }
    } catch (error) {
      logError('login setup failed', { error: error.message });
      finalize({
        success: false,
        error: error.message
      });
    }

    // Timeout after 5 minutes
    setTimeout(() => {
      if (processHandle && !killed) {
        killed = true;
        logError('login timed out');
        processHandle.kill();
        finalize({
          success: false,
          error: 'Login timeout (5 minutes exceeded)'
        });
      }
    }, 5 * 60 * 1000);
  });
}
