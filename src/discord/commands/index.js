/**
 * Command Registry
 *
 * Collects and exports all slash commands for registration with Discord.
 * Each command file exports a command object with `data` and `execute` properties.
 */

import { listCommand } from './list.js';
import { statusCommand } from './status.js';
import { startCommand } from './start.js';
import { stopCommand } from './stop.js';
import { createCommand } from './create.js';
import { snapshotCommand } from './snapshot.js';
import { restoreCommand } from './restore.js';
import { restartCommand } from './restart.js';
import { destroyCommand } from './destroy.js';
import { panelCommand } from './panel.js';

// All commands in array format for easy iteration
export const commands = [
  listCommand,
  statusCommand,
  startCommand,
  stopCommand,
  createCommand,
  snapshotCommand,
  restoreCommand,
  restartCommand,
  destroyCommand,
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
  listCommand,
  statusCommand,
  startCommand,
  stopCommand,
  createCommand,
  snapshotCommand,
  restoreCommand,
  restartCommand,
  destroyCommand,
  panelCommand
};
