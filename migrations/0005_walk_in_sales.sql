-- Rebuild only the three mandatory-customer tables, preserving every original ID/value.
-- D1 executes migrations transactionally. Foreign keys remain enabled.
PRAGMA defer_foreign_keys=ON;
CREATE TABLE sales_walk_in_new (
    id TEXT PRIMARY KEY,
    customer_id TEXT REFERENCES customers(id),
    created_by TEXT NOT NULL REFERENCES users(id),
    status TEXT NOT NULL DEFAULT 'completed'
        CHECK (status IN ('completed', 'cancelled')),
    total_kurus INTEGER NOT NULL CHECK (total_kurus >= 0),
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    sale_type TEXT NOT NULL DEFAULT 'normal' CHECK (sale_type IN ('normal','walk_in')),
    walk_in_customer_name TEXT,
    CHECK ((sale_type='normal' AND customer_id IS NOT NULL AND walk_in_customer_name IS NULL)
      OR (sale_type='walk_in' AND customer_id IS NULL AND typeof(total_kurus)='integer' AND total_kurus BETWEEN 1 AND 9007199254740991
        AND (walk_in_customer_name IS NULL OR (length(trim(walk_in_customer_name)) BETWEEN 1 AND 160))))
);
INSERT INTO sales_walk_in_new (id,customer_id,created_by,status,total_kurus,idempotency_key,created_at,updated_at) SELECT id,customer_id,created_by,status,total_kurus,idempotency_key,created_at,updated_at FROM sales;
CREATE TABLE payments_walk_in_new (
    id TEXT PRIMARY KEY,
    customer_id TEXT REFERENCES customers(id),
    sale_id TEXT REFERENCES sales(id),
    amount_kurus INTEGER NOT NULL CHECK (amount_kurus > 0),
    method TEXT NOT NULL CHECK (method IN ('cash', 'card', 'bank')),
    created_by TEXT NOT NULL REFERENCES users(id),
    idempotency_key TEXT NOT NULL UNIQUE,
    reversal_of_payment_id TEXT UNIQUE REFERENCES payments(id),
    created_at TEXT NOT NULL
);
INSERT INTO payments_walk_in_new (id,customer_id,sale_id,amount_kurus,method,created_by,idempotency_key,reversal_of_payment_id,created_at) SELECT id,customer_id,sale_id,amount_kurus,method,created_by,idempotency_key,reversal_of_payment_id,created_at FROM payments;
CREATE TABLE financial_adjustments_walk_in_new (
  id TEXT PRIMARY KEY,
  correction_request_id TEXT NOT NULL UNIQUE REFERENCES correction_requests(id),
  payment_id TEXT NOT NULL UNIQUE REFERENCES payments(id),
  reversal_payment_id TEXT NOT NULL UNIQUE REFERENCES payments(id),
  sale_id TEXT NOT NULL REFERENCES sales(id),
  customer_id TEXT REFERENCES customers(id),
  kind TEXT NOT NULL CHECK (kind IN ('record_reversal', 'external_refund')),
  amount_kurus INTEGER NOT NULL CHECK (typeof(amount_kurus) = 'integer' AND amount_kurus > 0 AND amount_kurus <= 9007199254740991),
  method TEXT NOT NULL CHECK (method IN ('cash', 'card', 'bank')),
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  requested_by TEXT NOT NULL REFERENCES users(id),
  performed_by TEXT NOT NULL REFERENCES users(id),
  approved_by TEXT NOT NULL REFERENCES users(id),
  before_sale_remaining_kurus INTEGER NOT NULL CHECK (before_sale_remaining_kurus >= 0),
  after_sale_remaining_kurus INTEGER NOT NULL CHECK ((customer_id IS NOT NULL AND after_sale_remaining_kurus = before_sale_remaining_kurus + amount_kurus AND after_sale_remaining_kurus <= 9007199254740991) OR (customer_id IS NULL AND before_sale_remaining_kurus=0 AND after_sale_remaining_kurus=0)),
  before_customer_debt_kurus INTEGER NOT NULL CHECK (before_customer_debt_kurus >= 0),
  after_customer_debt_kurus INTEGER NOT NULL CHECK ((customer_id IS NOT NULL AND after_customer_debt_kurus = before_customer_debt_kurus + amount_kurus AND after_customer_debt_kurus <= 9007199254740991) OR (customer_id IS NULL AND before_customer_debt_kurus=0 AND after_customer_debt_kurus=0)),
  external_reference TEXT,
  external_confirmed_at TEXT,
  created_at TEXT NOT NULL,
  CHECK (payment_id <> reversal_payment_id),
  CHECK ((kind = 'record_reversal' AND external_reference IS NULL AND external_confirmed_at IS NULL)
    OR (kind = 'external_refund' AND external_reference IS NOT NULL AND length(trim(external_reference)) BETWEEN 1 AND 200 AND external_confirmed_at IS NOT NULL))
);
INSERT INTO financial_adjustments_walk_in_new (id,correction_request_id,payment_id,reversal_payment_id,sale_id,customer_id,kind,amount_kurus,method,reason,requested_by,performed_by,approved_by,before_sale_remaining_kurus,after_sale_remaining_kurus,before_customer_debt_kurus,after_customer_debt_kurus,external_reference,external_confirmed_at,created_at) SELECT id,correction_request_id,payment_id,reversal_payment_id,sale_id,customer_id,kind,amount_kurus,method,reason,requested_by,performed_by,approved_by,before_sale_remaining_kurus,after_sale_remaining_kurus,before_customer_debt_kurus,after_customer_debt_kurus,external_reference,external_confirmed_at,created_at FROM financial_adjustments;
DROP TABLE financial_adjustments;
DROP TABLE payments;
DROP TABLE sales;
ALTER TABLE sales_walk_in_new RENAME TO sales;
ALTER TABLE payments_walk_in_new RENAME TO payments;
ALTER TABLE financial_adjustments_walk_in_new RENAME TO financial_adjustments;
CREATE INDEX idx_sales_customer ON sales(customer_id);
CREATE INDEX idx_sales_date ON sales(created_at);
CREATE INDEX idx_payments_customer ON payments(customer_id);
CREATE INDEX idx_payments_sale ON payments(sale_id);
CREATE INDEX idx_payments_date ON payments(created_at);
CREATE UNIQUE INDEX financial_adjustments_external_reference ON financial_adjustments(method, external_reference) WHERE kind = 'external_refund';
CREATE INDEX financial_adjustments_created_at ON financial_adjustments(created_at);
CREATE INDEX financial_adjustments_sale ON financial_adjustments(sale_id);
CREATE INDEX financial_adjustments_customer ON financial_adjustments(customer_id);
CREATE INDEX financial_adjustments_performer ON financial_adjustments(performed_by, created_at);
PRAGMA defer_foreign_keys=OFF;
