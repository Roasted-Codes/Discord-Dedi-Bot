/**
 * Dedi-Bot - Discord Bot for Managing Vultr VPS Instances
 *
 * Modular entry point that wires together all components.
 */

import { config } from './config/index.js';
import {
  SELF_DESTRUCT_INITIAL_MINUTES,
  SELF_DESTRUCT_COIN_MINUTES,
  PANEL_REFRESH_INTERVAL_MS
} from './config/constants.js';
import { createDiscordClient, REST, Routes, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } from './discord/client.js';
import { commands, registerCommands } from './discord/commands/index.js';
import { setupHandlers, setDestructionPollingFunction, setPanelExecutors, setModalPanelFunction } from './discord/handlers/index.js';
import { setPollingFunction } from './discord/commands/create.js';
import { setSnapshotPollingFunction } from './discord/commands/snapshot.js';
import { setRestorePollingFunction } from './discord/commands/restore.js';
import { setPanelFunction } from './discord/commands/panel.js';
import { instanceState } from './state/instanceState.js';
import { panelData, savePanelData } from './state/panelState.js';
import {
  vultr,
  listInstances,
  getInstance,
  getGroupedRegions,
  calculateInstanceCost
} from './vultr/index.js';
import { sendAutoCleanupFollowUp, sendServerCreationDM, sendServerDestructionDM } from './services/notifications.js';
import { formatStatus, formatRemainingTime, formatInstanceDetails } from './utils/formatters.js';
import { logger } from './utils/logger.js';

// Create Discord client
const client = createDiscordClient();

// Track cleanup functions for graceful shutdown
const cleanupFunctions = [];

// ============================================================================
// POLLING FUNCTIONS
// ============================================================================

async function initializeSelfDestructTimer(instanceId) {
  const trackedInstance = instanceState.getInstance(instanceId);
  if (!trackedInstance) return;

  if (trackedInstance.selfDestructTimer) return;

  const now = Date.now();
  const expiresAt = now + (SELF_DESTRUCT_INITIAL_MINUTES * 60 * 1000);

  instanceState.updateInstance(instanceId, trackedInstance.status, {
    selfDestructTimer: {
      expiresAt,
      initialDuration: SELF_DESTRUCT_INITIAL_MINUTES * 60 * 1000,
      extendedCount: 0,
      warningsSent: []
    }
  });

  logger.debug(`Timer set for ${instanceId.slice(0, 8)}...: ${SELF_DESTRUCT_INITIAL_MINUTES}min`);
}

async function startInstanceStatusPolling(instanceId, serverName, region, interaction, message, sendDM = true) {
  logger.debug(`Polling instance ${instanceId.slice(0, 8)}...`);

  let attempts = 0;
  const maxWaitTime = 30 * 60 * 1000;
  const startTime = Date.now();

  const pollStatus = async () => {
    attempts++;
    const elapsedMinutes = Math.floor((Date.now() - startTime) / 60000);

    if (Date.now() - startTime > maxWaitTime) {
      await sendAutoCleanupFollowUp(interaction,
        `Server "${serverName}" exceeded 30-minute startup limit.\n` +
        `Use \`/status\` to check manually.`
      );
      return;
    }

    try {
      const instance = await getInstance(instanceId);
      if (!instance) {
        await sendAutoCleanupFollowUp(interaction, 'This server is not available for management.');
        return;
      }

      const status = formatStatus(instance);
      instanceState.updateInstance(instanceId, instance.power_status, { ip: instance.main_ip });

      if (instance.status === 'active' &&
          instance.power_status === 'running' &&
          instance.main_ip &&
          instance.main_ip !== '0.0.0.0') {

        if (sendDM) {
          try {
            await sendServerCreationDM(interaction.user, {
              serverName,
              region,
              ip: instance.main_ip,
              elapsedMinutes
            });
          } catch (e) {
            logger.debug('Failed to send creation DM:', e.message);
          }
        }

        await initializeSelfDestructTimer(instanceId);
        logger.info(`Server "${serverName}" ready (${elapsedMinutes}min)`);
        setTimeout(() => updatePanel(), 2000);
        return;
      }

      // Continue polling silently - panel shows status
      setTimeout(pollStatus, 45000);

    } catch (error) {
      logger.debug(`Polling error for ${instanceId.slice(0, 8)}...:`, error.message);
      if (Date.now() - startTime < maxWaitTime) {
        setTimeout(pollStatus, 45000);
      }
    }
  };

  setTimeout(pollStatus, 10000);
}

async function startSnapshotStatusPolling(snapshotId, snapshotName, isPublic, interaction) {
  logger.debug(`Polling snapshot ${snapshotId.slice(0, 8)}...`);

  let attempts = 0;
  const maxWaitTime = 30 * 60 * 1000;
  const startTime = Date.now();

  const pollStatus = async () => {
    attempts++;
    const elapsedMinutes = Math.floor((Date.now() - startTime) / 60000);

    if (Date.now() - startTime > maxWaitTime) {
      await sendAutoCleanupFollowUp(interaction,
        `Snapshot "${snapshotName}" exceeded 30-minute creation limit.\n` +
        `Check Vultr dashboard manually.`
      );
      return;
    }

    try {
      const response = await vultr.snapshots.listSnapshots();
      const snapshot = (response.snapshots || []).find(s => s.id === snapshotId);

      if (!snapshot) {
        setTimeout(pollStatus, 30000);
        return;
      }

      if (snapshot.status === 'complete') {
        const finalMessage =
          `Snapshot "${snapshotName}" is now COMPLETE!\n\n` +
          `Size: ${snapshot.size || 'Unknown'} GB\n` +
          `ID: \`${snapshot.id}\`\n` +
          `${isPublic ? 'Available to all users' : 'Private snapshot'}\n` +
          `Creation time: ${elapsedMinutes} minutes`;

        await sendAutoCleanupFollowUp(interaction, finalMessage);
        return;
      }

      if (snapshot.status === 'error' || snapshot.status === 'failed') {
        await sendAutoCleanupFollowUp(interaction,
          `Snapshot "${snapshotName}" creation FAILED!\n` +
          `Please try again.`
        );
        return;
      }

      // Continue polling silently
      setTimeout(pollStatus, 30000);

    } catch (error) {
      logger.debug(`Polling error for snapshot ${snapshotId.slice(0, 8)}...:`, error.message);
      if (Date.now() - startTime < maxWaitTime) {
        setTimeout(pollStatus, 30000);
      }
    }
  };

  setTimeout(pollStatus, 15000);
}

async function startInstanceDestructionPolling(instanceId, serverName, cost, interaction) {
  logger.debug(`Destruction polling for ${instanceId.slice(0, 8)}...`);

  const maxWaitTime = 15 * 60 * 1000;
  const startTime = Date.now();

  const pollStatus = async () => {
    if (Date.now() - startTime > maxWaitTime) {
      await sendAutoCleanupFollowUp(interaction,
        `Destruction timeout after 15 minutes. Check Vultr dashboard.\nCost: ${cost}`
      );
      return;
    }

    try {
      const instance = await getInstance(instanceId);

      if (!instance) {
        instanceState.updateInstance(instanceId, 'destroyed', { selfDestructTimer: null });
        try {
          await sendServerDestructionDM(interaction.user, serverName, cost);
        } catch (e) {
          logger.debug('Failed to send destruction DM:', e.message);
        }
        setTimeout(() => updatePanel(), 2000);
        return;
      }

      try {
        await vultr.instances.deleteInstance({ "instance-id": instanceId });
      } catch (e) {
        // May fail if server still booting
      }

      // Continue polling silently - panel shows status
      setTimeout(pollStatus, 10000);

    } catch (error) {
      if (error.response?.status === 404 || error.response?.status === 403) {
        instanceState.updateInstance(instanceId, 'destroyed', { selfDestructTimer: null });
        try {
          await sendServerDestructionDM(interaction.user, serverName, cost);
        } catch (e) {
          logger.debug('Failed to send destruction DM:', e.message);
        }
        return;
      }
      setTimeout(pollStatus, 10000);
    }
  };

  setTimeout(pollStatus, 2000);
}

// ============================================================================
// PANEL FUNCTIONS
// ============================================================================

async function getServerStats() {
  try {
    const instances = await listInstances();
    return {
      running: instances.filter(i => i.power_status === 'running').length,
      stopped: instances.filter(i => i.power_status === 'stopped').length,
      total: instances.length
    };
  } catch (error) {
    return { running: 0, stopped: 0, total: 0 };
  }
}

async function generatePanelComponents(showQuickActions = true) {
  const stats = await getServerStats();

  const row1 = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId('btn_destroy')
        .setLabel('Destroy')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(stats.total === 0),
      new ButtonBuilder()
        .setCustomId('btn_restart')
        .setLabel('Restart')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(stats.total === 0),
      new ButtonBuilder()
        .setCustomId('btn_insert_coin')
        .setLabel('Insert Coin')
        .setStyle(ButtonStyle.Success)
        .setDisabled(stats.total === 0)
    );

  const rows = [row1];

  if (showQuickActions) {
    // Quick action cities
    const quickCities = [
      { id: 'dfw', name: 'Dallas' },
      { id: 'ord', name: 'Chicago' },
      { id: 'ewr', name: 'NYC' },
      { id: 'lax', name: 'LA' },
      { id: 'mia', name: 'Miami' },
      { id: 'sea', name: 'Seattle' },
      { id: 'atl', name: 'Atlanta' },
      { id: 'sjc', name: 'San Jose' },
      { id: 'yto', name: 'Toronto' },
      { id: 'ams', name: 'Amsterdam' }
    ];

    const row2 = new ActionRowBuilder();
    const row3 = new ActionRowBuilder();

    quickCities.slice(0, 5).forEach(city => {
      row2.addComponents(
        new ButtonBuilder()
          .setCustomId(`btn_quick_${city.id}`)
          .setLabel(city.name)
          .setStyle(ButtonStyle.Secondary)
      );
    });

    quickCities.slice(5, 10).forEach(city => {
      row3.addComponents(
        new ButtonBuilder()
          .setCustomId(`btn_quick_${city.id}`)
          .setLabel(city.name)
          .setStyle(ButtonStyle.Secondary)
      );
    });

    rows.push(row2, row3);
  }

  return rows;
}

async function formatServersForPanel(guild) {
  try {
    const instances = await listInstances();
    if (!instances.length) return 'No active servers.';

    let content = '';
    for (const instance of instances) {
      const tracked = instanceState.getInstance(instance.id);
      const status = formatStatus(instance);
      const serverName = instance.label || 'Unnamed Server';

      // Show status text for non-running servers
      const isCreating = instance.status === 'pending' || instance.power_status === 'stopped' && !instance.main_ip;
      const statusText = isCreating ? ' *(Creating...)*' : '';

      content += `${status.emoji} **${serverName}**${statusText}\n`;

      if (instance.main_ip && instance.main_ip !== '0.0.0.0') {
        content += `> Xlink: http://${instance.main_ip}:34522\n`;
      } else if (isCreating) {
        content += `> Waiting for IP...\n`;
      }

      if (tracked?.selfDestructTimer) {
        const timeStr = formatRemainingTime(tracked.selfDestructTimer.expiresAt);
        content += `> Timer: ${timeStr}\n`;
      }

      if (tracked?.creator?.id && tracked.creator.id !== 'unknown') {
        try {
          const member = await guild?.members?.fetch(tracked.creator.id);
          content += `> Created by: ${member?.displayName || tracked.creator.username}\n`;
        } catch {
          content += `> Created by: ${tracked.creator.username}\n`;
        }
      }

      content += '\n';
    }

    return content.trim();
  } catch (error) {
    logger.error('Error formatting panel:', error.message);
    return 'Error loading servers.';
  }
}

let panelUpdateInProgress = false;
let pendingPanelUpdate = false;

async function updatePanel(interaction = null, channel = null) {
  if (panelUpdateInProgress) {
    pendingPanelUpdate = true;
    return;
  }

  panelUpdateInProgress = true;

  try {
    // Determine channel
    let targetChannel = channel;
    if (!targetChannel && panelData.channelId) {
      targetChannel = client.channels.cache.get(panelData.channelId);
      if (!targetChannel) {
        try {
          targetChannel = await client.channels.fetch(panelData.channelId);
        } catch (e) {
          targetChannel = null;
        }
      }
    }
    if (!targetChannel && interaction?.channel) {
      targetChannel = interaction.channel;
    }

    if (!targetChannel) {
      if (interaction) await interaction.editReply('Cannot find channel for panel.');
      return;
    }

    // Generate content
    const serverContent = await formatServersForPanel(targetChannel.guild);
    const stats = await getServerStats();
    const components = await generatePanelComponents(true);

    const content =
      `**Server Control Panel**\n` +
      `Running: ${stats.running} | Stopped: ${stats.stopped} | Total: ${stats.total}\n\n` +
      `${serverContent}\n\n` +
      `*Quick Create: Click a city button to create a server there*`;

    // Update or create panel message
    if (panelData.messageId) {
      try {
        const message = await targetChannel.messages.fetch(panelData.messageId);
        await message.edit({ content, components });
      } catch (e) {
        // Message deleted, create new one
        const newMessage = await targetChannel.send({ content, components });
        panelData.messageId = newMessage.id;
        panelData.channelId = targetChannel.id;
        savePanelData();
      }
    } else {
      const newMessage = await targetChannel.send({ content, components });
      panelData.messageId = newMessage.id;
      panelData.channelId = targetChannel.id;
      savePanelData();
    }

    if (interaction && !interaction.replied && !interaction.deferred) {
      // Already handled by creating/editing panel
    } else if (interaction?.deferred) {
      await interaction.editReply('Panel updated!');
    }

  } catch (error) {
    logger.error('Error updating panel:', error.message);
  } finally {
    panelUpdateInProgress = false;
    if (pendingPanelUpdate) {
      pendingPanelUpdate = false;
      setTimeout(() => updatePanel(), 1000);
    }
  }
}

// ============================================================================
// PANEL BUTTON EXECUTORS
// ============================================================================

async function executeDestroyFromPanel(interaction) {
  const instances = await listInstances();
  const activeInstances = instances.filter(i => i.status !== 'destroyed');

  if (!activeInstances.length) {
    return sendAutoCleanupFollowUp(interaction, 'No active servers found.');
  }

  const options = activeInstances.map(instance => ({
    label: instance.label || 'Unnamed Server',
    description: `Status: ${instance.power_status} | ${instance.region}`,
    value: instance.id
  }));

  const row = new ActionRowBuilder()
    .addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('destroy_server')
        .setPlaceholder('Select a server to destroy')
        .addOptions(options)
    );

  return sendAutoCleanupFollowUp(interaction, {
    content: '**WARNING**: Select a server to destroy:',
    components: [row]
  });
}

async function executeRestartFromPanel(interaction) {
  const instances = await listInstances();
  const activeInstances = instances.filter(i => i.status !== 'destroyed');

  if (!activeInstances.length) {
    return sendAutoCleanupFollowUp(interaction, 'No active servers found.');
  }

  const options = activeInstances.map(instance => ({
    label: instance.label || 'Unnamed Server',
    description: `Status: ${instance.power_status} | ${instance.region}`,
    value: instance.id
  }));

  const row = new ActionRowBuilder()
    .addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('restart_server')
        .setPlaceholder('Select a server to restart')
        .addOptions(options)
    );

  return sendAutoCleanupFollowUp(interaction, {
    content: 'Select a server to restart:',
    components: [row]
  });
}

async function executeQuickCreate(interaction, regionId) {
  const groupedRegions = await getGroupedRegions();
  let cityName = regionId.toUpperCase();

  for (const [continent, countries] of Object.entries(groupedRegions)) {
    for (const [country, cities] of Object.entries(countries)) {
      const city = cities.find(c => c.id === regionId);
      if (city) {
        cityName = city.city;
        break;
      }
    }
    if (cityName !== regionId.toUpperCase()) break;
  }

  const serverName = `${interaction.user.username}'s ${cityName} Server`;

  try {
    const { createInstanceFromSnapshot } = await import('./vultr/index.js');

    let snapshotId = config.vultr.snapshotId;
    if (!snapshotId) {
      const { getSnapshots } = await import('./vultr/index.js');
      const snapshots = await getSnapshots();
      snapshotId = snapshots[0]?.id;
    }

    if (!snapshotId) {
      return sendAutoCleanupFollowUp(interaction, 'No snapshots available.');
    }

    const instance = await createInstanceFromSnapshot(snapshotId, serverName, regionId);

    if (instance?.id) {
      instanceState.trackInstance(
        instance.id,
        interaction.user.id,
        interaction.user.username,
        'creating',
        { name: serverName, region: regionId }
      );

      startInstanceStatusPolling(instance.id, serverName, regionId, interaction, null, true);
      setTimeout(() => updatePanel(), 5000);
    } else {
      await sendAutoCleanupFollowUp(interaction, 'Failed to create server.');
    }
  } catch (error) {
    logger.error('Quick create failed:', error.message);
    await sendAutoCleanupFollowUp(interaction, `Error: ${error.message}`);
  }
}

// ============================================================================
// SELF-DESTRUCT POLLING
// ============================================================================

function startSelfDestructPolling() {
  logger.debug('Self-destruct polling started');

  const checkTimers = async () => {
    try {
      const activeInstances = instanceState.getActiveInstances();

      for (const tracked of activeInstances) {
        const timer = tracked.selfDestructTimer;
        if (!timer) continue;

        const remainingMs = timer.expiresAt - Date.now();
        const remainingMinutes = Math.floor(remainingMs / 60000);

        if (remainingMs <= 0) {
          logger.info(`Timer expired for "${tracked.name}" - destroying`);

          try {
            await vultr.instances.deleteInstance({ "instance-id": tracked.id });
            instanceState.updateInstance(tracked.id, 'destroyed', { selfDestructTimer: null });

            try {
              const user = await client.users.fetch(tracked.creator.id);
              if (user) {
                await user.send(
                  `**Server Self-Destructed**\n\n` +
                  `Server "${tracked.name}" has been automatically destroyed.\n` +
                  `The self-destruct timer expired.`
                );
              }
            } catch (e) { /* ignore DM errors */ }

            setTimeout(() => updatePanel(), 2000);
          } catch (e) {
            logger.error(`Error destroying ${tracked.id.slice(0, 8)}...:`, e.message);
          }
          continue;
        }

        // Send warnings
        const warningsSent = timer.warningsSent || [];

        if (remainingMinutes <= 10 && remainingMinutes > 5 && !warningsSent.includes('10min')) {
          await sendWarningDM(tracked, 10);
          timer.warningsSent.push('10min');
          instanceState.updateInstance(tracked.id, tracked.status, { selfDestructTimer: timer });
        } else if (remainingMinutes <= 5 && !warningsSent.includes('5min')) {
          await sendWarningDM(tracked, 5);
          timer.warningsSent.push('5min');
          instanceState.updateInstance(tracked.id, tracked.status, { selfDestructTimer: timer });
        }
      }
    } catch (error) {
      logger.error('Self-destruct poll error:', error.message);
    }
  };

  const intervalId = setInterval(checkTimers, 30000);
  cleanupFunctions.push(() => clearInterval(intervalId));

  setTimeout(checkTimers, 5000);
}

async function sendWarningDM(tracked, minutesRemaining) {
  try {
    const user = await client.users.fetch(tracked.creator.id);
    if (!user) return;

    const timeStr = formatRemainingTime(tracked.selfDestructTimer.expiresAt);

    const coinButton = new ButtonBuilder()
      .setCustomId(`coin_${tracked.id}`)
      .setLabel(`Insert Coin (+${SELF_DESTRUCT_COIN_MINUTES}min)`)
      .setStyle(ButtonStyle.Success);

    const row = new ActionRowBuilder().addComponents(coinButton);

    await user.send({
      content:
        `**Self-Destruct Warning**\n\n` +
        `Server "${tracked.name}" will self-destruct in ${minutesRemaining} minutes!\n` +
        `Time remaining: ${timeStr}\n\n` +
        `Click the button below to extend the timer:`,
      components: [row]
    });

    logger.debug(`Warning DM sent to ${user.username}`);
  } catch (error) {
    logger.debug(`Warning DM failed:`, error.message);
  }
}

// ============================================================================
// WIRE UP DEPENDENCIES
// ============================================================================

setPollingFunction(startInstanceStatusPolling);
setSnapshotPollingFunction(startSnapshotStatusPolling);
setRestorePollingFunction(startInstanceStatusPolling);
setPanelFunction(updatePanel);
setDestructionPollingFunction(startInstanceDestructionPolling);
setModalPanelFunction(updatePanel);
setPanelExecutors({
  destroy: executeDestroyFromPanel,
  restart: executeRestartFromPanel,
  quickCreate: executeQuickCreate
});

// ============================================================================
// READY EVENT
// ============================================================================

client.once('ready', async () => {
  logger.startup(client.user.tag);

  // Test Vultr API
  try {
    const testResponse = await vultr.instances.listInstances();
    logger.info('Vultr API connected');

    // Recover existing instances
    if (testResponse.instances) {
      for (const instance of testResponse.instances) {
        if (instance.id === config.exclude.instanceId) continue;

        instanceState.trackInstance(
          instance.id,
          'unknown',
          'System Recovery',
          instance.power_status,
          {
            ip: instance.main_ip,
            name: instance.label || 'Recovered Server',
            region: instance.region
          }
        );
      }
      if (testResponse.instances.length > 0) {
        logger.info(`Recovered ${testResponse.instances.length} instance(s)`);
      }
    }
  } catch (error) {
    logger.error('Vultr API connection failed:', error.message);
  }

  // Register commands
  try {
    const commandData = commands.map(cmd => cmd.data.toJSON());
    const rest = new REST({ version: '10' }).setToken(config.discord.token);

    logger.info(`Registering ${commandData.length} commands...`);
    await rest.put(Routes.applicationCommands(client.user.id), { body: commandData });

    // Clear guild-specific commands (were causing duplicates)
    if (config.discord.guildId) {
      await rest.put(
        Routes.applicationGuildCommands(client.user.id, config.discord.guildId),
        { body: [] }
      );
      logger.debug(`Cleared guild commands`);
    }

    logger.info('Commands registered');
  } catch (error) {
    logger.error('Command registration failed:', error.message);
  }

  // Restore panel
  if (panelData.messageId && panelData.channelId) {
    try {
      let channel = client.channels.cache.get(panelData.channelId);
      if (!channel) {
        channel = await client.channels.fetch(panelData.channelId);
      }
      if (channel) {
        await updatePanel(null, channel);
        logger.info('Panel restored');
      }
    } catch (error) {
      logger.error('Panel restore failed:', error.message);
    }
  }

  // Start panel refresh
  const panelIntervalId = setInterval(async () => {
    if (panelData.channelId) {
      try {
        await updatePanel();
      } catch (error) {
        // Ignore
      }
    }
  }, PANEL_REFRESH_INTERVAL_MS);
  cleanupFunctions.push(() => clearInterval(panelIntervalId));

  // Start self-destruct polling
  startSelfDestructPolling();
});

// ============================================================================
// GRACEFUL SHUTDOWN
// ============================================================================

async function shutdown(signal) {
  logger.info(`Shutting down (${signal})...`);

  for (const cleanup of cleanupFunctions) {
    if (typeof cleanup === 'function') {
      cleanup();
    }
  }

  client.destroy();
  logger.info('Goodbye!');
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ============================================================================
// SETUP AND START
// ============================================================================

registerCommands(client);
setupHandlers(client);

client.login(config.discord.token)
  .then(() => logger.info('Connecting to Discord...'))
  .catch(error => logger.error('Login failed:', error.message));
