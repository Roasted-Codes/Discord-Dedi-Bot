import test from 'node:test';
import assert from 'node:assert/strict';

import { handleDestroyServer } from '../src/discord/handlers/selectMenus.js';

function destroyInteraction(overrides = {}) {
  return {
    customId: 'destroy_server',
    values: ['instance-1'],
    user: { id: 'friend-1', username: 'Friend' },
    deferred: false,
    replied: false,
    deferUpdate: async () => {},
    editReply: async () => {},
    deleteReply: async () => {},
    followUp: async () => {},
    ...overrides
  };
}

function unlockedDependencies(overrides = {}) {
  const dependencies = {
    checkCurrent: async () => false,
    fetchInstance: async () => ({
      id: 'instance-1',
      label: 'Overnight Work',
      power_status: 'running'
    }),
    calculateCost: async () => '$1.00',
    isLocked: () => false,
    deleteInstance: async () => {},
    state: {
      getInstance: () => null,
      updateInstance: () => {}
    },
    beginDestructionPolling: () => {},
    releaseAssignment: async () => {},
    ...overrides
  };
  if (!overrides.runUnlocked) {
    dependencies.runUnlocked = async (instanceId, action) => {
      if (dependencies.isLocked(instanceId)) return { submitted: false, locked: true };
      await action();
      return { submitted: true, locked: false };
    };
  }
  return dependencies;
}

test('a locked destroy selection is rejected without calling Vultr', async () => {
  const edits = [];
  let deleteCalls = 0;
  let deleteReplyCalls = 0;
  const interaction = destroyInteraction({
    editReply: async payload => { edits.push(payload); },
    deleteReply: async () => { deleteReplyCalls += 1; }
  });

  await handleDestroyServer(interaction, unlockedDependencies({
    isLocked: () => true,
    deleteInstance: async () => { deleteCalls += 1; }
  }));

  assert.equal(deleteCalls, 0);
  assert.equal(deleteReplyCalls, 0);
  assert.match(edits[0].content, /🔒/);
  assert.match(edits[0].content, /locked by an administrator/i);
  assert.deepEqual(edits[0].components, []);
});

test('a stale destroy selection rechecks the lock immediately before deletion', async () => {
  const edits = [];
  const checks = [false, true];
  let deleteCalls = 0;
  let deleteReplyCalls = 0;
  const interaction = destroyInteraction({
    editReply: async payload => { edits.push(payload); },
    deleteReply: async () => { deleteReplyCalls += 1; }
  });

  await handleDestroyServer(interaction, unlockedDependencies({
    isLocked: () => checks.shift(),
    deleteInstance: async () => { deleteCalls += 1; }
  }));

  assert.equal(deleteCalls, 0);
  assert.equal(deleteReplyCalls, 0);
  assert.match(edits.at(-1).content, /locked by an administrator/i);
});

test('an unlocked server still follows the existing deletion and polling path', async () => {
  let deleteCalls = 0;
  let pollingCalls = 0;
  let deleteReplyCalls = 0;
  const interaction = destroyInteraction({
    deleteReply: async () => { deleteReplyCalls += 1; }
  });

  await handleDestroyServer(interaction, unlockedDependencies({
    deleteInstance: async instanceId => {
      assert.equal(instanceId, 'instance-1');
      deleteCalls += 1;
    },
    beginDestructionPolling: (instanceId, serverName, cost) => {
      assert.equal(instanceId, 'instance-1');
      assert.equal(serverName, 'Overnight Work');
      assert.equal(cost, '$1.00');
      pollingCalls += 1;
    }
  }));

  assert.equal(deleteCalls, 1);
  assert.equal(pollingCalls, 1);
  assert.equal(deleteReplyCalls, 1);
});

test('provider deletion failure replaces the submitting progress response', async () => {
  const edits = [];
  let followUpCalls = 0;
  let deleteReplyCalls = 0;
  const interaction = destroyInteraction({
    editReply: async payload => { edits.push(payload); },
    deleteReply: async () => { deleteReplyCalls += 1; },
    followUp: async () => { followUpCalls += 1; }
  });

  await handleDestroyServer(interaction, unlockedDependencies({
    submitDeletion: async () => { throw new Error('provider unavailable'); }
  }));

  assert.match(edits[0].content, /Submitting destruction request/i);
  assert.match(edits.at(-1).content, /provider unavailable/i);
  assert.deepEqual(edits.at(-1).components, []);
  assert.equal(deleteReplyCalls, 0);
  assert.equal(followUpCalls, 0);
});

test('cleanup failure after accepted deletion never edits the deleted reply', async () => {
  const edits = [];
  let deleted = false;
  let deleteCalls = 0;
  const interaction = destroyInteraction({
    editReply: async payload => {
      if (deleted) throw new Error('Unknown Message');
      edits.push(payload);
    },
    deleteReply: async () => { deleted = true; }
  });

  await assert.doesNotReject(() => handleDestroyServer(interaction, unlockedDependencies({
    deleteInstance: async () => { deleteCalls += 1; },
    state: {
      getInstance: () => ({ status: 'running', selfDestructTimer: { id: 'timer-1' } }),
      updateInstance: () => { throw new Error('state unavailable'); }
    }
  })));

  assert.equal(deleteCalls, 1);
  assert.equal(deleted, true);
  assert.equal(edits.length, 1);
  assert.match(edits[0].content, /Submitting destruction request/i);
});

test('async polling startup failure after accepted deletion is contained', async () => {
  const edits = [];
  let deleted = false;
  const interaction = destroyInteraction({
    editReply: async payload => {
      if (deleted) throw new Error('Unknown Message');
      edits.push(payload);
    },
    deleteReply: async () => { deleted = true; }
  });

  await assert.doesNotReject(() => handleDestroyServer(interaction, unlockedDependencies({
    beginDestructionPolling: async () => {
      await Promise.resolve();
      throw new Error('polling unavailable');
    }
  })));
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(deleted, true);
  assert.equal(edits.length, 1);
  assert.match(edits[0].content, /Submitting destruction request/i);
});
