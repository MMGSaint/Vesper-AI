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
