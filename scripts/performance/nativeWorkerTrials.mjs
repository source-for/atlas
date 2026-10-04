/** Manual adapter for an agent-owned tab in existing native Chrome. No login, auth reads or browser launch. */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { cpus, freemem, totalmem, platform, release, arch } from 'node:os';
import { execFileSync } from 'node:child_process';
import { repoRoot } from './common.mjs';
import { installProbe, timingReport } from './probe.mjs';
import { summarizeWorkerTrials } from './workerAnalysis.mjs';
const paths={web:'/r/source-for/atlas?root=container:apps-web&detail=context&lens=system:okie',app:'/r/source-for/atlas?root=container:apps-web&detail=context&sel=component:apps-web-src-app-tsx&lens=system:okie&lens=container:apps-web&lens=component:apps-web-src-app-tsx&z=7.95'};
const expectedFor=scenario=>scenario==='web'?'container:apps-web':'component:apps-web-src-app-tsx';
const methods=['Runtime.consoleAPICalled','Network.responseReceived','Network.requestWillBeSent'];
const bounded=async(promise,ms)=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Journey deadline exceeded')),ms);})]);}finally{clearTimeout(timer);}};

/** Caller supplies the documented Cua Tab and tab-scoped CDP capability. Close the agent-owned tab after finish. */
export async function createNativeWorkerTrialSession({tab,cdp,origin,runs=20,output,onProgress,backend='webgpu',cpuThrottleRate='inherited (not changed by adapter)',deadlineMs=45000}){
 if(!Number.isInteger(runs)||runs<1)throw new Error('runs must be a positive integer; fewer than20 is a smoke check.');
 if(!['https://sourcefor.dev','https://staging.sourcefor.dev'].includes(origin)&&!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin))throw new Error('Use production, staging or loopback production build.');
 if(!['webgpu','webgl2'].includes(backend))throw new Error('Choose an explicit GPU backend.');
 output=resolve(output??`/tmp/cla385-native-${Date.now()}.json`);
 if(!output.startsWith('/tmp/')||!output.endsWith('.json'))throw new Error('Raw output must be a .json file under /tmp.');
 if(!Number.isFinite(deadlineMs)||deadlineMs<1000||deadlineMs>45000)throw new Error('One journey deadline must be1000–45000ms.');
 let scriptId,cursor,finished=false,busy=false;
 const primed=new Set();
 const report={schemaVersion:1,smoke:runs<20,startedAt:new Date().toISOString(),environment:{
  commit:execFileSync('git',['rev-parse','HEAD'],{cwd:repoRoot,encoding:'utf8'}).trim(),dirty:execFileSync('git',['status','--porcelain'],{cwd:repoRoot,encoding:'utf8'}).trim(),origin,
  browserProfile:'Existing native Chrome profile and ordinary sign-in; no fresh context, no cookie/token reads or copies',headless:false,node:'browser-control runtime; Node version unavailable',
  os:`${platform()} ${release()} ${arch()}`,cpu:cpus()[0].model,logicalCpus:cpus().length,memoryBytes:totalmem(),freeMemoryBytes:freemem(),cpuThrottleRate,backend,
  cache:'Existing profile reused. Cold clears browser HTTP cache and disables cache throughout journey; warm enables cache, full prime, then new document. Browser/GPU/user state retained; cache clear affects shared profile cache. Cache disabling is target-scoped and restored to standard enabled policy.',
  nativeBackgroundPolicy:'Existing native Chrome launch/profile settings inherited, not changed; tab brought to front per journey. Background processes and other user tabs uncontrolled.',
  instrumentation:'perf=1 and temporary dev mode; pre-document bounded longtask/visibility observers; safe workerJobs JSON, no raw trace',
  network:origin.startsWith('https:')?'Live read-only published endpoints; remote cache/network variance retained':'Loopback pinned responses',
  usableMetric:'Matching populated inspector, projection/canvas and visible-entity diagnostics when available; older builds use partitionDrawn>0 residency surrogate, labeled per row',
  order:'Alternating web/App by repetition; cold then warm; explicit full prime before measured warm; story step3 paused after each load',
  cleanup:'Remove pre-document script, disconnect injected observers, restore only prior okie.devMode value; cache enabled and owned-target request blocklist cleared. CPU is caller metadata only, never changed here. Root closes agent-owned tab.',
 },rows:[],primingFailures:[]};
 const save=async()=>{await mkdir(dirname(output),{recursive:true});await writeFile(output,`${JSON.stringify(report,null,2)}\n`);};
 const evaluate=async(expression,timeoutMs=3000)=>{
  const result=await cdp.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:false},{timeoutMs});
  if(result.exceptionDetails)throw new Error('Diagnostic evaluation failed');
  return result.result?.value;
 };
 const drain=async({row,waitMs=0}={})=>{
  let pages=0;
  do{
   const events=await cdp.readEvents({...(cursor===undefined?{}:{afterSequence:cursor}),methods,limit:1000,timeoutMs:waitMs});
   cursor=events.cursor;
   if(row){
    if(events.truncated)row.captureTruncated=true;
    for(const event of events.events){
     const p=event.params??{};
     if(event.method==='Network.responseReceived'){row.cacheResponses.total++;row.cacheResponses.disk+=Boolean(p.response?.fromDiskCache);row.cacheResponses.serviceWorker+=Boolean(p.response?.fromServiceWorker);}
     if(event.method==='Network.requestWillBeSent'){
      try{const url=new URL(p.request?.url);if(url.origin===origin&&/^\/(api|scan)\//.test(url.pathname)&&!['GET','HEAD','OPTIONS'].includes(p.request?.method))row.unexpectedRequests.push({method:p.request.method,kind:'application-write'});}catch{}
     }
     if(event.method==='Runtime.consoleAPICalled'&&p.type==='warning'&&p.args?.[0]?.value==='Atlas worker preparation failed'){
      const fields=Object.fromEntries((p.args[1]?.preview?.properties??[]).filter(field=>['reason','phase','elapsedMs'].includes(field.name)).map(field=>[field.name,field.value]));
      row.warnings.push({sequence:event.sequence,reason:/^atlas-worker-[a-z-]+$/.test(fields.reason??'')?fields.reason:'unavailable',phase:/^(queued|received|compiling|compiled|root-slice|projection|layout|adapter)$/.test(fields.phase??'')?fields.phase:'unavailable',...(Number.isFinite(Number(fields.elapsedMs))?{elapsedMs:Number(fields.elapsedMs)}:{})});
     }
    }
   }
   if(!events.hasMore)return;
   if(++pages===10){if(row)row.captureTruncated=true;return;}
   waitMs=0;
  }while(true);
 };
 const script=`(()=>{if(location.origin!==${JSON.stringify(origin)})return;
 const original=localStorage.getItem('okie.devMode');window.__okieNativeOriginalDev=original;
 const observers=[];const OriginalPO=window.PerformanceObserver,OriginalMO=window.MutationObserver;
 try {if(OriginalPO)window.PerformanceObserver=class extends OriginalPO{constructor(...args){super(...args);observers.push(this);}};
 window.MutationObserver=class extends OriginalMO{constructor(...args){super(...args);observers.push(this);}};
 (${installProbe.toString()})();}finally{window.PerformanceObserver=OriginalPO;window.MutationObserver=OriginalMO;}
 const transitions=window.__okieWorkerTrialVisibility=[{atMs:performance.now(),visible:document.visibilityState==='visible',focused:document.hasFocus()}];
 let dropped=0;const changed=()=>{if(transitions.length<200)transitions.push({atMs:performance.now(),visible:document.visibilityState==='visible',focused:document.hasFocus()});else dropped++;};
 for(const type of ['visibilitychange','focus','blur'])window.addEventListener(type,changed);
 const restore=()=>{if(original===null)localStorage.removeItem('okie.devMode');else localStorage.setItem('okie.devMode',original);};
 window.addEventListener('pagehide',restore,{once:true});
 window.__okieNativeCleanup=()=>{observers.forEach(observer=>observer.disconnect());for(const type of ['visibilitychange','focus','blur'])window.removeEventListener(type,changed);window.removeEventListener('pagehide',restore);restore();};
 window.__okieNativeVisibilityDropped=()=>dropped;
 })()`;
 try{
  await cdp.send('Runtime.enable',{});await cdp.send('Network.enable',{});
  await cdp.send('Network.setBlockedURLs',{urls:['*://*/api/ask*','*://*/api/operator/*','https://openrouter.ai/*','https://api.openai.com/*','https://api.anthropic.com/*']});
  scriptId=(await cdp.send('Page.addScriptToEvaluateOnNewDocument',{source:script})).identifier;
  report.environment.browser=await cdp.send('Browser.getVersion',{}).then(value=>({product:value.product,jsVersion:value.jsVersion,protocolVersion:value.protocolVersion})).catch(()=>({unavailable:true}));
  await drain();
 }catch(error){
  if(scriptId)await cdp.send('Page.removeScriptToEvaluateOnNewDocument',{identifier:scriptId}).catch(()=>{});
  await cdp.send('Network.setBlockedURLs',{urls:[]}).catch(()=>{});
  await cdp.send('Network.setCacheDisabled',{cacheDisabled:false}).catch(()=>{});
  throw error;
 }
 const runOne=async({scenario,cache,repetition,prime=false})=>{
  if(finished||busy)throw new Error('Session finished or another journey is running');
  if(!['web','app'].includes(scenario)||!['cold','warm'].includes(cache)||!Number.isInteger(repetition)||repetition<1||repetition>runs||prime&&cache!=='warm')throw new Error('Invalid journey configuration');
  busy=true;const row={scenario,cache,repetition,prime,expected:expectedFor(scenario),metrics:{},warnings:[],unexpectedRequests:[],cacheResponses:{total:0,disk:0,serviceWorker:0}};
  const started=Date.now(),deadline=started+deadlineMs,key=`${scenario}:${repetition}`;
  const remaining=()=>{const left=deadline-Date.now();if(left<=0)throw new Error('Journey deadline exceeded');return left;};
  const read=expression=>evaluate(expression,Math.min(3000,remaining()));
  const poll=async(expression)=>{while(true){const result=await read(expression);if(result?.failure==='deep-history-preparation')throw new Error('Deep history preparation failed');if(result)return result;await drain({row,waitMs:Math.min(250,remaining())});}};
  const click=async(locator)=>{
   // Only readiness waits retry. An action error may have dispatched a real click, so never retry it.
   while(true){
    let actionable=false;
    try{
     await locator.waitFor({state:'visible',timeoutMs:Math.min(3000,remaining())});
     const disabled=await locator.getAttribute('disabled');
     const ariaDisabled=await locator.getAttribute('aria-disabled');
     actionable=disabled==null&&ariaDisabled!=='true';
    }catch{remaining();}
    if(actionable)break;
    await drain({row,waitMs:Math.min(250,remaining())});
   }
   await locator.click({timeoutMs:Math.min(3000,remaining())});
  };
  try{
   await drain();
   if(cache==='cold'){primed.clear();await cdp.send('Network.clearBrowserCache',{});}
   await cdp.send('Network.setCacheDisabled',{cacheDisabled:cache==='cold'});
   if(cache==='warm'&&!prime&&!primed.has(key))throw new Error('Measured warm journey requires a successful explicit prime');
   await cdp.send('Page.bringToFront',{});
   await bounded(tab.goto(`${origin}${paths[scenario]}&perf=1&backend=${backend}`),remaining());
   await cdp.send('Page.bringToFront',{});
   row.metrics.usableMs=await poll(`(()=>{const app=document.querySelector('[data-testid="atlas-app"]');let replay,navigation;try{replay=JSON.parse(app?.dataset.rendererReplayState??'{}');navigation=JSON.parse(app?.dataset.navigationState??'{}');}catch{return false;}if(Array.from(document.querySelectorAll('[role="status"]')).some(node=>/This history entry could not|Background scene preparation is unavailable|Reload this page/.test(node.textContent??'')))return{failure:'deep-history-preparation'};const loading=Boolean(document.querySelector('.map-heading [role="status"]'));const canvas=document.querySelector('[data-testid="atlas-canvas"] canvas');const drawn=app?.hasAttribute('data-renderer-visible-entities')?Number(app.dataset.rendererVisibleEntities)>0:replay.residency?.partitionDrawn>0;return !loading&&navigation.selectedId===${JSON.stringify(row.expected)}&&navigation.rootEntityId==='container:apps-web'&&Number(app?.dataset.cameraSettledEpoch)>0&&app?.dataset.selectedEntityId===${JSON.stringify(row.expected)}&&window.__okieBenchmark?.inspectorEntityId()===${JSON.stringify(row.expected)}&&Number(app.dataset.projectionEntityCount)>0&&drawn&&canvas?.width>0&&canvas?.height>0&&performance.now();})()`);
   row.initialBackend=row.backend=await read(`document.querySelector('[data-testid="renderer-status"]')?.dataset.activeBackend`);
   row.backendMismatch=row.backend!==backend;
   row.beforeStory=await read(`(${timingReport.toString()})()`);row.workerInstrumentation=Array.isArray(row.beforeStory?.workerJobs);
   row.usableContract=await read(`document.querySelector('[data-testid="atlas-app"]')?.hasAttribute('data-renderer-visible-entities')?'visible-entities':'residency-surrogate'`);
   row.deepSelection=await read(`(()=>{const query=new URLSearchParams(location.search),overview=document.querySelector('[data-contextual-overview]'),prose=overview?.querySelector('.overview-description,.overview-lead,[data-block-type="markdown"],[data-block-type="observed_text"]');return{selected:document.querySelector('[data-testid="atlas-app"]')?.dataset.selectedEntityId,lensDepth:query.getAll('lens').length,heading:overview?.querySelector('.overview-title')?.textContent,kind:overview?.querySelector('.overview-chip')?.textContent,descriptionPresent:Boolean(prose?.textContent?.trim())&&!overview?.textContent.includes('No description has been captured yet.')};})()`);
   if(scenario==='app'&&row.deepSelection.lensDepth!==3)throw new Error('Deep App lens path was rewritten');
   if(await read(`Boolean(document.querySelector('.story-catalog-menu > summary'))`))await click(tab.playwright.locator('.story-catalog-menu > summary'));
   const storyStart=await read('performance.now()');
   await click(tab.playwright.locator('[data-testid="story-launch-overview"]'));
   await click(tab.playwright.getByRole('button',{name:/^Go to story step 3:/}));
   await poll(`(()=>{const player=document.querySelector('[data-playback-state="paused"]'),app=document.querySelector('[data-testid="atlas-app"]');return player?.dataset.storyPreparing==='false'&&player.getAttribute('aria-busy')==='false'&&player.querySelector('.story-copy small')?.textContent.includes('STEP 3 OF')&&window.__okieBenchmark.inspectorEntityId()===app?.dataset.selectedEntityId;})()`);
   row.metrics.storyPausedMs=(await read('performance.now()'))-storyStart;
   row.afterStory=await read(`(${timingReport.toString()})()`);
  }catch(error){row.error=/^(Journey deadline exceeded|Diagnostic evaluation failed|Measured warm journey requires a successful explicit prime|Deep App lens path was rewritten|Deep history preparation failed)$/.test(error.message)?error.message:'Navigation or UI action failed (external details omitted)';
   if(error.message==='Journey deadline exceeded')await cdp.send('Page.stopLoading',{}, {timeoutMs:2000}).catch(()=>{});
   row.lastDiagnostics=await evaluate(`(${timingReport.toString()})()`,2000).catch(()=>null);}
  finally{
   try{await drain({row});}catch{row.captureTruncated=true;}
   row.elapsedMs=Date.now()-started;
   row.probe=await evaluate(`({visibility:document.visibilityState,focused:document.hasFocus(),longTasks:window.__okieBenchmark?.longTasks,longTasksDropped:window.__okieBenchmark?.longTasksDropped,visibilityTransitions:window.__okieWorkerTrialVisibility,visibilityDropped:window.__okieNativeVisibilityDropped?.()})`,2000).catch(()=>null);
   row.state=await evaluate(`(()=>{const app=document.querySelector('[data-testid="atlas-app"]'),overview=document.querySelector('[data-contextual-overview]');let navigation;try{navigation=JSON.parse(app?.dataset.navigationState??'{}');}catch{}return{root:app?.dataset.rootEntityId,selected:app?.dataset.selectedEntityId,snapshotId:navigation?.snapshotId,viewId:navigation?.viewId,scanBoot:app?.dataset.scanBoot,overviewTitle:overview?.querySelector('.overview-title')?.textContent,storyState:document.querySelector('[data-playback-state]')?.dataset.playbackState,backend:document.querySelector('[data-testid="renderer-status"]')?.dataset.activeBackend,viewport:{width:innerWidth,height:innerHeight},deviceScaleFactor:devicePixelRatio};})()`,2000).catch(()=>null);
   row.finalBackend=row.state?.backend;
   row.build=await evaluate(`performance.getEntriesByType('resource').filter(e=>/\\/assets\\/(?:index|sceneCompileWorker)-[\\w-]+\\.js(?:$|\\?)/.test(e.name)).map(e=>({asset:e.name.match(/\\/assets\\/([^?]+)/)[1],startMs:e.startTime,durationMs:e.duration,transferBytes:e.transferSize,encodedBytes:e.encodedBodySize}))`,2000).catch(()=>[]);
   if(row.captureTruncated||row.probe?.longTasksDropped||row.probe?.visibilityDropped)row.error='Bounded capture overflow or truncated CDP evidence';
   if(row.unexpectedRequests.length)row.error='Unexpected non-read application request';
   if(prime){if(!row.error&&!row.warnings.length)primed.add(key);else{primed.delete(key);report.primingFailures.push(row);}}
   else report.rows.push(row);
   busy=false;report.summary=summarizeWorkerTrials(report);await save();await onProgress?.(row);
  }
  return row;
 };
 const finish=async()=>{
  if(busy)throw new Error('Finish only after the current journey completes');
  if(finished)return report;
  finished=true;report.cleanupFailures=[];
  for(const [name,work]of [['probe',()=>evaluate('window.__okieNativeCleanup?.()',2000)],['script',()=>cdp.send('Page.removeScriptToEvaluateOnNewDocument',{identifier:scriptId})],['cache',()=>cdp.send('Network.setCacheDisabled',{cacheDisabled:false})],['blockedRequests',()=>cdp.send('Network.setBlockedURLs',{urls:[]})]])try{await work();}catch{report.cleanupFailures.push(name);}
  report.finishedAt=new Date().toISOString();report.summary=summarizeWorkerTrials(report);await save();return report;
 };
 const runPair=async repetition=>{const scenario=repetition%2?'web':'app';const cold=await runOne({scenario,cache:'cold',repetition});const prime=await runOne({scenario,cache:'warm',repetition,prime:true});const warm=await runOne({scenario,cache:'warm',repetition});return{cold,prime,warm};};
 return{runOne,runPair,finish,report,output};
}
export async function runNativeWorkerTrials(options){const session=await createNativeWorkerTrialSession(options);try{for(let repetition=1;repetition<=(options.runs??20);repetition++)await session.runPair(repetition);}finally{await session.finish();}return session.report;}
