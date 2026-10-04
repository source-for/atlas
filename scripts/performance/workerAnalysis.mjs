import { percentile } from './common.mjs';
/** Missing or cross-clock-incoherent endpoints are unavailable, never a fabricated zero. */
export function gap(clocks,end,start){
 const a=clocks?.[start],b=clocks?.[end];
 return typeof a==='number'&&typeof b==='number'&&Number.isFinite(a)&&Number.isFinite(b)&&b>=a?b-a:null;
}
export function workerBreakdown(job){
 const c=job.clocks??{};
 const inboundStart=Math.max(c.mainSendAfter??NaN,c.workerModuleReady??NaN);
 return {
  queueMs:gap(c,'mainDequeued','mainQueued'),
  startupMs:job.workerFresh?gap(c,'workerModuleReady','mainWorkerCreated'):null,
  requestPostMs:gap(c,'mainSendAfter','mainSendBefore'),
  inboundResidualMs:gap({...c,inboundStart},'workerReceived','inboundStart'),
  compileMs:gap(c,'workerCompileEnd','workerCompileStart'),
  resultPostMs:gap(c,'workerResultPostAfter','workerResultPostBefore'),
  deliveryResidualMs:gap(c,'mainReceive','workerResultPostAfter'),
  resultHandledMs:gap(c,'mainResultHandled','mainReceive'),
  handlerMs:gap(c,'mainHandleEnd','mainReceive'),
  timeoutOvershootMs:gap(c,'mainTimeout','mainDeadline'),
 };
}
export function summarizeWorkerTrials(report){
 return ['cold','warm'].map(cache=>{
  const rows=report.rows.filter(row=>row.cache===cache);
  const jobs=rows.flatMap(row=>(row.afterStory??row.lastDiagnostics??row.beforeStory)?.workerJobs??[]);
  const breakdowns=jobs.map(workerBreakdown);
  const metricNames=Object.keys(workerBreakdown({}));
  return {cache,attempts:rows.length,valid:rows.filter(row=>!row.error).length,errors:rows.filter(row=>row.error).length,
   workerWarnings:rows.reduce((sum,row)=>sum+(row.warnings?.length??0),0),
   instrumented:rows.filter(row=>row.workerInstrumentation).length,jobs:jobs.length,
   outcomes:Object.fromEntries(['success','invalid','error','timeout','cancelled','pending'].map(outcome=>[outcome,jobs.filter(job=>job.outcome===outcome).length])),
   usableMs:{p50:percentile(rows.filter(row=>!row.error).map(row=>row.metrics.usableMs),.5),p95:percentile(rows.filter(row=>!row.error).map(row=>row.metrics.usableMs),.95)},
   phases:Object.fromEntries(metricNames.map(metric=>{const values=breakdowns.map(value=>value[metric]).filter(Number.isFinite);return [metric,{n:values.length,p50:percentile(values,.5),p95:percentile(values,.95),max:values.length?Math.max(...values):null}];})),
   // Scalar correlation evidence only; row pairing preserves provenance without exporting URLs.
   stalledJobs:rows.flatMap(row=>((row.afterStory??row.lastDiagnostics??row.beforeStory)?.workerJobs??[]).filter(job=>job.clocks?.mainTimeout!==undefined||job.outcome==='timeout'||gap(job.clocks,'mainTerminal','mainQueued')>=20000).map(job=>({repetition:row.repetition,scenario:row.scenario,jobId:job.jobId,sessionId:job.sessionId,outcome:job.outcome,abandoned:job.abandoned,clocks:job.clocks,breakdown:workerBreakdown(job)}))),
  };
 });
}
