-- compat: breaking (quarantine_state is keyed by contract_id instead of a single id = 1 row)
-- Issue #384: quarantine_state moves from a single `id = 1` singleton row to
-- one row per contract_id, primary-keyed on contract_id. With multi-contract
-- tailing, multiple contracts share the same poller execution; an independent
-- failure counter and escalation state per contract is required.

ALTER TABLE quarantine_state ADD COLUMN IF NOT EXISTS contract_id TEXT;

-- Attribute pre-existing singleton row to the existing cursor contract if available
UPDATE quarantine_state
   SET contract_id = (SELECT contract_id FROM indexer_cursor ORDER BY updated_at DESC LIMIT 1)
 WHERE contract_id IS NULL;

DELETE FROM quarantine_state WHERE contract_id IS NULL;

ALTER TABLE quarantine_state DROP CONSTRAINT IF EXISTS single_row;
ALTER TABLE quarantine_state DROP CONSTRAINT IF EXISTS quarantine_state_single_row_check;
ALTER TABLE quarantine_state ALTER COLUMN contract_id SET NOT NULL;
ALTER TABLE quarantine_state DROP CONSTRAINT IF EXISTS quarantine_state_pkey;
ALTER TABLE quarantine_state ADD CONSTRAINT quarantine_state_pkey PRIMARY KEY (contract_id);
ALTER TABLE quarantine_state ALTER COLUMN id DROP NOT NULL;
ALTER TABLE quarantine_state ALTER COLUMN id SET DEFAULT 1;
