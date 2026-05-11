"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { fetchCurrentUser, fetchRound, fetchZoneDebug, uploadProfilePicture } from "@/lib/api";
import { clearSession, patchSessionUser, readSession, hasUnlockedProfilePhoto } from "@/lib/auth-session";
import type { AuthResponse, AuthUser } from "@/lib/types";

const FACE_NOT_DETECTED_MESSAGE = "Face not detected! Please upload a clear photo of your face to unlock PLAY.";
const LAST_LOCATION_STORAGE_KEY = "kmk_last_location";
const LAST_ZONE_ID_STORAGE_KEY = "kmk_last_zone_id";

type Coordinates = {
  latitude: number;
  longitude: number;
};

type LocationPermission = "unknown" | "prompt" | "granted" | "denied" | "unsupported";

function readStoredLocation(): Coordinates | null {
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

function MenuCard({
  title,
  subtitle,
  href,
  onClick,
  disabled = false,
  locked = false,
  glow = false
}: {
  title: string;
  subtitle: string;
  href?: string;
  onClick?: () => void;
  disabled?: boolean;
  locked?: boolean;
  glow?: boolean;
}) {
  const className = `group min-h-28 rounded-2xl border px-4 py-4 text-left backdrop-blur transition duration-200 hover:-translate-y-0.5 ${
    locked
      ? "animate-pulse border-orange-400/60 bg-orange-500/15 shadow-[0_0_30px_rgba(251,146,60,0.25)]"
      : glow
        ? "border-cyan-300/40 bg-cyan-400/10 shadow-[0_0_20px_rgba(56,189,248,0.2)]"
        : "border-slate-600/40 bg-slate-900/45"
  }`;

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className={`${className} disabled:cursor-not-allowed disabled:opacity-70`}
      >
        <p className="text-base font-semibold text-white">{title}</p>
        <p className="mt-2 text-sm text-slate-300 group-hover:text-slate-100">{subtitle}</p>
      </button>
    );
  }

  return (
    <Link
      href={href || "/dashboard"}
      className={className}
    >
      <p className="text-base font-semibold text-white">{title}</p>
      <p className="mt-2 text-sm text-slate-300 group-hover:text-slate-100">{subtitle}</p>
    </Link>
  );
}

export default function DashboardPage() {
  const router = useRouter();
  const [session, setSession] = useState<AuthResponse | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isUploadingPhoto, setIsUploadingPhoto] = useState(false);
  const [isStartingPlay, setIsStartingPlay] = useState(false);
  const [uploadMessage, setUploadMessage] = useState<string | null>(null);
  const [locationStatus, setLocationStatus] = useState<string | null>(null);
  const [currentLocation, setCurrentLocation] = useState<Coordinates | null>(null);
  const [locationPermission, setLocationPermission] = useState<LocationPermission>("unknown");
  const [isRequestingLocation, setIsRequestingLocation] = useState(false);
  const [zoneId, setZoneId] = useState<string | null>(null);
  const [nearestDistanceKm, setNearestDistanceKm] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastSyncedLocationRef = useRef<string | null>(null);

  useEffect(() => {
    const nextSession = readSession();
    if (!nextSession) {
      router.replace("/login");
      return;
    }

    setSession(nextSession);
    setUser(nextSession.user);

    const loadCurrentUser = async () => {
      try {
        const nextUser = await fetchCurrentUser(nextSession.access_token);
        setUser(nextUser);
        patchSessionUser(nextUser);
      } catch (loadError) {
        const message = loadError instanceof Error ? loadError.message : "Unable to load profile.";
        setError(message);
      } finally {
        setIsLoading(false);
      }
    };

    void loadCurrentUser();
  }, [router]);

  const playLocked = useMemo(
    () => !hasUnlockedProfilePhoto(user?.profile_image_url) || !user?.face_verified,
    [user?.face_verified, user?.profile_image_url]
  );

  const logout = () => {
    clearSession();
    router.replace("/login");
  };

  const syncZoneDebug = useCallback(
    async (coords?: Coordinates) => {
      if (!session) {
        return;
      }
      try {
        const debug = await fetchZoneDebug(session.access_token, coords);
        setZoneId(debug.zone_id);
        setNearestDistanceKm(debug.nearest_profiles[0]?.distance_km ?? null);
        if (typeof window !== "undefined") {
          window.localStorage.setItem(LAST_ZONE_ID_STORAGE_KEY, debug.zone_id);
        }
      } catch {
        // Keep dashboard usable even if debug endpoint fails temporarily.
      }
    },
    [session]
  );

  const persistLocation = useCallback((coords: Coordinates) => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(LAST_LOCATION_STORAGE_KEY, JSON.stringify(coords));
    }
    setCurrentLocation(coords);
    setLocationPermission("granted");
    setLocationStatus("Location access enabled. Geo-Room server will auto-select.");
  }, []);

  const requestLocation = useCallback(async (): Promise<Coordinates | null> => {
    if (typeof window === "undefined" || !navigator.geolocation) {
      setLocationPermission("unsupported");
      setLocationStatus("Geolocation is not available on this device/browser.");
      return null;
    }

    setIsRequestingLocation(true);
    return new Promise<Coordinates | null>((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          const coords = {
            latitude: position.coords.latitude,
            longitude: position.coords.longitude
          };
          persistLocation(coords);
          resolve(coords);
        },
        (geoError) => {
          if (geoError.code === geoError.PERMISSION_DENIED) {
            setLocationPermission("denied");
            setLocationStatus("Location permission denied. Tap ENABLE to allow access and start nearby matching.");
          } else {
            setLocationPermission("prompt");
            setLocationStatus("Could not read your location yet. Tap ENABLE to try again.");
          }
          resolve(null);
        },
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 10000 }
      );
    }).finally(() => setIsRequestingLocation(false));
  }, [persistLocation]);

  useEffect(() => {
    const storedLocation = readStoredLocation();
    if (storedLocation) {
      setCurrentLocation(storedLocation);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || !navigator.geolocation) {
      setLocationPermission("unsupported");
      setLocationStatus("Geolocation is not available on this device/browser.");
      return;
    }

    if (!navigator.permissions?.query) {
      setLocationPermission((previous) => (previous === "granted" ? previous : "unknown"));
      return;
    }

    let isMounted = true;
    let permissionStatusRef: PermissionStatus | null = null;

    const applyPermission = (state: PermissionState) => {
      if (!isMounted) {
        return;
      }
      if (state === "granted") {
        setLocationPermission("granted");
      } else if (state === "denied") {
        setLocationPermission("denied");
      } else {
        setLocationPermission("prompt");
      }
    };

    void navigator.permissions
      .query({ name: "geolocation" })
      .then((permissionStatus) => {
        permissionStatusRef = permissionStatus;
        applyPermission(permissionStatus.state);
        permissionStatus.onchange = () => applyPermission(permissionStatus.state);
      })
      .catch(() => {
        if (isMounted) {
          setLocationPermission((previous) => (previous === "granted" ? previous : "unknown"));
        }
      });

    return () => {
      isMounted = false;
      if (permissionStatusRef) {
        permissionStatusRef.onchange = null;
      }
    };
  }, []);

  useEffect(() => {
    void requestLocation();
  }, [requestLocation]);

  useEffect(() => {
    if (!session) {
      return;
    }

    if (!currentLocation) {
      void syncZoneDebug();
      return;
    }

    const syncKey = `${currentLocation.latitude.toFixed(6)},${currentLocation.longitude.toFixed(6)}`;
    if (syncKey === lastSyncedLocationRef.current) {
      return;
    }

    lastSyncedLocationRef.current = syncKey;
    void syncZoneDebug(currentLocation);
  }, [currentLocation, session, syncZoneDebug]);

  useEffect(() => {
    if (typeof window === "undefined" || !navigator.geolocation || locationPermission !== "granted") {
      return;
    }

    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        persistLocation({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude
        });
      },
      () => {
        // Keep previous successful coordinates and zone debug values.
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 10000 }
    );

    return () => navigator.geolocation.clearWatch(watchId);
  }, [locationPermission, persistLocation]);

  const startPlay = async () => {
    if (!session || playLocked) {
      return;
    }

    setError(null);
    setIsStartingPlay(true);

    try {
      const promptedCoords = await requestLocation();
      const coords = promptedCoords ?? currentLocation ?? readStoredLocation();
      if (!coords) {
        throw new Error("Location is required to start matchmaking. Please enable location access and try again.");
      }

      window.localStorage.setItem(LAST_LOCATION_STORAGE_KEY, JSON.stringify(coords));
      setCurrentLocation(coords);
      await syncZoneDebug(coords);

      const round = await fetchRound({ location: coords }, session.access_token);
      setZoneId(round.zone_id);
      window.localStorage.setItem(LAST_ZONE_ID_STORAGE_KEY, round.zone_id);

      router.push("/play");
    } catch (startError) {
      const message = startError instanceof Error ? startError.message : "Could not start matchmaking.";
      setError(message);
      if (typeof window !== "undefined" && typeof window.alert === "function") {
        window.alert(message);
      }
    } finally {
      setIsStartingPlay(false);
    }
  };

  const showLocationModal = locationPermission !== "granted" && locationPermission !== "unsupported";

  const handleProfilePhotoUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const selectedFile = event.target.files?.[0];
    event.target.value = "";

    if (!selectedFile || !session) {
      return;
    }

    setError(null);
    setUploadMessage(null);
    setIsUploadingPhoto(true);

    try {
      const updatedUser = await uploadProfilePicture(selectedFile, session.access_token);
      setUser(updatedUser);
      patchSessionUser(updatedUser);
      setUploadMessage("Profile photo uploaded. PLAY is now unlocked.");
    } catch (uploadError) {
      const message = uploadError instanceof Error ? uploadError.message : "Could not upload profile photo.";
      if (message === FACE_NOT_DETECTED_MESSAGE && typeof window !== "undefined" && typeof window.alert === "function") {
        window.alert(message);
      }
      setError(message);
    } finally {
      setIsUploadingPhoto(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md items-start px-3 py-4 md:justify-center md:py-8">
      {showLocationModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 px-4">
          <div className="w-full max-w-sm rounded-2xl border-2 border-yellow-300 bg-slate-950 p-6 text-center shadow-[0_0_40px_rgba(234,179,8,0.35)]">
            <p className="text-xl font-extrabold uppercase tracking-wide text-white">Location Required</p>
            <p className="mt-3 text-base font-semibold text-yellow-200">
              To find people in your area, we need your location.
            </p>
            <button
              type="button"
              onClick={() => {
                void requestLocation();
              }}
              disabled={isRequestingLocation}
              className="mt-5 min-h-12 w-full rounded-xl border border-yellow-200 bg-yellow-300 px-4 text-lg font-black text-slate-950 transition hover:bg-yellow-200 disabled:cursor-not-allowed disabled:opacity-70"
            >
              {isRequestingLocation ? "ENABLING..." : "ENABLE"}
            </button>
            {locationPermission === "denied" && (
              <p className="mt-3 text-xs text-slate-300">If blocked, re-allow location in browser settings, then tap ENABLE.</p>
            )}
          </div>
        </div>
      )}
      <section
        className="w-full space-y-4 rounded-3xl border border-slate-700/50 bg-slate-950/65 p-4 shadow-2xl shadow-black/30 backdrop-blur-xl"
        style={{
          paddingTop: "max(env(safe-area-inset-top), 0.25rem)",
          paddingBottom: "max(env(safe-area-inset-bottom), 0.75rem)"
        }}
      >
        <header className="flex items-center justify-between">
          <p className="font-display text-3xl text-white">Dashboard</p>
          <button
            type="button"
            onClick={logout}
            className="min-h-11 min-w-11 rounded-xl border border-slate-500/70 bg-slate-800/70 px-3 text-sm font-semibold text-slate-100 transition hover:bg-slate-700/80"
          >
            Logout
          </button>
        </header>

        <div className="rounded-2xl border border-slate-700/60 bg-slate-900/55 p-4 backdrop-blur">
          <div className="flex items-center gap-4">
            <div className="relative h-24 w-24 overflow-hidden rounded-full border border-slate-600">
              {hasUnlockedProfilePhoto(user?.profile_image_url) ? (
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
            <div>
              <p className="text-xl font-semibold text-white">{user?.name || "Loading..."}</p>
              <p className="text-sm text-slate-300">{user?.email || ""}</p>
              <p className="mt-2 text-sm text-cyan-200">Rounds Played: {user?.rounds_played ?? 0}</p>
            </div>
          </div>
        </div>

        {error && <p className="rounded-xl bg-red-500/20 px-3 py-2 text-sm text-red-200">{error}</p>}
        {uploadMessage && <p className="rounded-xl bg-emerald-500/20 px-3 py-2 text-sm text-emerald-200">{uploadMessage}</p>}
        {locationStatus && <p className="rounded-xl bg-slate-800/70 px-3 py-2 text-sm text-slate-200">{locationStatus}</p>}
        {isLoading && <p className="rounded-xl bg-slate-800/70 px-3 py-2 text-sm text-slate-200">Loading profile...</p>}

        <label className="block rounded-2xl border border-slate-700/60 bg-slate-900/55 p-3">
          <span className="mb-2 block text-sm font-semibold text-slate-100">Upload Profile Photo</span>
          <input
            type="file"
            accept="image/*"
            onChange={handleProfilePhotoUpload}
            disabled={isUploadingPhoto || !session}
            className="block w-full text-sm text-slate-200 file:mr-3 file:rounded-lg file:border-0 file:bg-cyan-500/25 file:px-3 file:py-2 file:text-sm file:font-semibold file:text-cyan-100 hover:file:bg-cyan-500/35 disabled:opacity-60"
          />
          <p className="mt-2 text-xs text-slate-400">Photos are automatically resized for faster mobile loading.</p>
          {isUploadingPhoto && <p className="mt-2 text-xs text-cyan-200">Uploading and compressing image...</p>}
        </label>

        <div className="grid grid-cols-2 gap-3">
          {playLocked ? (
            <MenuCard
              title="UPLOAD PHOTO TO UNLOCK PLAY"
              subtitle="Your photo is required before entering rounds."
              href="/settings"
              locked
            />
          ) : (
            <MenuCard
              title="PLAY"
              subtitle={isStartingPlay ? "Computing your Geo-Room and loading nearby players..." : "Start swiping and vote this round."}
              onClick={() => {
                void startPlay();
              }}
              disabled={isStartingPlay || isLoading || !session}
              glow
            />
          )}

          <MenuCard title="LEADERBOARD" subtitle="See top-rated profiles." href="/leaderboard" />
          <MenuCard title="SETTINGS" subtitle="Update profile and preferences." href="/settings" />
        </div>

        <p className="text-xs text-slate-400">
          Your profile photo is the image other users see and rate during rounds.
        </p>
        <p className="text-[11px] text-slate-500">
          Zone: {zoneId ?? "unknown"} | Distance to nearest:{" "}
          {nearestDistanceKm !== null ? `${nearestDistanceKm.toFixed(2)} km` : "-- km"}
        </p>
      </section>
    </main>
  );
}
