import { NextResponse, type NextRequest } from "next/server";
import { authConfig, isAuthorized } from "@/lib/auth";

/** Puts every page and API route behind the optional login (see src/lib/auth.ts). */
export async function proxy(request: NextRequest) {
  const auth = authConfig();
  if (auth.mode === "off") return NextResponse.next();
  if (auth.mode === "misconfigured") {
    return new NextResponse(auth.reason, { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  if (await isAuthorized(request.headers.get("authorization"), auth.user, auth.password)) {
    return NextResponse.next();
  }
  return new NextResponse("Sign in to use the Database Agent.", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Database Agent", charset="UTF-8"', "Content-Type": "text/plain; charset=utf-8" },
  });
}

export const config = {
  // Everything except build assets and the health check Render polls.
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico$|api/health$).*)"],
};
