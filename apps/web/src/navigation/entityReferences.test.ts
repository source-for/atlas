import { expect, it } from 'vitest';
import { navigationEntityReference } from './entityReferences';
import { navigationStateFromUrl, type NavigationDefaults } from './navigationState';

const root = 'system:okie';
const container = 'container:apps-web';
const component = 'component:apps-web-src-app-tsx';
const defaults: NavigationDefaults = { repositoryId: 'repo:okie', snapshotId: 'snapshot:okie', viewId: 'view:okie',
  rootEntityId: root, selectedId: root, detail: 'context', camera: { x: 0, y: 0, zoom: .2 }, minZoom: .01, maxZoom: 20 };

it('preserves deep selection and canonical lens IDs absent from the progressive rendered window', () => {
  const hasEntity = navigationEntityReference({ rendered: { entities: [{ id: root }] },
    published: { entities: [root, container, component].map(id => ({ id })) } });
  const url = `https://example.test/?root=${container}&sel=${component}&detail=context&z=7.95&lens=${root}&lens=${container}&lens=${component}`;
  const decoded = navigationStateFromUrl(url, defaults, { references: { hasEntity } });
  expect(decoded.state).toMatchObject({ rootEntityId: container, selectedId: component, lensPath: [root, container, component], camera: { zoom: 7.95 } });
  expect(decoded.warnings).toEqual([]);
  const reloaded = navigationStateFromUrl(decoded.canonicalUrl, defaults, { references: { hasEntity } });
  expect(reloaded.state).toEqual(decoded.state);
  expect(hasEntity('missing')).toBe(false);
});

it('sees canonical lazy merges without rebuilding the reference closure', () => {
  const published = { entities: [{ id: root }] };
  const hasEntity = navigationEntityReference({ rendered: published, published });
  expect(hasEntity(component)).toBe(false);
  published.entities = [...published.entities, { id: component }];
  expect(hasEntity(component)).toBe(true);
});

it('preserves golden, imported and stress reference policies independently of published residency', () => {
  const rendered = { entities: [{ id: 'golden' }] };
  const published = { entities: [{ id: 'published' }] };
  expect(navigationEntityReference({ rendered })('golden')).toBe(true);
  expect(navigationEntityReference({ rendered })('missing')).toBe(false);
  const imported = navigationEntityReference({ rendered, published, imported: { entities: [{ id: 'imported' }] } });
  expect(imported('golden')).toBe(true); expect(imported('imported')).toBe(true); expect(imported('published')).toBe(false);
  expect(navigationEntityReference({ rendered, published, stress: true })('arbitrary-stress-id')).toBe(true);
});
