import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import fse from 'fs-extra';
import {
  ClientStatus,
  Command,
  CommandResult,
  DebugLogEntry,
  HeartbeatPayload,
  SessionInfo
} from './apiTypes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEBUG_TOKEN_ENV = 'X_DEBUG_TOKEN_BLLO_CODE_REVIEWER';
const DEBUG_TOKEN = process.env[DEBUG_TOKEN_ENV] ?? '';
if (DEBUG_TOKEN.length <= 10) {
  console.error(`[debug-server] ${DEBUG_TOKEN_ENV} must be set to a value longer than 10 characters.`);
  process.exit(1);
}

const app = express();
const isAllowedOrigin = (origin: string): boolean => {
  if (origin.startsWith('chrome-extension://')) return true;
  if (/^http:\/\/localhost(?::\d+)?$/.test(origin)) return true;
  if (/^http:\/\/127\.0\.0\.1(?::\d+)?$/.test(origin)) return true;
  return false;
};
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (isAllowedOrigin(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-Debug-Token']
}));
app.use(bodyParser.json({ limit: '5mb' }));

const requireDebugToken = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (req.method === 'OPTIONS') {
    next();
    return;
  }
  const token = req.get('X-Debug-Token') ?? '';
  if (token !== DEBUG_TOKEN) {
    res.status(401).json({ error: 'Missing or invalid debug token.' });
    return;
  }
  next();
};

const rootDir = path.resolve(__dirname, '../');
const uiDistDir = path.resolve(__dirname, 'web-ui', 'dist');
const logsDir = path.join(rootDir, 'logs');
const resultsDir = path.join(logsDir, 'results');
const htmlDir = path.join(logsDir, 'html');
const historyDir = path.join(logsDir, 'history');

let session: SessionInfo = {
  id: `session-${Date.now().toString(36)}`,
  startedAt: new Date().toISOString()
};
let commands: Command[] = [];
let results: CommandResult[] = [];
const clients = new Map<string, ClientStatus>();
let nextCommandId = 1;

async function ensureDirs() {
  await Promise.all([
    fse.ensureDir(logsDir),
    fse.ensureDir(resultsDir),
    fse.ensureDir(htmlDir),
    fse.ensureDir(historyDir)
  ]);
}

function msAgo(iso: string): number {
  return Date.now() - new Date(iso).getTime();
}

async function appendLog(entry: DebugLogEntry) {
  await ensureDirs();
  const line = JSON.stringify(entry) + '\n';
  await fs.appendFile(path.join(logsDir, 'debug.log'), line, 'utf8');
}

app.post('/log', requireDebugToken, async (req, res) => {
  const body = req.body as Partial<DebugLogEntry>;
  const entry: DebugLogEntry = {
    timestamp: body.timestamp || new Date().toISOString(),
    level: body.level || 'info',
    source: body.source || 'debug-server',
    message: body.message || '',
    context: body.context,
    stack: body.stack
  };
  await appendLog(entry).catch(() => {});
  res.json({ ok: true });
});

app.post('/heartbeat', requireDebugToken, async (req, res) => {
  const payload = req.body as HeartbeatPayload;
  const now = new Date().toISOString();
  const status: ClientStatus = {
    clientId: payload.clientId,
    extensionVersion: payload.extensionVersion,
    lastSeenAt: now,
    lastSeenMsAgo: 0,
    debugFlags: payload.debugFlags
  };
  clients.set(payload.clientId, status);
  res.json({ ok: true });
});

app.get('/status', requireDebugToken, (_req, res) => {
  const clientList = Array.from(clients.values()).map((c) => ({
    ...c,
    lastSeenMsAgo: msAgo(c.lastSeenAt)
  }));
  res.json({
    session,
    clients: clientList,
    queue: { pending: commands.length, inFlight: 0 }
  });
});

app.post('/command', requireDebugToken, (req, res) => {
  const { type, payload, targetClientId, correlationId } = req.body as Partial<Command>;
  if (!type) {
    res.status(400).json({ error: 'type required' });
    return;
  }
  const cmd: Command = {
    commandId: nextCommandId++,
    type,
    payload,
    targetClientId,
    correlationId,
    createdAt: new Date().toISOString()
  };
  commands.push(cmd);
  res.json({ commandId: cmd.commandId });
});

app.get('/command', requireDebugToken, (req, res) => {
  const clientId = req.query.clientId as string | undefined;
  const idx = commands.findIndex((cmd) => !cmd.targetClientId || cmd.targetClientId === clientId);
  if (idx === -1) {
    res.json({ command: null });
    return;
  }
  const [cmd] = commands.splice(idx, 1);
  res.json({ command: cmd });
});

app.post('/result', requireDebugToken, async (req, res) => {
  const { rawHtml, override, ...body } = req.body as (CommandResult & { rawHtml?: string; override?: boolean });
  const result: CommandResult = {
    ...body,
    createdAt: body.createdAt || new Date().toISOString(),
    artifacts: body.artifacts ?? {}
  };
  const commandId = Number(result.commandId);
  if (!Number.isFinite(commandId)) {
    res.status(400).json({ error: 'commandId must be numeric.' });
    return;
  }
  result.commandId = commandId;
  await ensureDirs();
  if (rawHtml) {
    const htmlFile = path.join(htmlDir, `${result.commandId}.html`);
    await fs.writeFile(htmlFile, rawHtml, 'utf8');
    result.artifacts = { ...(result.artifacts ?? {}), htmlFile: `/logs/html/${result.commandId}.html` };
  }
  if (result.parsed) {
    const jsonFile = path.join(resultsDir, `${result.commandId}.json`);
    await fs.writeFile(jsonFile, JSON.stringify(result.parsed, null, 2), 'utf8');
    result.artifacts = { ...(result.artifacts ?? {}), jsonFile: `/logs/results/${result.commandId}.json` };
  }
  if (override) {
    results = results.filter((r) => r.commandId !== result.commandId);
  }
  results.push(result);
  if (results.length > 200) results = results.slice(-200);
  res.json({ ok: true });
});

app.get('/results', requireDebugToken, (req, res) => {
  const limit = Number(req.query.limit ?? 50);
  res.json({ results: results.slice(-limit).reverse() });
});

app.post('/session/reset', requireDebugToken, async (_req, res) => {
  await ensureDirs();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(historyDir, stamp);
  await fse.ensureDir(dest);
  const moves: Array<Promise<void>> = [];
  const currentLog = path.join(logsDir, 'debug.log');
  const currentResults = resultsDir;
  const currentHtml = htmlDir;

  if (await fse.pathExists(currentLog)) {
    await fse.ensureDir(path.join(dest, 'logs'));
    moves.push(fse.move(currentLog, path.join(dest, 'logs', 'debug.log'), { overwrite: true }));
  }
  if (await fse.pathExists(currentResults)) {
    await fse.ensureDir(path.join(dest, 'results'));
    moves.push(fse.move(currentResults, path.join(dest, 'results'), { overwrite: true }));
  }
  if (await fse.pathExists(currentHtml)) {
    await fse.ensureDir(path.join(dest, 'html'));
    moves.push(fse.move(currentHtml, path.join(dest, 'html'), { overwrite: true }));
  }
  await Promise.all(moves);
  await ensureDirs();

  commands = [];
  results = [];
  clients.clear();
  session = { id: `session-${Date.now().toString(36)}`, startedAt: new Date().toISOString() };
  res.json({ ok: true, session });
});

app.get('/logs', requireDebugToken, async (req, res) => {
  const tail = Number(req.query.tail ?? 200);
  const file = path.join(logsDir, 'debug.log');
  try {
    const data = await fs.readFile(file, 'utf8');
    const lines = data.trim().split('\n').slice(-tail).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
    res.json({ logs: lines });
  } catch {
    res.json({ logs: [] });
  }
});

app.use('/logs', express.static(logsDir));

app.use('/', express.static(uiDistDir));
app.get('*', (_req, res) => {
  const indexPath = path.join(uiDistDir, 'index.html');
  res.sendFile(indexPath, (err) => {
    if (err) res.status(200).send('Debug server running. Build web-ui for UI.');
  });
});

const portRaw = process.env.DEBUG_SERVER_PORT ?? process.env.PORT ?? '3030';
const port = Number(portRaw) || 3030;
(async () => {
  await ensureDirs();
  app.listen(port, '127.0.0.1', () => {
    console.log(`[debug-server] listening on http://127.0.0.1:${port}`);
  });
})();
