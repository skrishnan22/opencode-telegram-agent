import { spawn } from 'child_process';
import { config } from '../config.js';

/**
 * Perform interactive login using PTY
 */
export async function performLogin({ provider, onUrl }) {
  return new Promise((resolve) => {
    let outputBuffer = '';
    let urlFound = false;

    const opencode = spawn('opencode', ['auth', 'login'], {
      env: {
        ...process.env,
        XDG_DATA_HOME: config.XDG_DATA_HOME
      },
      // Use PTY if available, otherwise stdio
      stdio: ['pipe', 'pipe', 'pipe']
    });

    // Send provider selection
    setTimeout(() => {
      if (!opencode.killed) {
        // Try to send input to select OpenAI
        opencode.stdin.write('\n'); // Select first option or default
      }
    }, 500);

    opencode.stdout.on('data', (data) => {
      const text = data.toString();
      outputBuffer += text;

      // Look for URL in output
      if (!urlFound) {
        const urlMatch = text.match(/(https?:\/\/[^\s]+)/);
        if (urlMatch) {
          urlFound = true;
          onUrl(urlMatch[1]);
        }
      }

      // Check for completion
      if (text.includes('Successfully') || text.includes('Done')) {
        resolve({ success: true });
      }
    });

    opencode.stderr.on('data', (data) => {
      const text = data.toString();
      outputBuffer += text;

      // Some CLI tools output to stderr
      if (!urlFound) {
        const urlMatch = text.match(/(https?:\/\/[^\s]+)/);
        if (urlMatch) {
          urlFound = true;
          onUrl(urlMatch[1]);
        }
      }
    });

    opencode.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true });
      } else {
        resolve({ 
          success: false, 
          error: `Login process exited with code ${code}. Output: ${outputBuffer.slice(-500)}`
        });
      }
    });

    opencode.on('error', (error) => {
      resolve({ 
        success: false, 
        error: error.message 
      });
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      if (!opencode.killed) {
        opencode.kill();
        resolve({ 
          success: false, 
          error: 'Login timeout (5 minutes exceeded)' 
        });
      }
    }, 5 * 60 * 1000);
  });
}
