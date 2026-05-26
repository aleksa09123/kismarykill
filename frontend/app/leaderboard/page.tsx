"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { fetchCurrentUser, fetchLeaderboard } from "@/lib/api";
import { readSession } from "@/lib/auth-session";
import { ENABLE_API_BOTS } from "@/lib/feature-flags";
import { ACTIVE_GAME_MODE_UPDATED_EVENT, readActiveGameMode, type GameMode } from "@/lib/game-mode";
import { VIP_CELEBRITIES } from "@/lib/vip-data";
import { getVIPStatForProfile, VIP_STATS_UPDATED_EVENT } from "@/lib/vip-stats";
import type { AuthUser, LeaderboardEntry } from "@/lib/types";

function leaderboardModeLabel(mode: GameMode): string {
  if (mode === "live") {
    return "Live";
  }
  if (mode === "classic") {
    return "Classic";
  }
  return "VIP";
}

function locationLeaderboardTitle(user: AuthUser | null, mode: GameMode): string {
  if (mode === "vip") {
    return "Top VIP Profiles - Global";
  }
  const modeLabel = leaderboardModeLabel(mode);
  const countryCode = (user?.country_code ?? "").trim().toUpperCase();
  const countryName = (user?.country_name ?? "").trim();
  if (!countryCode) {
    return `National Ranking - ${modeLabel}`;
  }
  const countryLabel = countryName ? `${countryName} (${countryCode})` : countryCode;
  return `National Ranking - ${modeLabel} - ${countryLabel}`;
}

function buildVipLeaderboardEntries(): LeaderboardEntry[] {
  return VIP_CELEBRITIES.map((celebrity, index) => {
    const stats = getVIPStatForProfile(celebrity.id);
    const roundsPlayed = stats.kisses + stats.marries + stats.kills;
    const score = stats.kisses * 2 + stats.marries * 3 + stats.kills;
    const winRate = roundsPlayed > 0 ? Number((((stats.kisses + stats.marries) / roundsPlayed) * 100).toFixed(1)) : 0;

    return {
      rank: index + 1,
      user_id: index + 1,
      name: celebrity.name,
      profile_image_url: celebrity.imageUrl,
      score,
      kisses: stats.kisses,
      marries: stats.marries,
      kills: stats.kills,
      rounds_played: roundsPlayed,
      win_rate: winRate
    };
  })
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      if (right.rounds_played !== left.rounds_played) {
        return right.rounds_played - left.rounds_played;
      }
      return left.name.localeCompare(right.name);
    })
    .map((entry, index) => ({ ...entry, rank: index + 1 }));
}

export default function LeaderboardPage() {
  const router = useRouter();
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [leaderboardUser, setLeaderboardUser] = useState<AuthUser | null>(null);
  const [activeMode, setActiveMode] = useState<GameMode>("classic");
  const [hasMounted, setHasMounted] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setHasMounted(true);
  }, []);

  useEffect(() => {
    if (!hasMounted) {
      return;
    }

    const syncModeFromStorage = () => {
      setActiveMode(readActiveGameMode());
    };

    syncModeFromStorage();
    window.addEventListener("focus", syncModeFromStorage);
    window.addEventListener("storage", syncModeFromStorage);
    window.addEventListener(ACTIVE_GAME_MODE_UPDATED_EVENT, syncModeFromStorage as EventListener);
    return () => {
      window.removeEventListener("focus", syncModeFromStorage);
      window.removeEventListener("storage", syncModeFromStorage);
      window.removeEventListener(ACTIVE_GAME_MODE_UPDATED_EVENT, syncModeFromStorage as EventListener);
    };
  }, [hasMounted]);

  useEffect(() => {
    if (!hasMounted) {
      return;
    }

    const session = readSession();
    if (!session) {
      router.replace("/login");
      return;
    }

    const mode = readActiveGameMode();
    if (mode !== activeMode) {
      setActiveMode(mode);
    }

    let cancelled = false;
    setIsLoading(true);
    setError(null);

    const loadLeaderboard = async () => {
      try {
        if (mode === "vip") {
          if (cancelled) {
            return;
          }
          setEntries(buildVipLeaderboardEntries());
          setLeaderboardUser(null);
          return;
        }

        const currentUser = await fetchCurrentUser(session.access_token);
        const leaderboardMode = mode === "live" ? "live" : "classic";
        const response = await fetchLeaderboard(
          session.access_token,
          currentUser.country_code,
          leaderboardMode
        );

        if (cancelled) {
          return;
        }
        setEntries(response.users);
        setLeaderboardUser({
          ...currentUser,
          country_code: response.country_code ?? currentUser.country_code,
          country_name: response.country_name ?? currentUser.country_name,
        });
      } catch (loadError) {
        if (cancelled) {
          return;
        }
        const message = loadError instanceof Error ? loadError.message : "Could not load leaderboard.";
        setError(message);
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };

    void loadLeaderboard();
    return () => {
      cancelled = true;
    };
  }, [activeMode, hasMounted, router]);

  useEffect(() => {
    if (!hasMounted || activeMode !== "vip") {
      return;
    }

    const refreshVipEntries = () => {
      setEntries(buildVipLeaderboardEntries());
      setIsLoading(false);
    };

    const onVipStatsUpdated = () => refreshVipEntries();
    window.addEventListener("storage", refreshVipEntries);
    window.addEventListener("focus", refreshVipEntries);
    window.addEventListener(VIP_STATS_UPDATED_EVENT, onVipStatsUpdated);
    return () => {
      window.removeEventListener("storage", refreshVipEntries);
      window.removeEventListener("focus", refreshVipEntries);
      window.removeEventListener(VIP_STATS_UPDATED_EVENT, onVipStatsUpdated);
    };
  }, [activeMode, hasMounted]);

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

        {error && <p className="rounded-xl bg-red-500/20 px-3 py-2 text-sm text-red-200">{error}</p>}

        <div className="space-y-3">
          <p className="rounded-xl bg-slate-900/70 px-3 py-2 text-sm text-cyan-100">
            {locationLeaderboardTitle(leaderboardUser, activeMode)}
          </p>
          {isLoading || !hasMounted
            ? Array.from({ length: 10 }).map((_, index) => (
                <article
                  key={`leaderboard-skeleton-${index}`}
                  className="flex items-center gap-3 rounded-2xl border border-slate-700/60 bg-slate-900/60 px-3 py-3 backdrop-blur"
                >
                  <div className="skeleton-shimmer h-6 w-7 rounded-md" />
                  <div className="skeleton-shimmer h-14 w-14 rounded-full border border-slate-600/50" />
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="skeleton-shimmer h-4 w-2/5 rounded-md" />
                    <div className="skeleton-shimmer h-3 w-4/5 rounded-md" />
                    <div className="skeleton-shimmer h-3 w-3/5 rounded-md" />
                  </div>
                </article>
              ))
            : entries.map((entry) => (
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
                        unoptimized
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
                      Score {entry.score} | Rounds {entry.rounds_played} | Win {entry.win_rate.toFixed(1)}%
                    </p>
                    <p className="text-[11px] text-slate-400">
                      K {entry.kisses} M {entry.marries} X {entry.kills}
                    </p>
                  </div>
                </article>
              ))}
          {!isLoading && entries.length === 0 && (
            <article className="rounded-2xl border border-slate-700/60 bg-slate-900/60 px-3 py-4 text-sm text-slate-200">
              {activeMode === "vip"
                ? "VIP leaderboard is temporarily unavailable."
                : ENABLE_API_BOTS
                  ? "No national leaderboard activity yet for your country."
                  : "No real-player leaderboard activity yet. API bots are currently paused."}
            </article>
          )}
        </div>
      </section>
    </main>
  );
}
