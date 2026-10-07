import { useEffect } from 'react';
import type { TabView } from '@/lib/tabs';

/* Global keyboard control for the tab rail. The
   arrow/Tab pair cycles, ⌘1..9 jumps, ⌘W closes and ⌘T starts a new chat.
   Anything typed into a field, or any open popup/menu, keeps the key for
   itself. */
export function useTabsShortcuts({
  tabs,
  activeId,
  onActivate,
  onClose,
  onNew,
}: {
  tabs: TabView[];
  activeId?: string;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      const typing = Boolean(target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable));
      const overlay = overlayOpen();
      const mod = event.metaKey || event.ctrlKey;

      const cycle = (step: number) => {
        if (tabs.length < 2) return false;
        const index = tabs.findIndex((tab) => tab.id === activeId);
        const next = tabs[(index + step + tabs.length) % tabs.length];
        if (!next || next.id === activeId) return false;
        event.preventDefault();
        onActivate(next.id);
        return true;
      };

      if (mod && event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        cycle(event.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      if (event.ctrlKey && event.key === 'Tab') {
        cycle(event.shiftKey ? -1 : 1);
        return;
      }
      if (mod && !event.altKey && /^[1-9]$/.test(event.key) && !typing) {
        const tab = tabs[Number(event.key) - 1];
        if (tab) {
          event.preventDefault();
          onActivate(tab.id);
        }
        return;
      }
      if (mod && !event.shiftKey && event.key.toLowerCase() === 'w' && !typing && !overlay) {
        if (!activeId) return;
        event.preventDefault();
        onClose(activeId);
        return;
      }
      if (mod && event.key.toLowerCase() === 't' && !typing && !overlay) {
        event.preventDefault();
        onNew();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [tabs, activeId, onActivate, onClose, onNew]);
}

function overlayOpen() {
  const nodes = document.querySelectorAll<HTMLElement>(
    '[data-slot="dialog-content"],[role="dialog"],[role="menu"],[data-slot="popover-content"],[role="listbox"]',
  );
  for (const node of nodes) {
    if (node.hasAttribute('hidden') || node.getAttribute('aria-hidden') === 'true') continue;
    if (node.getClientRects().length > 0) return true;
  }
  return false;
}
