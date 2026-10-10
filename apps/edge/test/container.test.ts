import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { AtlasApiContainer, containerEnvFingerprint, containerEnvVars } from '../src/container';
import { CONTAINER_INSTANCE_NAME, CONTAINER_ORIGIN, devBackendOrigin, selectBackend } from '../src/backend';
import { STORE_HOST, atlasStoreOutbound } from '../src/store';
import { edgeEnv, edgeFetch, seedAtlas } from './helpers';

describe('AtlasApiContainer', () => {
  it('runs the server read-only on 8080, sleeping after 10 minutes, env built from the Worker env', async () => {
    // Miniflare has no container runtime here, so construct the class against a real Durable Object
    // state (a throwaway AtlasBudget instance) with a stand-in `ctx.container`.
    const stub = edgeEnv.ATLAS_BUDGET!.getByName('container-constructor-probe');
    await runInDurableObject(stub, async (_budget, state) => {
      Object.defineProperty(state, 'container', { value: { running: false }, configurable: true });
      const ctx = state;
      const instance = new AtlasApiContainer(ctx as never, edgeEnv);
      expect(instance.defaultPort).toBe(8080);
      expect(instance.sleepAfter).toBe('10m');
      expect(instance.enableInternet).toBe(true);
      expect(instance.envVars).toEqual(containerEnvVars(edgeEnv));
      expect(instance.envVars).toMatchObject({ OKIE_SERVER_MODE: 'public-readonly', OKIE_PUBLISHED_STORE_URL: 'http://atlas-store.internal' });
      await instance.applyOutboundInterceptionPromise;
      await state.storage.deleteAlarm();
    });
  });

  it('destroys a running container that was started with a different env, and only then (CLA-483)', async () => {
    const stub = edgeEnv.ATLAS_BUDGET!.getByName('container-env-restart-probe');
    await runInDurableObject(stub, async (_budget, state) => {
      let destroyed = 0;
      const container = { running: true, monitor: () => new Promise<void>(() => undefined), destroy: async () => { destroyed += 1; container.running = false; }, interceptOutboundHttp: async () => undefined, interceptAllOutboundHttp: async () => undefined };
      Object.defineProperty(state, 'container', { value: container, configurable: true });
      const build = async (env: typeof edgeEnv) => {
        const instance = new AtlasApiContainer(state as never, env);
        await instance.envCheck;
        await Promise.resolve(instance.applyOutboundInterceptionPromise).catch(() => undefined);
        return instance;
      };
      const oldEnv = { ...edgeEnv, OKIE_LLM_API_KEY: 'old-key' };
      // Running with no record of what it started with (the deploy that adds this check): restart once.
      const first = await build(oldEnv);
      expect(destroyed).toBe(1);
      // It starts again and records its env; a Durable Object restart with the same env leaves it running.
      container.running = true;
      await first.onStart();
      await build(oldEnv);
      expect(destroyed).toBe(1);
      // A rotated key: the running container is destroyed so the next request starts it with the new one.
      await build({ ...edgeEnv, OKIE_LLM_API_KEY: 'new-key' });
      expect(destroyed).toBe(2);
      // Not running: nothing to do.
      await build({ ...edgeEnv, OKIE_LLM_API_KEY: 'newer-key' });
      expect(destroyed).toBe(2);
      // A failing check never throws out of the constructor.
      container.running = true;
      container.destroy = async () => { throw new Error('no runtime'); };
      await build({ ...edgeEnv, OKIE_LLM_API_KEY: 'another-key' });
      // The stored value is a digest, never the key.
      const stored = [...(await state.storage.list<string>()).values()].filter(value => typeof value === 'string').join(' ');
      expect(stored).not.toContain('old-key');
      expect(stored).toContain(await containerEnvFingerprint(containerEnvVars(oldEnv)));
      await state.storage.deleteAlarm();
    });
  });

  it('fingerprints the env independent of key order and changes with any value', async () => {
    const a = await containerEnvFingerprint({ A: '1', B: '2' });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await containerEnvFingerprint({ B: '2', A: '1' })).toBe(a);
    expect(await containerEnvFingerprint({ A: '1', B: '3' })).not.toBe(a);
    expect(await containerEnvFingerprint({ A: '1' })).not.toBe(a);
  });

  it('builds container env vars from the Worker env, forwarding secrets only when set', () => {
    expect(containerEnvVars({})).toEqual({
      OKIE_SERVER_MODE: 'public-readonly',
      OKIE_SERVER_HOST: '0.0.0.0',
      OKIE_SERVER_PORT: '8080',
      OKIE_TRUSTED_PROXY: 'cloudflare',
      OKIE_PUBLISHED_STORE_URL: 'http://atlas-store.internal',
      OKIE_JEV_BLOCK_PLANNER: '0',
    });
    const vars = containerEnvVars({
      OKIE_LLM_API_KEY: 'k',
      JEV_API: 'j',
      OKIE_LLM_MODEL: 'm',
      OKIE_JEV_BLOCK_PLANNER: '1',
      OKIE_ASK_PER_IP_WINDOW: '20',
      DEV_BACKEND_ORIGIN: 'http://127.0.0.1:4195',
      TURNSTILE_SECRET_KEY: 'never-forwarded',
      OKIE_PUBLIC_ORIGIN: 'https://sourcefor.dev',
    });
    expect(vars).toMatchObject({ OKIE_LLM_API_KEY: 'k', JEV_API: 'j', OKIE_LLM_MODEL: 'm', OKIE_JEV_BLOCK_PLANNER: '0', OKIE_ASK_PER_IP_WINDOW: '20' });
    expect(Object.keys(vars)).not.toContain('DEV_BACKEND_ORIGIN');
    expect(Object.keys(vars)).not.toContain('TURNSTILE_SECRET_KEY');
    expect(containerEnvVars({ OKIE_LLM_API_KEY: '' })).not.toHaveProperty('OKIE_LLM_API_KEY');
  });

  it('registers the atlas-store.internal outbound handler (public AND private, GET/HEAD only)', async () => {
    const handlers = AtlasApiContainer.outboundByHost;
    expect(Object.keys(handlers ?? {})).toEqual([STORE_HOST]);
    await seedAtlas({ slug: 'acme__mirror', versionId: 'v1', files: { 'snapshot.json': '{"s":1}' }, privateFiles: { 'operator-explanations.json': '{"private":true}' } });
    const handler = handlers![STORE_HOST]!;
    const ctx = { containerId: 'x', className: 'AtlasApiContainer' };
    const priv = await handler(new Request(`http://${STORE_HOST}/atlas/v1/repos/acme__mirror/versions/v1/private/operator-explanations.json`), edgeEnv, ctx);
    expect(priv.status).toBe(200);
    expect(await priv.text()).toBe('{"private":true}');
    const pub = await handler(new Request(`http://${STORE_HOST}/atlas/v1/repos/acme__mirror/latest.json`), edgeEnv, ctx);
    expect(await pub.json()).toMatchObject({ versionId: 'v1' });
    const head = await handler(new Request(`http://${STORE_HOST}/atlas/v1/repos/acme__mirror/versions/v1/public/snapshot.json`, { method: 'HEAD' }), edgeEnv, ctx);
    expect(head.headers.get('content-length')).toBe('7');
    const ranged = await atlasStoreOutbound(new Request(`http://${STORE_HOST}/atlas/v1/repos/acme__mirror/versions/v1/public/snapshot.json`, { headers: { range: 'bytes=1-3' } }), edgeEnv.ATLAS_BUCKET);
    expect(ranged.status).toBe(206);
    expect(await ranged.text()).toBe('"s"');
    expect(ranged.headers.get('content-range')).toBe('bytes 1-3/7');
    await edgeEnv.ATLAS_BUCKET.put('other/secret.txt', 'nope');
    for (const path of ['/other/secret.txt', '/atlas/v1/../other/secret.txt', '/atlas/v1/repos/acme__mirror/missing.json', '/atlas/v1/']) {
      expect((await atlasStoreOutbound(new Request(`http://${STORE_HOST}${path}`), edgeEnv.ATLAS_BUCKET)).status, path).toBe(404);
    }
    const put = await atlasStoreOutbound(new Request(`http://${STORE_HOST}/atlas/v1/index.json`, { method: 'PUT', body: 'x' }), edgeEnv.ATLAS_BUCKET);
    expect(put.status).toBe(405);
  });

  it('routes all container traffic to one named instance unless DEV_BACKEND_ORIGIN is set', () => {
    expect(CONTAINER_INSTANCE_NAME).toBe('atlas-api');
    expect(selectBackend({ ...edgeEnv, DEV_BACKEND_ORIGIN: undefined })?.origin).toBe(CONTAINER_ORIGIN);
    expect(selectBackend({ ...edgeEnv, DEV_BACKEND_ORIGIN: 'http://127.0.0.1:4195/' })?.origin).toBe('http://127.0.0.1:4195');
    // Browse-only staging/production bind no container: no backend at all.
    expect(selectBackend({ ...edgeEnv, ATLAS_API: undefined, DEV_BACKEND_ORIGIN: undefined })).toBeUndefined();
    expect(devBackendOrigin({ DEV_BACKEND_ORIGIN: 'file:///etc/passwd' })).toBeUndefined();
    expect(devBackendOrigin({ DEV_BACKEND_ORIGIN: '' })).toBeUndefined();
  });
  it('reports a sleeping container without forwarding a request or starting it', async () => {
    let fetches = 0;
    let stateReads = 0;
    let status = 'stopped';
    const namespace = { getByName: (name: string) => {
      expect(name).toBe(CONTAINER_INSTANCE_NAME);
      return {
        getState: async () => { stateReads++; return { status, lastChange: 0 }; },
        fetch: async () => { fetches++; return new Response(); },
      };
    } };
    const backend = selectBackend({ ...edgeEnv, ATLAS_API: namespace as never });
    expect(await backend!.warmingUp!()).toBe(true);
    status = 'healthy';
    expect(await backend!.warmingUp!()).toBe(false);
    status = 'running';
    expect(await backend!.warmingUp!()).toBe(true);
    expect(stateReads).toBe(3);
    expect(fetches).toBe(0);
  });

});

describe('DEV_* gates', () => {
  it('is unset in the test env (which is wrangler.jsonc)', () => {
    expect(edgeEnv.DEV_BACKEND_ORIGIN).toBeUndefined();
    expect(edgeEnv.DEV_STORE_ROUTE).toBeUndefined();
  });

  it('keeps /__store closed unless DEV_STORE_ROUTE=1', async () => {
    await seedAtlas({ slug: 'acme__devstore', versionId: 'v1', privateFiles: { 'operator-explanations.json': '{"private":true}' } });
    const path = '/__store/atlas/v1/repos/acme__devstore/versions/v1/private/operator-explanations.json';
    const closed = await edgeFetch(path);
    expect(closed.status).toBe(404);
    expect(await closed.json()).toEqual({ error: 'not found' });
    expect((await edgeFetch(path, { env: { DEV_STORE_ROUTE: 'true' } })).status).toBe(404);
    const open = await edgeFetch(path, { env: { DEV_STORE_ROUTE: '1' } });
    expect(open.status).toBe(200);
    expect(await open.text()).toBe('{"private":true}');
  });
});
