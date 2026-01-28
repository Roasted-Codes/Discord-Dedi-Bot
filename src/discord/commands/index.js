/**
 * Command Registry
 *
 * Collects and exports all slash commands for registration with Discord.
 * Each command file exports a command object with `data` and `execute` properties.
 */

import { createCommand } from './create.js';
import { destroyCommand } from './destroy.js';
import { snapshotCommand } from './snapshot.js';
import { panelCommand } from './panel.js';

// All commands in array format for easy iteration
export const commands = [
  createCommand,
  destroyCommand,
  snapshotCommand,
  panelCommand
];

/**
 * Register all commands to the client's commands collection
 * @param {Client} client - Discord client instance
 */
export function registerCommands(client) {
  for (const command of commands) {
    client.commands.set(command.data.name, command);
  }
}

// Re-export individual commands for direct access if needed
export {
  createCommand,
  destroyCommand,
  snapshotCommand,
  panelCommand
};
