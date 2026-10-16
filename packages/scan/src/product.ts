import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface ProductNames {
  /** npm package name, e.g. `@sourcefor/atlas`. */
  packageName: string;
  /** The single executable name. */
  bin: string;
}

/**
 * Product names, compiled in so importing `@okie/scan` reads no file (the server deploys
 * `dist/` only). `packages/scan/product.json` is the source; product.test.ts keeps this equal.
 */
export const product: ProductNames = { packageName: "@sourcefor/atlas", bin: "sourcefor-atlas" };

/**
 * The compiled CLI (`packages/scan/dist/cli.js`) and the packed bundle (`bin/cli.mjs`) both
 * sit one directory below their package root, which holds `package.json` and, in the packed
 * CLI only, the prebuilt `viewer/`. Read only when a CLI command needs them.
 */
const packageRoot = new URL("../", import.meta.url);

/** The running package's version (written into artifacts as `generator.version`). */
export function productVersion(): string {
  return (JSON.parse(readFileSync(new URL("package.json", packageRoot), "utf8")) as { version: string }).version;
}

/** The viewer bundled with the packed CLI, or undefined when running from source. */
export function bundledViewerDirectory(): string | undefined {
  const viewer = fileURLToPath(new URL("viewer/", packageRoot));
  return existsSync(`${viewer}index.html`) ? viewer : undefined;
}
