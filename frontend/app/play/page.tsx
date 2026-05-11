"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { GameRound } from "@/components/game-round";
import { fetchCurrentUser } from "@/lib/api";
import { clearSession, hasUnlockedProfilePhoto, patchSessionUser, readSession } from "@/lib/auth-session";
import type { AuthResponse, AuthUser } from "@/lib/types";

export default function PlayPage() {
  const router = useRouter();
  const [session, setSession] = useState<AuthResponse | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const currentSession = readSession();
    if (!currentSession) {
      router.replace("/login");
      return;
    }

    const hydrate = async () => {
      setSession(currentSession);
      try {
        const refreshedUser = await fetchCurrentUser(currentSession.access_token);
        patchSessionUser(refreshedUser);
        if (!hasUnlockedProfilePhoto(refreshedUser.profile_image_url) || !refreshedUser.face_verified) {
          router.replace("/dashboard");
          return;
        }
        setUser(refreshedUser);
      } catch {
        clearSession();
        router.replace("/login");
        return;
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

  if (isLoading || !session || !user) {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-md items-center justify-center px-4">
        <p className="text-sm text-slate-300">Loading game...</p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md items-start px-3 py-4 md:justify-center md:py-8">
      <div
        className="w-full"
        style={{
          paddingTop: "max(env(safe-area-inset-top), 0.25rem)",
          paddingBottom: "max(env(safe-area-inset-bottom), 0.75rem)"
        }}
      >
        <GameRound
          accessToken={session.access_token}
          currentUser={user}
          onLogout={logout}
          onBackToMenu={() => router.push("/dashboard")}
        />
      </div>
    </main>
  );
}
