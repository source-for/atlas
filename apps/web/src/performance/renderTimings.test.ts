import { expect, it, vi } from 'vitest';
import { beginRenderTiming, subscribeRenderTiming } from './renderTimings';

it('does no clock work without recording and stops delivery on unsubscribe', () => {
  const clock = vi.fn(() => 10);
  expect(beginRenderTiming(clock)).toBeUndefined();
  expect(clock).not.toHaveBeenCalled();
  const listener = vi.fn();
  const stop = subscribeRenderTiming(listener);
  const frame = beginRenderTiming(clock)!;
  stop();
  frame('render-publish');
  expect(listener).not.toHaveBeenCalled();
});

it('samples normal frames but retains slow frames with their individual CPU phases', () => {
  const samples: unknown[] = [];
  const stop = subscribeRenderTiming((...sample) => samples.push(sample));
  let time = 0;
  const run = (start: number, draw: number) => {
    time = start;
    const frame = beginRenderTiming(() => time)!;
    time += 1; frame('render-scene');
    time += 2; frame('render-state');
    time += draw; frame('render-draw');
    time += 1; frame('render-publish');
  };
  run(0, 2);
  run(20, 2);
  expect(samples).toHaveLength(4);
  run(40, 20);
  expect(samples).toHaveLength(8);
  expect(samples[6]).toEqual(['render-draw', 43, 20]);
  run(300, 2);
  expect(samples).toHaveLength(12);
  stop();
});
