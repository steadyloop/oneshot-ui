-- Run against each OneShot serving database, including the local jobs DB.
BEGIN;

CREATE TABLE IF NOT EXISTS company_edit (
    company_id bigint PRIMARY KEY REFERENCES company(id) ON DELETE CASCADE,
    changes jsonb NOT NULL CHECK (
        jsonb_typeof(changes) = 'object'
        AND changes <> '{}'::jsonb
        AND changes - ARRAY['name', 'domain', 'description', 'tags'] = '{}'::jsonb
    ),
    edited_by uuid NOT NULL,
    revision uuid NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    sync_error text
);

COMMIT;
