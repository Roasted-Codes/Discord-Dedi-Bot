/**
 * Handler Registry
 *
 * Sets up all interaction handlers on the Discord client.
 */

import { handleAutocomplete } from './autocomplete.js';
import { handleCommand } from './commands.js';
import { handleSelectMenu } from './selectMenus.js';
import { handleButton } from './buttons.js';
import { handleModal } from './modals.js';
import { logger } from '../../utils/logger.js';

/**
 * Set up all interaction handlers on the client
 */
export function setupHandlers(client) {
  client.on('interactionCreate', async interaction => {
    try {
      if (interaction.isAutocomplete()) {
        await handleAutocomplete(interaction);
        return;
      }

      if (interaction.isCommand()) {
        await handleCommand(interaction, client);
        return;
      }

      if (interaction.isStringSelectMenu()) {
        await handleSelectMenu(interaction);
        return;
      }

      if (interaction.isButton()) {
        await handleButton(interaction);
        return;
      }

      if (interaction.isModalSubmit()) {
        await handleModal(interaction);
        return;
      }

      logger.debug(`Unhandled interaction type: ${interaction.type}`);
    } catch (error) {
      logger.error('Error handling interaction:', error.message);
    }
  });
}

// Re-export individual handlers
export { handleAutocomplete } from './autocomplete.js';
export { handleCommand } from './commands.js';
export {
  handleSelectMenu,
  setDestructionPollingFunction,
  setServerLockPanelFunction
} from './selectMenus.js';
export { handleButton, setPanelExecutors } from './buttons.js';
export {
  handleModal,
  setModalPanelFunction,
  setModalManualRestoreFunction
} from './modals.js';
