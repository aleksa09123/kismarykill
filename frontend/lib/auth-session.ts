import type { AuthResponse, AuthUser } from "@/lib/types";
import { getSupabaseAuthSession } from "@/lib/supabase";
import { safeClearStorage, safeGetStorageItem, safeRemoveStorageItem, safeSetStorageItem } from "@/lib/safe-storage";

export const AUTH_STORAGE_KEY = "kmk_auth_session";

const PLACEHOLDER_TOKENS = ["placeholder", "default-avatar", "/default-avatar", "avatar-default"];
const KNOWN_AUTH_COOKIE_NAMES = [
  AUTH_STORAGE_KEY,
  "access_token",
  "auth_token",
  "token",
  "refresh_token",
  "sb-access-token",
  "sb-refresh-token",
  "supabase-auth-token"
];
const AUTH_COOKIE_NAME_MARKERS = ["auth", "token", "session", "supabase", "sb-"];
const AUTH_SESSION_SCHEMA_VERSION = 2;
let sessionMemoryCache: AuthResponse | null | undefined;
let ongoingSilentRecovery: Promise<boolean> | null = null;
let hardResetInProgress = false;

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeGender(value: unknown): AuthUser["gender"] {
  const normalized = normalizeString(value).toLowerCase();
  return normalized === "female" ? "female" : "male";
}

function normalizePreferredGender(value: unknown): AuthUser["preferred_gender"] {
  const normalized = normalizeString(value).toLowerCase();
  if (normalized === "male" || normalized === "female" || normalized === "both") {
    return normalized;
  }
  return "both";
}

function normalizeAuthUser(value: unknown): AuthUser | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const raw = value as Record<string, unknown>;
  const id = Number(raw.id ?? raw.user_id ?? raw.userId);
  if (!Number.isFinite(id) || id <= 0) {
    return null;
  }

  const email = normalizeString(raw.email);
  const fallbackName = email ? email.split("@", 1)[0] : "Player";
  const name = normalizeString(raw.name ?? raw.ime ?? raw.username) || fallbackName || "Player";
  const countryCode = normalizeString(raw.country_code ?? raw.country ?? raw.countryCode).toUpperCase();
  const countryName = normalizeString(raw.country_name ?? raw.countryName);
  const roundsPlayed = Number(raw.rounds_played ?? raw.roundsPlayed ?? 0);

  return {
    ...(raw as Partial<AuthUser>),
    id,
    email,
    name,
    username: normalizeString(raw.username) || name,
    country_code: countryCode || null,
    country_name: countryName || null,
    gender: normalizeGender(raw.gender ?? raw.pol),
    preferred_gender: normalizePreferredGender(raw.preferred_gender ?? raw.preferredGender),
    profile_image_url: normalizeString(raw.profile_image_url ?? raw.profileImageUrl ?? raw.slika_url) || null,
    rounds_played: Number.isFinite(roundsPlayed) ? Math.max(0, roundsPlayed) : 0
  };
}

function parseStoredSession(raw: string): AuthResponse | null {
  try {
    const parsed = JSON.parse(raw) as Partial<AuthResponse> & Record<string, unknown>;
    const accessToken = normalizeString(parsed.access_token ?? parsed.accessToken ?? parsed.token);
    const user = normalizeAuthUser(parsed.user);
    if (!accessToken || !user) {
      return null;
    }
    return {
      ...(parsed as Partial<AuthResponse>),
      access_token: accessToken,
      token_type: "bearer",
      user
    };
  } catch {
    return null;
  }
}

function expireCookie(name: string): void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return;
  }

  const cleanedName = name.trim();
  if (!cleanedName) {
    return;
  }

  const expires = "Thu, 01 Jan 1970 00:00:00 GMT";
  const hostname = window.location.hostname;
  const domains = new Set<string>([""]);

  if (hostname && hostname !== "localhost") {
    domains.add(hostname);
    domains.add(`.${hostname}`);
  }

  domains.forEach((domain) => {
    const domainPart = domain ? `; domain=${domain}` : "";
    document.cookie = `${cleanedName}=; expires=${expires}; Max-Age=0; path=/${domainPart}; SameSite=Lax`;
  });
}

function clearAuthCookies(): void {
  if (typeof document === "undefined") {
    return;
  }

  const cookieNames = new Set<string>(KNOWN_AUTH_COOKIE_NAMES);
  document.cookie.split(";").forEach((cookie) => {
    const name = cookie.split("=")[0]?.trim();
    if (!name) {
      return;
    }

    const normalizedName = name.toLowerCase();
    if (AUTH_COOKIE_NAME_MARKERS.some((marker) => normalizedName.includes(marker))) {
      cookieNames.add(name);
    }
  });

  cookieNames.forEach(expireCookie);
}

function clearAuthPersistence(options: { clearAllStorage?: boolean } = {}): void {
  sessionMemoryCache = null;
  if (typeof window === "undefined") {
    return;
  }

  if (options.clearAllStorage) {
    safeClearStorage("local");
    safeClearStorage("session");
  }

  safeRemoveStorageItem(AUTH_STORAGE_KEY);
  clearAuthCookies();
}

export function readSession(): AuthResponse | null {
  if (sessionMemoryCache !== undefined) {
    return sessionMemoryCache;
  }

  if (typeof window === "undefined") {
    sessionMemoryCache = null;
    return sessionMemoryCache;
  }

  const raw = safeGetStorageItem(AUTH_STORAGE_KEY);
  if (!raw) {
    sessionMemoryCache = null;
    return null;
  }

  const parsed = parseStoredSession(raw);
  if (!parsed) {
    sessionMemoryCache = null;
    return null;
  }

  sessionMemoryCache = parsed;
  safeSetStorageItem(
    AUTH_STORAGE_KEY,
    JSON.stringify({ ...parsed, schema_version: AUTH_SESSION_SCHEMA_VERSION })
  );
  return parsed;
}

export function writeSession(session: AuthResponse): void {
  const normalizedSession = parseStoredSession(JSON.stringify(session)) ?? session;
  sessionMemoryCache = normalizedSession;
  if (typeof window === "undefined") {
    return;
  }
  safeSetStorageItem(
    AUTH_STORAGE_KEY,
    JSON.stringify({ ...normalizedSession, schema_version: AUTH_SESSION_SCHEMA_VERSION })
  );
}

export function clearSession(): void {
  clearAuthPersistence();
}

export function hardResetAuthStateAndRedirectToLogin(): void {
  if (typeof window === "undefined") {
    sessionMemoryCache = null;
    return;
  }
  if (hardResetInProgress) {
    return;
  }

  hardResetInProgress = true;
  clearAuthPersistence({ clearAllStorage: true });

  if (window.location.pathname !== "/login") {
    window.location.replace("/login");
  }
}

export function hardResetAuthStateAndReload(): void {
  hardResetAuthStateAndRedirectToLogin();
}

export function patchSessionUser(nextUser: AuthUser): AuthResponse | null {
  const current = readSession();
  if (!current) {
    return null;
  }

  const updated: AuthResponse = {
    ...current,
    user: nextUser
  };
  writeSession(updated);
  return updated;
}

export function refreshSessionFromStorage(): AuthResponse | null {
  sessionMemoryCache = undefined;
  return readSession();
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const payload = token.split(".")[1];
  if (!payload) {
    return null;
  }

  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    return JSON.parse(globalThis.atob(padded)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function getAccessTokenExpiresAtMs(token: string | null | undefined): number | null {
  const payload = token ? decodeJwtPayload(token) : null;
  const exp = payload?.exp;
  const expSeconds = typeof exp === "number" ? exp : Number.parseInt(String(exp ?? ""), 10);
  if (!Number.isFinite(expSeconds) || expSeconds <= 0) {
    return null;
  }
  return expSeconds * 1000;
}

export function isAccessTokenExpired(token: string | null | undefined, leewaySeconds = 60): boolean {
  const expiresAtMs = getAccessTokenExpiresAtMs(token);
  if (expiresAtMs === null) {
    return true;
  }
  return expiresAtMs <= Date.now() + leewaySeconds * 1000;
}

export async function recoverSessionSilently(): Promise<boolean> {
  if (typeof window === "undefined") {
    return false;
  }

  if (ongoingSilentRecovery) {
    return ongoingSilentRecovery;
  }

  ongoingSilentRecovery = (async () => {
    try {
      await getSupabaseAuthSession();
    } catch {
      // Best-effort recovery: if Supabase auth is unavailable, keep local session untouched.
    }

    const refreshed = refreshSessionFromStorage();
    return Boolean(refreshed?.access_token);
  })();

  try {
    return await ongoingSilentRecovery;
  } finally {
    ongoingSilentRecovery = null;
  }
}

export function hasUnlockedProfilePhoto(url: string | null | undefined): boolean {
  if (!url) {
    return false;
  }

  const cleaned = url.trim().toLowerCase();
  if (!cleaned) {
    return false;
  }

  return !PLACEHOLDER_TOKENS.some((token) => cleaned.includes(token));
}
