import { useMemo, useState } from 'preact/hooks';
import type { DebugLogEntry, LogLevel, LogSource } from '../../../apiTypes';

type Props = { logs: DebugLogEntry[] };

const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
const sources: LogSource[] = ['background', 'content', 'popup', 'options', 'debug-server', 'cdp'];

export default function LogsPanel({ logs }: Props) {
  const [levelFilter, setLevelFilter] = useState<Set<LogLevel>>(new Set(levels));
  const [sourceFilter, setSourceFilter] = useState<LogSource | 'all'>('all');
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    return logs.filter((log) => {
      if (!levelFilter.has(log.level as LogLevel)) return false;
      if (sourceFilter !== 'all' && log.source !== sourceFilter) return false;
      if (search && !`${log.message} ${JSON.stringify(log.context ?? {})}`.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [logs, levelFilter, sourceFilter, search]);

  return (
    <div class="card">
      <div style="display:flex; justify-content: space-between; align-items:center; margin-bottom:8px;">
        <div style="font-weight:700;">Logs</div>
        <input
          type="text"
          placeholder="Search text"
          value={search}
          onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
          style="border:1px solid #e2e8f0; border-radius:8px; padding:6px 8px; font-size:12px;"
        />
      </div>
      <div style="display:flex; gap:8px; flex-wrap: wrap; margin-bottom:8px; font-size:12px;">
        {levels.map((lvl) => (
          <label key={lvl} style="display:flex; align-items:center; gap:4px;">
            <input
              type="checkbox"
              checked={levelFilter.has(lvl)}
              onChange={(e) => {
                const next = new Set(levelFilter);
                const checked = (e.target as HTMLInputElement).checked;
                if (checked) next.add(lvl); else next.delete(lvl);
                setLevelFilter(next);
              }}
            />
            {lvl}
          </label>
        ))}
        <select
          value={sourceFilter}
          onChange={(e) => setSourceFilter((e.target as HTMLSelectElement).value as any)}
          style="border:1px solid #e2e8f0; border-radius:8px; padding:6px 8px; font-size:12px; margin-left:auto;"
        >
          <option value="all">All sources</option>
          {sources.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
      <div style="max-height:60vh; overflow:auto;">
        <table class="table">
          <thead>
            <tr><th>Time</th><th>Level</th><th>Source</th><th>Message</th><th>Context</th></tr>
          </thead>
          <tbody>
            {filtered.map((log, idx) => (
              <tr key={`${log.timestamp}-${idx}`}>
                <td>{log.timestamp}</td>
                <td>{log.level}</td>
                <td>{log.source}</td>
                <td>{log.message}</td>
                <td><pre style="background:#f1f5f9; color:#0f172a;">{JSON.stringify(log.context ?? {}, null, 2)}</pre></td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={5} style="color:#94a3b8; text-align:center; padding:12px;">No matching logs.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
