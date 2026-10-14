import { realpathSync } from "node:fs";
import { sep } from "node:path";

/**
 * A machine path and what replaces it: `bare` for the path alone, `beforeSlash` when a `/…` suffix follows.
 * `inFileUrl` also rewrites it right after `file://` (cargo's `path+file:///…` source ids): right for a `<label>`,
 * never for a relative replacement (`file://lib/a.ts` would be a different URL).
 */
export interface PathPrefix { path: string | undefined; bare: string; beforeSlash: string; inFileUrl?: boolean }

/** `<label>` for a path alone and `<label>/` before a suffix, also inside a `file://` URL. */
export function labelledPrefix(label: string, path: string | undefined): PathPrefix {
  return { path, bare: `<${label}>`, beforeSlash: `<${label}>/`, inFileUrl: true };
}

/**
 * Builds once, applies many times: rewrites each prefix (lexical and symlink-resolved spelling, longest first) in a
 * message. A prefix only matches as a whole path: never inside a longer path (`/Volumes/X/Users/me`) or, unless
 * `inFileUrl`, a `file://` URL; never as part of a longer name (`/repo-old`, `/repo.bak`); a sentence-ending `.`
 * still ends it.
 */
export function pathPrefixRewriter(prefixes: readonly PathPrefix[]): (text: string) => string {
  const forms = (path: string): string[] => {
    let physical = path;
    try { physical = realpathSync(path); } catch { /* keep the lexical path */ }
    return [...new Set([path, physical].map(form => form.split(sep).join("/").replace(/\/+$/, "")).filter(Boolean))];
  };
  const rules = prefixes.flatMap(prefix => prefix.path ? forms(prefix.path).map(form => ({ ...prefix, path: form })) : [])
    .sort((left, right) => right.path.length - left.path.length)
    .map(({ path, bare, beforeSlash, inFileUrl }) => ({
      pattern: new RegExp(`${inFileUrl ? "(?:(?<=file://)|(?<![\\w./-]))" : "(?<![\\w./-])"}${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:/|(?![\\w-]|\\.\\w))`, "g"),
      bare,
      beforeSlash,
    }));
  return text => rules.reduce((current, { pattern, bare, beforeSlash }) => current.replace(pattern, match => match.endsWith("/") ? beforeSlash : bare), text);
}
