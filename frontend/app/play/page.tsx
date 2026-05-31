"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { BlindModeRound } from "@/components/blind-mode-round";
import { GameRound } from "@/components/game-round";
import { LiveModeRound } from "@/components/live-mode-round";
import { fetchCurrentUser } from "@/lib/api";
import { clearSession, hasUnlockedProfilePhoto, patchSessionUser, readSession } from "@/lib/auth-session";
import { normalizeGameMode, type GameMode, readActiveGameMode, writeActiveGameMode } from "@/lib/game-mode";
import type { AuthResponse, AuthUser, VoteType } from "@/lib/types";
import { recordVIPRoundVotes } from "@/lib/vip-stats";

export default function PlayPage() {
  const router = useRouter();
  const [session, setSession] = useState<AuthResponse | null>(() => readSession());
  const [user, setUser] = useState<AuthUser | null>(() => readSession()?.user ?? null);
  const [isLoading, setIsLoading] = useState<boolean>(() => readSession() === null);
  const [warning, setWarning] = useState<string | null>(null);
  const [mode, setMode] = useState<GameMode>(() => readActiveGameMode());

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const queryMode = new URLSearchParams(window.location.search).get("mode");
    const nextMode = queryMode === null ? readActiveGameMode() : normalizeGameMode(queryMode);
    setMode(nextMode);
    writeActiveGameMode(nextMode);
  }, []);

  useEffect(() => {
    router.prefetch("/dashboard");
  }, [router]);

  useEffect(() => {
    const currentSession = readSession();
    if (!currentSession) {
      router.replace("/login");
      return;
    }

    setSession(currentSession);
    setUser(currentSession.user);
    setWarning(null);
    setIsLoading(false);

    const hydrate = async () => {
      try {
        const refreshedUser = await fetchCurrentUser(currentSession.access_token);
        patchSessionUser(refreshedUser);
        if (!hasUnlockedProfilePhoto(refreshedUser.profile_image_url) || !refreshedUser.face_verified) {
          router.replace("/dashboard");
          return;
        }
        setUser(refreshedUser);
      } catch (hydrateError) {
        const message =
          hydrateError instanceof Error
            ? hydrateError.message
            : "Could not refresh profile right now.";
        setWarning(
          `${message} Session is preserved, so you can retry without logging in again.`
        );
      } finally {
        setIsLoading(false);
      }
    };

    void hydrate();
  }, [router]);

  const logout = () => {
    clearSession();
    router.replace("/login");
  };

  const handleVipRoundConfirm = async (votes: Array<{ profileId: string; action: VoteType }>) => {
    if (mode !== "vip") {
      return;
    }

    recordVIPRoundVotes(votes);

    const latestSession = readSession();
    const fallbackUser = latestSession?.user ?? user;
    if (!fallbackUser) {
      return;
    }

    const nextUser: AuthUser = {
      ...fallbackUser,
      rounds_played: Math.max(0, fallbackUser.rounds_played) + 1
    };
    const patched = patchSessionUser(nextUser);
    setUser(patched?.user ?? nextUser);
  };

  const handleBlindRoundSubmitted = () => {
    const latestSession = readSession();
    const fallbackUser = latestSession?.user ?? user;
    if (!fallbackUser) {
      return;
    }

    const nextUser: AuthUser = {
      ...fallbackUser,
      rounds_played: Math.max(0, fallbackUser.rounds_played) + 1
    };
    const patched = patchSessionUser(nextUser);
    setUser(patched?.user ?? nextUser);
  };

  if (isLoading || !session || !user) {
    return (
      <main className="relative mx-auto flex min-h-screen w-full max-w-md items-center justify-center overflow-x-hidden px-4">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(70%_55%_at_0%_0%,rgba(8,107,255,0.32),transparent_70%),radial-gradient(55%_45%_at_100%_6%,rgba(20,110,255,0.22),transparent_72%),linear-gradient(160deg,#010716_0%,#020c25_50%,#010913_100%)]" />
        <p className="relative z-10 rounded-2xl border border-blue-300/20 bg-blue-500/10 px-4 py-2 text-sm text-blue-100">
          Loading game...
        </p>
      </main>
    );
  }

  return (
    <main className="relative mx-auto flex min-h-screen w-full max-w-md items-start overflow-x-hidden px-3 py-4 md:justify-center md:py-8">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(70%_55%_at_0%_0%,rgba(8,107,255,0.32),transparent_70%),radial-gradient(55%_45%_at_100%_6%,rgba(20,110,255,0.22),transparent_72%),linear-gradient(160deg,#010716_0%,#020c25_50%,#010913_100%)]" />
      <div className="pointer-events-none absolute inset-x-4 top-10 h-56 rounded-full bg-cyan-400/10 blur-3xl" />
      <div
        className="relative z-10 w-full"
        style={{
          paddingTop: "max(env(safe-area-inset-top), 0.25rem)",
          paddingBottom: "max(env(safe-area-inset-bottom), 0.75rem)"
        }}
      >
        {warning ? (
          <p className="mb-3 rounded-2xl border border-amber-300/35 bg-amber-500/15 px-3 py-2 text-sm text-amber-100">
            {warning}
          </p>
        ) : null}
        {mode === "live" ? (
          <LiveModeRound
            currentUser={user}
            onBackToMenu={() => router.push("/dashboard")}
          />
        ) : mode === "blind" ? (
          <BlindModeRound
            accessToken={session.access_token}
            currentUser={user}
            onBackToMenu={() => router.push("/dashboard")}
            onRoundSubmitted={handleBlindRoundSubmitted}
          />
        ) : (
          <GameRound
            accessToken={session.access_token}
            currentUser={user}
            mode={mode}
            onLogout={logout}
            onBackToMenu={() => router.push("/dashboard")}
            onVipConfirmRound={handleVipRoundConfirm}
          />
        )}
      </div>
    </main>
  );
}
