// Matching for words that mark text as student or customer data. The shipped lists hold only everyday words; the names that identify a person's own school, courses, or customers are added as extra terms from a file kept outside the repository.
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A case-insensitive whole-word matcher for a base pattern plus extra literal terms. A hyphen inside a term matches with or without it, so `mis-600` also matches `mis600`. */
export function termRegex(base: string, extra: readonly string[]): RegExp {
  const terms = extra.map(t => t.trim()).filter(Boolean).map(t => escape(t).replace(/-/g, '-?'));
  const all = [base, ...terms].filter(Boolean).join('|');
  return new RegExp(`\\b(${all})\\b`, 'i');
}
