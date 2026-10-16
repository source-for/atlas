/**
 * Locale-independent string order: UTF-16 code-unit comparison, the same as
 * `Array.prototype.sort()` with no comparator. Use it for every order that decides an
 * ID, a truncation, a hash, or output order — `localeCompare` and `Intl.Collator`
 * follow the process locale (`LC_ALL`/`LANG`), so the same scan would differ by machine.
 */
export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
