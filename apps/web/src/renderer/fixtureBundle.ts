import type { ScanFixture } from './scanFixture';

// A scanned fixture is fetched + validated + compiled BEFORE the App module is
// evaluated (see main.tsx), then stashed here so App.tsx can read the compiled
// scene/story/snapshot/view synchronously — exactly like the golden fixture —
// keeping the story-playback machinery unchanged. Undefined for golden/stress.
let activeScanFixture: ScanFixture | undefined;

export function setActiveScanFixture(fixture: ScanFixture | undefined): void {
  if (activeScanFixture !== fixture) activeScanFixture?.disposeSceneWorker();
  activeScanFixture = fixture;
}

export function getActiveScanFixture(): ScanFixture | undefined {
  return activeScanFixture;
}

export { scanKeepsResidentL3Landmarks } from './scanFixture';
