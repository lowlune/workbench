import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { IconBell, IconBellOff, IconCheck, IconLoader2 } from '@tabler/icons-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { markAllNotificationsRead, markNotificationRead, notifications } from '@/lib/workbench';
import {
  browserNotificationPermission,
  browserNotificationsSupported,
  readNotificationPreferences,
  requestBrowserNotificationPermission,
  writeNotificationPreferences,
  type NotificationPreferences,
} from '@/lib/notifications';
import type { NotificationItem } from '@/lib/types';
import { cn, timeAgo } from '@/lib/utils';

/* The attention centre (§33): an in-app list fed by GET /notifications and the
   notification.created SSE event, plus opt-in browser notifications. */
export function NotificationsCenter({
  open,
  onOpenChange,
  onOpenConversation,
  onToast,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenConversation: (conversationId: string) => void;
  onToast: (message: string, isError?: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [preferences, setPreferences] = useState<NotificationPreferences>(() => readNotificationPreferences());
  const [permission, setPermission] = useState<NotificationPermission>(() => browserNotificationPermission());
  const listQuery = useQuery({ queryKey: ['notifications'], queryFn: notifications, staleTime: 15_000, enabled: open });

  const readOne = useMutation({
    mutationFn: (id: string) => markNotificationRead(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['notifications'] }),
    onError: (error: Error) => onToast(error.message, true),
  });
  const readAll = useMutation({
    mutationFn: () => markAllNotificationsRead(),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['notifications'] }),
    onError: (error: Error) => onToast(error.message, true),
  });

  useEffect(() => {
    writeNotificationPreferences(preferences);
  }, [preferences]);

  const items = listQuery.data?.notifications || [];
  const unread = listQuery.data?.unread ?? items.filter((item) => !item.read).length;

  async function toggleBrowser(next: boolean) {
    if (!next) {
      setPreferences((current) => ({ ...current, browser: false }));
      return;
    }
    if (!browserNotificationsSupported()) {
      onToast('This browser does not support notifications.', true);
      return;
    }
    const result = permission === 'granted' ? permission : await requestBrowserNotificationPermission();
    setPermission(result);
    if (result !== 'granted') {
      onToast('Notification permission was not granted.', true);
      return;
    }
    setPreferences((current) => ({ ...current, browser: true }));
  }

  function openItem(item: NotificationItem) {
    if (!item.read) readOne.mutate(item.id);
    if (item.conversationId) {
      onOpenChange(false);
      onOpenConversation(item.conversationId);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-[8vh] flex max-h-[80vh] w-[calc(100vw-2rem)] max-w-md flex-col gap-0 rounded-xl p-0">
        <DialogTitle className="sr-only">Notifications</DialogTitle>
        <DialogDescription className="sr-only">Recent attention events and notification preferences.</DialogDescription>

        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <IconBell size={16} className="shrink-0 text-muted-foreground" />
          <span className="text-[13px] font-semibold">Notifications</span>
          {unread > 0 && <span className="rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground tabular-nums">{unread}</span>}
          <button
            type="button"
            disabled={unread === 0 || readAll.isPending}
            onClick={() => readAll.mutate()}
            className="ml-auto inline-flex cursor-pointer items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium text-muted-foreground transition-[color,background-color,scale] duration-150 hover:bg-accent hover:text-foreground active:scale-[0.96] disabled:pointer-events-none disabled:opacity-40"
          >
            {readAll.isPending ? <IconLoader2 size={12} className="animate-spin" /> : <IconCheck size={12} />}
            Read all
          </button>
        </div>

        <div className="wb-scroll min-h-0 flex-1 overflow-y-auto p-1.5">
          {listQuery.isPending && (
            <div className="grid place-items-center py-10 text-muted-foreground"><IconLoader2 size={18} className="animate-spin" /></div>
          )}
          {listQuery.isError && <p role="alert" className="px-3 py-6 text-center text-[13px] text-destructive">{listQuery.error.message}</p>}
          {listQuery.isSuccess && items.length === 0 && (
            <p className="px-3 py-8 text-center text-[13px] text-muted-foreground">Nothing needs your attention.</p>
          )}
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => openItem(item)}
              className={cn(
                'flex w-full min-w-0 cursor-pointer items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors duration-75 hover:bg-accent active:bg-(--accent-pressed)',
                item.conversationId ? '' : 'cursor-default',
              )}
            >
              <span aria-hidden="true" className={cn(
                'mt-1.5 size-1.5 shrink-0 rounded-full',
                item.read ? 'bg-muted-foreground/30' : item.severity === 'error' ? 'bg-destructive' : 'bg-foreground',
              )} />
              <span className="min-w-0 flex-1">
                <span className={cn('block truncate text-[13px]', !item.read && 'font-medium')}>{item.title}</span>
                {item.body && <span className="mt-0.5 block line-clamp-2 text-[11px]/4 text-muted-foreground">{item.body}</span>}
                <span className="mt-0.5 block text-[10.5px] text-muted-foreground/70">{item.created ? timeAgo(item.created) : ''}</span>
              </span>
            </button>
          ))}
        </div>

        <div className="border-t border-border p-3">
          <div className="flex items-center gap-2 px-1">
            {preferences.browser ? <IconBell size={14} className="text-muted-foreground" /> : <IconBellOff size={14} className="text-muted-foreground" />}
            <span className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">Browser notifications</span>
          </div>
          <Toggle
            label="Send browser notifications"
            description={browserNotificationsSupported()
              ? permission === 'denied' ? 'Blocked in browser settings.' : 'Only while this tab is hidden.'
              : 'Not supported in this browser.'}
            checked={preferences.browser}
            disabled={!browserNotificationsSupported() || permission === 'denied'}
            onChange={(value) => void toggleBrowser(value)}
          />
          <Toggle
            label="Only when the tab is hidden"
            checked={preferences.onlyWhenHidden}
            disabled={!preferences.browser}
            onChange={(value) => setPreferences((current) => ({ ...current, onlyWhenHidden: value }))}
          />
          <Toggle
            label="Waiting for input or permission"
            checked={preferences.attention}
            onChange={(value) => setPreferences((current) => ({ ...current, attention: value }))}
          />
          <Toggle
            label="Run completed"
            checked={preferences.completed}
            onChange={(value) => setPreferences((current) => ({ ...current, completed: value }))}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Toggle({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'mt-1 flex w-full cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 text-left transition-[color,background-color,scale] duration-100 active:scale-[0.98] hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50',
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="block text-[12.5px]">{label}</span>
        {description && <span className="block text-[10.5px] text-muted-foreground">{description}</span>}
      </span>
      <span className={cn('relative h-4 w-7 shrink-0 rounded-full transition-colors duration-150', checked ? 'bg-primary' : 'bg-muted')}>
        <span className={cn('absolute top-0.5 left-0.5 size-3 rounded-full bg-background transition-transform duration-150 ease-out', checked ? 'translate-x-3' : 'translate-x-0')} />
      </span>
    </button>
  );
}
