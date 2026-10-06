import type { Attachment } from '@/lib/attachments';

export type Engine = 'opencode' | 'pi';
export type AgentStatus = 'working' | 'blocked' | 'idle' | 'done' | 'unknown' | 'history' | string;

/** A follow-up the user typed while an agent was still responding. In v2 it
 *  lives on the server; the component shape stays for the restored UI. */
export interface QueuedMessage {
  id: string;
  text: string;
  attachments: Attachment[];
  model?: string;
}

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

export interface ActiveRun {
  id: string;
  status: string;
  error?: string | null;
  model: string;
  started?: number | null;
  ended?: number | null;
}

export interface Interaction {
  id: string;
  kind: 'permission' | 'question';
  permission?: string;
  patterns?: string[];
  questions?: { question: string; header?: string; multiple?: boolean; options: { label: string; description?: string }[] }[];
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
  engine?: Engine;
  projectId?: string | null;
  revision?: number;
  model?: ModelOption | null;
  messages?: Message[];
  messageTotal?: number;
  messageOffset?: number;
  hasMoreMessages?: boolean;
  canResume?: boolean;
  resumeStatus?: 'working' | 'idle' | 'unknown';
  modelPref?: string | null;
  pinned?: boolean;
  hidden?: boolean;
  customTitle?: boolean;
  tags?: string[];
  reasoning?: string | null;
  mode?: 'plan' | 'build';
  paused?: boolean;
  legacy?: boolean;
  activeRun?: ActiveRun | null;
  queued?: { id: string; text: string; model: string; attachments?: { id: string; name: string; mime: string }[] }[];
  interactions?: Interaction[];
  capabilities?: Record<string, boolean>;
}

export interface ModelCost { input?: number; output?: number; currency?: string }

export interface ModelOption {
  id: string;
  name: string;
  provider: string;
  contextLimit?: number;
  outputLimit?: number;
}

export interface Offering extends ModelOption {
  engine: Engine;
  connectionId?: string;
  connectionLabel?: string;
  authKind?: 'subscription' | 'api_key' | 'oauth' | 'unknown';
  planLabel?: string;
  images?: boolean;
  reasoning?: boolean;
  variants?: string[];
  cost?: ModelCost;
  available?: boolean;
  stale?: boolean;
  unavailableReason?: string;
  pricingSource?: string;
  catalogFetchedAt?: number;
}

export interface ModelDefaults {
  user?: string | null;
  project?: string | null;
  conversation?: string | null;
}

export interface Connection {
  id: string;
  engine: Engine | 'opencode' | 'pi';
  provider: string;
  label: string;
  auth: string;
  authKind: 'subscription' | 'api_key' | 'oauth' | 'unknown';
  health: 'ok' | 'error' | 'unknown';
  healthMessage?: string | null;
  modelCount: number;
  consoleUrl?: string;
  quotaStatus: 'not_available' | 'reported' | 'stale';
  checkedAt?: number;
}

export interface Project {
  id: string;
  name: string;
  directory: string;
  model?: string | null;
  defaults?: Partial<Record<Engine, string | null>>;
  workspaces?: string[];
  conversationCount?: number;
  lastUsedAt?: number | null;
  missing?: boolean;
}

export interface Bootstrap {
  sessions: Session[];
  projects: Project[];
  seq: number;
  defaults: Partial<Record<Engine, string | null>>;
  engines: Engine[];
  connections?: Connection[];
  nextCursor?: string | null;
  maxRuns?: number;
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
  artifactId?: string;
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
  revision?: number;
  commandId?: string;
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
    cost?: number | null;
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
  uptime?: number;
}

export interface SystemSample {
  t: number;
  cpu: number;
  memoryPercent: number;
  memoryUsed: number;
}

export interface SystemSnapshot extends SystemStats {
  cpu?: { percent: number; cores: number };
  disk?: { total: number; free: number; used: number; percent: number };
  sampledAt?: number;
}

export interface ProcessInfo {
  pid: number;
  cpu: number;
  memory: number;
  etimes: number;
  user: string;
  name: string;
  args: string;
}

export interface Overview {
  system: SystemStats;
  agents: Agent[];
  sessions: Session[];
  directories: { name: string; directory: string }[];
}

/** Legacy clip shape used by the restored ClipsView. */
export interface Clip {
  id: string;
  kind: 'text' | 'image';
  text?: string;
  filename?: string;
  mime?: string;
  device?: string;
  created?: number;
  dataUrl?: string;
}

export interface UsageTotals {
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number | null;
  unknownCost: number;
}

export interface UsageBreakdown extends UsageTotals {
  key?: string;
  label: string;
  engine?: string;
  provider?: string;
  model?: string;
  projectId?: string | null;
}

export interface UsageResponse {
  days: number;
  from: number;
  coverage: string;
  totals: UsageTotals;
  daily: { day: string; requests: number; input: number; output: number; cost: number | null }[];
  byModel: UsageBreakdown[];
  byProject: UsageBreakdown[];
  byEngine: UsageBreakdown[];
}

export interface ApiErrorPayload {
  error?: string;
}
