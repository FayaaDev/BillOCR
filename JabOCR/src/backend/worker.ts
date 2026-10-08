import { jobTypes, type JobHandlerContext, type JobHandlers } from "./contracts";
import type { BillDatabase, RetryPolicy } from "../db/database";
import type { Logger } from "./logger";

export class PermanentJobError extends Error { readonly retryable = false; }

/** Executes one injected provider handler after its DB claim transaction has closed. */
export class JobWorker {
  constructor(private readonly database: BillDatabase, private readonly handlers: JobHandlers, private readonly policy: RetryPolicy, private readonly workerId: string, private readonly logger: Logger) {}

  get supportedTypes() { return jobTypes.filter((type) => this.handlers[type] !== undefined); }

  async runOnce(): Promise<boolean> {
    const job = this.database.claimNextJob(this.workerId, this.policy, new Date(), this.supportedTypes);
    if (!job) return false;
    const handler = this.handlers[job.type];
    if (!handler) return false;
    let leaseLost = false;
    const heartbeat = setInterval(() => {
      try {
        if (!this.database.renewLease(job.id, job.leaseToken, this.policy.leaseMs)) {
          leaseLost = true;
          this.logger.warn("job lease heartbeat lost ownership", { jobId: job.id });
        }
      } catch {
        leaseLost = true;
        this.logger.warn("job lease heartbeat failed", { jobId: job.id });
      }
    }, Math.max(1, Math.floor(this.policy.leaseMs / 3)));
    const context: JobHandlerContext = {
      idempotencyKey: job.idempotencyKey,
      assertLease: () => {
        try {
          if (this.database.renewLease(job.id, job.leaseToken, this.policy.leaseMs)) return;
          leaseLost = true;
        } catch {
          leaseLost = true;
        }
        throw new Error("Job lease is no longer owned");
      },
      assertCurrentApprovalRevision: () => {
        if (job.type !== "project_to_sheet" || this.database.isApprovedAtRevision(job.billId, job.expectedRevision)) return;
        throw new PermanentJobError("Project job is no longer approved at its expected revision");
      },
    };
    try {
      await handler(job, context); // External work occurs after claimNextJob's transaction has returned.
      if (job.type === "project_to_sheet") context.assertCurrentApprovalRevision();
      if (leaseLost || !this.database.completeJob(job.id, job.leaseToken)) this.logger.warn("job completion lost lease", { jobId: job.id });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.database.failJob(job.id, job.leaseToken, message, this.policy, new Date(), !(error instanceof PermanentJobError));
      this.logger.warn("job handler failed", { jobId: job.id, type: job.type });
    } finally {
      clearInterval(heartbeat);
    }
    return true;
  }
}

export interface BackgroundWorker { runOnce(): Promise<boolean>; }

/** Timer-driven worker lifecycle: it yields between jobs and can be stopped before DB shutdown. */
export class BackgroundWorkerLoop {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active: Promise<void> | undefined;
  private acceptingWork = false;
  private lastProgressAt = Date.now();
  private activeSince: number | null = null;
  private failed = false;

  constructor(private readonly worker: BackgroundWorker, private readonly logger: Logger, private readonly idleDelayMs = 1_000, private readonly activeDelayMs = 10) {}

  start(): void {
    if (this.acceptingWork) return;
    this.acceptingWork = true;
    this.lastProgressAt = Date.now();
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.acceptingWork = false;
    if (this.timer) clearTimeout(this.timer);
    await this.active;
  }

  health(now = Date.now(), maxJobMs = 15 * 60_000): { reasons: string[]; lastProgressAt: number; activeSince: number | null } {
    const reasons: string[] = [];
    if (!this.acceptingWork) reasons.push("worker_stopped");
    if (this.failed) reasons.push("worker_failed");
    if (this.activeSince !== null ? now - this.activeSince > maxJobMs : now - this.lastProgressAt > Math.max(30_000, this.idleDelayMs * 3)) reasons.push("worker_stalled");
    return { reasons, lastProgressAt: this.lastProgressAt, activeSince: this.activeSince };
  }

  private schedule(delayMs: number): void {
    if (!this.acceptingWork) return;
    this.timer = setTimeout(() => { void this.tick(); }, delayMs);
  }

  private async tick(): Promise<void> {
    this.activeSince = Date.now();
    this.active = (async () => {
      try {
        const processed = await this.worker.runOnce();
        this.failed = false;
        this.lastProgressAt = Date.now();
        this.schedule(processed ? this.activeDelayMs : this.idleDelayMs);
      } catch {
        this.failed = true;
        this.logger.error("background worker iteration failed");
        this.schedule(this.idleDelayMs);
      } finally {
        this.activeSince = null;
      }
    })();
    await this.active;
  }
}
