/**
 * Select Menu Handler
 *
 * Handles string select menu interactions.
 */

import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import {
  getInstance,
  isCurrentServer,
  calculateInstanceCost,
  startInstanceApi,
  stopInstanceApi,
  vultr
} from '../../vultr/index.js';
import { instanceState } from '../../state/instanceState.js';
import { formatInstanceDetails, formatRemainingTime } from '../../utils/formatters.js';
import { sendAutoCleanupFollowUp } from '../../services/notifications.js';
import { SELF_DESTRUCT_COIN_MINUTES } from '../../config/constants.js';
import { logger } from '../../utils/logger.js';

// Will be set by main entry point
let startInstanceDestructionPolling = null;

export function setDestructionPollingFunction(fn) {
  startInstanceDestructionPolling = fn;
}

export async function handleSelectMenu(interaction) {
  switch (interaction.customId) {
    case 'select_server':
      await handleSelectServer(interaction);
      break;
    case 'start_server':
      await handleStartServer(interaction);
      break;
    case 'stop_server':
      await handleStopServer(interaction);
      break;
    case 'restart_server':
      await handleRestartServer(interaction);
      break;
    case 'destroy_server':
      await handleDestroyServer(interaction);
      break;
    case 'insert_coin_server':
      await handleInsertCoin(interaction);
      break;
    default:
      logger.warn(`Unknown select menu: ${interaction.customId}`);
  }
}

async function handleSelectServer(interaction) {
  try {
    await interaction.deferUpdate();
  } catch (e) {
    if (e.code === 10062) return;
    throw e;
  }

  const selectedId = interaction.values[0];

  try {
    const instance = await getInstance(selectedId);
    if (!instance) {
      return interaction.editReply({
        content: 'This server is not available for management.',
        components: []
      });
    }

    const trackedInstance = instanceState.getInstance(selectedId);
    const formattedStatus = formatInstanceDetails(trackedInstance, instance);
    return interaction.editReply({
      content: formattedStatus,
      components: []
    });
  } catch (error) {
    logger.error('Error handling server selection:', error.message);
    return interaction.editReply({
      content: 'There was an error getting the server status.',
      components: []
    });
  }
}

async function handleStartServer(interaction) {
  try {
    await interaction.deferUpdate();
  } catch (e) {
    if (e.code === 10062) return;
    throw e;
  }

  const instanceId = interaction.values[0];

  try {
    await interaction.editReply({
      content: 'Starting the server. This may take a few minutes...',
      components: []
    });

    const success = await startInstanceApi(instanceId);
    if (success) {
      instanceState.updateInstance(instanceId, 'running');
      interaction.editReply('Server started successfully!');
    } else {
      interaction.editReply('Failed to confirm the server has started. Please check its status manually.');
    }
  } catch (error) {
    logger.error('Error starting server:', error.message);
    interaction.editReply('There was an error starting the server.');
  }
}

async function handleStopServer(interaction) {
  try {
    await interaction.deferUpdate();
  } catch (e) {
    if (e.code === 10062) return;
    throw e;
  }

  const instanceId = interaction.values[0];

  try {
    await interaction.editReply({
      content: 'Stopping the server. This may take a few minutes...',
      components: []
    });

    const success = await stopInstanceApi(instanceId);
    if (success) {
      instanceState.updateInstance(instanceId, 'stopped');
      interaction.editReply('Server stopped successfully!');
    } else {
      interaction.editReply('Failed to confirm the server has stopped. Please check its status manually.');
    }
  } catch (error) {
    logger.error('Error stopping server:', error.message);
    interaction.editReply('There was an error stopping the server.');
  }
}

async function handleRestartServer(interaction) {
  try {
    await interaction.deferUpdate();
  } catch (e) {
    if (e.code === 10062) return;
    throw e;
  }

  const instanceId = interaction.values[0];

  try {
    const instance = await getInstance(instanceId);
    if (!instance) {
      return interaction.editReply({
        content: 'This server is not available for management.',
        components: []
      });
    }

    const serverName = instance.label || 'Unnamed Server';

    const confirmRow = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(`confirm_restart_${instanceId}`)
          .setLabel('Confirm Restart')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId('cancel_restart')
          .setLabel('Cancel')
          .setStyle(ButtonStyle.Secondary)
      );

    return interaction.editReply({
      content: `**Confirm Restart**\n\nAre you sure you want to restart "${serverName}"?`,
      components: [confirmRow]
    });
  } catch (error) {
    logger.error('Error handling restart selection:', error.message);
    return interaction.editReply({
      content: 'There was an error processing the restart request.',
      components: []
    });
  }
}

async function handleDestroyServer(interaction) {
  try {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferUpdate();
    }
  } catch (e) {
    if (e.code === 10062) return;
    throw e;
  }

  const destroyId = interaction.values[0];

  try {
    const isCurrent = await isCurrentServer(destroyId);
    if (isCurrent) {
      return interaction.editReply({
        content: 'Cannot destroy bot server - self-protection enabled.',
        components: []
      });
    }

    const instance = await getInstance(destroyId);
    if (!instance) {
      return interaction.editReply({
        content: 'This server is not available for management.',
        components: []
      });
    }

    const serverName = instance.label || 'Unnamed Server';
    const formattedCost = await calculateInstanceCost(instance);

    // Clear the select menu immediately - panel will show updates
    try {
      await interaction.deleteReply();
    } catch {
      // Ignore if already deleted
    }

    try {
      await vultr.instances.deleteInstance({ "instance-id": destroyId });

      const trackedInstance = instanceState.getInstance(destroyId);
      if (trackedInstance?.selfDestructTimer) {
        instanceState.updateInstance(destroyId, trackedInstance.status, {
          selfDestructTimer: null
        });
      }

      if (startInstanceDestructionPolling) {
        startInstanceDestructionPolling(destroyId, serverName, formattedCost, interaction);
      } else {
        instanceState.updateInstance(destroyId, 'destroyed');
      }

    } catch (deleteError) {
      // Show errors as ephemeral followup since original reply was deleted
      const errorMsg = deleteError.response?.status === 400
        ? `Cannot destroy "${serverName}" - Vultr preventing deletion. Try again in a few minutes.`
        : `Error destroying "${serverName}": ${deleteError.message}`;

      await interaction.followUp({ content: errorMsg, ephemeral: true });
    }
  } catch (error) {
    logger.error('Error destroying server:', error.message);
    return interaction.editReply({
      content: 'There was an error destroying the server.',
      components: []
    });
  }
}

async function handleInsertCoin(interaction) {
  try {
    await interaction.deferUpdate();
  } catch (e) {
    if (e.code === 10062) return;
    throw e;
  }

  const instanceId = interaction.values[0];

  try {
    const trackedInstance = instanceState.getInstance(instanceId);
    if (!trackedInstance?.selfDestructTimer) {
      return interaction.editReply({
        content: 'This server does not have an active timer.',
        components: []
      });
    }

    const timer = trackedInstance.selfDestructTimer;
    const newExpiresAt = timer.expiresAt + (SELF_DESTRUCT_COIN_MINUTES * 60 * 1000);

    timer.expiresAt = newExpiresAt;
    timer.extendedCount = (timer.extendedCount || 0) + 1;

    instanceState.updateInstance(instanceId, trackedInstance.status, {
      selfDestructTimer: timer
    });

    const timeStr = formatRemainingTime(newExpiresAt);
    const serverName = trackedInstance.name || 'Unnamed Server';

    await interaction.editReply({
      content: `**Coin Inserted!**\n\n` +
        `Server "${serverName}" timer extended by ${SELF_DESTRUCT_COIN_MINUTES} minutes.\n` +
        `New time remaining: ${timeStr}`,
      components: []
    });

  } catch (error) {
    logger.error('Error handling insert coin:', error.message);
    return interaction.editReply({
      content: 'There was an error inserting the coin.',
      components: []
    });
  }
}
