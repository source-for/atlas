import { realpathSync } from "node:fs";
import { sep } from "node:path";

/** A machine path and what replaces it: `bare` for the path alone, `beforeSlash` when a `/…` suffix follows. */
export interface PathPrefix { path: string | undefined; bare: string; beforeSlash: string }

/** `<label>` for a path alone and `<label>/` before a suffix. */
export function labelledPrefix(label: string, path: string | undefined): PathPrefix {
  return { path, bare: `<${label}>`, beforeSlash: `<${label}>/` };
}

/**
 * Builds once, applies many times: rewrites each prefix (lexical and symlink-resolved spelling, longest first) in a
 * message. A prefix only matches as a whole path: never inside a longer path or URL (`/Volumes/X/Users/me`,
 * `file:///…`), never as part of a longer name (`/repo-old`, `/repo.bak`); a sentence-ending `.` still ends it.
 */
export function pathPrefixRewriter(prefixes: readonly PathPrefix[]): (text: string) => string {
  const forms = (path: string): string[] => {
    let physical = path;
    try { physical = realpathSync(path); } catch { /* keep the lexical path */ }
    return [...new Set([path, physical].map(form => form.split(sep).join("/").replace(/\/+$/, "")).filter(Boolean))];
  };
  const rules = prefixes.flatMap(prefix => prefix.path ? forms(prefix.path).map(form => ({ ...prefix, path: form })) : [])
    .sort((left, right) => right.path.length - left.path.length)
    .map(({ path, bare, beforeSlash }) => ({
      pattern: new RegExp(`(?<![\\w./-])${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:/|(?![\\w-]|\\.\\w))`, "g"),
      bare,
      beforeSlash,
    }));
  return text => rules.reduce((current, { pattern, bare, beforeSlash }) => current.replace(pattern, match => match.endsWith("/") ? beforeSlash : bare), text);
}
