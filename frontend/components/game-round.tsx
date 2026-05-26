"use client";

import { motion } from "framer-motion";
import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { fetchRound, fetchRoundBatch, submitRoundVotes } from "@/lib/api";
import { ENABLE_API_BOTS } from "@/lib/feature-flags";
import {
  VIP_MEN,
  VIP_PORTRAIT_FALLBACK_URL,
  VIP_WOMEN,
  type VIPCelebrity
} from "@/lib/vip-data";
import type { AuthUser, GetRoundResponse, RoundUser, VoteType } from "@/lib/types";

const actionStyle: Record<VoteType, string> = {
  kiss: "border-rose-300/50 bg-[#241226]/90 text-rose-200",
  marry: "border-emerald-300/50 bg-[#102620]/90 text-emerald-200",
  kill: "border-orange-300/50 bg-[#2a1a1a]/90 text-orange-200"
};

const selectedStyle: Record<VoteType, string> = {
  kiss: "ring-2 ring-rose-300 shadow-[0_0_0_1px_rgba(251,113,133,0.45)]",
  marry: "ring-2 ring-emerald-300 shadow-[0_0_0_1px_rgba(52,211,153,0.45)]",
  kill: "ring-2 ring-orange-300 shadow-[0_0_0_1px_rgba(251,146,60,0.45)]"
};

const tiltByVote: Record<VoteType, { x: number; y: number; rotate: number }> = {
  kiss: { x: -6, y: -2, rotate: -2.5 },
  marry: { x: 6, y: -1, rotate: 2.5 },
  kill: { x: 4, y: 4, rotate: 3.5 }
};

const cardAccentStyle: Record<VoteType, string> = {
  kiss: "border-rose-300/65 shadow-[0_0_35px_rgba(244,114,182,0.2)]",
  marry: "border-emerald-300/65 shadow-[0_0_35px_rgba(16,185,129,0.2)]",
  kill: "border-orange-300/65 shadow-[0_0_35px_rgba(251,146,60,0.2)]"
};

const badgeStyle: Record<VoteType, string> = {
  kiss: "border-rose-200/60 bg-rose-500/85 text-white",
  marry: "border-emerald-200/60 bg-emerald-500/85 text-white",
  kill: "border-orange-200/60 bg-orange-500/85 text-white"
};

const ROUND_SIZE = 3;
const ROUND_BATCH_SIZE = 18;
const ROUND_BATCH_LOW_WATERMARK = 6;
const INTERSTITIAL_AD_ROUND_INTERVAL = 7;
const INTERSTITIAL_AD_CLOSE_DELAY_MS = 1600;
const VIP_ROOM_ID = "vip_global";
const FALLBACK_PROFILE_IMAGE_URL = VIP_PORTRAIT_FALLBACK_URL;
const CARD_IMAGE_WIDTH = 760;
const CARD_IMAGE_HEIGHT = 1000;
const ADSENSE_CLIENT_ID = "ca-pub-1680175309169171";
const ADSENSE_INTERSTITIAL_SLOT_ID = process.env.NEXT_PUBLIC_ADSENSE_INTERSTITIAL_SLOT_ID?.trim() ?? "";
const ensureArray = <T,>(items: T[] | null | undefined): T[] => (Array.isArray(items) ? items : []);
const normalizeRoundUser = (candidate: RoundUser): RoundUser => {
  const profileImage = candidate.profile_image_url ?? candidate.imageUrl ?? null;
  const normalizedId = String(candidate.id ?? "").trim();
  const normalizedTargetId =
    typeof candidate.target_id === "number" && Number.isFinite(candidate.target_id)
      ? candidate.target_id
      : Number.parseInt(normalizedId, 10);
  return {
    ...candidate,
    id: normalizedId || `profile-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    target_id: Number.isFinite(normalizedTargetId) ? normalizedTargetId : 0,
    profile_image_url: profileImage,
    imageUrl: candidate.imageUrl ?? profileImage,
    location: candidate.location ?? null,
    is_local_ai_bot: Boolean(candidate.is_local_ai_bot)
  };
};

export type GameMode = "classic" | "vip";
export type VIPRoundVote = { profileId: string; action: VoteType };

type GameRoundProps = {
  accessToken: string;
  currentUser: AuthUser;
  mode: GameMode;
  onLogout: () => void;
  onBackToMenu?: () => void;
  onVipConfirmRound?: (votes: VIPRoundVote[]) => void | Promise<void>;
};

type IconProps = {
  className?: string;
};

function HeartOutlineIcon({ className = "h-5 w-5" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path
        d="M12 20s-7-4.8-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.2-7 10-7 10Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function BackArrowIcon({ className = "h-4 w-4" }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden>
      <path d="M9.5 4.5 4.5 10l5 5M5 10h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function LocationPinIcon({ className = "h-3.5 w-3.5" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path
        d="M12 21s6-5.4 6-10a6 6 0 1 0-12 0c0 4.6 6 10 6 10Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="11" r="2.2" fill="currentColor" />
    </svg>
  );
}

function RingIcon({ className = "h-3.5 w-3.5" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <circle cx="12" cy="12.5" r="4.2" stroke="currentColor" strokeWidth="1.8" />
      <path d="M12 5.2V2.8M10.3 4h3.4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function SkullIcon({ className = "h-3.5 w-3.5" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path
        d="M12 4.6c-3.4 0-6.1 2.6-6.1 5.8 0 2.2 1.2 4.1 3 5.1v1.3c0 .9.7 1.6 1.6 1.6h3c.9 0 1.6-.7 1.6-1.6v-1.3a5.7 5.7 0 0 0 3-5.1c0-3.2-2.7-5.8-6.1-5.8Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <circle cx="9.8" cy="10.9" r="1.1" fill="currentColor" />
      <circle cx="14.2" cy="10.9" r="1.1" fill="currentColor" />
      <path d="M10.5 14h3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function CheckIcon({ className = "h-4.5 w-4.5" }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden>
      <path d="m4.5 10.4 3.2 3.2 7.8-7.9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ControllerIcon({ className = "h-4 w-4" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <rect x="3.5" y="8.2" width="17" height="8.8" rx="4.2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M8 12.5h3.5M9.75 10.7v3.6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <circle cx="15.8" cy="11.4" r="1" fill="currentColor" />
      <circle cx="17.6" cy="13.2" r="1" fill="currentColor" />
    </svg>
  );
}

const actionMeta: Record<VoteType, { ariaLabel: string; Icon: (props: IconProps) => JSX.Element }> = {
  kiss: { ariaLabel: "Kiss", Icon: HeartOutlineIcon },
  marry: { ariaLabel: "Marry", Icon: RingIcon },
  kill: { ariaLabel: "Kill", Icon: SkullIcon }
};

const pickUniqueCelebrities = (pool: VIPCelebrity[] | null | undefined, count: number): VIPCelebrity[] => {
  const candidates = [...ensureArray(pool)];
  const picked: VIPCelebrity[] = [];
  while (picked.length < count && candidates.length > 0) {
    const index = Math.floor(Math.random() * candidates.length);
    const [next] = candidates.splice(index, 1);
    if (next) {
      picked.push(next);
    }
  }
  return picked;
};

const toVipRoundUsers = (celebrities: VIPCelebrity[] | null | undefined): RoundUser[] =>
  ensureArray(celebrities).map((celebrity, index) => ({
    id: celebrity.id || `vip-${index + 1}`,
    target_id: index + 1,
    name: celebrity.name || "",
    profile_image_url: celebrity.imageUrl || FALLBACK_PROFILE_IMAGE_URL,
    gender: celebrity.gender === "female" ? "female" : "male",
    latitude: 0,
    longitude: 0,
    distance_km: Number((Math.random() * 9 + 0.5).toFixed(1))
  }));

const normalizeRoundResponse = (candidate: GetRoundResponse | null | undefined): GetRoundResponse => ({
  zone_id: typeof candidate?.zone_id === "string" ? candidate.zone_id : "",
  users: ensureArray(candidate?.users).map(normalizeRoundUser).slice(0, ROUND_SIZE)
});

export function GameRound({
  accessToken,
  currentUser,
  mode,
  onLogout,
  onBackToMenu,
  onVipConfirmRound
}: GameRoundProps) {
  const [users, setUsers] = useState<RoundUser[]>([]);
  const [zoneId, setZoneId] = useState<string | null>(null);
  const [selectedByUser, setSelectedByUser] = useState<Record<string, VoteType>>({});
  const [brokenImageByUser, setBrokenImageByUser] = useState<Record<string, boolean>>({});
  const [isFallbackImageBroken, setIsFallbackImageBroken] = useState(false);
  const [isLoadingRound, setIsLoadingRound] = useState(true);
  const [isSubmittingVotes, setIsSubmittingVotes] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [roundKey, setRoundKey] = useState(0);
  const [roundsSinceLastAd, setRoundsSinceLastAd] = useState<number>(0);
  const [isInterstitialAdVisible, setIsInterstitialAdVisible] = useState(false);
  const [isAdCloseReady, setIsAdCloseReady] = useState(false);
  const [pendingRoundAfterAd, setPendingRoundAfterAd] = useState(false);
  const [interstitialAdInstance, setInterstitialAdInstance] = useState(0);
  const [adRenderError, setAdRenderError] = useState<string | null>(null);
  const isVipMode = mode === "vip";
  const isAdSlotConfigured = ADSENSE_INTERSTITIAL_SLOT_ID.length > 0;
  const vipPool = useMemo(() => (currentUser.gender === "male" ? VIP_WOMEN : VIP_MEN), [currentUser.gender]);
  const roundCacheRef = useRef<GetRoundResponse[]>([]);
  const isBatchPrefetchingRef = useRef(false);
  const [cachedRoundCount, setCachedRoundCount] = useState(0);

  const syncCachedRoundCount = useCallback(() => {
    setCachedRoundCount(roundCacheRef.current.length);
  }, []);

  const appendToRoundCache = useCallback(
    (rounds: GetRoundResponse[] | null | undefined): number => {
      const normalizedRounds = ensureArray(rounds)
        .map((round) => normalizeRoundResponse(round))
        .filter((round) => round.users.length === ROUND_SIZE);
      if (normalizedRounds.length === 0) {
        return 0;
      }
      roundCacheRef.current.push(...normalizedRounds);
      syncCachedRoundCount();
      return normalizedRounds.length;
    },
    [syncCachedRoundCount]
  );

  const pullNextCachedRound = useCallback((): GetRoundResponse | null => {
    const next = roundCacheRef.current.shift() ?? null;
    syncCachedRoundCount();
    return next;
  }, [syncCachedRoundCount]);

  const maybePrefetchBatchRounds = useCallback(
    async ({ force = false, silent = false }: { force?: boolean; silent?: boolean } = {}): Promise<void> => {
      if (isVipMode) {
        return;
      }

      const cacheSize = roundCacheRef.current.length;
      if (!force && cacheSize >= ROUND_BATCH_LOW_WATERMARK) {
        return;
      }
      if (isBatchPrefetchingRef.current) {
        return;
      }

      isBatchPrefetchingRef.current = true;
      try {
        const batchResponse = await fetchRoundBatch(accessToken, ROUND_BATCH_SIZE);
        const added = appendToRoundCache(batchResponse?.rounds);
        if (added === 0 && !silent && cacheSize === 0) {
          setInfo("No fresh profiles right now. Retrying...");
        }
      } catch {
        if (!silent) {
          setInfo("Temporary network issue detected. Recovering in the background...");
        }
      } finally {
        isBatchPrefetchingRef.current = false;
      }
    },
    [accessToken, appendToRoundCache, isVipMode]
  );

  const loadRound = useCallback(
    async () => {
      setIsLoadingRound(true);
      setSelectedByUser({});
      setBrokenImageByUser({});
      setIsFallbackImageBroken(false);
      setError(null);
      setInfo(null);

      if (isVipMode) {
        try {
          const nextCelebrities = pickUniqueCelebrities(vipPool, ROUND_SIZE);
          if (nextCelebrities.length !== ROUND_SIZE) {
            throw new Error("VIP roster is temporarily unavailable.");
          }
          setUsers(toVipRoundUsers(nextCelebrities));
          setRoundKey((previous) => previous + 1);
          setZoneId(VIP_ROOM_ID);
        } catch (vipError) {
          const message = vipError instanceof Error ? vipError.message : "Could not load VIP round.";
          setError(message);
          setUsers([]);
        } finally {
          setIsLoadingRound(false);
        }
        return;
      }

      try {
        let nextRound = pullNextCachedRound();
        if (!nextRound) {
          try {
            const batchResponse = await fetchRoundBatch(accessToken, ROUND_BATCH_SIZE);
            appendToRoundCache(batchResponse?.rounds);
            nextRound = pullNextCachedRound();
          } catch {
            nextRound = null;
          }
        }

        if (!nextRound) {
          const fallbackResponse = await fetchRound(accessToken);
          nextRound = normalizeRoundResponse(fallbackResponse);
          setInfo("Network hiccup detected. Loaded a fallback round.");
        }

        const normalizedRound = normalizeRoundResponse(nextRound);
        if (normalizedRound.users.length !== ROUND_SIZE) {
          throw new Error(
            ENABLE_API_BOTS
              ? "Not enough profiles right now. More bots/users will appear as activity grows."
              : "No local profiles are available yet. API bots are currently paused, so only real players are shown."
          );
        }

        setUsers(normalizedRound.users);
        setRoundKey((previous) => previous + 1);
        setZoneId((previousZoneId) => {
          if (previousZoneId && previousZoneId !== normalizedRound.zone_id) {
            setInfo("Moved to a new room. Refreshing your local server feed.");
          }
          return normalizedRound.zone_id;
        });
        void maybePrefetchBatchRounds({ silent: true });
      } catch (roundError) {
        const message = roundError instanceof Error ? roundError.message : "Could not load the round.";
        setError(message);
        setUsers([]);
      } finally {
        setIsLoadingRound(false);
      }
    },
    [accessToken, appendToRoundCache, isVipMode, maybePrefetchBatchRounds, pullNextCachedRound, vipPool]
  );

  useEffect(() => {
    roundCacheRef.current = [];
    isBatchPrefetchingRef.current = false;
    syncCachedRoundCount();
  }, [accessToken, isVipMode, syncCachedRoundCount]);

  useEffect(() => {
    void loadRound();
  }, [loadRound]);

  useEffect(() => {
    if (isVipMode) {
      return;
    }
    if (cachedRoundCount < ROUND_BATCH_LOW_WATERMARK) {
      void maybePrefetchBatchRounds({ silent: true });
    }
  }, [cachedRoundCount, isVipMode, maybePrefetchBatchRounds]);

  useEffect(() => {
    if (!isInterstitialAdVisible) {
      return;
    }

    setIsAdCloseReady(false);
    const timeoutId = window.setTimeout(() => {
      setIsAdCloseReady(true);
    }, INTERSTITIAL_AD_CLOSE_DELAY_MS);

    return () => window.clearTimeout(timeoutId);
  }, [isInterstitialAdVisible]);

  useEffect(() => {
    if (!isInterstitialAdVisible || !isAdSlotConfigured) {
      return;
    }

    setAdRenderError(null);
    const timeoutId = window.setTimeout(() => {
      try {
        const adQueueHost = window as Window & { adsbygoogle?: Array<Record<string, unknown>> };
        adQueueHost.adsbygoogle = adQueueHost.adsbygoogle ?? [];
        adQueueHost.adsbygoogle.push({});
      } catch {
        setAdRenderError("Ad failed to load. Close and continue to the next round.");
      }
    }, 0);

    return () => window.clearTimeout(timeoutId);
  }, [interstitialAdInstance, isAdSlotConfigured, isInterstitialAdVisible]);

  const usedActions = useMemo(() => new Set<VoteType>(Object.values(selectedByUser)), [selectedByUser]);

  const assignAction = (userId: string, action: VoteType) => {
    if (isSubmittingVotes) {
      return;
    }

    if (typeof window !== "undefined" && typeof navigator.vibrate === "function") {
      navigator.vibrate(50);
    }

    setError(null);
    setSelectedByUser((previous) => {
      const next = { ...previous };

      if (next[userId] === action) {
        delete next[userId];
        return next;
      }

      const sameActionOwner = Object.entries(next).find(
        ([candidateId, existingAction]) => candidateId !== userId && existingAction === action
      );
      if (sameActionOwner) {
        delete next[sameActionOwner[0]];
      }

      next[userId] = action;
      return next;
    });
  };

  const safeUsers = ensureArray(users);

  const isRoundComplete =
    safeUsers.length === ROUND_SIZE && safeUsers.every((candidate) => selectedByUser[candidate.id] !== undefined);

  const advanceToNextRound = useCallback(async () => {
    const nextCount = roundsSinceLastAd + 1;

    if (nextCount >= INTERSTITIAL_AD_ROUND_INTERVAL) {
      setRoundsSinceLastAd(nextCount);
      setPendingRoundAfterAd(true);
      setIsInterstitialAdVisible(true);
      setInterstitialAdInstance((previous) => previous + 1);
      setInfo("Sponsored break unlocked.");
      return;
    }

    setRoundsSinceLastAd(nextCount);
    await loadRound();
  }, [loadRound, roundsSinceLastAd]);

  const closeInterstitialAd = useCallback(async () => {
    if (!isAdCloseReady) {
      return;
    }

    const shouldLoadPendingRound = pendingRoundAfterAd;
    setIsInterstitialAdVisible(false);
    setIsAdCloseReady(false);
    setPendingRoundAfterAd(false);
    setRoundsSinceLastAd(0);
    setInfo(null);

    if (shouldLoadPendingRound) {
      await loadRound();
    }
  }, [isAdCloseReady, loadRound, pendingRoundAfterAd]);

  const confirmVotes = async () => {
    if (!isRoundComplete || isSubmittingVotes) {
      return;
    }

    setIsSubmittingVotes(true);
    setError(null);
    try {
      if (isVipMode) {
        const voteCandidates = ensureArray(users);
        const vipVotes: VIPRoundVote[] = voteCandidates.map((candidate) => ({
          profileId: candidate.id,
          action: selectedByUser[candidate.id] as VoteType
        }));

        if (onVipConfirmRound) {
          await onVipConfirmRound(vipVotes);
        }
        setInfo("VIP round saved.");

        await advanceToNextRound();
        return;
      }

      const voteCandidates = ensureArray(users);
      if (voteCandidates.length === 0) {
        setError("No profiles available for this round yet.");
        return;
      }

      await submitRoundVotes(
        {
          votes: voteCandidates.map((candidate) => ({
            target_id: candidate.target_id,
            tip_glasa: selectedByUser[candidate.id] as VoteType
          }))
        },
        accessToken
      );
      await advanceToNextRound();
    } catch (submitError) {
      const message = submitError instanceof Error ? submitError.message : "Could not submit votes.";
      setError(message);
    } finally {
      setIsSubmittingVotes(false);
    }
  };

  const renderCandidateCard = (candidate: RoundUser | undefined, slotIndex: number) => {
    if (!candidate) {
      return (
        <div className="relative aspect-[0.76] w-full rounded-3xl border border-blue-200/15 bg-[#071128]/60 shadow-[inset_0_0_0_1px_rgba(12,24,52,0.8)]" />
      );
    }

    const selected = selectedByUser[candidate.id];
    const safeName = candidate.name?.trim() || "";
    const imageUrl = candidate.profile_image_url?.trim() || candidate.imageUrl?.trim() || null;
    const isImageBroken = Boolean(brokenImageByUser[candidate.id]);
    const nameLength = safeName.length;
    const nameSizeClass =
      nameLength > 28
        ? "text-[10px] sm:text-[11px]"
        : nameLength > 23
          ? "text-[11px] sm:text-[12px]"
          : nameLength > 18
            ? "text-[13px] sm:text-[14px]"
            : nameLength > 14
              ? "text-[16px] sm:text-[17px]"
              : "text-[24px] sm:text-[26px]";
    const resolvedImageUrl = !isImageBroken && imageUrl ? imageUrl : FALLBACK_PROFILE_IMAGE_URL;
    const tilt = selected ? tiltByVote[selected] : { x: 0, y: 0, rotate: 0 };
    const activeCardStyle = selected ? cardAccentStyle[selected] : "border-blue-200/25 shadow-[0_8px_30px_rgba(2,10,28,0.65)]";

    return (
      <div className="relative aspect-[0.76] w-full rounded-3xl border border-blue-200/15 bg-[#071128]/55 p-[2px] shadow-[inset_0_0_0_1px_rgba(12,24,52,0.8)]">
        <motion.article
          key={`round-${roundKey}-slot-${slotIndex}-candidate-${candidate.id}`}
          initial={{ opacity: 0, scale: 0.96, y: 10 }}
          animate={{
            opacity: 1,
            scale: selected ? 1.01 : 1,
            y: tilt.y,
            x: tilt.x,
            rotate: tilt.rotate
          }}
          transition={{ type: "spring", stiffness: 190, damping: 24, mass: 0.9 }}
          className={`absolute inset-[2px] flex h-[calc(100%-4px)] flex-col overflow-hidden rounded-[22px] border bg-[linear-gradient(180deg,rgba(6,18,46,0.96)_0%,rgba(6,15,38,0.98)_100%)] ${activeCardStyle}`}
        >
          <div className="relative min-h-0 flex-1 bg-[#0b1637]">
            {!isFallbackImageBroken ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={resolvedImageUrl}
                alt={safeName || "Profile"}
                loading="lazy"
                decoding="async"
                className="w-full h-full object-cover"
                onError={() => {
                  if (resolvedImageUrl === FALLBACK_PROFILE_IMAGE_URL) {
                    setIsFallbackImageBroken(true);
                    return;
                  }
                  setBrokenImageByUser((previous) => (previous[candidate.id] ? previous : { ...previous, [candidate.id]: true }));
                }}
              />
            ) : (
              <div className="h-full w-full bg-[radial-gradient(60%_70%_at_50%_30%,rgba(35,138,255,0.28),transparent_70%),linear-gradient(160deg,#0d1f45_0%,#09162e_65%,#060f22_100%)]">
                <div className="absolute inset-0 shadow-[inset_0_0_0_1px_rgba(123,180,255,0.2)]" />
              </div>
            )}

            {selected && (
              <span
                className={`absolute left-2.5 top-2.5 rounded-full border px-2 py-1 text-[10px] font-bold uppercase tracking-wide shadow ${badgeStyle[selected]}`}
              >
                {selected}
              </span>
            )}

            <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-[#030a18]/95 via-[#050e24]/70 to-transparent px-3 pb-3 pt-12">
              <p className={`w-full whitespace-nowrap font-bold leading-tight tracking-tight text-white ${nameSizeClass}`}>
                {safeName || "Unknown"}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2 border-t border-blue-200/15 bg-[#070f25]/80 p-2 sm:p-2.5">
            {(Object.keys(actionStyle) as VoteType[]).map((action) => {
              const disabled = isSubmittingVotes;
              const { ariaLabel, Icon } = actionMeta[action];
              return (
                <button
                  key={action}
                  type="button"
                  aria-label={ariaLabel}
                  disabled={disabled}
                  onClick={() => assignAction(candidate.id, action)}
                  className={`inline-flex min-h-10 min-w-0 items-center justify-center rounded-xl border px-1.5 transition-colors duration-200 ${
                    actionStyle[action]
                  } ${selected === action ? selectedStyle[action] : ""} ${
                    disabled ? "opacity-60" : "active:brightness-110"
                  }`}
                >
                  <span className="inline-flex h-5 w-5 items-center justify-center">
                    <Icon className="h-4 w-4 drop-shadow-[0_0_10px_currentColor]" />
                  </span>
                </button>
              );
            })}
          </div>
        </motion.article>
      </div>
    );
  };

  const renderSkeletonCard = (slotIndex: number) => (
    <div
      key={`skeleton-card-${slotIndex}`}
      className="relative aspect-[0.76] w-full rounded-3xl border border-blue-200/15 bg-[#071128]/60 p-[2px] shadow-[inset_0_0_0_1px_rgba(12,24,52,0.8)]"
    >
      <div className="absolute inset-[2px] overflow-hidden rounded-[22px] border border-blue-200/20 bg-[#081530]/85">
        <div className="skeleton-shimmer h-[72%] w-full" />
        <div className="space-y-2 px-3 py-3">
          <div className="skeleton-shimmer h-4 w-3/4 rounded-md" />
          <div className="grid grid-cols-3 gap-2 pt-1">
            <div className="skeleton-shimmer h-9 rounded-xl" />
            <div className="skeleton-shimmer h-9 rounded-xl" />
            <div className="skeleton-shimmer h-9 rounded-xl" />
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <>
      <section className="w-full space-y-4 rounded-[30px] border border-blue-300/15 bg-[linear-gradient(180deg,rgba(2,14,38,0.9)_0%,rgba(3,12,33,0.92)_100%)] p-3.5 shadow-[0_30px_90px_rgba(1,4,12,0.78)] backdrop-blur-xl sm:p-4">
      <header className="rounded-3xl border border-blue-200/15 bg-[#050f2a]/80 px-3 py-3 shadow-[inset_0_0_0_1px_rgba(15,30,62,0.85)]">
        <div className="flex items-start justify-between gap-2.5">
          <div className="min-w-0">
            <div className="flex items-center gap-2.5">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-fuchsia-300/25 bg-gradient-to-br from-fuchsia-500/20 via-violet-500/15 to-sky-500/15 text-fuchsia-200 shadow-[0_0_18px_rgba(217,70,239,0.25)]">
                <HeartOutlineIcon className="h-5 w-5" />
              </span>
              <div className="min-w-0">
                <p className="truncate text-[35px] font-bold leading-tight text-white sm:text-[37px]">KMK</p>
                <p className="truncate text-xs text-slate-400">Signed in as {currentUser.name}</p>
              </div>
            </div>
          </div>
          {onBackToMenu && (
            <button
              type="button"
              onClick={onBackToMenu}
              className="inline-flex min-h-11 shrink-0 items-center justify-center gap-1.5 rounded-full border border-violet-300/30 bg-[#1a1740]/85 px-3.5 text-xs font-semibold text-violet-100 transition-colors duration-200 active:bg-[#251d56] sm:text-sm"
            >
              <BackArrowIcon className="h-4 w-4" />
              Back to Menu
            </button>
          )}
        </div>
      </header>

      {error && <p className="rounded-2xl border border-red-300/30 bg-red-500/15 px-3 py-2 text-sm text-red-100">{error}</p>}
      {info && <p className="rounded-2xl border border-cyan-300/30 bg-cyan-500/15 px-3 py-2 text-sm text-cyan-100">{info}</p>}

      {(isLoadingRound || isSubmittingVotes) && (
        <p className="rounded-2xl border border-blue-300/20 bg-blue-500/10 px-3 py-2 text-sm text-blue-100">
          {isSubmittingVotes ? "Submitting votes and loading next round..." : "Loading profiles..."}
        </p>
      )}

      {!isLoadingRound && safeUsers.length !== ROUND_SIZE && (
        <p className="rounded-2xl border border-amber-300/35 bg-amber-500/15 px-3 py-2 text-sm text-amber-100">
          {ENABLE_API_BOTS
            ? "Not enough profiles right now. More bots/users will appear as activity grows."
            : "No local profiles are available yet. API bots are currently paused, so only real players are shown."}
        </p>
      )}

      <div className="space-y-3">
        {isLoadingRound ? (
          <div className="mx-auto w-full max-w-[520px]">
            <div className="grid grid-cols-4 gap-2.5 sm:gap-3">
              <div className="col-span-2">{renderSkeletonCard(0)}</div>
              <div className="col-span-2">{renderSkeletonCard(1)}</div>
              <div className="col-span-2 col-start-2">{renderSkeletonCard(2)}</div>
            </div>
          </div>
        ) : (
          <motion.div
            key={`round-layout-${roundKey}`}
            initial={{ opacity: 0, scale: 0.97 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.28, ease: "easeOut" }}
            className="mx-auto w-full max-w-[520px]"
          >
            <div className="grid grid-cols-4 gap-2.5 sm:gap-3">
              <div className="col-span-2">{renderCandidateCard(safeUsers[0], 0)}</div>
              <div className="col-span-2">{renderCandidateCard(safeUsers[1], 1)}</div>
              <div className="col-span-2 col-start-2">{renderCandidateCard(safeUsers[2], 2)}</div>
            </div>
          </motion.div>
        )}
      </div>

        <button
          type="button"
          onClick={() => {
            void confirmVotes();
          }}
          disabled={!isRoundComplete || isSubmittingVotes || safeUsers.length !== ROUND_SIZE}
          className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-full border border-blue-300/45 bg-gradient-to-r from-[#2830a3] via-[#2c48c8] to-[#235cca] px-4 py-2 text-sm font-semibold text-blue-50 shadow-[0_14px_30px_rgba(30,84,200,0.45)] transition-colors duration-200 active:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <CheckIcon className="h-4.5 w-4.5" />
          {isSubmittingVotes ? "Submitting Round..." : "Confirm Round"}
        </button>

        <footer className="flex items-center justify-between gap-2 rounded-2xl border border-blue-200/15 bg-[#060f27]/85 px-3 py-2.5 text-xs text-slate-300">
          <div className="flex min-w-0 items-center gap-2">
            <ControllerIcon className="h-4 w-4 shrink-0 text-violet-200" />
            <p className="truncate">
              Chosen actions: {Array.from(usedActions).join(", ") || "none"} ({usedActions.size}/3)
            </p>
            <span className="h-4 w-px bg-blue-200/30" />
            <p className="truncate">Room: {zoneId ?? "loading"}</p>
          </div>
          <span className="shrink-0 rounded-full border border-blue-300/35 bg-blue-500/20 px-2.5 py-1 text-[11px] font-semibold text-blue-100">
            {usedActions.size}/3
          </span>
        </footer>
      </section>

      {isInterstitialAdVisible && (
        <div className="fixed inset-0 z-[140] flex items-center justify-center bg-[radial-gradient(80%_80%_at_50%_20%,rgba(37,99,235,0.22),transparent_65%),linear-gradient(180deg,rgba(2,6,23,0.96)_0%,rgba(3,8,28,0.98)_100%)] px-4 py-6">
          <motion.section
            initial={{ opacity: 0, scale: 0.94, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            transition={{ type: "spring", stiffness: 220, damping: 24 }}
            className="w-full max-w-md rounded-3xl border border-blue-300/25 bg-[#060f2d]/95 p-4 shadow-[0_30px_90px_rgba(0,0,0,0.65)]"
          >
            <p className="text-center text-xs uppercase tracking-[0.2em] text-cyan-200/80">Sponsored Break</p>
            <h3 className="mt-1 text-center text-xl font-bold text-white">Video Ad</h3>
            <p className="mt-1 text-center text-sm text-slate-300">Thanks for playing. Your next round will resume after this video ad.</p>

            <div className="mt-4 rounded-2xl border border-blue-300/20 bg-[linear-gradient(160deg,rgba(15,23,42,0.92)_0%,rgba(17,24,39,0.92)_100%)] p-3">
              <div className="min-h-[220px] rounded-xl border border-blue-300/25 bg-[#0b1535]/90 p-2">
                {isAdSlotConfigured ? (
                  <ins
                    key={`interstitial-adsense-${interstitialAdInstance}`}
                    className="adsbygoogle block h-full w-full"
                    style={{ display: "block", minHeight: "220px" }}
                    data-ad-client={ADSENSE_CLIENT_ID}
                    data-ad-slot={ADSENSE_INTERSTITIAL_SLOT_ID}
                    data-ad-format="auto"
                    data-full-width-responsive="true"
                  />
                ) : (
                  <div className="flex min-h-[220px] items-center justify-center rounded-lg border border-dashed border-amber-300/40 bg-amber-500/10 text-center">
                    <p className="max-w-[260px] text-xs text-amber-100">
                      Configure NEXT_PUBLIC_ADSENSE_INTERSTITIAL_SLOT_ID to render interstitial video ad creatives here.
                    </p>
                  </div>
                )}
              </div>
            </div>

            {adRenderError ? (
              <p className="mt-3 rounded-xl border border-amber-300/40 bg-amber-500/15 px-3 py-2 text-xs text-amber-100">
                {adRenderError}
              </p>
            ) : null}

            <div className="mt-4 flex justify-center">
              {isAdCloseReady ? (
                <button
                  type="button"
                  onClick={() => {
                    void closeInterstitialAd();
                  }}
                  className="inline-flex min-h-11 items-center justify-center rounded-xl border border-rose-300/50 bg-rose-500/20 px-4 text-sm font-semibold text-rose-100 transition hover:bg-rose-500/30"
                >
                  Close Ad (X)
                </button>
              ) : (
                <p className="rounded-xl border border-blue-300/25 bg-blue-500/10 px-3 py-2 text-xs text-blue-100">
                  Close button unlocks in a moment...
                </p>
              )}
            </div>
          </motion.section>
        </div>
      )}
    </>
  );
}

