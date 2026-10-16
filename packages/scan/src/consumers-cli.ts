import { readFileSync } from "node:fs";
import { formatDependencyConsumerReport, parsePortableAtlas, queryDependencyConsumers, sanitizeControlCharacters, type DependencyEcosystem } from "@okie/architecture";
import { product } from "./product.js";
import { stableJson } from "./scan.js";

export const CONSUMERS_USAGE = `Usage: ${product.bin} consumers <dependency> --bundle <atlas.okie.json> [--ecosystem npm|cargo] [--json] [--runtime-only]`;

/**
 * `sourcefor-atlas consumers`: answer "who uses <dependency>?" from a bundle's captured
 * dependency facts. Exit 0 even with no consumers; throws on bad arguments or bundle.
 */
export function runConsumersQuery(args: readonly string[], read: (path: string) => string = path => readFileSync(path, "utf8")): string {
  let dependency: string | undefined;
  let bundlePath: string | undefined;
  let ecosystem: DependencyEcosystem | undefined;
  let json = false;
  let includeTypeOnly = true;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const value = (): string => {
      const next = args[index + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`Missing value for ${arg}. ${CONSUMERS_USAGE}`);
      index += 1;
      return next;
    };
    if (arg === "--bundle") bundlePath = value();
    else if (arg === "--ecosystem") {
      const next = value();
      if (next !== "npm" && next !== "cargo") throw new Error(`--ecosystem must be npm or cargo. ${CONSUMERS_USAGE}`);
      ecosystem = next;
    } else if (arg === "--json") json = true;
    else if (arg === "--runtime-only") includeTypeOnly = false;
    else if (arg.startsWith("--") || dependency !== undefined) throw new Error(`Unexpected argument: ${sanitizeControlCharacters(arg)}. ${CONSUMERS_USAGE}`);
    else dependency = arg;
  }
  if (!dependency || !dependency.trim()) throw new Error(`Missing dependency name. ${CONSUMERS_USAGE}`);
  if (!bundlePath) throw new Error(`Missing --bundle. ${CONSUMERS_USAGE}`);
  let text: string;
  try { text = read(bundlePath); } catch { throw new Error(`Bundle not found: ${sanitizeControlCharacters(bundlePath)}`); }
  const bundle = parsePortableAtlas(text);
  const report = queryDependencyConsumers(bundle.dependencies, dependency, { ...(ecosystem ? { ecosystem } : {}), includeTypeOnly });
  // JSON.stringify escapes C0 but not DEL/C1 (U+007F–U+009F, e.g. the 8-bit CSI U+009B): escape those too.
  return json ? stableJson(report).replace(/[\u007f-\u009f]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`) : formatDependencyConsumerReport(report);
}
