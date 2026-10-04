import { afterEach, expect, it, vi } from 'vitest';
import type { SceneCompileRequest, SceneCompileResponse, SceneWorkerRequest, SceneWorkerResponse } from './sceneCompileProtocol';
import type { ScanSceneInput } from './scanScene';
const compile = vi.hoisted(() => vi.fn((input: ScanSceneInput) => ({ rootEntityId: input.focusEntityId, previous: input.previous })));
vi.mock('./scanScene', () => ({ compileScanScene: compile }));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.resetModules(); compile.mockClear(); });
it('owns one graph generation and bounds previous scene references to the last two results', async () => {
  const worker = { onmessage: null as ((event: { data: SceneCompileRequest }) => void) | null, postMessage: vi.fn() };
  vi.stubGlobal('self', worker);
  await import('./sceneCompileWorker');
  const input = { focusEntityId: 'root' } as SceneCompileRequest['input'];
  const snapshot = {} as ScanSceneInput['snapshot'];
  const graph = { snapshot, view: { rootEntityId: 'root' }, childCounts: { root: 3 }, unpublishedChildren: [] } as unknown as NonNullable<SceneCompileRequest['graph']>;
  const send = (request: SceneCompileRequest) => {
    worker.onmessage!({ data: request });
    return worker.postMessage.mock.lastCall![0] as SceneCompileResponse;
  };
  const first = send({ id: 1, generation: 0, graph, input });
  expect(first.ok).toBe(true);
  expect(worker.postMessage.mock.calls.slice(0, 3).map(call => call[0])).toEqual(['received', 'compiling', 'compiled'].map(phase => ({ operation: 'progress', id: 1, generation: 0, phase })));
  expect(compile.mock.lastCall![0]).toMatchObject(graph);
  send({ id: 2, generation: 0, previousId: 1, input });
  expect(compile.mock.lastCall![0].previous).toBe(first.scene);
  send({ id: 3, generation: 0, input });
  expect(send({ id: 4, generation: 0, previousId: 1, input }).ok).toBe(false);
  expect(send({ id: 5, generation: 1, input }).ok).toBe(false);
  expect(send({ id: 6, generation: 1, graph, previousId: 3, input }).ok).toBe(false);
  expect(send({ id: 7, generation: 1, input }).ok).toBe(true);
});

it('initialization retains the full graph while compiling a temporary bootstrap slice', async () => {
  const { sliceArchitectureNeighborhood } = await import('@okie/architecture');
  const { default: snapshotDoc } = await import('../../../../fixtures/architecture/demo-snapshot.json');
  const { default: viewDoc } = await import('../../../../fixtures/architecture/demo-view.json');
  const snapshot = structuredClone(snapshotDoc) as unknown as ScanSceneInput['snapshot'];
  const view = structuredClone(viewDoc) as unknown as ScanSceneInput['view'];
  const owner = snapshot.entities.find(entity => entity.kind === 'component')!;
  snapshot.entities.push(...Array.from({ length: 150 }, (_, i) => ({ id: `code:worker-${i}`, name: `code${i}`, kind: 'code' as const, parentId: owner.id, sourceRefs: [] })));
  const packet = { ...sliceArchitectureNeighborhood(snapshot, view, { focusEntityId: view.rootEntityId }), snapshot, view };
  const worker = { onmessage: null as ((event: { data: SceneWorkerRequest }) => void) | null, postMessage: vi.fn() };
  vi.stubGlobal('self', worker); await import('./sceneCompileWorker');
  worker.onmessage!({ data: { operation: 'initializeNeighborhood', id: 1, generation: 2, packet, modeOptions: {} } });
  const initial = worker.postMessage.mock.lastCall![0] as SceneWorkerResponse;
  expect('status' in initial && initial.status).toBe('ready');
  expect(compile.mock.lastCall![0].snapshot).not.toBe(snapshot);
  const input = { focusEntityId: view.rootEntityId, boot: 'neighborhood', modeOptions: {} } as SceneCompileRequest['input'];
  worker.onmessage!({ data: { id: 2, generation: 2, input, previousId: 1 } });
  expect(compile.mock.lastCall![0]).toMatchObject({ snapshot, view, childCounts: packet.childCounts, unpublishedChildren: packet.unpublishedChildren ?? [] });
  expect(compile.mock.lastCall![0].previous).toBe('scene' in initial ? initial.scene : undefined);
  const invalid = { ...packet, schemaVersion: 999 } as unknown as typeof packet;
  worker.onmessage!({ data: { operation: 'initializeNeighborhood', id: 3, generation: 4, packet: invalid, modeOptions: {} } });
  const response = worker.postMessage.mock.lastCall![0] as SceneWorkerResponse;
  expect('status' in response && response.status).toBe('invalid');
  worker.onmessage!({ data: { id: 4, generation: 2, input } });
  expect((worker.postMessage.mock.lastCall![0] as SceneCompileResponse).ok).toBe(false);
});

it('opt-in clocks separate compiler work from progress and result post costs', async () => {
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const worker = { onmessage:null as ((event:{data:SceneWorkerRequest})=>void)|null,
    postMessage:vi.fn((_response:SceneWorkerResponse)=>{ now += 5; }) };
  vi.stubGlobal('self', worker);
  compile.mockImplementationOnce((input:ScanSceneInput)=>{ now += 7; return {rootEntityId:input.focusEntityId, previous:input.previous}; });
  await import('./sceneCompileWorker');
  worker.onmessage!({data:{id:1,generation:0,diagnostics:true,graph:{snapshot:{} as ScanSceneInput['snapshot'],view:{rootEntityId:'root'} as ScanSceneInput['view'],childCounts:{},unpublishedChildren:[]},input:{focusEntityId:'root'} as SceneCompileRequest['input']}});
  const messages = worker.postMessage.mock.calls.map(call=>call[0]);
  const result = messages.find(message=>!('operation' in message))!;
  const ack = messages.at(-1)!;
  expect('operation' in ack && ack.operation).toBe('timing');
  expect(result.clocks!.workerCompileEnd! - result.clocks!.workerCompileStart!).toBe(7);
  expect(ack.clocks!.workerResultPostAfter! - ack.clocks!.workerResultPostBefore!).toBe(5);
  expect(result.clocks!.workerGraphInstalled).toBeGreaterThanOrEqual(result.clocks!.workerReceived!);
  expect(messages[0]).toMatchObject({operation:'progress', phase:'received', clocks:{workerModuleReady:expect.any(Number),workerTimeOrigin:performance.timeOrigin}});
});

it('reports installed input graph size on diagnostic progress/results, reuse and replacement only',async()=>{
  const worker={onmessage:null as ((event:{data:SceneWorkerRequest})=>void)|null,postMessage:vi.fn()};
  vi.stubGlobal('self',worker);await import('./sceneCompileWorker');
  const graphFor=(entities:number,relations:number)=>({snapshot:{entities:Array.from({length:entities},()=>({name:'private entity'})),relations:Array.from({length:relations},()=>({name:'private relation'}))},view:{rootEntityId:'root'},childCounts:{},unpublishedChildren:[]}) as unknown as NonNullable<SceneCompileRequest['graph']>;
  const send=(request:SceneCompileRequest)=>{worker.postMessage.mockClear();worker.onmessage!({data:request});return worker.postMessage.mock.calls.map(call=>call[0] as SceneWorkerResponse);};
  const input={focusEntityId:'root'} as SceneCompileRequest['input'];
  for(const [request,size]of [
    [{id:1,generation:1,diagnostics:true,graph:graphFor(2,3),input},{entities:2,relations:3}],
    [{id:2,generation:1,diagnostics:true,input},{entities:2,relations:3}],
    [{id:3,generation:2,diagnostics:true,graph:graphFor(5,7),input},{entities:5,relations:7}],
  ] as const){
    const messages=send(request);
    expect(messages.filter(message=>!('operation' in message)||message.operation==='timing'||message.operation==='progress'&&message.phase==='compiling').map(message=>message.graphSize)).toEqual([size,size,size]);
    expect(JSON.stringify(messages.map(message=>message.graphSize))).not.toContain('private');
  }
  expect(send({id:4,generation:2,input}).every(message=>message.graphSize===undefined)).toBe(true);
});

it('bootstrap diagnostics count the validated full retained graph rather than the temporary shallow slice',async()=>{
  const {sliceArchitectureNeighborhood}=await import('@okie/architecture');
  const {default:snapshotDoc}=await import('../../../../fixtures/architecture/demo-snapshot.json');
  const {default:viewDoc}=await import('../../../../fixtures/architecture/demo-view.json');
  const snapshot=structuredClone(snapshotDoc) as unknown as ScanSceneInput['snapshot'];
  const view=structuredClone(viewDoc) as unknown as ScanSceneInput['view'];
  const owner=snapshot.entities.find(entity=>entity.kind==='component')!;
  snapshot.entities.push(...Array.from({length:150},(_,index)=>({id:`code:size-${index}`,name:`symbol${index}`,kind:'code' as const,parentId:owner.id,sourceRefs:[]})));
  const packet={...sliceArchitectureNeighborhood(snapshot,view,{focusEntityId:view.rootEntityId}),snapshot,view};
  const worker={onmessage:null as ((event:{data:SceneWorkerRequest})=>void)|null,postMessage:vi.fn()};
  vi.stubGlobal('self',worker);await import('./sceneCompileWorker');
  worker.onmessage!({data:{operation:'initializeNeighborhood',id:1,generation:1,packet,modeOptions:{},diagnostics:true}});
  const messages=worker.postMessage.mock.calls.map(call=>call[0] as SceneWorkerResponse);
  const expected={entities:snapshot.entities.length,relations:snapshot.relations.length};
  expect(compile.mock.lastCall![0].snapshot.entities.length).toBeLessThan(expected.entities);
  expect(messages.find(message=>'status' in message&&message.status==='ready')?.graphSize).toEqual(expected);
  expect(messages.at(-1)?.graphSize).toEqual(expected);
});
