import test from 'node:test';
import assert from 'node:assert/strict';
import { gap, workerBreakdown, summarizeWorkerTrials } from './workerAnalysis.mjs';
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
