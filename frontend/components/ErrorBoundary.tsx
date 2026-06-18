import React from 'react';

interface ErrorBoundaryState {
  error: Error | null;
}

export default class ErrorBoundary extends React.Component<React.PropsWithChildren, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('Aura Gold render failure', error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div className="min-h-screen bg-slate-50 p-6 text-slate-900">
        <div className="mx-auto mt-16 max-w-2xl rounded-3xl border border-red-200 bg-white p-8 shadow-floating">
          <p className="text-xs font-black uppercase tracking-[0.24em] text-red-600">Frontend Error</p>
          <h1 className="mt-3 text-3xl font-black tracking-tight">Aura Gold could not render this screen.</h1>
          <p className="mt-3 text-sm font-semibold text-slate-600">
            The app is still loaded, but a React render error stopped the current view. Check the browser console for the full stack trace.
          </p>
          <pre className="mt-6 max-h-72 overflow-auto rounded-2xl border border-slate-200 bg-slate-950 p-4 text-xs text-red-100">
            {this.state.error.stack || this.state.error.message}
          </pre>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-6 rounded-xl bg-amber-500 px-4 py-2 text-sm font-bold text-white transition hover:bg-amber-600"
          >
            Reload app
          </button>
        </div>
      </div>
    );
  }
}
