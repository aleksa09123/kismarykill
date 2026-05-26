"use client";

import type { ErrorInfo, ReactNode } from "react";
import { Component } from "react";

type AppErrorBoundaryProps = {
  children: ReactNode;
};

type AppErrorBoundaryState = {
  hasError: boolean;
};

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = {
    hasError: false
  };

  static getDerivedStateFromError(): AppErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error("Client error boundary caught an error:", error, errorInfo);
  }

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <main className="mx-auto flex min-h-screen w-full max-w-md items-center justify-center bg-slate-950 px-4 text-slate-100">
        <section className="w-full rounded-3xl border border-cyan-300/25 bg-cyan-500/10 p-5 text-center shadow-2xl shadow-black/30 backdrop-blur">
          <h1 className="text-xl font-bold text-white">We kept the app running</h1>
          <p className="mt-2 text-sm text-cyan-100">
            This screen hit a recoverable client error. Your session was preserved.
          </p>
          <button
            type="button"
            onClick={() => this.setState({ hasError: false })}
            className="mt-4 inline-flex min-h-10 items-center justify-center rounded-xl border border-cyan-300/55 bg-cyan-500/25 px-4 text-sm font-semibold text-cyan-50 transition hover:bg-cyan-500/35"
          >
            Continue
          </button>
        </section>
      </main>
    );
  }
}
