import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createPowerActionCoordinator,
  formatPowerActionMessage
} from '../src/services/powerActions.js';

test('power outcomes have action-specific Discord messages', () => {
  assert.match(
    formatPowerActionMessage({ status: 'completed', action: 'restart' }),
    /restart completed/i
  );
  assert.match(
    formatPowerActionMessage({ status: 'completed', action: 'start' }),
    /started and is now running/i
  );
  assert.match(
    formatPowerActionMessage({ status: 'accepted_unconfirmed', action: 'restart' }),
    /accepted.*not confirmed/i
  );
  assert.match(
    formatPowerActionMessage({ status: 'failed', action: 'start' }),
    /failed/i
  );
});

test('running instance submits exactly one restart request', async () => {
  let restartCalls = 0;
  let startCalls = 0;
  const executePowerAction = createPowerActionCoordinator({
    getInstance: async () => ({ power_status: 'running' }),
    restartInstance: async () => { restartCalls += 1; },
    startInstance: async () => { startCalls += 1; return true; },
    sleep: async () => {},
    verificationAttempts: 2
  });

  const result = await executePowerAction('instance-1');

  assert.deepEqual(result, { status: 'accepted_unconfirmed', action: 'restart' });
  assert.equal(restartCalls, 1);
  assert.equal(startCalls, 0);
});

test('running instance reports completion only after a reboot transition', async () => {
  const states = ['running', 'stopped', 'running'];
  const executePowerAction = createPowerActionCoordinator({
    getInstance: async () => ({ power_status: states.shift() }),
    restartInstance: async () => {},
    startInstance: async () => true,
    sleep: async () => {},
    verificationAttempts: 3
  });

  assert.deepEqual(
    await executePowerAction('instance-restart'),
    { status: 'completed', action: 'restart' }
  );
});

test('stopped instance starts and reports when running is reached', async () => {
  let restartCalls = 0;
  let startCalls = 0;
  const executePowerAction = createPowerActionCoordinator({
    getInstance: async () => ({ power_status: 'stopped' }),
    restartInstance: async () => { restartCalls += 1; },
    startInstance: async () => { startCalls += 1; return true; }
  });

  const result = await executePowerAction('instance-2');

  assert.deepEqual(result, { status: 'completed', action: 'start' });
  assert.equal(startCalls, 1);
  assert.equal(restartCalls, 0);
});

test('stopped instance reports a bounded verification timeout', async () => {
  const executePowerAction = createPowerActionCoordinator({
    getInstance: async () => ({ power_status: 'stopped' }),
    restartInstance: async () => {},
    startInstance: async () => false
  });

  assert.deepEqual(
    await executePowerAction('instance-3'),
    { status: 'timed_out', action: 'start' }
  );
});

test('duplicate clicks do not submit duplicate provider actions', async () => {
  let startCalls = 0;
  let releaseStart;
  const startPending = new Promise(resolve => { releaseStart = resolve; });
  const executePowerAction = createPowerActionCoordinator({
    getInstance: async () => ({ power_status: 'stopped' }),
    restartInstance: async () => {},
    startInstance: async () => {
      startCalls += 1;
      return startPending;
    }
  });

  const first = executePowerAction('instance-4');
  await new Promise(resolve => setImmediate(resolve));
  const duplicate = await executePowerAction('instance-4');

  assert.deepEqual(duplicate, { status: 'busy' });
  assert.equal(startCalls, 1);
  releaseStart(true);
  assert.deepEqual(await first, { status: 'completed', action: 'start' });
});

test('missing and transitional instances return explicit outcomes', async () => {
  const missing = createPowerActionCoordinator({
    getInstance: async () => null,
    restartInstance: async () => {},
    startInstance: async () => true
  });
  const transitional = createPowerActionCoordinator({
    getInstance: async () => ({ power_status: 'pending' }),
    restartInstance: async () => {},
    startInstance: async () => true
  });

  assert.deepEqual(await missing('missing'), { status: 'not_found' });
  assert.deepEqual(
    await transitional('pending'),
    { status: 'unsupported', powerStatus: 'pending' }
  );
});

test('provider failures are explicit and release the instance lock', async () => {
  let attempts = 0;
  const executePowerAction = createPowerActionCoordinator({
    getInstance: async () => ({ power_status: 'stopped' }),
    restartInstance: async () => {},
    startInstance: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('provider unavailable');
      return true;
    }
  });

  assert.deepEqual(
    await executePowerAction('instance-failure'),
    { status: 'failed', action: 'start' }
  );
  assert.deepEqual(
    await executePowerAction('instance-failure'),
    { status: 'completed', action: 'start' }
  );
});
