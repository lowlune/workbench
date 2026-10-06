import type { NotificationItem } from './types';

/* Notification preferences live in localStorage so every tab shares them and
   the SSE handler can read them without React state (§33). */
export interface NotificationPreferences {
  browser: boolean;
  onlyWhenHidden: boolean;
  attention: boolean;
  completed: boolean;
}

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  browser: false,
  onlyWhenHidden: true,
  attention: true,
  completed: true,
};

const STORAGE_KEY = 'workbench-notifications';

export function readNotificationPreferences(): NotificationPreferences {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return { ...DEFAULT_NOTIFICATION_PREFERENCES, ...(saved && typeof saved === 'object' ? saved : {}) };
  } catch {
    return { ...DEFAULT_NOTIFICATION_PREFERENCES };
  }
}

export function writeNotificationPreferences(preferences: NotificationPreferences) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences)); }
  catch { /* Preferences are a convenience; ignore private-mode failures. */ }
}

export function browserNotificationsSupported() {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function browserNotificationPermission(): NotificationPermission {
  return browserNotificationsSupported() ? Notification.permission : 'denied';
}

export async function requestBrowserNotificationPermission(): Promise<NotificationPermission> {
  if (!browserNotificationsSupported()) return 'denied';
  try { return await Notification.requestPermission(); }
  catch { return Notification.permission; }
}

/* Browser notifications are only delivered when the user opted in, permission
   is granted, and (by default) the tab is hidden so we never double-notify a
   visible UI. */
export function showBrowserNotification(title: string, body?: string, preferences = readNotificationPreferences()) {
  if (!preferences.browser || !browserNotificationsSupported()) return;
  if (Notification.permission !== 'granted') return;
  if (preferences.onlyWhenHidden && document.visibilityState !== 'hidden') return;
  try {
    const notification = new Notification(title, { body, tag: `workbench-${title}`, silent: false });
    notification.onclick = () => { window.focus(); notification.close(); };
  } catch { /* Some browsers require a service worker; the in-app centre still works. */ }
}

/** Kind-aware gate for the SSE stream. */
export function notifyForEvent(item: Pick<NotificationItem, 'kind' | 'title' | 'body'>, preferences = readNotificationPreferences()) {
  const kind = item.kind || '';
  const attention = /attention|permission|question|waiting/.test(kind);
  const completed = /complete|finished|done/.test(kind);
  if (attention && !preferences.attention) return;
  if (completed && !preferences.completed) return;
  showBrowserNotification(item.title, item.body || undefined, preferences);
}
