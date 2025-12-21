import type { CommandResult } from '../../../apiTypes';

type Props = { results: CommandResult[] };

export default function ResultsPanel({ results }: Props) {
  return (
    <div class="card">
      <div style="font-weight:700; margin-bottom:8px;">Results</div>
      {results.length === 0 && <div style="color:#94a3b8; font-size:12px;">No results yet.</div>}
      {results.map((r) => (
        <div key={`${r.commandId}-${r.clientId}`} style="border-bottom:1px solid #e2e8f0; padding:8px 0;">
          <div style="display:flex; justify-content: space-between; align-items:center; flex-wrap: wrap; gap:6px;">
            <div>#{r.commandId} · {r.clientId}</div>
            <span style={`padding:2px 8px; border-radius:999px; background:${r.status === 'ok' ? '#dcfce7' : '#fee2e2'}; color:${r.status === 'ok' ? '#15803d' : '#b91c1c'}`}>{r.status}</span>
          </div>
          <div style="font-weight:600; margin-top:4px;">{r.summary}</div>
          {r.parsed && <pre>{JSON.stringify(r.parsed, null, 2)}</pre>}
          {r.error && <pre style="background:#fef2f2; color:#991b1b;">{JSON.stringify(r.error, null, 2)}</pre>}
          {r.artifacts?.htmlFile && (
            <a href={r.artifacts.htmlFile} target="_blank" rel="noreferrer">HTML artifact</a>
          )}
          {r.artifacts?.jsonFile && (
            <a href={r.artifacts.jsonFile} target="_blank" rel="noreferrer" style="margin-left:8px;">JSON artifact</a>
          )}
        </div>
      ))}
    </div>
  );
}
