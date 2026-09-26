export const dynamic = "force-dynamic";

/** Liveness check for the host (Render's healthCheckPath). Public, and reveals nothing. */
export function GET() {
  return Response.json({ ok: true });
}
