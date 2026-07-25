import test from 'node:test';
import assert from 'node:assert/strict';

import {
  shouldInitializeSelfDestructTimer,
  submitSelfDestructDeletion,
  submitUnlockedDeletion
} from '../src/services/serverDeletionGuard.js';

function guardedBy(isLocked) {
  return async (instanceId, action) => {
    if (isLocked(instanceId)) return { submitted: false, locked: true };
    await action();
    return { submitted: true, locked: false };
  };
}

test('submitUnlockedDeletion refuses a locked instance without invoking the provider', async () => {
  let deleteCalls = 0;

  const result = await submitUnlockedDeletion({
    instanceId: 'locked-instance',
    isLocked: () => true,
    deleteInstance: async () => { deleteCalls += 1; },
    runUnlocked: guardedBy(() => true)
  });

  assert.deepEqual(result, { submitted: false, locked: true });
  assert.equal(deleteCalls, 0);
});

test('submitUnlockedDeletion invokes the provider once for an unlocked instance', async () => {
  const deleted = [];

  const result = await submitUnlockedDeletion({
    instanceId: 'open-instance',
    isLocked: () => false,
    deleteInstance: async instanceId => { deleted.push(instanceId); },
    runUnlocked: guardedBy(() => false)
  });

  assert.deepEqual(result, { submitted: true, locked: false });
  assert.deepEqual(deleted, ['open-instance']);
});

test('submitUnlockedDeletion fails closed when lock state cannot be read', async () => {
  let deleteCalls = 0;

  await assert.rejects(
    submitUnlockedDeletion({
      instanceId: 'unknown-instance',
      isLocked: () => { throw new Error('corrupt registry'); },
      deleteInstance: async () => { deleteCalls += 1; },
      runUnlocked: async () => { throw new Error('corrupt registry'); }
    }),
    /corrupt registry/
  );

  assert.equal(deleteCalls, 0);
});

test('submitUnlockedDeletion rejects callers without a serialized guard', async () => {
  await assert.rejects(
    submitUnlockedDeletion({
      instanceId: 'unguarded-instance',
      deleteInstance: async () => {}
    }),
    /runUnlocked.*required/
  );
});

test('locked self-destruct expiration cancels its timer without provider deletion', async () => {
  const tracked = {
    id: 'locked-instance',
    status: 'running',
    selfDestructTimer: { expiresAt: 1 }
  };
  const updates = [];
  let deleteCalls = 0;

  const result = await submitSelfDestructDeletion({
    tracked,
    isLocked: () => true,
    deleteInstance: async () => { deleteCalls += 1; },
    runUnlocked: guardedBy(() => true),
    state: {
      updateInstance: (...args) => { updates.push(args); }
    }
  });

  assert.deepEqual(result, { submitted: false, locked: true });
  assert.equal(deleteCalls, 0);
  assert.deepEqual(updates, [[
    'locked-instance',
    'running',
    { selfDestructTimer: null }
  ]]);
});

test('unlocked self-destruct expiration submits provider deletion', async () => {
  const deleted = [];
  const updates = [];

  const result = await submitSelfDestructDeletion({
    tracked: { id: 'open-instance', status: 'running' },
    isLocked: () => false,
    deleteInstance: async instanceId => { deleted.push(instanceId); },
    runUnlocked: guardedBy(() => false),
    state: {
      updateInstance: (...args) => { updates.push(args); }
    }
  });

  assert.deepEqual(result, { submitted: true, locked: false });
  assert.deepEqual(deleted, ['open-instance']);
  assert.deepEqual(updates, []);
});

test('locked instances cannot acquire a new self-destruct timer after provisioning', () => {
  const tracked = { id: 'provisioning-instance', selfDestructTimer: null };

  assert.equal(shouldInitializeSelfDestructTimer({
    tracked,
    isLocked: () => true
  }), false);
  assert.equal(shouldInitializeSelfDestructTimer({
    tracked,
    isLocked: () => false
  }), true);
  assert.equal(shouldInitializeSelfDestructTimer({
    tracked: { ...tracked, selfDestructTimer: { expiresAt: 1 } },
    isLocked: () => false
  }), false);
});

test('concurrent deletion submissions are single-flight per instance', async () => {
  let releaseProvider;
  let deleteCalls = 0;
  const providerPending = new Promise(resolve => { releaseProvider = resolve; });
  const deleteInstance = async () => {
    deleteCalls += 1;
    await providerPending;
  };

  const first = submitUnlockedDeletion({
    instanceId: 'same-instance',
    isLocked: () => false,
    deleteInstance,
    runUnlocked: guardedBy(() => false)
  });
  const second = await submitUnlockedDeletion({
    instanceId: 'same-instance',
    isLocked: () => false,
    deleteInstance,
    runUnlocked: guardedBy(() => false)
  });

  assert.deepEqual(second, { submitted: false, locked: false, inFlight: true });
  assert.equal(deleteCalls, 1);
  releaseProvider();
  await first;
});
