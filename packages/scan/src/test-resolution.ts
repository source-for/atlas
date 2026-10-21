import type { WorkspaceResolution } from "./discover.js";

/**
 * Test helper: an explicit {@link WorkspaceResolution} for a hand-built discovery whose
 * packages all live in the scan root's workspace (`name -> unit dir`, each package's
 * manifest in that dir). Production discovery never derives a resolution from units.
 */
export function testResolution(packages: ReadonlyMap<string, string> = new Map()): WorkspaceResolution {
  return {
    jsRoots: [""],
    packages: [...packages].map(([name, dir]) => ({ dir, manifest: `${dir}/package.json`, name, context: "", unit: dir, dependencies: [] })),
    cargoContexts: [{ dir: "", crates: [] }],
  };
}
