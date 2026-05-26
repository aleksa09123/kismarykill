import type { VoteType } from "@/lib/types";
import { safeGetStorageItem, safeSetStorageItem } from "@/lib/safe-storage";

export type VIPStatEntry = {
  kisses: number;
  marries: number;
  kills: number;
};

type VIPStatsMap = Record<string, VIPStatEntry>;

const VIP_STATS_STORAGE_KEY = "kmk_vip_stats_v1";
export const VIP_STATS_UPDATED_EVENT = "kmk:vip-stats-updated";

function normalizeStatEntry(value: unknown): VIPStatEntry {
  if (!value || typeof value !== "object") {
    return { kisses: 0, marries: 0, kills: 0 };
  }
  const next = value as Partial<VIPStatEntry>;
  return {
    kisses: Number.isFinite(next.kisses) ? Math.max(0, Number(next.kisses)) : 0,
    marries: Number.isFinite(next.marries) ? Math.max(0, Number(next.marries)) : 0,
    kills: Number.isFinite(next.kills) ? Math.max(0, Number(next.kills)) : 0
  };
}

export function readVIPStats(): VIPStatsMap {
  if (typeof window === "undefined") {
    return {};
  }

  const raw = safeGetStorageItem(VIP_STATS_STORAGE_KEY);
  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).map(([key, value]) => [key, normalizeStatEntry(value)])
    );
  } catch {
    return {};
  }
}

function writeVIPStats(stats: VIPStatsMap): void {
  if (typeof window === "undefined") {
    return;
  }
  safeSetStorageItem(VIP_STATS_STORAGE_KEY, JSON.stringify(stats));
  window.dispatchEvent(new CustomEvent<VIPStatsMap>(VIP_STATS_UPDATED_EVENT, { detail: stats }));
}

export function getVIPStatForProfile(profileId: string): VIPStatEntry {
  const stats = readVIPStats();
  return stats[profileId] ?? { kisses: 0, marries: 0, kills: 0 };
}

export function recordVIPRoundVotes(votes: Array<{ profileId: string; action: VoteType }>): VIPStatsMap {
  const nextStats = readVIPStats();

  votes.forEach((vote) => {
    const existing = nextStats[vote.profileId] ?? { kisses: 0, marries: 0, kills: 0 };
    const updated = { ...existing };
    if (vote.action === "kiss") {
      updated.kisses += 1;
    } else if (vote.action === "marry") {
      updated.marries += 1;
    } else if (vote.action === "kill") {
      updated.kills += 1;
    }
    nextStats[vote.profileId] = updated;
  });

  writeVIPStats(nextStats);
  return nextStats;
}
