-- compat: backward-compatible
-- #393 — delete_expired_failed_events() must only prune resolved failed events
-- (WHERE resolved_at IS NOT NULL) and guard against empty string in GUC setting
-- via NULLIF(..., '').
CREATE OR REPLACE FUNCTION delete_expired_failed_events() RETURNS void AS $$
BEGIN
  DELETE FROM failed_events
  WHERE resolved_at IS NOT NULL
    AND created_at < now() - INTERVAL '1 day' * COALESCE(
      NULLIF(current_setting('app.failed_events_retention_days', true), '')::int,
      30
    );
END;
$$ LANGUAGE plpgsql;
