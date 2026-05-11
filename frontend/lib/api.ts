import type {
  AuthResponse,
  AuthUser,
  GetRoundRequest,
  GetRoundResponse,
  LeaderboardResponse,
  LoginRequest,
  RegisterRequest,
  RegisterStartResponse,
  UpdateProfileRequest,
  VerifyRegistrationRequest,
  VoteRoundRequest,
  VoteRoundResponse,
  ZoneDebugResponse
} from "@/lib/types";

const API_BASE_URL = "http://192.168.100.91:8000";

const REQUEST_TIMEOUT_MS = 60000;

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
  if (typeof window !== "undefined" && typeof window.alert === "function") {
    window.alert("Connecting to: http://192.168.100.91:8000...");
  }
}

async function request<T>(path: string, init: RequestInit, accessToken?: string): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;

  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        ...(init.headers ?? {})
      },
      credentials: "omit",
      cache: "no-store",
      signal: controller.signal
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("Request timed out. Please check phone Wi-Fi and backend server availability.");
    }

    throw new Error(
      `Could not reach API at ${API_BASE_URL}. Make sure backend is running on your LAN IP and CORS is configured.`
    );
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const errorBody = (await response.json()) as { detail?: unknown };
      const backendMessage = errorMessageFromUnknown(errorBody.detail);
      throw new Error(backendMessage ?? `Request failed with status ${response.status}`);
    }

    const errorPayload = await response.text();
    throw new Error(errorPayload || `Request failed with status ${response.status}`);
  }

  return (await response.json()) as T;
}

export async function registerUser(payload: RegisterRequest): Promise<RegisterStartResponse> {
  alertConnectingToApi();
  try {
    return await request<RegisterStartResponse>(
      "/register",
      {
        method: "POST",
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
      "/register/verify",
      {
        method: "POST",
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
      "/login",
      {
        method: "POST",
        body: JSON.stringify(payload)
      },
      undefined
    );
  } catch (error) {
    alertAuthError(error);
    throw error;
  }
}

export async function fetchRound(payload: GetRoundRequest, accessToken: string): Promise<GetRoundResponse> {
  const params = new URLSearchParams({
    latitude: String(payload.location.latitude),
    longitude: String(payload.location.longitude)
  });
  const response = await request<GetRoundResponse>(
    `/profiles?${params.toString()}`,
    {
      method: "GET",
      headers: {
        "x-latitude": String(payload.location.latitude),
        "x-longitude": String(payload.location.longitude)
      }
    },
    accessToken
  );
  return response;
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

export async function fetchLeaderboard(accessToken: string) {
  return request<LeaderboardResponse>(
    "/leaderboard",
    {
      method: "GET"
    },
    accessToken
  );
}

export async function uploadProfilePicture(file: File, accessToken: string): Promise<AuthUser> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const formData = new FormData();
  formData.append("file", file);

  try {
    const response = await fetch(`${API_BASE_URL}/upload-profile-picture`, {
      method: "POST",
      body: formData,
      headers: {
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {})
      },
      credentials: "omit",
      cache: "no-store",
      signal: controller.signal
    });

    if (!response.ok) {
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        const errorBody = (await response.json()) as { detail?: unknown };
        const backendMessage = errorMessageFromUnknown(errorBody.detail);
        throw new Error(backendMessage ?? `Request failed with status ${response.status}`);
      }

      const errorPayload = await response.text();
      throw new Error(errorPayload || `Request failed with status ${response.status}`);
    }

    return (await response.json()) as AuthUser;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("Image upload timed out. Please try again.");
    }

    if (error instanceof Error) {
      throw error;
    }
    throw new Error("Could not upload profile image.");
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function fetchZoneDebug(
  accessToken: string,
  location?: { latitude: number; longitude: number }
): Promise<ZoneDebugResponse> {
  const params = new URLSearchParams();
  const headers: Record<string, string> = {};

  if (location) {
    params.set("latitude", String(location.latitude));
    params.set("longitude", String(location.longitude));
    headers["x-latitude"] = String(location.latitude);
    headers["x-longitude"] = String(location.longitude);
  }

  const suffix = params.toString();
  const path = suffix ? `/debug/zone?${suffix}` : "/debug/zone";

  return request<ZoneDebugResponse>(
    path,
    {
      method: "GET",
      headers
    },
    accessToken
  );
}
