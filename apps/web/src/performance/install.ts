import { subscribeLoadTiming } from './loadTimings';
import { subscribeRenderTiming } from './renderTimings';
import { subscribeSearchTiming } from './workerTimings';
import { performanceQueryEnabled, startPerformanceSession, type Metric, type PerformanceHost } from './recorder';

function browserHost(win: Window & typeof globalThis, doc: Document): PerformanceHost {
  const Observer = win.PerformanceObserver;
  return {
    now: () => win.performance.now(),
    supportedEntryTypes: Observer?.supportedEntryTypes ?? [],
    observe(type, callback, buffered) {
      const observer = new Observer(list => callback(list.getEntries()));
      try { observer.observe({ type, buffered, ...(type === 'event' ? { durationThreshold: 16 } : {}) }); }
      catch (error) { observer.disconnect(); throw error; }
      return () => observer.disconnect();
    },
    requestFrame: callback => win.requestAnimationFrame(callback),
    cancelFrame: id => win.cancelAnimationFrame(id),
    hidden: () => doc.visibilityState === 'hidden',
    onVisibility(callback) { doc.addEventListener('visibilitychange', callback); return () => doc.removeEventListener('visibilitychange', callback); },
  };
}

/** Local, ephemeral diagnostics. No persistence, network transmission or resource-name collection. */
export function installPerformanceDiagnostics(win: Window & typeof globalThis = window, doc = document) {
  let active: ReturnType<typeof startPerformanceSession> | undefined;
  let panel: HTMLElement | undefined;
  let refresh: number | undefined;
  let disposed = false;
  let unsubscribeLoad: (() => void) | undefined;
  let unsubscribeRender: (() => void) | undefined;
  let unsubscribeTiming: (() => void) | undefined;
  let resumeRecorder: ReturnType<typeof startPerformanceSession>['recorder'] | undefined;
  const stop = () => {
    unsubscribeLoad?.();
    unsubscribeLoad = undefined;
    unsubscribeRender?.();
    unsubscribeRender = undefined;
    unsubscribeTiming?.();
    unsubscribeTiming = undefined;
    active?.stop();
    active = undefined;
    if (refresh !== undefined) win.clearInterval(refresh);
    refresh = undefined;
    panel?.remove();
    panel = undefined;
  };
  const start = (recorder?: ReturnType<typeof startPerformanceSession>['recorder']) => {
    if (active || disposed) return;
    // A retained BFCache recorder already contains buffered entries from the previous observer.
    active = startPerformanceSession(browserHost(win, doc), recorder, recorder === undefined);
    unsubscribeTiming = subscribeSearchTiming((metric, durationMs) => active?.recorder.record(metric, win.performance.now(), durationMs));
    unsubscribeLoad = subscribeLoadTiming((metric, startMs, durationMs) => active?.recorder.record(metric, startMs, durationMs));
    unsubscribeRender = subscribeRenderTiming((metric, startMs, durationMs) => active?.recorder.record(metric, startMs, durationMs));
    panel = doc.createElement('section');
    panel.setAttribute('aria-label', 'Performance diagnostics');
    panel.dataset.performancePanel = 'true';
    panel.style.cssText = 'position:fixed;bottom:12px;right:12px;z-index:2147483646;background:#111c19;color:#eef4f2;border:1px solid #82948d;border-radius:10px;padding:14px;width:min(380px,calc(100vw - 24px));max-height:70vh;overflow:auto;font:13px/1.5 system-ui;box-shadow:0 6px 24px #0008;box-sizing:border-box';
    const heading = doc.createElement('strong');
    heading.textContent = 'Local performance diagnostics';
    const explanation = doc.createElement('p');
    explanation.textContent = 'Paint is browser page paint, not atlas readiness. Bootstrap completion means render requested, not rendered. Interaction timings are sampled events, not INP. Frame gaps over 50 ms exclude hidden pages. Reload with ?perf=1 to capture bootstrap. Search worker timings separate preparation, index build, query processing and round trip; their timestamps mark receipt on the UI thread. Render phases measure synchronous UI work, not GPU completion; frames are sampled every 250 ms plus slow frames over 16 ms.';
    const summary = doc.createElement('pre');
    summary.style.cssText = 'white-space:pre-wrap;font:12px/1.5 monospace';
    const rawReport = doc.createElement('pre');
    rawReport.style.cssText = 'white-space:pre-wrap;font:11px/1.4 monospace';
    const reportDetails = doc.createElement('details');
    const reportLabel = doc.createElement('summary');
    reportLabel.textContent = 'Inspect safe timing JSON';
    reportDetails.append(reportLabel, rawReport);
    const update = () => {
      if (!active) return;
      const report = active.recorder.report();
      const lines = Object.entries(report.capabilities).map(([name, state]) => `${name}: ${state}`);
      for (const metric of [...new Set(report.samples.map(sample => sample.metric))]) {
        const samples = report.samples.filter(sample => sample.metric === metric);
        const latest = samples[samples.length - 1]!;
        lines.push(`${metric}: ${metric === 'first-paint' || metric === 'first-contentful-paint' || metric === 'largest-contentful-paint' || metric === 'bootstrap-start' || metric === 'bootstrap-complete' || metric === 'atlas-first-frame' ? `${latest.startMs} ms since navigation` : `${latest.durationMs} ms duration`} (${samples.length} retained)`);
      }
      lines.push(`Dropped samples: ${report.droppedSamples}`);
      summary.textContent = lines.join('\n');

    };
    reportDetails.addEventListener('toggle', () => {
      if (reportDetails.open && active) rawReport.textContent = JSON.stringify(active.recorder.report(), null, 2);
    });
    const exportButton = doc.createElement('button');
    exportButton.type = 'button';
    exportButton.textContent = 'Export safe timing JSON';
    exportButton.addEventListener('click', () => {
      if (!active) return;
      const url = URL.createObjectURL(new Blob([JSON.stringify(active.recorder.report(), null, 2)], { type: 'application/json' }));
      const link = doc.createElement('a');
      link.href = url;
      link.download = 'atlas-performance.json';
      link.click();
      URL.revokeObjectURL(url);
    });
    const close = doc.createElement('button');
    close.type = 'button';
    close.textContent = 'Stop recording';
    close.style.marginLeft = '8px';
    close.addEventListener('click', stop);
    panel.append(heading, explanation, summary, exportButton, close, reportDetails);
    doc.body.append(panel);
    update();
    refresh = win.setInterval(update, 1000);
  };
  const key = (event: KeyboardEvent) => {
    if (event.shiftKey && event.altKey && event.code === 'KeyP' && !event.repeat) {
      event.preventDefault();
      if (active) stop(); else start();
    }
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    resumeRecorder = undefined;
    stop();
    win.removeEventListener('keydown', key);
    win.removeEventListener('pagehide', pageHide);
    win.removeEventListener('pageshow', pageShow);
  };
  const pageHide = (event: PageTransitionEvent) => {
    if (!event.persisted) { dispose(); return; }
    // A cached document is suspended, not destroyed. Leave only activation/lifecycle listeners.
    resumeRecorder = active?.recorder;
    stop();
  };
  const pageShow = (event: PageTransitionEvent) => {
    if (event.persisted && resumeRecorder && !disposed) {
      const recorder = resumeRecorder;
      resumeRecorder = undefined;
      start(recorder);
    }
  };
  win.addEventListener('keydown', key);
  win.addEventListener('pagehide', pageHide);
  win.addEventListener('pageshow', pageShow);
  if (performanceQueryEnabled(win.location.search)) start();
  return {
    mark(metric: Extract<Metric, 'bootstrap-start' | 'bootstrap-complete'>) { active?.recorder.record(metric, win.performance.now()); },
    dispose,
  };
}
