import { useEffect, useState, type FormEvent } from "react";
import type { State } from "./useTelegraph";

interface Props {
  login: State["login"];
  onStart: (email: string) => boolean;
  onVerify: (email: string, code: string, name?: string) => boolean;
}

// email -> code -> (first login only) username
export function Login({ login, onStart, onVerify }: Props) {
  const [stage, setStage] = useState<"email" | "code" | "name">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Each reply from the local app moves the form on (or shows why not).
  useEffect(() => {
    if (!login) return;
    setBusy(false);
    setError(login.step === "error" ? login.reason ?? "something went wrong" : null);
    if (login.step === "code-sent") setStage("code");
    if (login.step === "needs-name") setStage("name");
  }, [login]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const sent =
      stage === "email" ? onStart(email) : onVerify(email, code, stage === "name" ? name.trim() : undefined);
    setBusy(sent);
    if (!sent) setError("local app not reachable");
  };

  const restart = () => {
    setStage("email");
    setCode("");
    setName("");
    setError(null);
  };

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <h1>Telegraph</h1>

        {stage === "email" && (
          <>
            <p>Log in or sign up with your email. We'll send you a 6-digit code.</p>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              aria-label="Email"
              autoComplete="email"
              autoFocus
              required
            />
            <button disabled={busy || !email.trim()}>{busy ? "Sending…" : "Send code"}</button>
          </>
        )}

        {stage === "code" && (
          <>
            <p>
              Enter the code sent to <strong>{email}</strong>.
            </p>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="123456"
              aria-label="Code"
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
            />
            <button disabled={busy || code.length !== 6}>{busy ? "Checking…" : "Log in"}</button>
            <div className="login-links">
              <button type="button" className="link" onClick={restart}>
                Use a different email
              </button>
              <button type="button" className="link" disabled={busy} onClick={() => setBusy(onStart(email))}>
                Resend code
              </button>
            </div>
          </>
        )}

        {stage === "name" && (
          <>
            <p>New account: pick a username. Others will add you by this name.</p>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="username"
              aria-label="Username"
              autoComplete="username"
              maxLength={32}
              autoFocus
            />
            <button disabled={busy || !name.trim()}>{busy ? "Creating…" : "Create account"}</button>
          </>
        )}

        {error && <div className="login-error">{error}</div>}
      </form>
    </div>
  );
}
