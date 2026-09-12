import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { timingSafeEqual } from "node:crypto";

const COOKIE = "jf_session";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days — this is a single-user tool

function secretKey(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error("AUTH_SECRET must be set to a random string of 16+ characters");
  }
  return new TextEncoder().encode(secret);
}

/** Constant-time compare so the login form cannot be probed byte by byte. */
export function checkPassword(input: string): boolean {
  const expected = process.env.APP_PASSWORD ?? "";
  if (!expected) return false;
  const a = Buffer.from(input);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function createSession() {
  const token = await new SignJWT({ sub: "owner" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE_SECONDS}s`)
    .sign(secretKey());

  const store = await cookies();
  store.set(COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  });
}

export async function destroySession() {
  const store = await cookies();
  store.delete(COOKIE);
}

export async function isAuthed(): Promise<boolean> {
  try {
    const token = (await cookies()).get(COOKIE)?.value;
    if (!token) return false;
    await jwtVerify(token, secretKey());
    return true;
  } catch {
    return false;
  }
}

/** Use at the top of every protected page. */
export async function requireAuth() {
  if (!(await isAuthed())) redirect("/login");
}

/** Guard for cron endpoints, which are called by GitHub Actions / Vercel. */
export function checkCronAuth(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  const bearer = header.replace(/^Bearer\s+/i, "");
  // Vercel Cron sends its own header; GitHub Actions sends ours.
  const vercelHeader = req.headers.get("x-vercel-signature");
  if (vercelHeader && process.env.VERCEL) return true;
  if (!bearer) return false;
  const a = Buffer.from(bearer);
  const b = Buffer.from(secret);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
