import type { AppConfig } from "./config";
import type { BillDatabase } from "./database";
import { handleAdminRequest, type AdminHttpCapabilities } from "./admin-ui";
import { handleReviewRequest } from "./review-ui";

export function handleRequest(request: Request, database?: BillDatabase, config?: AppConfig, admin?: AdminHttpCapabilities): Response | Promise<Response> {
  if (new URL(request.url).pathname === "/health") return Response.json({ status: "ok" });
  const pathname = new URL(request.url).pathname;
  if (config && (pathname === "/admin" || pathname.startsWith("/admin/"))) return handleAdminRequest(request, config, admin);
  if (database && config && (pathname === "/review" || pathname.startsWith("/review/"))) return handleReviewRequest(request, database, config);
  return new Response("Not found", { status: 404 });
}
