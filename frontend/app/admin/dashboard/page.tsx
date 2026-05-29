"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { readSession } from "@/lib/auth-session";
import type { AuthResponse } from "@/lib/types";

type RegistrationRow = {
  id: number;
  ime?: string | null;
  email?: string | null;
  datum_registracije?: string | null;
};

type AdminUsersResponse = {
  totalUsers: number;
  registrations: RegistrationRow[];
  updatedAt: string;
};

type DashboardStatus = "checking" | "missing-session" | "unauthorized" | "ready";

const REFRESH_INTERVAL_MS = 7000;

function formatRegistrationDate(value: string | null | undefined): string {
  if (!value) {
    return "Nepoznat datum";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Nepoznat datum";
  }

  return new Intl.DateTimeFormat("sr-Latn-BA", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function getDisplayName(row: RegistrationRow): string {
  return row.ime?.trim() || "Bez imena";
}

function getDisplayIdentifier(row: RegistrationRow): string {
  return row.email?.trim() || `ID #${row.id}`;
}

function AdminStateMessage({
  title,
  description,
  action
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden px-4 py-8">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(80%_70%_at_50%_0%,rgba(34,211,238,0.18),transparent_70%),linear-gradient(160deg,#010716_0%,#031026_52%,#010913_100%)]" />
      <section className="relative z-10 w-full max-w-md rounded-3xl border border-blue-300/20 bg-[#03112d]/90 p-5 text-center shadow-[0_30px_90px_rgba(0,0,0,0.55)] backdrop-blur">
        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-cyan-200/80">Admin Dashboard</p>
        <h1 className="mt-3 text-2xl font-bold text-white">{title}</h1>
        <p className="mt-2 text-sm leading-relaxed text-slate-300">{description}</p>
        {action && <div className="mt-5">{action}</div>}
      </section>
    </main>
  );
}

export default function AdminDashboardPage() {
  const router = useRouter();
  const [session, setSession] = useState<AuthResponse | null>(null);
  const [status, setStatus] = useState<DashboardStatus>("checking");
  const [totalUsers, setTotalUsers] = useState<number>(0);
  const [registrations, setRegistrations] = useState<RegistrationRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);

  useEffect(() => {
    const currentSession = readSession();
    setSession(currentSession);

    if (!currentSession) {
      setStatus("missing-session");
      router.replace("/login");
      return;
    }

    setStatus("ready");
  }, [router]);

  const loadDashboardData = useCallback(async () => {
    if (!session?.access_token) {
      setIsLoading(false);
      return;
    }

    setError(null);

    const response = await fetch("/api/admin/users", {
      headers: {
        Authorization: `Bearer ${session.access_token}`
      },
      cache: "no-store"
    });

    if (response.status === 403) {
      setStatus("unauthorized");
      setIsLoading(false);
      return;
    }

    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? "Neuspesno ucitavanje admin podataka.");
    }

    const payload = (await response.json()) as AdminUsersResponse;
    setTotalUsers(payload.totalUsers);
    setRegistrations(payload.registrations);
    setLastUpdatedAt(new Date(payload.updatedAt));
    setIsLoading(false);
  }, [session]);

  useEffect(() => {
    if (status !== "ready") {
      return;
    }

    let isActive = true;

    const refresh = async () => {
      try {
        await loadDashboardData();
      } catch (caughtError) {
        if (!isActive) {
          return;
        }
        const message = caughtError instanceof Error ? caughtError.message : "Neuspesno ucitavanje admin podataka.";
        setError(message);
        setIsLoading(false);
      }
    };

    void refresh();

    const intervalId = window.setInterval(() => {
      void refresh();
    }, REFRESH_INTERVAL_MS);

    return () => {
      isActive = false;
      window.clearInterval(intervalId);
    };
  }, [loadDashboardData, status]);

  if (status === "checking" || status === "missing-session") {
    return (
      <AdminStateMessage
        title="Provera pristupa"
        description="Citam aktivnu sesiju i proveravam da li nalog ima admin pristup."
      />
    );
  }

  if (status === "unauthorized") {
    return (
      <AdminStateMessage
        title="Pristup odbijen"
        description="Ova stranica je dostupna samo admin nalogu."
        action={
          <Link
            href="/dashboard"
            className="inline-flex min-h-11 items-center justify-center rounded-2xl border border-cyan-300/35 bg-cyan-500/15 px-5 text-sm font-semibold text-cyan-100 transition hover:bg-cyan-500/25"
          >
            Nazad na dashboard
          </Link>
        }
      />
    );
  }

  return (
    <main className="relative min-h-screen overflow-hidden px-4 py-5 sm:px-6 lg:px-8">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(85%_65%_at_50%_0%,rgba(34,211,238,0.18),transparent_72%),radial-gradient(70%_50%_at_100%_30%,rgba(59,130,246,0.14),transparent_74%),linear-gradient(160deg,#010716_0%,#031026_54%,#010913_100%)]" />

      <section className="relative z-10 mx-auto flex min-h-[calc(100vh-2.5rem)] w-full max-w-6xl flex-col gap-4">
        <header className="rounded-3xl border border-blue-300/15 bg-[#03112d]/85 p-4 shadow-[0_30px_90px_rgba(0,0,0,0.42)] backdrop-blur sm:p-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.24em] text-cyan-200/80">Admin Dashboard</p>
              <h1 className="mt-2 text-3xl font-bold leading-tight text-white sm:text-4xl">Registracije uzivo</h1>
              <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-300">
                Pregled ukupnog broja korisnika i poslednjih registracija iz postojece users tabele.
              </p>
              {session?.user.email && <p className="mt-2 text-xs text-slate-400">Admin: {session.user.email}</p>}
            </div>
            <div className="rounded-2xl border border-emerald-300/20 bg-emerald-500/10 px-3 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-emerald-100">
              Refresh: {REFRESH_INTERVAL_MS / 1000}s
            </div>
          </div>
        </header>

        {error && (
          <p className="rounded-2xl border border-red-300/30 bg-red-500/15 px-4 py-3 text-sm text-red-100">
            {error}
          </p>
        )}

        <div className="grid gap-4 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.4fr)]">
          <section className="rounded-3xl border border-cyan-300/20 bg-[#03112d]/85 p-5 shadow-[inset_0_1px_0_rgba(180,220,255,0.08),0_20px_70px_rgba(0,0,0,0.38)] backdrop-blur">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-slate-300">Ukupan broj korisnika</p>
                <p className="mt-1 text-xs uppercase tracking-[0.18em] text-cyan-200/70">Live count</p>
              </div>
              <span className="inline-flex h-3 w-3 rounded-full bg-emerald-400 shadow-[0_0_18px_rgba(52,211,153,0.95)]" />
            </div>

            <div className="mt-8 flex min-h-[190px] items-center justify-center rounded-3xl border border-blue-300/15 bg-[#061737]/75 shadow-[inset_0_0_55px_rgba(34,211,238,0.08)]">
              {isLoading ? (
                <div className="h-20 w-48 rounded-3xl skeleton-shimmer" />
              ) : (
                <p className="font-display text-7xl font-bold leading-none text-white drop-shadow-[0_0_24px_rgba(34,211,238,0.45)] sm:text-8xl">
                  {totalUsers.toLocaleString("sr-Latn-BA")}
                </p>
              )}
            </div>

            <p className="mt-4 text-sm text-slate-300">
              {lastUpdatedAt ? `Azurirano: ${formatRegistrationDate(lastUpdatedAt.toISOString())}` : "Cekam prvo ucitavanje..."}
            </p>
          </section>

          <section className="overflow-hidden rounded-3xl border border-blue-300/15 bg-[#03112d]/85 shadow-[inset_0_1px_0_rgba(180,220,255,0.08),0_20px_70px_rgba(0,0,0,0.38)] backdrop-blur">
            <div className="border-b border-blue-300/15 px-4 py-4 sm:px-5">
              <p className="text-sm font-semibold text-slate-100">Lista poslednjih 10 registracija</p>
              <p className="mt-1 text-xs text-slate-400">Sortirano od najnovijeg korisnika.</p>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full min-w-[620px] border-collapse text-left">
                <thead>
                  <tr className="border-b border-blue-300/10 bg-[#061737]/70 text-xs uppercase tracking-[0.18em] text-cyan-200/75">
                    <th className="px-4 py-3 font-semibold sm:px-5">Ime</th>
                    <th className="px-4 py-3 font-semibold sm:px-5">Email/ID</th>
                    <th className="px-4 py-3 font-semibold sm:px-5">Datum registracije</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-blue-300/10">
                  {isLoading &&
                    Array.from({ length: 5 }).map((_, index) => (
                      <tr key={`loading-${index}`}>
                        <td className="px-4 py-4 sm:px-5">
                          <div className="h-5 w-36 rounded-lg skeleton-shimmer" />
                        </td>
                        <td className="px-4 py-4 sm:px-5">
                          <div className="h-5 w-48 rounded-lg skeleton-shimmer" />
                        </td>
                        <td className="px-4 py-4 sm:px-5">
                          <div className="h-5 w-32 rounded-lg skeleton-shimmer" />
                        </td>
                      </tr>
                    ))}

                  {!isLoading &&
                    registrations.map((registration) => (
                      <tr key={registration.id} className="text-sm text-slate-200">
                        <td className="px-4 py-4 font-semibold text-white sm:px-5">{getDisplayName(registration)}</td>
                        <td className="px-4 py-4 text-slate-300 sm:px-5">{getDisplayIdentifier(registration)}</td>
                        <td className="px-4 py-4 text-slate-300 sm:px-5">
                          {formatRegistrationDate(registration.datum_registracije)}
                        </td>
                      </tr>
                    ))}

                  {!isLoading && registrations.length === 0 && (
                    <tr>
                      <td className="px-4 py-8 text-center text-sm text-slate-300 sm:px-5" colSpan={3}>
                        Jos nema registracija za prikaz.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </section>
    </main>
  );
}
