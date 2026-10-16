import { Container } from '@cloudflare/containers';
import type { EdgeEnv } from './env';
import { STORE_HOST, atlasStoreOutbound } from './store';

/**
 * The read-only Ask / block-plan API (apps/server built from apps/server/Dockerfile) as a Cloudflare
 * Container (CLA-266). The server mirrors published atlases from `http://atlas-store.internal/<key>`,
 * which never leaves Cloudflare: the outbound handler below answers it straight from the Worker's R2
 * binding (public AND private objects under `atlas/v1/`, GET/HEAD only). Everything else egresses
 * normally (the LLM / Jev providers).
 */

/** Runtime env for the container, built from the Worker env; secrets only when set. */
export function containerEnvVars(env: Partial<EdgeEnv>): Record<string, string> {
  const vars: Record<string, string> = {
    OKIE_SERVER_MODE: 'public-readonly',
    OKIE_SERVER_HOST: '0.0.0.0',
    OKIE_SERVER_PORT: '8080',
    OKIE_TRUSTED_PROXY: 'cloudflare',
    OKIE_PUBLISHED_STORE_URL: `http://${STORE_HOST}`,
    // Chat uses OpenRouter; the optional Jev Overview planner stays off.
    OKIE_JEV_BLOCK_PLANNER: '0',
    // CLA-606: the server sends nothing to an LLM without an explicit provider opt-in; OKIE_LLM_API_KEY is the key.
    OKIE_LLM_PROVIDER: 'openrouter',
  };
  for (const name of ['OKIE_LLM_API_KEY', 'JEV_API', 'OKIE_LLM_MODEL', 'OKIE_ASK_PER_IP_WINDOW'] as const) {
    const value = env[name];
    if (typeof value === 'string' && value !== '') vars[name] = value;
  }
  return vars;
}

/** SHA-256 of the env a container would start with. Stored to tell a changed secret; never the values. */
export async function containerEnvFingerprint(vars: Record<string, string>): Promise<string> {
  const text = JSON.stringify(Object.entries(vars).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

const ENV_FINGERPRINT_KEY = 'okie:container-env-fingerprint';
/** The whole env check, and the wait for a destroyed container to report stopped. */
export const ENV_CHECK_TIMEOUT_MS = 10_000;
const STOPPED_POLL_MS = 50;

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export class AtlasApiContainer extends Container<EdgeEnv> {
  override defaultPort = 8080;
  override sleepAfter = '10m';
  override enableInternet = true;
  /** Settles (never rejects) once the constructor has checked the running container's env (CLA-483). */
  readonly envCheck: Promise<void>;
  /** The running container may still hold an old env: do not record the current one for it. */
  private envUnverified = false;

  constructor(ctx: ConstructorParameters<typeof Container<EdgeEnv>>[0], env: EdgeEnv, timeoutMs = ENV_CHECK_TIMEOUT_MS) {
    super(ctx, env);
    this.envVars = containerEnvVars(env);
    // Bounded: a destroy that hangs must not hold the input gate until the runtime resets this object.
    this.envCheck = ctx.blockConcurrencyWhile(() => Promise.race([
      this.destroyIfEnvChanged(timeoutMs),
      sleep(timeoutMs).then(() => { if (this.ctx.container?.running) this.envUnverified = true; }),
    ])).catch(() => { this.envUnverified = true; });
  }

  /**
   * CLA-483: a container reads its env once, when it starts. A secret put or a deploy with an unchanged image
   * restarts this Durable Object but leaves the container running with the old values (an expired gateway key kept
   * failing Ask). If the running container was started with a different env, destroy it and wait until it reports
   * stopped, so the next request starts it with the current one. A check that fails leaves the container alone and
   * unrecorded, so the next construction tries again.
   */
  private async destroyIfEnvChanged(timeoutMs: number): Promise<void> {
    try {
      const container = this.ctx.container;
      if (!container?.running) return;
      const started = await this.ctx.storage.get<string>(ENV_FINGERPRINT_KEY);
      if (started === await containerEnvFingerprint(this.envVars ?? {})) return;
      this.envUnverified = true;
      await this.destroy();
      // `running` turns false when the runtime's monitor settles, which can be after destroy resolves.
      const deadline = Date.now() + timeoutMs;
      while (container.running && Date.now() < deadline) await sleep(STOPPED_POLL_MS);
      if (!container.running) this.envUnverified = false;
    } catch { this.envUnverified = true; }
  }

  /** Runs on a real start and when the library adopts an already-running container; only the first is recorded. */
  override async onStart(): Promise<void> {
    if (this.envUnverified) return;
    try {
      await this.ctx.storage.put(ENV_FINGERPRINT_KEY, await containerEnvFingerprint(this.envVars ?? {}));
    } catch { /* unrecorded: the next construction restarts the container once */ }
  }
}

// Assigned through the inherited static setter (which registers the handler by class name); a
// `static outboundByHost = …` class field would define an own property and bypass that registry.
AtlasApiContainer.outboundByHost = {
  [STORE_HOST]: (request: Request, env: unknown) => atlasStoreOutbound(request, (env as EdgeEnv).ATLAS_BUCKET),
};
