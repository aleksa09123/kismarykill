export type GameMode = "classic" | "vip" | "live";

export const ACTIVE_GAME_MODE_STORAGE_KEY = "kmk_active_mode";
export const ACTIVE_GAME_MODE_UPDATED_EVENT = "kmk:active-game-mode-updated";

export function normalizeGameMode(value: string | null | undefined): GameMode {
  if (value === "vip" || value === "live") {
    return value;
  }
  return "classic";
}

export function readActiveGameMode(): GameMode {
  if (typeof window === "undefined") {
    return "classic";
  }
  return normalizeGameMode(window.localStorage.getItem(ACTIVE_GAME_MODE_STORAGE_KEY));
}

export function writeActiveGameMode(mode: GameMode): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(ACTIVE_GAME_MODE_STORAGE_KEY, mode);
  window.dispatchEvent(new CustomEvent<GameMode>(ACTIVE_GAME_MODE_UPDATED_EVENT, { detail: mode }));
}
