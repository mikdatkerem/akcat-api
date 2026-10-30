// Classify only known financial schema prerequisites. Never return/log raw SQL or causes.
export function missingFinancialSchema(error: unknown): boolean {
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 5 && error instanceof Error && !seen.has(error); depth++) {
    seen.add(error);
    if (/no such column:\s*(?:\w+\.)?version\b|has no column named\s+version\b/i.test(error.message)) return true;
    if (/no such column:\s*(?:\w+\.)?(?:sale_type|walk_in_customer_name)\b|has no column named\s+(?:sale_type|walk_in_customer_name)\b/i.test(error.message)) return true;
    if (/no such table:\s*(?:main\.)?financial_adjustments\b/i.test(error.message)) return true;
    if (/no such column:\s*(?:\w+\.)?list_unit_price_kurus\b/i.test(error.message)
      || /table\s+sale_items\s+has no column named\s+list_unit_price_kurus\b/i.test(error.message)) return true;
    error = error.cause;
  }
  return false;
}
