"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { API_BASE_URL } from "@/lib/api";
import { LIVE_ACTIVITY_STORAGE_KEY } from "@/components/version-sentinel";
import { safeRemoveStorageItem, safeSetStorageItem } from "@/lib/safe-storage";
import type { AuthUser } from "@/lib/types";

type LiveModeRoundProps = {
  currentUser: AuthUser;
  onBackToMenu?: () => void;
};

type LiveRole = "judge" | "contestant";
type ConnectionStatus = "disconnected" | "connecting" | "connected";
type LiveViewState = "lobby" | "searching" | "match";
type LivePhase = "LOBBY" | "INTRO" | "BATTLE" | "JUDGMENT" | "AD_PHASE";
type LiveJudgeAction = "kiss" | "marry" | "kill";

type WsPayload = Record<string, unknown> & {
  type?: string;
  action?: string;
  room_id?: string;
  role?: string;
  participants?: unknown;
  user_id?: unknown;
  from_user_id?: unknown;
  target_user_id?: unknown;
  duration?: unknown;
  detail?: unknown;
  reason?: unknown;
  sdp?: unknown;
  candidate?: unknown;
  mid?: unknown;
  mline_index?: unknown;
};

type StreamVideoProps = {
  stream: MediaStream | null;
  className: string;
  muted?: boolean;
};

const RTC_CONFIGURATION: RTCConfiguration = {
  iceServers: [
    {
      urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"],
    },
  ],
};

const ROUND_FADE_OUT_MS = 460;
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 15000;
const PHASE_TICK_INTERVAL_MS = 250;
const MATCH_SEARCH_TIMEOUT_MS = 20000;
const LIVE_WS_PING_INTERVAL_MS = 10000;
const LIVE_AD_DEFAULT_DURATION_SECONDS = 15;
const ADSENSE_CLIENT_ID = "ca-pub-1680175309169171";
const ADSENSE_INTERSTITIAL_SLOT_ID = process.env.NEXT_PUBLIC_ADSENSE_INTERSTITIAL_SLOT_ID?.trim() ?? "";

function reconnectDelayForAttempt(attempt: number): number {
  const exponentialDelay = RECONNECT_BASE_DELAY_MS * 2 ** Math.max(0, attempt);
  const jitter = Math.floor(Math.random() * 350);
  return Math.min(RECONNECT_MAX_DELAY_MS, exponentialDelay + jitter);
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

function normalizeRole(value: unknown): LiveRole | null {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "judge" || normalized === "contestant") {
    return normalized;
  }
  return null;
}

function asInt(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return parsed;
}

function toIntList(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => asInt(item))
    .filter((item): item is number => item !== null);
}

function buildLiveWsUrl(userId: number): string {
  const explicitBase = (process.env.NEXT_PUBLIC_LIVE_WS_URL ?? "").trim();
  if (explicitBase) {
    const withUserTemplate = explicitBase.replace("{user_id}", String(userId)).replace("{userId}", String(userId));
    if (withUserTemplate !== explicitBase) {
      return withUserTemplate;
    }
    const normalizedBase = withUserTemplate.replace(/\/+$/, "");
    if (/\/ws\/live\/\d+$/i.test(normalizedBase)) {
      return normalizedBase;
    }
    if (/\/ws\/live$/i.test(normalizedBase)) {
      return `${normalizedBase}/${userId}`;
    }
    return `${normalizedBase}/ws/live/${userId}`;
  }

  const fallbackHttpBase = API_BASE_URL || "https://kissmarykill-backend.onrender.com";
  const withoutTrailingSlash = fallbackHttpBase.replace(/\/+$/, "");
  const withoutApiSuffix = withoutTrailingSlash.replace(/\/api$/i, "");
  const wsBase = withoutApiSuffix.replace(/^http:\/\//i, "ws://").replace(/^https:\/\//i, "wss://");
  return `${wsBase}/ws/live/${userId}`;
}

function formatSeconds(seconds: number): string {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const remainder = safe % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function roleLabel(role: LiveRole): string {
  return role === "judge" ? "Judge" : "Contestant";
}

function actionLabel(action: LiveJudgeAction): string {
  if (action === "kiss") {
    return "KISS";
  }
  if (action === "marry") {
    return "MARRY";
  }
  return "KILL";
}

function useStableBooleanRef(value: boolean) {
  const valueRef = useRef(value);
  useEffect(() => {
    valueRef.current = value;
  }, [value]);
  return valueRef;
}

export function LiveModeRound({ currentUser, onBackToMenu }: LiveModeRoundProps) {
  const [selectedRole, setSelectedRole] = useState<LiveRole>("contestant");
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("disconnected");
  const [viewState, setViewState] = useState<LiveViewState>("lobby");
  const [phase, setPhase] = useState<LivePhase>("LOBBY");
  const [phaseSecondsLeft, setPhaseSecondsLeft] = useState<number>(0);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [participants, setParticipants] = useState<number[]>([]);
  const [judgeId, setJudgeId] = useState<number | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStreams, setRemoteStreams] = useState<Record<number, MediaStream>>({});
  const [selectedTargetUserId, setSelectedTargetUserId] = useState<number | null>(null);
  const [eliminatedUserIds, setEliminatedUserIds] = useState<number[]>([]);
  const [fadeRoundOut, setFadeRoundOut] = useState(false);
  const [isLiveAdVisible, setIsLiveAdVisible] = useState(false);
  const [liveAdSecondsLeft, setLiveAdSecondsLeft] = useState(0);
  const [liveAdInstance, setLiveAdInstance] = useState(0);
  const [liveAdRenderError, setLiveAdRenderError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const pingIntervalRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);
  const searchTimeoutRef = useRef<number | null>(null);
  const phaseEndAtRef = useRef<number | null>(null);
  const phaseTickerRef = useRef<number | null>(null);
  const liveAdEndAtRef = useRef<number | null>(null);
  const liveAdTickerRef = useRef<number | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const peerConnectionsRef = useRef<Record<number, RTCPeerConnection>>({});
  const pendingCandidatesRef = useRef<Record<number, RTCIceCandidateInit[]>>({});
  const selectedRoleRef = useRef<LiveRole>(selectedRole);
  const viewStateRef = useRef<LiveViewState>(viewState);
  const roomIdRef = useRef<string | null>(roomId);
  const keepSearchingRef = useRef(false);
  const queuedJoinRef = useRef(false);
  const isUnmountedRef = useRef(false);

  const isSearchingRef = useStableBooleanRef(viewState === "searching");

  useEffect(() => {
    selectedRoleRef.current = selectedRole;
  }, [selectedRole]);

  useEffect(() => {
    viewStateRef.current = viewState;
    safeSetStorageItem(LIVE_ACTIVITY_STORAGE_KEY, viewState === "lobby" ? "0" : "1", "session");
  }, [viewState]);

  useEffect(() => {
    roomIdRef.current = roomId;
  }, [roomId]);

  useEffect(() => {
    if (!isLiveAdVisible || !ADSENSE_INTERSTITIAL_SLOT_ID) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      try {
        const adQueueHost = window as Window & { adsbygoogle?: Array<Record<string, unknown>> };
        adQueueHost.adsbygoogle = adQueueHost.adsbygoogle ?? [];
        adQueueHost.adsbygoogle.push({});
      } catch {
        setLiveAdRenderError("Ad failed to load. The live room will continue automatically.");
      }
    }, 0);

    return () => window.clearTimeout(timeoutId);
  }, [isLiveAdVisible, liveAdInstance]);

  const sendSocketMessage = useCallback((payload: Record<string, unknown>) => {
    const socket = wsRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    socket.send(JSON.stringify(payload));
    return true;
  }, []);

  const clearPhaseTicker = useCallback(() => {
    if (phaseTickerRef.current !== null) {
      window.clearInterval(phaseTickerRef.current);
      phaseTickerRef.current = null;
    }
    phaseEndAtRef.current = null;
  }, []);

  const stopSocketPing = useCallback(() => {
    if (pingIntervalRef.current !== null) {
      window.clearInterval(pingIntervalRef.current);
      pingIntervalRef.current = null;
    }
  }, []);

  const startSocketPing = useCallback(() => {
    stopSocketPing();
    pingIntervalRef.current = window.setInterval(() => {
      const socket = wsRef.current;
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "ping" }));
      }
    }, LIVE_WS_PING_INTERVAL_MS);
  }, [stopSocketPing]);

  const clearLiveAdTicker = useCallback(() => {
    if (liveAdTickerRef.current !== null) {
      window.clearInterval(liveAdTickerRef.current);
      liveAdTickerRef.current = null;
    }
    liveAdEndAtRef.current = null;
  }, []);

  const startLiveAd = useCallback(
    (durationSeconds: number) => {
      const safeDuration = Math.max(1, Math.trunc(durationSeconds || LIVE_AD_DEFAULT_DURATION_SECONDS));
      clearLiveAdTicker();
      clearPhaseTicker();
      setPhase("AD_PHASE");
      setPhaseSecondsLeft(safeDuration);
      setLiveAdSecondsLeft(safeDuration);
      setIsLiveAdVisible(true);
      setLiveAdRenderError(null);
      setLiveAdInstance((previous) => previous + 1);
      setStatusMessage("Sponsored video break. Live room is paused.");

      liveAdEndAtRef.current = Date.now() + safeDuration * 1000;
      liveAdTickerRef.current = window.setInterval(() => {
        const endAt = liveAdEndAtRef.current;
        if (!endAt) {
          return;
        }
        const remainingSeconds = Math.max(0, Math.ceil((endAt - Date.now()) / 1000));
        setLiveAdSecondsLeft(remainingSeconds);
        setPhaseSecondsLeft(remainingSeconds);
        if (remainingSeconds <= 0) {
          clearLiveAdTicker();
          setIsLiveAdVisible(false);
        }
      }, PHASE_TICK_INTERVAL_MS);
    },
    [clearLiveAdTicker, clearPhaseTicker]
  );

  const stopLocalMedia = useCallback(() => {
    const stream = localStreamRef.current;
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
    }
    localStreamRef.current = null;
    setLocalStream(null);
  }, []);

  const closePeerConnection = useCallback((peerUserId: number) => {
    const peerConnection = peerConnectionsRef.current[peerUserId];
    if (peerConnection) {
      try {
        peerConnection.onicecandidate = null;
        peerConnection.ontrack = null;
        peerConnection.onconnectionstatechange = null;
        peerConnection.close();
      } catch {
        // ignore close failures
      }
      delete peerConnectionsRef.current[peerUserId];
    }
    delete pendingCandidatesRef.current[peerUserId];
    setRemoteStreams((previous) => {
      if (previous[peerUserId] === undefined) {
        return previous;
      }
      const next = { ...previous };
      delete next[peerUserId];
      return next;
    });
  }, []);

  const closeAllPeerConnections = useCallback(() => {
    Object.keys(peerConnectionsRef.current).forEach((peerKey) => {
      const peerUserId = Number.parseInt(peerKey, 10);
      if (Number.isFinite(peerUserId)) {
        closePeerConnection(peerUserId);
      }
    });
    peerConnectionsRef.current = {};
    pendingCandidatesRef.current = {};
    setRemoteStreams({});
  }, [closePeerConnection]);

  const resetRoundState = useCallback(() => {
    setRoomId(null);
    setParticipants([]);
    setJudgeId(null);
    setSelectedTargetUserId(null);
    setEliminatedUserIds([]);
    setPhase("LOBBY");
    setPhaseSecondsLeft(0);
  }, []);

  const stopReconnectTimer = useCallback(() => {
    if (reconnectTimeoutRef.current !== null) {
      window.clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
  }, []);

  const clearSearchTimeout = useCallback(() => {
    if (searchTimeoutRef.current !== null) {
      window.clearTimeout(searchTimeoutRef.current);
      searchTimeoutRef.current = null;
    }
  }, []);

  const createJoinQueuePayload = useCallback(() => {
    const countryCode = (currentUser.country_code || "GL").trim().toUpperCase() || "GL";
    return {
      type: "join_queue",
      role: selectedRoleRef.current,
      gender: currentUser.gender,
      preferred_gender: currentUser.preferred_gender,
      country_code: countryCode,
    };
  }, [currentUser.country_code, currentUser.gender, currentUser.preferred_gender]);

  const sendJoinQueue = useCallback(() => {
    const joined = sendSocketMessage(createJoinQueuePayload());
    if (joined) {
      queuedJoinRef.current = false;
      setStatusMessage("Finding players...");
      setErrorMessage(null);
    } else {
      queuedJoinRef.current = true;
    }
  }, [createJoinQueuePayload, sendSocketMessage]);

  const attachSocketHandlers = useCallback(
    (socket: WebSocket) => {
      socket.onopen = () => {
        if (isUnmountedRef.current) {
          return;
        }
        reconnectAttemptRef.current = 0;
        setConnectionStatus("connected");
        setErrorMessage(null);
        startSocketPing();
        const activeRoomId = roomIdRef.current;
        if (activeRoomId && viewStateRef.current === "match") {
          sendSocketMessage({
            type: "resume_room",
            room_id: activeRoomId,
            roomId: activeRoomId,
          });
          setStatusMessage("Live connection restored.");
          return;
        }
        if (keepSearchingRef.current || queuedJoinRef.current || isSearchingRef.current) {
          sendJoinQueue();
        }
      };

      socket.onmessage = (event: MessageEvent<string>) => {
        const parseIncoming = async () => {
          let payload: WsPayload | null = null;
          try {
            payload = JSON.parse(event.data) as WsPayload;
          } catch {
            setErrorMessage("Invalid message from server.");
            return;
          }

          if (!payload || typeof payload !== "object") {
            return;
          }

          const messageType = String(payload.type ?? payload.action ?? "").trim().toLowerCase();
          if (!messageType) {
            return;
          }

          if (messageType === "connected") {
            return;
          }

          if (messageType === "queue_joined") {
            setViewState("searching");
            setStatusMessage("Finding players...");
            return;
          }

          if (messageType === "queue_rejoined") {
            setViewState("searching");
            setStatusMessage("New round is ready. Searching again...");
            return;
          }

          if (messageType === "queue_left") {
            if (!keepSearchingRef.current) {
              setViewState("lobby");
              setStatusMessage(null);
            }
            return;
          }

          if (messageType === "match_found") {
            const incomingParticipants = toIntList(payload.participants);
            const incomingRoomId = String(payload.room_id ?? "").trim();
            if (!incomingRoomId || incomingParticipants.length < 4) {
              setErrorMessage("Server returned incomplete match data.");
              return;
            }

            clearSearchTimeout();
            setFadeRoundOut(false);
            setRoomId(incomingRoomId);
            setParticipants(incomingParticipants);
            setJudgeId(incomingParticipants[0] ?? null);
            setSelectedTargetUserId(null);
            setEliminatedUserIds([]);
            setViewState("match");
            setStatusMessage("Match found. Preparing connections...");
            setErrorMessage(null);

            try {
              const stream = await navigator.mediaDevices.getUserMedia({
                video: true,
                audio: true,
              });
              localStreamRef.current = stream;
              setLocalStream(stream);
            } catch (mediaError) {
              const message = mediaError instanceof Error ? mediaError.message : "Could not open camera and microphone.";
              setErrorMessage(message);
              setStatusMessage("Match found, but camera/microphone are unavailable.");
            }

            for (const participantUserId of incomingParticipants) {
              if (participantUserId === currentUser.id) {
                continue;
              }
              if (!peerConnectionsRef.current[participantUserId]) {
                const peerConnection = new RTCPeerConnection(RTC_CONFIGURATION);
                peerConnectionsRef.current[participantUserId] = peerConnection;

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
                    target_user_id: participantUserId,
                    candidate: iceEvent.candidate,
                  });
                };

                peerConnection.ontrack = (trackEvent) => {
                  const stream = trackEvent.streams[0];
                  if (!stream) {
                    return;
                  }
                  setRemoteStreams((previous) => ({
                    ...previous,
                    [participantUserId]: stream,
                  }));
                };

                peerConnection.onconnectionstatechange = () => {
                  if (
                    peerConnection.connectionState === "failed" ||
                    peerConnection.connectionState === "closed"
                  ) {
                    closePeerConnection(participantUserId);
                  }
                };
              }

              if (currentUser.id < participantUserId) {
                try {
                  const peerConnection = peerConnectionsRef.current[participantUserId];
                  if (peerConnection) {
                    const offer = await peerConnection.createOffer();
                    await peerConnection.setLocalDescription(offer);
                    sendSocketMessage({
                      type: "offer",
                      target_user_id: participantUserId,
                      sdp: peerConnection.localDescription,
                    });
                  }
                } catch (offerError) {
                  const message = offerError instanceof Error ? offerError.message : "Offer exchange failed.";
                  setErrorMessage(`Signal error: ${message}`);
                }
              }
            }

            return;
          }

          if (messageType === "room_state") {
            const incomingParticipants = toIntList(payload.participants ?? payload.participant_ids);
            const incomingRoomId = String(payload.room_id ?? payload.roomId ?? "").trim();
            if (!incomingRoomId || incomingParticipants.length < 4) {
              return;
            }
            const incomingJudgeId = asInt(payload.judge_id ?? payload.judgeId) ?? incomingParticipants[0] ?? null;
            const incomingPhase = String(payload.phase ?? "LOBBY").trim().toUpperCase();
            const incomingDuration = Math.max(0, Number.parseInt(String(payload.duration ?? "0"), 10));

            setRoomId(incomingRoomId);
            setParticipants(incomingParticipants);
            setJudgeId(incomingJudgeId);
            setViewState("match");
            setErrorMessage(null);
            setStatusMessage("Live room restored.");
            if (incomingPhase === "AD_PHASE") {
              startLiveAd(incomingDuration || LIVE_AD_DEFAULT_DURATION_SECONDS);
            } else if (incomingPhase === "INTRO" || incomingPhase === "BATTLE" || incomingPhase === "JUDGMENT") {
              setPhase(incomingPhase);
              setPhaseSecondsLeft(incomingDuration);
            }
            return;
          }

          if (messageType === "room_resume_failed") {
            setStatusMessage("Live room could not be restored. Returning to matchmaking...");
            closeAllPeerConnections();
            stopLocalMedia();
            resetRoundState();
            keepSearchingRef.current = true;
            queuedJoinRef.current = true;
            setViewState("searching");
            sendJoinQueue();
            return;
          }

          if (messageType === "phase_change") {
            const incomingPhase = String(payload.phase ?? "").trim().toUpperCase();
            const incomingDuration = Math.max(0, Number.parseInt(String(payload.duration ?? "0"), 10));
            if (incomingPhase === "AD_PHASE") {
              startLiveAd(incomingDuration || LIVE_AD_DEFAULT_DURATION_SECONDS);
            } else if (incomingPhase === "INTRO" || incomingPhase === "BATTLE" || incomingPhase === "JUDGMENT") {
              setPhase(incomingPhase);
              setPhaseSecondsLeft(incomingDuration);
              if (incomingDuration > 0) {
                clearPhaseTicker();
                phaseEndAtRef.current = Date.now() + incomingDuration * 1000;
                phaseTickerRef.current = window.setInterval(() => {
                  const endAt = phaseEndAtRef.current;
                  if (!endAt) {
                    return;
                  }
                  const remainingSeconds = Math.max(0, Math.ceil((endAt - Date.now()) / 1000));
                  setPhaseSecondsLeft(remainingSeconds);
                }, PHASE_TICK_INTERVAL_MS);
              } else {
                clearPhaseTicker();
              }
            }
            return;
          }

          if (messageType === "show_live_ad") {
            const incomingDuration = Math.max(
              1,
              Number.parseInt(String(payload.duration ?? LIVE_AD_DEFAULT_DURATION_SECONDS), 10)
            );
            startLiveAd(incomingDuration);
            return;
          }

          if (messageType === "offer" || messageType === "answer" || messageType === "ice_candidate") {
            const fromUserId = asInt(payload.from_user_id);
            if (fromUserId === null || fromUserId === currentUser.id) {
              return;
            }

            if (!peerConnectionsRef.current[fromUserId]) {
              const peerConnection = new RTCPeerConnection(RTC_CONFIGURATION);
              peerConnectionsRef.current[fromUserId] = peerConnection;

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
                  target_user_id: fromUserId,
                  candidate: iceEvent.candidate,
                });
              };

              peerConnection.ontrack = (trackEvent) => {
                const stream = trackEvent.streams[0];
                if (!stream) {
                  return;
                }
                setRemoteStreams((previous) => ({
                  ...previous,
                  [fromUserId]: stream,
                }));
              };

              peerConnection.onconnectionstatechange = () => {
                if (
                  peerConnection.connectionState === "failed" ||
                  peerConnection.connectionState === "closed"
                ) {
                  closePeerConnection(fromUserId);
                }
              };
            }

            const peerConnection = peerConnectionsRef.current[fromUserId];
            if (!peerConnection) {
              return;
            }

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
                    // ignore rollback failure
                  }
                }
                await peerConnection.setRemoteDescription(sessionDescription);
                const answer = await peerConnection.createAnswer();
                await peerConnection.setLocalDescription(answer);
                sendSocketMessage({
                  type: "answer",
                  target_user_id: fromUserId,
                  sdp: peerConnection.localDescription,
                });

                const pending = pendingCandidatesRef.current[fromUserId] ?? [];
                if (pending.length > 0) {
                  for (const candidate of pending) {
                    try {
                      await peerConnection.addIceCandidate(candidate);
                    } catch {
                      // ignore invalid candidate
                    }
                  }
                  pendingCandidatesRef.current[fromUserId] = [];
                }
              } catch (offerError) {
                const message = offerError instanceof Error ? offerError.message : "Offer handling failed.";
                setErrorMessage(`Signal error: ${message}`);
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
                const pending = pendingCandidatesRef.current[fromUserId] ?? [];
                if (pending.length > 0) {
                  for (const candidate of pending) {
                    try {
                      await peerConnection.addIceCandidate(candidate);
                    } catch {
                      // ignore invalid candidate
                    }
                  }
                  pendingCandidatesRef.current[fromUserId] = [];
                }
              } catch (answerError) {
                const message = answerError instanceof Error ? answerError.message : "Answer handling failed.";
                setErrorMessage(`Signal error: ${message}`);
              }
              return;
            }

            const rawCandidate = payload.candidate;
            let candidateToApply: RTCIceCandidateInit | null = null;
            if (rawCandidate && typeof rawCandidate === "object") {
              const parsedCandidate = rawCandidate as RTCIceCandidateInit;
              candidateToApply = {
                ...parsedCandidate,
                sdpMid:
                  parsedCandidate.sdpMid ?? (typeof payload.mid === "string" ? payload.mid : undefined),
                sdpMLineIndex:
                  parsedCandidate.sdpMLineIndex ??
                  (typeof payload.mline_index === "number" ? payload.mline_index : undefined),
              };
            } else if (typeof rawCandidate === "string" && rawCandidate.length > 0) {
              candidateToApply = {
                candidate: rawCandidate,
                sdpMid: typeof payload.mid === "string" ? payload.mid : undefined,
                sdpMLineIndex:
                  typeof payload.mline_index === "number" ? payload.mline_index : undefined,
              };
            }

            if (!candidateToApply) {
              return;
            }

            if (peerConnection.remoteDescription && peerConnection.remoteDescription.type) {
              try {
                await peerConnection.addIceCandidate(candidateToApply);
              } catch {
                // ignore invalid candidate
              }
            } else {
              const pending = pendingCandidatesRef.current[fromUserId] ?? [];
              pending.push(candidateToApply);
              pendingCandidatesRef.current[fromUserId] = pending;
            }
            return;
          }

          if (messageType === "user_eliminated") {
            const eliminatedId = asInt(payload.user_id);
            if (eliminatedId === null) {
              return;
            }
            setEliminatedUserIds((previous) =>
              previous.includes(eliminatedId) ? previous : [...previous, eliminatedId]
            );
            closePeerConnection(eliminatedId);
            setStatusMessage(`Contestant #${eliminatedId} was eliminated.`);
            return;
          }

          if (messageType === "room_member_left") {
            const leftUserId = asInt(payload.user_id);
            if (leftUserId !== null) {
              closePeerConnection(leftUserId);
              setStatusMessage(`Player #${leftUserId} left the room.`);
            }
            return;
          }

          if (messageType === "force_skip" || messageType === "round_completed") {
            clearLiveAdTicker();
            setIsLiveAdVisible(false);
            setFadeRoundOut(true);
            setStatusMessage(
              messageType === "force_skip"
                ? "Time expired. Auto-skipping and starting new matchmaking..."
                : "Round finished. Returning to lobby..."
            );
            window.setTimeout(() => {
              closeAllPeerConnections();
              stopLocalMedia();
              resetRoundState();
              setFadeRoundOut(false);
              if (keepSearchingRef.current) {
                setViewState("searching");
                setStatusMessage("Finding players...");
                sendJoinQueue();
              } else {
                setViewState("lobby");
              }
            }, ROUND_FADE_OUT_MS);
            return;
          }

          if (messageType === "error") {
            const detail = String(payload.detail ?? payload.reason ?? "unknown_error");
            setErrorMessage(detail);
          }
        };

        void parseIncoming();
      };

      socket.onerror = () => {
        if (isUnmountedRef.current) {
          return;
        }
        setConnectionStatus("connecting");
        if (viewStateRef.current === "match") {
          setStatusMessage("Live connection interrupted. Reconnecting...");
        }
      };

      socket.onclose = () => {
        if (isUnmountedRef.current) {
          return;
        }
        wsRef.current = null;
        stopSocketPing();
        const shouldReconnect = keepSearchingRef.current || viewStateRef.current === "match";
        if (shouldReconnect) {
          setConnectionStatus("connecting");
          if (viewStateRef.current !== "match") {
            setViewState("searching");
          }
          setStatusMessage(
            viewStateRef.current === "match"
              ? "Live connection interrupted. Reconnecting..."
              : "Connection dropped. Trying to reconnect..."
          );
          stopReconnectTimer();
          const delay = reconnectDelayForAttempt(reconnectAttemptRef.current);
          reconnectAttemptRef.current += 1;
          reconnectTimeoutRef.current = window.setTimeout(() => {
            if (isUnmountedRef.current) {
              return;
            }
            const stillNeedsReconnect = keepSearchingRef.current || viewStateRef.current === "match";
            if (!stillNeedsReconnect) {
              return;
            }
            const existingSocket = wsRef.current;
            if (existingSocket && existingSocket.readyState !== WebSocket.CLOSED) {
              return;
            }
            const liveWsUrl = buildLiveWsUrl(currentUser.id);
            const newSocket = new WebSocket(liveWsUrl);
            wsRef.current = newSocket;
            setConnectionStatus("connecting");
            attachSocketHandlers(newSocket);
          }, delay);
          return;
        }
        reconnectAttemptRef.current = 0;
        setConnectionStatus("disconnected");
        closeAllPeerConnections();
        clearPhaseTicker();
      };
    },
    [
      clearLiveAdTicker,
      clearPhaseTicker,
      clearSearchTimeout,
      closeAllPeerConnections,
      closePeerConnection,
      currentUser.id,
      isSearchingRef,
      resetRoundState,
      sendJoinQueue,
      sendSocketMessage,
      startLiveAd,
      startSocketPing,
      stopLocalMedia,
      stopSocketPing,
      stopReconnectTimer,
    ]
  );

  const ensureSocketConnected = useCallback(() => {
    const existingSocket = wsRef.current;
    if (existingSocket && existingSocket.readyState === WebSocket.OPEN) {
      setConnectionStatus("connected");
      return;
    }
    if (existingSocket && existingSocket.readyState === WebSocket.CONNECTING) {
      setConnectionStatus("connecting");
      return;
    }

    const liveWsUrl = buildLiveWsUrl(currentUser.id);
    const socket = new WebSocket(liveWsUrl);
    wsRef.current = socket;
    setConnectionStatus("connecting");
    attachSocketHandlers(socket);
  }, [attachSocketHandlers, currentUser.id]);

  const requestMatchmaking = useCallback(() => {
    keepSearchingRef.current = true;
    queuedJoinRef.current = true;
    clearSearchTimeout();
    setViewState("searching");
    setErrorMessage(null);
    setStatusMessage("Connecting to live server...");
    searchTimeoutRef.current = window.setTimeout(() => {
      if (!keepSearchingRef.current) {
        return;
      }

      searchTimeoutRef.current = null;
      keepSearchingRef.current = false;
      queuedJoinRef.current = false;
      stopReconnectTimer();
      clearPhaseTicker();
      closeAllPeerConnections();
      stopLocalMedia();
      resetRoundState();

      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        sendSocketMessage({ type: "leave_queue" });
      }

      if (wsRef.current) {
        try {
          wsRef.current.close(1000, "match_search_timeout");
        } catch {
          // ignore close failures
        }
        wsRef.current = null;
      }

      setConnectionStatus("disconnected");
      setViewState("lobby");
      setStatusMessage(null);
      setErrorMessage("Match not found. Please try again.");
    }, MATCH_SEARCH_TIMEOUT_MS);
    ensureSocketConnected();

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      sendJoinQueue();
    }
  }, [
    clearPhaseTicker,
    clearSearchTimeout,
    closeAllPeerConnections,
    ensureSocketConnected,
    resetRoundState,
    sendJoinQueue,
    sendSocketMessage,
    stopLocalMedia,
    stopReconnectTimer,
  ]);

  const leaveLiveMode = useCallback(
    (options?: { closeSocket?: boolean }) => {
      keepSearchingRef.current = false;
      queuedJoinRef.current = false;
      reconnectAttemptRef.current = 0;
      clearSearchTimeout();
      stopReconnectTimer();
      stopSocketPing();
      clearPhaseTicker();
      clearLiveAdTicker();
      closeAllPeerConnections();
      stopLocalMedia();
      resetRoundState();

      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        sendSocketMessage({ type: "leave_queue" });
      }

      if (options?.closeSocket !== false && wsRef.current) {
        try {
          wsRef.current.close(1000, "live_mode_exit");
        } catch {
          // ignore close failures
        }
        wsRef.current = null;
      }

      setViewState("lobby");
      setStatusMessage(null);
      setConnectionStatus((previousStatus) =>
        options?.closeSocket === false ? previousStatus : "disconnected"
      );
      setFadeRoundOut(false);
      setIsLiveAdVisible(false);
      setLiveAdSecondsLeft(0);
      safeSetStorageItem(LIVE_ACTIVITY_STORAGE_KEY, "0", "session");
    },
    [
      clearLiveAdTicker,
      clearPhaseTicker,
      clearSearchTimeout,
      closeAllPeerConnections,
      resetRoundState,
      sendSocketMessage,
      stopSocketPing,
      stopLocalMedia,
      stopReconnectTimer,
    ]
  );

  useEffect(() => {
    return () => {
      isUnmountedRef.current = true;
      safeRemoveStorageItem(LIVE_ACTIVITY_STORAGE_KEY, "session");
      leaveLiveMode();
    };
  }, [leaveLiveMode]);

  const judgeUserId = judgeId;
  const amJudge = judgeUserId === currentUser.id;
  const contestingUserIds = participants.filter((participantId) => participantId !== judgeUserId);

  const introBigCountdown =
    phase === "INTRO" && phaseSecondsLeft > 0 && phaseSecondsLeft <= 3 ? phaseSecondsLeft : null;
  const battleTimer = phase === "BATTLE" ? formatSeconds(phaseSecondsLeft) : null;

  const sendJudgeAction = useCallback(
    (action: LiveJudgeAction) => {
      if (!amJudge || phase !== "JUDGMENT") {
        return;
      }

      if (action === "kill") {
        if (!selectedTargetUserId) {
          setErrorMessage("Choose a contestant before using KILL.");
          return;
        }
        sendSocketMessage({
          type: "kill",
          target_user_id: selectedTargetUserId,
          round_complete: true,
        });
        setStatusMessage(`KILL sent for user #${selectedTargetUserId}.`);
        setErrorMessage(null);
        return;
      }

      sendSocketMessage({
        type: "judgment_complete",
        decision: action,
        target_user_id: selectedTargetUserId,
      });
      setStatusMessage(`${actionLabel(action)} decision sent.`);
      setErrorMessage(null);
    },
    [amJudge, phase, selectedTargetUserId, sendSocketMessage]
  );

  const handleBackToMenu = () => {
    leaveLiveMode();
    if (onBackToMenu) {
      onBackToMenu();
    }
  };

  const renderSlot = (participantUserId: number | null, slotRole: "judge" | "contestant") => {
    if (participantUserId === null) {
      return (
        <article className="relative overflow-hidden rounded-2xl border border-cyan-300/15 bg-[#060f2e]/75">
          <div className="flex aspect-[4/3] items-center justify-center">
            <p className="text-xs uppercase tracking-[0.2em] text-cyan-200/55">Waiting...</p>
          </div>
        </article>
      );
    }

    const isMe = participantUserId === currentUser.id;
    const isEliminated = eliminatedUserIds.includes(participantUserId);
    const isSelectableContestant =
      amJudge &&
      phase === "JUDGMENT" &&
      slotRole === "contestant" &&
      !isEliminated &&
      participantUserId !== currentUser.id;
    const isSelectedTarget = selectedTargetUserId === participantUserId;
    const stream = isMe ? localStream : remoteStreams[participantUserId] ?? null;
    const isBlurred = phase === "INTRO";

    return (
      <article
        className={`relative overflow-hidden rounded-2xl border bg-[#040d28]/92 shadow-[0_14px_32px_rgba(0,0,0,0.42)] ${
          isSelectedTarget ? "border-rose-300 shadow-[0_0_0_1px_rgba(251,113,133,0.65)]" : "border-cyan-300/20"
        } ${isSelectableContestant ? "cursor-pointer transition hover:border-rose-300/80" : ""}`}
        onClick={() => {
          if (!isSelectableContestant) {
            return;
          }
          setSelectedTargetUserId(participantUserId);
          setErrorMessage(null);
        }}
      >
        {stream ? (
          <StreamVideo
            stream={stream}
            muted={isMe}
            className={`aspect-[4/3] w-full object-cover transition duration-500 ${
              isBlurred ? "blur-sm brightness-75 saturate-75" : "blur-0 brightness-100"
            }`}
          />
        ) : (
          <div className="flex aspect-[4/3] items-center justify-center bg-[radial-gradient(70%_70%_at_50%_25%,rgba(34,211,238,0.2),transparent_70%),linear-gradient(160deg,#04122f_0%,#060b1f_100%)]">
            <p className="text-[11px] uppercase tracking-[0.18em] text-cyan-100/70">No Video</p>
          </div>
        )}

        <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between gap-2 bg-gradient-to-b from-[#020617]/95 via-[#020617]/70 to-transparent px-3 py-2">
          <span
            className={`rounded-full border px-2 py-1 text-[10px] font-bold uppercase tracking-[0.18em] ${
              slotRole === "judge"
                ? "border-amber-300/45 bg-amber-500/20 text-amber-100"
                : "border-cyan-300/45 bg-cyan-500/15 text-cyan-100"
            }`}
          >
            {slotRole === "judge" ? "Judge" : "Contestant"}
          </span>
          <span className="rounded-full border border-blue-200/35 bg-blue-500/20 px-2 py-1 text-[10px] font-semibold text-blue-100">
            {isMe ? "YOU" : `#${participantUserId}`}
          </span>
        </div>

        {isEliminated ? (
          <div className="absolute inset-0 live-glitch-overlay flex items-center justify-center bg-red-950/60">
            <span className="text-[54px] font-black text-red-200 drop-shadow-[0_0_18px_rgba(248,113,113,0.85)]">X</span>
          </div>
        ) : null}
      </article>
    );
  };

  return (
    <>
    <section className="w-full space-y-4 rounded-[30px] border border-cyan-300/20 bg-[linear-gradient(175deg,rgba(2,12,34,0.93)_0%,rgba(2,8,22,0.96)_100%)] p-3.5 shadow-[0_30px_90px_rgba(1,4,12,0.82)] backdrop-blur-xl sm:p-4">
      <header className="rounded-3xl border border-cyan-300/20 bg-[#050f2a]/90 px-3 py-3 shadow-[inset_0_0_0_1px_rgba(50,120,190,0.35)]">
        <div className="flex items-center justify-between gap-2">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan-200/80">Live Mode</p>
            <h2 className="text-lg font-bold text-white">Real-time Match Room</h2>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleBackToMenu}
              className="rounded-full border border-blue-300/35 bg-blue-500/15 px-3 py-1.5 text-xs font-semibold text-blue-100 transition hover:bg-blue-500/25"
            >
              Back
            </button>
          </div>
        </div>
      </header>

      <div className="rounded-2xl border border-cyan-300/20 bg-[#06142f]/80 px-3 py-2 text-xs text-cyan-100">
        <div className="flex items-center justify-between gap-2">
          <span>
            WS status:{" "}
            <strong
              className={
                connectionStatus === "connected"
                  ? "text-emerald-300"
                  : connectionStatus === "connecting"
                    ? "text-amber-300"
                    : "text-red-300"
              }
            >
              {connectionStatus}
            </strong>
          </span>
          <span>{roomId ? `Room: ${roomId}` : "Room: -"} </span>
        </div>
      </div>

      {errorMessage ? (
        <p className="rounded-2xl border border-red-300/35 bg-red-500/15 px-3 py-2 text-sm text-red-100">{errorMessage}</p>
      ) : null}
      {statusMessage ? (
        <p className="rounded-2xl border border-emerald-300/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-100">{statusMessage}</p>
      ) : null}

      {viewState !== "match" ? (
        <div className="space-y-4 rounded-3xl border border-cyan-300/20 bg-[radial-gradient(90%_80%_at_20%_0%,rgba(34,211,238,0.16),transparent_70%),linear-gradient(170deg,#040f29_0%,#02081a_100%)] p-4">
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-cyan-100/85">CHOOSE YOUR ROLE</p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <button
              type="button"
              disabled={viewState === "searching"}
              onClick={() => setSelectedRole("judge")}
              className={`rounded-2xl border px-3 py-4 text-left transition ${
                selectedRole === "judge"
                  ? "border-amber-300/55 bg-amber-500/15 text-amber-100"
                  : "border-blue-200/20 bg-[#081a43]/70 text-slate-200 hover:border-amber-300/40"
              } disabled:cursor-not-allowed disabled:opacity-70`}
            >
              <p className="text-xs uppercase tracking-[0.18em] text-amber-200">Judge</p>
              <p className="mt-1 text-sm font-semibold">I want to judge</p>
            </button>
            <button
              type="button"
              disabled={viewState === "searching"}
              onClick={() => setSelectedRole("contestant")}
              className={`rounded-2xl border px-3 py-4 text-left transition ${
                selectedRole === "contestant"
                  ? "border-fuchsia-300/55 bg-fuchsia-500/15 text-fuchsia-100"
                  : "border-blue-200/20 bg-[#081a43]/70 text-slate-200 hover:border-fuchsia-300/40"
              } disabled:cursor-not-allowed disabled:opacity-70`}
            >
              <p className="text-xs uppercase tracking-[0.18em] text-fuchsia-200">Contestant</p>
              <p className="mt-1 text-sm font-semibold">I want to be judged</p>
            </button>
          </div>
          <button
            type="button"
            disabled={viewState === "searching"}
            onClick={requestMatchmaking}
            className="live-neon-pulse inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl border border-emerald-300/60 bg-[linear-gradient(90deg,rgba(16,185,129,0.35),rgba(6,182,212,0.35))] px-4 text-sm font-bold uppercase tracking-[0.16em] text-emerald-50 shadow-[0_14px_36px_rgba(16,185,129,0.35)] disabled:cursor-wait disabled:opacity-80"
          >
            {viewState === "searching" ? (
              <span className="h-4 w-4 rounded-full border-2 border-emerald-100/30 border-t-emerald-50 animate-spin" />
            ) : null}
            {viewState === "searching" ? "FINDING MATCH..." : "FIND MATCH"}
          </button>
          {viewState === "searching" ? (
            <div className="space-y-3 rounded-2xl border border-cyan-300/20 bg-[#04132f]/80 p-4 text-center">
              <p className="text-xs text-slate-300">Role: {roleLabel(selectedRole)}</p>
              <button
                type="button"
                onClick={() => leaveLiveMode({ closeSocket: false })}
                className="mx-auto rounded-full border border-amber-300/40 bg-amber-500/10 px-4 py-2 text-xs font-semibold text-amber-100 transition hover:bg-amber-500/20"
              >
                Cancel search
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {viewState === "match" ? (
        <div
          className={`space-y-3 rounded-3xl border border-cyan-300/20 bg-[#030d24]/92 p-3 transition ${
            fadeRoundOut ? "opacity-0 scale-[0.985] duration-300" : "opacity-100 scale-100 duration-150"
          }`}
        >
          <div className="relative overflow-hidden rounded-2xl border border-cyan-300/20 bg-[#040f2e] p-2">
            {judgeUserId !== null ? renderSlot(judgeUserId, "judge") : renderSlot(null, "judge")}
          </div>

          <div className="grid grid-cols-3 gap-2">
            {[0, 1, 2].map((index) => renderSlot(contestingUserIds[index] ?? null, "contestant"))}
          </div>

          <div className="rounded-2xl border border-blue-200/20 bg-[#071438]/80 px-3 py-2 text-center">
            <p className="text-[11px] uppercase tracking-[0.2em] text-cyan-200/75">Phase</p>
            <p className="text-sm font-bold text-white">{phase}</p>
            {phase === "BATTLE" && battleTimer ? (
              <p className="mt-1 text-2xl font-black text-cyan-200">{battleTimer}</p>
            ) : null}
            {phase === "JUDGMENT" ? (
              <p className="mt-1 text-lg font-extrabold text-amber-200">{phaseSecondsLeft}s</p>
            ) : null}
            {phase === "AD_PHASE" ? (
              <p className="mt-1 text-lg font-extrabold text-cyan-200">Ad break {liveAdSecondsLeft}s</p>
            ) : null}
          </div>

          {introBigCountdown ? (
            <div className="rounded-2xl border border-fuchsia-300/40 bg-fuchsia-500/15 px-3 py-4 text-center">
              <p className="text-[11px] uppercase tracking-[0.2em] text-fuchsia-100">Intro Countdown</p>
              <p className="text-5xl font-black text-white">{introBigCountdown}</p>
            </div>
          ) : null}

          {phase === "JUDGMENT" && amJudge ? (
            <div className="space-y-3 rounded-2xl border border-amber-300/35 bg-[#210d17]/65 px-3 py-3">
              <p className="text-center text-xs uppercase tracking-[0.2em] text-amber-100">
                Judge Controls {selectedTargetUserId ? `| Target #${selectedTargetUserId}` : ""}
              </p>
              <div className="grid grid-cols-3 gap-2">
                {(["kiss", "marry", "kill"] as LiveJudgeAction[]).map((action) => (
                  <button
                    key={action}
                    type="button"
                    onClick={() => sendJudgeAction(action)}
                    className={`min-h-12 rounded-xl border text-xs font-extrabold uppercase tracking-[0.15em] ${
                      action === "kiss"
                        ? "border-rose-300/60 bg-rose-500/20 text-rose-100"
                        : action === "marry"
                          ? "border-emerald-300/60 bg-emerald-500/20 text-emerald-100"
                          : "border-red-300/65 bg-red-500/25 text-red-100"
                    }`}
                  >
                    {actionLabel(action)}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>

      {isLiveAdVisible ? (
        <div className="fixed inset-0 z-[180] flex items-center justify-center bg-[radial-gradient(80%_80%_at_50%_20%,rgba(34,211,238,0.22),transparent_65%),linear-gradient(180deg,rgba(2,6,23,0.97)_0%,rgba(3,8,28,0.99)_100%)] px-4 py-6">
          <section className="w-full max-w-md rounded-3xl border border-cyan-300/30 bg-[#06142f]/95 p-4 shadow-[0_30px_90px_rgba(0,0,0,0.7)]">
            <p className="text-center text-xs uppercase tracking-[0.22em] text-cyan-200/80">Live Sponsored Break</p>
            <h3 className="mt-1 text-center text-xl font-bold text-white">Video Ad</h3>
            <p className="mt-1 text-center text-sm text-slate-300">
              The live room is paused for everyone. Gameplay resumes automatically.
            </p>

            <div className="mt-4 rounded-2xl border border-cyan-300/20 bg-[linear-gradient(160deg,rgba(15,23,42,0.92)_0%,rgba(17,24,39,0.92)_100%)] p-3">
              <div className="min-h-[220px] rounded-xl border border-cyan-300/25 bg-[#0b1535]/90 p-2">
                {ADSENSE_INTERSTITIAL_SLOT_ID ? (
                  <ins
                    key={`live-interstitial-adsense-${liveAdInstance}`}
                    className="adsbygoogle block h-full w-full"
                    style={{ display: "block", minHeight: "220px" }}
                    data-ad-client={ADSENSE_CLIENT_ID}
                    data-ad-slot={ADSENSE_INTERSTITIAL_SLOT_ID}
                    data-ad-format="auto"
                    data-full-width-responsive="true"
                  />
                ) : (
                  <div className="flex min-h-[220px] items-center justify-center rounded-lg border border-dashed border-cyan-300/35 bg-cyan-500/10 text-center">
                    <p className="max-w-[260px] text-xs text-cyan-100">
                      Configure NEXT_PUBLIC_ADSENSE_INTERSTITIAL_SLOT_ID to render the live interstitial video ad here.
                    </p>
                  </div>
                )}
              </div>
            </div>

            {liveAdRenderError ? (
              <p className="mt-3 rounded-xl border border-amber-300/40 bg-amber-500/15 px-3 py-2 text-xs text-amber-100">
                {liveAdRenderError}
              </p>
            ) : null}

            <div className="mt-4 rounded-2xl border border-cyan-300/25 bg-cyan-500/10 px-3 py-3 text-center">
              <p className="text-[11px] uppercase tracking-[0.2em] text-cyan-100/75">Resuming in</p>
              <p className="mt-1 text-4xl font-black text-white">{liveAdSecondsLeft}s</p>
              <p className="mt-1 text-xs text-slate-300">Close is disabled during synchronized Live ads.</p>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
