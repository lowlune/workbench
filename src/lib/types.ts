export type AgentStatus = 'working' | 'blocked' | 'idle' | 'done' | 'unknown' | 'history' | string;

export interface Agent {
  paneId: string;
  tabId?: string;
  workspaceId?: string;
  agent: string;
  status: AgentStatus;
  title: string;
  cwd?: string;
  sessionId?: string | null;
  sessionTitle?: string | null;
  updated?: number | null;
}

export interface Session {
  id: string;
  title?: string | null;
  directory?: string;
  created?: number;
  updated?: number;
  agent?: string;
  preview?: string;
  live?: boolean;
  status?: AgentStatus;
  model?: {
    id?: string;
    providerID?: string;
    variant?: string;
    name?: string;
    contextLimit?: number;
    outputLimit?: number;
  } | null;
  messages?: Message[];
  messageTotal?: number;
  messageOffset?: number;
  hasMoreMessages?: boolean;
  canResume?: boolean;
  resumeStatus?: 'working' | 'idle' | 'unknown';
}

export interface MessagePart {
  id: string;
  type: string;
  text?: string;
  mime?: string;
  filename?: string;
  url?: string;
  tool?: string;
  callID?: string;
  state?: {
    status?: string;
    title?: string;
    time?: unknown;
    output?: string;
    error?: string;
    raw?: string;
    input?: unknown;
  };
}

export interface Message {
  id: string;
  created?: number;
  info: {
    role: 'user' | 'assistant';
    agent?: string;
    modelID?: string;
    providerID?: string;
    modelName?: string;
    contextLimit?: number;
    outputLimit?: number;
    variant?: string;
    mode?: string;
    tokens?: {
      input?: number;
      output?: number;
      reasoning?: number;
      total?: number;
      cache?: { read?: number; write?: number };
    };
  };
  parts: MessagePart[];
}

export interface SystemStats {
  load?: number[];
  cpuCount?: number;
  memoryTotal?: number;
  memoryFree?: number;
  memoryUsed?: number;
  memoryPercent?: number;
  swap?: { total?: number; free?: number; used?: number };
}

export interface Overview {
  system: SystemStats;
  agents: Agent[];
  sessions: Session[];
  directories: { name: string; directory: string }[];
}

export interface Clip {
  id: string;
  kind: 'text' | 'image';
  text?: string;
  filename?: string;
  mime?: string;
  device?: string;
  created?: number;
}

export interface ApiErrorPayload {
  error?: string;
}
