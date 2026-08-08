import test from 'node:test';
import assert from 'node:assert/strict';

import {
  handleConfirmRestart,
  setPanelExecutors
} from '../src/discord/handlers/buttons.js';

test('restart confirmation consumes controls before awaiting provider action', async () => {
  const edits = [];
  let releasePowerAction;
  const pendingResult = new Promise(resolve => { releasePowerAction = resolve; });
  let panelRefreshes = 0;
  setPanelExecutors({
    refreshPanel: async () => { panelRefreshes += 1; }
  });
  const interaction = {
    editReply: async payload => { edits.push(payload); }
  };

  const handling = handleConfirmRestart(
    interaction,
    'instance-1',
    async () => pendingResult
  );
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(edits.length, 1);
  assert.deepEqual(edits[0].components, []);

  releasePowerAction({ status: 'completed', action: 'restart' });
  await handling;

  assert.match(edits[1].content, /restart completed/i);
  assert.deepEqual(edits[1].components, []);
  assert.equal(panelRefreshes, 1);
});

test('restart confirmation renders provider failures without throwing', async () => {
  const edits = [];
  setPanelExecutors({});
  const interaction = {
    editReply: async payload => { edits.push(payload); }
  };

  await handleConfirmRestart(
    interaction,
    'instance-2',
    async () => ({ status: 'failed', action: 'restart' })
  );

  assert.match(edits.at(-1).content, /failed/i);
});
