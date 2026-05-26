"use client";

type StorageArea = "local" | "session";

function getStorage(area: StorageArea): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return area === "local" ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

export function safeGetStorageItem(key: string, area: StorageArea = "local"): string | null {
  try {
    return getStorage(area)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function safeSetStorageItem(key: string, value: string, area: StorageArea = "local"): boolean {
  try {
    getStorage(area)?.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function safeRemoveStorageItem(key: string, area: StorageArea = "local"): void {
  try {
    getStorage(area)?.removeItem(key);
  } catch {
    // Storage can be unavailable in private browsing or after quota/security failures.
  }
}

export function safeClearStorage(area: StorageArea = "local"): void {
  try {
    getStorage(area)?.clear();
  } catch {
    // Best effort only.
  }
}

export function safeReadJson<T>(key: string, fallback: T, area: StorageArea = "local"): T {
  const raw = safeGetStorageItem(key, area);
  if (!raw) {
    return fallback;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
