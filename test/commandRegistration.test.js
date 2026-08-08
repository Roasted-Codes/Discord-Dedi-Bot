import test from 'node:test';
import assert from 'node:assert/strict';

import { registerApplicationCommands } from '../src/discord/registerApplicationCommands.js';

test('guild-scoped registration is immediate and clears duplicate global commands', async () => {
  const calls = [];
  const rest = { put: async (route, options) => { calls.push({ route, body: options.body }); return options.body; } };
  const commands = [{ name: 'panel' }];

  const scope = await registerApplicationCommands({
    rest,
    applicationId: 'app-1',
    guildId: 'guild-1',
    commands
  });

  assert.equal(scope, 'guild');
  assert.equal(calls.length, 2);
  assert.match(calls[0].route, /applications\/app-1\/guilds\/guild-1\/commands/);
  assert.deepEqual(calls[0].body, commands);
  assert.match(calls[1].route, /applications\/app-1\/commands/);
  assert.deepEqual(calls[1].body, []);
});
