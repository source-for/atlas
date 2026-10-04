type EntitySource = { entities: readonly { id: string }[] };

/** Published navigation addresses the captured graph, independently of the
 * currently compiled window. Read the live array so lazy merges are visible. */
export function navigationEntityReference(input: {
  rendered: EntitySource;
  published?: EntitySource;
  imported?: EntitySource;
  stress?: boolean;
}): (id: string) => boolean {
  const renderedIds = new Set(input.rendered.entities.map(entity => entity.id));
  return id => Boolean(input.stress
    ? input.rendered.entities.some(entity => entity.id === id)
    : (input.published && !input.imported
      ? input.published.entities.some(entity => entity.id === id)
      : renderedIds.has(id) || input.imported?.entities.some(entity => entity.id === id)));
}
