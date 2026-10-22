// One definition for sale, receivables and collection reads/writes; reversal creation remains out of scope.
export const validPayment = "p.reversal_of_payment_id IS NULL AND NOT EXISTS (SELECT 1 FROM payments r WHERE r.reversal_of_payment_id = p.id)";
export const balancesCte = `WITH paid AS (
  SELECT p.sale_id, sum(p.amount_kurus) AS paid_kurus FROM payments p WHERE ${validPayment} GROUP BY p.sale_id
), balances AS (
  SELECT s.*, coalesce(p.paid_kurus, 0) AS paid_kurus, s.total_kurus - coalesce(p.paid_kurus, 0) AS remaining_kurus
  FROM sales s LEFT JOIN paid p ON p.sale_id = s.id
)`;
export function safeMoney(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Invalid financial amount");
  return value;
}
export function safeBalance(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error("Invalid financial balance");
  return value;
}
