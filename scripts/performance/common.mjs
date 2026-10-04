import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const pinPath = resolve(repoRoot, 'fixtures/performance/published-large.pin.json');
export const dataRoot = resolve(repoRoot, 'fixtures/performance/data');
export const sha256 = data => createHash('sha256').update(data).digest('hex');
export function arg(name, fallback) { const index = process.argv.indexOf(`--${name}`); return index < 0 ? fallback : process.argv[index + 1]; }
export function percentile(values, p) { const ordered = values.filter(Number.isFinite).sort((a,b) => a-b); return ordered.length ? ordered[Math.max(0, Math.ceil(p*ordered.length)-1)] : null; }
export async function readPin() {
  const pin = JSON.parse(await readFile(pinPath, 'utf8'));
  const responses = new Map();
  for (const entry of pin.responses) {
    const body = await readFile(resolve(dataRoot, entry.file));
    if (sha256(body) !== entry.sha256 || body.length !== entry.bytes) throw new Error(`Pinned data mismatch: ${entry.file}. Run pnpm perf:acquire.`);
    responses.set(entry.key, { ...entry, body });
  }
  return { pin, responses };
}
export const PERFORMANCE_METRICS = ['firstDrawMs','usableAtlasMs','maxLongTaskBeforeDrawMs','levelMs','childMs','storyStartMs','storyStep3Ms','searchMs'];
const stressOnlyUnsupported = new Set(['childMs','storyStartMs','storyStep3Ms']);
const validMetric = metric => metric?.status === 'ok' && Number.isFinite(metric.durationMs) && metric.durationMs >= 0;
export function assertWarmPrime(row) {
  if (row.error || row.failures?.length) throw new Error(`Warm priming failed: ${row.error ?? row.failures.join(', ')}`);
  for (const name of PERFORMANCE_METRICS) {
    const metric = row.metrics?.[name];
    if (validMetric(metric)) continue;
    if (metric?.status === 'unsupported' && (name === 'maxLongTaskBeforeDrawMs' || (row.dataset === 'stress' && stressOnlyUnsupported.has(name)))) continue;
    throw new Error(`Warm priming failed: missing or invalid ${name}`);
  }
}
export function summarizeRows(rows, datasets) {
  const summary = [];
  for (const dataset of datasets) for (const cache of ['cold','warm']) for (const metric of PERFORMANCE_METRICS) {
    const group = rows.filter(row => row.dataset === dataset && row.cache === cache);
    const values = group.flatMap(row => !row.error && validMetric(row.metrics?.[metric]) ? [row.metrics[metric].durationMs] : []);
    const unsupported = group.filter(row => !row.error && row.metrics?.[metric]?.status === 'unsupported').length;
    summary.push({ dataset,cache,metric,requested:group.length,successful:values.length,failed:group.length-values.length-unsupported,unsupported,medianMs:percentile(values,0.5),p95Ms:percentile(values,0.95) });
  }
  return summary;
}
