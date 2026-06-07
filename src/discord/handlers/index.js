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
        return handleAutocomplete(interaction);
      }

      if (interaction.isCommand()) {
        return handleCommand(interaction, client);
      }

      if (interaction.isStringSelectMenu()) {
        return handleSelectMenu(interaction);
      }

      if (interaction.isButton()) {
        return handleButton(interaction);
      }

      if (interaction.isModalSubmit()) {
        return handleModal(interaction);
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
export { handleSelectMenu, setDestructionPollingFunction, setQuickCreateWithTimerFunction } from './selectMenus.js';
export { handleButton, setPanelExecutors } from './buttons.js';
export {
  handleModal,
  setModalPanelFunction,
  setModalQuickCreateFunction,
  setModalManualRestoreFunction
} from './modals.js';
