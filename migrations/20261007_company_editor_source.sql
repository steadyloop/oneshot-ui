-- Preserve company IDs when administrator edits change their identity keys.
BEGIN;
ALTER TABLE frontend_identity ADD COLUMN IF NOT EXISTS previous_keys jsonb
    NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(previous_keys) = 'array');
COMMIT;
