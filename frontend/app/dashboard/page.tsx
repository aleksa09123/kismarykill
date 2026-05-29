"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { PremiumLiveFeedModel } from "@/components/premium-live-feed-model";
import { ReferralUnlockModal } from "@/components/referral-unlock-modal";
import { fetchBotFeedback, fetchCurrentLocation, fetchLocationOptions, setCurrentLocation } from "@/lib/api";
import { AUTH_STORAGE_KEY, hasUnlockedProfilePhoto, readSession, refreshSessionFromStorage } from "@/lib/auth-session";
import { ENABLE_API_BOTS } from "@/lib/feature-flags";
import {
  ACTIVE_GAME_MODE_STORAGE_KEY,
  ACTIVE_GAME_MODE_UPDATED_EVENT,
  type GameMode,
  readActiveGameMode,
  writeActiveGameMode
} from "@/lib/game-mode";
import {
  GLOBAL_LOCATION_OPTION,
  LOCATION_SELECTION_STORAGE_KEY,
  buildServerId,
  persistLocationClient,
  readInitialLocationClient,
  readPersistedLocationClient
} from "@/lib/location-storage";
import type {
  AuthResponse,
  AuthUser,
  BotFeedbackEntry,
  BotFeedbackResponse,
  LocationOptionCountry,
  LocationSelectionResponse,
  VoteType
} from "@/lib/types";

const reactionLabel: Record<VoteType, string> = {
  kiss: "kissed",
  marry: "married",
  kill: "killed"
};

const reactionStyle: Record<VoteType, string> = {
  kiss: "border-rose-400/35 bg-rose-500/15 text-rose-100",
  marry: "border-emerald-400/35 bg-emerald-500/15 text-emerald-100",
  kill: "border-red-400/35 bg-red-500/15 text-red-100"
};

const premiumFeedDescription = "Unlock your Live Feed to see exactly who Kissed, Married, or Killed you!";
const LOCATION_SYNC_TIMEOUT_MS = 12000;
const MAX_LOCATION_RESULTS = 250;
let cachedLocationOptions: LocationOptionCountry[] | null = null;

type IconProps = {
  className?: string;
};

function readInitialSessionClient(): AuthResponse | null {
  if (typeof window === "undefined") {
    return null;
  }
  return readSession();
}

function parseAdminEmails(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean)
  );
}

function isAdminEmail(email: string | null | undefined): boolean {
  const normalizedEmail = email?.trim().toLowerCase();
  if (!normalizedEmail) {
    return false;
  }

  return parseAdminEmails(process.env.NEXT_PUBLIC_ADMIN_EMAILS).has(normalizedEmail);
}

function GlobeIcon({ className = "h-4 w-4" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" />
      <path d="M3 12h18M12 3c2.8 3 2.8 15 0 18M12 3c-2.8 3-2.8 15 0 18" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

function ChevronDownIcon({ className = "h-4 w-4" }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden>
      <path d="m5.5 7.5 4.5 5 4.5-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ChevronRightIcon({ className = "h-5 w-5" }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden>
      <path d="m8 5 4.5 5L8 15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function GamepadIcon({ className = "h-3.5 w-3.5" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <rect x="3.5" y="8" width="17" height="9" rx="4.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="M8 12h4M10 10v4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="16" cy="11" r="1" fill="currentColor" />
      <circle cx="18" cy="13" r="1" fill="currentColor" />
    </svg>
  );
}

function LockIcon({ className = "h-4 w-4" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <rect x="5" y="10" width="14" height="10" rx="2.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="M8.5 10V7.8A3.5 3.5 0 0 1 12 4.3a3.5 3.5 0 0 1 3.5 3.5V10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function PlayIcon({ className = "h-5 w-5" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" />
      <path d="m10 8 6 4-6 4V8Z" fill="currentColor" />
    </svg>
  );
}

function TrophyIcon({ className = "h-5 w-5" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path d="M7 5h10v3a5 5 0 0 1-10 0V5Z" stroke="currentColor" strokeWidth="1.8" />
      <path d="M7 7H5a2 2 0 0 0 2 3m10-3h2a2 2 0 0 1-2 3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M12 13v3m-3 3h6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function SettingsIcon({ className = "h-5 w-5" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path
        d="M9.3 4.8 12 3l2.7 1.8 3.2-.2.9 3 2.6 2-1.1 3 1.1 3-2.6 2-.9 3-3.2-.2L12 21l-2.7-1.8-3.2.2-.9-3-2.6-2 1.1-3-1.1-3 2.6-2 .9-3 3.2.2Z"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <circle cx="12" cy="12" r="2.5" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

function ShieldIcon({ className = "h-5 w-5" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path
        d="M12 3.5 5.2 6.1v5.1c0 4.4 2.8 8.2 6.8 9.3 4-1.1 6.8-4.9 6.8-9.3V6.1L12 3.5Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path d="m9.2 12 1.8 1.8 4-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function BoltIcon({ className = "h-4 w-4" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M13.7 2 5 13h5.3L9.8 22 19 10.7h-5.2L13.7 2Z" />
    </svg>
  );
}

function CrownIcon({ className = "h-3.5 w-3.5" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path d="m4 18 1.6-10 5.1 4 1.3-6 1.3 6 5.1-4L20 18H4Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M4 18h16" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="5.6" cy="8" r="1.1" fill="currentColor" />
      <circle cx="12" cy="6" r="1.1" fill="currentColor" />
      <circle cx="18.4" cy="8" r="1.1" fill="currentColor" />
    </svg>
  );
}

function LiveSignalIcon({ className = "h-3.5 w-3.5" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <circle cx="12" cy="12" r="2.1" fill="currentColor" />
      <path d="M7.8 16.2a6 6 0 0 1 0-8.4M16.2 7.8a6 6 0 0 1 0 8.4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M5 19a10 10 0 0 1 0-14M19 5a10 10 0 0 1 0 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function RingsIcon({ className = "h-14 w-14" }: IconProps) {
  return (
    <svg viewBox="0 0 80 80" fill="none" className={className} aria-hidden>
      <defs>
        <linearGradient id="ringsA" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#f8d477" />
          <stop offset="60%" stopColor="#d99c42" />
          <stop offset="100%" stopColor="#8e5a21" />
        </linearGradient>
      </defs>
      <circle cx="30" cy="44" r="17" stroke="url(#ringsA)" strokeWidth="6" />
      <circle cx="49" cy="36" r="17" stroke="url(#ringsA)" strokeWidth="6" />
    </svg>
  );
}

function LipsIcon({ className = "h-12 w-12" }: IconProps) {
  return (
    <svg viewBox="0 0 80 80" fill="none" className={className} aria-hidden>
      <defs>
        <linearGradient id="lipsA" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#fbe39b" />
          <stop offset="50%" stopColor="#d7a760" />
          <stop offset="100%" stopColor="#8f5f2f" />
        </linearGradient>
      </defs>
      <path
        d="M12 44c8-12 20-18 28-18s20 6 28 18c-8 6-20 11-28 11s-20-5-28-11Zm14 2c6-6 10-9 14-9s8 3 14 9c-6 4-10 6-14 6s-8-2-14-6Z"
        fill="url(#lipsA)"
      />
    </svg>
  );
}

function SkullIcon({ className = "h-16 w-16" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <defs>
        <linearGradient id="skullA" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#f1f5ff" />
          <stop offset="45%" stopColor="#b9b8df" />
          <stop offset="100%" stopColor="#6f6798" />
        </linearGradient>
      </defs>
      <path
        d="M12 3.2c-4.7 0-8.5 3.7-8.5 8.2 0 3 1.7 5.6 4.3 7v1.9c0 1.4 1.1 2.5 2.5 2.5h3.4c1.4 0 2.5-1.1 2.5-2.5v-1.9a8 8 0 0 0 4.3-7c0-4.5-3.8-8.2-8.5-8.2Z"
        fill="url(#skullA)"
        stroke="#d7dcff"
        strokeWidth="0.6"
      />
      <circle cx="9" cy="12" r="1.6" fill="#252845" />
      <circle cx="15" cy="12" r="1.6" fill="#252845" />
      <path d="M10.1 16.1h3.8a1.9 1.9 0 0 1-3.8 0Z" fill="#252845" />
      <path d="M9.5 19.3h5M10.7 21h2.6" stroke="#252845" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function ProfileFallback() {
  return (
    <div className="flex h-full w-full items-center justify-center rounded-full bg-slate-800 text-slate-300">
      <svg viewBox="0 0 24 24" className="h-10 w-10" aria-hidden>
        <path
          fill="currentColor"
          d="M12 12a5 5 0 1 0-5-5 5 5 0 0 0 5 5m0 2c-4 0-8 2-8 5v1h16v-1c0-3-4-5-8-5"
        />
      </svg>
    </div>
  );
}

export default function DashboardPage() {
  const router = useRouter();
  const [session, setSession] = useState<AuthResponse | null>(() => readInitialSessionClient());
  const [user, setUser] = useState<AuthUser | null>(() => readInitialSessionClient()?.user ?? null);
  const [isMounted, setIsMounted] = useState(false);
  const [isStartingPlay, setIsStartingPlay] = useState(false);
  const [isChangingLocation, setIsChangingLocation] = useState(false);
  const [isReferralModalOpen, setIsReferralModalOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [botFeedback, setBotFeedback] = useState<BotFeedbackResponse | null>(null);
  const [selectedMode, setSelectedMode] = useState<GameMode>(() => readActiveGameMode());
  const [currentLocation, setCurrentLocationState] = useState<LocationSelectionResponse | null>(() => readInitialLocationClient());

  const [locationOptions, setLocationOptions] = useState<LocationOptionCountry[]>(() =>
    cachedLocationOptions ?? [GLOBAL_LOCATION_OPTION]
  );
  const [isLoadingLocationOptions, setIsLoadingLocationOptions] = useState(true);
  const [countrySearchQuery, setCountrySearchQuery] = useState("");
  const [isLocationPickerOpen, setIsLocationPickerOpen] = useState(false);
  const [selectedCountryCode, setSelectedCountryCode] = useState<string>(() => readInitialLocationClient()?.country_code ?? "");
  const [selectedCountryName, setSelectedCountryName] = useState<string>(() => readInitialLocationClient()?.country_name ?? "");
  const locationUpdateRequestRef = useRef(0);
  const locationOptionsRequestRef = useRef(0);
  const dashboardSyncRequestRef = useRef(0);
  const hasInitializedDashboardRef = useRef(false);
  const hasHydratedModeRef = useRef(false);
  const isComponentMountedRef = useRef(false);
  const locationMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    isComponentMountedRef.current = true;
    setIsMounted(true);
    return () => {
      isComponentMountedRef.current = false;
      dashboardSyncRequestRef.current += 1;
      locationUpdateRequestRef.current += 1;
      locationOptionsRequestRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!isMounted) {
      return;
    }

    const syncFromStorage = () => {
      const refreshed = refreshSessionFromStorage();
      if (refreshed) {
        setSession(refreshed);
        setUser(refreshed.user);
      }

      const nextLocation = readInitialLocationClient();
      if (nextLocation) {
        setCurrentLocationState(nextLocation);
        setSelectedCountryCode(nextLocation.country_code);
        setSelectedCountryName(nextLocation.country_name);
      }

      setSelectedMode(readActiveGameMode());
    };
    const syncModeFromStorage = () => {
      setSelectedMode(readActiveGameMode());
    };

    const onStorage = (event: StorageEvent) => {
      if (
        event.key === null ||
        event.key === AUTH_STORAGE_KEY ||
        event.key === ACTIVE_GAME_MODE_STORAGE_KEY ||
        event.key === LOCATION_SELECTION_STORAGE_KEY
      ) {
        syncFromStorage();
      }
    };

    syncFromStorage();
    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", syncFromStorage);
    window.addEventListener(ACTIVE_GAME_MODE_UPDATED_EVENT, syncModeFromStorage as EventListener);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", syncFromStorage);
      window.removeEventListener(ACTIVE_GAME_MODE_UPDATED_EVENT, syncModeFromStorage as EventListener);
    };
  }, [isMounted]);

  const handleModeSelection = useCallback((mode: GameMode) => {
    setSelectedMode(mode);
    writeActiveGameMode(mode);
  }, []);

  useEffect(() => {
    if (!isMounted) {
      return;
    }
    if (session) {
      return;
    }
    const nextSession = readSession();
    if (!nextSession) {
      router.replace("/login");
      return;
    }
    setSession(nextSession);
    setUser(nextSession.user);
  }, [isMounted, router, session]);

  useEffect(() => {
    if (!isMounted) {
      return;
    }
    if (!hasHydratedModeRef.current) {
      hasHydratedModeRef.current = true;
      return;
    }
    writeActiveGameMode(selectedMode);
  }, [isMounted, selectedMode]);

  useEffect(() => {
    if (selectedMode === "vip") {
      setBotFeedback(null);
    }
  }, [selectedMode]);

  const loadLocationOptions = useCallback(async () => {
    if (cachedLocationOptions) {
      setLocationOptions(cachedLocationOptions);
      setIsLoadingLocationOptions(false);
      return;
    }

    const requestId = ++locationOptionsRequestRef.current;
    setIsLoadingLocationOptions(true);
    try {
      const payload = await fetchLocationOptions();
      const normalizedCountries = [
        GLOBAL_LOCATION_OPTION,
        ...payload
          .map((country) => ({
            country_code: country.country_code,
            country_name: country.country_name,
          }))
          .filter((country) => country.country_code && country.country_name)
          .filter((country, index, list) => index === list.findIndex((item) => item.country_code === country.country_code))
          .filter((country) => country.country_code !== GLOBAL_LOCATION_OPTION.country_code)
          .sort((a, b) => a.country_name.localeCompare(b.country_name)),
      ];
      if (requestId !== locationOptionsRequestRef.current || !isComponentMountedRef.current) {
        return;
      }
      setLocationOptions(normalizedCountries);
      cachedLocationOptions = normalizedCountries;
    } catch {
      if (requestId !== locationOptionsRequestRef.current || !isComponentMountedRef.current) {
        return;
      }
      // Keep global selector available if public API is temporarily unavailable.
      setLocationOptions([GLOBAL_LOCATION_OPTION]);
    } finally {
      if (requestId === locationOptionsRequestRef.current && isComponentMountedRef.current) {
        setIsLoadingLocationOptions(false);
      }
    }
  }, []);

  useEffect(() => {
    void loadLocationOptions();
  }, [loadLocationOptions]);

  useEffect(() => {
    if (!session || hasInitializedDashboardRef.current) {
      return;
    }
    hasInitializedDashboardRef.current = true;

    const requestId = ++dashboardSyncRequestRef.current;
    setError(null);

    const syncDashboardContext = async () => {
      const withTimeout = <T,>(promise: Promise<T>, fallbackMessage: string): Promise<T> =>
        new Promise<T>((resolve, reject) => {
          const timeoutId = window.setTimeout(() => {
            reject(new Error(fallbackMessage));
          }, LOCATION_SYNC_TIMEOUT_MS);
          promise
            .then((result) => {
              window.clearTimeout(timeoutId);
              resolve(result);
            })
            .catch((timeoutError) => {
              window.clearTimeout(timeoutId);
              reject(timeoutError);
            });
        });

      const [locationResult, feedbackResult] = await Promise.allSettled([
        withTimeout(fetchCurrentLocation(session.access_token), "Location sync timed out."),
        ENABLE_API_BOTS && selectedMode !== "vip"
          ? withTimeout(fetchBotFeedback(session.access_token), "Live feed sync timed out.")
          : Promise.resolve(null)
      ]);

      if (requestId !== dashboardSyncRequestRef.current || !isComponentMountedRef.current) {
        return;
      }

      if (locationResult.status === "fulfilled") {
        const persistedLocation = readPersistedLocationClient();
        const resolvedLocation =
          persistedLocation &&
          persistedLocation.country_code !== GLOBAL_LOCATION_OPTION.country_code &&
          locationResult.value.country_code === GLOBAL_LOCATION_OPTION.country_code
            ? persistedLocation
            : locationResult.value;
        setCurrentLocationState(resolvedLocation);
        setSelectedCountryCode(resolvedLocation.country_code);
        setSelectedCountryName(resolvedLocation.country_name);
        persistLocationClient(resolvedLocation);
      }

      if (ENABLE_API_BOTS && feedbackResult.status === "fulfilled") {
        setBotFeedback(feedbackResult.value);
      } else if (!ENABLE_API_BOTS) {
        setBotFeedback(null);
      } else if (selectedMode === "vip") {
        setBotFeedback(null);
      }

      if (locationResult.status === "rejected" && feedbackResult.status === "rejected") {
        setError("Unable to refresh dashboard context.");
      }
    };

    void syncDashboardContext();
  }, [selectedMode, session]);

  const playLocked = useMemo(
    () => !hasUnlockedProfilePhoto(user?.profile_image_url) || !user?.face_verified,
    [user?.face_verified, user?.profile_image_url]
  );

  const selectedCountry = useMemo(
    () =>
      locationOptions.find((country) => country.country_code === selectedCountryCode) ??
      (selectedCountryCode === GLOBAL_LOCATION_OPTION.country_code ? GLOBAL_LOCATION_OPTION : null),
    [locationOptions, selectedCountryCode]
  );
  const filteredCountries = useMemo(() => {
    const query = countrySearchQuery.trim().toLowerCase();
    const list = query
      ? locationOptions.filter((country) => country.country_name.toLowerCase().includes(query))
      : locationOptions;
    const limited = list.slice(0, MAX_LOCATION_RESULTS);
    const selected = list.find((country) => country.country_code === selectedCountryCode);
    if (selected && !limited.some((country) => country.country_code === selected.country_code)) {
      return [selected, ...limited.slice(0, Math.max(0, MAX_LOCATION_RESULTS - 1))];
    }
    return limited;
  }, [countrySearchQuery, locationOptions, selectedCountryCode]);
  const selectorCountryCode = selectedCountryCode || currentLocation?.country_code || GLOBAL_LOCATION_OPTION.country_code;
  const connectedCountryLabel = selectedCountryName || currentLocation?.country_name || GLOBAL_LOCATION_OPTION.country_name;
  const referralTarget = 5;
  const referralCount = Math.max(
    0,
    Math.floor(Number(user?.referralCount ?? user?.referral_count ?? 0))
  );
  const hasReferralUnlock = referralCount >= referralTarget;
  const isPremiumUser = Boolean(user?.is_premium);
  const shouldShowPaywall = user !== null && !isPremiumUser && !hasReferralUnlock;
  const shouldShowAdminPanel = useMemo(() => isAdminEmail(user?.email), [user?.email]);
  const inviteRef = user?.id ?? user?.username?.trim() ?? "";
  const referralLink = isMounted && inviteRef
    ? `${window.location.origin}/register?ref=${encodeURIComponent(String(inviteRef))}`
    : "";

  useEffect(() => {
    if (!shouldShowPaywall) {
      setIsReferralModalOpen(false);
    }
  }, [shouldShowPaywall]);

  const loadBotFeedback = useCallback(async () => {
    if (!session || !ENABLE_API_BOTS || selectedMode === "vip") {
      return;
    }
    try {
      const summary = await fetchBotFeedback(session.access_token);
      setBotFeedback(summary);
    } catch {
      // Keep dashboard usable even if feedback endpoint is temporarily unavailable.
    }
  }, [selectedMode, session]);

  useEffect(() => {
    if (!selectedCountryName && selectedCountry) {
      setSelectedCountryName(selectedCountry.country_name);
    }
  }, [selectedCountry, selectedCountryName]);

  const syncLocationAndRefreshContext = useCallback(
    async (countryCode: string, keepModalOpen = true) => {
      if (!session || !countryCode) {
        return;
      }

      const nextCountryName = selectedCountryName || selectedCountry?.country_name || countryCode;
      const draftLocation: LocationSelectionResponse = {
        country_code: countryCode,
        country_name: nextCountryName,
        latitude: 0,
        longitude: 0,
        server_id: buildServerId(countryCode)
      };

      // Lock user choice immediately so the selector survives re-renders/network jitter.
      setCurrentLocationState(draftLocation);
      setSelectedCountryCode(countryCode);
      setSelectedCountryName(nextCountryName);
      persistLocationClient(draftLocation);
      setBotFeedback(null);

      const requestId = ++locationUpdateRequestRef.current;
      setIsChangingLocation(true);
      setError(null);
      try {
        const withTimeout = <T,>(promise: Promise<T>, fallbackMessage: string): Promise<T> =>
          new Promise<T>((resolve, reject) => {
            const timeoutId = window.setTimeout(() => {
              reject(new Error(fallbackMessage));
            }, LOCATION_SYNC_TIMEOUT_MS);
            promise
              .then((result) => {
                window.clearTimeout(timeoutId);
                resolve(result);
              })
              .catch((timeoutError) => {
                window.clearTimeout(timeoutId);
                reject(timeoutError);
              });
          });

        await withTimeout(
          setCurrentLocation(
          {
            country_code: countryCode,
            country_name: nextCountryName,
          },
          session.access_token
          ),
          "Location update timed out. Please try again."
        );

        // Confirm the backend cookie context first, then refresh dashboard data.
        const [confirmedLocation, nextFeed] = await withTimeout(
          Promise.all([
            fetchCurrentLocation(session.access_token),
            ENABLE_API_BOTS && selectedMode !== "vip"
              ? fetchBotFeedback(session.access_token)
              : Promise.resolve(null)
          ]),
          "Location sync took too long. Please try again."
        );

        // Ignore stale responses if a newer location change started.
        if (requestId !== locationUpdateRequestRef.current || !isComponentMountedRef.current) {
          return;
        }

        setBotFeedback(ENABLE_API_BOTS ? nextFeed : null);
        const resolvedLocation =
          draftLocation.country_code !== GLOBAL_LOCATION_OPTION.country_code &&
          confirmedLocation.country_code === GLOBAL_LOCATION_OPTION.country_code
            ? draftLocation
            : confirmedLocation;

        setCurrentLocationState(() => resolvedLocation);
        setSelectedCountryCode(() => resolvedLocation.country_code);
        setSelectedCountryName(() => resolvedLocation.country_name);
        persistLocationClient(resolvedLocation);

        if (!keepModalOpen) {
          setIsLocationPickerOpen(false);
        }
      } catch (locationError) {
        if (requestId !== locationUpdateRequestRef.current || !isComponentMountedRef.current) {
          return;
        }
        const message =
          locationError instanceof Error
            ? locationError.message
            : "Could not synchronize location. Please try again.";
        setError(message);
      } finally {
        if (requestId === locationUpdateRequestRef.current && isComponentMountedRef.current) {
          setIsChangingLocation(false);
        }
      }
    },
    [selectedCountry?.country_name, selectedCountryName, selectedMode, session]
  );

  useEffect(() => {
    if (!isLocationPickerOpen) {
      return;
    }
    const handlePointerDown = (event: PointerEvent) => {
      if (!locationMenuRef.current) {
        return;
      }
      if (!locationMenuRef.current.contains(event.target as Node)) {
        setIsLocationPickerOpen(false);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [isLocationPickerOpen]);

  useEffect(() => {
    if (!session || !ENABLE_API_BOTS || selectedMode === "vip") {
      return;
    }
    const intervalId = window.setInterval(() => {
      void loadBotFeedback();
    }, 7000);
    return () => window.clearInterval(intervalId);
  }, [loadBotFeedback, selectedMode, session, currentLocation?.server_id]);

  const applySelectedLocation = async () => {
    if (!currentLocation) {
      await syncLocationAndRefreshContext(selectedCountryCode, false);
      return;
    }
    if (currentLocation.country_code === selectedCountryCode) {
      setIsLocationPickerOpen(false);
      return;
    }
    await syncLocationAndRefreshContext(selectedCountryCode, false);
  };

  const startPlay = async () => {
    if (!session || playLocked) {
      return;
    }

    const locationForPlay: LocationSelectionResponse = {
      country_code: selectorCountryCode,
      country_name: connectedCountryLabel,
      latitude: currentLocation?.latitude ?? 0,
      longitude: currentLocation?.longitude ?? 0,
      server_id: buildServerId(selectorCountryCode)
    };

    setCurrentLocationState(locationForPlay);
    persistLocationClient(locationForPlay);

    setError(null);
    setIsStartingPlay(true);

    try {
      await setCurrentLocation(
        {
          country_code: locationForPlay.country_code,
          country_name: locationForPlay.country_name
        },
        session.access_token
      );
    } catch {
      // Keep play flow moving; current selector state is still passed through URL and local storage.
    }

    const params = new URLSearchParams({
      mode: selectedMode,
      country_code: locationForPlay.country_code,
      country_name: locationForPlay.country_name
    });
    writeActiveGameMode(selectedMode);
    router.push(`/play?${params.toString()}`);
  };

  const renderFeedEntry = (entry: BotFeedbackEntry) => {
    const action = reactionLabel[entry.tip_glasa];
    if (entry.is_for_current_user) {
      return (
        <>
          <span className="font-semibold">{entry.actor_name}</span> {action} you
        </>
      );
    }
    return (
      <>
        <span className="font-semibold">{entry.actor_name}</span> {action}{" "}
        <span className="font-semibold">{entry.target_name}</span>
      </>
    );
  };

  return (
    <main className="relative mx-auto flex min-h-screen w-full max-w-md items-start overflow-x-hidden px-3 py-4 md:justify-center md:py-8">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(70%_55%_at_0%_0%,rgba(8,107,255,0.32),transparent_70%),radial-gradient(55%_45%_at_100%_6%,rgba(20,110,255,0.22),transparent_72%),linear-gradient(160deg,#010716_0%,#020c25_50%,#010913_100%)]" />
      <div className="pointer-events-none absolute inset-x-4 top-10 h-56 rounded-full bg-cyan-400/10 blur-3xl" />

      <section
        className="relative z-10 w-full space-y-3 rounded-[30px] border border-blue-300/15 bg-[linear-gradient(180deg,rgba(2,15,42,0.88)_0%,rgba(3,12,33,0.86)_100%)] p-3.5 shadow-[0_30px_90px_rgba(1,4,12,0.75)] backdrop-blur-xl sm:p-4"
        style={{
          paddingTop: "max(env(safe-area-inset-top), 0.4rem)",
          paddingBottom: "max(env(safe-area-inset-bottom), 0.85rem)"
        }}
      >
        <header className="relative min-h-[48px]">
          <h1 className="max-w-[calc(100%-148px)] font-display text-[26px] font-bold leading-[1.02] tracking-tight text-white sm:text-[30px]">
            Kiss Marry Kill
          </h1>
          <div ref={locationMenuRef} className="absolute right-0 top-0 z-50">
            <button
              type="button"
              onClick={() => {
                if (!selectedCountryCode) {
                  setSelectedCountryCode(currentLocation?.country_code ?? GLOBAL_LOCATION_OPTION.country_code);
                  setSelectedCountryName(currentLocation?.country_name ?? GLOBAL_LOCATION_OPTION.country_name);
                }
                setIsLocationPickerOpen((open) => !open);
              }}
              className="inline-flex h-10 w-[140px] max-w-[140px] touch-manipulation items-center gap-1.5 rounded-full border border-blue-300/25 bg-[#081744]/90 px-2.5 text-xs font-semibold text-slate-100 shadow-[inset_0_0_0_1px_rgba(114,181,255,0.12)] transition-colors duration-200 active:bg-[#0a1e52] motion-reduce:transition-none"
            >
              <GlobeIcon className="h-3.5 w-3.5 shrink-0 text-cyan-200" />
              <span className="min-w-0 flex-1 truncate text-left text-[11px] sm:text-xs">
                {isMounted ? `${selectorCountryCode} - ${connectedCountryLabel}` : "Select Country"}
              </span>
              <ChevronDownIcon className="h-3.5 w-3.5 shrink-0 text-blue-200/80" />
            </button>

            {isLocationPickerOpen && (
              <div className="absolute right-0 top-[calc(100%+8px)] z-50 w-[min(90vw,320px)] rounded-3xl border border-blue-300/20 bg-[#040c26]/95 p-3 shadow-[0_30px_80px_rgba(0,0,0,0.7)] backdrop-blur-sm">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-white">Global Location Selector</p>
                  <button
                    type="button"
                    onClick={() => setIsLocationPickerOpen(false)}
                    className="inline-flex min-h-8 touch-manipulation items-center rounded-full border border-slate-500/40 bg-slate-700/20 px-3 py-1 text-xs font-semibold text-slate-200 transition-colors duration-200 active:bg-slate-700/40"
                  >
                    Close
                  </button>
                </div>

                <div className="mt-3 space-y-3">
                  <div>
                    <p className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.18em] text-blue-200/70">Country</p>
                    <input
                      type="text"
                      value={countrySearchQuery}
                      onChange={(event) => setCountrySearchQuery(event.target.value)}
                      placeholder="Search country..."
                      className="mb-1.5 h-9 w-full rounded-xl border border-blue-300/20 bg-[#071535] px-3 text-xs text-slate-100 placeholder:text-slate-400/80 outline-none focus:border-cyan-300/45"
                    />
                    <div className="max-h-36 overflow-y-auto rounded-2xl border border-blue-300/20 bg-[#071535] p-1">
                      {isLoadingLocationOptions && (
                        <p className="px-3 py-2 text-xs text-slate-300">Loading countries...</p>
                      )}
                      {!isLoadingLocationOptions &&
                        filteredCountries.map((country) => {
                        const isSelected = selectedCountryCode === country.country_code;
                        return (
                          <button
                            key={country.country_code}
                            type="button"
                            onClick={() => {
                              setSelectedCountryCode(country.country_code);
                              setSelectedCountryName(country.country_name);
                            }}
                            className={`flex min-h-10 w-full touch-manipulation items-center rounded-xl px-3 py-2 text-left text-sm transition-colors duration-150 ${
                              isSelected ? "bg-cyan-500/25 text-cyan-100" : "text-slate-200 active:bg-slate-700/35"
                            }`}
                          >
                            {country.country_name}
                          </button>
                        );
                        })}
                      {!isLoadingLocationOptions && filteredCountries.length === 0 && (
                        <p className="px-3 py-2 text-xs text-slate-300">No countries found.</p>
                      )}
                    </div>
                  </div>

                </div>

                <button
                  type="button"
                  onClick={() => {
                    void applySelectedLocation();
                  }}
                  disabled={isChangingLocation || !selectedCountryCode}
                  className="mt-3 inline-flex min-h-11 w-full touch-manipulation items-center justify-center gap-2 rounded-2xl border border-cyan-300/40 bg-gradient-to-r from-cyan-500/30 to-blue-500/30 px-4 py-2.5 text-sm font-semibold text-cyan-100 transition-colors duration-200 active:from-cyan-500/45 active:to-blue-500/45 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <GlobeIcon className="h-4 w-4" />
                  {isChangingLocation ? "Updating..." : "Connect To Location"}
                </button>
              </div>
            )}
          </div>
        </header>

        {isMounted && (
          <div className="flex items-center gap-2 rounded-2xl border border-blue-300/10 bg-[#061331]/75 px-3 py-2 text-xs">
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-emerald-400 shadow-[0_0_14px_rgba(52,211,153,0.95)]" />
            <span className="text-slate-300">
              Connected to Server:{" "}
              <span className="font-semibold text-cyan-300">
                {connectedCountryLabel}
              </span>
            </span>
          </div>
        )}

        <div className="rounded-3xl border border-blue-300/15 bg-[#041331]/80 p-3 shadow-[inset_0_1px_0_rgba(160,210,255,0.08)] backdrop-blur">
          <div className="flex items-center gap-3">
            <div className="relative h-20 w-20 shrink-0 sm:h-24 sm:w-24">
              <div className="absolute -inset-1 rounded-full bg-[conic-gradient(from_120deg,rgba(34,211,238,0.65),rgba(59,130,246,0.9),rgba(14,165,233,0.6),rgba(34,211,238,0.65))] blur-[2px]" />
              <div className="absolute -inset-0.5 rounded-full border border-cyan-300/65 shadow-[0_0_18px_rgba(34,211,238,0.55)]" />
              <div className="relative h-full w-full overflow-hidden rounded-full border border-slate-700/70 bg-slate-900">
                {isMounted && hasUnlockedProfilePhoto(user?.profile_image_url) ? (
                  <Image
                    src={user?.profile_image_url || ""}
                    alt={user?.name || "Profile"}
                    fill
                    sizes="96px"
                    className="object-cover"
                  />
                ) : (
                  <ProfileFallback />
                )}
              </div>
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-[29px] font-bold leading-none text-white sm:text-[31px]">
                {user?.name || "Loading..."}
              </h2>
              <p className="mt-1 truncate text-xs text-slate-300 sm:text-sm">
                {user?.email || ""}
              </p>
              <div className="mt-2 inline-flex max-w-full items-center gap-1.5 rounded-full border border-blue-300/15 bg-[#0a1f47]/75 px-2.5 py-1 text-[11px] text-slate-300 sm:text-xs">
                <GamepadIcon className="h-3.5 w-3.5 shrink-0 text-slate-200" />
                <span className="truncate">Rounds Played:</span>
                <span className="font-semibold text-cyan-300">{user?.rounds_played ?? 0}</span>
              </div>
            </div>
            <ChevronRightIcon className="h-5 w-5 shrink-0 text-slate-400" />
          </div>
        </div>

        {error && <p className="rounded-2xl border border-red-300/30 bg-red-500/15 px-3 py-2 text-sm text-red-100">{error}</p>}

        <div className="rounded-3xl border border-blue-300/15 bg-[#03112d]/80 p-3 shadow-[inset_0_1px_0_rgba(180,220,255,0.06)]">
          <div className="mb-3 flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-blue-500/20 text-cyan-300">
              <BoltIcon className="h-3.5 w-3.5" />
            </span>
            <p className="text-sm font-semibold text-slate-100">Live Activity Feed</p>
          </div>

          {shouldShowPaywall ? (
            <div className="relative overflow-hidden rounded-2xl border border-blue-300/30 bg-[linear-gradient(160deg,rgba(14,8,40,0.98)_0%,rgba(4,14,46,0.95)_52%,rgba(16,8,40,0.98)_100%)] p-4 shadow-[0_0_0_1px_rgba(72,142,255,0.3),0_18px_45px_rgba(0,0,0,0.55)]">
              <div className="pointer-events-none absolute -left-6 -top-8 h-36 w-36 rounded-full bg-fuchsia-500/30 blur-3xl" />
              <div className="pointer-events-none absolute -right-8 top-8 h-36 w-36 rounded-full bg-blue-500/35 blur-3xl" />
              <div className="pointer-events-none absolute left-[48%] top-[28%] h-24 w-24 -translate-x-1/2 rounded-full bg-cyan-400/25 blur-2xl" />

              <div className="pointer-events-none absolute left-2 top-1 z-20 h-14 w-14 drop-shadow-[0_10px_18px_rgba(251,191,36,0.4)]">
                <PremiumLiveFeedModel
                  className="h-full w-full"
                  modelPath="/models/premium-rings.glb"
                  motion="yaw"
                  material="gold"
                  scale={1.06}
                  baseRotation={[0.12, 0.18, -0.08]}
                  interlockedPair
                  fallback={<RingsIcon className="h-full w-full opacity-95" />}
                />
              </div>
              <div className="pointer-events-none absolute bottom-14 left-3 z-30 h-12 w-12 drop-shadow-[0_10px_16px_rgba(245,158,11,0.35)]">
                <PremiumLiveFeedModel
                  className="h-full w-full"
                  proceduralModel="gold-lips-premium"
                  motion="roll"
                  material="gold"
                  scale={0.98}
                  baseRotation={[0.05, -0.32, -0.18]}
                  fallback={<LipsIcon className="h-full w-full opacity-95" />}
                />
              </div>
              <div className="pointer-events-none absolute right-2 top-4 z-30 h-[70px] w-[70px] drop-shadow-[0_10px_20px_rgba(150,120,255,0.45)]">
                <PremiumLiveFeedModel
                  className="h-full w-full"
                  modelPath="/models/premium-skull.glb"
                  motion="pitch"
                  material="steel"
                  scale={1.02}
                  baseRotation={[-0.06, 0.27, 0]}
                  fallback={<SkullIcon className="h-full w-full opacity-95" />}
                />
              </div>

              <div className="relative mx-auto max-w-[240px] text-center">
                <p className="bg-gradient-to-r from-amber-200 via-orange-200 to-amber-400 bg-clip-text text-lg font-bold text-transparent">
                  Premium Live Feed
                </p>
                <p className="mt-2 text-sm leading-snug text-slate-200">
                  Unlock your Live Feed to see exactly who{" "}
                  <span className="font-semibold text-rose-300">Kissed</span>,{" "}
                  <span className="font-semibold text-emerald-300">Married</span>, or{" "}
                  <span className="font-semibold text-red-300">Killed</span> you!
                </p>
                {botFeedback?.paywall_message && botFeedback.paywall_message !== premiumFeedDescription && (
                  <p className="mt-2 text-[11px] text-slate-400">{botFeedback.paywall_message}</p>
                )}
              </div>

              <button
                type="button"
                onClick={() => setIsReferralModalOpen(true)}
                className="relative z-10 mt-4 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-cyan-400 via-sky-500 to-violet-500 px-4 py-3 text-sm font-semibold text-white shadow-[0_12px_30px_rgba(46,126,255,0.55)] transition hover:brightness-110"
              >
                <LockIcon className="h-4 w-4" />
                Unlock Now
              </button>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-lg border border-rose-400/35 bg-rose-500/15 px-2 py-1 text-xs font-semibold text-rose-100">
                  Kiss: {botFeedback?.kisses ?? 0}
                </span>
                <span className="rounded-lg border border-emerald-400/35 bg-emerald-500/15 px-2 py-1 text-xs font-semibold text-emerald-100">
                  Marry: {botFeedback?.marries ?? 0}
                </span>
                <span className="rounded-lg border border-red-400/35 bg-red-500/15 px-2 py-1 text-xs font-semibold text-red-100">
                  Kill: {botFeedback?.kills ?? 0}
                </span>
                <span className="ml-auto text-xs text-slate-300">Total reactions: {botFeedback?.total ?? 0}</span>
              </div>

              <div className="mt-3 space-y-2">
                {botFeedback?.recent?.length ? (
                  botFeedback.recent.map((entry, index) => (
                    <div
                      key={`${entry.actor_user_id}-${entry.target_user_id}-${entry.timestamp}-${index}`}
                      className={`rounded-xl border px-3 py-2 text-sm ${reactionStyle[entry.tip_glasa]}`}
                    >
                      {renderFeedEntry(entry)}
                    </div>
                  ))
                ) : (
                  <p className="rounded-xl border border-blue-300/15 bg-blue-500/5 px-3 py-2 text-xs text-slate-300">
                    No reactions yet. Keep checking back.
                  </p>
                )}
              </div>
            </>
          )}
        </div>

        <div className="rounded-2xl border border-blue-300/20 bg-[#061737]/75 p-1.5 shadow-[inset_0_1px_0_rgba(170,210,255,0.08)]">
          <div className="grid grid-cols-3 gap-1.5">
            <button
              type="button"
              onClick={() => handleModeSelection("classic")}
              aria-pressed={selectedMode === "classic"}
              className={`inline-flex min-h-10 w-full touch-manipulation items-center justify-center rounded-xl px-3 text-xs font-semibold uppercase tracking-wide transition-colors duration-200 ${
                selectedMode === "classic"
                  ? "border border-cyan-300/45 bg-gradient-to-r from-cyan-500/20 to-blue-500/30 text-cyan-100 shadow-[0_0_18px_rgba(56,189,248,0.25)]"
                  : "border border-blue-200/15 bg-[#071a40]/70 text-slate-300 active:bg-[#0a224f]"
              }`}
            >
              Classic
            </button>
            <button
              type="button"
              onClick={() => handleModeSelection("vip")}
              aria-pressed={selectedMode === "vip"}
              className={`inline-flex min-h-10 w-full touch-manipulation items-center justify-center gap-1.5 rounded-xl px-3 text-xs font-semibold uppercase tracking-wide transition-colors duration-200 ${
                selectedMode === "vip"
                  ? "border border-fuchsia-300/55 bg-gradient-to-r from-fuchsia-500/25 to-pink-500/35 text-fuchsia-100 shadow-[0_0_20px_rgba(236,72,153,0.3)]"
                  : "border border-blue-200/15 bg-[#071a40]/70 text-slate-300 active:bg-[#0a224f]"
              }`}
            >
              <CrownIcon className={`h-3.5 w-3.5 ${selectedMode === "vip" ? "text-fuchsia-200" : "text-violet-200/80"}`} />
              VIP Edition
            </button>
            <button
              type="button"
              onClick={() => handleModeSelection("live")}
              aria-pressed={selectedMode === "live"}
              className={`inline-flex min-h-10 w-full touch-manipulation items-center justify-center gap-1.5 rounded-xl px-2 text-[11px] font-semibold uppercase tracking-wide transition-colors duration-200 ${
                selectedMode === "live"
                  ? "border border-emerald-300/55 bg-gradient-to-r from-emerald-500/25 to-cyan-500/35 text-emerald-100 shadow-[0_0_20px_rgba(16,185,129,0.3)]"
                  : "border border-blue-200/15 bg-[#071a40]/70 text-slate-300 active:bg-[#0a224f]"
              }`}
            >
              <LiveSignalIcon className={`h-3.5 w-3.5 ${selectedMode === "live" ? "text-emerald-200" : "text-cyan-200/80"}`} />
              Live Mode
            </button>
          </div>
          <p className="mt-1.5 px-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-300">
            Active Mode: {selectedMode === "vip" ? "VIP Edition" : selectedMode === "live" ? "Live Mode" : "Classic"}
          </p>
        </div>

        {playLocked ? (
          <Link
            href="/settings"
            className="relative flex h-14 w-full max-w-full touch-manipulation items-center justify-center gap-2 overflow-hidden rounded-2xl border border-amber-300/45 bg-gradient-to-r from-amber-500/30 to-orange-500/30 px-4 text-sm font-semibold uppercase tracking-wide text-amber-100 transition-colors duration-200 active:from-amber-500/40 active:to-orange-500/40 motion-reduce:transition-none"
          >
            <LockIcon className="h-4 w-4" />
            Upload Photo To Unlock Play
          </Link>
        ) : (
          <button
            type="button"
            onClick={startPlay}
            disabled={isStartingPlay || !session}
            className="relative h-14 w-full max-w-full touch-manipulation overflow-hidden rounded-2xl border border-blue-300/45 bg-[radial-gradient(75%_95%_at_0%_0%,rgba(76,151,255,0.42),transparent_70%),radial-gradient(95%_120%_at_100%_100%,rgba(34,211,238,0.25),transparent_72%),linear-gradient(92deg,#0f44b8_0%,#1261e2_45%,#1b8dfd_100%)] px-4 text-sm font-semibold uppercase tracking-[0.12em] text-white shadow-[0_14px_34px_rgba(24,110,255,0.45)] transition-colors duration-200 active:brightness-110 motion-reduce:transition-none disabled:cursor-not-allowed disabled:opacity-60"
          >
            <span className="relative flex min-w-[168px] items-center justify-center gap-2 whitespace-nowrap">
              <PlayIcon className="h-5 w-5" />
              {isStartingPlay ? "Opening Round..." : "Play"}
            </span>
          </button>
        )}

        <div className="space-y-2.5">
          <Link
            href="/leaderboard"
            className="flex h-[52px] w-full max-w-full touch-manipulation items-center rounded-2xl border border-blue-300/15 bg-[#061737]/85 px-3.5 py-3 text-sm font-semibold uppercase tracking-wide text-slate-100 transition-colors duration-200 active:bg-[#0a234a] motion-reduce:transition-none"
          >
            <span className="mr-3 flex h-8 w-8 items-center justify-center rounded-lg bg-violet-500/20 text-violet-300">
              <TrophyIcon className="h-[18px] w-[18px]" />
            </span>
            <span className="flex-1">Leaderboard</span>
            <ChevronRightIcon className="h-5 w-5 text-slate-400" />
          </Link>
          <Link
            href="/settings"
            className="flex h-[52px] w-full max-w-full touch-manipulation items-center rounded-2xl border border-blue-300/15 bg-[#061737]/85 px-3.5 py-3 text-sm font-semibold uppercase tracking-wide text-slate-100 transition-colors duration-200 active:bg-[#0a234a] motion-reduce:transition-none"
          >
            <span className="mr-3 flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/20 text-emerald-300">
              <SettingsIcon className="h-[18px] w-[18px]" />
            </span>
            <span className="flex-1">Settings</span>
            <ChevronRightIcon className="h-5 w-5 text-slate-400" />
          </Link>
          {shouldShowAdminPanel && (
            <Link
              href="/admin/dashboard"
              className="flex h-[52px] w-full max-w-full touch-manipulation items-center rounded-2xl border border-cyan-300/25 bg-[linear-gradient(92deg,rgba(6,23,55,0.92)_0%,rgba(8,34,67,0.9)_100%)] px-3.5 py-3 text-sm font-semibold uppercase tracking-wide text-cyan-100 shadow-[inset_0_1px_0_rgba(180,220,255,0.08),0_0_20px_rgba(34,211,238,0.08)] transition-colors duration-200 active:bg-[#0a234a] motion-reduce:transition-none"
            >
              <span className="mr-3 flex h-8 w-8 items-center justify-center rounded-lg border border-cyan-300/25 bg-cyan-500/15 text-cyan-200">
                <ShieldIcon className="h-[18px] w-[18px]" />
              </span>
              <span className="flex-1">Admin Panel</span>
              <ChevronRightIcon className="h-5 w-5 text-cyan-200/70" />
            </Link>
          )}
        </div>

        <div className="flex items-center gap-3 rounded-2xl border border-blue-300/15 bg-[#041632]/80 px-3 py-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-cyan-300/30 bg-cyan-500/10 text-cyan-300">
            <GlobeIcon className="h-6 w-6" />
          </span>
          <p className="text-xs leading-relaxed text-slate-300">
            Live feed and matchmaking are now bound to your selected country server.
          </p>
        </div>
      </section>
      <ReferralUnlockModal
        isOpen={isReferralModalOpen}
        onClose={() => setIsReferralModalOpen(false)}
        referralCount={referralCount}
        referralTarget={referralTarget}
        referralLink={referralLink}
      />
    </main>
  );
}
