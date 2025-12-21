import type { ClientStatus, SessionInfo } from '../../../apiTypes';

type Props = {
  session: SessionInfo | null;
  clients: ClientStatus[];
  queueSize: number;
  onReset: () => Promise<void>;
};

export default function StatusPanel({ session, clients, queueSize, onReset }: Props) {
  return (
    <div class="card">
      <div style="display:flex; justify-content: space-between; align-items:center;">
        <div>
          <div style="font-weight:700;">Session</div>
          <div style="color:#475569; font-size:12px;">{session ? `${session.id} · ${session.startedAt}` : 'Loading...'}</div>
        </div>
        <button class="secondary" onClick={onReset}>Reset Session</button>
      </div>
      <div style="margin-top:8px; font-size:13px; color:#334155;">Queue pending: {queueSize}</div>
      <div style="margin-top:12px;">
        <div style="font-weight:700; margin-bottom:4px;">Clients</div>
        {clients.length === 0 && <div style="color:#94a3b8; font-size:12px;">No heartbeats yet.</div>}
        {clients.map((client) => (
          <div key={client.clientId} style="padding:6px 0; border-bottom:1px solid #e2e8f0;">
            <div style="font-weight:600;">{client.clientId}</div>
            <div style="color:#475569; font-size:12px;">
              v{client.extensionVersion} · last seen {Math.round(client.lastSeenMsAgo / 1000)}s ago
            </div>
            {client.debugFlags?.length ? (
              <div style="color:#0ea5e9; font-size:12px;">Flags: {client.debugFlags.join(', ')}</div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
