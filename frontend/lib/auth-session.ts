import type { AuthResponse, AuthUser } from "@/lib/types";

export const AUTH_STORAGE_KEY = "kmk_auth_session";

const PLACEHOLDER_TOKENS = ["placeholder", "default-avatar", "/default-avatar", "avatar-default"];

export function readSession(): AuthResponse | null {
  if (typeof window === "undefined") {
    return null;
  }

  const raw = window.localStorage.getItem(AUTH_STORAGE_KEY);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as AuthResponse;
    if (!parsed.access_token || !parsed.user) {
      window.localStorage.removeItem(AUTH_STORAGE_KEY);
      return null;
    }
    return parsed;
  } catch {
    window.localStorage.removeItem(AUTH_STORAGE_KEY);
    return null;
  }
}

export function writeSession(session: AuthResponse): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(session));
}

export function clearSession(): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.removeItem(AUTH_STORAGE_KEY);
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
