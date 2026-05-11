"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { fetchLeaderboard } from "@/lib/api";
import { readSession } from "@/lib/auth-session";
import type { LeaderboardEntry } from "@/lib/types";

export default function LeaderboardPage() {
  const router = useRouter();
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const session = readSession();
    if (!session) {
      router.replace("/login");
      return;
    }

    const loadLeaderboard = async () => {
      try {
        const response = await fetchLeaderboard(session.access_token);
        setEntries(response.users);
      } catch (loadError) {
        const message = loadError instanceof Error ? loadError.message : "Could not load leaderboard.";
        setError(message);
      } finally {
        setIsLoading(false);
      }
    };

    void loadLeaderboard();
  }, [router]);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md items-start px-3 py-4 md:justify-center md:py-8">
      <section
        className="w-full space-y-4 rounded-3xl border border-slate-700/50 bg-slate-950/65 p-4 shadow-2xl shadow-black/30 backdrop-blur-xl"
        style={{
          paddingTop: "max(env(safe-area-inset-top), 0.25rem)",
          paddingBottom: "max(env(safe-area-inset-bottom), 0.75rem)"
        }}
      >
        <header className="flex items-center justify-between">
          <p className="font-display text-3xl text-white">Leaderboard</p>
          <Link
            href="/dashboard"
            className="min-h-11 min-w-11 rounded-xl border border-cyan-400/60 px-3 py-2 text-sm font-semibold text-cyan-100 transition hover:bg-cyan-900/40"
          >
            Back to Menu
          </Link>
        </header>

        {isLoading && <p className="rounded-xl bg-slate-800/70 px-3 py-2 text-sm text-slate-200">Loading ranks...</p>}
        {error && <p className="rounded-xl bg-red-500/20 px-3 py-2 text-sm text-red-200">{error}</p>}

        <div className="space-y-3">
          {entries.map((entry) => (
            <article
              key={entry.user_id}
              className="flex items-center gap-3 rounded-2xl border border-slate-700/60 bg-slate-900/60 px-3 py-3 backdrop-blur transition hover:border-cyan-300/60"
            >
              <p className="w-7 text-center text-lg font-bold text-cyan-200">#{entry.rank}</p>
              <div className="relative h-14 w-14 overflow-hidden rounded-full border border-slate-600">
                {entry.profile_image_url ? (
                  <Image
                    src={entry.profile_image_url}
                    alt={entry.name}
                    fill
                    sizes="56px"
                    className="object-cover"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center bg-slate-800 text-slate-300">
                    {entry.name.slice(0, 1).toUpperCase()}
                  </div>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold text-white">{entry.name}</p>
                <p className="text-xs text-slate-300">
                  Score {entry.score} | K {entry.kisses} M {entry.marries} X {entry.kills}
                </p>
              </div>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
