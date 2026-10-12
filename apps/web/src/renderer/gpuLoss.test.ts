import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createRejectedCallReports, listenForWebGlContextLoss, nextBackendAfterLoss, REJECTED_CALL_EPISODE_MS, REJECTED_CALL_ERROR_NAME, rendererFailureKind } from './gpuLoss';

describe('GPU loss recovery policy', () => {
  it('moves auto WebGPU to one fresh WebGL2 attempt without looping', () => {
    expect(nextBackendAfterLoss('auto', 'webgpu')).toBe('webgl2');
    expect(nextBackendAfterLoss('auto', 'webgl2')).toBe('canvas2d');
  });

  it('moves forced GPU backends directly to Canvas2D', () => {
    expect(nextBackendAfterLoss('webgpu', 'webgpu')).toBe('canvas2d');
    expect(nextBackendAfterLoss('webgl2', 'webgl2')).toBe('canvas2d');
  });
});

describe('listenForWebGlContextLoss', () => {
  it('prevents browser restoration and cleans up with the active session', () => {
    const canvas = new EventTarget();
    const onLoss = vi.fn();
    const detach = listenForWebGlContextLoss(canvas, onLoss);
    const firstLoss = new Event('webglcontextlost', { cancelable: true });
    canvas.dispatchEvent(firstLoss);
    expect(firstLoss.defaultPrevented).toBe(true);
    expect(onLoss).toHaveBeenCalledOnce();

    detach();
    canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    expect(onLoss).toHaveBeenCalledOnce();
  });
});

describe('rendererFailureKind', () => {
  const bridge = readFileSync(new URL('../../../../crates/atlas-wasm/src/browser.rs', import.meta.url), 'utf8');
  // The message literal each bridge constructor is given, as written in browser.rs.
  const messages = (constructor: string) => [...bridge.matchAll(new RegExp(`\\b${constructor}\\((?:format!\\()?\\s*"([^"]+)"`, 'g'))].map(match => match[1]!);
  const tagged = (message: string) => Object.assign(new Error(message), { name: REJECTED_CALL_ERROR_NAME });

  it('reads the name the bridge gives a rejected call', () => {
    expect(bridge).toContain(`error.set_name("${REJECTED_CALL_ERROR_NAME}")`);
  });

  it('keeps the renderer for the calls the engine refuses', () => {
    const rejected = messages('rejected_call');
    for (const message of ['visibility filter failed: {error}', 'scene patch failed: {error}', 'setScene must be called first']) expect(rejected).toContain(message);
    for (const message of rejected) expect(rendererFailureKind(tagged(message))).toBe('rejected');
    expect(rendererFailureKind(tagged('visibility filter failed: unknown object visual-node:code:gone'))).toBe('rejected');
    expect(rendererFailureKind(tagged('scene patch failed: revision mismatch: expected 4, received 3'))).toBe('rejected');
  });

  it('treats a surface error, and anything it cannot identify, as a loss', () => {
    const lost = messages('js_error');
    for (const message of ['render failed: {error}', 'renderer health check failed: {error}', 'renderer has been disposed']) expect(lost).toContain(message);
    for (const message of lost) {
      expect(messages('rejected_call')).not.toContain(message);
      expect(rendererFailureKind(new Error(message))).toBe('lost');
    }
    // The message alone never decides: an untagged validation message is still a loss.
    expect(rendererFailureKind(new Error('visibility filter failed: unknown object a'))).toBe('lost');
    expect(rendererFailureKind('WebGL context lost.')).toBe('lost');
    expect(rendererFailureKind(Object.assign(new Error('unreachable'), { name: 'RuntimeError' }))).toBe('lost');
    expect(rendererFailureKind({ name: REJECTED_CALL_ERROR_NAME, message: 'not an Error' })).toBe('lost');
    expect(rendererFailureKind(undefined)).toBe('lost');
  });
});

describe('createRejectedCallReports', () => {
  const none = { console: false, trace: false };

  it('reports the same message once per episode, measured from the last report', () => {
    const due = createRejectedCallReports();
    expect(due('a', 0, undefined)).toEqual({ console: true, trace: false });
    // Suppressed rejections do not move the window.
    for (let nowMs = 1_000; nowMs < REJECTED_CALL_EPISODE_MS; nowMs += 1_000) expect(due('a', nowMs, undefined)).toEqual(none);
    expect(due('a', REJECTED_CALL_EPISODE_MS, undefined)).toEqual({ console: true, trace: false });
    expect(due('a', REJECTED_CALL_EPISODE_MS + 1, undefined)).toEqual(none);
  });

  it('always reports a message that differs from the last one reported', () => {
    const due = createRejectedCallReports();
    expect(due('a', 0, 1)).toEqual({ console: true, trace: true });
    expect(due('b', 1, 1)).toEqual({ console: true, trace: true });
    expect(due('b', 2, 1)).toEqual(none);
    expect(due('a', 3, 1)).toEqual({ console: true, trace: true });
  });

  it('reports to each new recording, and to none while not recording', () => {
    const due = createRejectedCallReports();
    expect(due('a', 0, undefined)).toEqual({ console: true, trace: false });
    expect(due('a', 1, 1)).toEqual({ console: false, trace: true });
    expect(due('a', 2, 1)).toEqual(none);
    expect(due('a', 3, 2)).toEqual({ console: false, trace: true });
    expect(due('a', 4, undefined)).toEqual(none);
    // The recording's own window is fixed too.
    expect(due('a', 5, 3)).toEqual({ console: false, trace: true });
    expect(due('a', REJECTED_CALL_EPISODE_MS + 4, 3)).toEqual({ console: true, trace: false });
    expect(due('a', REJECTED_CALL_EPISODE_MS + 5, 3)).toEqual({ console: false, trace: true });
  });
});
