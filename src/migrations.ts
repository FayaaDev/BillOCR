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
  `ALTER TABLE extractions ADD COLUMN selected_provider TEXT CHECK (selected_provider IN ('mistral','azure'));
   ALTER TABLE extractions ADD COLUMN fallback_status TEXT CHECK (fallback_status IN ('not_needed','pending','succeeded','failed'));
   ALTER TABLE extraction_attempts ADD COLUMN provider TEXT NOT NULL DEFAULT 'mistral' CHECK (provider IN ('mistral','azure'));
   CREATE TABLE IF NOT EXISTS extraction_invocations (
     id TEXT PRIMARY KEY, bill_id TEXT NOT NULL REFERENCES bills(id), job_id TEXT NOT NULL REFERENCES jobs(id),
     job_attempt INTEGER NOT NULL CHECK (job_attempt >= 1), provider TEXT NOT NULL CHECK (provider IN ('mistral','azure')),
     idempotency_key TEXT NOT NULL, provider_model TEXT, prompt_schema_version TEXT, requested_at TEXT NOT NULL,
     completed_at TEXT, outcome TEXT NOT NULL CHECK (outcome IN ('requested','succeeded','failed')),
     raw_provider_response TEXT, error_details TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
     UNIQUE (job_id, job_attempt, provider)
   );
   CREATE INDEX IF NOT EXISTS extraction_invocations_bill_idx ON extraction_invocations(bill_id, created_at);
   CREATE TABLE IF NOT EXISTS azure_extraction_operations (
     id TEXT PRIMARY KEY, invocation_id TEXT NOT NULL UNIQUE REFERENCES extraction_invocations(id),
     bill_id TEXT NOT NULL REFERENCES bills(id), job_id TEXT NOT NULL REFERENCES jobs(id), operation_location TEXT NOT NULL UNIQUE,
     state TEXT NOT NULL CHECK (state IN ('submitted','running','succeeded','failed')), last_error TEXT,
     completed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
   );
   CREATE INDEX IF NOT EXISTS azure_extraction_operations_resume_idx ON azure_extraction_operations(state, updated_at);`,
  `ALTER TABLE extractions ADD COLUMN selected_invocation_id TEXT REFERENCES extraction_invocations(id);
    CREATE INDEX IF NOT EXISTS extractions_selected_invocation_idx ON extractions(selected_invocation_id);`,
  `ALTER TABLE azure_extraction_operations ADD COLUMN normalized_json TEXT;
   ALTER TABLE azure_extraction_operations ADD COLUMN raw_provider_response TEXT;
   ALTER TABLE azure_extraction_operations ADD COLUMN provider_model TEXT;`,
  `ALTER TABLE azure_extraction_operations RENAME TO azure_extraction_operations_previous;
   CREATE TABLE azure_extraction_operations (
     id TEXT PRIMARY KEY, invocation_id TEXT NOT NULL UNIQUE REFERENCES extraction_invocations(id),
     bill_id TEXT NOT NULL REFERENCES bills(id), job_id TEXT NOT NULL REFERENCES jobs(id), operation_location TEXT UNIQUE,
     state TEXT NOT NULL CHECK (state IN ('submitting','submitted','running','succeeded','failed')),
     normalized_json TEXT, raw_provider_response TEXT, provider_model TEXT, last_error TEXT,
     completed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
   );
   INSERT INTO azure_extraction_operations (id, invocation_id, bill_id, job_id, operation_location, state, normalized_json, raw_provider_response, provider_model, last_error, completed_at, created_at, updated_at)
     SELECT id, invocation_id, bill_id, job_id, operation_location, state, normalized_json, raw_provider_response, provider_model, last_error, completed_at, created_at, updated_at FROM azure_extraction_operations_previous;
   DROP TABLE azure_extraction_operations_previous;
   CREATE INDEX IF NOT EXISTS azure_extraction_operations_resume_idx ON azure_extraction_operations(state, updated_at);`,
  `CREATE TABLE IF NOT EXISTS admin_upload_batches (
      id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, original_filename TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('queued','processing','completed','failed')),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS admin_upload_batch_items (
      id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES admin_upload_batches(id), item_index INTEGER NOT NULL CHECK (item_index >= 0),
      entry_path TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('queued','processing','complete','not_invoice','rejected','failed')),
      error_code TEXT, bill_id TEXT REFERENCES bills(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE (batch_id, item_index)
    );
    CREATE INDEX IF NOT EXISTS admin_upload_batch_items_batch_idx ON admin_upload_batch_items(batch_id, state, item_index);
    ALTER TABLE bills ADD COLUMN source TEXT NOT NULL DEFAULT 'whatsapp' CHECK (source IN ('whatsapp','admin_upload'));
    ALTER TABLE bills ADD COLUMN source_identity TEXT;
    ALTER TABLE bills ADD COLUMN extraction_policy TEXT NOT NULL DEFAULT 'mistral_with_azure_fallback' CHECK (extraction_policy IN ('mistral_with_azure_fallback','azure_only'));
    ALTER TABLE bills ADD COLUMN classification TEXT NOT NULL DEFAULT 'unclassified' CHECK (classification IN ('unclassified','invoice','not_invoice'));
    ALTER TABLE bills ADD COLUMN batch_item_id TEXT REFERENCES admin_upload_batch_items(id);
    UPDATE bills SET source_identity = id WHERE source_identity IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS bills_source_identity_idx ON bills(source, source_identity) WHERE source_identity IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS bills_batch_item_idx ON bills(batch_item_id) WHERE batch_item_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS bill_classification_events (
      id TEXT PRIMARY KEY, bill_id TEXT NOT NULL REFERENCES bills(id), from_classification TEXT NOT NULL CHECK (from_classification IN ('unclassified','invoice','not_invoice')),
      to_classification TEXT NOT NULL CHECK (to_classification IN ('unclassified','invoice','not_invoice')),
      actor TEXT NOT NULL, reason TEXT, content_revision INTEGER NOT NULL, review_revision INTEGER NOT NULL, created_at TEXT NOT NULL
    );
     CREATE INDEX IF NOT EXISTS bill_classification_events_bill_idx ON bill_classification_events(bill_id, created_at);`,
  /* Source identity extension. This rebuild removes the legacy global WhatsApp-message
     uniqueness while retaining every existing bill ID for child FKs. */
  `CREATE TABLE bills_rebuilt (
     id TEXT PRIMARY KEY, source_message_id TEXT NOT NULL, source_chat_id TEXT NOT NULL,
     source_sender_id TEXT NOT NULL, attachment_index INTEGER NOT NULL CHECK (attachment_index >= 0),
     received_at TEXT NOT NULL, caption TEXT, original_filename TEXT, mime_type TEXT NOT NULL,
     original_path TEXT NOT NULL, content_sha256 TEXT NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('received','extracting','needs_review','approved','failed')),
     drive_file_id TEXT, sheet_row_key TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
     content_revision INTEGER NOT NULL DEFAULT 0, review_revision INTEGER NOT NULL DEFAULT 0,
     manual_review_required INTEGER NOT NULL DEFAULT 0,
     source TEXT NOT NULL CHECK (source IN ('whatsapp','telegram','admin_upload')),
     source_identity TEXT NOT NULL,
     extraction_policy TEXT NOT NULL CHECK (extraction_policy IN ('mistral_with_azure_fallback','azure_only')),
     classification TEXT NOT NULL CHECK (classification IN ('unclassified','invoice','not_invoice')),
     batch_item_id TEXT REFERENCES admin_upload_batch_items(id)
   );
   INSERT INTO bills_rebuilt (id, source_message_id, source_chat_id, source_sender_id, attachment_index, received_at, caption, original_filename, mime_type, original_path, content_sha256, status, drive_file_id, sheet_row_key, created_at, updated_at, content_revision, review_revision, manual_review_required, source, source_identity, extraction_policy, classification, batch_item_id)
     SELECT id, whatsapp_message_id, whatsapp_group_id, whatsapp_sender_id, attachment_index, received_at, caption, original_filename, mime_type, original_path, content_sha256, status, drive_file_id, sheet_row_key, created_at, updated_at, content_revision, review_revision, manual_review_required, source, source_identity, extraction_policy, classification, batch_item_id FROM bills;
   DROP TABLE bills;
   ALTER TABLE bills_rebuilt RENAME TO bills;
   CREATE UNIQUE INDEX bills_source_identity_idx ON bills(source, source_identity);
   CREATE UNIQUE INDEX bills_batch_item_idx ON bills(batch_item_id) WHERE batch_item_id IS NOT NULL;
   CREATE INDEX bills_source_message_idx ON bills(source, source_chat_id, source_message_id, attachment_index);
   CREATE TABLE IF NOT EXISTS telegram_polling_cursor (
     id INTEGER PRIMARY KEY CHECK (id = 1), next_update_id INTEGER NOT NULL CHECK (next_update_id >= 0), updated_at TEXT NOT NULL
   );`,
  /* Historical WhatsApp rows used a bill ID for source_identity. Runtime identity is the
     canonical message tuple; normalize only WhatsApp and leave ZIP/admin identities intact. */
  `UPDATE bills
     SET source_identity = json_array(source_chat_id, source_message_id, attachment_index)
    WHERE source = 'whatsapp'
      AND source_identity <> json_array(source_chat_id, source_message_id, attachment_index);`,
  /* Historical original_filename values were sanitized, so they cannot safely seed a global
     source-filename identity. New intake retains its bounded raw basename separately. */
  `ALTER TABLE bills ADD COLUMN source_filename TEXT;
   ALTER TABLE bills ADD COLUMN filename_key TEXT;
   CREATE UNIQUE INDEX bills_filename_key_idx ON bills(filename_key COLLATE BINARY) WHERE filename_key IS NOT NULL;`,
  /* Legacy transport filenames were sanitized and therefore untrusted. ZIP entry paths retain
     a source basename only when their stored path is demonstrably safe and untruncated. */
  `CREATE TEMP TABLE legacy_zip_filename_candidates (
      bill_id TEXT PRIMARY KEY, source_filename TEXT NOT NULL, filename_key TEXT NOT NULL, created_at TEXT NOT NULL
    );
    WITH RECURSIVE stripped(bill_id, basename) AS (
      SELECT b.id, item.entry_path FROM bills b
        JOIN admin_upload_batch_items item ON item.id = b.batch_item_id
       WHERE b.source = 'admin_upload' AND b.source_filename IS NULL
         AND length(item.entry_path) BETWEEN 1 AND 999
         AND instr(item.entry_path, char(0)) = 0 AND instr(item.entry_path, char(92)) = 0
         AND item.entry_path NOT LIKE '/%' AND item.entry_path NOT GLOB '[A-Za-z]:*'
         AND item.entry_path NOT IN ('.', '..') AND item.entry_path NOT LIKE './%' AND item.entry_path NOT LIKE '../%'
         AND item.entry_path NOT LIKE '%//%' AND item.entry_path NOT LIKE '%/./%' AND item.entry_path NOT LIKE '%/../%'
         AND item.entry_path NOT LIKE '%/.' AND item.entry_path NOT LIKE '%/..'
      UNION ALL
      SELECT bill_id, substr(basename, instr(basename, '/') + 1) FROM stripped WHERE instr(basename, '/') > 0
    ), positions(bill_id, basename, position) AS (
      SELECT bill_id, basename, 1 FROM stripped WHERE instr(basename, '/') = 0
      UNION ALL
      SELECT bill_id, basename, position + 1 FROM positions WHERE position < length(basename)
    )
    INSERT INTO legacy_zip_filename_candidates (bill_id, source_filename, filename_key, created_at)
      SELECT p.bill_id, p.basename,
        CASE WHEN MAX(CASE WHEN substr(p.basename, p.position, 1) = '.' THEN p.position ELSE 0 END) > 1
          THEN substr(p.basename, 1, MAX(CASE WHEN substr(p.basename, p.position, 1) = '.' THEN p.position ELSE 0 END) - 1)
          ELSE p.basename END,
        b.created_at
      FROM positions p JOIN bills b ON b.id = p.bill_id
      WHERE length(p.basename) BETWEEN 1 AND 512
      GROUP BY p.bill_id, p.basename, b.created_at;
    UPDATE bills SET source_filename = (SELECT source_filename FROM legacy_zip_filename_candidates WHERE bill_id = bills.id)
      WHERE id IN (SELECT bill_id FROM legacy_zip_filename_candidates);
    UPDATE bills SET filename_key = (SELECT filename_key FROM legacy_zip_filename_candidates WHERE bill_id = bills.id)
      WHERE id IN (
        SELECT candidate.bill_id FROM legacy_zip_filename_candidates candidate
         WHERE NOT EXISTS (
           SELECT 1 FROM legacy_zip_filename_candidates earlier
            WHERE earlier.filename_key = candidate.filename_key
              AND (earlier.created_at < candidate.created_at OR (earlier.created_at = candidate.created_at AND earlier.bill_id < candidate.bill_id))
         )
           AND NOT EXISTS (SELECT 1 FROM bills existing WHERE existing.filename_key = candidate.filename_key)
      );
    DROP TABLE legacy_zip_filename_candidates;`,
  `DROP INDEX bills_filename_key_idx;
   ALTER TABLE bills ADD COLUMN dedup_sha256 TEXT;
   UPDATE bills SET dedup_sha256 = content_sha256
     WHERE id = (SELECT first.id FROM bills first WHERE first.content_sha256 = bills.content_sha256 ORDER BY first.created_at, first.id LIMIT 1);
   CREATE UNIQUE INDEX bills_dedup_sha256_idx ON bills(dedup_sha256) WHERE dedup_sha256 IS NOT NULL;
   CREATE INDEX bills_content_sha256_idx ON bills(content_sha256);`,
];

export function applyMigrations(db: Database): void {
  // SQLite cannot remove an inline UNIQUE constraint without rebuilding its table. Disable FK
  // enforcement before the transaction only for that rebuild, then verify integrity afterwards.
  let transactionOpen = false;
  try {
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = OFF;");
    db.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    const applied = db.query<{ version: number }, [number]>("SELECT version FROM schema_migrations WHERE version = ?");
    const record = db.query<unknown, [number, string]>("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?) ON CONFLICT(version) DO NOTHING");
    migrations.forEach((sql, index) => {
      const version = index + 1;
      if (applied.get(version)) return;
      db.exec(sql);
      record.run(version, new Date().toISOString());
    });
    const violations = db.query<{ count: number }, []>("SELECT count(*) AS count FROM pragma_foreign_key_check").get()?.count ?? 0;
    if (violations > 0) throw new Error("Migration produced foreign key violations");
    db.exec("COMMIT");
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) db.exec("ROLLBACK");
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON;");
  }
}
