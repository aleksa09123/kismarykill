"use client";

import { motion } from "framer-motion";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { API_BASE_URL, fetchLocationOptions } from "@/lib/api";
import {
  GLOBAL_LOCATION_OPTION,
  readInitialLocationClient
} from "@/lib/location-storage";
import type { AuthUser, LocationOptionCountry, VoteType } from "@/lib/types";

type BlindModeRoundProps = {
  accessToken: string;
  currentUser: AuthUser;
  onBackToMenu?: () => void;
  onRoundSubmitted?: () => void;
};

type BlindPhase = "setup" | "queue" | "vibe" | "reveal";
type ConnectionStatus = "idle" | "connecting" | "connected";

type WsPayload = Record<string, unknown> & {
  type?: string;
  room_id?: string;
  peer_id?: unknown;
  from_user_id?: unknown;
  target_user_id?: unknown;
  initiator?: unknown;
  vibe_check_seconds?: unknown;
  reveal_at?: unknown;
  your_choice?: unknown;
  peer_choice?: unknown;
  action?: unknown;
  choice?: unknown;
  sdp?: unknown;
  candidate?: unknown;
  mid?: unknown;
  mline_index?: unknown;
  detail?: unknown;
  reason?: unknown;
  requeue?: unknown;
};

type StreamVideoProps = {
  stream: MediaStream | null;
  className: string;
  muted?: boolean;
};

type IconProps = {
  className?: string;
};

const RTC_CONFIGURATION: RTCConfiguration = {
  iceServers: [
    {
      urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"],
    },
  ],
};

const VIBE_CHECK_SECONDS = 25;
const GLOBAL_EXPANSION_SECONDS = 7;
const PING_INTERVAL_MS = 10000;

const actionStyles: Record<VoteType, { label: string; className: string; selectedClassName: string }> = {
  kiss: {
    label: "Kiss \uD83D\uDC8B",
    className: "border-rose-300/60 bg-rose-500/18 text-rose-50 shadow-[0_14px_30px_rgba(244,63,94,0.24)]",
    selectedClassName: "ring-2 ring-rose-100 bg-rose-500/45",
  },
  marry: {
    label: "Marry \uD83D\uDC8D",
    className: "border-emerald-300/60 bg-emerald-500/18 text-emerald-50 shadow-[0_14px_30px_rgba(16,185,129,0.22)]",
    selectedClassName: "ring-2 ring-emerald-100 bg-emerald-500/45",
  },
  kill: {
    label: "Kill \uD83D\uDC80",
    className: "border-orange-300/60 bg-orange-500/18 text-orange-50 shadow-[0_14px_30px_rgba(249,115,22,0.24)]",
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

function XIcon({ className = "h-4 w-4" }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden>
      <path d="m5 5 10 10M15 5 5 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function StreamVideo({ stream, className, muted = false }: StreamVideoProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    if (!videoRef.current) {
      return;
    }
    videoRef.current.srcObject = stream;
  }, [stream]);

  return <video ref={videoRef} autoPlay playsInline muted={muted} className={className} />;
}

function asInt(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeCountryCode(value: string | null | undefined): string {
  return (value || "").trim().toUpperCase() || GLOBAL_LOCATION_OPTION.country_code;
}

function actionLabel(action: VoteType | null): string {
  if (action === "kiss") {
    return "Kiss";
  }
  if (action === "marry") {
    return "Marry";
  }
  if (action === "kill") {
    return "Kill";
  }
  return "No choice locked";
}

function buildBlindWsUrl(accessToken: string, countryCode: string): string {
  const explicitBase = (process.env.NEXT_PUBLIC_BLIND_WS_URL ?? "").trim();
  const encodedCountry = encodeURIComponent(countryCode);
  const encodedToken = encodeURIComponent(accessToken);

  if (explicitBase) {
    const templated = explicitBase
      .replace("{country}", encodedCountry)
      .replace("{country_code}", encodedCountry)
      .replace("{token}", encodedToken);
    if (templated !== explicitBase) {
      return templated;
    }
    const separator = templated.includes("?") ? "&" : "?";
    return `${templated.replace(/\/+$/, "")}${separator}country=${encodedCountry}&token=${encodedToken}`;
  }

  const fallbackHttpBase = API_BASE_URL || "https://kissmarykill-backend.onrender.com";
  const withoutTrailingSlash = fallbackHttpBase.replace(/\/+$/, "").replace(/\/api$/i, "");
  const wsBase = withoutTrailingSlash.replace(/^http:\/\//i, "ws://").replace(/^https:\/\//i, "wss://");
  return `${wsBase}/ws/blind-mode?country=${encodedCountry}&token=${encodedToken}`;
}

function initialCountryCode(user: AuthUser): string {
  const storedLocation = readInitialLocationClient();
  return normalizeCountryCode(storedLocation?.country_code ?? user.country_code ?? GLOBAL_LOCATION_OPTION.country_code);
}

export function BlindModeRound({ accessToken, currentUser, onBackToMenu, onRoundSubmitted }: BlindModeRoundProps) {
  const [phase, setPhase] = useState<BlindPhase>("setup");
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("idle");
  const [countries, setCountries] = useState<LocationOptionCountry[]>([GLOBAL_LOCATION_OPTION]);
  const [selectedCountryCode, setSelectedCountryCode] = useState(() => initialCountryCode(currentUser));
  const [isSearchExpanded, setIsSearchExpanded] = useState(false);
  const [countdown, setCountdown] = useState(VIBE_CHECK_SECONDS);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [peerId, setPeerId] = useState<number | null>(null);
  const [selectedAction, setSelectedAction] = useState<VoteType | null>(null);
  const [peerAction, setPeerAction] = useState<VoteType | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const countdownTimerRef = useRef<number | null>(null);
  const globalExpansionTimerRef = useRef<number | null>(null);
  const pingTimerRef = useRef<number | null>(null);
  const hasSubmittedChoiceRef = useRef(false);
  const phaseRef = useRef<BlindPhase>("setup");

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  const selectedCountry = useMemo(
    () => countries.find((country) => country.country_code === selectedCountryCode) ?? GLOBAL_LOCATION_OPTION,
    [countries, selectedCountryCode]
  );

  const queueText = isSearchExpanded
    ? "Expanding search globally..."
    : `Searching for matches in ${selectedCountry.country_name}...`;

  const sendSocketMessage = useCallback((payload: Record<string, unknown>): boolean => {
    const socket = wsRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    socket.send(JSON.stringify(payload));
    return true;
  }, []);

  const clearCountdownTimer = useCallback(() => {
    if (countdownTimerRef.current !== null) {
      window.clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
  }, []);

  const clearGlobalExpansionTimer = useCallback(() => {
    if (globalExpansionTimerRef.current !== null) {
      window.clearTimeout(globalExpansionTimerRef.current);
      globalExpansionTimerRef.current = null;
    }
  }, []);

  const stopSocketPing = useCallback(() => {
    if (pingTimerRef.current !== null) {
      window.clearInterval(pingTimerRef.current);
      pingTimerRef.current = null;
    }
  }, []);

  const closePeerConnection = useCallback(() => {
    peerConnectionRef.current?.close();
    peerConnectionRef.current = null;
    pendingCandidatesRef.current = [];
    setRemoteStream(null);
  }, []);

  const stopLocalMedia = useCallback(() => {
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
  }, []);

  const resetMatchState = useCallback(() => {
    clearCountdownTimer();
    closePeerConnection();
    setRoomId(null);
    setPeerId(null);
    setSelectedAction(null);
    setPeerAction(null);
    setCountdown(VIBE_CHECK_SECONDS);
    hasSubmittedChoiceRef.current = false;
  }, [clearCountdownTimer, closePeerConnection]);

  const ensureLocalMedia = useCallback(async (): Promise<MediaStream> => {
    if (localStreamRef.current) {
      return localStreamRef.current;
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    localStreamRef.current = stream;
    return stream;
  }, []);

  const createPeerConnection = useCallback(
    (nextPeerId: number): RTCPeerConnection => {
      if (peerConnectionRef.current) {
        return peerConnectionRef.current;
      }

      const peerConnection = new RTCPeerConnection(RTC_CONFIGURATION);
      peerConnectionRef.current = peerConnection;

      // Add both tracks up front: audio is heard during the black-screen phase,
      // while remote video is visually revealed only after the countdown.
      const activeLocalStream = localStreamRef.current;
      if (activeLocalStream) {
        activeLocalStream.getTracks().forEach((track) => {
          peerConnection.addTrack(track, activeLocalStream);
        });
      }

      peerConnection.onicecandidate = (iceEvent) => {
        if (!iceEvent.candidate) {
          return;
        }
        sendSocketMessage({
          type: "ice_candidate",
          target_user_id: nextPeerId,
          candidate: iceEvent.candidate,
        });
      };

      peerConnection.ontrack = (trackEvent) => {
        const stream = trackEvent.streams[0];
        if (stream) {
          setRemoteStream(stream);
        }
      };

      peerConnection.onconnectionstatechange = () => {
        if (peerConnection.connectionState === "failed" || peerConnection.connectionState === "closed") {
          closePeerConnection();
        }
      };

      return peerConnection;
    },
    [closePeerConnection, sendSocketMessage]
  );

  const applyPendingCandidates = useCallback(async (peerConnection: RTCPeerConnection) => {
    const pending = pendingCandidatesRef.current;
    if (pending.length === 0) {
      return;
    }
    pendingCandidatesRef.current = [];
    for (const candidate of pending) {
      try {
        await peerConnection.addIceCandidate(candidate);
      } catch {
        // Browser ICE implementations can reject stale candidates after renegotiation.
      }
    }
  }, []);

  const startCountdown = useCallback(
    (durationSeconds: number, revealAt: unknown) => {
      clearCountdownTimer();
      const revealAtMs = typeof revealAt === "string" ? Date.parse(revealAt) : Number.NaN;
      const endAt = Number.isFinite(revealAtMs) ? revealAtMs : Date.now() + durationSeconds * 1000;

      setCountdown(Math.max(0, Math.ceil((endAt - Date.now()) / 1000)));
      countdownTimerRef.current = window.setInterval(() => {
        const remaining = Math.max(0, Math.ceil((endAt - Date.now()) / 1000));
        setCountdown(remaining);
        if (remaining <= 0) {
          clearCountdownTimer();
          setPhase((currentPhase) => (currentPhase === "vibe" ? "reveal" : currentPhase));
        }
      }, 250);
    },
    [clearCountdownTimer]
  );

  const handleSignalingPayload = useCallback(
    async (payload: WsPayload, messageType: string) => {
      const incomingPeerId = asInt(payload.from_user_id ?? payload.peer_id);
      if (incomingPeerId === null) {
        return;
      }
      const peerConnection = createPeerConnection(incomingPeerId);

      if (messageType === "offer") {
        const sessionDescription = payload.sdp as RTCSessionDescriptionInit | undefined;
        if (!sessionDescription || typeof sessionDescription !== "object") {
          return;
        }
        try {
          if (peerConnection.signalingState !== "stable") {
            try {
              await peerConnection.setLocalDescription({ type: "rollback" });
            } catch {
              // Some browsers do not support rollback in every state.
            }
          }
          await peerConnection.setRemoteDescription(sessionDescription);
          const answer = await peerConnection.createAnswer();
          await peerConnection.setLocalDescription(answer);
          sendSocketMessage({
            type: "answer",
            target_user_id: incomingPeerId,
            sdp: peerConnection.localDescription,
          });
          await applyPendingCandidates(peerConnection);
        } catch (offerError) {
          const message = offerError instanceof Error ? offerError.message : "Offer handling failed.";
          setError(`Signal error: ${message}`);
        }
        return;
      }

      if (messageType === "answer") {
        const sessionDescription = payload.sdp as RTCSessionDescriptionInit | undefined;
        if (!sessionDescription || typeof sessionDescription !== "object") {
          return;
        }
        try {
          await peerConnection.setRemoteDescription(sessionDescription);
          await applyPendingCandidates(peerConnection);
        } catch (answerError) {
          const message = answerError instanceof Error ? answerError.message : "Answer handling failed.";
          setError(`Signal error: ${message}`);
        }
        return;
      }

      const rawCandidate = payload.candidate;
      let candidateToApply: RTCIceCandidateInit | null = null;
      if (rawCandidate && typeof rawCandidate === "object") {
        const parsedCandidate = rawCandidate as RTCIceCandidateInit;
        candidateToApply = {
          ...parsedCandidate,
          sdpMid: parsedCandidate.sdpMid ?? (typeof payload.mid === "string" ? payload.mid : undefined),
          sdpMLineIndex:
            parsedCandidate.sdpMLineIndex ??
            (typeof payload.mline_index === "number" ? payload.mline_index : undefined),
        };
      } else if (typeof rawCandidate === "string" && rawCandidate.length > 0) {
        candidateToApply = {
          candidate: rawCandidate,
          sdpMid: typeof payload.mid === "string" ? payload.mid : undefined,
          sdpMLineIndex: typeof payload.mline_index === "number" ? payload.mline_index : undefined,
        };
      }

      if (!candidateToApply) {
        return;
      }

      if (peerConnection.remoteDescription?.type) {
        try {
          await peerConnection.addIceCandidate(candidateToApply);
        } catch {
          // Ignore invalid ICE from interrupted calls.
        }
      } else {
        pendingCandidatesRef.current.push(candidateToApply);
      }
    },
    [applyPendingCandidates, createPeerConnection, sendSocketMessage]
  );

  const handleMatchFound = useCallback(
    async (payload: WsPayload) => {
      const incomingPeerId = asInt(payload.peer_id);
      const incomingRoomId = String(payload.room_id ?? "").trim();
      if (!incomingRoomId || incomingPeerId === null) {
        setError("Server returned incomplete Blind Mode match data.");
        return;
      }

      clearGlobalExpansionTimer();
      resetMatchState();
      setRoomId(incomingRoomId);
      setPeerId(incomingPeerId);
      setPhase("vibe");
      setConnectionStatus("connected");
      setError(null);

      try {
        await ensureLocalMedia();
        const peerConnection = createPeerConnection(incomingPeerId);
        const duration = Math.max(
          1,
          Number.parseInt(String(payload.vibe_check_seconds ?? VIBE_CHECK_SECONDS), 10)
        );
        startCountdown(duration, payload.reveal_at);

        if (Boolean(payload.initiator)) {
          const offer = await peerConnection.createOffer();
          await peerConnection.setLocalDescription(offer);
          sendSocketMessage({
            type: "offer",
            target_user_id: incomingPeerId,
            sdp: peerConnection.localDescription,
          });
        }
      } catch (mediaError) {
        const message = mediaError instanceof Error ? mediaError.message : "Could not open camera and microphone.";
        setError(message);
      }
    },
    [
      clearGlobalExpansionTimer,
      createPeerConnection,
      ensureLocalMedia,
      resetMatchState,
      sendSocketMessage,
      startCountdown,
    ]
  );

  const attachSocketHandlers = useCallback(
    (socket: WebSocket) => {
      socket.onopen = () => {
        setConnectionStatus("connected");
        setError(null);
        if (pingTimerRef.current === null) {
          pingTimerRef.current = window.setInterval(() => {
            sendSocketMessage({ type: "ping" });
          }, PING_INTERVAL_MS);
        }
      };

      socket.onmessage = (event: MessageEvent<string>) => {
        const parseIncoming = async () => {
          let payload: WsPayload | null = null;
          try {
            payload = JSON.parse(event.data) as WsPayload;
          } catch {
            setError("Invalid message from Blind Mode server.");
            return;
          }
          if (!payload || typeof payload !== "object") {
            return;
          }

          const messageType = String(payload.type ?? "").trim().toLowerCase();
          if (!messageType || messageType === "connected" || messageType === "pong") {
            return;
          }

          if (messageType === "queue_joined") {
            setPhase("queue");
            setIsSearchExpanded(false);
            clearGlobalExpansionTimer();
            globalExpansionTimerRef.current = window.setTimeout(() => {
              setIsSearchExpanded(true);
            }, GLOBAL_EXPANSION_SECONDS * 1000);
            return;
          }

          if (messageType === "search_expanded") {
            setIsSearchExpanded(true);
            return;
          }

          if (messageType === "match_found") {
            await handleMatchFound(payload);
            return;
          }

          if (messageType === "choice_locked") {
            const action = String(payload.action ?? "").trim().toLowerCase() as VoteType;
            if (action === "kiss" || action === "marry" || action === "kill") {
              setSelectedAction(action);
              if (!hasSubmittedChoiceRef.current) {
                hasSubmittedChoiceRef.current = true;
                onRoundSubmitted?.();
              }
            }
            return;
          }

          if (messageType === "reveal") {
            const yourChoice = String(payload.your_choice ?? "").trim().toLowerCase() as VoteType;
            const theirChoice = String(payload.peer_choice ?? "").trim().toLowerCase() as VoteType;
            setSelectedAction(yourChoice === "kiss" || yourChoice === "marry" || yourChoice === "kill" ? yourChoice : null);
            setPeerAction(theirChoice === "kiss" || theirChoice === "marry" || theirChoice === "kill" ? theirChoice : null);
            setCountdown(0);
            setPhase("reveal");
            clearCountdownTimer();
            return;
          }

          if (messageType === "room_closed" || messageType === "peer_left") {
            resetMatchState();
            setIsSearchExpanded(false);
            if (Boolean(payload.requeue)) {
              setPhase("queue");
              globalExpansionTimerRef.current = window.setTimeout(() => {
                setIsSearchExpanded(true);
              }, GLOBAL_EXPANSION_SECONDS * 1000);
            } else {
              setPhase("setup");
            }
            return;
          }

          if (messageType === "offer" || messageType === "answer" || messageType === "ice_candidate") {
            await handleSignalingPayload(payload, messageType);
            return;
          }

          if (messageType === "error") {
            setError(String(payload.detail ?? "Blind Mode error"));
          }
        };

        void parseIncoming();
      };

      socket.onerror = () => {
        setConnectionStatus("connecting");
        setError("Blind Mode connection interrupted.");
      };

      socket.onclose = () => {
        wsRef.current = null;
        stopSocketPing();
        if (phaseRef.current !== "setup") {
          resetMatchState();
          setPhase("setup");
          setConnectionStatus("idle");
        }
      };
    },
    [
      clearCountdownTimer,
      clearGlobalExpansionTimer,
      handleMatchFound,
      handleSignalingPayload,
      onRoundSubmitted,
      resetMatchState,
      sendSocketMessage,
      stopSocketPing,
    ]
  );

  const joinQueue = useCallback(async () => {
    setError(null);
    setPhase("queue");
    setConnectionStatus("connecting");
    setIsSearchExpanded(false);
    resetMatchState();
    clearGlobalExpansionTimer();
    globalExpansionTimerRef.current = window.setTimeout(() => {
      setIsSearchExpanded(true);
    }, GLOBAL_EXPANSION_SECONDS * 1000);

    try {
      await ensureLocalMedia();
    } catch (mediaError) {
      const message = mediaError instanceof Error ? mediaError.message : "Could not open camera and microphone.";
      setError(message);
      setPhase("setup");
      setConnectionStatus("idle");
      clearGlobalExpansionTimer();
      return;
    }

    const existingSocket = wsRef.current;
    if (existingSocket && existingSocket.readyState === WebSocket.OPEN) {
      sendSocketMessage({
        type: "join_queue",
        country: selectedCountryCode,
      });
      return;
    }

    const socket = new WebSocket(buildBlindWsUrl(accessToken, selectedCountryCode));
    wsRef.current = socket;
    attachSocketHandlers(socket);
  }, [
    accessToken,
    attachSocketHandlers,
    clearGlobalExpansionTimer,
    ensureLocalMedia,
    resetMatchState,
    selectedCountryCode,
    sendSocketMessage,
  ]);

  const lockChoice = useCallback(
    (action: VoteType) => {
      if (phase !== "vibe" || selectedAction) {
        return;
      }
      setSelectedAction(action);
      sendSocketMessage({
        type: "choice",
        room_id: roomId,
        choice: action,
      });
    },
    [phase, roomId, selectedAction, sendSocketMessage]
  );

  const requestNextMatch = useCallback(() => {
    sendSocketMessage({ type: "next_match", room_id: roomId });
    resetMatchState();
    setPhase("queue");
    setIsSearchExpanded(false);
    clearGlobalExpansionTimer();
    globalExpansionTimerRef.current = window.setTimeout(() => {
      setIsSearchExpanded(true);
    }, GLOBAL_EXPANSION_SECONDS * 1000);
  }, [clearGlobalExpansionTimer, resetMatchState, roomId, sendSocketMessage]);

  const leaveBlindMode = useCallback(() => {
    wsRef.current?.close(1000, "blind_mode_exit");
    wsRef.current = null;
    stopSocketPing();
    clearGlobalExpansionTimer();
    resetMatchState();
    stopLocalMedia();
    setPhase("setup");
    setConnectionStatus("idle");
    onBackToMenu?.();
  }, [clearGlobalExpansionTimer, onBackToMenu, resetMatchState, stopLocalMedia, stopSocketPing]);

  useEffect(() => {
    let cancelled = false;
    const loadCountries = async () => {
      try {
        const options = await fetchLocationOptions();
        if (cancelled) {
          return;
        }
        const normalized = [
          GLOBAL_LOCATION_OPTION,
          ...options
            .filter((country) => country.country_code && country.country_name)
            .filter((country) => country.country_code !== GLOBAL_LOCATION_OPTION.country_code),
        ];
        setCountries(normalized);
        if (!normalized.some((country) => country.country_code === selectedCountryCode)) {
          setSelectedCountryCode(normalized[0]?.country_code ?? GLOBAL_LOCATION_OPTION.country_code);
        }
      } catch {
        if (!cancelled) {
          setCountries([GLOBAL_LOCATION_OPTION]);
        }
      }
    };
    void loadCountries();
    return () => {
      cancelled = true;
    };
  }, [selectedCountryCode]);

  useEffect(() => {
    return () => {
      wsRef.current?.close(1000, "blind_mode_unmount");
      stopSocketPing();
      clearGlobalExpansionTimer();
      clearCountdownTimer();
      closePeerConnection();
      stopLocalMedia();
    };
  }, [clearCountdownTimer, clearGlobalExpansionTimer, closePeerConnection, stopLocalMedia, stopSocketPing]);

  const showCallSurface = phase === "vibe" || phase === "reveal";
  const overlayClassName =
    phase === "reveal"
      ? "opacity-0 pointer-events-none transition-opacity duration-500"
      : "opacity-100 transition-opacity duration-500";

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
              <p className="truncate text-xs uppercase tracking-[0.18em] text-fuchsia-100/70">
                {connectionStatus === "connected" ? "Live connection" : "Real-time queue"}
              </p>
            </div>
          </div>
          {onBackToMenu && (
            <button
              type="button"
              onClick={leaveBlindMode}
              className="inline-flex min-h-11 shrink-0 items-center justify-center gap-1.5 rounded-full border border-violet-300/30 bg-[#1a1740]/85 px-3.5 text-xs font-semibold text-violet-100 transition-colors duration-200 active:bg-[#251d56] sm:text-sm"
            >
              <BackArrowIcon className="h-4 w-4" />
              Back
            </button>
          )}
        </div>
      </header>

      {phase === "setup" || phase === "queue" ? (
        <div className="rounded-3xl border border-violet-200/20 bg-[#070d25]/86 p-3">
          <label className="mb-2 block text-[11px] font-semibold uppercase tracking-[0.18em] text-violet-100/70">
            Country
          </label>
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <select
              value={selectedCountryCode}
              disabled={phase === "queue"}
              onChange={(event) => setSelectedCountryCode(event.target.value)}
              className="min-h-11 rounded-2xl border border-violet-200/25 bg-[#0b1431] px-3 text-sm font-semibold text-white outline-none focus:border-cyan-200/60 disabled:opacity-60"
            >
              {countries.map((country) => (
                <option key={country.country_code} value={country.country_code} className="bg-[#0b1431] text-white">
                  {country.country_name}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={phase === "queue" || connectionStatus === "connecting"}
              onClick={() => {
                void joinQueue();
              }}
              className="inline-flex min-h-11 items-center justify-center rounded-2xl border border-cyan-200/35 bg-cyan-400/18 px-4 text-sm font-black uppercase tracking-wide text-cyan-50 transition-transform duration-200 hover:scale-105 active:brightness-110 disabled:cursor-not-allowed disabled:opacity-55"
            >
              Join
            </button>
          </div>
        </div>
      ) : null}

      {error && <p className="rounded-2xl border border-red-300/30 bg-red-500/15 px-3 py-2 text-sm text-red-100">{error}</p>}

      {phase === "queue" ? (
        <div className="flex min-h-[420px] flex-col items-center justify-center rounded-[28px] border border-violet-200/20 bg-[#050816]/92 p-5 text-center">
          <span className="h-14 w-14 animate-spin rounded-full border-4 border-violet-200/25 border-t-cyan-200" />
          <p className="mt-5 text-lg font-black text-white">{queueText}</p>
          <p className="mt-2 text-xs uppercase tracking-[0.2em] text-violet-100/55">Blind queue</p>
        </div>
      ) : null}

      {showCallSurface ? (
        <div className="relative min-h-[540px] overflow-hidden rounded-[28px] border border-white/15 bg-black shadow-[0_24px_70px_rgba(0,0,0,0.45)]">
          <StreamVideo
            stream={remoteStream}
            className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-500 ${
              phase === "reveal" ? "opacity-100" : "opacity-0"
            }`}
          />

          <div className={`bg-black w-full h-full absolute inset-0 z-50 flex flex-col justify-center items-center ${overlayClassName}`}>
            <div className="text-center">
              <p className="text-[92px] font-black leading-none text-white drop-shadow-[0_18px_34px_rgba(255,255,255,0.14)]">
                {countdown}
              </p>
              <p className="mt-3 text-xs font-semibold uppercase tracking-[0.22em] text-white/55">
                Vibe Check
              </p>
            </div>

            <div className="absolute inset-x-3 bottom-5 grid grid-cols-3 gap-2.5">
              {(Object.keys(actionStyles) as VoteType[]).map((action) => {
                const meta = actionStyles[action];
                const isSelected = selectedAction === action;
                return (
                  <button
                    key={action}
                    type="button"
                    disabled={phase !== "vibe" || Boolean(selectedAction)}
                    onClick={() => lockChoice(action)}
                    className={`inline-flex min-h-12 items-center justify-center rounded-2xl border px-1.5 text-xs font-black uppercase tracking-wide transition-transform duration-200 hover:scale-105 active:brightness-110 disabled:cursor-not-allowed disabled:opacity-60 sm:text-sm ${meta.className} ${
                      isSelected ? meta.selectedClassName : ""
                    }`}
                  >
                    {meta.label}
                  </button>
                );
              })}
            </div>
          </div>

          {phase === "reveal" ? (
            <button
              type="button"
              aria-label="Disconnect and find next match"
              onClick={requestNextMatch}
              className="absolute right-3 top-3 z-[60] inline-flex h-11 w-11 items-center justify-center rounded-full border border-white/25 bg-black/60 text-white shadow-[0_12px_24px_rgba(0,0,0,0.35)] transition-transform duration-200 hover:scale-105 active:brightness-125"
            >
              <XIcon className="h-5 w-5" />
            </button>
          ) : null}

          {phase === "reveal" ? (
            <motion.div
              initial={{ opacity: 0, y: 28 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ type: "spring", stiffness: 210, damping: 24 }}
              className="absolute inset-x-3 bottom-3 z-40 rounded-3xl border border-white/20 bg-[#071126]/92 p-4 text-white shadow-[0_22px_50px_rgba(0,0,0,0.45)] backdrop-blur"
            >
              <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan-100/70">
                Room {roomId ?? "active"} {peerId ? `#${peerId}` : ""}
              </p>
              <div className="mt-3 grid grid-cols-2 gap-3">
                <div className="rounded-2xl border border-cyan-200/20 bg-cyan-400/10 p-3">
                  <p className="text-[11px] uppercase tracking-[0.18em] text-cyan-100/65">You chose</p>
                  <p className="mt-1 text-xl font-black">{actionLabel(selectedAction)}</p>
                </div>
                <div className="rounded-2xl border border-fuchsia-200/20 bg-fuchsia-400/10 p-3">
                  <p className="text-[11px] uppercase tracking-[0.18em] text-fuchsia-100/65">They chose</p>
                  <p className="mt-1 text-xl font-black">{actionLabel(peerAction)}</p>
                </div>
              </div>
            </motion.div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
