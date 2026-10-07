import { Component, type ErrorInfo, type ReactNode } from 'react';
import { IconAlertTriangleFilled } from '@tabler/icons-react';

/* Last line of defence: a render error in one pane must not blank the whole
   app. Shows a recoverable message (and the error text, so a bug report can
   carry it) instead of a white screen. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Workbench crashed', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="grid h-dvh w-full place-items-center bg-background px-6 text-foreground">
        <div className="max-w-md text-center">
          <IconAlertTriangleFilled size={22} className="mx-auto text-destructive" />
          <h1 className="mt-3 text-[15px] font-semibold">Something went wrong</h1>
          <p className="mt-2 text-[13px]/5 text-muted-foreground">
            The interface hit an error. Your conversations and runs are safe on the server.
          </p>
          <pre className="wb-scrollbar mt-3 max-h-32 overflow-auto rounded-xl bg-well px-3 py-2 text-left text-[11px]/4 text-muted-foreground shadow-[inset_0_0_0_1px_var(--well-outline)]">
            {this.state.error.message}
          </pre>
          <div className="mt-4 flex items-center justify-center gap-2">
            <button
              type="button"
              onClick={() => this.setState({ error: null })}
              className="cursor-pointer rounded-full px-3.5 py-2 text-[13px] font-medium text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground"
            >
              Dismiss
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="cursor-pointer rounded-full bg-primary px-3.5 py-2 text-[13px] font-medium text-primary-foreground transition-[background-color,scale] duration-150 hover:bg-(--primary-hover) active:scale-[0.96]"
            >
              Reload
            </button>
          </div>
        </div>
      </div>
    );
  }
}
