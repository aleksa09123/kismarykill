import { safeGetStorageItem, safeSetStorageItem } from "@/lib/safe-storage";

export type GameMode = "classic" | "vip" | "blind" | "live";

export const DEFAULT_GAME_MODE: GameMode = "blind";
export const ACTIVE_GAME_MODE_STORAGE_KEY = "kmk_active_mode";
export const ACTIVE_GAME_MODE_UPDATED_EVENT = "kmk:active-game-mode-updated";

export function parseGameMode(value: string | null | undefined): GameMode | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "classic" || normalized === "vip" || normalized === "blind" || normalized === "live") {
    return normalized;
  }
  return null;
}

export function normalizeGameMode(value: string | null | undefined, fallback: GameMode = DEFAULT_GAME_MODE): GameMode {
  return parseGameMode(value) ?? fallback;
}

export function readActiveGameMode(): GameMode {
  if (typeof window === "undefined") {
    return DEFAULT_GAME_MODE;
  }
  return normalizeGameMode(safeGetStorageItem(ACTIVE_GAME_MODE_STORAGE_KEY));
}

export function writeActiveGameMode(mode: GameMode): void {
  if (typeof window === "undefined") {
    return;
  }
  safeSetStorageItem(ACTIVE_GAME_MODE_STORAGE_KEY, mode);
  window.dispatchEvent(new CustomEvent<GameMode>(ACTIVE_GAME_MODE_UPDATED_EVENT, { detail: mode }));
}
