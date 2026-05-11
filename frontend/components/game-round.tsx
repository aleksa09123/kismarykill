"use client";

import Image from "next/image";
import { useCallback, useEffect, useMemo, useState } from "react";

import { fetchRound, submitRoundVotes } from "@/lib/api";
import type { AuthUser, RoundLocation, RoundUser, VoteType } from "@/lib/types";

const actionStyle: Record<VoteType, string> = {
  kiss: "border-rose-300 bg-rose-50 text-rose-700",
  marry: "border-emerald-300 bg-emerald-50 text-emerald-700",
  kill: "border-slate-300 bg-slate-100 text-slate-700"
};

const selectedStyle: Record<VoteType, string> = {
  kiss: "ring-2 ring-rose-400",
  marry: "ring-2 ring-emerald-400",
  kill: "ring-2 ring-slate-500"
};

const DEFAULT_LOCATION: RoundLocation = {
  latitude: 43.8563,
  longitude: 18.4131
};

const ROUND_SIZE = 3;
const ZONE_RADIUS_KM = 20;
const LAST_LOCATION_STORAGE_KEY = "kmk_last_location";

function haversineDistanceKm(a: RoundLocation, b: RoundLocation): number {
  const toRad = (value: number) => (value * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);

  const n =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(n), Math.sqrt(1 - n));
  return 6371 * c;
}

function readStoredLocation(): RoundLocation | null {
  if (typeof window === "undefined") {
    return null;
  }

  const raw = window.localStorage.getItem(LAST_LOCATION_STORAGE_KEY);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as { latitude?: unknown; longitude?: unknown };
    if (typeof parsed.latitude !== "number" || typeof parsed.longitude !== "number") {
      return null;
    }
    return {
      latitude: parsed.latitude,
      longitude: parsed.longitude
    };
  } catch {
    return null;
  }
}

type GameRoundProps = {
  accessToken: string;
  currentUser: AuthUser;
  onLogout: () => void;
  onBackToMenu?: () => void;
};

export function GameRound({ accessToken, currentUser, onLogout, onBackToMenu }: GameRoundProps) {
  const [users, setUsers] = useState<RoundUser[]>([]);
  const [location, setLocation] = useState<RoundLocation>(DEFAULT_LOCATION);
  const [zoneId, setZoneId] = useState<string | null>(null);
  const [zoneOrigin, setZoneOrigin] = useState<RoundLocation | null>(null);
  const [selectedByUser, setSelectedByUser] = useState<Record<number, VoteType>>({});
  const [isLoadingRound, setIsLoadingRound] = useState(true);
  const [isSubmittingVotes, setIsSubmittingVotes] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const loadRound = useCallback(
    async (nextLocation: RoundLocation) => {
      setIsLoadingRound(true);
      setSelectedByUser({});
      setError(null);
      setInfo(null);
      setLocation(nextLocation);

      try {
        const response = await fetchRound({ location: nextLocation }, accessToken);
        setUsers(response.users);
        setZoneId((previousZoneId) => {
          if (previousZoneId && previousZoneId !== response.zone_id) {
            setInfo("Moved to a new Geo-Room. Refreshing your local server feed.");
          }
          return response.zone_id;
        });
        setZoneOrigin(nextLocation);
      } catch (roundError) {
        const message = roundError instanceof Error ? roundError.message : "Could not load the round.";
        setError(message);
        setUsers([]);
      } finally {
        setIsLoadingRound(false);
      }
    },
    [accessToken]
  );

  useEffect(() => {
    const storedLocation = readStoredLocation();
    if (storedLocation) {
      void loadRound(storedLocation);
    }

    if (!navigator.geolocation) {
      if (!storedLocation) {
        void loadRound(DEFAULT_LOCATION);
      }
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const nextLocation = {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude
        };
        if (typeof window !== "undefined") {
          window.localStorage.setItem(LAST_LOCATION_STORAGE_KEY, JSON.stringify(nextLocation));
        }
        void loadRound(nextLocation);
      },
      () => {
        if (!storedLocation) {
          void loadRound(DEFAULT_LOCATION);
        }
      },
      { enableHighAccuracy: true, timeout: 5000 }
    );
  }, [loadRound]);

  useEffect(() => {
    if (!navigator.geolocation) {
      return;
    }

    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        const nextLocation: RoundLocation = {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude
        };
        if (typeof window !== "undefined") {
          window.localStorage.setItem(LAST_LOCATION_STORAGE_KEY, JSON.stringify(nextLocation));
        }

        setLocation(nextLocation);
        if (!zoneOrigin || isLoadingRound || isSubmittingVotes) {
          return;
        }

        const movedKm = haversineDistanceKm(zoneOrigin, nextLocation);
        if (movedKm >= ZONE_RADIUS_KM) {
          void loadRound(nextLocation);
        }
      },
      () => {
        // Keep last known location if geolocation updates fail mid-session.
      },
      { enableHighAccuracy: true, timeout: 5000, maximumAge: 10000 }
    );

    return () => navigator.geolocation.clearWatch(watchId);
  }, [isLoadingRound, isSubmittingVotes, loadRound, zoneOrigin]);

  const usedActions = useMemo(() => new Set<VoteType>(Object.values(selectedByUser)), [selectedByUser]);

  const assignAction = (userId: number, action: VoteType) => {
    if (isSubmittingVotes) {
      return;
    }

    setSelectedByUser((previous) => {
      const next = { ...previous };

      if (next[userId] === action) {
        delete next[userId];
        return next;
      }

      const sameActionOwner = Object.entries(next).find(([, existingAction]) => existingAction === action);
      if (sameActionOwner) {
        delete next[Number(sameActionOwner[0])];
      }

      next[userId] = action;
      return next;
    });
  };

  const isRoundComplete =
    users.length === ROUND_SIZE && users.every((candidate) => selectedByUser[candidate.id] !== undefined);

  useEffect(() => {
    if (!isRoundComplete || isSubmittingVotes) {
      return;
    }

    const submitVotes = async () => {
      setIsSubmittingVotes(true);
      setError(null);

      try {
        await submitRoundVotes(
          {
            votes: users.map((candidate) => ({
              target_id: candidate.id,
              tip_glasa: selectedByUser[candidate.id] as VoteType
            }))
          },
          accessToken
        );

        await loadRound(location);
      } catch (submitError) {
        const message = submitError instanceof Error ? submitError.message : "Could not submit votes.";
        setError(message);
      } finally {
        setIsSubmittingVotes(false);
      }
    };

    void submitVotes();
  }, [accessToken, isRoundComplete, isSubmittingVotes, loadRound, location, selectedByUser, users]);

  return (
    <section className="w-full space-y-4 rounded-3xl border border-slate-200 bg-white/95 p-4 shadow-xl shadow-slate-900/10 backdrop-blur">
      <header className="rounded-2xl bg-slate-900 px-4 py-3 text-white">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="font-display text-2xl leading-tight">Kiss Marry Kill</p>
            <p className="text-xs text-slate-300">Signed in as {currentUser.name}</p>
          </div>
          <div className="flex items-center gap-2">
            {onBackToMenu && (
              <button
                type="button"
                onClick={onBackToMenu}
                className="min-h-11 min-w-11 rounded-xl border border-cyan-400/60 px-3 text-sm font-semibold text-cyan-100 transition hover:bg-cyan-900/40"
              >
                Back to Menu
              </button>
            )}
            <button
              type="button"
              onClick={onLogout}
              className="min-h-11 min-w-11 rounded-xl border border-slate-500 px-3 text-sm font-semibold text-slate-100 transition hover:bg-slate-800"
            >
              Logout
            </button>
          </div>
        </div>
      </header>

      {error && <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {info && <p className="rounded-xl bg-cyan-50 px-3 py-2 text-sm text-cyan-700">{info}</p>}

      {(isLoadingRound || isSubmittingVotes) && (
        <p className="rounded-xl bg-slate-100 px-3 py-2 text-sm text-slate-700">
          {isSubmittingVotes ? "Submitting votes and loading next round..." : "Loading nearby users..."}
        </p>
      )}

      {!isLoadingRound && users.length !== ROUND_SIZE && (
        <p className="rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-700">
          Not enough users matched your filters in this area right now. Try again from another location.
        </p>
      )}

      <div className="space-y-3">
        {users.map((candidate) => {
          const selected = selectedByUser[candidate.id];
          const imageUrl = candidate.profile_image_url?.trim() || null;

          return (
            <article key={candidate.id} className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
              <div className="relative aspect-[4/5] w-full bg-slate-200">
                {imageUrl ? (
                  <Image
                    src={imageUrl}
                    alt={candidate.name}
                    fill
                    sizes="(max-width: 768px) 100vw, 420px"
                    className="object-cover"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center bg-slate-300 text-3xl font-bold text-slate-600">
                    {candidate.name.slice(0, 1).toUpperCase()}
                  </div>
                )}
                <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-4 pb-4 pt-10 text-white">
                  <p className="font-display text-2xl">{candidate.name}</p>
                  <p className="text-sm text-slate-200">
                    {candidate.distance_km.toFixed(1)} km away | {candidate.gender}
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2 p-3">
                {(Object.keys(actionStyle) as VoteType[]).map((action) => (
                  <button
                    key={action}
                    type="button"
                    disabled={isSubmittingVotes}
                    onClick={() => assignAction(candidate.id, action)}
                    className={`min-h-11 min-w-11 rounded-xl border px-2 text-sm font-semibold capitalize transition ${
                      actionStyle[action]
                    } ${selected === action ? selectedStyle[action] : ""}`}
                  >
                    {action}
                  </button>
                ))}
              </div>
            </article>
          );
        })}
      </div>

      <footer className="rounded-xl bg-slate-100 px-3 py-2 text-xs text-slate-700">
        Chosen actions: {Array.from(usedActions).join(", ") || "none"} ({usedActions.size}/3) | Zone:{" "}
        {zoneId ?? "loading"} | Location:{" "}
        {location.latitude.toFixed(3)}, {location.longitude.toFixed(3)}
      </footer>
    </section>
  );
}

