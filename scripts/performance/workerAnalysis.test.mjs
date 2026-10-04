import test from 'node:test';
import assert from 'node:assert/strict';
import { gap, workerBreakdown, workerPartition, summarizeWorkerTrials } from './workerAnalysis.mjs';
test('phase gaps keep absence and inverted cross-realm clocks unavailable',()=>{
 assert.equal(gap({},'end','start'),null);
 assert.equal(gap({start:11,end:10},'end','start'),null);
 assert.equal(gap({start:10,end:10},'end','start'),0);
 const job={workerFresh:true,clocks:{mainQueued:0,mainDequeued:7,mainWorkerCreated:8,mainSendBefore:9,mainSendAfter:12,workerModuleReady:15,workerReceived:18,workerCompileStart:20,workerCompileEnd:30,workerResultPostBefore:31,workerResultPostAfter:35,mainReceive:40,mainResultHandled:41,mainHandleEnd:45}};
 assert.deepEqual(workerBreakdown(job),{queueMs:7,startupMs:7,requestPostMs:3,inboundResidualMs:3,compileMs:10,resultPostMs:4,deliveryResidualMs:5,resultHandledMs:1,handlerMs:5,timeoutOvershootMs:null});
});
test('timeout and abandoned jobs remain in attributed evidence while invalid loads do not enter usable percentiles',()=>{
 const result=summarizeWorkerTrials({rows:[{cache:'cold',repetition:1,scenario:'web',error:'failed',workerInstrumentation:true,lastDiagnostics:{workerJobs:[{jobId:2,outcome:'timeout',abandoned:true,clocks:{mainQueued:1,mainTerminal:20002,mainDeadline:20000,mainTimeout:20002}}]}},{cache:'cold',metrics:{usableMs:1500},warnings:[],workerInstrumentation:false}]});
 assert.equal(result[0].attempts,2);assert.equal(result[0].errors,1);assert.equal(result[0].usableMs.p50,1500);
 assert.equal(result[0].stalledJobs.length,1);assert.equal(result[0].stalledJobs[0].abandoned,true);assert.equal(result[0].phases.timeoutOvershootMs.max,2);
});

const completeClocks={mainQueued:0,mainDequeued:7,mainSendBefore:9,mainSendAfter:12,workerModuleReady:15,workerReceived:18,workerCompileStart:25,workerCompileEnd:35,workerGraphInstalled:36,workerResultPostBefore:38,workerResultPostAfter:42,mainReceive:45,mainResultHandled:46,mainHandleEnd:50};
function assertPartition(job){
 const result=workerPartition(job);
 assert.equal(result.complete,true);
 assert.ok(Math.abs(Object.values(result.stages).reduce((a,b)=>a+b,0)-result.totalMs)<0.001);
 assert.ok(Object.values(result.stages).every(value=>value>=0));
 return result;
}
test('recorded 16.365 second compile partitions total without double-counting concurrent startup',()=>{
 const clocks={mainQueued:1791123662934,mainDequeued:1791123662934,mainSendBefore:1791123662934.2,mainSendAfter:1791123662957.5,workerModuleReady:1791123662981.4,workerReceived:1791123663123.4,workerCompileStart:1791123663123.5,workerCompileEnd:1791123679488.9,workerResultPostBefore:1791123679489.1,workerResultPostAfter:1791123679534.8,mainReceive:1791123679649.1,mainResultHandled:1791123679649.3,mainHandleEnd:1791123679649.3};
 const result=assertPartition({workerFresh:true,clocks});
 assert.equal(result.totalMs,clocks.mainHandleEnd-clocks.mainQueued);
 assert.equal(result.endClock,'mainHandleEnd');
 assert.equal(result.stages.compileMs,clocks.workerCompileEnd-clocks.workerCompileStart);
 assert.ok(result.stages.startupRemainingMs<workerBreakdown({workerFresh:true,clocks:{...clocks,mainWorkerCreated:clocks.mainDequeued}}).startupMs);
});
test('bootstrap validation and finalization are covered even when graph installation follows compile',()=>{
 const result=assertPartition({workerFresh:true,clocks:completeClocks});
 assert.equal(result.stages.workerPrecompileMs,7);
 assert.equal(result.stages.workerFinalizationMs,3);
 assert.equal(result.stages.handlerTailMs,4);
});
test('receipt before post return is concurrent, and missing ACK combines post and delivery',()=>{
 const overlap=assertPartition({workerFresh:true,clocks:{...completeClocks,mainSendAfter:24,workerResultPostAfter:48}});
 assert.equal(overlap.stages.requestPostConcurrentStartupMs,9);
 assert.equal(overlap.stages.startupRemainingMs,0);
 assert.equal(overlap.stages.resultDeliveryMs,0);
 const noAck={...completeClocks};delete noAck.workerResultPostAfter;
 const combined=assertPartition({workerFresh:true,clocks:noAck});
 assert.equal(combined.resultDeliveryAccounting,'combined-post-and-delivery');
 assert.equal(combined.stages.resultDeliveryMs,7);
 assert.equal(combined.stages.resultPostConcurrentDeliveryMs,undefined);
 assert.equal(workerBreakdown({clocks:noAck}).resultPostMs,null);
});
test('missing or inverted causal endpoints leave complete partition unavailable',()=>{
 assert.equal(workerPartition({clocks:{...completeClocks,workerCompileStart:undefined}}).complete,false);
 assert.equal(workerPartition({clocks:{...completeClocks,workerCompileStart:17}}).complete,false);
});
test('abandoned cancelled timeout is counted as an event and retains last worker phase evidence',()=>{
 const phases={received:{worker:10,mainReceive:11,mainHandleEnd:12},layout:{worker:50,mainReceive:51,mainHandleEnd:52}};
 const summary=summarizeWorkerTrials({rows:[{cache:'cold',error:'failed',lastDiagnostics:{workerJobs:[{outcome:'cancelled',abandoned:true,clocks:{mainQueued:0,mainTimeout:20010,mainDeadline:20000},phases}]}}]})[0];
 assert.equal(summary.timeoutEvents,1);assert.equal(summary.outcomes.cancelled,1);assert.equal(summary.outcomes.timeout,0);
 assert.deepEqual(summary.stalledJobs[0].phases,phases);
 assert.equal(summary.stalledJobs[0].lastPhase,'layout');assert.equal(summary.stalledJobs[0].lastPhaseAgeMs,19960);
 assert.equal(summary.stalledJobs[0].partition.complete,false);
});

test('refused cache-policy attempts retain errors but cannot recount prior timeout diagnostics',()=>{
 const job={outcome:'cancelled',abandoned:true,clocks:{mainQueued:0,mainTimeout:20010,mainDeadline:20000},phases:{layout:{worker:50,mainReceive:51,mainHandleEnd:52}}};
 const rows=[{cache:'warm',stage:'readiness',error:'failed',lastDiagnostics:{workerJobs:[job]}},{cache:'warm',stage:'cache-policy',error:'refused',lastDiagnostics:{workerJobs:[job]}}];
 const summary=summarizeWorkerTrials({rows})[1];
 assert.equal(summary.attempts,2);assert.equal(summary.errors,2);
 assert.equal(summary.jobs,1);assert.equal(summary.outcomes.cancelled,1);
 assert.equal(summary.timeoutEvents,1);assert.equal(summary.stalledJobs.length,1);
 assert.equal(summary.phases.timeoutOvershootMs.n,1);
 assert.equal(summary.phases.timeoutOvershootMs.max,10);
});
