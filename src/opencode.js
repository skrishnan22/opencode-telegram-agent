import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import getPort from 'get-port';
import { createOpencode, createOpencodeClient } from '@opencode-ai/sdk';
import { config } from '../config.js';

const LOG_PREFIX = 'opencode';

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

function createLineLogger(logFn, label) {
  let buffer = '';
  return (data) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) {
        logFn(`${label}: ${trimmed}`);
      }
    }
  };
}

async function respondToPermission(client, { sessionID, requestID, reply, message }) {
  if (client?.permission?.reply) {
    return client.permission.reply({
      requestID,
      reply,
      message
    });
  }

  if (client?.permission?.respond) {
    return client.permission.respond({
      sessionID,
      permissionID: requestID,
      response: reply
    });
  }

  if (client?.session?.postSessionByIdPermissionsByPermissionId) {
    return client.session.postSessionByIdPermissionsByPermissionId({
      path: {
        id: sessionID,
        permissionID: requestID
      },
      body: {
        response: reply
      }
    });
  }

  throw new Error('No permission reply method available in SDK client');
}

/**
 * Start OpenCode server for a session
 */
export async function startOpenCodeServer(session) {
  // Get available port
  const port = await getPort();
  
  // Start server process
  logInfo('starting OpenCode server', { port, workspace: session.workspacePath });
  const serverProcess = spawn('opencode', [
    'serve',
    '--hostname', '127.0.0.1',
    '--port', port.toString(),
    '--print-logs',
    '--log-level', 'INFO'
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

  const stdoutLogger = createLineLogger(logInfo, 'server');
  const stderrLogger = createLineLogger(logError, 'server');
  serverProcess.stdout?.on('data', stdoutLogger);
  serverProcess.stderr?.on('data', stderrLogger);
  serverProcess.on('exit', (code, signal) => {
    logError('OpenCode server exited', { code, signal, port });
  });
  serverProcess.on('error', (error) => {
    logError('OpenCode server spawn error', { error: error.message, port });
  });

  session.serverProcess = serverProcess;
  session.serverPort = port;

  // Wait for server to be ready
  logInfo('waiting for OpenCode server to be ready', { port, timeout: 30000 });
  await waitForServer(port);

  logInfo('OpenCode server ready', { port });

  return port;
}

/**
 * Run OpenCode with a message
 */
export async function runOpenCode({ session, message, onProgress, onApproval }) {
  logInfo('runOpenCode called', {
    sessionId: session.id,
    chatId: session.chatId,
    model: session.model,
    hasServerPort: !!session.serverPort,
    hasServerProcess: !!session.serverProcess,
    messageLength: message.length
  });

  // Ensure server is running
  if (!session.serverPort || !session.serverProcess) {
    logInfo('starting new OpenCode server for session', { sessionId: session.id });
    await startOpenCodeServer(session);
  } else {
    logInfo('reusing existing OpenCode server', { port: session.serverPort });
  }

  const baseUrl = `http://127.0.0.1:${session.serverPort}`;
  logInfo('creating OpenCode SDK client', { baseUrl });
  const client = createOpencodeClient({ baseUrl });
  logInfo('SDK client created', { clientMethods: Object.keys(client || {}) });

  // Get or create OpenCode session
  let opencodeSessionId = session.opencodeSessionId;
  if (!opencodeSessionId) {
    logInfo('creating OpenCode session', { chatId: session.chatId });
    try {
      const newSession = await client.session.create({
        body: { title: `Telegram session ${session.chatId}` }
      });
      logInfo('session.create response', {
        hasData: !!newSession?.data,
        dataKeys: newSession?.data ? Object.keys(newSession.data) : []
      });
      opencodeSessionId = newSession.data.id;
      session.opencodeSessionId = opencodeSessionId;
      logInfo('OpenCode session created', { sessionId: opencodeSessionId });
    } catch (createError) {
      logError('failed to create OpenCode session', {
        error: createError.message,
        stack: createError.stack
      });
      throw createError;
    }
  } else {
    logInfo('reusing existing OpenCode session', { sessionId: opencodeSessionId });
  }

  // Parse model
  const [providerId, modelId] = session.model.split('/');
  logInfo('running prompt', { sessionId: opencodeSessionId, model: session.model });

  // Subscribe to events
  const events = await client.event.subscribe();
  logInfo('event stream subscribed', { sessionId: opencodeSessionId });
  logInfo('event stream details', {
    hasStream: !!events?.stream,
    eventsType: typeof events,
    eventsKeys: events ? Object.keys(events) : []
  });
  const outputBuffer = [];
  const completedTextParts = new Set();
  const textPartLengths = new Map();
  let startTime = Date.now();

  // Send the prompt
  const promptPromise = client.session
    .prompt({
      path: { id: opencodeSessionId },
      body: {
        model: { providerID: providerId, modelID: modelId },
        parts: [{ type: 'text', text: message }]
      }
    })
    .then((result) => {
      logInfo('prompt accepted', { sessionId: opencodeSessionId });
      return result;
    })
    .catch((error) => {
      logError('prompt failed', { sessionId: opencodeSessionId, error: error.message });
      throw error;
    });

  // Handle events concurrently
  const eventPromise = (async () => {
    try {
      logInfo('starting event loop', { sessionId: opencodeSessionId });
      let eventCount = 0;
      for await (const event of events.stream) {
        eventCount++;
        const sessionIdFromEvent =
          event.properties?.sessionID ||
          event.properties?.part?.sessionID ||
          event.properties?.info?.id ||
          event.properties?.info?.sessionID;

        logInfo('event received', {
          eventNumber: eventCount,
          type: event.type,
          sessionIdFromEvent,
          targetSessionId: opencodeSessionId,
          propertiesKeys: event.properties ? Object.keys(event.properties) : []
        });

        if (sessionIdFromEvent && sessionIdFromEvent !== opencodeSessionId) {
          logInfo('skipping event for different session', { sessionIdFromEvent, opencodeSessionId });
          continue;
        }

        logInfo('processing event', { type: event.type, sessionId: sessionIdFromEvent });

        if (event.type === 'message.part.updated') {
          const part = event.properties?.part;
          if (!part || part.sessionID !== opencodeSessionId) {
            continue;
          }

          if (part.type === 'text') {
            if (event.properties?.delta) {
              outputBuffer.push(event.properties.delta);
              const current = textPartLengths.get(part.id) || 0;
              textPartLengths.set(part.id, current + event.properties.delta.length);
            } else if (part.time?.end && !completedTextParts.has(part.id)) {
              if (!textPartLengths.has(part.id)) {
                outputBuffer.push(part.text || '');
              }
              completedTextParts.add(part.id);
            }
          }

          if (onProgress) {
            onProgress({
              output: outputBuffer.join(''),
              elapsed: Math.floor((Date.now() - startTime) / 1000),
              event
            });
          }
        }

        if (event.type === 'session.error') {
          const errorMessage = event.properties?.error?.data?.message || event.properties?.error?.name || 'OpenCode session error';
          logError('session error event', {
            sessionId: opencodeSessionId,
            error: errorMessage,
            fullError: JSON.stringify(event.properties?.error || {}).slice(0, 500)
          });
          throw new Error(errorMessage);
        }

        if (event.type === 'session.idle') {
          logInfo('session idle event received', {
            eventSessionId: event.properties?.sessionID,
            targetSessionId: opencodeSessionId,
            isMatch: event.properties?.sessionID === opencodeSessionId,
            outputBufferLength: outputBuffer.length
          });
          if (event.properties?.sessionID === opencodeSessionId) {
            logInfo('breaking event loop due to session.idle', { sessionId: opencodeSessionId });
            break;
          }
        }

        if (event.type === 'permission.asked' || event.type === 'permission.updated') {
          if (!onApproval) {
            continue;
          }

          const permission = event.properties;
          const requestId = permission.id || permission.requestID || permission.permissionID;
          if (!requestId) {
            logError('permission event missing id', { event });
            continue;
          }

          const decision = await onApproval({
            id: requestId,
            tool: permission.permission || permission.type,
            input: permission.metadata || {}
          });

          const reply = decision.approved ? (decision.remember ? 'always' : 'once') : 'reject';

          await respondToPermission(client, {
            sessionID: opencodeSessionId,
            requestID: requestId,
            reply
          });

          if (decision.remember && decision.approved && (permission.permission || permission.type)) {
            session.permissions[permission.permission || permission.type] = 'allow';
          }
        }
      }

      logInfo('event stream completed', {
        sessionId: opencodeSessionId,
        totalEventsReceived: eventCount,
        outputBufferItems: outputBuffer.length,
        outputLength: outputBuffer.join('').length,
        completedPartsCount: completedTextParts.size
      });
    } catch (error) {
      logError('event stream error', {
        error: error.message,
        stack: error.stack,
        eventsProcessed: eventCount
      });
      throw error;
    }
  })();

  // Wait for both
  logInfo('waiting for prompt and event stream to complete', { sessionId: opencodeSessionId });
  const [result] = await Promise.all([promptPromise, eventPromise]);

  // FALLBACK: If event streaming didn't provide content, extract from prompt result
  if (outputBuffer.length === 0 && result?.data?.parts) {
    logInfo('event stream provided no content, using prompt result fallback', {
      partsCount: result.data.parts.length,
      partTypes: result.data.parts.map(p => p.type)
    });
    for (const part of result.data.parts) {
      if (part.type === 'text' && part.text) {
        outputBuffer.push(part.text);
      }
    }
  }

  logInfo('runOpenCode completed', {
    sessionId: opencodeSessionId,
    outputLength: outputBuffer.join('').length,
    duration: Math.floor((Date.now() - startTime) / 1000),
    hasResult: !!result
  });

  // Sync auth back to persistent storage
  await syncAuthFromSession(session);

  const finalOutput = outputBuffer.join('');
  logInfo('returning from runOpenCode', {
    outputPreview: finalOutput.slice(0, 200),
    totalLength: finalOutput.length
  });

  return {
    output: finalOutput,
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
