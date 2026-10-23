// Classify only the known schema prerequisite. Never return/log raw SQL or causes.
export function missingFinancialSchema(error: unknown): boolean {
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 5 && error instanceof Error && !seen.has(error); depth++) {
    seen.add(error);
    if (/no such table:\s*(?:main\.)?financial_adjustments\b/i.test(error.message)) return true;
    error = error.cause;
  }
  return false;
}
