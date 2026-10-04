#!/usr/bin/env node
/** Manual native Chrome worker trials. Never part of CI; raw evidence stays outside git. */
import { chromium } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname, sep } from 'node:path';
import { cpus, freemem, totalmem, platform, release, arch } from 'node:os';
import { execFileSync } from 'node:child_process';
import { repoRoot, arg } from './common.mjs';
import { installProbe, timingReport } from './probe.mjs';
import { summarizeWorkerTrials } from './workerAnalysis.mjs';

const runs=Number(arg('runs','20'));
const smoke=process.argv.includes('--smoke');
if(!Number.isInteger(runs)||runs<1||(!smoke&&runs<20))throw new Error('Use >=20 runs; --smoke permits a smaller harness validation.');
const origin=arg('origin','https://staging.sourcefor.dev');
if(!['https://sourcefor.dev','https://staging.sourcefor.dev'].includes(origin)&&!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin))throw new Error('Only production, staging or an explicit loopback production build are supported.');
const output=resolve(arg('output',`/tmp/cla385-${Date.now()}.json`));
if(!output.endsWith('.json')||output===repoRoot||output.startsWith(`${repoRoot}${sep}`))throw new Error('Raw report must be a .json file outside the repository.');
const timeout=Number(arg('timeout','65000'));
if(!Number.isFinite(timeout)||timeout<1)throw new Error('--timeout must be positive.');
const backend=arg('backend','webgpu');
if(!['webgpu','webgl2'].includes(backend))throw new Error('Choose WebGPU or WebGL2 explicitly.');
const paths={
 web:'/r/source-for/atlas?root=container:apps-web&detail=context&lens=system:okie',
 app:'/r/source-for/atlas?root=container:apps-web&detail=context&sel=component:apps-web-src-app-tsx&lens=system:okie&lens=container:apps-web&lens=component:apps-web-src-app-tsx&z=7.95',
};
const browser=await chromium.launch({channel:'chrome',headless:false,
 ignoreDefaultArgs:['--disable-background-timer-throttling','--disable-backgrounding-occluded-windows','--disable-renderer-backgrounding'],
 args:['--disable-background-networking','--disable-component-update','--no-first-run']});
const report={schemaVersion:1,smoke,startedAt:new Date().toISOString(),environment:{
 commit:execFileSync('git',['rev-parse','HEAD'],{cwd:repoRoot,encoding:'utf8'}).trim(),
 dirty:execFileSync('git',['status','--porcelain'],{cwd:repoRoot,encoding:'utf8'}).trim(),
 origin,browser:browser.version(),channel:'chrome',headless:false,node:process.version,
 playwright:JSON.parse(await readFile(resolve(repoRoot,'node_modules/playwright/package.json'),'utf8')).version,
 os:`${platform()} ${release()} ${arch()}`,cpu:cpus()[0].model,logicalCpus:cpus().length,memoryBytes:totalmem(),freeMemoryBytes:freemem(),
 viewport:{width:1440,height:1000},deviceScaleFactor:1,cpuThrottleRate:1,backend,
 cache:'Fresh isolated context per cold/warm pair; cold cache cleared and disabled for the journey; warm cache enabled, one full unmeasured prime, then a new document. Browser/GPU process reused.',
 network:origin.startsWith('https:')?'Live read-only published endpoints; remote cache/network variance retained':'Loopback pinned responses',
 instrumentation:'perf=1, dev mode, bounded pre-document long tasks and visibility transitions; no raw DevTools trace',
 nativeBackgroundPolicy:'Playwright default flags disabling background timers/occluded-window and renderer backgrounding explicitly omitted; normal Chrome visibility scheduling retained',
 usableMetric:'DOM polling observes matching populated inspector, positive projection, canvas dimensions and positive renderer-visible entities when available; older deployed builds use partitionDrawn>0 residency surrogate (row labeled; contracts not directly comparable)',
 order:'Alternating web/App deep links by repetition; cold then warm; full story step-3 paused check after each load',
 },rows:[]};
const save=async()=>{await mkdir(dirname(output),{recursive:true});await writeFile(output,`${JSON.stringify(report,null,2)}\n`);};
async function trial(page,url,expected,measure=true){
 const warnings=[];
 const onConsole=message=>{if(message.type()==='warning'&&message.text().startsWith('Atlas worker preparation failed'))warnings.push({atMs:Date.now(),text:message.text()});};
 page.on('console',onConsole);
 const start=Date.now();const row={expected,metrics:{},warnings};
 try{
  await page.bringToFront();
  await page.goto(url,{waitUntil:'domcontentloaded',timeout});
  if(new URL(page.url()).origin!==origin)throw new Error('App origin redirected to an access gate; use the authenticated native-profile adapter without copying credentials');
  await page.bringToFront();
  const ready=await page.waitForFunction(expected=>{
   const app=document.querySelector('[data-testid="atlas-app"]');
   let replay;try{replay=JSON.parse(app?.dataset.rendererReplayState??'{}');}catch{return false;}
   let navigation;try{navigation=JSON.parse(app?.dataset.navigationState??'{}');}catch{return false;}
   const loading=Boolean(document.querySelector('.map-heading [role="status"]'));
   const canvas=document.querySelector('[data-testid="atlas-canvas"] canvas');
   const drawn=app?.hasAttribute('data-renderer-visible-entities')?Number(app.dataset.rendererVisibleEntities)>0:replay.residency?.partitionDrawn>0;
   return !loading&&navigation?.selectedId===expected&&navigation?.rootEntityId==='container:apps-web'&&Number(app?.dataset.cameraSettledEpoch)>0&&app?.dataset.selectedEntityId===expected&&window.__okieBenchmark?.inspectorEntityId()===expected&&Number(app.dataset.projectionEntityCount)>0&&drawn&&canvas?.width>0&&canvas?.height>0&&performance.now();
  },expected,{timeout});
  row.metrics.usableMs=await ready.jsonValue();await ready.dispose();
  const deepFailed=await page.evaluate(()=>Array.from(document.querySelectorAll('[role="status"]')).some(node=>/This history entry could not|Background scene preparation is unavailable|Reload this page/.test(node.textContent??'')));
  if(deepFailed)throw new Error('Deep history preparation failed');
  row.backend=await page.locator('[data-testid="renderer-status"]').getAttribute('data-active-backend');
  if(row.backend!==backend)throw new Error(`Requested ${backend}, got ${row.backend}`);
  row.beforeStory=await page.evaluate(timingReport);
  row.workerInstrumentation=Array.isArray(row.beforeStory.workerJobs);
  row.usableContract=await page.evaluate(()=>document.querySelector('[data-testid="atlas-app"]')?.hasAttribute('data-renderer-visible-entities')?'visible-entities':'residency-surrogate');
  row.deepSelection=await page.evaluate(()=>{const query=new URLSearchParams(location.search);const overview=document.querySelector('[data-contextual-overview]');const prose=overview?.querySelector('.overview-description,.overview-lead,[data-block-type="markdown"],[data-block-type="observed_text"]');return {selected:document.querySelector('[data-testid="atlas-app"]')?.dataset.selectedEntityId,lensDepth:query.getAll('lens').length,heading:overview?.querySelector('.overview-title')?.textContent,kind:overview?.querySelector('.overview-chip')?.textContent,descriptionPresent:Boolean(prose?.textContent?.trim())&&!overview?.textContent.includes('No description has been captured yet.')};});
  if(expected==='component:apps-web-src-app-tsx'&&row.deepSelection.lensDepth!==3)throw new Error('Deep App lens path was rewritten');
  const menu=page.locator('.story-catalog-menu > summary');if(await menu.count())await menu.click();
  const storyStart=await page.evaluate(()=>performance.now());
  await page.locator('[data-testid="story-launch-overview"]').click();
  const jump=page.getByRole('button',{name:/^Go to story step 3:/});
  await jump.click();
  await page.waitForFunction(()=>{
   const player=document.querySelector('[data-playback-state="paused"]');
   const app=document.querySelector('[data-testid="atlas-app"]');
   return player?.querySelector('.story-copy small')?.textContent.includes('STEP 3 OF')&&window.__okieBenchmark.inspectorEntityId()===app?.dataset.selectedEntityId;
  },null,{timeout});
  row.metrics.storyPausedMs=await page.evaluate(start=>performance.now()-start,storyStart);
  row.afterStory=await page.evaluate(timingReport);
 }catch(error){row.error=error.message;row.lastDiagnostics=await page.evaluate(timingReport).catch(()=>null);}
 finally{
  row.elapsedMs=Date.now()-start;
  row.probe=await page.evaluate(()=>({visibility:document.visibilityState,focused:document.hasFocus(),longTasks:window.__okieBenchmark?.longTasks,longTasksDropped:window.__okieBenchmark?.longTasksDropped,visibilityTransitions:window.__okieWorkerTrialVisibility})).catch(()=>null);
  row.state=await page.evaluate(()=>{
   const app=document.querySelector('[data-testid="atlas-app"]');const overview=document.querySelector('[data-contextual-overview]');
   let navigation;try{navigation=JSON.parse(app?.dataset.navigationState??'{}');}catch{}
   return {root:app?.dataset.rootEntityId,selected:app?.dataset.selectedEntityId,snapshotId:navigation?.snapshotId,viewId:navigation?.viewId,scanBoot:app?.dataset.scanBoot,overviewTitle:overview?.querySelector('.overview-title')?.textContent,storyState:document.querySelector('[data-playback-state]')?.dataset.playbackState,finalBackend:document.querySelector('[data-testid="renderer-status"]')?.dataset.activeBackend};
  }).catch(()=>null);
  // Fixed asset fingerprints identify deployed builds without exporting arbitrary resource URLs.
  row.build=await page.evaluate(()=>performance.getEntriesByType('resource').filter(e=>/\/assets\/(?:index|sceneCompileWorker)-[\w-]+\.js(?:$|\?)/.test(e.name)).map(e=>({asset:e.name.match(/\/assets\/([^?]+)/)[1],startMs:e.startTime,durationMs:e.duration,transferBytes:e.transferSize,encodedBytes:e.encodedBodySize})) ).catch(()=>[]);
  page.off('console',onConsole);
 }
 if(row.probe?.longTasksDropped)row.error='Long-task buffer overflow; evidence incomplete';
 if(measure)return row;
 if(row.error||warnings.length)throw new Error(`Warm prime failed: ${row.error??'worker warning'}`);
}
try{
 for(let repetition=1;repetition<=runs;repetition++){
  const scenario=repetition%2?'web':'app';const expected=scenario==='web'?'container:apps-web':'component:apps-web-src-app-tsx';
  const context=await browser.newContext({viewport:report.environment.viewport,deviceScaleFactor:1,serviceWorkers:'block'});
  context.setDefaultTimeout(timeout);
  await context.addInitScript(installProbe);
  await context.addInitScript(()=>{window.__okieWorkerTrialVisibility=[{atMs:performance.now(),visible:document.visibilityState==='visible',focused:document.hasFocus()}];for(const event of ['visibilitychange','focus','blur'])window.addEventListener(event,()=>{if(window.__okieWorkerTrialVisibility.length<200)window.__okieWorkerTrialVisibility.push({atMs:performance.now(),visible:document.visibilityState==='visible',focused:document.hasFocus()});});});
  // Do not use Playwright routing: it disables HTTP cache and invalidates warm trials.
  // Scripted controls only read published data; block inference/operator routes with CDP.
  const denied=[];
  const page=await context.newPage();const cdp=await context.newCDPSession(page);
  await cdp.send('Network.enable');await cdp.send('Emulation.setCPUThrottlingRate',{rate:1});
  await cdp.send('Network.setBlockedURLs',{urls:['*://*/api/ask*','*://*/api/operator/*','https://openrouter.ai/*','https://api.openai.com/*','https://api.anthropic.com/*']});
  page.on('request',request=>{const url=new URL(request.url());if(url.origin===origin&&/^\/(api|scan)\//.test(url.pathname)&&!['GET','HEAD','OPTIONS'].includes(request.method()))denied.push({method:request.method(),kind:'application-write'});});
  const cacheEvents=[];
  cdp.on('Network.responseReceived',event=>cacheEvents.push({disk:Boolean(event.response.fromDiskCache),serviceWorker:Boolean(event.response.fromServiceWorker)}));
  const url=`${origin}${paths[scenario]}&perf=1&backend=${backend}`;
  try{
   for(const cache of ['cold','warm']){
    let row;
    try{
     if(cache==='cold'){await cdp.send('Network.clearBrowserCache');await cdp.send('Network.setCacheDisabled',{cacheDisabled:true});}
     else{await cdp.send('Network.setCacheDisabled',{cacheDisabled:false});await trial(page,url,expected,false);cacheEvents.length=0;}
     row=await trial(page,url,expected);
    }catch(error){row={error:error.message};}
    row.unexpectedRequests=[...denied];
    row.cacheResponses={total:cacheEvents.length,disk:cacheEvents.filter(event=>event.disk).length,serviceWorker:cacheEvents.filter(event=>event.serviceWorker).length};cacheEvents.length=0;
    if(denied.length)row.error='Unexpected non-read application request';
    report.rows.push({scenario,cache,repetition,...row});
    console.log(`${origin} ${scenario} ${cache} ${repetition}/${runs}: ${row.error??`${Math.round(row.metrics.usableMs)}ms usable; ${row.warnings.length} worker warnings`}`);
    await save();
   }
  }finally{await context.close();}
 }
}finally{await browser.close();report.finishedAt=new Date().toISOString();report.summary=summarizeWorkerTrials(report);await save();}
if(report.rows.some(row=>row.error||row.warnings?.length))process.exitCode=1;
