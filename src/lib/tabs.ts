import { useSyncExternalStore } from 'react';
import type { Attention, RunState } from '@/lib/types';

/* ------------------------------------------------------------------------ *
 * Tabs store
 *
 * Tabs are a working set of open conversations, not history. `order` is the
 * raw open order, `pinned` a subset that floats to the top, and `activeId`
 * caches the last active tab so a reload with no hash can fall back to it.
 * The route (`#chat/:id`) stays the source of truth for "what is active";
 * this store only mirrors it.
 * ------------------------------------------------------------------------ */

export interface TabsState {
  order: string[];
  pinned: string[];
  activeId: string | null;
}

/** Derived, never duplicated: one lightweight view per open tab. */
export interface TabView {
  id: string;
  title: string;
  status: RunState | null;
  attention: Attention;
  running: boolean;
  pinned: boolean;
  projectId?: string | null;
  updated?: number;
  started?: number | null;
}

export const MAX_TABS = 12;
const STORAGE_KEY = 'workbench-tabs';
const SCROLL_KEY = 'workbench-tab-scroll';

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string' || !value || seen.has(value)) continue;
    seen.add(value);
    output.push(value);
  }
  return output;
}

function load(): TabsState {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null') as Partial<TabsState> | null;
    if (raw && typeof raw === 'object') {
      const order = dedupe(Array.isArray(raw.order) ? raw.order : []);
      const pinned = dedupe(Array.isArray(raw.pinned) ? raw.pinned : []).filter((id) => order.includes(id));
      const activeId = typeof raw.activeId === 'string' && order.includes(raw.activeId) ? raw.activeId : null;
      return { order, pinned, activeId };
    }
  } catch { /* Storage may be disabled; tabs just start empty. */ }
  return { order: [], pinned: [], activeId: null };
}

let state: TabsState = load();
const listeners = new Set<() => void>();
let persistTimer: number | undefined;
let serverSync: ((next: TabsState) => void) | undefined;

function persist() {
  window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* Preference is optional. */ }
    serverSync?.(state);
  }, 250);
}

function emit() {
  for (const listener of listeners) listener();
  persist();
}

function commit(patch: Partial<TabsState>) {
  state = { ...state, ...patch };
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getTabsState(): TabsState {
  return state;
}

/** React binding; the snapshot identity only changes on an actual mutation. */
export function useTabs(): TabsState {
  return useSyncExternalStore(subscribe, getTabsState, getTabsState);
}

/* ---- Mutations --------------------------------------------------------- */

/**
 * Open a conversation in the rail (or just activate it). Returns the ids that
 * were evicted once MAX_TABS was exceeded so the caller can toast them.
 */
export function openTab(id: string): string[] {
  if (!id) return [];
  if (state.order.includes(id)) {
    if (state.activeId !== id) commit({ activeId: id });
    return [];
  }
  const evicted: string[] = [];
  let order = state.order.includes(id) ? state.order : [...state.order, id];
  if (order.length > MAX_TABS) {
    const active = id;
    order = order.filter((candidate) => {
      if (order.length - evicted.length <= MAX_TABS) return true;
      if (candidate === active || state.pinned.includes(candidate)) return true;
      evicted.push(candidate);
      return false;
    });
  }
  const pinned = state.pinned.filter((candidate) => order.includes(candidate));
  commit({ order, pinned, activeId: id });
  return evicted;
}

/** Ensure a tab exists without stealing focus (background opens). */
export function ensureTab(id: string): string[] {
  if (!id || state.order.includes(id)) return [];
  const activeId = state.activeId;
  const evicted = openTab(id);
  commit({ activeId });
  return evicted;
}

export function closeTab(id: string): void {
  const order = state.order.filter((candidate) => candidate !== id);
  commit({
    order,
    pinned: state.pinned.filter((candidate) => candidate !== id),
    activeId: state.activeId === id ? null : state.activeId,
  });
}

export function setActiveTab(id: string | null): void {
  if (id && !state.order.includes(id)) {
    openTab(id);
    return;
  }
  if (state.activeId === id) return;
  commit({ activeId: id });
}

export function togglePin(id: string): void {
  if (!state.order.includes(id)) return;
  const pinnedNow = !state.pinned.includes(id);
  const pinned = pinnedNow
    ? [...state.pinned, id]
    : state.pinned.filter((candidate) => candidate !== id);
  /* Pinning floats the tab to the top; the rail renders `order` as-is. */
  const order = pinnedNow ? [id, ...state.order.filter((candidate) => candidate !== id)] : state.order;
  commit({ pinned, order });
}

export function reorderTabs(orderedIds: string[]): void {
  const listed = orderedIds.filter((id) => state.order.includes(id));
  const rest = state.order.filter((id) => !listed.includes(id));
  const order = [...listed, ...rest];
  if (order.length === state.order.length && order.every((id, index) => id === state.order[index])) return;
  commit({ order });
}

export function closeOtherTabs(id: string): void {
  const order = state.order.filter((candidate) => candidate === id || state.pinned.includes(candidate));
  commit({ order, pinned: state.pinned.filter((candidate) => order.includes(candidate)), activeId: id });
}

export function closeAllTabs(): void {
  const order = state.order.filter((candidate) => state.pinned.includes(candidate));
  commit({ order, pinned: state.pinned.filter((candidate) => order.includes(candidate)), activeId: null });
}

/** Drop tabs whose conversation no longer exists / is archived (§10). */
export function reconcileTabs(validIds: Set<string>): string[] {
  const removed = state.order.filter((id) => !validIds.has(id));
  if (!removed.length) return removed;
  const order = state.order.filter((id) => validIds.has(id));
  commit({
    order,
    pinned: state.pinned.filter((id) => order.includes(id)),
    activeId: state.activeId && order.includes(state.activeId) ? state.activeId : null,
  });
  return removed;
}

/** Adopt another device's working set, but never overwrite local tabs. */
export function adoptServerTabs(server: Partial<TabsState> | null | undefined): void {
  if (!server || state.order.length) return;
  const order = dedupe(Array.isArray(server.order) ? server.order : []).slice(0, MAX_TABS);
  if (!order.length) return;
  state = {
    order,
    pinned: dedupe(Array.isArray(server.pinned) ? server.pinned : []).filter((id) => order.includes(id)),
    activeId: typeof server.activeId === 'string' && order.includes(server.activeId) ? server.activeId : order[0],
  };
  emit();
}

/** Wire persistence to the server for multi-device sync (P2, §6). */
export function setTabsServerSync(sync: ((next: TabsState) => void) | undefined): void {
  serverSync = sync;
}

/* ---- Per-tab scroll --------------------------------------------------- */

const scrollMemory = new Map<string, number>();
let scrollLoaded = false;
let scrollFlush: number | undefined;

function loadScrollMemory() {
  if (scrollLoaded) return;
  scrollLoaded = true;
  try {
    const raw = JSON.parse(sessionStorage.getItem(SCROLL_KEY) || '{}') as Record<string, number>;
    for (const [id, value] of Object.entries(raw)) {
      if (typeof value === 'number' && Number.isFinite(value)) scrollMemory.set(id, value);
    }
  } catch { /* Session scroll restore is a convenience. */ }
}

export function readTabScroll(id: string): number | undefined {
  loadScrollMemory();
  return scrollMemory.get(id);
}

export function writeTabScroll(id: string, top: number): void {
  if (!id || !Number.isFinite(top)) return;
  loadScrollMemory();
  scrollMemory.set(id, Math.max(0, Math.round(top)));
  window.clearTimeout(scrollFlush);
  scrollFlush = window.setTimeout(() => {
    try { sessionStorage.setItem(SCROLL_KEY, JSON.stringify(Object.fromEntries(scrollMemory))); } catch { /* ignore */ }
  }, 400);
}

export function forgetTabScroll(id: string): void {
  loadScrollMemory();
  scrollMemory.delete(id);
}
