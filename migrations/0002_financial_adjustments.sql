-- Full reversals only. A refund is an administrator's attestation of an external
-- payment, never a bank/POS command. Original payments remain immutable.
CREATE TABLE financial_adjustments (
  id TEXT PRIMARY KEY,
  correction_request_id TEXT NOT NULL UNIQUE REFERENCES correction_requests(id),
  payment_id TEXT NOT NULL UNIQUE REFERENCES payments(id),
  reversal_payment_id TEXT NOT NULL UNIQUE REFERENCES payments(id),
  sale_id TEXT NOT NULL REFERENCES sales(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  kind TEXT NOT NULL CHECK (kind IN ('record_reversal', 'external_refund')),
  amount_kurus INTEGER NOT NULL CHECK (typeof(amount_kurus) = 'integer' AND amount_kurus > 0 AND amount_kurus <= 9007199254740991),
  method TEXT NOT NULL CHECK (method IN ('cash', 'card', 'bank')),
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  requested_by TEXT NOT NULL REFERENCES users(id),
  performed_by TEXT NOT NULL REFERENCES users(id),
  approved_by TEXT NOT NULL REFERENCES users(id),
  before_sale_remaining_kurus INTEGER NOT NULL CHECK (before_sale_remaining_kurus >= 0),
  after_sale_remaining_kurus INTEGER NOT NULL CHECK (after_sale_remaining_kurus = before_sale_remaining_kurus + amount_kurus AND after_sale_remaining_kurus <= 9007199254740991),
  before_customer_debt_kurus INTEGER NOT NULL CHECK (before_customer_debt_kurus >= 0),
  after_customer_debt_kurus INTEGER NOT NULL CHECK (after_customer_debt_kurus = before_customer_debt_kurus + amount_kurus AND after_customer_debt_kurus <= 9007199254740991),
  external_reference TEXT,
  external_confirmed_at TEXT,
  created_at TEXT NOT NULL,
  CHECK (payment_id <> reversal_payment_id),
  CHECK ((kind = 'record_reversal' AND external_reference IS NULL AND external_confirmed_at IS NULL)
    OR (kind = 'external_refund' AND external_reference IS NOT NULL AND length(trim(external_reference)) BETWEEN 1 AND 200 AND external_confirmed_at IS NOT NULL))
);
CREATE UNIQUE INDEX financial_adjustments_external_reference ON financial_adjustments(method, external_reference) WHERE kind = 'external_refund';
CREATE INDEX financial_adjustments_created_at ON financial_adjustments(created_at);
CREATE INDEX financial_adjustments_sale ON financial_adjustments(sale_id);
CREATE INDEX financial_adjustments_customer ON financial_adjustments(customer_id);
CREATE INDEX financial_adjustments_performer ON financial_adjustments(performed_by, created_at);
