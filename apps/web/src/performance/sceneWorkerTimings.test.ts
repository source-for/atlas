import { expect, it } from 'vitest';
import { createPerformanceRecorder } from './recorder';
import { WORKER_JOB_LIMIT, type SceneWorkerJobTiming } from './sceneWorkerTimings';
const job = (correlationId:number):SceneWorkerJobTiming => ({correlationId,sessionId:1,jobId:correlationId,generation:0,operation:'compile',priority:'selected',outcome:'pending',abandoned:false,graphSent:false,workerFresh:false,clocks:{mainQueued:10},phases:{}});
it('keeps bounded job snapshots independent of metric-ring eviction, without resurrecting late ACKs',()=>{
  const recorder=createPerformanceRecorder(1);
  for(let id=1;id<=WORKER_JOB_LIMIT+2;id++)recorder.recordWorkerJob(job(id));
  recorder.recordWorkerJob({...job(1),clocks:{workerResultPostAfter:100}});
  const latest=job(WORKER_JOB_LIMIT+2);latest.outcome='timeout';recorder.recordWorkerJob(latest);
  for(let i=0;i<10;i++)recorder.record('long-task',i,50);
  const report=recorder.report();
  expect(report.workerJobs).toHaveLength(WORKER_JOB_LIMIT);
  expect(report.droppedWorkerJobs).toBe(2);
  expect(report.workerJobs[0].correlationId).toBe(3);
  expect(report.workerJobs.at(-1)?.outcome).toBe('timeout');
  report.workerJobs.at(-1)!.clocks.mainQueued=999;
  expect(recorder.report().workerJobs.at(-1)?.clocks.mainQueued).toBe(10);
});
it('copies only fixed scalar job clocks and phase fields into exports',()=>{
  const recorder=createPerformanceRecorder();
  const value=job(1);
  Object.assign(value,{source:'private source',query:'secret query'});
  Object.assign(value.clocks,{entityId:'private entity',workerCompileEnd:NaN,workerCompileStart:-1});
  Object.assign(value.phases,{privatePhase:{worker:1,mainReceive:2,mainHandleEnd:3}});
  value.phases.received={worker:10,mainReceive:20,mainHandleEnd:21};
  recorder.recordWorkerJob(value);
  expect(recorder.report().workerJobs[0].clocks).toEqual({mainQueued:10});
  expect(recorder.report().workerJobs[0].phases).toEqual({received:{worker:10,mainReceive:20,mainHandleEnd:21}});
  expect(JSON.stringify(recorder.report())).not.toMatch(/private|secret|entityId|source|query/);
});

it('exports only independent safe integer graph cardinalities, not graph data or malformed counts',()=>{
  const recorder=createPerformanceRecorder();const value=job(1);
  Object.assign(value,{graphSize:{entities:5507,relations:13003,entityNames:['private']}});
  recorder.recordWorkerJob(value);
  expect(recorder.report().workerJobs[0].graphSize).toEqual({entities:5507,relations:13003});
  value.graphSize!.entities=1;
  const exported=recorder.report();exported.workerJobs[0].graphSize!.relations=1;
  expect(recorder.report().workerJobs[0].graphSize).toEqual({entities:5507,relations:13003});
  for(const [index,invalid]of [{entities:-1,relations:1},{entities:1.5,relations:1},{entities:NaN,relations:1},{entities:1,relations:Infinity},{entities:'1',relations:1},{entities:1},null].entries()){
    const malformed=job(index+2);Object.assign(malformed,{graphSize:invalid});recorder.recordWorkerJob(malformed);
  }
  expect(recorder.report().workerJobs.slice(1).every(value=>value.graphSize===undefined)).toBe(true);
  expect(JSON.stringify(recorder.report())).not.toContain('private');
});
