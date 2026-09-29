export interface ServiceHealth {
  status: "ready" | "degraded";
  reasons: string[];
  worker?: { lastProgressAt: number; activeSince: number | null };
  backlog?: { overdueJobs: number; oldestDueAt: string | null };
}
