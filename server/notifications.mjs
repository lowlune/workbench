import { uid } from './store.mjs';

/* In-app notifications (PLAN §33).

   Every attention-worthy transition creates a durable record and emits a
   `notification.created` event. Dedup is per (run_id, kind) so a reconnecting
   worker or a retried hook cannot spam the centre. A record is always created
   even if the user is watching the chat; `attention` just tells the shell to
   surface it non-intrusively. SMTP is intentionally out of scope here. */

export function createNotification(store, {
  kind, conversationId = null, runId = null, title, body = null, severity = 'info', attention = false,
} = {}) {
  if (!kind || !title) return null;
  if (runId) {
    const existing = store.db.prepare('SELECT id FROM notifications WHERE run_id=? AND kind=?').get(runId, kind);
    if (existing) return null;
  }
  const id = uid('ntf_');
  try {
    store.db.prepare(`INSERT INTO notifications(id,kind,severity,conversation_id,run_id,title,body,read,attention,created)
      VALUES (?,?,?,?,?,?,?,0,?,?)`).run(id, kind, severity, conversationId, runId, String(title).slice(0, 200), body ? String(body).slice(0, 2000) : null, attention ? 1 : 0, Date.now());
  } catch (error) {
    if (String(error.message || '').includes('UNIQUE')) return null;
    throw error;
  }
  store.event('notification.created', conversationId, { notificationId: id, kind, conversationId, runId, title, severity }, { kind: 'notification.created', runId });
  return id;
}

export function serializeNotification(row) {
  return {
    id: row.id, kind: row.kind, severity: row.severity, conversationId: row.conversation_id,
    runId: row.run_id, title: row.title, body: row.body, read: !!row.read,
    attention: !!row.attention, created: row.created, delivered: row.delivered ?? null,
    delivery: row.delivery ?? null,
  };
}

export function listNotifications(store, { unreadOnly = false, limit = 100 } = {}) {
  const capped = Math.max(1, Math.min(500, Number(limit) || 100));
  const rows = unreadOnly
    ? store.db.prepare('SELECT * FROM notifications WHERE read=0 ORDER BY created DESC LIMIT ?').all(capped)
    : store.db.prepare('SELECT * FROM notifications ORDER BY created DESC LIMIT ?').all(capped);
  const unread = Number(store.db.prepare('SELECT count(*) AS n FROM notifications WHERE read=0').get().n);
  return { notifications: rows.map(serializeNotification), unread };
}

export function markNotificationRead(store, id) {
  const result = store.db.prepare('UPDATE notifications SET read=1, delivered=? WHERE id=?').run(Date.now(), id);
  if (!result.changes) {
    const error = new Error('Notification not found.');
    error.status = 404;
    throw error;
  }
  const row = store.db.prepare('SELECT * FROM notifications WHERE id=?').get(id);
  store.event('notifications.changed', row.conversation_id, { notificationId: id }, { kind: 'notifications.changed' });
  return serializeNotification(row);
}

export function markAllNotificationsRead(store, conversationId = null) {
  const result = conversationId
    ? store.db.prepare('UPDATE notifications SET read=1, delivered=? WHERE read=0 AND conversation_id=?').run(Date.now(), conversationId)
    : store.db.prepare('UPDATE notifications SET read=1, delivered=? WHERE read=0').run(Date.now());
  store.event('notifications.changed', conversationId, { marked: Number(result.changes) }, { kind: 'notifications.changed' });
  return { marked: Number(result.changes) };
}
