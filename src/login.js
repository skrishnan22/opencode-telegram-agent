import { spawn as spawnChild } from 'child_process';
import * as pty from 'node-pty';
import { config } from '../config.js';

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

    const handleOutput = (data) => {
      const text = stripAnsi(data.toString());
      outputBuffer += text;

      if (!urlFound) {
        const urlMatch = extractUrl(text);
        if (urlMatch) {
          urlFound = true;
          onUrl(urlMatch);
        }
      }

      if (text.includes('Successfully') || text.includes('Done')) {
        finalize({ success: true });
      }
    };

    let processHandle = null;

    try {
      if (pty && typeof pty.spawn === 'function') {
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
            opencode.write(providerLabel);
            opencode.write('\r');
          } else {
            opencode.write('\r');
          }
        }, 500);
      } else {
        const opencode = spawnChild('opencode', ['auth', 'login'], {
          env,
          stdio: ['pipe', 'pipe', 'pipe']
        });

        processHandle = opencode;
        opencode.stdout.on('data', handleOutput);
        opencode.stderr.on('data', handleOutput);

        opencode.on('close', (code) => {
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
            opencode.stdin.write(`${providerLabel}\n`);
          } else {
            opencode.stdin.write('\n');
          }
        }, 500);
      }
    } catch (error) {
      finalize({
        success: false,
        error: error.message
      });
    }

    // Timeout after 5 minutes
    setTimeout(() => {
      if (processHandle && !killed) {
        killed = true;
        processHandle.kill();
        finalize({
          success: false,
          error: 'Login timeout (5 minutes exceeded)'
        });
      }
    }, 5 * 60 * 1000);
  });
}
