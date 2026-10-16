import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Product names and the package root, resolved from this module's location. The
 * compiled CLI (`packages/scan/dist/cli.js`) and the packed bundle (`bin/cli.mjs`)
 * both sit one directory below their package root, which holds `product.json`,
 * `package.json` and, in the packed CLI only, the prebuilt `viewer/`.
 */
const packageRoot = new URL("../", import.meta.url);

export interface ProductNames {
  /** npm package name, e.g. `@sourcefor/atlas`. */
  packageName: string;
  /** The single executable name. */
  bin: string;
}

export const product: ProductNames = JSON.parse(readFileSync(new URL("product.json", packageRoot), "utf8")) as ProductNames;

/** The running package's version (written into artifacts as `generator.version`). */
export function productVersion(): string {
  return (JSON.parse(readFileSync(new URL("package.json", packageRoot), "utf8")) as { version: string }).version;
}

/** The viewer bundled with the packed CLI, or undefined when running from source. */
export function bundledViewerDirectory(): string | undefined {
  const viewer = fileURLToPath(new URL("viewer/", packageRoot));
  return existsSync(`${viewer}index.html`) ? viewer : undefined;
}
