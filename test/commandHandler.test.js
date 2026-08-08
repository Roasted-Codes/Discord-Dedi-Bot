import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';

import { handleCommand } from '../src/discord/handlers/commands.js';

test('/destroy is deferred ephemerally before command execution', async () => {
  const events = [];
  const interaction = {
    commandName: 'destroy',
    deferred: false,
    replied: false,
    deferReply: async options => {
      events.push(['defer', options]);
      interaction.deferred = true;
    }
  };
  const client = {
    commands: new Map([
      ['destroy', {
        execute: async () => {
          events.push(['execute']);
        }
      }]
    ])
  };

  await handleCommand(interaction, client);

  assert.deepEqual(events, [
    ['defer', { flags: MessageFlags.Ephemeral }],
    ['execute']
  ]);
});
