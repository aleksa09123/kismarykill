"use client";

import { motion } from "framer-motion";
import { useCallback, useEffect, useMemo, useState } from "react";

import { fetchBlindModeRound, submitBlindModeChoice } from "@/lib/api";
import type { BlindModeRoundResult, BlindModeSubmitResponse, VoteType } from "@/lib/types";

type BlindModeRoundProps = {
  accessToken: string;
  onBackToMenu?: () => void;
  onRoundSubmitted?: () => void;
};

type IconProps = {
  className?: string;
};

const BLIND_THEME_CLASSES: Record<string, string> = {
  "bg-gradient-to-br from-fuchsia-600 via-violet-600 to-cyan-500":
    "bg-gradient-to-br from-fuchsia-600 via-violet-600 to-cyan-500",
  "bg-gradient-to-br from-rose-500 via-orange-400 to-amber-300":
    "bg-gradient-to-br from-rose-500 via-orange-400 to-amber-300",
  "bg-gradient-to-br from-emerald-500 via-teal-500 to-sky-500":
    "bg-gradient-to-br from-emerald-500 via-teal-500 to-sky-500",
  "bg-gradient-to-br from-indigo-600 via-blue-500 to-lime-300":
    "bg-gradient-to-br from-indigo-600 via-blue-500 to-lime-300",
  "bg-gradient-to-br from-pink-500 via-red-500 to-yellow-400":
    "bg-gradient-to-br from-pink-500 via-red-500 to-yellow-400",
};

const actionStyles: Record<VoteType, { label: string; className: string; selectedClassName: string }> = {
  kiss: {
    label: "Kiss",
    className: "border-rose-200/55 bg-rose-500/20 text-rose-50 shadow-[0_12px_28px_rgba(244,63,94,0.25)]",
    selectedClassName: "ring-2 ring-rose-100 bg-rose-500/45",
  },
  marry: {
    label: "Marry",
    className: "border-emerald-200/55 bg-emerald-500/20 text-emerald-50 shadow-[0_12px_28px_rgba(16,185,129,0.22)]",
    selectedClassName: "ring-2 ring-emerald-100 bg-emerald-500/45",
  },
  kill: {
    label: "Kill",
    className: "border-orange-200/55 bg-orange-500/20 text-orange-50 shadow-[0_12px_28px_rgba(249,115,22,0.24)]",
    selectedClassName: "ring-2 ring-orange-100 bg-orange-500/45",
  },
};

function BackArrowIcon({ className = "h-4 w-4" }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden>
      <path d="M9.5 4.5 4.5 10l5 5M5 10h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function MaskIcon({ className = "h-5 w-5" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path
        d="M4.5 8.7c4.9-2.1 10.1-2.1 15 0v3.2c0 3.1-2.4 5.6-5.4 5.6-1.1 0-1.9-.3-2.1-.3s-1 .3-2.1.3c-3 0-5.4-2.5-5.4-5.6V8.7Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path d="M8 12.2h3M13 12.2h3M9 15c1 .8 2 .8 3 0 1 .8 2 .8 3 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function CheckIcon({ className = "h-4 w-4" }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden>
      <path d="m4.5 10.4 3.2 3.2 7.8-7.9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function parseVibeCheck(value: string): string[] {
  const normalized = value.replace(/\r/g, "\n");
  const parts = normalized
    .split(/\n|;|\|/)
    .map((item) => item.replace(/^[-*•]\s*/, "").trim())
    .filter(Boolean);
  return parts.length > 0 ? parts.slice(0, 5) : [value.trim()].filter(Boolean);
}

function themeClassFor(value: string | undefined): string {
  return BLIND_THEME_CLASSES[value ?? ""] ?? BLIND_THEME_CLASSES["bg-gradient-to-br from-fuchsia-600 via-violet-600 to-cyan-500"];
}

export function BlindModeRound({ accessToken, onBackToMenu, onRoundSubmitted }: BlindModeRoundProps) {
  const [roundResult, setRoundResult] = useState<BlindModeRoundResult | null>(null);
  const [selectedAction, setSelectedAction] = useState<VoteType | null>(null);
  const [submitResult, setSubmitResult] = useState<BlindModeSubmitResponse | null>(null);
  const [isLoadingRound, setIsLoadingRound] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadRound = useCallback(async () => {
    setIsLoadingRound(true);
    setSelectedAction(null);
    setSubmitResult(null);
    setError(null);
    try {
      const nextRound = await fetchBlindModeRound(accessToken);
      setRoundResult(nextRound);
    } catch (loadError) {
      const message = loadError instanceof Error ? loadError.message : "Could not load Blind Mode.";
      setError(message);
      setRoundResult(null);
    } finally {
      setIsLoadingRound(false);
    }
  }, [accessToken]);

  useEffect(() => {
    void loadRound();
  }, [loadRound]);

  const vibeItems = useMemo(
    () => parseVibeCheck(roundResult?.round.vibe_check ?? ""),
    [roundResult?.round.vibe_check]
  );
  const resolvedThemeClass = themeClassFor(roundResult?.round.aesthetic_theme);
  const canSubmit = Boolean(roundResult?.roundToken && selectedAction && !submitResult);

  const submitChoice = async () => {
    if (!roundResult?.roundToken || !selectedAction || isSubmitting || submitResult) {
      return;
    }

    setIsSubmitting(true);
    setError(null);
    try {
      const result = await submitBlindModeChoice(
        {
          action: selectedAction,
          round_token: roundResult.roundToken,
        },
        accessToken
      );
      setSubmitResult(result);
      onRoundSubmitted?.();
    } catch (submitError) {
      const message = submitError instanceof Error ? submitError.message : "Could not submit Blind Mode choice.";
      setError(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <section className="w-full space-y-4 rounded-[30px] border border-fuchsia-200/20 bg-[linear-gradient(180deg,rgba(17,10,35,0.94)_0%,rgba(4,12,32,0.94)_100%)] p-3.5 shadow-[0_30px_90px_rgba(1,4,12,0.78)] backdrop-blur-xl sm:p-4">
      <header className="rounded-3xl border border-fuchsia-200/20 bg-[#080d26]/85 px-3 py-3 shadow-[inset_0_0_0_1px_rgba(80,45,120,0.45)]">
        <div className="flex items-start justify-between gap-2.5">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-fuchsia-200/35 bg-fuchsia-500/20 text-fuchsia-100 shadow-[0_0_22px_rgba(217,70,239,0.25)]">
              <MaskIcon className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <p className="truncate text-[30px] font-bold leading-tight text-white sm:text-[34px]">Blind Mode</p>
              <p className="truncate text-xs uppercase tracking-[0.18em] text-fuchsia-100/70">Anonymous Round</p>
            </div>
          </div>
          {onBackToMenu && (
            <button
              type="button"
              onClick={onBackToMenu}
              className="inline-flex min-h-11 shrink-0 items-center justify-center gap-1.5 rounded-full border border-violet-300/30 bg-[#1a1740]/85 px-3.5 text-xs font-semibold text-violet-100 transition-colors duration-200 active:bg-[#251d56] sm:text-sm"
            >
              <BackArrowIcon className="h-4 w-4" />
              Back
            </button>
          )}
        </div>
      </header>

      {error && <p className="rounded-2xl border border-red-300/30 bg-red-500/15 px-3 py-2 text-sm text-red-100">{error}</p>}

      {isLoadingRound ? (
        <div className="rounded-[28px] border border-fuchsia-200/20 bg-[#0a1029]/80 p-4">
          <div className="skeleton-shimmer h-[420px] rounded-[24px]" />
        </div>
      ) : roundResult ? (
        <motion.article
          key={roundResult.roundToken}
          initial={{ opacity: 0, y: 14, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.28, ease: "easeOut" }}
          className={`relative overflow-hidden rounded-[28px] border border-white/20 ${resolvedThemeClass} p-[1px] shadow-[0_24px_70px_rgba(0,0,0,0.45)]`}
        >
          <div className="min-h-[430px] rounded-[27px] bg-slate-950/22 p-4 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.22)] backdrop-blur-sm sm:p-5">
            <div className="flex min-h-[398px] flex-col justify-between rounded-[22px] border border-white/20 bg-black/18 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.12)]">
              <div>
                <span className="inline-flex rounded-full border border-white/30 bg-white/15 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-white/90">
                  Unknown Profile
                </span>
                <h2 className="mt-5 text-[33px] font-black leading-[0.98] text-white drop-shadow-[0_10px_24px_rgba(0,0,0,0.3)] sm:text-[38px]">
                  {roundResult.round.anonymous_hook}
                </h2>
              </div>

              <div className="space-y-4">
                <div className="rounded-2xl border border-white/25 bg-white/16 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.14)]">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-white/70">Controversial Take</p>
                  <p className="mt-2 text-xl font-black leading-tight text-white sm:text-2xl">
                    {roundResult.round.unpopular_opinion}
                  </p>
                </div>

                <ul className="space-y-2.5 rounded-2xl border border-white/20 bg-black/16 p-4 text-sm font-semibold text-white/92">
                  {vibeItems.map((item, index) => (
                    <li key={`${item}-${index}`} className="flex gap-2.5">
                      <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-white/85" />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </motion.article>
      ) : (
        <p className="rounded-2xl border border-amber-300/35 bg-amber-500/15 px-3 py-2 text-sm text-amber-100">
          No Blind Mode profile is available right now.
        </p>
      )}

      <div className="grid grid-cols-3 gap-2.5">
        {(Object.keys(actionStyles) as VoteType[]).map((action) => {
          const meta = actionStyles[action];
          const isSelected = selectedAction === action;
          return (
            <button
              key={action}
              type="button"
              disabled={isLoadingRound || isSubmitting || Boolean(submitResult)}
              onClick={() => setSelectedAction(action)}
              className={`inline-flex min-h-12 items-center justify-center rounded-2xl border px-2 text-sm font-black uppercase tracking-wide transition-transform duration-200 hover:scale-105 active:brightness-110 disabled:cursor-not-allowed disabled:opacity-55 ${meta.className} ${
                isSelected ? meta.selectedClassName : ""
              }`}
            >
              {meta.label}
            </button>
          );
        })}
      </div>

      <button
        type="button"
        disabled={!canSubmit || isSubmitting}
        onClick={() => {
          void submitChoice();
        }}
        className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-full border border-white/25 bg-gradient-to-r from-fuchsia-500 via-violet-500 to-cyan-400 px-4 py-2 text-sm font-black uppercase tracking-[0.14em] text-white shadow-[0_16px_34px_rgba(103,58,183,0.38)] transition-transform duration-200 hover:scale-105 active:brightness-110 disabled:cursor-not-allowed disabled:opacity-55"
      >
        <CheckIcon className="h-4 w-4" />
        {isSubmitting ? "Submitting..." : "Lock In Choice"}
      </button>

      {submitResult ? (
        <div className="rounded-3xl border border-emerald-200/30 bg-emerald-500/12 p-3 text-emerald-50">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-100/75">Revealed</p>
          <div className="mt-3 flex items-center gap-3">
            <div className="h-16 w-16 shrink-0 overflow-hidden rounded-2xl border border-white/20 bg-slate-900">
              {submitResult.revealed_profile.profile_image_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={submitResult.revealed_profile.profile_image_url}
                  alt={submitResult.revealed_profile.name}
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-sm font-black text-slate-300">KMK</div>
              )}
            </div>
            <div className="min-w-0">
              <p className="truncate text-xl font-black text-white">{submitResult.revealed_profile.name}</p>
              <p className="mt-1 text-xs uppercase tracking-[0.16em] text-emerald-100/70">
                {submitResult.action} saved
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              void loadRound();
            }}
            className="mt-3 inline-flex min-h-11 w-full items-center justify-center rounded-2xl border border-emerald-200/35 bg-emerald-400/20 px-4 text-sm font-bold text-emerald-50 transition-transform duration-200 hover:scale-105 active:brightness-110"
          >
            Next Blind Card
          </button>
        </div>
      ) : null}
    </section>
  );
}
