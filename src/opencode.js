import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import getPort from 'get-port';
import { createOpencode, createOpencodeClient } from '@opencode-ai/sdk';
import { config } from '../config.js';

/**
 * Start OpenCode server for a session
 */
export async function startOpenCodeServer(session) {
  // Get available port
  const port = await getPort();
  
  // Start server process
  const serverProcess = spawn('opencode', [
    'serve',
    '--hostname', '127.0.0.1',
    '--port', port.toString()
  ], {
    cwd: session.workspacePath,
    env: {
      ...process.env,
      XDG_DATA_HOME: session.dataDir,
      HOME: session.workspacePath,
      OPENCODE_PERMISSION: JSON.stringify(getPermissionConfig(session))
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  session.serverProcess = serverProcess;
  session.serverPort = port;

  // Wait for server to be ready
  await waitForServer(port);

  return port;
}

/**
 * Run OpenCode with a message
 */
export async function runOpenCode({ session, message, onProgress, onApproval }) {
  // Ensure server is running
  if (!session.serverPort || !session.serverProcess) {
    await startOpenCodeServer(session);
  }

  const client = createOpencodeClient({
    baseUrl: `http://127.0.0.1:${session.serverPort}`
  });

  // Get or create OpenCode session
  let opencodeSessionId = session.opencodeSessionId;
  if (!opencodeSessionId) {
    const newSession = await client.session.create({
      body: { title: `Telegram session ${session.chatId}` }
    });
    opencodeSessionId = newSession.data.id;
    session.opencodeSessionId = opencodeSessionId;
  }

  // Parse model
  const [providerId, modelId] = session.model.split('/');

  // Subscribe to events
  const events = await client.event.subscribe();
  const outputBuffer = [];
  let startTime = Date.now();

  // Send the prompt
  const promptPromise = client.session.prompt({
    path: { id: opencodeSessionId },
    body: {
      model: { providerID: providerId, modelID: modelId },
      parts: [{ type: 'text', text: message }]
    }
  });

  // Handle events concurrently
  const eventPromise = (async () => {
    for await (const event of events.stream) {
      if (event.type === 'message') {
        // Collect output
        const content = extractContent(event);
        if (content) {
          outputBuffer.push(content);
        }

        // Report progress
        if (onProgress) {
          onProgress({
            output: outputBuffer.join('\n'),
            elapsed: Math.floor((Date.now() - startTime) / 1000),
            event
          });
        }
      } else if (event.type === 'permission_request') {
        // Handle permission request
        if (onApproval) {
          const decision = await onApproval({
            id: event.properties.permission_id,
            tool: event.properties.tool,
            input: event.properties.input
          });

          // Respond to permission
          await client.session.postSessionByIdPermissionsByPermissionId({
            path: { 
              id: opencodeSessionId, 
              permissionID: event.properties.permission_id 
            },
            body: {
              response: decision.approved ? 'allow' : 'deny',
              remember: decision.remember
            }
          });

          // Cache permission if "remember"
          if (decision.remember && decision.approved) {
            session.permissions[event.properties.tool] = 'allow';
          }
        }
      }
    }
  })();

  // Wait for both
  const [result] = await Promise.all([promptPromise, eventPromise]);

  // Sync auth back to persistent storage
  await syncAuthFromSession(session);

  return {
    output: outputBuffer.join('\n'),
    duration: Math.floor((Date.now() - startTime) / 1000),
    result
  };
}

/**
 * List available models from OpenAI
 */
export async function listModels() {
  // Use CLI to list models
  return new Promise((resolve, reject) => {
    const opencode = spawn('opencode', ['models', 'openai', '--refresh'], {
      env: { ...process.env, XDG_DATA_HOME: config.XDG_DATA_HOME }
    });

    let output = '';
    opencode.stdout.on('data', (data) => {
      output += data.toString();
    });

    opencode.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`opencode models failed with code ${code}`));
        return;
      }

      // Parse output (format: "provider/model - name")
      const models = output
        .split('\n')
        .filter(line => line.includes('/'))
        .map(line => {
          const [idPart, ...nameParts] = line.split(' - ');
          return {
            id: idPart.trim(),
            name: nameParts.join(' - ').trim() || idPart.trim()
          };
        });

      resolve(models);
    });

    opencode.on('error', reject);
  });
}

/**
 * Wait for OpenCode server to be ready
 */
async function waitForServer(port, timeout = 30000) {
  const start = Date.now();
  
  while (Date.now() - start < timeout) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/global/health`);
      if (response.ok) {
        return;
      }
    } catch (e) {
      // Server not ready yet
    }
    await new Promise(r => setTimeout(r, 100));
  }
  
  throw new Error('OpenCode server failed to start');
}

/**
 * Extract text content from event
 */
function extractContent(event) {
  if (event.properties?.parts) {
    return event.properties.parts
      .filter(p => p.type === 'text')
      .map(p => p.text)
      .join('');
  }
  return null;
}

/**
 * Get permission configuration for session
 */
function getPermissionConfig(session) {
  // Base permissions
  const permissions = {
    '*': 'ask',
    'bash': {
      '*': 'ask',
      'git *': 'allow',
      'git status *': 'allow',
      'git log *': 'allow',
      'git diff *': 'allow',
      'git add *': 'allow',
      'git commit *': 'ask',
      'git push *': 'deny',
      'npm *': 'allow',
      'pnpm *': 'allow',
      'yarn *': 'allow',
      'pip *': 'allow',
      'pip3 *': 'allow',
      'python *': 'allow',
      'node *': 'allow',
      'grep *': 'allow',
      'cat *': 'allow',
      'ls *': 'allow',
      'find *': 'allow',
      'rm *': 'deny',
      'sudo *': 'deny',
      'docker *': 'deny',
      'kubectl *': 'deny',
      'curl *': 'ask',
      'wget *': 'ask'
    },
    'edit': {
      '*': 'ask'
    },
    'external_directory': 'deny',
    'doom_loop': 'ask'
  };

  // Merge with cached session permissions
  for (const [tool, action] of Object.entries(session.permissions || {})) {
    if (typeof permissions[tool] === 'object') {
      permissions[tool]['*'] = action;
    } else {
      permissions[tool] = action;
    }
  }

  return permissions;
}

/**
 * Sync auth from session back to persistent storage
 */
async function syncAuthFromSession(session) {
  try {
    const sessionAuthPath = path.join(session.dataDir, 'opencode', 'auth.json');
    const persistentAuthPath = path.join(config.XDG_DATA_HOME, 'opencode', 'auth.json');
    
    await fs.access(sessionAuthPath);
    await fs.copyFile(sessionAuthPath, persistentAuthPath);
  } catch (error) {
    // No auth to sync
  }
}
