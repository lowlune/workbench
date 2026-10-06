export type Engine = 'opencode' | 'pi';

export interface ModelCost { input?: number; output?: number; currency?: string }

export interface Offering {
  id: string;
  name: string;
  provider: string;
  engine: Engine;
  connectionId?: string;
  connectionLabel?: string;
  authKind?: 'subscription' | 'api_key' | 'oauth' | 'unknown';
  planLabel?: string;
  contextLimit?: number;
  outputLimit?: number;
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

export interface ActiveRun {
  id: string;
  status: string;
  error?: string | null;
  model: string;
  started?: number | null;
  ended?: number | null;
}

export interface QueuedTurn {
  id: string;
  text: string;
  model: string;
  attachments?: { id: string; name: string; mime: string }[];
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
  projectId?: string | null;
  engine?: Engine;
  modelPref?: string | null;
  reasoning?: string | null;
  mode?: 'plan' | 'build';
  revision?: number;
  created?: number;
  updated?: number;
  pinned?: boolean;
  hidden?: boolean;
  paused?: boolean;
  legacy?: boolean;
  canResume?: boolean;
  resumeStatus?: 'working' | 'idle' | 'unknown';
  status?: string;
  /** Derived client flag: a run is actively working in this conversation. */
  live?: boolean;
  activeRun?: ActiveRun | null;
  queued?: QueuedTurn[];
  interactions?: Interaction[];
  capabilities?: Record<string, boolean>;
  messages?: Message[];
  hasMoreMessages?: boolean;
  nextBefore?: string | null;
}

export interface Bootstrap {
  sessions: Session[];
  projects: Project[];
  seq: number;
  defaults: Partial<Record<Engine, string | null>>;
  engines: Engine[];
  connections?: Connection[];
  nextCursor?: string | null;
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
  key: string;
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

export interface Clip {
  id: string;
  projectId: string | null;
  title: string;
  text: string;
  pinned: number;
  created: number;
  attachment: { id: string; name: string; mime: string } | null;
}

export interface ProjectFile {
  path: string;
  name: string;
  directory: boolean;
  size: number;
  modified: number;
}

export interface ApiErrorPayload {
  error?: string;
}
