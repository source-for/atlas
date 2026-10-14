// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { ScanFixtureError } from './renderer/scanFixture';
import { ScanErrorScreen } from './ScanErrorScreen';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mount(error: unknown) {
  const onRetry = vi.fn();
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(<ScanErrorScreen error={error} onRetry={onRetry} />));
  return { container, onRetry, unmount: () => act(() => root.unmount()) };
}

describe('CLA-268 scan error screen', () => {
  it('offers a real "Try again" that re-runs the boot', () => {
    const screen = mount(new Error('Neighborhood request failed: 503'));
    const button = screen.container.querySelector('[role="alert"] button');
    expect(button?.textContent).toBe('Try again');
    expect(button?.getAttribute('type')).toBe('button');
    act(() => (button as HTMLButtonElement).click());
    expect(screen.onRetry).toHaveBeenCalledTimes(1);
    screen.unmount();
  });

  it('keeps the rest of the screen: heading, the error, the validation issues, the demo link', () => {
    const failed = mount(new Error('Neighborhood request failed: 503'));
    expect(failed.container.querySelector('h1')?.textContent).toBe('Scanned snapshot could not be loaded');
    expect(failed.container.querySelector('pre')?.textContent).toBe('Neighborhood request failed: 503');
    expect(failed.container.querySelector('a[href="?fixture=okie"]')).not.toBeNull();
    failed.unmount();
    const invalid = mount(new ScanFixtureError([{ path: 'snapshot.entities', message: 'must be an array' }]));
    expect(invalid.container.querySelector('li')?.textContent).toBe('snapshot.entities — must be an array');
    invalid.unmount();
  });

  it('main.tsx gives every scan error screen a reload as its retry', () => {
    const main = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'main.tsx'), 'utf8');
    const screens = main.match(/<ScanErrorScreen\b[^\n]*?\/><\/StrictMode>/g) ?? [];
    expect(screens.length).toBe(2);
    for (const screen of screens) expect(screen).toContain('onRetry={() => window.location.reload()}');
  });
});
