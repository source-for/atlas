import test from 'node:test';
import assert from 'node:assert/strict';
import { PERFORMANCE_METRICS, assertWarmPrime, summarizeRows, actionDuration } from './common.mjs';

const metric = durationMs => ({ status: 'ok', durationMs });
const row = (overrides = {}) => ({ dataset: 'golden', cache: 'cold', failures: [], metrics: Object.fromEntries(PERFORMANCE_METRICS.map(name => [name, metric(10)])), ...overrides });
const summaryFor = (rows, name = 'firstDrawMs', dataset = 'golden') => summarizeRows(rows, [dataset]).find(item => item.cache === 'cold' && item.metric === name);

test('invalid runs never improve percentiles and are counted once as failures', () => {
  const result = summaryFor([
    row(),
    row({ error: 'unexpected request', metrics: { firstDrawMs: metric(1) } }),
    row({ metrics: { firstDrawMs: { status: 'failed' } } }),
    row({ metrics: { firstDrawMs: { status: 'unsupported' } } }),
  ]);
  assert.deepEqual(result, { dataset: 'golden', cache: 'cold', metric: 'firstDrawMs', requested: 4, successful: 1, failed: 2, unsupported: 1, medianMs: 10, p95Ms: 10 });
  const invalidUnsupported = summaryFor([row({ error: 'uncaptured request', metrics: { firstDrawMs: { status: 'unsupported' } } })]);
  assert.equal(invalidUnsupported.failed, 1);
  assert.equal(invalidUnsupported.unsupported, 0);
  assert.equal(invalidUnsupported.medianMs, null);
});

test('ten repetitions use nearest rank percentiles and keep cache/dataset groups separate', () => {
  const rows = Array.from({ length: 10 }, (_, index) => row({ metrics: { firstDrawMs: metric(index + 1) } }));
  rows.push(row({ cache: 'warm', metrics: { firstDrawMs: metric(1000) } }), row({ dataset: 'stress', metrics: { firstDrawMs: metric(2000) } }));
  const result = summaryFor(rows);
  assert.equal(result.requested, 10);
  assert.equal(result.successful, 10);
  assert.equal(result.medianMs, 5);
  assert.equal(result.p95Ms, 10);
});

test('nonfinite, negative, and missing observations count as failed samples', () => {
  const result = summaryFor([NaN, Infinity, -1].map(duration => row({ metrics: { firstDrawMs: metric(duration) } })).concat(row({ metrics: {} })));
  assert.equal(result.successful, 0);
  assert.equal(result.failed, 4);
  assert.equal(result.p95Ms, null);
});

test('warm prime rejects invalid traffic, step failures, and incomplete observations', () => {
  assert.doesNotThrow(() => assertWarmPrime(row()));
  assert.throws(() => assertWarmPrime(row({ error: 'unexpected request' })), /Warm priming failed/);
  assert.throws(() => assertWarmPrime(row({ failures: ['search failed'] })), /Warm priming failed/);
  for (const invalid of [undefined, { status: 'failed' }, metric(NaN), metric(-1)]) {
    assert.throws(() => assertWarmPrime(row({ metrics: { ...row().metrics, searchMs: invalid } })), /searchMs/);
  }
});

test('warm prime accepts only explicitly supported unsupported cases', () => {
  const stress = row({ dataset: 'stress' });
  for (const name of ['childMs', 'storyStartMs', 'storyStep3Ms', 'maxLongTaskBeforeDrawMs']) stress.metrics[name] = { status: 'unsupported' };
  assert.doesNotThrow(() => assertWarmPrime(stress));
  assert.doesNotThrow(() => assertWarmPrime(row({ metrics: { ...row().metrics, maxLongTaskBeforeDrawMs: { status: 'unsupported' } } })));
  assert.throws(() => assertWarmPrime(row({ metrics: { ...row().metrics, levelMs: { status: 'unsupported' } } })), /levelMs/);
  assert.throws(() => assertWarmPrime({ ...stress, metrics: { ...stress.metrics, levelMs: { status: 'unsupported' } } }), /levelMs/);
  assert.throws(() => assertWarmPrime({ ...stress, metrics: { ...stress.metrics, searchMs: { status: 'unsupported' } } }), /searchMs/);
});

test('action timing rejects absent or coerced event clocks rather than returning plausible durations', () => {
  assert.equal(actionDuration(125.5, 150), 24.5);
  assert.equal(actionDuration(0, 0), 0);
  for (const start of [null, undefined, '125.5', NaN, Infinity, -1]) assert.throws(() => actionDuration(start, 150), /start event timestamp/);
  for (const end of [null, undefined, '150', NaN, Infinity, 124]) assert.throws(() => actionDuration(125, end), /completion timestamp/);
});
