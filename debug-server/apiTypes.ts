export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogSource =
  | 'background'
  | 'content'
  | 'popup'
  | 'options'
  | 'debug-server'
  | 'cdp';

export interface DebugLogEntry {
  timestamp: string;  // ISO
  level: LogLevel;
  source: LogSource;
  message: string;
  context?: Record<string, unknown>;
  stack?: string;
}

export interface HeartbeatPayload {
  clientId: string;
  extensionVersion: string;
  debugFlags?: string[];
}

export interface ClientStatus {
  clientId: string;
  extensionVersion: string;
  lastSeenAt: string;
  lastSeenMsAgo: number;
  debugFlags?: string[];
}

export interface Command {
  commandId: number;
  type: string;
  payload?: Record<string, unknown>;
  targetClientId?: string;
  correlationId?: string;
  createdAt: string;
}

export type CommandStatus = 'ok' | 'error';

export interface CommandResult {
  commandId: number;
  clientId: string;
  status: CommandStatus;
  summary: string;
  parsed?: Record<string, unknown>;
  error?: {
    message: string;
    stack?: string;
    details?: any;
  };
  artifacts?: {
    htmlFile?: string;
    jsonFile?: string;
  };
  createdAt: string;
}

export interface SessionInfo {
  id: string;
  startedAt: string;
}
