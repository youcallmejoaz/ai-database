import { describe, expect, it } from "vitest";
import { authConfig, isAuthorized } from "@/lib/auth";

const basic = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;

describe("authConfig", () => {
  it("is off in development when nothing is set", () => {
    expect(authConfig({ NODE_ENV: "development" })).toEqual({ mode: "off" });
  });

  it("locks production when no login is configured", () => {
    const config = authConfig({ NODE_ENV: "production" });
    expect(config.mode).toBe("misconfigured");
    if (config.mode === "misconfigured") expect(config.reason).toMatch(/BASIC_AUTH_USER/);
  });

  it("lets production run without a login only when explicitly disabled", () => {
    expect(authConfig({ NODE_ENV: "production", AUTH_DISABLED: "true" })).toEqual({ mode: "off" });
    expect(authConfig({ NODE_ENV: "production", AUTH_DISABLED: "1" }).mode).toBe("misconfigured");
  });

  it("enables basic auth when both values are set", () => {
    expect(authConfig({ NODE_ENV: "production", BASIC_AUTH_USER: "joel", BASIC_AUTH_PASSWORD: "correct horse battery" })).toEqual({
      mode: "basic",
      user: "joel",
      password: "correct horse battery",
    });
  });

  it("rejects half a configuration and short passwords, even with AUTH_DISABLED", () => {
    expect(authConfig({ BASIC_AUTH_USER: "joel", AUTH_DISABLED: "true" }).mode).toBe("misconfigured");
    expect(authConfig({ BASIC_AUTH_PASSWORD: "correct horse battery" }).mode).toBe("misconfigured");
    const short = authConfig({ BASIC_AUTH_USER: "joel", BASIC_AUTH_PASSWORD: "short" });
    expect(short.mode).toBe("misconfigured");
    if (short.mode === "misconfigured") expect(short.reason).toMatch(/at least 12/);
  });
});

describe("isAuthorized", () => {
  const user = "joel";
  const password = "correct horse: battery staple"; // a colon in the password is allowed

  it("accepts the right credentials", async () => {
    expect(await isAuthorized(basic(user, password), user, password)).toBe(true);
    expect(await isAuthorized(basic(user, password).replace("Basic", "basic"), user, password)).toBe(true);
  });

  it("rejects wrong, missing or malformed credentials", async () => {
    expect(await isAuthorized(basic(user, "wrong password here"), user, password)).toBe(false);
    expect(await isAuthorized(basic("someone", password), user, password)).toBe(false);
    expect(await isAuthorized(null, user, password)).toBe(false);
    expect(await isAuthorized("Bearer abc", user, password)).toBe(false);
    expect(await isAuthorized("Basic !!!not-base64!!!", user, password)).toBe(false);
    expect(await isAuthorized(`Basic ${Buffer.from("no-colon").toString("base64")}`, user, password)).toBe(false);
  });

  it("handles non-ASCII credentials", async () => {
    expect(await isAuthorized(basic("jöel", "pässwörd-über-12"), "jöel", "pässwörd-über-12")).toBe(true);
  });
});
