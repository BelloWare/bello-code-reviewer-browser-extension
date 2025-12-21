import { useEffect, useMemo, useState } from 'preact/hooks';
import StatusPanel from './components/StatusPanel';
import LogsPanel from './components/LogsPanel';
import CommandsPanel from './components/CommandsPanel';
import ResultsPanel from './components/ResultsPanel';
import type { ClientStatus, CommandResult, DebugLogEntry, SessionInfo } from '../../apiTypes';

const API = (import.meta as any).env?.VITE_DEBUG_API || 'http://localhost:3030';
const DEBUG_TOKEN = (import.meta as any).env?.X_DEBUG_TOKEN_BLLO_CODE_REVIEWER || '';

const buildHeaders = (withJson: boolean) => {
  const headers: Record<string, string> = {};
  if (withJson) headers['Content-Type'] = 'application/json';
  if (DEBUG_TOKEN) headers['X-Debug-Token'] = DEBUG_TOKEN;
  return headers;
};

async function getJSON<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, { headers: buildHeaders(false) });
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return res.json();
}

async function postJSON<T>(path: string, body: any): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: buildHeaders(true),
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return res.json();
}

export default function App() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [clients, setClients] = useState<ClientStatus[]>([]);
  const [logs, setLogs] = useState<DebugLogEntry[]>([]);
  const [results, setResults] = useState<CommandResult[]>([]);
  const [queueSize, setQueueSize] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const tick = async () => {
      try {
        const status = await getJSON<{ session: SessionInfo; clients: ClientStatus[]; queue: { pending: number } }>('/status');
        setSession(status.session);
        setClients(status.clients);
        setQueueSize(status.queue.pending);
      } catch (err) {
        setError((err as Error).message);
      }
    };
    const logTick = async () => {
      try {
        const data = await getJSON<{ logs: DebugLogEntry[] }>('/logs?tail=200');
        setLogs(data.logs ?? []);
      } catch (err) {
        setError((err as Error).message);
      }
    };
    const resultTick = async () => {
      try {
        const data = await getJSON<{ results: CommandResult[] }>('/results?limit=100');
        setResults(data.results ?? []);
      } catch (err) {
        setError((err as Error).message);
      }
    };

    tick();
    logTick();
    resultTick();
    const statusId = setInterval(tick, 4000);
    const logsId = setInterval(logTick, 6000);
    const resId = setInterval(resultTick, 5000);
    return () => {
      clearInterval(statusId);
      clearInterval(logsId);
      clearInterval(resId);
    };
  }, []);

  const lastCommands = useMemo(() => results.slice(0, 10).map((r) => ({ commandId: r.commandId, type: (r as any).type ?? '', status: r.status, summary: r.summary })), [results]);

  return (
    <div class="row">
      <div style="flex:2; min-width:320px;">
        <StatusPanel session={session} clients={clients} queueSize={queueSize} onReset={async () => {
          await postJSON('/session/reset', {});
          setResults([]);
          setLogs([]);
        }} />
        <CommandsPanel
          onSend={async (payload) => {
            await postJSON('/command', payload);
          }}
          recent={lastCommands}
        />
        <ResultsPanel results={results} />
      </div>
      <div style="flex:3; min-width:420px;">
        <LogsPanel logs={logs} />
      </div>
      {error && <div class="card" style="color:#b91c1c;">{error}</div>}
    </div>
  );
}
