import assert from "node:assert/strict";
import test from "node:test";
import { validateArchitectureExtraction } from "@okie/architecture";
import type { Discovery } from "./discover.js";
import { extractArchitecture } from "./extract.js";
import { rustTopLevelItems } from "./extract-rust.js";
import { testResolution } from "./test-resolution.js";

test("rustTopLevelItems captures mods, structs, enums, fns, and impl methods", () => {
  const items = rustTopLevelItems([
    "mod camera;",
    "use std::fmt;",
    "pub struct Engine { x: u32 }",
    "enum Kind { A, B }",
    "impl Engine {",
    "  pub fn boot() {}",
    "  fn helper() {}",
    "}",
    "pub fn hit_test() {}",
    "const N: u8 = 1;",
  ].join("\n"));
  assert.deepEqual(
    items.map(item => [item.name, item.exported, item.startLine]),
    [
      ["camera", false, 1],
      ["Engine", true, 3],
      ["Kind", false, 4],
      ["Engine::boot", true, 6],
      ["Engine::helper", false, 7],
      ["hit_test", true, 9],
      ["N", false, 10],
    ],
  );
});

test("rustTopLevelItems skips use, cfg(test) modules, and #[test] fns; reports 1-based spans", () => {
  const items = rustTopLevelItems([
    "pub use crate::lod::LodController;",
    "pub struct Ready;",
    "#[cfg(test)]",
    "mod tests {",
    "  #[test]",
    "  fn hidden() {}",
    "}",
    "impl Ready {",
    "  #[test]",
    "  fn unit() {}",
    "  pub fn ping() {}",
    "}",
  ].join("\n"));
  assert.deepEqual(
    items.map(item => item.name),
    ["Ready", "Ready::ping"],
  );
  const ping = items.find(item => item.name === "Ready::ping")!;
  assert.equal(ping.startLine, 11);
  assert.equal(ping.endLine, 11);
});

test("rust crate extraction emits L3 files and L4 outline; Open inside is enabled", () => {
  const discovery: Discovery = {
    sourceFiles: ["crates/engine/src/lib.rs", "crates/engine/src/hit_test.rs"],
    units: [
      { kind: "rust", dir: "crates/engine", name: "engine", evidencePath: "crates/engine", packageManifest: undefined },
    ],
    unitByFile: new Map([
      ["crates/engine/src/lib.rs", "crates/engine"],
      ["crates/engine/src/hit_test.rs", "crates/engine"],
    ]),
    resolution: testResolution(new Map()),
    summary: { singlePackage: false, includedJs: false, skippedJsFiles: 0, skippedMembers: [] },
  };
  const files: Record<string, string> = {
    "README.md": "# Acme",
    "crates/engine/Cargo.toml": "[dependencies]\n",
    "crates/engine/src/lib.rs": [
      "mod hit_test;",
      "pub struct Engine;",
      "impl Engine { pub fn boot() {} }",
    ].join("\n"),
    "crates/engine/src/hit_test.rs": "pub fn hit_test() {}\n",
  };
  const extraction = extractArchitecture({
    discovery,
    readFile: path => {
      const text = files[path];
      if (text === undefined) throw new Error(`missing ${path}`);
      return text;
    },
    systemName: "Acme",
    systemSlug: "acme",
  });
  assert.deepEqual(validateArchitectureExtraction(extraction), []);
  const byId = new Map(extraction.entities.map(entity => [entity.id, entity]));
  const crate = byId.get("container:crates-engine")!;
  assert.equal(crate.technology?.[0], "Rust");
  const filesInCrate = extraction.entities.filter(entity => entity.parentId === crate.id);
  assert.deepEqual(filesInCrate.map(entity => entity.name).sort(), ["src/hit_test.rs", "src/lib.rs"]);
  assert.equal(byId.get("component:crates-engine-src-lib-rs")!.kind, "component");
  const engine = byId.get("code:crates-engine-src-lib-rs:engine")!;
  assert.equal(engine.parentId, "component:crates-engine-src-lib-rs");
  assert.equal(engine.sourceRefs[0]!.symbol, "Engine");
  const boot = byId.get("code:crates-engine-src-lib-rs:engine-boot")!;
  assert.equal(boot.sourceRefs[0]!.symbol, "Engine::boot");
  const hit = byId.get("code:crates-engine-src-hit-test-rs:hit-test")!;
  assert.equal(hit.sourceRefs[0]!.symbol, "hit_test");
  assert.equal(hit.sourceRefs[0]!.startLine, 1);
});

test("rust --public-api keeps pub items and pub methods only", () => {
  const discovery: Discovery = {
    sourceFiles: ["crates/engine/src/lib.rs"],
    units: [{ kind: "rust", dir: "crates/engine", name: "engine", evidencePath: "crates/engine", packageManifest: undefined }],
    unitByFile: new Map([["crates/engine/src/lib.rs", "crates/engine"]]),
    resolution: testResolution(new Map()),
    summary: { singlePackage: false, includedJs: false, skippedJsFiles: 0, skippedMembers: [] },
  };
  const extraction = extractArchitecture({
    discovery,
    readFile: path => {
      if (path === "README.md") return "# Acme\n";
      if (path === "crates/engine/Cargo.toml") return "[dependencies]\n";
      return "struct Hidden;\npub struct Shown;\nimpl Shown { fn priv_m() {} pub fn pub_m() {} }\n";
    },
    systemName: "Acme",
    systemSlug: "acme",
    codeSurface: "public",
  });
  const code = extraction.entities.filter(entity => entity.kind === "code").map(entity => entity.name).sort();
  assert.deepEqual(code, ["Shown", "Shown::pub_m"]);
});
