"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";

import { fetchCurrentUser, updateCurrentUser } from "@/lib/api";
import { hasUnlockedProfilePhoto, patchSessionUser, readSession } from "@/lib/auth-session";
import type { Gender, PreferredGender } from "@/lib/types";

export default function SettingsPage() {
  const router = useRouter();
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [gender, setGender] = useState<Gender>("male");
  const [preferredGender, setPreferredGender] = useState<PreferredGender>("both");
  const [profileImageUrl, setProfileImageUrl] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    const session = readSession();
    if (!session) {
      router.replace("/login");
      return;
    }

    setAccessToken(session.access_token);

    const loadUser = async () => {
      try {
        const me = await fetchCurrentUser(session.access_token);
        setName(me.name);
        setGender(me.gender);
        setPreferredGender(me.preferred_gender);
        setProfileImageUrl(me.profile_image_url || "");
        patchSessionUser(me);
      } catch (loadError) {
        const message = loadError instanceof Error ? loadError.message : "Could not load settings.";
        setError(message);
      } finally {
        setIsLoading(false);
      }
    };

    void loadUser();
  }, [router]);

  const saveSettings = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!accessToken) {
      return;
    }

    setError(null);
    setSuccess(null);
    setIsSaving(true);

    try {
      const updatedUser = await updateCurrentUser(
        {
          name: name.trim(),
          gender,
          preferred_gender: preferredGender,
          profile_image_url: profileImageUrl.trim() || null
        },
        accessToken
      );
      patchSessionUser(updatedUser);
      setSuccess("Profile saved.");
    } catch (saveError) {
      const message = saveError instanceof Error ? saveError.message : "Could not save profile.";
      setError(message);
    } finally {
      setIsSaving(false);
    }
  };

  const unlocked = hasUnlockedProfilePhoto(profileImageUrl);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md items-start px-3 py-4 md:justify-center md:py-8">
      <section
        className="w-full space-y-4 rounded-3xl border border-slate-700/50 bg-slate-950/65 p-4 shadow-2xl shadow-black/30 backdrop-blur-xl"
        style={{
          paddingTop: "max(env(safe-area-inset-top), 0.25rem)",
          paddingBottom: "max(env(safe-area-inset-bottom), 0.75rem)"
        }}
      >
        <header className="flex items-center justify-between">
          <p className="font-display text-3xl text-white">Settings</p>
          <Link
            href="/dashboard"
            className="min-h-11 min-w-11 rounded-xl border border-cyan-400/60 px-3 py-2 text-sm font-semibold text-cyan-100 transition hover:bg-cyan-900/40"
          >
            Back to Menu
          </Link>
        </header>

        <div className="rounded-2xl border border-slate-700/60 bg-slate-900/55 p-4">
          <div className="relative mx-auto h-24 w-24 overflow-hidden rounded-full border border-slate-600">
            {unlocked ? (
              <Image src={profileImageUrl} alt="Profile preview" fill sizes="96px" className="object-cover" />
            ) : (
              <div className="flex h-full w-full items-center justify-center bg-slate-800 text-xs font-semibold text-orange-300">
                Upload Photo
              </div>
            )}
          </div>
          <p className="mt-3 text-center text-xs text-slate-300">
            Uploading a real profile photo unlocks PLAY mode.
          </p>
        </div>

        {isLoading && <p className="rounded-xl bg-slate-800/70 px-3 py-2 text-sm text-slate-200">Loading settings...</p>}

        <form onSubmit={saveSettings} className="space-y-4">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-200">Display name</span>
            <input
              required
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="min-h-11 w-full rounded-xl border border-slate-600 bg-slate-900/70 px-3 text-slate-100 outline-none ring-cyan-400 transition focus:ring"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-200">Profile image URL</span>
            <input
              type="url"
              value={profileImageUrl}
              onChange={(event) => setProfileImageUrl(event.target.value)}
              className="min-h-11 w-full rounded-xl border border-slate-600 bg-slate-900/70 px-3 text-slate-100 outline-none ring-cyan-400 transition focus:ring"
              placeholder="https://i.pravatar.cc/300?u=your-id"
            />
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-slate-200">Gender</span>
              <select
                value={gender}
                onChange={(event) => setGender(event.target.value as Gender)}
                className="min-h-11 w-full rounded-xl border border-slate-600 bg-slate-900/70 px-3 text-slate-100 outline-none ring-cyan-400 transition focus:ring"
              >
                <option value="male">Male</option>
                <option value="female">Female</option>
              </select>
            </label>

            <label className="block">
              <span className="mb-1 block text-sm font-medium text-slate-200">Preferred gender</span>
              <select
                value={preferredGender}
                onChange={(event) => setPreferredGender(event.target.value as PreferredGender)}
                className="min-h-11 w-full rounded-xl border border-slate-600 bg-slate-900/70 px-3 text-slate-100 outline-none ring-cyan-400 transition focus:ring"
              >
                <option value="both">Both</option>
                <option value="male">Male</option>
                <option value="female">Female</option>
              </select>
            </label>
          </div>

          {error && <p className="rounded-xl bg-red-500/20 px-3 py-2 text-sm text-red-200">{error}</p>}
          {success && <p className="rounded-xl bg-emerald-500/20 px-3 py-2 text-sm text-emerald-200">{success}</p>}

          <button
            type="submit"
            disabled={isSaving || isLoading}
            className="min-h-11 w-full rounded-xl border border-cyan-300/60 bg-cyan-400/15 px-4 text-sm font-semibold text-cyan-100 transition hover:bg-cyan-400/25 disabled:opacity-60"
          >
            {isSaving ? "Saving..." : "Save settings"}
          </button>
        </form>
      </section>
    </main>
  );
}
