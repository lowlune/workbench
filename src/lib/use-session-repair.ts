import { useEffect, useState, type RefObject } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getSessionUpdates } from './api';
import type { Session } from './types';

export function useSessionRepair(sessionId: string | undefined, loaded: boolean, streamConnected: RefObject<boolean>, mergeSession: (previous: Session | undefined, incoming: Session) => Session) {
  const queryClient = useQueryClient();
  const [connectionError, setConnectionError] = useState(false);
  useEffect(() => {
    if (!sessionId || !loaded) { setConnectionError(false); return; }
    let disposed = false;
    let inFlight = false;
    const poll = async () => {
      if (disposed) return;
      if (streamConnected.current) { setConnectionError(false); return; }
      if (inFlight || document.visibilityState === 'hidden') return;
      const current = queryClient.getQueryData<{ session: Session }>(['session', sessionId])?.session;
      if (!current) return;
      inFlight = true;
      try {
        const update = await getSessionUpdates(sessionId, String(current.updated || 0));
        if (disposed) return;
        setConnectionError(false);
        if (update.changed && update.session) queryClient.setQueryData<{ session: Session }>(['session', sessionId], cached => ({ session: mergeSession(cached?.session, update.session!) }));
        else if (update.resumeStatus && update.resumeStatus !== current.resumeStatus) queryClient.setQueryData<{ session: Session }>(['session', sessionId], cached => cached ? ({ session: { ...cached.session, resumeStatus: update.resumeStatus } }) : cached);
      } catch { if (!disposed) setConnectionError(true); }
      finally { inFlight = false; }
    };
    const timer = window.setInterval(() => void poll(), 30_000);
    document.addEventListener('visibilitychange', poll);
    return () => { disposed = true; window.clearInterval(timer); document.removeEventListener('visibilitychange', poll); };
  }, [sessionId, loaded, queryClient, streamConnected, mergeSession]);
  return connectionError;
}
