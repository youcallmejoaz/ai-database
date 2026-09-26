import { friendlyError } from "@/lib/agent";
import { getSchemaSummary } from "@/lib/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The schema summary the agent sees. */
export async function GET() {
  try {
    return Response.json({ schema: await getSchemaSummary() });
  } catch (err) {
    return Response.json({ error: friendlyError(err) }, { status: 500 });
  }
}

/** Reload the schema after the database structure changes. */
export async function POST() {
  try {
    return Response.json({ schema: await getSchemaSummary({ refresh: true }) });
  } catch (err) {
    return Response.json({ error: friendlyError(err) }, { status: 500 });
  }
}
