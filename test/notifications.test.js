import test from 'node:test';
import assert from 'node:assert/strict';

import { sendAutoCleanupFollowUp } from '../src/services/notifications.js';

test('expired Discord webhook tokens are non-fatal for delayed follow-ups', async () => {
  const error = new Error('Invalid Webhook Token');
  error.code = 50027;
  const interaction = {
    followUp: async () => { throw error; }
  };

  const result = await sendAutoCleanupFollowUp(interaction, 'Delayed status update');

  assert.equal(result, null);
});
