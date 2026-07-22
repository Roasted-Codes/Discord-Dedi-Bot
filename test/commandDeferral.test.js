import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';

import { handleCommand } from '../src/discord/handlers/commands.js';

test('/create is deferred ephemerally while other commands preserve existing behavior', async () => {
  const calls = [];
  const client = {
    commands: new Map([
      ['create', { execute: async () => { calls.push('execute-create'); } }],
      ['panel', { execute: async () => { calls.push('execute-panel'); } }]
    ])
  };

  const createInteraction = {
    commandName: 'create',
    deferred: false,
    replied: false,
    deferReply: async options => { calls.push(['defer-create', options]); }
  };
  const panelInteraction = {
    commandName: 'panel',
    deferred: false,
    replied: false,
    deferReply: async options => { calls.push(['defer-panel', options]); }
  };

  await handleCommand(createInteraction, client);
  await handleCommand(panelInteraction, client);

  assert.deepEqual(calls, [
    ['defer-create', { flags: MessageFlags.Ephemeral }],
    'execute-create',
    ['defer-panel', undefined],
    'execute-panel'
  ]);
});
