import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { product } from "./product.js";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

test("the compiled product names equal packages/scan/product.json", () => {
  assert.deepEqual(product, JSON.parse(readFileSync(join(packageRoot, "product.json"), "utf8")));
});

test("the scan barrel imports from a dist-only deployment (no product.json beside it)", () => {
  // `pnpm --filter @okie/server deploy` and the server image ship `files: ["dist", ...]` only.
  const root = mkdtempSync(join(tmpdir(), "okie-scan-deployed-"));
  try {
    const deployed = join(root, "node_modules/@okie/scan");
    mkdirSync(deployed, { recursive: true });
    cpSync(join(packageRoot, "dist"), join(deployed, "dist"), { recursive: true });
    cpSync(join(packageRoot, "package.json"), join(deployed, "package.json"));
    symlinkSync(join(packageRoot, "node_modules"), join(deployed, "node_modules"), "dir");
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", "await import('@okie/scan'); console.log('imported');"], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "imported");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
