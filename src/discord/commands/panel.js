/**
 * /panel Command
 *
 * Show the server control panel with buttons.
 */

import { SlashCommandBuilder } from 'discord.js';
import { logger } from '../../utils/logger.js';

// This will be set by the main entry point
let updatePanel = null;

export function setPanelFunction(fn) {
  updatePanel = fn;
}

export const panelCommand = {
  data: new SlashCommandBuilder()
    .setName('panel')
    .setDescription('Show the server control panel with buttons'),

  async execute(interaction) {
    try {
      if (updatePanel) {
        await updatePanel(interaction);
      } else {
        await interaction.editReply('Panel functionality not available.');
      }
    } catch (error) {
      logger.error('Panel command failed:', error.message);
      await interaction.editReply('There was an error displaying the control panel.');
    }
  }
};
