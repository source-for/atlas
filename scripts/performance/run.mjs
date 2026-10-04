#!/usr/bin/env node
import { chromium } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname, sep } from 'node:path';
import { cpus, freemem, totalmem, platform, release, arch } from 'node:os';
import { execFileSync } from 'node:child_process';
import { repoRoot, arg, sha256, summarizeRows, assertWarmPrime } from './common.mjs';
import { serveBuild } from './server.mjs';
import { installProbe, timingReport } from './probe.mjs';
const runs=Number(arg('runs','10'));
const smoke=process.argv.includes('--smoke');
if(!Number.isInteger(runs)||runs<1||(!smoke&&runs<10))throw new Error('Use >=10 runs per cache/dataset. --smoke permits smaller validation runs.');
const datasets=arg('datasets','golden,stress,published').split(',');
if(datasets.some(name=>!['golden','stress','published'].includes(name)))throw new Error('Unknown dataset.');
const rate=Number(arg('cpu','1'));
if(!Number.isFinite(rate)||rate<1)throw new Error('--cpu must be >=1.');
const requestedBackend=arg('backend','webgl2');
if(!['webgl2','webgpu','canvas2d'].includes(requestedBackend))throw new Error('Choose an explicit backend.');
const headless=process.argv.includes('--headless');
const channel=arg('channel','chrome');
const output=resolve(arg('output',`/tmp/okie-performance-${Date.now()}.json`));
if(!output.endsWith('.json') || output===repoRoot || output.startsWith(`${repoRoot}${sep}`))throw new Error('--output must be a .json file outside the repository; raw reports are local artifacts.');
const timeout=Number(arg('timeout','45000'));
if(!Number.isFinite(timeout)||timeout<1)throw new Error('--timeout must be positive.');
const server=await serveBuild();
let browser;
try { browser=await chromium.launch({channel:channel==='chromium'?undefined:channel,headless,
 args:['--disable-background-networking','--disable-component-update','--no-first-run','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost'],
}); } catch(error) { await server.close(); throw error; }
const report={schemaVersion:1,smoke,startedAt:new Date().toISOString(),environment:{
 commit:execFileSync('git',['rev-parse','HEAD'],{cwd:repoRoot,encoding:'utf8'}).trim(),dirty:execFileSync('git',['status','--porcelain'],{cwd:repoRoot,encoding:'utf8'}).trim(),
 node:process.version,playwright:JSON.parse(await readFile(resolve(repoRoot,'node_modules/playwright/package.json'),'utf8')).version,
 browser:browser.version(),channel,headless,os:`${platform()} ${release()} ${arch()}`,cpu:cpus()[0].model,logicalCpus:cpus().length,memoryBytes:totalmem(),freeMemoryBytes:freemem(),
 cpuThrottleRate:rate,network:'unthrottled loopback; no remote browser traffic',viewport:{width:1440,height:1000},deviceScaleFactor:1,requestedBackend,
 cache:'cold: fresh context, CDP clear+disabled HTTP cache; warm: same context, cache enabled, unmeasured complete journey then fresh document. Workers/indexes fresh on reload; server bodies preloaded for both.',
 instrumentation:'perf=1 safe app timing recorder (panel hidden), pre-document scalar longtask PerformanceObserver, DOM observer; no DevTools trace',
 buildIndexSha256:sha256(await readFile(resolve(repoRoot,'apps/web/dist/index.html'))),
 publishedPin:server.pin,
 goldenSnapshotSha256:sha256(await readFile(resolve(repoRoot,'fixtures/architecture/demo-snapshot.json'))),
 stressSha256:sha256(await readFile(resolve(repoRoot,'fixtures/renderer/stress-5000.json'))),
},rows:[],serverViolations:server.violations};
const browserCdp=await browser.newBrowserCDPSession();
report.environment.gpu=await browserCdp.send('SystemInfo.getInfo').then(info=>({devices:info.gpu.devices,featureStatus:info.gpu.featureStatus})).catch(()=>({unavailable:true}));
const selectors={app:'[data-testid="atlas-app"]',inspector:'#inspector-entity-title'};
const unsupported=reason=>({status:'unsupported',reason});
async function checkReady(page) {
 await page.waitForFunction(()=>Number.isFinite(window.__okieBenchmark?.inspectorReadyMs) && Boolean(document.querySelector('[data-testid="renderer-status"]')?.dataset.activeBackend) && document.querySelector('[data-testid="renderer-status"]').dataset.activeBackend!=='initializing',null,{timeout});
 const state=await page.locator('[data-testid="renderer-status"]').getAttribute('data-active-backend');
 if(state!==requestedBackend)throw new Error(`Backend mismatch: requested ${requestedBackend}, active ${state}`);
 return state;
}
async function timedAction(page,locator,event,action,condition,arg) {
 await locator.evaluate((element,event)=>{element.addEventListener(event,()=>{window.__okieBenchmark.actionStart=performance.now();}, {once:true,capture:true});},event);
 await action();
 const completed=await page.waitForFunction(condition,arg,{timeout});
 const endMs=await completed.jsonValue();await completed.dispose();
 return {status:'ok',durationMs:endMs-await page.evaluate(()=>window.__okieBenchmark.actionStart)};
}
async function journey(page,dataset,url,measure=true) {
 const row={dataset,metrics:{},failures:[]};
 const step=async(name,work)=>{try{row.metrics[name]=await work();}catch(error){row.metrics[name]={status:'failed',reason:error.message};row.failures.push(name);}};
 await page.goto(url,{waitUntil:'domcontentloaded',timeout});
 row.backend=await checkReady(page);
 const startup=await page.evaluate(timingReport);
 const firstDraw=startup.samples.find(sample=>sample.metric==='atlas-first-frame');
 if(!firstDraw)throw new Error(`First draw timing absent (dropped ${startup.droppedSamples} safe samples); refusing a fabricated startup number.`);
 const probe=await page.evaluate(()=>({ready:window.__okieBenchmark.inspectorReadyMs,supported:window.__okieBenchmark.longTaskSupported,longTasks:window.__okieBenchmark.longTasks,dropped:window.__okieBenchmark.longTasksDropped}));
 if(probe.dropped)throw new Error('Pre-document longtask buffer overflow; startup metric would be incomplete.');
 row.metrics.firstDrawMs={status:'ok',durationMs:firstDraw.startMs};
 row.metrics.usableAtlasMs={status:'ok',durationMs:Math.max(firstDraw.startMs,probe.ready)};
 row.metrics.maxLongTaskBeforeDrawMs=probe.supported?{status:'ok',durationMs:Math.max(0,...probe.longTasks.filter(task=>task.startMs<firstDraw.startMs).map(task=>task.durationMs))}:unsupported('longtask PerformanceObserver unavailable');
 row.startupTimings=startup; row.preDrawLongTasks=probe.longTasks.filter(task=>task.startMs<firstDraw.startMs);
 if(dataset==='stress') { row.metrics.levelMs=unsupported('Renderer-only fixture has no architecture level navigation contract');row.metrics.childMs=unsupported('Synthetic leaves have no inspector children'); }
 else {
  await page.getByRole('tab',{name:'Details',exact:true}).click();
  await step('levelMs',async()=>{
   const epoch=await page.locator(selectors.app).getAttribute('data-camera-settled-epoch');
   const button=page.getByRole('button',{name:'Containers level',exact:true});
   return timedAction(page,button,'click',()=>button.click(),epoch=>{
    const app=document.querySelector('[data-testid="atlas-app"]');
    return app?.dataset.detail==='container' && app.dataset.cameraSettledEpoch!==epoch && window.__okieBenchmark.inspectorEntityId()===app.dataset.selectedEntityId && performance.now();
   },epoch);
  });
  await step('childMs',async()=>{
   const child=page.locator('.children-section button[data-inspector-entity-id]').first();
   const id=await child.getAttribute('data-inspector-entity-id');
   const epoch=await page.locator(selectors.app).getAttribute('data-camera-settled-epoch');
   return timedAction(page,child,'click',()=>child.click(),({id,epoch})=>{
    const app=document.querySelector('[data-testid="atlas-app"]');
    return app?.dataset.selectedEntityId===id && app.dataset.cameraSettledEpoch!==epoch && window.__okieBenchmark.inspectorEntityId()===id && performance.now();
   },{id,epoch});
  });
 }
 if(dataset==='stress') {row.metrics.storyStartMs=unsupported('Renderer stress fixture has no guided story');row.metrics.storyStep3Ms=unsupported('Renderer stress fixture has no guided story');}
 else {
  await step('storyStartMs',async()=>{
   const menu=page.locator('.story-catalog-menu > summary');if(await menu.count())await menu.click();
   const launch=page.locator('[data-testid="story-launch-overview"]');
   const storyId=await launch.getAttribute('data-story-id');
   return timedAction(page,launch,'click',()=>launch.click(),storyId=>{
    const player=document.querySelector('[data-playback-state]');
    return player?.dataset.storyId===storyId && player.dataset.playbackState!=='preparing' && window.__okieBenchmark.inspectorEntityId()===document.querySelector('[data-testid="atlas-app"]')?.dataset.selectedEntityId && performance.now();
   },storyId);
  });
  await step('storyStep3Ms',async()=>{
   const jump=page.getByRole('button',{name:/^Go to story step 3:/});
   return timedAction(page,jump,'click',()=>jump.click(),()=>{
    const player=document.querySelector('[data-playback-state="paused"]');
    return player?.querySelector('.story-copy small')?.textContent.includes('STEP 3 OF') && window.__okieBenchmark.inspectorEntityId()===document.querySelector('[data-testid="atlas-app"]')?.dataset.selectedEntityId && performance.now();
   });
  });
 }
 await step('searchMs',async()=>{
  await page.locator('.search-trigger').click();
  const input=page.locator('#atlas-search');
  const query=dataset==='stress'?'Node 42':'web';
  const result=await timedAction(page,input,'input',()=>input.fill(query),query=>{
   const input=document.querySelector('#atlas-search');const results=document.querySelector('.search-results');
   return input?.value===query && results?.getAttribute('aria-busy')==='false' && results.querySelectorAll('[role="option"]').length>0 && document.querySelector('.search-popover [role="status"]')?.textContent.includes('MATCHES') && performance.now();
  },query);
  result.backend=await page.locator('[data-search-backend]').getAttribute('data-search-backend');
  result.resultCount=await page.locator('.search-results [role="option"]').count();
  return result;
 });
 if(measure)row.finalTimings=await page.evaluate(timingReport);
 return row;
}
try {
 for(const dataset of datasets)for(let repetition=1;repetition<=runs;repetition++) {
  const context=await browser.newContext({viewport:report.environment.viewport,deviceScaleFactor:1,serviceWorkers:'block'});
  context.setDefaultTimeout(timeout);
  await context.addInitScript(installProbe);
  const page=await context.newPage();
  const external=[];
  page.on('request',request=>{const url=request.url();if(/^https?:/.test(url)&&!url.startsWith(`${server.origin}/`))external.push(url);});
  const cdp=await context.newCDPSession(page);
  await cdp.send('Network.enable');await cdp.send('Emulation.setCPUThrottlingRate',{rate});
  const route=dataset==='published'?'/r/source-for/atlas':`/?fixture=${dataset==='golden'?'okie':'stress'}`;
  const url=`${server.origin}${route}${route.includes('?')?'&':'?'}perf=1&backend=${requestedBackend}`;
  for(const cache of ['cold','warm']) {
   const row={dataset,cache,repetition};const violationsBefore=server.violations.length;
   try {
    if(cache==='cold'){await cdp.send('Network.clearBrowserCache');await cdp.send('Network.setCacheDisabled',{cacheDisabled:true});}
    else {await cdp.send('Network.setCacheDisabled',{cacheDisabled:false});const prime=await journey(page,dataset,url,false);assertWarmPrime(prime);if(external.length||server.violations.length>violationsBefore)throw new Error('Warm priming made external or uncaptured requests.');}
    Object.assign(row,await journey(page,dataset,url));
    if(external.length||server.violations.length>violationsBefore)throw new Error('External or uncaptured request detected; see local raw report.');
   }catch(error){row.error=error.message;row.failureState=await page.evaluate(()=>({title:document.title,probeReady:window.__okieBenchmark?.inspectorReadyMs,backend:document.querySelector('[data-testid="renderer-status"]')?.dataset.activeBackend,app:document.querySelector('[data-testid="atlas-app"]')?.dataset,inspectorTitle:document.querySelector('#inspector-entity-title')?.textContent,overview:document.querySelector('[data-contextual-overview]')?.dataset,body:document.body.innerText.slice(0,2000)})).catch(()=>({unavailable:true}));}
   report.rows.push(row);console.log(`${dataset} ${cache} ${repetition}/${runs}: ${row.error??(row.failures?.length?`failed ${row.failures.join(',')}`:`usable ${Math.round(row.metrics.usableAtlasMs.durationMs)}ms`)}`);
   await mkdir(dirname(output),{recursive:true});await writeFile(output,`${JSON.stringify(report,null,2)}\n`);
  }
  await context.close();
 }
} finally {await browser.close();await server.close();}
report.finishedAt=new Date().toISOString();
report.summary=summarizeRows(report.rows,datasets);
await writeFile(output,`${JSON.stringify(report,null,2)}\n`);
const table=['| Dataset | Cache | Metric | Successful / N | Failures | Unsupported | Median ms | p95 ms |','| --- | --- | --- | --- | --- | --- | --- | --- |',...report.summary.map(s=>`| ${s.dataset} | ${s.cache} | ${s.metric} | ${s.successful} / ${s.requested} | ${s.failed} | ${s.unsupported} | ${s.medianMs?.toFixed(1)??'—'} | ${s.p95Ms?.toFixed(1)??'—'} |`)];
await writeFile(output.replace(/\.json$/, '')+'.md',`${table.join('\n')}\n`);
console.log(`Raw local report: ${output}`);
if(report.rows.some(row=>row.error||row.failures?.length)||server.violations.length)process.exitCode=1;
