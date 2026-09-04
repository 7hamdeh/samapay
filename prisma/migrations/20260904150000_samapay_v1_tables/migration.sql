
-- =====================================================================
-- HAND-WRITTEN, IN THE SCHEMA'S OWN WORDS: audit_events IS APPEND-ONLY.
-- =====================================================================
-- Copied as a CONTRACT from SamaPrime's 20260826193605 / 20260827010000
-- migrations (the audit chain there carries seven permanent scars from
-- rows deleted before this trigger existed). Here it exists from row one.
CREATE OR REPLACE FUNCTION audit_events_no_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is immutable in place: row % cannot be modified', OLD.id
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER audit_events_immutable BEFORE UPDATE ON "audit_events"
  FOR EACH ROW EXECUTE FUNCTION audit_events_no_update();

CREATE OR REPLACE FUNCTION audit_events_no_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only: deleting row % would break the hash chain permanently', OLD.id
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON "audit_events"
  FOR EACH ROW EXECUTE FUNCTION audit_events_no_delete();
