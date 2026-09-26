/**
 * Optional HTTP Basic authentication for the whole app, enforced in
 * src/proxy.ts. Set BASIC_AUTH_USER and BASIC_AUTH_PASSWORD to turn it on.
 *
 * In production (`next start`) a login is required: without credentials the
 * app answers 503 with instructions, unless AUTH_DISABLED=true is set. This
 * keeps a deploy from exposing the database by accident.
 */

export type AuthConfig =
  | { mode: "off" }
  | { mode: "basic"; user: string; password: string }
  | { mode: "misconfigured"; reason: string };

const MIN_PASSWORD_LENGTH = 12;

type Env = Record<string, string | undefined>;

export function authConfig(env: Env = process.env): AuthConfig {
  const user = env.BASIC_AUTH_USER;
  const password = env.BASIC_AUTH_PASSWORD;
  if (user && password) {
    if (password.length < MIN_PASSWORD_LENGTH) {
      return { mode: "misconfigured", reason: `BASIC_AUTH_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters.` };
    }
    return { mode: "basic", user, password };
  }
  if (user || password) {
    return { mode: "misconfigured", reason: "Set both BASIC_AUTH_USER and BASIC_AUTH_PASSWORD to enable the login." };
  }
  if (env.AUTH_DISABLED === "true" || env.NODE_ENV !== "production") return { mode: "off" };
  return {
    mode: "misconfigured",
    reason:
      "No login is configured, so this app is locked. Set BASIC_AUTH_USER and BASIC_AUTH_PASSWORD, " +
      "or set AUTH_DISABLED=true to run without a login (only on a private network).",
  };
}

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

/** Compare two strings in constant time (via fixed-length digests). */
async function safeEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/** Check an `Authorization: Basic …` header against the configured credentials. */
export async function isAuthorized(header: string | null, user: string, password: string): Promise<boolean> {
  const match = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header ?? "");
  if (!match) return false;
  let decoded: string;
  try {
    decoded = new TextDecoder().decode(Uint8Array.from(atob(match[1]), (c) => c.charCodeAt(0)));
  } catch {
    return false;
  }
  const colon = decoded.indexOf(":");
  if (colon === -1) return false;
  // Check both parts every time, so timing doesn't reveal which one was wrong.
  const [userOk, passwordOk] = await Promise.all([
    safeEqual(decoded.slice(0, colon), user),
    safeEqual(decoded.slice(colon + 1), password),
  ]);
  return userOk && passwordOk;
}
