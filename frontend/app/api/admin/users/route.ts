import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

type AdminIdentity = {
  id: string;
  email: string;
};

type RegistrationRow = {
  id: number;
  ime?: string | null;
  email?: string | null;
  datum_registracije?: string | null;
};

type BackendUserResponse = {
  id?: number | string;
  email?: string | null;
};

const USER_SELECT_COLUMNS = "id, ime, email, datum_registracije";
const REQUEST_TIMEOUT_MS = 15000;

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function jsonResponse(body: Record<string, unknown>, init?: ResponseInit) {
  const response = NextResponse.json(body, init);
  response.headers.set("Cache-Control", "no-store, no-cache, max-age=0, must-revalidate");
  return response;
}

function parseCsvEnv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function getAdminEmails(): Set<string> {
  return new Set(
    [...parseCsvEnv(process.env.ADMIN_EMAILS), ...parseCsvEnv(process.env.NEXT_PUBLIC_ADMIN_EMAILS)]
      .map((email) => email.toLowerCase())
  );
}

function getAdminUserIds(): Set<string> {
  return new Set([
    ...parseCsvEnv(process.env.ADMIN_USER_IDS),
    ...parseCsvEnv(process.env.NEXT_PUBLIC_ADMIN_USER_IDS)
  ]);
}

function isAdmin(identity: AdminIdentity): boolean {
  const adminEmails = getAdminEmails();
  const adminUserIds = getAdminUserIds();
  const email = identity.email.trim().toLowerCase();
  const userId = identity.id.trim();

  if (adminEmails.size === 0 && adminUserIds.size === 0) {
    return false;
  }

  return Boolean(email && adminEmails.has(email)) || Boolean(userId && adminUserIds.has(userId));
}

function getBearerToken(request: NextRequest): string | null {
  const authorization = request.headers.get("authorization") ?? "";
  const [scheme, token] = authorization.split(" ");

  if (scheme?.toLowerCase() !== "bearer" || !token?.trim()) {
    return null;
  }

  return token.trim();
}

function resolveSupabaseConfig(): { url: string; key: string } | null {
  const url = (process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim();
  const key = (
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.SUPABASE_SERVICE_KEY ??
    process.env.SUPABASE_SECRET_KEY ??
    process.env.SUPABASE_KEY ??
    process.env.SUPABASE_ANON_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
    ""
  ).trim();

  if (!url || !key) {
    return null;
  }

  return { url, key };
}

function createSupabaseServerClient() {
  const config = resolveSupabaseConfig();
  if (!config) {
    return null;
  }

  return createClient(config.url, config.key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    }
  });
}

async function resolveSupabaseAuthIdentity(token: string): Promise<AdminIdentity | null> {
  const supabase = createSupabaseServerClient();
  if (!supabase) {
    return null;
  }

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) {
    return null;
  }

  return {
    id: data.user.id,
    email: data.user.email ?? ""
  };
}

async function resolveBackendIdentity(token: string): Promise<AdminIdentity | null> {
  const apiBaseUrl = (process.env.API_BASE_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "").trim().replace(/\/+$/, "");
  if (!apiBaseUrl) {
    return null;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${apiBaseUrl}/me`, {
      headers: {
        Authorization: `Bearer ${token}`
      },
      cache: "no-store",
      signal: controller.signal
    });

    if (!response.ok) {
      return null;
    }

    const user = (await response.json()) as BackendUserResponse;
    if (user.id === undefined || user.id === null) {
      return null;
    }

    return {
      id: String(user.id),
      email: String(user.email ?? "")
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function resolveCurrentIdentity(token: string): Promise<AdminIdentity | null> {
  return (await resolveSupabaseAuthIdentity(token)) ?? (await resolveBackendIdentity(token));
}

export async function GET(request: NextRequest) {
  const token = getBearerToken(request);
  if (!token) {
    return jsonResponse({ error: "Unauthorized" }, { status: 403 });
  }

  const identity = await resolveCurrentIdentity(token);
  if (!identity || !isAdmin(identity)) {
    return jsonResponse({ error: "Unauthorized" }, { status: 403 });
  }

  const supabase = createSupabaseServerClient();
  if (!supabase) {
    return jsonResponse({ error: "Supabase server config is missing" }, { status: 500 });
  }

  const [countResponse, latestResponse] = await Promise.all([
    supabase.from("users").select("id", { count: "exact", head: true }),
    supabase
      .from("users")
      .select(USER_SELECT_COLUMNS)
      .order("datum_registracije", { ascending: false, nullsFirst: false })
      .limit(10)
  ]);

  if (countResponse.error || latestResponse.error) {
    return jsonResponse(
      {
        error: countResponse.error?.message ?? latestResponse.error?.message ?? "Could not load admin users"
      },
      { status: 500 }
    );
  }

  return jsonResponse({
    totalUsers: countResponse.count ?? 0,
    registrations: (latestResponse.data ?? []) as RegistrationRow[],
    updatedAt: new Date().toISOString()
  });
}
