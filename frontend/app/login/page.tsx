"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";

import { AuthPanel } from "@/components/auth-panel";
import { writeSession } from "@/lib/auth-session";
import type { AuthResponse } from "@/lib/types";

export default function LoginPage() {
  const router = useRouter();

  const handleAuthenticated = (payload: AuthResponse) => {
    writeSession(payload);
    router.replace("/dashboard");
  };

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md items-start px-3 py-4 md:justify-center md:py-8">
      <div
        className="w-full space-y-4"
        style={{
          paddingTop: "max(env(safe-area-inset-top), 0.25rem)",
          paddingBottom: "max(env(safe-area-inset-bottom), 0.75rem)"
        }}
      >
        <AuthPanel onAuthenticated={handleAuthenticated} initialMode="login" lockMode />
        <p className="text-center text-sm text-slate-300">
          New here?{" "}
          <Link className="font-semibold text-orange-300 hover:text-orange-200" href="/register">
            Create account
          </Link>
        </p>
      </div>
    </main>
  );
}
