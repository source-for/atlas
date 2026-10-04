/** Installed before document scripts: records bounded scalar long tasks and DOM readiness only. */
export function installProbe() {
  const probe = window.__okieBenchmark = { longTaskSupported:false,longTasks:[],longTasksDropped:0,inspectorReadyMs:null,visibleEntities:null,visibleRelations:null };
  if(PerformanceObserver.supportedEntryTypes.includes('longtask')) {
    probe.longTaskSupported=true;
    new PerformanceObserver(list=>{for(const entry of list.getEntries()){ if(probe.longTasks.length===10000){probe.longTasks.shift();probe.longTasksDropped++;}probe.longTasks.push({startMs:entry.startTime,durationMs:entry.duration}); }}).observe({type:'longtask',buffered:true});
  }
  try { localStorage.setItem('okie.devMode','1'); } catch { /* about:blank has no storage origin */ }
  probe.inspectorEntityId = () => {
    const title=document.querySelector('#inspector-entity-title');
    if(title?.textContent?.trim())return title.closest('[data-inspector-entity-id]')?.dataset.inspectorEntityId;
    const overview=document.querySelector('[data-contextual-overview]');
    return overview?.querySelector('.overview-title')?.textContent?.trim() ? overview.dataset.contextualOverview : null;
  };
  function check() {
    const panel=document.querySelector('[data-performance-panel]');
    if(panel)panel.style.display='none';
    const app=document.querySelector('[data-testid="atlas-app"]');
    probe.visibleEntities=Number(app?.dataset.rendererVisibleEntities ?? 0);
    probe.visibleRelations=Number(app?.dataset.rendererVisibleRelations ?? 0);
    const inspectorId=probe.inspectorEntityId();
    const canvas=document.querySelector('[data-testid="atlas-canvas"] canvas');
    if(probe.inspectorReadyMs===null && app && Number(app.dataset.projectionEntityCount)>0 && inspectorId && probe.visibleEntities>0 && canvas?.width>0 && canvas?.height>0 && app.dataset.selectedEntityId===inspectorId) probe.inspectorReadyMs=performance.now();
  }
  new MutationObserver(check).observe(document,{childList:true,characterData:true,subtree:true,attributes:true,attributeFilter:['data-selected-entity-id','data-projection-entity-count','width','height','data-renderer-visible-entities','data-renderer-visible-relations']});
  document.addEventListener('DOMContentLoaded',check);
}
export function timingReport() {
  const report = document.querySelector('[data-performance-report]');
  if(!report)throw new Error('Performance diagnostics unavailable');
  const details=report.parentElement;
  details.open=true;
  details.dispatchEvent(new Event('toggle'));
  return JSON.parse(report.textContent);
}
