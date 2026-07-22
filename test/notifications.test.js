import test from 'node:test';
import assert from 'node:assert/strict';

import {
  scheduleMessageCleanup,
  scheduleInteractionReplyCleanup,
  sendAutoCleanupFollowUp
} from '../src/services/notifications.js';

test('expired Discord webhook tokens are non-fatal for delayed follow-ups', async () => {
  const error = new Error('Invalid Webhook Token');
  error.code = 50027;
  const interaction = {
    followUp: async () => { throw error; }
  };

  const result = await sendAutoCleanupFollowUp(interaction, 'Delayed status update');

  assert.equal(result, null);
});

test('original interaction replies are deleted after the configured delay', async () => {
  let scheduledDelay;
  let scheduledCallback;
  let deleteCalls = 0;
  const interaction = {
    deleteReply: async () => { deleteCalls += 1; }
  };

  scheduleInteractionReplyCleanup(interaction, {
    deleteAfterMs: 600000,
    setTimeoutFn: (callback, delay) => {
      scheduledCallback = callback;
      scheduledDelay = delay;
    }
  });

  assert.equal(scheduledDelay, 600000);
  assert.equal(deleteCalls, 0);
  await scheduledCallback();
  assert.equal(deleteCalls, 1);
});

test('message cleanup can be postponed while a component action is pending', () => {
  const scheduled = [];
  const cleared = [];
  const message = { id: 'message-1', delete: async () => {} };
  const setTimeoutFn = (callback, delay) => {
    const timer = { callback, delay };
    scheduled.push(timer);
    return timer;
  };
  const clearTimeoutFn = timer => { cleared.push(timer); };

  scheduleMessageCleanup(message, {
    deleteAfterMs: 30000,
    setTimeoutFn,
    clearTimeoutFn
  });
  scheduleMessageCleanup(message, {
    deleteAfterMs: 180000,
    setTimeoutFn,
    clearTimeoutFn
  });

  assert.deepEqual(cleared, [scheduled[0]]);
  assert.equal(scheduled[1].delay, 180000);
});
