-- Additive only: existing catalog/customer records start at version 1.
-- Financial history and sale-time snapshots are intentionally untouched.
ALTER TABLE products ADD COLUMN version INTEGER NOT NULL DEFAULT 1
    CHECK (typeof(version) = 'integer' AND version BETWEEN 1 AND 9007199254740991);
ALTER TABLE customers ADD COLUMN version INTEGER NOT NULL DEFAULT 1
    CHECK (typeof(version) = 'integer' AND version BETWEEN 1 AND 9007199254740991);
