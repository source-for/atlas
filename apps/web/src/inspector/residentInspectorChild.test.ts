import { expect, it, vi } from 'vitest';
import { navigateResidentInspectorChild } from './residentInspectorChild';

it('navigates a resident hierarchy child immediately without neighborhood work or replacement geometry', () => {
  const entity = { id: 'child', detail: 'component', x: 27 };
  const navigate = vi.fn(); const compile = vi.fn();
  if (!navigateResidentInspectorChild({ entities: [entity], id: 'child', canNavigate: () => true, navigate })) compile();
  expect(navigate).toHaveBeenCalledWith(entity);
  expect(compile).not.toHaveBeenCalled();
});
it('requires preparation for missing/undrawable children and canonical code-owner drills', () => {
  const navigate = vi.fn();
  expect(navigateResidentInspectorChild({ entities: [], id: 'missing', canNavigate: () => true, navigate })).toBe(false);
  expect(navigateResidentInspectorChild({ entities: [{ id: 'code', detail: 'code' }], id: 'code', canNavigate: () => true, navigate })).toBe(false);
  expect(navigateResidentInspectorChild({ entities: [{ id: 'child' }], id: 'child', canNavigate: () => false, navigate })).toBe(false);
  expect(navigate).not.toHaveBeenCalled();
});
