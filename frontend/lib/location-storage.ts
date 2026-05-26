"use client";

import { safeGetStorageItem, safeSetStorageItem } from "@/lib/safe-storage";
import type { AuthUser, LocationOptionCountry, LocationSelectionResponse } from "@/lib/types";

export const LOCATION_SELECTION_STORAGE_KEY = "kmk_selected_location_v1";
export const GLOBAL_LOCATION_OPTION: LocationOptionCountry = {
  country_code: "GL",
  country_name: "Global"
};

function normalizeCountryCode(value: unknown): string {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

function normalizeCountryName(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function buildServerId(countryCode: string): string {
  return countryCode.toLowerCase();
}

function buildLocationFromPartial(value: Partial<LocationSelectionResponse>): LocationSelectionResponse | null {
  const countryCode = normalizeCountryCode(value.country_code);
  if (!countryCode) {
    return null;
  }

  const countryName = normalizeCountryName(value.country_name) || countryCode;
  return {
    country_code: countryCode,
    country_name: countryName,
    latitude: Number(value.latitude ?? 0),
    longitude: Number(value.longitude ?? 0),
    server_id:
      typeof value.server_id === "string" && value.server_id.trim().length > 0
        ? value.server_id.trim()
        : buildServerId(countryCode)
  };
}

export function readLocationCookieClient(): LocationSelectionResponse | null {
  if (typeof document === "undefined") {
    return null;
  }

  const cookieName = "user_location=";
  const item = document.cookie.split("; ").find((chunk) => chunk.startsWith(cookieName));
  if (!item) {
    return null;
  }

  try {
    const rawValue = item.slice(cookieName.length);
    const parsed = JSON.parse(decodeURIComponent(rawValue)) as Partial<LocationSelectionResponse>;
    return buildLocationFromPartial(parsed);
  } catch {
    return null;
  }
}

export function readPersistedLocationClient(): LocationSelectionResponse | null {
  if (typeof window === "undefined") {
    return null;
  }

  const raw = safeGetStorageItem(LOCATION_SELECTION_STORAGE_KEY);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<LocationSelectionResponse>;
    return buildLocationFromPartial(parsed);
  } catch {
    return null;
  }
}

export function persistLocationClient(location: LocationSelectionResponse): void {
  if (typeof window === "undefined") {
    return;
  }
  safeSetStorageItem(LOCATION_SELECTION_STORAGE_KEY, JSON.stringify(location));
}

export function readInitialLocationClient(): LocationSelectionResponse | null {
  return readPersistedLocationClient() ?? readLocationCookieClient();
}

export function locationFromUser(user: AuthUser | null): LocationSelectionResponse | null {
  if (!user) {
    return null;
  }

  return buildLocationFromPartial({
    country_code: user.country_code ?? undefined,
    country_name: user.country_name ?? undefined,
    latitude: 0,
    longitude: 0,
    server_id: user.country_code ? buildServerId(user.country_code) : undefined
  });
}

export function isGlobalCountryCode(countryCode: string | null | undefined): boolean {
  return normalizeCountryCode(countryCode) === GLOBAL_LOCATION_OPTION.country_code;
}

export function mergeLocationLabel(
  countryCode: string | null | undefined,
  preferredName?: string | null,
  fallbackName?: string | null
): LocationSelectionResponse | null {
  const normalizedCode = normalizeCountryCode(countryCode);
  if (!normalizedCode) {
    return null;
  }

  return buildLocationFromPartial({
    country_code: normalizedCode,
    country_name: normalizeCountryName(preferredName) || normalizeCountryName(fallbackName) || normalizedCode,
    latitude: 0,
    longitude: 0,
    server_id: buildServerId(normalizedCode)
  });
}
