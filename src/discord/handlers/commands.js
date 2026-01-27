/**
 * Command Handler
 *
 * Handles slash command execution.
 */

import { MessageFlags } from 'discord.js';
import { logger } from '../../utils/logger.js';

export async function handleCommand(interaction, client) {
  const command = client.commands.get(interaction.commandName);

  if (!command) {
    logger.warn(`Unknown command: ${interaction.commandName}`);
    return interaction.reply({
      content: 'Sorry, this command is not available.',
      flags: MessageFlags.Ephemeral
    });
  }

  // Defer reply immediately to get 15-minute response window
  try {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply();
    }
  } catch (error) {
    if (error.code === 10062) {
      logger.debug(`Command ${interaction.commandName} expired`);
      return;
    }
    throw error;
  }

  try {
    await command.execute(interaction);
  } catch (error) {
    logger.error(`Command /${interaction.commandName} failed:`, error.message);

    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply('There was an error while executing this command.');
      } else {
        await interaction.reply({
          content: 'There was an error while executing this command.',
          flags: MessageFlags.Ephemeral
        });
      }
    } catch (replyError) {
      logger.debug('Failed to send error message:', replyError.message);
    }
  }
}
