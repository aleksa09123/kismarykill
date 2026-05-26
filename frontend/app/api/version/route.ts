import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export function GET() {
  const version =
    process.env.NEXT_PUBLIC_APP_VERSION?.trim() ||
    process.env.VERCEL_GIT_COMMIT_SHA?.trim() ||
    process.env.VERCEL_DEPLOYMENT_ID?.trim() ||
    "development";

  return NextResponse.json(
    {
      version,
      checked_at: new Date().toISOString()
    },
    {
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0"
      }
    }
  );
}
