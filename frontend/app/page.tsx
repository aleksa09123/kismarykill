"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { readSession } from "@/lib/auth-session";

export default function RootPage() {
  const router = useRouter();

  useEffect(() => {
    const session = readSession();
    if (session?.access_token) {
      router.replace("/dashboard");
      return;
    }
    router.replace("/login");
  }, [router]);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md items-center justify-center px-4">
      <p className="rounded-2xl border border-blue-300/20 bg-blue-500/10 px-4 py-2 text-sm text-blue-100">
        Redirecting...
      </p>
    </main>
  );
}
