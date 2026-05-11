"use client";

import { FormEvent, useState } from "react";

import { loginUser, registerUser, verifyRegistration } from "@/lib/api";
import type { AuthResponse, Gender, PreferredGender } from "@/lib/types";

type AuthMode = "login" | "register";
type RegisterStep = "form" | "verify";

type AuthPanelProps = {
  onAuthenticated: (payload: AuthResponse) => void;
  initialMode?: AuthMode;
  lockMode?: boolean;
};

export function AuthPanel({ onAuthenticated, initialMode = "login", lockMode = false }: AuthPanelProps) {
  const [mode, setMode] = useState<AuthMode>(initialMode);
  const [registerStep, setRegisterStep] = useState<RegisterStep>("form");
  const [pendingEmail, setPendingEmail] = useState("");
  const [verificationCode, setVerificationCode] = useState("");
  const [info, setInfo] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [gender, setGender] = useState<Gender>("male");
  const [preferredGender, setPreferredGender] = useState<PreferredGender>("both");
  const [profileImageUrl, setProfileImageUrl] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const switchMode = (nextMode: AuthMode) => {
    setMode(nextMode);
    setError(null);
    setInfo(null);
    setVerificationCode("");
    setPendingEmail("");
    setRegisterStep("form");
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setInfo(null);
    setIsSubmitting(true);

    try {
      if (mode === "register") {
        if (registerStep === "form") {
          const response = await registerUser({
            email,
            password,
            name: name.trim(),
            gender,
            preferred_gender: preferredGender,
            profile_image_url: profileImageUrl.trim() || undefined
          });
          setPendingEmail(response.email);
          setRegisterStep("verify");
          setInfo(`${response.detail} Enter the 6-digit code shown in the backend terminal logs.`);
          return;
        }

        const payload = await verifyRegistration({
          email: pendingEmail || email,
          code: verificationCode
        });
        onAuthenticated(payload);
        return;
      }

      const payload = await loginUser({ email, password });
      onAuthenticated(payload);
    } catch (submitError) {
      const message = submitError instanceof Error ? submitError.message : "Authentication failed.";
      setError(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <section className="w-full rounded-3xl border border-slate-200 bg-white/95 p-5 shadow-xl shadow-slate-900/10 backdrop-blur">
      <div className="mb-5 flex items-center justify-between">
        <div>
          <p className="font-display text-2xl tracking-tight text-slate-900">Kiss Marry Kill</p>
          <p className="text-sm text-slate-600">Login or create an account to start swiping.</p>
        </div>
      </div>

      {!lockMode && (
        <div className="mb-5 grid grid-cols-2 gap-2 rounded-xl bg-slate-100 p-1">
          <button
            type="button"
            onClick={() => switchMode("login")}
            className={`min-h-11 rounded-lg text-sm font-semibold transition ${
              mode === "login" ? "bg-white text-slate-900 shadow" : "text-slate-600"
            }`}
          >
            Login
          </button>
          <button
            type="button"
            onClick={() => switchMode("register")}
            className={`min-h-11 rounded-lg text-sm font-semibold transition ${
              mode === "register" ? "bg-white text-slate-900 shadow" : "text-slate-600"
            }`}
          >
            Register
          </button>
        </div>
      )}

      <form onSubmit={submit} className="space-y-4">
        {mode === "register" && registerStep === "verify" ? (
          <>
            <div className="rounded-xl bg-slate-100 px-3 py-2 text-sm text-slate-700">
              Verification email: <span className="font-semibold">{pendingEmail || email}</span>
            </div>
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-slate-700">6-digit code</span>
              <input
                required
                value={verificationCode}
                onChange={(event) => setVerificationCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
                inputMode="numeric"
                pattern="[0-9]{6}"
                className="min-h-11 w-full rounded-xl border border-slate-300 px-3 text-slate-900 outline-none ring-orange-500 transition focus:ring"
                placeholder="Enter verification code"
              />
            </label>
            <button
              type="button"
              onClick={() => {
                setRegisterStep("form");
                setVerificationCode("");
                setInfo(null);
              }}
              className="min-h-11 w-full rounded-xl border border-slate-300 px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-100"
            >
              Edit registration details
            </button>
          </>
        ) : null}

        {mode === "register" && registerStep === "form" && (
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">Name</span>
            <input
              required
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="min-h-11 w-full rounded-xl border border-slate-300 px-3 text-slate-900 outline-none ring-orange-500 transition focus:ring"
              placeholder="Your first name"
            />
          </label>
        )}

        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-700">Email</span>
          <input
            required
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="min-h-11 w-full rounded-xl border border-slate-300 px-3 text-slate-900 outline-none ring-orange-500 transition focus:ring"
            placeholder="you@example.com"
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-700">Password</span>
          <input
            required
            minLength={8}
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="min-h-11 w-full rounded-xl border border-slate-300 px-3 text-slate-900 outline-none ring-orange-500 transition focus:ring"
            placeholder="Minimum 8 characters"
          />
        </label>

        {mode === "register" && registerStep === "form" && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="mb-1 block text-sm font-medium text-slate-700">Gender</span>
                <select
                  value={gender}
                  onChange={(event) => setGender(event.target.value as Gender)}
                  className="min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-slate-900 outline-none ring-orange-500 transition focus:ring"
                >
                  <option value="male">Male</option>
                  <option value="female">Female</option>
                </select>
              </label>

              <label className="block">
                <span className="mb-1 block text-sm font-medium text-slate-700">Looking for</span>
                <select
                  value={preferredGender}
                  onChange={(event) => setPreferredGender(event.target.value as PreferredGender)}
                  className="min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-slate-900 outline-none ring-orange-500 transition focus:ring"
                >
                  <option value="both">Both</option>
                  <option value="male">Male</option>
                  <option value="female">Female</option>
                </select>
              </label>
            </div>

            <label className="block">
              <span className="mb-1 block text-sm font-medium text-slate-700">Profile image URL (optional)</span>
              <input
                type="url"
                value={profileImageUrl}
                onChange={(event) => setProfileImageUrl(event.target.value)}
                className="min-h-11 w-full rounded-xl border border-slate-300 px-3 text-slate-900 outline-none ring-orange-500 transition focus:ring"
                placeholder="https://i.pravatar.cc/300?u=my-id"
              />
            </label>
          </>
        )}

        {info && <p className="rounded-xl bg-blue-50 px-3 py-2 text-sm text-blue-700">{info}</p>}
        {error && <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

        <button
          type="submit"
          disabled={isSubmitting}
          className="min-h-11 w-full rounded-xl bg-slate-900 px-4 text-sm font-semibold text-white transition hover:bg-black disabled:opacity-60"
        >
          {isSubmitting
            ? "Please wait..."
            : mode === "register"
              ? registerStep === "form"
                ? "Send verification code"
                : "Verify and create account"
              : "Sign in"}
        </button>
      </form>
    </section>
  );
}
