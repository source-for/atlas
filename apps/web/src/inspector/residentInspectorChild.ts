/** Resident hierarchy navigation must stay synchronous; code declarations need
 * their canonical owner compile and deliberately do not take this fast path. */
export function navigateResidentInspectorChild<T extends { id: string; detail?: string }>(input: {
  entities: readonly T[];
  id: string;
  canNavigate(entity: T): boolean;
  navigate(entity: T): void;
}): boolean {
  const resident = input.entities.find(entity => entity.id === input.id);
  if (!resident || resident.detail === 'code' || !input.canNavigate(resident)) return false;
  input.navigate(resident);
  return true;
}
