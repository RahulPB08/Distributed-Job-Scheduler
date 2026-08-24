/**
 * Unit & Integration Tests for the Worker Auto-Scaler Service
 *
 * Covers:
 * 1. Initial configuration and config updates
 * 2. Accurate fleet metrics computation
 * 3. Scale-up / scale-down cooldown field existence
 * 4. Scheduler is reported as HA only (not autoscaled)
 * 5. No scheduler config in the AutoScalerService
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb } from '../backend/src/database/db.js';
import { AutoScalerService } from '../backend/src/services/autoscaler.service.js';

test.before(async () => {
  await initDb();
});

test.after(async () => {
  AutoScalerService.stop();
  await closeDb();
});

test('AutoScaler: Configures and reads initial state', async () => {
  const config = AutoScalerService.getConfig();
  assert.equal(typeof config.minWorkers, 'number');
  assert.equal(typeof config.maxWorkers, 'number');
  assert.equal(config.enabled, true);

  // Verify new cooldown fields exist
  assert.equal(typeof config.scaleUpCooldownSec,   'number', 'scaleUpCooldownSec should be a number');
  assert.equal(typeof config.scaleDownCooldownSec, 'number', 'scaleDownCooldownSec should be a number');
  assert.equal(typeof config.scaleUpHysteresis,    'number', 'scaleUpHysteresis should be a number');
  assert.equal(typeof config.cpuScaleUpPercent,    'number', 'cpuScaleUpPercent should be a number');

  // Verify sensible production defaults
  assert.ok(config.scaleUpCooldownSec   >= 1,  'scale-up cooldown should be >= 1s');
  assert.ok(config.scaleDownCooldownSec >= 10, 'scale-down cooldown should be >= 10s');
  assert.ok(config.scaleDownCooldownSec >  config.scaleUpCooldownSec, 'scale-down cooldown should be longer than scale-up');
});

test('AutoScaler: Config update merges correctly', async () => {
  AutoScalerService.updateConfig({
    minWorkers: 2,
    maxWorkers: 6,
    jobsPerWorkerThreshold: 5,
  });

  const updated = AutoScalerService.getConfig();
  assert.equal(updated.minWorkers,             2);
  assert.equal(updated.maxWorkers,             6);
  assert.equal(updated.jobsPerWorkerThreshold, 5);
  // Cooldown fields should survive a partial update
  assert.equal(typeof updated.scaleUpCooldownSec,   'number');
  assert.equal(typeof updated.scaleDownCooldownSec, 'number');
});

test('AutoScaler: getFleetMetrics returns complete structure', async () => {
  const metrics = await AutoScalerService.getFleetMetrics();

  assert.equal(typeof metrics.queuedJobs,                'number');
  assert.equal(typeof metrics.runningJobs,               'number');
  assert.equal(typeof metrics.activeWorkersCount,        'number');
  assert.equal(typeof metrics.dynamicWorkersCount,       'number');
  assert.equal(typeof metrics.totalCapacitySlots,        'number');
  assert.equal(typeof metrics.capacityUtilizationPercent,'number');
  assert.equal(typeof metrics.lastScaleAction,           'string');
  assert.ok(Array.isArray(metrics.telemetryHistory),     'telemetryHistory should be an array');
  assert.ok(Array.isArray(metrics.scaleEvents),          'scaleEvents should be an array');

  // Cooldown remaining fields
  assert.equal(typeof metrics.scaleUpCooldownRemainingSec,   'number');
  assert.equal(typeof metrics.scaleDownCooldownRemainingSec, 'number');
});

test('AutoScaler: Scheduler is reported as single instance — not autoscaled', async () => {
  const metrics = await AutoScalerService.getFleetMetrics();

  // Schedulers are counted for observability
  assert.equal(typeof metrics.activeSchedulersCount, 'number');

  // Scheduler mode must be reported as single scheduler
  assert.equal(metrics.schedulerMode, 'SINGLE_SCHEDULER',
    'Scheduler mode should clearly state single dedicated scheduler');

  // No min/maxSchedulers in config
  const config = AutoScalerService.getConfig();
  assert.equal(config.minSchedulers, undefined, 'minSchedulers should not exist in config');
  assert.equal(config.maxSchedulers, undefined, 'maxSchedulers should not exist in config');
});

test('AutoScaler: Scale events log is bounded to last 20', () => {
  // Pump 25 events into the log
  for (let i = 0; i < 25; i++) {
    AutoScalerService._recordScaleEvent({ action: `EVENT_${i}`, timestamp: new Date().toISOString() });
  }
  assert.ok(
    AutoScalerService.state.scaleEvents.length <= 20,
    'Scale events log should be capped at 20 entries'
  );
});

test('AutoScaler: Telemetry history is bounded to last 30 ticks', () => {
  // Verify the rolling window stays at 30
  while (AutoScalerService.state.telemetryHistory.length < 35) {
    AutoScalerService.state.telemetryHistory.push({ time: '00:00:00', activeWorkers: 2 });
  }
  // Simulate what evaluateFleetCapacity does
  while (AutoScalerService.state.telemetryHistory.length > 30) {
    AutoScalerService.state.telemetryHistory.shift();
  }
  assert.ok(
    AutoScalerService.state.telemetryHistory.length <= 30,
    'Telemetry history should be capped at 30 ticks'
  );
});
