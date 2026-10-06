import assert from 'node:assert/strict';
import test from 'node:test';
import { ProactivityEngine, type ProactiveObservation } from './proactivity.ts';

function observation(overrides: Partial<ProactiveObservation> = {}): ProactiveObservation {
  return {
    capturedAtMs: 1,
    optimizerAvailable: true,
    cpuUtilizationPct: 20,
    gpuUtilizationPct: 90,
    gpuTemperatureC: 70,
    gpuVramUsedGB: 10,
    gpuVramTotalGB: 20,
    performanceState: 'gpu',
    ...overrides,
  };
}

test('sentinel waits for sustained evidence', () => {
  const fakeOptimizer = {
    getTelemetry: async () => ({
      available: true,
      hardware: {
        mode: 'mock',
        os: 'windows',
        cpu: { name: 'cpu', cores: 16, threads: 32, utilizationPct: 20, tempC: 60 },
        gpu: { name: 'gpu', vramGB: 20, utilizationPct: 99, tempC: 90, vramUsedGB: 19, },
        ram: { totalGB: 96, usedGB: 80 },
        notes: [],
        capturedAt: new Date().toISOString(),
      },
      bound: 'gpu',
      notes: [],
    }),
  };

  const notifications = { push: () => ({ id: 'note' }) };
  const events = { emit: () => ({ id: 'evt' }) };

  const engine = new ProactivityEngine(
    fakeOptimizer as never,
    events as never,
    notifications as never,
    { minSamplesForAlert: 3 },
  );

  assert.equal(engine.evaluate(observation({ gpuTemperatureC: 90 })).length, 0);
  assert.equal(engine.evaluate(observation({ gpuTemperatureC: 90 })).length, 0);
  const issues = engine.evaluate(observation({ gpuTemperatureC: 90 }));
  assert.ok(issues.length >= 1);
  assert.ok(issues.some((issue) => issue.id === 'gpu-hot'));

});


test('sentinel rearms only after evidence clears and cooldown permits it', () => {
  let now = 0;
  const engine = new ProactivityEngine(
    { getTelemetry: async () => { throw new Error('unused'); } } as never,
    { emit: () => ({ id: 'evt' }) } as never,
    { push: () => ({ id: 'note' }) } as never,
    { minSamplesForAlert: 2, cooldownMs: 100, maxAlertsPerWindow: 10, now: () => now },
  );

  assert.equal(engine.evaluate(observation({ capturedAtMs: now, gpuTemperatureC: 90 })).length, 0);
  now = 1;
  assert.equal(engine.evaluate(observation({ capturedAtMs: now, gpuTemperatureC: 90 })).length, 1);
  now = 2;
  assert.equal(engine.evaluate(observation({ capturedAtMs: now, gpuTemperatureC: 91 })).length, 0);

  now = 3;
  assert.equal(engine.evaluate(observation({ capturedAtMs: now, gpuTemperatureC: 70 })).length, 0);

  now = 50;
  assert.equal(engine.evaluate(observation({ capturedAtMs: now, gpuTemperatureC: 90 })).length, 0);
  now = 150;
  assert.equal(engine.evaluate(observation({ capturedAtMs: now, gpuTemperatureC: 90 })).length, 0);
  now = 151;
  assert.equal(engine.evaluate(observation({ capturedAtMs: now, gpuTemperatureC: 90 })).length, 1);
});

test('sentinel applies a global alert budget across issue types', () => {
  let now = 0;
  const engine = new ProactivityEngine(
    { getTelemetry: async () => { throw new Error('unused'); } } as never,
    { emit: () => ({ id: 'evt' }) } as never,
    { push: () => ({ id: 'note' }) } as never,
    { minSamplesForAlert: 1, maxAlertsPerWindow: 1, rateLimitWindowMs: 1000, cooldownMs: 0, now: () => now },
  );

  assert.equal(engine.evaluate(observation({ capturedAtMs: now, gpuTemperatureC: 90 })).length, 1);
  now = 1;
  assert.equal(engine.evaluate(observation({ capturedAtMs: now, gpuTemperatureC: 75, gpuUtilizationPct: 99 })).length, 0);
});
