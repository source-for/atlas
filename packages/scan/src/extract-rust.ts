import type Parser from "tree-sitter";
import { rustParser, rustParserUnavailable } from "./analyzers.js";

/**
 * Top-level Rust outline item (and impl methods as `Type::method`).
 * Mirrors TS `topLevelDeclarations`: file-local, name + 1-based span + pub.
 */
export interface RustOutlineItem {
  name: string;
  startLine: number;
  endLine: number;
  /** `pub` (not `pub(crate)` / `pub(super)`). Used by `--public-api`. */
  exported: boolean;
}

const TOP_LEVEL_TYPES = new Set([
  "function_item",
  "struct_item",
  "enum_item",
  "trait_item",
  "mod_item",
  "type_item",
  "const_item",
  "static_item",
  "union_item",
  "macro_definition",
]);

function isSkippedAttribute(text: string): boolean {
  const compact = text.replace(/\s+/g, "");
  if (compact === "#[test]" || compact.startsWith("#[test]")) return true;
  if (/#\[cfg\(not\(test\)\)/.test(compact)) return false;
  return /#\[cfg\(test\)/.test(compact) || /#\[cfg\(all\(test[,)]/.test(compact);
}

function hasPub(node: Parser.SyntaxNode): boolean {
  return node.namedChildren.some(child => child.type === "visibility_modifier" && child.text === "pub");
}

function collectOutline(
  nodes: readonly Parser.SyntaxNode[],
  implType: string | undefined,
  into: RustOutlineItem[],
): void {
  let skipNext = false;
  for (const node of nodes) {
    if (node.type === "line_comment" || node.type === "block_comment") continue;
    if (node.type === "attribute_item" || node.type === "inner_attribute_item") {
      if (isSkippedAttribute(node.text)) skipNext = true;
      continue;
    }
    const skipped = skipNext;
    skipNext = false;
    if (skipped) continue;
    if (node.type === "use_declaration" || node.type === "extern_crate_declaration" || node.type === "foreign_mod_item") {
      continue;
    }
    if (node.type === "impl_item") {
      const typeName = node.childForFieldName("type")?.text;
      const body = node.childForFieldName("body");
      if (typeName && body) collectOutline(body.namedChildren, typeName, into);
      continue;
    }
    if (implType) {
      if (node.type !== "function_item") continue;
    } else if (!TOP_LEVEL_TYPES.has(node.type)) {
      continue;
    }
    const nameNode = node.childForFieldName("name");
    const baseName = nameNode?.text;
    if (!baseName) continue;
    into.push({
      name: implType ? `${implType}::${baseName}` : baseName,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      exported: hasPub(node),
    });
  }
}

/** Deterministic outline of one `.rs` file. Test modules and `#[test]` items are omitted. Empty when no Rust parser loads. */
export function rustTopLevelItems(text: string): RustOutlineItem[] {
  if (rustParserUnavailable()) return [];
  const tree = rustParser().parse(text);
  const items: RustOutlineItem[] = [];
  collectOutline(tree.rootNode.namedChildren, undefined, items);
  return items;
}
