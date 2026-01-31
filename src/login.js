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
    let selectionSent = false;
    let selectionTimer = null;
    let enterPulseTimer = null;
    let enterPulseCount = 0;
    let writeInput = null;
    let isPty = false;

    const finalize = (result) => {
      if (resolved) {
        return;
      }
      resolved = true;
      if (selectionTimer) {
        clearTimeout(selectionTimer);
      }
      if (enterPulseTimer) {
        clearInterval(enterPulseTimer);
      }
      resolve(result);
    };

    const providerKey = typeof provider === 'string' ? provider.toLowerCase() : '';
    const providerLabel = PROVIDER_LABELS[providerKey] || provider;
    const providerInput = providerKey || providerLabel;

    const env = {
      ...process.env,
      XDG_DATA_HOME: config.XDG_DATA_HOME,
      TERM: 'xterm-256color'
    };

    logInfo('starting login process', {
      provider: providerLabel,
      providerInput,
      XDG_DATA_HOME: config.XDG_DATA_HOME
    });

    const sendInput = (value) => {
      if (!writeInput || killed || resolved) {
        return;
      }
      const payload = isPty ? value : value.replace(/\r/g, '\n');
      writeInput(payload);
    };

    const startEnterPulse = () => {
      if (enterPulseTimer) {
        return;
      }

      enterPulseTimer = setInterval(() => {
        if (killed || resolved || urlFound) {
          clearInterval(enterPulseTimer);
          enterPulseTimer = null;
          return;
        }

        enterPulseCount += 1;
        logInfo('sending enter to advance login', { count: enterPulseCount });
        sendInput('\r');

        if (enterPulseCount >= 6) {
          clearInterval(enterPulseTimer);
          enterPulseTimer = null;
        }
      }, 3000);
    };

    const sendProviderSelection = () => {
      if (selectionSent) {
        return;
      }
      selectionSent = true;

      if (providerInput) {
        logInfo('sending provider selection', { provider: providerInput });
        sendInput(providerInput);
        sendInput('\r');
      } else {
        logInfo('sending default provider selection');
        sendInput('\r');
      }

      startEnterPulse();
    };

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

      if (!selectionSent) {
        const normalized = text.toLowerCase();
        if (normalized.includes('select provider') || normalized.includes('add credential')) {
          sendProviderSelection();
        }
      }
    };

    let processHandle = null;

    try {
      if (pty && typeof pty.spawn === 'function') {
        logInfo('using PTY for login');
        isPty = true;
        const opencode = pty.spawn('opencode', ['--print-logs', '--log-level', 'INFO', 'auth', 'login'], {
          name: 'xterm-256color',
          cols: 80,
          rows: 24,
          env,
          cwd: process.cwd()
        });

        processHandle = opencode;
        writeInput = (value) => opencode.write(value);
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

        selectionTimer = setTimeout(sendProviderSelection, 1500);
      } else {
        logInfo('using stdio for login');
        isPty = false;
        const opencode = spawnChild('opencode', ['--print-logs', '--log-level', 'INFO', 'auth', 'login'], {
          env,
          stdio: ['pipe', 'pipe', 'pipe']
        });

        processHandle = opencode;
        writeInput = (value) => opencode.stdin.write(value);
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

        selectionTimer = setTimeout(sendProviderSelection, 1500);
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
        logError('login timed out', { output: outputBuffer.slice(-500) });
        processHandle.kill();
        finalize({
          success: false,
          error: 'Login timeout (5 minutes exceeded)'
        });
      }
    }, 5 * 60 * 1000);
  });
}
