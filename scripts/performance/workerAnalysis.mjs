import { percentile } from './common.mjs';
/** Missing or cross-clock-incoherent endpoints are unavailable, never a fabricated zero. */
export function gap(clocks,end,start){
 const a=clocks?.[start],b=clocks?.[end];
 return typeof a==='number'&&typeof b==='number'&&Number.isFinite(a)&&Number.isFinite(b)&&b>=a?b-a:null;
}
/** Raw diagnostic intervals overlap; they are context metrics, never an additive partition. */
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
/** A wall-time partition, not CPU attribution. Concurrent post/startup and post/delivery
 * are clipped at receipt; raw intervals above intentionally retain their full span.
 * Handler tail includes pumping the successor job. No ACK means delivery stays combined.
 */
export function workerPartition(job){
 const c=job.clocks??{};
 const keys=['mainQueued','mainDequeued','mainSendBefore','workerReceived','workerCompileStart','workerCompileEnd','workerResultPostBefore','mainReceive','mainResultHandled','mainHandleEnd'];
 const points=keys.map(key=>c[key]);
 if(points.some((value,index)=>!Number.isFinite(value)||(index>0&&value<points[index-1])))return {complete:false,totalMs:null,stages:null,resultDeliveryAccounting:null};
 const [queued,dequeued,send,received,compileStart,compileEnd,post,receive,handled,end]=points;
 const clip=(value,start,end)=>Math.max(start,Math.min(end,value));
 // A missing post-return or fresh-worker module clock cannot be assigned to an exclusive stage.
 const dispatchKnown=Number.isFinite(c.mainSendAfter)&&(!job.workerFresh||Number.isFinite(c.workerModuleReady));
 const postReturn=dispatchKnown?clip(c.mainSendAfter,send,received):send;
 const moduleReady=dispatchKnown&&job.workerFresh?clip(c.workerModuleReady,postReturn,received):postReturn;
 const ackKnown=Number.isFinite(c.workerResultPostAfter)&&c.workerResultPostAfter>=post;
 const resultPostEnd=ackKnown?clip(c.workerResultPostAfter,post,receive):post;
 const stages={queueMs:dequeued-queued,dispatchSetupMs:send-dequeued,
  ...(dispatchKnown?{requestPostConcurrentStartupMs:postReturn-send,startupRemainingMs:moduleReady-postReturn,inboundRemainingMs:received-moduleReady}:{dispatchStartupCombinedMs:received-send}),
  workerPrecompileMs:compileStart-received,compileMs:compileEnd-compileStart,workerFinalizationMs:post-compileEnd,
  ...(ackKnown?{resultPostConcurrentDeliveryMs:resultPostEnd-post,resultDeliveryMs:receive-resultPostEnd}:{resultDeliveryMs:receive-post}),
  resultHandledMs:handled-receive,handlerTailMs:end-handled};
 return {complete:true,totalMs:end-queued,startClock:'mainQueued',endClock:'mainHandleEnd',stages,dispatchAccounting:dispatchKnown?'clipped-post-startup-and-inbound':'combined-dispatch-and-startup',resultDeliveryAccounting:ackKnown?'clipped-post-and-delivery':'combined-post-and-delivery'};
}
export function timeoutPhase(job){
 const timeout=job.clocks?.mainTimeout;
 const phases=job.phases??{};
 const candidates=Object.entries(phases).filter(([,value])=>Number.isFinite(value?.worker)&&Number.isFinite(timeout)&&value.worker<=timeout);
 candidates.sort((a,b)=>b[1].worker-a[1].worker);
 const last=candidates[0];
 return {phases,lastPhase:last?.[0]??null,lastPhaseAgeMs:last?timeout-last[1].worker:null};
}
function summarizeMetrics(values){
 const metrics=[...new Set(values.flatMap(value=>Object.keys(value)))];
 return Object.fromEntries(metrics.map(metric=>{const samples=values.map(value=>value[metric]).filter(Number.isFinite);return [metric,{n:samples.length,p50:percentile(samples,.5),p95:percentile(samples,.95),max:samples.length?Math.max(...samples):null}];}));
}
export function summarizeWorkerTrials(report){
 return ['cold','warm'].map(cache=>{
  const rows=report.rows.filter(row=>row.cache===cache);
  // A refused cache-policy call never began a new journey; its diagnostics belong to the prior document.
  const measuredRows=rows.filter(row=>row.stage!=='cache-policy');
  const jobs=measuredRows.flatMap(row=>(row.afterStory??row.lastDiagnostics??row.beforeStory)?.workerJobs??[]);
  const breakdowns=jobs.map(workerBreakdown);
  const metricNames=Object.keys(workerBreakdown({}));
  return {cache,attempts:rows.length,valid:rows.filter(row=>!row.error).length,errors:rows.filter(row=>row.error).length,
   workerWarnings:rows.reduce((sum,row)=>sum+(row.warnings?.length??0),0),
   instrumented:rows.filter(row=>row.workerInstrumentation).length,jobs:jobs.length,
   outcomes:Object.fromEntries(['success','invalid','error','timeout','cancelled','pending'].map(outcome=>[outcome,jobs.filter(job=>job.outcome===outcome).length])),
   timeoutEvents:jobs.filter(job=>Number.isFinite(job.clocks?.mainTimeout)).length,
   partitionTotals:summarizeMetrics(jobs.map(workerPartition).filter(value=>value.complete).map(value=>({fullHandlerMs:value.totalMs}))),
   completePartitions:jobs.filter(job=>workerPartition(job).complete).length,
   additiveStages:summarizeMetrics(jobs.map(workerPartition).filter(value=>value.complete).map(value=>value.stages)),
   usableMs:{p50:percentile(rows.filter(row=>!row.error).map(row=>row.metrics.usableMs),.5),p95:percentile(rows.filter(row=>!row.error).map(row=>row.metrics.usableMs),.95)},
   phases:Object.fromEntries(metricNames.map(metric=>{const values=breakdowns.map(value=>value[metric]).filter(Number.isFinite);return [metric,{n:values.length,p50:percentile(values,.5),p95:percentile(values,.95),max:values.length?Math.max(...values):null}];})),
   // Scalar correlation evidence only; row pairing preserves provenance without exporting URLs.
   stalledJobs:measuredRows.flatMap(row=>((row.afterStory??row.lastDiagnostics??row.beforeStory)?.workerJobs??[]).filter(job=>job.clocks?.mainTimeout!==undefined||job.outcome==='timeout'||gap(job.clocks,'mainTerminal','mainQueued')>=20000).map(job=>({repetition:row.repetition,scenario:row.scenario,jobId:job.jobId,sessionId:job.sessionId,outcome:job.outcome,abandoned:job.abandoned,clocks:job.clocks,...timeoutPhase(job),partition:workerPartition(job),breakdown:workerBreakdown(job)}))),
  };
 });
}
