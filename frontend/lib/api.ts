import type {
  BotFeedbackResponse,
  AuthResponse,
  AuthUser,
  GetRoundBatchResponse,
  GetRoundResponse,
  LeaderboardResponse,
  LoginRequest,
  LocationOptionCountry,
  LocationSelectionResponse,
  RegisterRequest,
  RegisterStartResponse,
  UpdateProfileRequest,
  VerifyRegistrationRequest,
  VoteRoundRequest,
  VoteRoundResponse
} from "@/lib/types";
import { hardResetAuthStateAndReload } from "@/lib/auth-session";

const rawApiBaseUrl = process.env.NEXT_PUBLIC_API_URL?.trim() ?? "";
export const API_BASE_URL = rawApiBaseUrl.replace(/\/+$/, "");

const REQUEST_TIMEOUT_MS = 60000;
const TRANSIENT_RETRY_DELAYS_MS = [400, 1200, 2500];
const NO_CACHE_HEADERS = {
  "Cache-Control": "no-cache, no-store, max-age=0",
  Pragma: "no-cache",
  Expires: "0"
};

export class ApiRequestError extends Error {
  status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
  }
}

function withCacheBuster(path: string): string {
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}t=${Date.now()}`;
}

function errorMessageFromUnknown(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  if (Array.isArray(value) || (typeof value === "object" && value !== null)) {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return null;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "Request failed";
}

function alertAuthError(error: unknown): void {
  if (typeof window !== "undefined" && typeof window.alert === "function") {
    window.alert(getErrorMessage(error));
  }
}

function alertConnectingToApi(): void {
  if (typeof window !== "undefined" && typeof window.alert === "function" && API_BASE_URL) {
    window.alert(`Connecting to: ${API_BASE_URL}...`);
  }
}

function containsUserNotFoundSignal(raw: unknown): boolean {
  if (raw === null || raw === undefined) {
    return false;
  }
  const normalized = String(raw).trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return normalized.includes("user_not_found") || normalized.includes("user not found");
}

function shouldResetAuthState(
  params: {
    status: number;
    detail: unknown;
    error: unknown;
    hadAuthorizationToken: boolean;
  }
): boolean {
  const { status, detail, error, hadAuthorizationToken } = params;
  if (containsUserNotFoundSignal(detail) || containsUserNotFoundSignal(error)) {
    return true;
  }
  return false;
}

async function buildApiError(response: Response): Promise<{
  status: number;
  message: string;
  detail: unknown;
  error: unknown;
}> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const errorBody = (await response.json()) as { detail?: unknown; error?: unknown };
    const detail = errorBody.detail;
    const error = errorBody.error;
    const message =
      errorMessageFromUnknown(detail) ??
      errorMessageFromUnknown(error) ??
      `Request failed with status ${response.status}`;
    return {
      status: response.status,
      message,
      detail,
      error,
    };
  }

  const rawText = await response.text();
  const message = rawText || `Request failed with status ${response.status}`;
  return {
    status: response.status,
    message,
    detail: rawText,
    error: null,
  };
}

async function request<T>(path: string, init: RequestInit, accessToken?: string): Promise<T> {
  if (!API_BASE_URL) {
    throw new ApiRequestError(
      "Missing NEXT_PUBLIC_API_URL. Add it in frontend/.env.local and Vercel Environment Variables."
    );
  }

  const fetchOnce = async (token: string | undefined): Promise<Response> => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await fetch(`${API_BASE_URL}${path}`, {
        ...init,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(init.headers ?? {})
        },
        credentials: "include",
        cache: "no-store",
        signal: controller.signal
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new ApiRequestError("Request timed out. Please check phone Wi-Fi and backend server availability.");
      }
      throw new ApiRequestError(
        `Could not reach API at ${API_BASE_URL}. Check NEXT_PUBLIC_API_URL and backend CORS settings.`
      );
    } finally {
      clearTimeout(timeoutId);
    }
  };

  const isIdempotentRequest = !init.method || init.method.toUpperCase() === "GET";
  const sleep = (delayMs: number) => new Promise((resolve) => setTimeout(resolve, delayMs));
  const tokenForRequest = accessToken;
  const hadAuthorizationToken = Boolean(tokenForRequest?.trim());
  let response: Response | null = null;

  for (let attempt = 0; attempt <= TRANSIENT_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      response = await fetchOnce(tokenForRequest);
      if (!isIdempotentRequest || response.status < 500 || attempt === TRANSIENT_RETRY_DELAYS_MS.length) {
        break;
      }
    } catch (error) {
      if (!isIdempotentRequest || attempt === TRANSIENT_RETRY_DELAYS_MS.length) {
        throw error;
      }
    }
    await sleep(TRANSIENT_RETRY_DELAYS_MS[Math.min(attempt, TRANSIENT_RETRY_DELAYS_MS.length - 1)]);
  }

  if (response === null) {
    throw new ApiRequestError("Request failed before reaching the API.");
  }

  if (!response.ok) {
    const apiError = await buildApiError(response);
    if (
      shouldResetAuthState({
        status: apiError.status,
        detail: apiError.detail,
        error: apiError.error,
        hadAuthorizationToken,
      })
    ) {
      hardResetAuthStateAndReload();
    }
    throw new ApiRequestError(apiError.message, apiError.status);
  }

  return (await response.json()) as T;
}

export async function registerUser(payload: RegisterRequest): Promise<RegisterStartResponse> {
  alertConnectingToApi();
  try {
    return await request<RegisterStartResponse>(
      withCacheBuster("/register"),
      {
        method: "POST",
        headers: NO_CACHE_HEADERS,
        body: JSON.stringify(payload)
      },
      undefined
    );
  } catch (error) {
    alertAuthError(error);
    throw error;
  }
}

export async function verifyRegistration(payload: VerifyRegistrationRequest): Promise<AuthResponse> {
  alertConnectingToApi();
  try {
    return await request<AuthResponse>(
      withCacheBuster("/register/verify"),
      {
        method: "POST",
        headers: NO_CACHE_HEADERS,
        body: JSON.stringify(payload)
      },
      undefined
    );
  } catch (error) {
    alertAuthError(error);
    throw error;
  }
}

export async function loginUser(payload: LoginRequest): Promise<AuthResponse> {
  alertConnectingToApi();
  try {
    return await request<AuthResponse>(
      withCacheBuster("/login"),
      {
        method: "POST",
        headers: NO_CACHE_HEADERS,
        body: JSON.stringify(payload)
      },
      undefined
    );
  } catch (error) {
    alertAuthError(error);
    throw error;
  }
}

export async function fetchRound(accessToken: string): Promise<GetRoundResponse> {
  return request<GetRoundResponse>(
    "/profiles",
    {
      method: "GET"
    },
    accessToken
  );
}

export async function fetchRoundBatch(accessToken: string, count: number): Promise<GetRoundBatchResponse> {
  const normalizedCount = Number.isFinite(count) ? Math.min(20, Math.max(1, Math.trunc(count))) : 18;
  return request<GetRoundBatchResponse>(
    `/profiles/batch?count=${normalizedCount}`,
    {
      method: "GET"
    },
    accessToken
  );
}

export async function submitRoundVotes(payload: VoteRoundRequest, accessToken: string): Promise<VoteRoundResponse> {
  return request<VoteRoundResponse>(
    "/vote",
    {
      method: "POST",
      body: JSON.stringify(payload)
    },
    accessToken
  );
}

export async function fetchCurrentUser(accessToken: string): Promise<AuthUser> {
  return request<AuthUser>(
    "/me",
    {
      method: "GET"
    },
    accessToken
  );
}

export async function updateCurrentUser(payload: UpdateProfileRequest, accessToken: string): Promise<AuthUser> {
  return request<AuthUser>(
    "/me",
    {
      method: "PATCH",
      body: JSON.stringify(payload)
    },
    accessToken
  );
}

export async function fetchLeaderboard(accessToken: string, countryCode?: string | null, mode?: string | null) {
  const normalizedCountry = (countryCode ?? "").trim().toUpperCase();
  const params = new URLSearchParams();
  if (normalizedCountry) {
    params.set("country_code", normalizedCountry);
  }
  const normalizedMode = (mode ?? "").trim().toLowerCase();
  if (normalizedMode) {
    params.set("mode", normalizedMode);
  }
  const query = params.toString();
  return request<LeaderboardResponse>(
    `/leaderboard${query ? `?${query}` : ""}`,
    {
      method: "GET"
    },
    accessToken
  );
}

export async function fetchBotFeedback(accessToken: string): Promise<BotFeedbackResponse> {
  return request<BotFeedbackResponse>(
    "/bot-feedback",
    {
      method: "GET"
    },
    accessToken
  );
}

export async function fetchLocationOptions(): Promise<LocationOptionCountry[]> {
  return request<LocationOptionCountry[]>(
    "/location/options",
    {
      method: "GET"
    },
    undefined
  );
}

export async function fetchCurrentLocation(accessToken: string): Promise<LocationSelectionResponse> {
  return request<LocationSelectionResponse>(
    "/location/current",
    {
      method: "GET"
    },
    accessToken
  );
}

export async function setCurrentLocation(
  payload: { country_code: string; country_name?: string },
  accessToken: string
): Promise<LocationSelectionResponse> {
  return request<LocationSelectionResponse>(
    "/location/select",
    {
      method: "POST",
      body: JSON.stringify(payload)
    },
    accessToken
  );
}

export async function uploadProfilePicture(file: File, accessToken: string): Promise<AuthUser> {
  if (!API_BASE_URL) {
    throw new ApiRequestError("Missing NEXT_PUBLIC_API_URL. Add it in frontend/.env.local and Vercel Environment Variables.");
  }

  const formData = new FormData();
  formData.append("file", file);

  const fetchUploadOnce = async (token: string): Promise<Response> => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await fetch(`${API_BASE_URL}/upload-profile-picture`, {
        method: "POST",
        body: formData,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        credentials: "include",
        cache: "no-store",
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeoutId);
    }
  };

  try {
    const tokenForRequest = accessToken;
    const hadAuthorizationToken = Boolean(tokenForRequest?.trim());
    const response = await fetchUploadOnce(tokenForRequest);

    if (!response.ok) {
      const apiError = await buildApiError(response);
      if (
        shouldResetAuthState({
          status: apiError.status,
          detail: apiError.detail,
          error: apiError.error,
          hadAuthorizationToken,
        })
      ) {
        hardResetAuthStateAndReload();
      }
      throw new ApiRequestError(apiError.message, apiError.status);
    }

    return (await response.json()) as AuthUser;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new ApiRequestError("Image upload timed out. Please try again.");
    }

    if (error instanceof ApiRequestError) {
      throw error;
    }
    if (error instanceof Error) {
      throw new ApiRequestError(error.message);
    }
    throw new ApiRequestError("Could not upload profile image.");
  }
}
