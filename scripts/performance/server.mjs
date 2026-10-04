import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { repoRoot, readPin, sha256 } from './common.mjs';
const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css', '.json':'application/json', '.wasm':'application/wasm', '.woff2':'font/woff2', '.svg':'image/svg+xml', '.png':'image/png', '.ico':'image/x-icon' };
export async function serveBuild(port = 0, dist = resolve(repoRoot, 'apps/web/dist')) {
  await stat(resolve(dist,'index.html'));
  const { pin, responses } = await readPin();
  const violations = [];
  const assets = new Map();
  const server = createServer(async (request,response) => {
    const url = new URL(request.url,'http://127.0.0.1');
    let body, status = 200, contentType, cacheControl;
    try {
      if (request.method !== 'GET' && request.method !== 'HEAD') throw new Error('Only read-only requests are served.');
      if (url.pathname === '/api/auth/me') {
        body = Buffer.from(JSON.stringify({ mode:'public', ask:false, connected:false }));
        contentType = 'application/json'; cacheControl = 'no-store';
      } else if (url.pathname === '/scan/index.json') {
        const entry = responses.get('index.json');body=entry.body;status=entry.status;contentType='application/json';cacheControl='public, max-age=60';
      } else if (url.pathname.startsWith('/scan/')) {
        const basename = url.pathname.split('/').at(-1);
        if (url.pathname !== `/scan/${pin.slug}/${basename}`) throw new Error('Unpinned slug requested.');
        const version = url.searchParams.get('version');
        if (version !== pin.publication.versionId && !(basename === 'neighborhood.json' && version === null)) throw new Error('Unpinned version requested.');
        const parameter = basename === 'neighborhood.json' ? 'focus' : basename === 'excerpt.json' ? 'entity' : undefined;
        const value = parameter ? url.searchParams.get(parameter) : undefined;
        const key = `${basename}${value ? `?${new URLSearchParams({ [parameter]: value })}` : ''}`;
        const entry = responses.get(key);
        if (!entry) throw new Error(`Uncaptured endpoint: ${key}`);
        body = entry.body; status = entry.status; contentType='application/json'; cacheControl=version ? 'public, max-age=31536000, immutable' : 'public, max-age=60';
      } else if (url.pathname.startsWith('/api/')) throw new Error('Live API calls are disabled.');
      else {
        const pathname = decodeURIComponent(url.pathname);
        const path = pathname === '/' || pathname === '/new' || pathname.startsWith('/r/') ? resolve(dist,'index.html') : resolve(dist, `.${pathname}`);
        if (!path.startsWith(`${dist}${sep}`)) throw new Error('Invalid static path.');
        if(!assets.has(path)) assets.set(path,await readFile(path));
        body=assets.get(path); contentType=types[extname(path)]??'application/octet-stream';
        cacheControl=extname(path)==='.html'?'no-cache':'public, max-age=31536000, immutable';
      }
      const etag = `"${sha256(body)}"`;
      const headers = { 'content-type':contentType,'cache-control':cacheControl,etag,
        'x-content-type-options':'nosniff','referrer-policy':'strict-origin-when-cross-origin',
        'permissions-policy':'tools=(self)', 'origin-agent-cluster':'?1',
      };
      if(contentType.startsWith('text/html')) headers['content-security-policy']="default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'self'";
      if(request.headers['if-none-match']===etag && status===200){ response.writeHead(304,headers);response.end();return; }
      response.writeHead(status,headers);response.end(request.method==='HEAD'?undefined:body);
    } catch(error) {
      violations.push({ path:url.pathname, query:url.search, error:error.message });
      response.writeHead(404,{'content-type':'application/json','cache-control':'no-store'});response.end(JSON.stringify({error:'Unserved benchmark request'}));
    }
  });
  await new Promise((done,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',done);});
  return { origin:`http://127.0.0.1:${server.address().port}`,pin,violations,close:()=>new Promise(done=>server.close(done)) };
}
