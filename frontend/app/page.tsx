"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { readSession } from "@/lib/auth-session";

export default function RootPage() {
  const router = useRouter();

  useEffect(() => {
    const session = readSession();
    if (session) {
      router.replace("/dashboard");
      return;
    }

    router.replace("/login");
  }, [router]);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md items-center justify-center px-4">
      <p className="text-sm text-slate-300">Preparing your dashboard...</p>
    </main>
  );
}
