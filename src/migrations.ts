import type { Database } from "bun:sqlite";

const migrations = [
  `CREATE TABLE IF NOT EXISTS bills (
    id TEXT PRIMARY KEY, whatsapp_message_id TEXT NOT NULL, whatsapp_group_id TEXT NOT NULL,
    whatsapp_sender_id TEXT NOT NULL, attachment_index INTEGER NOT NULL CHECK (attachment_index >= 0),
    received_at TEXT NOT NULL, caption TEXT, original_filename TEXT, mime_type TEXT NOT NULL,
    original_path TEXT NOT NULL, content_sha256 TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('received','extracting','needs_review','approved','failed')),
    drive_file_id TEXT, sheet_row_key TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE (whatsapp_message_id, attachment_index)
  );
  CREATE TABLE IF NOT EXISTS extractions (
    id TEXT PRIMARY KEY, bill_id TEXT NOT NULL UNIQUE REFERENCES bills(id), schema_version TEXT NOT NULL,
    normalized_json TEXT, raw_provider_response TEXT, provider_model TEXT, prompt_schema_version TEXT,
    requested_at TEXT, error_details TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS validation_issues (
    id TEXT PRIMARY KEY, bill_id TEXT NOT NULL REFERENCES bills(id), field TEXT, code TEXT NOT NULL,
    message TEXT NOT NULL, severity TEXT NOT NULL CHECK (severity IN ('warning','blocking')),
    observed_value TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY, bill_id TEXT NOT NULL REFERENCES bills(id), type TEXT NOT NULL CHECK (type IN ('extract','archive_to_drive','project_to_sheet','sync_review_correction')),
    state TEXT NOT NULL CHECK (state IN ('pending','running','succeeded','retryable_failure','permanent_failure')),
    idempotency_key TEXT NOT NULL UNIQUE, attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0), available_at TEXT NOT NULL,
    lease_token TEXT, lease_expires_at TEXT, claimed_by TEXT, claimed_at TEXT, last_error TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS jobs_claimable_idx ON jobs(state, available_at);
  CREATE INDEX IF NOT EXISTS jobs_bill_idx ON jobs(bill_id);
  CREATE TABLE IF NOT EXISTS review_events (
    id TEXT PRIMARY KEY, bill_id TEXT NOT NULL REFERENCES bills(id), reviewer_id TEXT NOT NULL, action TEXT NOT NULL,
    previous_values TEXT, corrected_values TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS provider_projection_metadata (
    id TEXT PRIMARY KEY, bill_id TEXT NOT NULL REFERENCES bills(id), provider TEXT NOT NULL, projection_key TEXT NOT NULL,
    external_id TEXT, external_url TEXT, metadata_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE (provider, projection_key)
  );`,
  `CREATE TABLE IF NOT EXISTS job_transition_history (
    id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), from_state TEXT,
    to_state TEXT NOT NULL CHECK (to_state IN ('pending','running','succeeded','retryable_failure','permanent_failure')),
    reason TEXT NOT NULL, created_at TEXT NOT NULL
  );
   CREATE INDEX IF NOT EXISTS job_transition_history_job_idx ON job_transition_history(job_id, created_at);`,
  `ALTER TABLE extractions ADD COLUMN completed_at TEXT;`,
  `CREATE TABLE IF NOT EXISTS extraction_attempts (
    id TEXT PRIMARY KEY, bill_id TEXT NOT NULL REFERENCES bills(id), job_id TEXT NOT NULL REFERENCES jobs(id),
    job_attempt INTEGER NOT NULL, provider_model TEXT, requested_at TEXT NOT NULL, completed_at TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('succeeded','failed')), raw_provider_response TEXT, error_details TEXT,
    created_at TEXT NOT NULL
  );
   CREATE INDEX IF NOT EXISTS extraction_attempts_bill_idx ON extraction_attempts(bill_id, created_at);`,
  `ALTER TABLE validation_issues RENAME TO validation_issues_previous;
   CREATE TABLE validation_issues (
     id TEXT PRIMARY KEY, bill_id TEXT NOT NULL REFERENCES bills(id), field TEXT, code TEXT NOT NULL,
     message TEXT NOT NULL, severity TEXT NOT NULL CHECK (severity IN ('warning','error','blocking')),
     observed_value TEXT, created_at TEXT NOT NULL
   );
   INSERT INTO validation_issues (id, bill_id, field, code, message, severity, observed_value, created_at)
     SELECT id, bill_id, field, code, message, severity, observed_value, created_at FROM validation_issues_previous;
   DROP TABLE validation_issues_previous;
   CREATE INDEX IF NOT EXISTS validation_issues_bill_idx ON validation_issues(bill_id);`,
  `ALTER TABLE bills ADD COLUMN content_revision INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE bills ADD COLUMN review_revision INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE jobs ADD COLUMN expected_revision INTEGER;
   CREATE INDEX IF NOT EXISTS jobs_project_revision_idx ON jobs(bill_id, type, expected_revision);`,
  `ALTER TABLE bills ADD COLUMN manual_review_required INTEGER NOT NULL DEFAULT 0;`,
  `CREATE TABLE IF NOT EXISTS drive_reservations (
    reservation_key TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('file','folder')),
    parent_id TEXT, logical_path TEXT NOT NULL UNIQUE, drive_id TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL CHECK (state IN ('reserved','confirmed')), bill_id TEXT REFERENCES bills(id),
    content_sha256 TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
   );`,
  /* Coordinator-approved Phase 5 canonical-review extension.  Model extraction remains in
     extractions; this table contains only reviewer-selected effective values. */
  `CREATE TABLE IF NOT EXISTS effective_bill_data (
     bill_id TEXT PRIMARY KEY REFERENCES bills(id), normalized_json TEXT NOT NULL,
     revision INTEGER NOT NULL, updated_at TEXT NOT NULL
   );
   ALTER TABLE review_events ADD COLUMN reason TEXT;
   ALTER TABLE review_events ADD COLUMN note TEXT;
   CREATE INDEX IF NOT EXISTS review_events_bill_idx ON review_events(bill_id, created_at);`,
];

export function applyMigrations(db: Database): void {
  db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    const applied = db.query<{ version: number }, [number]>("SELECT version FROM schema_migrations WHERE version = ?");
    const record = db.query<unknown, [number, string]>("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?) ON CONFLICT(version) DO NOTHING");
    migrations.forEach((sql, index) => {
      const version = index + 1;
      if (applied.get(version)) return;
      db.exec(sql);
      record.run(version, new Date().toISOString());
    });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
