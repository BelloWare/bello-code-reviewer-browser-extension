import { useState } from 'preact/hooks';

type CommandPayload = {
  type: string;
  payload?: Record<string, unknown>;
  targetClientId?: string;
  correlationId?: string;
};

type Props = {
  onSend: (payload: CommandPayload) => Promise<void>;
  recent: Array<{ commandId: number; type: string; status: string; summary: string }>;
};

export default function CommandsPanel({ onSend, recent }: Props) {
  const defaultPayload = '{ "example": true }';
  const [typeInput, setTypeInput] = useState('');
  const [payloadInput, setPayloadInput] = useState(defaultPayload);
  const [targetInput, setTargetInput] = useState('');

  return (
    <div class="card">
      <div style="font-weight:700; margin-bottom:8px;">Commands</div>
      <div style="display:flex; gap:8px; flex-direction:column;">
        <input
          type="text"
          placeholder="Type (e.g., reloadExtension, evalInTab)"
          value={typeInput}
          onInput={(e) => setTypeInput((e.target as HTMLInputElement).value)}
          style="border:1px solid #e2e8f0; border-radius:8px; padding:8px;"
        />
        <textarea
          rows={4}
          placeholder={defaultPayload}
          value={payloadInput}
          onInput={(e) => setPayloadInput((e.target as HTMLTextAreaElement).value)}
          style="border:1px solid #e2e8f0; border-radius:8px; padding:8px; font-family: monospace;"
        ></textarea>
        <input
          type="text"
          placeholder="Target clientId (optional)"
          value={targetInput}
          onInput={(e) => setTargetInput((e.target as HTMLInputElement).value)}
          style="border:1px solid #e2e8f0; border-radius:8px; padding:8px;"
        />
        <button
          onClick={async () => {
            let payload: Record<string, unknown> | undefined;
            if (payloadInput.trim()) {
              try {
                payload = JSON.parse(payloadInput);
              } catch {
                alert("Invalid JSON payload");
                return;
              }
            }
            await onSend({ type: typeInput || 'reloadExtension', payload, targetClientId: targetInput || undefined });
          }}
        >
          Send command
        </button>
      </div>
      <div style="margin-top:12px;">
        <div style="font-weight:700; margin-bottom:4px;">Recent</div>
        {recent.length === 0 && <div style="color:#94a3b8; font-size:12px;">No recent commands.</div>}
        {recent.map((cmd) => (
          <div key={cmd.commandId} style="border-bottom:1px solid #e2e8f0; padding:6px 0;">
            #{cmd.commandId} · {cmd.type || 'unknown'} · {cmd.status} · {cmd.summary}
          </div>
        ))}
      </div>
    </div>
  );
}
