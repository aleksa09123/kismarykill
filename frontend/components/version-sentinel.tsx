"use client";

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef } from "react";

import { ACTIVE_GAME_MODE_UPDATED_EVENT } from "@/lib/game-mode";
import { safeGetStorageItem, safeSetStorageItem } from "@/lib/safe-storage";

const VERSION_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const VERSION_ENDPOINT = "/api/version";
const CLIENT_BUILD_VERSION = (process.env.NEXT_PUBLIC_APP_VERSION ?? "development").trim() || "development";
export const LIVE_ACTIVITY_STORAGE_KEY = "kmk_live_activity_active";

type VersionResponse = {
  version?: string;
};

function isLiveActivityActive(): boolean {
  return safeGetStorageItem(LIVE_ACTIVITY_STORAGE_KEY, "session") === "1";
}

export function VersionSentinel() {
  const pathname = usePathname();
  const currentVersionRef = useRef(CLIENT_BUILD_VERSION);
  const pendingReloadRef = useRef(false);
  const isCheckingRef = useRef(false);

  const reloadWhenSafe = useCallback(() => {
    if (!pendingReloadRef.current) {
      return;
    }
    if (isLiveActivityActive()) {
      return;
    }
    pendingReloadRef.current = false;
    window.location.reload();
  }, []);

  const checkVersion = useCallback(async () => {
    if (isCheckingRef.current) {
      return;
    }
    isCheckingRef.current = true;
    try {
      const response = await fetch(`${VERSION_ENDPOINT}?t=${Date.now()}`, {
        cache: "no-store",
        headers: {
          "Cache-Control": "no-cache"
        }
      });
      if (!response.ok) {
        return;
      }
      const payload = (await response.json()) as VersionResponse;
      const nextVersion = String(payload.version ?? "").trim();
      if (!nextVersion) {
        return;
      }
      if (nextVersion !== currentVersionRef.current) {
        safeSetStorageItem("kmk_pending_app_version", nextVersion, "session");
        pendingReloadRef.current = true;
        reloadWhenSafe();
      }
    } catch {
      // Deployment checks are best-effort and should never interrupt gameplay.
    } finally {
      isCheckingRef.current = false;
    }
  }, [reloadWhenSafe]);

  useEffect(() => {
    void checkVersion();
  }, [checkVersion, pathname]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      void checkVersion();
    }, VERSION_CHECK_INTERVAL_MS);

    const onFocus = () => {
      reloadWhenSafe();
      void checkVersion();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        onFocus();
      }
    };

    window.addEventListener("focus", onFocus);
    window.addEventListener("popstate", onFocus);
    window.addEventListener(ACTIVE_GAME_MODE_UPDATED_EVENT, onFocus as EventListener);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("popstate", onFocus);
      window.removeEventListener(ACTIVE_GAME_MODE_UPDATED_EVENT, onFocus as EventListener);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [checkVersion, reloadWhenSafe]);

  return null;
}
