import { useQuery } from '@tanstack/react-query';
import { getOverview, getSystem } from './api';
import { archivedConversations, bootstrap, health, notifications, offerings, sharedTabs, usagePacing, usageReport } from './workbench';

// SSE supplies normal updates. Polls are visible-tab repair, with expensive
// telemetry enabled only while its panel is open.
export function useConsoleQueries({ settingsOpen, archivedOpen }: {
  settingsOpen: boolean; archivedOpen: boolean;
}) {
  const overviewQuery = useQuery({ queryKey: ['overview'], queryFn: getOverview,
    refetchInterval: 60_000, refetchIntervalInBackground: false, staleTime: 2000, retry: 1 });
  // Always on: the sidebar shows CPU/RAM in its header, so the snapshot must
  // exist before the panel is ever opened (it used to only fetch when open).
  const systemQuery = useQuery({ queryKey: ['system'], queryFn: getSystem,
    refetchInterval: 30_000, refetchIntervalInBackground: false, staleTime: 10_000, retry: 1 });
  const bootQuery = useQuery({ queryKey: ['bootstrap'], queryFn: bootstrap, staleTime: 30_000 });
  const sharedTabsQuery = useQuery({ queryKey: ['shared-tabs'], queryFn: sharedTabs,
    refetchInterval: 3000, refetchIntervalInBackground: false, staleTime: 1000, retry: 1 });
  const modelsQuery = useQuery({ queryKey: ['model-offerings'], queryFn: offerings, staleTime: 60_000, retry: 1 });
  const pacingQuery = useQuery({ queryKey: ['usage-pacing'], queryFn: usagePacing, staleTime: 30_000, retry: 1 });
  const weeklyUsageQuery = useQuery({ queryKey: ['usage', '7', ''], queryFn: () => usageReport(7),
    staleTime: 30_000, enabled: pacingQuery.isFetched && !pacingQuery.data, retry: 1 });
  const notificationsQuery = useQuery({ queryKey: ['notifications'], queryFn: notifications,
    staleTime: 15_000, refetchInterval: 120_000, refetchIntervalInBackground: false, retry: 1 });
  const archivedQuery = useQuery({ queryKey: ['archived'], queryFn: archivedConversations,
    enabled: archivedOpen, staleTime: 15_000, retry: 1 });
  const healthQuery = useQuery({ queryKey: ['health'], queryFn: health,
    enabled: settingsOpen, refetchInterval: 30_000, refetchIntervalInBackground: false, staleTime: 5000, retry: 1 });
  return { overviewQuery, systemQuery, bootQuery, sharedTabsQuery, modelsQuery, pacingQuery, weeklyUsageQuery,
    notificationsQuery, archivedQuery, healthQuery };
}
