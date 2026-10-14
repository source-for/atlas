// Synthetic scanner-to-inspector QA data. Never publishes or rescans a user repository.
import { buildScanArtifacts, stableJson } from '../../../packages/scan/dist/scan.js';
import { mkdirSync, writeFileSync } from 'node:fs';
const files={
 'README.md':'# Inspector QA\nDeterministic synthetic acceptance data, not a real published repository.\n',
 'package.json':JSON.stringify({name:'inspector-qa',exports:'./src/index.ts',bin:'./src/cli.ts'}),
 'src/index.ts':"export { publicApi } from './api.js';\n",
 'src/api.ts':"export function publicApi(value: number) { return internalHelper(value); }\nexport function internalHelper(value: number) { return value + 1; }\nfunction recurse(value: number): number { return value ? recurse(value - 1) : 0; }\n"+Array.from({length:7},(_,i)=>`export function extra${i}(value: number) { return internalHelper(value + ${i}); }`).join('\n'),
 'src/cli.ts':"import { publicApi } from './index.js';\npublicApi(1);\nexport function neverCalled() { return 7; }\n",
};
const sourceFiles=Object.keys(files).filter(x=>x.endsWith('.ts')).sort();
const discovery={sourceFiles,units:[{kind:'root',dir:'inspector-qa',name:'inspector-qa',packageName:'inspector-qa',packageManifest:'package.json',evidencePath:'package.json'}],unitByFile:new Map(sourceFiles.map(f=>[f,'inspector-qa'])),unitByPackageName:new Map([['inspector-qa','inspector-qa']]),summary:{singlePackage:true,includedJs:false,skippedJsFiles:0,skippedMembers:[]}};
const readFile=p=>{if(!(p in files))throw new Error('Missing fixture file '+p);return files[p]};
const a=buildScanArtifacts({discovery,pin:{commitSha:'1'.repeat(40),treeHash:'2'.repeat(40),generatedAt:'2026-09-12T00:00:00.000Z'},readFile,repositorySlug:'qa-inspector',systemName:'Inspector QA'});
const out='/tmp/okie-inspector-team/exposure-scan/qa__inspector';mkdirSync(out,{recursive:true});
for(const [name,data] of Object.entries({extraction:a.extraction,snapshot:a.snapshot,view:a.view,story:a.story,stories:a.catalog,scene:a.scene,timeline:a.timeline}))writeFileSync(`${out}/${name}.json`,stableJson(data));
writeFileSync('/tmp/okie-inspector-team/exposure-inputs.json',JSON.stringify(files,null,2));
console.log(JSON.stringify(a.snapshot.entities.filter(e=>e.kind==='code'||e.exposure).map(e=>({id:e.id,name:e.name,exposure:e.exposure?.map(x=>x.kind)})),null,2));
