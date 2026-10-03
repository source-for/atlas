import { expect, it, vi } from 'vitest';
import { createStartupLifetime } from './startupLifetime';
function target() {
  let listener: EventListener | undefined;
  return {
    addEventListener: vi.fn((_type: string, handler: EventListener) => { listener = handler; }),
    removeEventListener: vi.fn(),
    hide(persisted: boolean) { listener?.({ persisted } as PageTransitionEvent); },
  };
}
it('aborts and prevents publication when HMR replaces a pending startup', async () => {
  const events = target(); const lifetime = createStartupLifetime(events as unknown as Window);
  const publish = vi.fn(); let complete!: () => void;
  const pending = new Promise<void>(resolve => { complete = resolve; }).then(() => { lifetime.assertCurrent(); publish(); });
  const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  lifetime.dispose(); complete(); await rejection;
  expect(lifetime.signal.aborted).toBe(true); expect(publish).not.toHaveBeenCalled();
  expect(events.removeEventListener).toHaveBeenCalledOnce();
});
it('preserves bfcache startup but aborts discarded documents', () => {
  const events = target(); const lifetime = createStartupLifetime(events as unknown as Window);
  events.hide(true); expect(lifetime.signal.aborted).toBe(false); expect(() => lifetime.assertCurrent()).not.toThrow();
  events.hide(false); expect(lifetime.signal.aborted).toBe(true); expect(() => lifetime.assertCurrent()).toThrow();
});

it('disposes a bootstrap-owned fixture on cancellation, including cancellation before adoption', () => {
  const events = target(); const lifetime = createStartupLifetime(events as unknown as Window);
  const publishedFixtureDispose = vi.fn(); lifetime.own(publishedFixtureDispose);
  events.hide(true); expect(publishedFixtureDispose).not.toHaveBeenCalled();
  lifetime.dispose(); lifetime.dispose();
  expect(publishedFixtureDispose).toHaveBeenCalledTimes(1);
  const lateFixtureDispose = vi.fn();
  expect(() => lifetime.own(lateFixtureDispose)).toThrow();
  expect(lateFixtureDispose).toHaveBeenCalledTimes(1);
});
