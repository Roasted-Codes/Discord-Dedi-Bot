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
import {
  createDiscordClient,
  REST,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  AttachmentBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags
} from './discord/client.js';
import { fileURLToPath } from 'url';
import path from 'path';
import { randomUUID } from 'crypto';
import { commands, registerCommands } from './discord/commands/index.js';
import { registerApplicationCommands } from './discord/registerApplicationCommands.js';
import {
  setupHandlers,
  setDestructionPollingFunction,
  setPanelExecutors,
  setModalPanelFunction,
  setModalManualRestoreFunction
} from './discord/handlers/index.js';
import { setPollingFunction } from './discord/commands/create.js';
import { setSnapshotPollingFunction } from './discord/commands/snapshot.js';
import { setPanelFunction } from './discord/commands/panel.js';
import { instanceState } from './state/instanceState.js';
import { panelData, savePanelData } from './state/panelState.js';
import {
  vultr,
  listInstances,
  getInstance,
  getGroupedRegions,
  calculateInstanceCost,
  isCurrentServer,
  createInstanceFromSnapshot,
  getSnapshotRestoreSpec,
  getSnapshots,
  getBotManagedSnapshots,
  getCleanSnapshotName,
  hasSnapshotPermission
} from './vultr/index.js';
import {
  buildSelkiesUrl,
  buildXlinkUrl,
  sendAutoCleanupFollowUp,
  sendServerCreationDM,
  sendServerDestructionDM
} from './services/notifications.js';
import { formatStatus, formatRemainingTime, formatInstanceDetails } from './utils/formatters.js';
import { logger } from './utils/logger.js';
import { createServerIdentity, getNextServerSequence } from './identity/serverIdentity.js';
import { buildVultrUserData } from './identity/cloudInit.js';
import {
  DEFAULT_DEDI_SNAPSHOT_KEY,
  formatDediSnapshotDescription,
  getDediSnapshotChoice,
  getDediSnapshotChoiceById
} from './config/snapshots.js';
import {
  assignXlinkAccount,
  buildXlinkEnv,
  releaseXlinkAssignment,
  syncXlinkAssignmentsWithInstances,
  updateXlinkAssignmentInstance
} from './xlink/credentials.js';
import { buildSelkiesAccess, buildSelkiesEnv } from './selkies/access.js';
import {
  reconcileSelkiesRoutes,
  removeSelkiesRoute,
  upsertSelkiesRoute
} from './selkies/routes.js';

// Create Discord client
const client = createDiscordClient();

// Track cleanup functions for graceful shutdown
const cleanupFunctions = [];

// Banner image path
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bannerPath = path.join(__dirname, '../assets/h2_banner.png');
const PANEL_DUPLICATE_CLEANUP_INTERVAL_MS = 60 * 1000;
const PANEL_BUTTON_IDS = new Set([
  'btn_create_modal',
  'btn_destroy',
  'btn_restart',
  'btn_insert_coin',
  'btn_restore_snapshot'
]);

function isPanelButtonId(customId) {
  return PANEL_BUTTON_IDS.has(customId) || customId?.startsWith('btn_quick_');
}

function getMessageComponentIds(message) {
  const ids = [];
  for (const row of message?.components || []) {
    for (const component of row.components || []) {
      const customId = component.customId || component.custom_id;
      if (customId) ids.push(customId);
    }
  }
  return ids;
}

function isBotPanelMessage(message) {
  if (!message || message.author?.id !== client.user?.id) return false;

  const content = message.content || '';
  const componentIds = getMessageComponentIds(message);

  return content.includes('Quick Create: Click a city button') ||
    componentIds.some(isPanelButtonId);
}

function panelMessageFreshness(message) {
  const editedAt = message.editedTimestamp || 0;
  const createdAt = message.createdTimestamp || 0;
  return Math.max(editedAt, createdAt);
}

async function getNextIdentitySequence() {
  try {
    const vultrInstances = await listInstances();
    return getNextServerSequence([
      ...instanceState.instances,
      ...vultrInstances.map(instance => ({
        server_id: instance.label,
        label: instance.label,
        name: instance.label
      }))
    ]);
  } catch (error) {
    logger.debug('Falling back to bot-local server sequence:', error.message);
    return getNextServerSequence(instanceState.instances);
  }
}

async function resolveCityName(regionId) {
  try {
    const groupedRegions = await getGroupedRegions();
    for (const countries of Object.values(groupedRegions)) {
      for (const cities of Object.values(countries)) {
        const city = cities.find(candidate => candidate.id === regionId);
        if (city) {
          return city.city;
        }
      }
    }
  } catch (error) {
    logger.debug('Falling back to region code for city name:', error.message);
  }

  return String(regionId || '').toUpperCase();
}

async function syncXlinkAssignmentsBeforeAssign() {
  const instances = await listInstances();
  await syncXlinkAssignmentsWithInstances(instances);
}

async function handleCreateFailureXlinkCleanup(error, identity) {
  if (!identity) return;

  if (error.keepXlinkAssignment && error.instanceId) {
    try {
      await updateXlinkAssignmentInstance(identity.server_id, error.instanceId);
      logger.warn(`Kept XLink assignment ${identity.server_id} for unconfirmed instance ${error.instanceId.slice(0, 8)}...`);
    } catch (updateError) {
      logger.error('Failed to pin XLink assignment to unconfirmed instance:', updateError.message);
    }
    return;
  }

  await releaseXlinkAssignment({ serverId: identity.server_id });
}

async function registerSelkiesRouteForInstance(instanceId, instance, trackedInstance = null) {
  const tracked = trackedInstance || instanceState.getInstance(instanceId);
  if (!tracked?.selkiesUsername || !tracked?.selkiesPassword) {
    return null;
  }

  return upsertSelkiesRoute({
    instanceId,
    serverId: tracked.serverId || instance.label || tracked.name,
    ip: instance.main_ip || tracked.ip,
    creatorId: tracked.creator?.id,
    selkiesUsername: tracked.selkiesUsername,
    selkiesPassword: tracked.selkiesPassword
  });
}

function getSnapshotDisplayName(snapshot) {
  return getCleanSnapshotName(snapshot) || snapshot.description || snapshot.id;
}

const RESTORE_SNAPSHOT_PAGE_SIZE = 25;
const RESTORE_CONFIRM_TTL_MS = 15 * 60 * 1000;
const pendingManualRestores = new Map();

function truncateDiscordText(value, maxLength) {
  const text = String(value || '');
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

function getSnapshotShortId(snapshotOrId) {
  const id = typeof snapshotOrId === 'string' ? snapshotOrId : snapshotOrId?.id;
  return id ? id.slice(-8) : 'unknown';
}

function formatSnapshotDate(snapshot) {
  if (!snapshot?.date_created) return 'unknown date';
  const date = new Date(snapshot.date_created);
  if (Number.isNaN(date.getTime())) return 'unknown date';
  return date.toISOString().slice(0, 10);
}

function formatSnapshotSize(snapshot) {
  if (typeof snapshot?.size !== 'number' || snapshot.size <= 0) return 'unknown size';
  const sizeGb = snapshot.size > 1024 ? snapshot.size / (1024 ** 3) : snapshot.size;
  return `${Math.round(sizeGb)}GB`;
}

function formatSnapshotOptionDescription(snapshot) {
  return truncateDiscordText(
    `${formatSnapshotDate(snapshot)} | ${formatSnapshotSize(snapshot)} | ID ...${getSnapshotShortId(snapshot)}`,
    100
  );
}

function buildRestoreSnapshotPickerPayload(snapshots, requestedPage = 0) {
  const pageCount = Math.max(1, Math.ceil(snapshots.length / RESTORE_SNAPSHOT_PAGE_SIZE));
  const page = Math.min(Math.max(requestedPage, 0), pageCount - 1);
  const pageSnapshots = snapshots.slice(
    page * RESTORE_SNAPSHOT_PAGE_SIZE,
    (page + 1) * RESTORE_SNAPSHOT_PAGE_SIZE
  );

  const components = [];
  if (pageSnapshots.length) {
    components.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('restore_snapshot_select')
        .setPlaceholder('Choose a snapshot to restore')
        .addOptions(pageSnapshots.map(snapshot => ({
          label: truncateDiscordText(getSnapshotDisplayName(snapshot), 100),
          description: formatSnapshotOptionDescription(snapshot),
          value: snapshot.id
        })))
    ));
  }

  const navRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`restore_snapshot_page_${page - 1}`)
      .setLabel('Previous')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 0),
    new ButtonBuilder()
      .setCustomId(`restore_snapshot_page_${page + 1}`)
      .setLabel('Next')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= pageCount - 1 || snapshots.length === 0),
    new ButtonBuilder()
      .setCustomId(`restore_snapshot_refresh_${page}`)
      .setLabel('Refresh')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('restore_snapshot_advanced')
      .setLabel('Advanced: ID')
      .setStyle(ButtonStyle.Secondary)
  );
  components.push(navRow);

  const content = snapshots.length
    ? `**Restore Snapshot**\n\nChoose a bot-managed snapshot. Showing ${page + 1}/${pageCount}.`
    : '**Restore Snapshot**\n\nNo bot-managed snapshots were found. Use Advanced only if you have a raw Vultr snapshot ID.';

  return { content, components };
}

function storePendingManualRestore(payload) {
  const token = randomUUID();
  pendingManualRestores.set(token, {
    ...payload,
    createdAt: Date.now(),
    expiresAt: Date.now() + RESTORE_CONFIRM_TTL_MS
  });

  setTimeout(() => pendingManualRestores.delete(token), RESTORE_CONFIRM_TTL_MS);
  return token;
}

// ============================================================================
// POLLING FUNCTIONS
// ============================================================================

async function initializeSelfDestructTimer(instanceId) {
  const trackedInstance = instanceState.getInstance(instanceId);
  if (!trackedInstance) return;

  if (trackedInstance.selfDestructTimer) return;

  // Use custom timer if set, otherwise use default
  const timerMinutes = trackedInstance.timerMinutes ?? SELF_DESTRUCT_INITIAL_MINUTES;

  // timerMinutes of 0 means no timer
  if (timerMinutes === 0) {
    logger.debug(`No timer set for ${instanceId.slice(0, 8)}...`);
    return;
  }

  const now = Date.now();
  const expiresAt = now + (timerMinutes * 60 * 1000);

  instanceState.updateInstance(instanceId, trackedInstance.status, {
    selfDestructTimer: {
      expiresAt,
      initialDuration: timerMinutes * 60 * 1000,
      extendedCount: 0,
      warningsSent: []
    }
  });

  logger.debug(`Timer set for ${instanceId.slice(0, 8)}...: ${timerMinutes}min`);
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
            const trackedInstance = instanceState.getInstance(instanceId);
            await sendServerCreationDM(interaction.user, {
              serverName,
              region,
              ip: instance.main_ip,
              elapsedMinutes,
              serverId: trackedInstance?.serverId,
              hostname: trackedInstance?.hostname,
              friendlyHostname: trackedInstance?.friendlyHostname,
              snapshotLabel: trackedInstance?.snapshotLabel,
              selkiesUsername: trackedInstance?.selkiesUsername,
              selkiesPassword: trackedInstance?.selkiesPassword
            });
          } catch (e) {
            logger.debug('Failed to send creation DM:', e.message);
          }
        }

        try {
          await registerSelkiesRouteForInstance(instanceId, instance);
        } catch (error) {
          logger.warn(`Failed to register Selkies route for ${instanceId.slice(0, 8)}...: ${error.message}`);
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
        await removeSelkiesRoute({ instanceId });
        await releaseXlinkAssignment({ vultrInstanceId: instanceId });
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
        await removeSelkiesRoute({ instanceId });
        await releaseXlinkAssignment({ vultrInstanceId: instanceId });
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
        .setCustomId('btn_restore_snapshot')
        .setLabel('Restore Snapshot')
        .setStyle(ButtonStyle.Secondary)
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
          .setStyle(ButtonStyle.Primary)
      );
    });

    quickCities.slice(5, 10).forEach(city => {
      row3.addComponents(
        new ButtonBuilder()
          .setCustomId(`btn_quick_${city.id}`)
          .setLabel(city.name)
          .setStyle(ButtonStyle.Primary)
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
        const linkDetails = {
          ip: instance.main_ip,
          serverId: tracked?.serverId || instance.label,
          serverName,
          hostname: tracked?.hostname,
          friendlyHostname: tracked?.friendlyHostname
        };
        const selkiesUrl = buildSelkiesUrl(linkDetails);
        const xlinkUrl = buildXlinkUrl(linkDetails);

        if (selkiesUrl) {
          content += `> Selkies: ${selkiesUrl}\n`;
        }

        if (xlinkUrl) {
          content += `> XLink Kai: ${xlinkUrl}\n`;
        }
      } else if (isCreating) {
        content += `> Waiting for IP...\n`;
      }

      if (tracked?.selfDestructTimer) {
        const timeStr = formatRemainingTime(tracked.selfDestructTimer.expiresAt);
        content += `> Timer: ${timeStr}\n`;
      }

      const snapshotLabel = tracked?.snapshotLabel ||
        getDediSnapshotChoiceById(instance.snapshot_id)?.label;
      if (snapshotLabel) {
        content += `> Snapshot: ${snapshotLabel}\n`;
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
let lastPanelDuplicateCleanupAt = 0;

async function findPanelMessages(channel) {
  const messages = await channel.messages.fetch({ limit: 100 });
  return [...messages.values()]
    .filter(isBotPanelMessage)
    .sort((a, b) => panelMessageFreshness(b) - panelMessageFreshness(a));
}

async function resolveCanonicalPanelMessage(channel) {
  if (panelData.messageId) {
    try {
      const message = await channel.messages.fetch(panelData.messageId);
      if (isBotPanelMessage(message)) {
        return message;
      }
    } catch (error) {
      logger.warn(`Saved panel message ${panelData.messageId} could not be fetched: ${error.message}`);
    }
  }

  const panelMessages = await findPanelMessages(channel);
  const canonical = panelMessages[0] || null;
  if (canonical) {
    panelData.messageId = canonical.id;
    panelData.channelId = channel.id;
    savePanelData();
    logger.warn(`Recovered canonical panel message ${canonical.id}`);
  }

  return canonical;
}

async function retireDuplicatePanelMessage(message) {
  try {
    await message.delete();
    logger.info(`Deleted duplicate panel message ${message.id}`);
    return;
  } catch (deleteError) {
    logger.warn(`Could not delete duplicate panel ${message.id}: ${deleteError.message}`);
  }

  try {
    await message.edit({
      content: 'Superseded control panel. Use the latest panel message.',
      components: [],
      attachments: []
    });
    logger.info(`Disabled duplicate panel message ${message.id}`);
  } catch (editError) {
    logger.warn(`Could not disable duplicate panel ${message.id}: ${editError.message}`);
  }
}

async function cleanupDuplicatePanelMessages(channel, canonicalMessageId, force = false) {
  const now = Date.now();
  if (!force && now - lastPanelDuplicateCleanupAt < PANEL_DUPLICATE_CLEANUP_INTERVAL_MS) {
    return;
  }

  lastPanelDuplicateCleanupAt = now;

  try {
    const panelMessages = await findPanelMessages(channel);
    const duplicateMessages = panelMessages.filter(message => message.id !== canonicalMessageId);

    for (const message of duplicateMessages) {
      await retireDuplicatePanelMessage(message);
    }

    if (duplicateMessages.length > 0) {
      logger.info(`Retired ${duplicateMessages.length} duplicate panel message(s)`);
    }
  } catch (error) {
    logger.warn(`Duplicate panel cleanup failed: ${error.message}`);
  }
}

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

    const timestamp = new Date().toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZone: 'UTC'
    }) + ' GMT';

    const content =
      `Running: ${stats.running} | Stopped: ${stats.stopped} | Total: ${stats.total}\n` +
      `${serverContent}\n` +
      `*Quick Create: Click a city button*\n` +
      `─────────────────\n` +
      `✅ Online • ${timestamp}`;

    const banner = new AttachmentBuilder(bannerPath);

    let panelMessage = await resolveCanonicalPanelMessage(targetChannel);
    let createdPanel = false;

    if (panelMessage) {
      await panelMessage.edit({ content, files: [banner], components });
      panelData.messageId = panelMessage.id;
      panelData.channelId = targetChannel.id;
      savePanelData();
    } else {
      const newMessage = await targetChannel.send({ content, files: [banner], components });
      panelData.messageId = newMessage.id;
      panelData.channelId = targetChannel.id;
      savePanelData();
      panelMessage = newMessage;
      createdPanel = true;
    }

    await cleanupDuplicatePanelMessages(
      targetChannel,
      panelMessage.id,
      createdPanel || Boolean(interaction)
    );

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

async function executeManualRestoreFromPanel(interaction) {
  if (!hasSnapshotPermission(interaction.user.id)) {
    return interaction.reply({
      content: 'You do not have permission to restore snapshots.',
      flags: MessageFlags.Ephemeral
    });
  }

  const snapshots = await getBotManagedSnapshots();
  return interaction.reply({
    ...buildRestoreSnapshotPickerPayload(snapshots, 0),
    flags: MessageFlags.Ephemeral
  });
}

async function executeRestoreSnapshotPage(interaction, page = 0) {
  if (!hasSnapshotPermission(interaction.user.id)) {
    return interaction.reply({
      content: 'You do not have permission to restore snapshots.',
      flags: MessageFlags.Ephemeral
    });
  }

  try {
    await interaction.deferUpdate();
  } catch (error) {
    if (error.code === 10062) return;
    throw error;
  }

  const snapshots = await getBotManagedSnapshots();
  await interaction.editReply(buildRestoreSnapshotPickerPayload(snapshots, page));
}

async function executeAdvancedManualRestore(interaction) {
  if (!hasSnapshotPermission(interaction.user.id)) {
    return interaction.reply({
      content: 'You do not have permission to manually restore snapshots.',
      flags: MessageFlags.Ephemeral
    });
  }

  const modal = new ModalBuilder()
    .setCustomId('manual_restore_snapshot_modal')
    .setTitle('Advanced Snapshot Restore');

  const snapshotInput = new TextInputBuilder()
    .setCustomId('snapshot_id')
    .setLabel('Snapshot ID')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx')
    .setRequired(true)
    .setMaxLength(36);

  const nameInput = new TextInputBuilder()
    .setCustomId('server_name')
    .setLabel('Server Name note (optional)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('Final Vultr/StatsBorg name comes from XLink')
    .setRequired(false)
    .setMaxLength(50);

  const cityInput = new TextInputBuilder()
    .setCustomId('server_city')
    .setLabel('City/Region')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('dfw')
    .setRequired(true)
    .setMaxLength(10);

  const timerInput = new TextInputBuilder()
    .setCustomId('timer_minutes')
    .setLabel('Timer minutes (0 = no timer)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('210')
    .setRequired(true)
    .setMaxLength(4);

  modal.addComponents(
    new ActionRowBuilder().addComponents(snapshotInput),
    new ActionRowBuilder().addComponents(nameInput),
    new ActionRowBuilder().addComponents(cityInput),
    new ActionRowBuilder().addComponents(timerInput)
  );

  await interaction.showModal(modal);
}

async function executeManualRestoreConfirmation(interaction, {
  snapshotId,
  requestedName,
  regionId,
  timerMinutes,
  allowUnmanaged = false
}) {
  if (!hasSnapshotPermission(interaction.user.id)) {
    return interaction.editReply('You do not have permission to restore snapshots.');
  }

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(snapshotId)) {
    return interaction.editReply('Invalid snapshot ID format.');
  }

  const snapshots = allowUnmanaged ? await getSnapshots() : await getBotManagedSnapshots();
  const snapshot = snapshots.find(candidate => candidate.id === snapshotId);
  if (!snapshot) {
    return interaction.editReply(allowUnmanaged
      ? `Snapshot \`${snapshotId}\` was not found in this Vultr account.`
      : 'That snapshot is not available in the normal restore picker. Use Refresh or Advanced if needed.');
  }
  if (snapshot.status !== 'complete') {
    return interaction.editReply(`Snapshot "${getSnapshotDisplayName(snapshot)}" is not complete yet. Current status: ${snapshot.status || 'unknown'}.`);
  }

  const cityName = await resolveCityName(regionId);
  const snapshotLabel = getSnapshotDisplayName(snapshot);
  const restoreSpec = getSnapshotRestoreSpec(snapshot.id);
  const token = storePendingManualRestore({
    userId: interaction.user.id,
    snapshotId,
    requestedName,
    regionId,
    timerMinutes,
    cityName,
    snapshotLabel
  });

  const confirmRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`restore_snapshot_confirm_${token}`)
      .setLabel('Restore')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`restore_snapshot_cancel_${token}`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary)
  );

  return interaction.editReply({
    content:
      `**Confirm Snapshot Restore**\n\n` +
      `Snapshot: **${snapshotLabel}**\n` +
      `Created: ${formatSnapshotDate(snapshot)}\n` +
      `Snapshot ID: \`${snapshot.id}\` (...${getSnapshotShortId(snapshot)})\n` +
      `Region: ${cityName} (${regionId.toUpperCase()})\n` +
      `Server name: assigned XLink account\n` +
      `Timer: ${timerMinutes === 0 ? 'none' : `${timerMinutes} minutes`}\n` +
      `Plan: \`${restoreSpec.plan}\` (${restoreSpec.planSource})\n` +
      `${restoreSpec.sourceSummary ? `Source spec: ${restoreSpec.sourceSummary}\n` : ''}\n` +
      `Click Restore to create the server from this snapshot.`,
    components: [confirmRow]
  });
}

async function executeConfirmManualRestore(interaction, token) {
  const pending = pendingManualRestores.get(token);

  try {
    await interaction.deferUpdate();
  } catch (error) {
    if (error.code === 10062) return;
    throw error;
  }

  if (!pending) {
    return interaction.editReply({
      content: 'This restore confirmation expired. Start restore again.',
      components: []
    });
  }

  if (pending.userId !== interaction.user.id) {
    return interaction.editReply({
      content: 'Only the user who prepared this restore can confirm it.',
      components: []
    });
  }

  if (Date.now() > pending.expiresAt) {
    pendingManualRestores.delete(token);
    return interaction.editReply({
      content: 'This restore confirmation expired. Start restore again.',
      components: []
    });
  }

  pendingManualRestores.delete(token);
  await interaction.editReply({
    content: `Restoring from **${pending.snapshotLabel}**...`,
    components: []
  });

  await executeManualRestoreFromSnapshot(interaction, pending);
}

async function executeCancelManualRestore(interaction, token) {
  pendingManualRestores.delete(token);

  try {
    await interaction.deferUpdate();
  } catch (error) {
    if (error.code === 10062) return;
    throw error;
  }

  await interaction.editReply({
    content: 'Snapshot restore cancelled.',
    components: []
  });
}

async function executeQuickCreate(interaction, regionId) {
  return executeQuickCreateWithTimer(interaction, regionId, 0);
}

async function executeManualRestoreFromSnapshot(interaction, {
  snapshotId,
  requestedName,
  regionId,
  timerMinutes,
  cityName: preparedCityName = null,
  snapshotLabel: preparedSnapshotLabel = null
}) {
  let identity = null;
  let xlink = null;

  try {
    if (!hasSnapshotPermission(interaction.user.id)) {
      return interaction.editReply('You do not have permission to manually restore snapshots.');
    }

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(snapshotId)) {
      return interaction.editReply('Invalid snapshot ID format.');
    }

    const snapshots = await getSnapshots();
    const snapshot = snapshots.find(candidate => candidate.id === snapshotId);
    if (!snapshot) {
      return interaction.editReply(`Snapshot \`${snapshotId}\` was not found in this Vultr account.`);
    }
    if (snapshot.status !== 'complete') {
      return interaction.editReply(`Snapshot "${getSnapshotDisplayName(snapshot)}" is not complete yet. Current status: ${snapshot.status || 'unknown'}.`);
    }

    const cityName = preparedCityName || await resolveCityName(regionId);
    const snapshotLabel = preparedSnapshotLabel || getSnapshotDisplayName(snapshot);

    await syncXlinkAssignmentsBeforeAssign();
    xlink = await assignXlinkAccount({
      region: regionId,
      cityLabel: cityName,
      creator: interaction.user.username
    });
    identity = createServerIdentity({
      serverId: xlink.assignment.server_id,
      displayName: xlink.assignment.xtag,
      sequence: await getNextIdentitySequence(),
      region: regionId,
      creator: interaction.user.username,
      domain: process.env.REALONES_DOMAIN || ''
    });
    const serverName = identity.display_name;
    const xlinkEnv = buildXlinkEnv({
      credentials: xlink.credentials,
      cityLabel: cityName
    });
    const selkiesAccess = buildSelkiesAccess();
    const selkiesEnv = buildSelkiesEnv(selkiesAccess);

    const instance = await createInstanceFromSnapshot(
      snapshot.id,
      identity.server_id,
      regionId,
      { userData: buildVultrUserData(identity, { extraEnv: { ...xlinkEnv, ...selkiesEnv } }) }
    );

    if (!instance?.id) {
      await releaseXlinkAssignment({ serverId: identity.server_id });
      return interaction.editReply('Failed to restore snapshot. Please try again later.');
    }

    try {
      await updateXlinkAssignmentInstance(identity.server_id, instance.id);
    } catch (error) {
      logger.warn('XLink assignment instance update failed:', error.message);
    }

    instanceState.trackInstance(
      instance.id,
      interaction.user.id,
      interaction.user.username,
      'creating',
      {
        name: serverName,
        region: regionId,
        timerMinutes,
        serverId: identity.server_id,
        displayName: identity.display_name,
        hostname: identity.hostname,
        friendlyHostname: identity.friendly_hostname,
        realonesSequence: identity.env.REALONES_SERVER_SEQUENCE,
        snapshotKey: 'manual',
        snapshotId: snapshot.id,
        snapshotLabel,
        xlinkXtag: xlink.assignment.xtag,
        xlinkCityLabel: cityName,
        selkiesUsername: selkiesAccess.username,
        selkiesPassword: selkiesAccess.password
      }
    );

    await interaction.editReply(
      `Restoring "${serverName}" in ${cityName} (${regionId.toUpperCase()}).\n` +
      `Server ID: \`${identity.server_id}\`\n` +
      `Snapshot: \`${snapshotLabel}\`\n` +
      `Snapshot ID: \`${snapshot.id}\`\n` +
      `XLink Xtag: \`${xlink.assignment.xtag}\`\n` +
      `Timer: ${timerMinutes === 0 ? 'none' : `${timerMinutes} minutes`}\n` +
      `XLink auto-login: configured\n` +
      `Selkies login: configured`
    );

    startInstanceStatusPolling(instance.id, serverName, regionId, interaction, null, true);
    setTimeout(() => updatePanel(), 5000);
  } catch (error) {
    if (identity && xlink) {
      await handleCreateFailureXlinkCleanup(error, identity);
    }
    logger.error('Manual snapshot restore failed:', error.message);
    await interaction.editReply(`Manual restore failed: ${error.message}`);
  }
}

async function executeQuickCreateWithTimer(
  interaction,
  regionId,
  timerMinutes,
  snapshotKey = DEFAULT_DEDI_SNAPSHOT_KEY
) {
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

  let identity = null;
  let xlink = null;

  try {
    const { createInstanceFromSnapshot } = await import('./vultr/index.js');
    const snapshotChoice = getDediSnapshotChoice(snapshotKey);
    await syncXlinkAssignmentsBeforeAssign();
    xlink = await assignXlinkAccount({
      region: regionId,
      cityLabel: cityName,
      creator: interaction.user.username
    });
    identity = createServerIdentity({
      serverId: xlink.assignment.server_id,
      displayName: xlink.assignment.xtag,
      sequence: await getNextIdentitySequence(),
      region: regionId,
      creator: interaction.user.username,
      domain: process.env.REALONES_DOMAIN || ''
    });
    const serverName = identity.display_name;
    const xlinkEnv = buildXlinkEnv({
      credentials: xlink.credentials,
      cityLabel: cityName
    });
    const selkiesAccess = buildSelkiesAccess();
    const selkiesEnv = buildSelkiesEnv(selkiesAccess);

    const instance = await createInstanceFromSnapshot(
      snapshotChoice.id,
      identity.server_id,
      regionId,
      { userData: buildVultrUserData(identity, { extraEnv: { ...xlinkEnv, ...selkiesEnv } }) }
    );

    if (instance?.id) {
      try {
        await updateXlinkAssignmentInstance(identity.server_id, instance.id);
      } catch (error) {
        logger.warn('XLink assignment instance update failed:', error.message);
      }
      instanceState.trackInstance(
        instance.id,
        interaction.user.id,
        interaction.user.username,
        'creating',
        {
          name: serverName,
          region: regionId,
          timerMinutes: 0,
          serverId: identity.server_id,
          displayName: identity.display_name,
          hostname: identity.hostname,
          friendlyHostname: identity.friendly_hostname,
          realonesSequence: identity.env.REALONES_SERVER_SEQUENCE,
          snapshotKey: snapshotChoice.key,
          snapshotId: snapshotChoice.id,
          snapshotLabel: snapshotChoice.label,
          xlinkXtag: xlink.assignment.xtag,
          xlinkCityLabel: cityName,
          selkiesUsername: selkiesAccess.username,
          selkiesPassword: selkiesAccess.password
        }
      );

      await sendAutoCleanupFollowUp(interaction,
        `Creating "${serverName}" in ${cityName} (${regionId.toUpperCase()}).\n` +
        `Server ID: \`${identity.server_id}\`\n` +
        `Snapshot: \`${snapshotChoice.label}\`\n` +
        `Snapshot notes: ${formatDediSnapshotDescription(snapshotChoice)}\n` +
        `Timer: \`none\`\n` +
        `XLink Xtag: \`${xlink.assignment.xtag}\`\n` +
        `XLink auto-login: configured\n` +
        `Selkies login: configured`
      );
      startInstanceStatusPolling(instance.id, serverName, regionId, interaction, null, true);
      setTimeout(() => updatePanel(), 5000);
    } else {
      await releaseXlinkAssignment({ serverId: identity.server_id });
      await sendAutoCleanupFollowUp(interaction, 'Failed to create server.');
    }
  } catch (error) {
    if (identity && xlink) {
      await handleCreateFailureXlinkCleanup(error, identity);
    }
    if (error.message !== 'No snapshots available.') {
      logger.debug('Quick create error cleanup path:', error.message);
    }
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
            await removeSelkiesRoute({
              instanceId: tracked.id,
              serverId: tracked.serverId
            });
            await releaseXlinkAssignment({
              vultrInstanceId: tracked.id,
              serverId: tracked.serverId
            });

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
setPanelFunction(updatePanel);
setDestructionPollingFunction(startInstanceDestructionPolling);
setModalPanelFunction(updatePanel);
setModalManualRestoreFunction(executeManualRestoreConfirmation);
setPanelExecutors({
  destroy: executeDestroyFromPanel,
  restart: executeRestartFromPanel,
  manualRestore: executeManualRestoreFromPanel,
  restoreSnapshotPage: executeRestoreSnapshotPage,
  advancedManualRestore: executeAdvancedManualRestore,
  confirmManualRestore: executeConfirmManualRestore,
  cancelManualRestore: executeCancelManualRestore,
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
    await syncXlinkAssignmentsWithInstances(testResponse.instances || []);
    try {
      await reconcileSelkiesRoutes(testResponse.instances || []);
    } catch (error) {
      logger.warn(`Selkies route reconciliation failed: ${error.message}`);
    }

    // Recover existing instances
    if (testResponse.instances) {
      let recoveredCount = 0;
      for (const instance of testResponse.instances) {
        if (await isCurrentServer(instance.id)) continue;
        const snapshotChoice = getDediSnapshotChoiceById(instance.snapshot_id);

        instanceState.trackInstance(
          instance.id,
          'unknown',
          'System Recovery',
          instance.power_status,
          {
            ip: instance.main_ip,
            name: instance.label || 'Recovered Server',
            region: instance.region,
            snapshotKey: snapshotChoice?.key,
            snapshotId: snapshotChoice?.id,
            snapshotLabel: snapshotChoice?.label
          }
        );
        recoveredCount++;
      }
      if (recoveredCount > 0) {
        logger.info(`Recovered ${recoveredCount} instance(s)`);
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
    const commandScope = await registerApplicationCommands({
      rest,
      applicationId: client.user.id,
      guildId: config.discord.guildId,
      commands: commandData
    });

    logger.info(`Commands registered (${commandScope})`);
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
