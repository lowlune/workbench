import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from '@/App';
import { ErrorBoundary } from '@/components/error-boundary';
import { installScrollAffordance } from '@/lib/scroll-affordance';
import '@/styles/whirl/globals.css';

installScrollAffordance();

try {
  const savedTheme = localStorage.getItem('workbench-theme');
  const dark = savedTheme === 'dark' || (savedTheme !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
} catch { /* The app falls back to its light theme when browser storage is disabled. */ }

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
      staleTime: 5_000,
    },
  },
});

if ('serviceWorker' in navigator) {
  void navigator.serviceWorker.getRegistrations().then((registrations) => {
    for (const registration of registrations) void registration.unregister();
  });
  void caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith('workbench-shell-')).map((key) => caches.delete(key))));
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </QueryClientProvider>
  </React.StrictMode>,
);
