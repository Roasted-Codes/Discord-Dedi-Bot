/**
 * /create Command
 *
 * Create a new game server.
 */

import { SlashCommandBuilder } from 'discord.js';
import { createInstanceFromSnapshot, listInstances, getGroupedRegions } from '../../vultr/index.js';
import { instanceState } from '../../state/instanceState.js';
import { logger } from '../../utils/logger.js';
import { createServerIdentity, getNextServerSequence } from '../../identity/serverIdentity.js';
import { buildVultrUserData } from '../../identity/cloudInit.js';
import {
  formatDediSnapshotDescription,
  getDediSnapshotChoice,
  getDediSnapshotDiscordChoices
} from '../../config/snapshots.js';
import {
  assignXlinkAccount,
  buildXlinkEnv,
  redactXlinkCredentials,
  releaseXlinkAssignment,
  syncXlinkAssignmentsWithInstances,
  updateXlinkAssignmentInstance
} from '../../xlink/credentials.js';
import { buildSelkiesAccess, buildSelkiesEnv } from '../../selkies/access.js';
import { scheduleInteractionReplyCleanup } from '../../services/notifications.js';
import { CREATE_REPLY_CLEANUP_MS } from '../../config/constants.js';

// This will be set by the main entry point
let startInstanceStatusPolling = null;

export function setPollingFunction(fn) {
  startInstanceStatusPolling = fn;
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

async function resolveCityLabel(regionId) {
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
    logger.debug('Falling back to region code for city label:', error.message);
  }

  return String(regionId || '').toUpperCase();
}

async function syncXlinkAssignmentsBeforeAssign() {
  const vultrInstances = await listInstances();
  await syncXlinkAssignmentsWithInstances(vultrInstances);
}

async function handleCreateFailureXlinkCleanup(error, identity) {
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

export const createCommand = {
  data: new SlashCommandBuilder()
    .setName('create')
    .setDescription('Create a new game server')
    .addStringOption(option =>
      option
        .setName('snapshot')
        .setDescription('Snapshot image to create from (optional - defaults to Classic V2)')
        .setRequired(false)
        .addChoices(...getDediSnapshotDiscordChoices()))
    .addStringOption(option =>
      option
        .setName('name')
        .setDescription('A name for your server')
        .setRequired(false))
    .addStringOption(option =>
      option
        .setName('city')
        .setDescription('City to create server in (optional - defaults to Dallas)')
        .setRequired(false)
        .setAutocomplete(true)),

  async execute(interaction) {
    try {
      const selectedCity = interaction.options.getString('city') || 'dfw';
      const selectedSnapshot = interaction.options.getString('snapshot') || undefined;
      const snapshotChoice = getDediSnapshotChoice(selectedSnapshot);
      const snapshotDescription = formatDediSnapshotDescription(snapshotChoice);

      await interaction.editReply(`Creating your ${snapshotChoice.label} server...`);

      const cityLabel = await resolveCityLabel(selectedCity);
      await syncXlinkAssignmentsBeforeAssign();
      const xlink = await assignXlinkAccount({
        region: selectedCity,
        cityLabel,
        creator: interaction.user.username,
        creatorId: interaction.user.id,
        snapshotId: snapshotChoice.id,
        snapshotLabel: snapshotChoice.label
      });
      const identity = createServerIdentity({
        serverId: xlink.assignment.server_id,
        displayName: xlink.assignment.xtag,
        sequence: await getNextIdentitySequence(),
        region: selectedCity,
        creator: interaction.user.username,
        domain: process.env.REALONES_DOMAIN || ''
      });
      const serverName = identity.display_name;
      const xlinkEnv = buildXlinkEnv({
        credentials: xlink.credentials,
        cityLabel
      });
      const selkiesAccess = buildSelkiesAccess();
      const selkiesEnv = buildSelkiesEnv(selkiesAccess);

      let instance;
      try {
        instance = await createInstanceFromSnapshot(
          snapshotChoice.id,
          identity.server_id,
          selectedCity,
          { userData: buildVultrUserData(identity, { extraEnv: { ...xlinkEnv, ...selkiesEnv } }) }
        );
      } catch (error) {
        await handleCreateFailureXlinkCleanup(error, identity);
        throw error;
      }

      if (!instance?.id) {
        await releaseXlinkAssignment({ serverId: identity.server_id });
        return interaction.editReply('Failed to create the server. Please try again later.');
      }

      try {
        await updateXlinkAssignmentInstance(identity.server_id, instance.id);
      } catch (error) {
        logger.warn('XLink assignment instance update failed:', error.message);
      }

      // Track the new instance
      instanceState.trackInstance(
        instance.id,
        interaction.user.id,
        interaction.user.username,
        instance.status || 'creating',
        {
          ip: instance.main_ip,
          name: serverName,
          region: selectedCity,
          serverId: identity.server_id,
          displayName: identity.display_name,
          hostname: identity.hostname,
          friendlyHostname: identity.friendly_hostname,
          realonesSequence: identity.env.REALONES_SERVER_SEQUENCE,
          timerMinutes: 0,
          snapshotKey: snapshotChoice.key,
          snapshotId: snapshotChoice.id,
          snapshotLabel: snapshotChoice.label,
          xlinkXtag: xlink.assignment.xtag,
          xlinkCityLabel: cityLabel,
          selkiesUsername: selkiesAccess.username,
          selkiesPassword: selkiesAccess.password
        }
      );

      const redactedXlink = redactXlinkCredentials(xlink.credentials);
      const initialMessage = await interaction.editReply(
        `Server "${serverName}" creation started in ${selectedCity.toUpperCase()}!\n` +
        `Server ID: \`${identity.server_id}\`\n` +
        `Snapshot: \`${snapshotChoice.label}\`\n` +
        `Snapshot notes: ${snapshotDescription}\n` +
        `Timer: \`none\`\n` +
        `XLink Xtag: \`${redactedXlink.username}\`\n` +
        `XLink arena description: \`${xlinkEnv.XLINK_PRIVATE_ARENA_DESCRIPTION}\`\n` +
        `XLink auto-login: configured\n` +
        `Selkies login: configured\n` +
        `Please be patient - server creation typically takes 15 minutes.\n` +
        `Checking status automatically...\n` +
        `Tip: The server will be ready when its status shows as "running"\n` +
        `Don't forget to use /destroy to delete your server when you're done!`
      );

      // Start automatic status polling if function is available
      if (startInstanceStatusPolling) {
        startInstanceStatusPolling(instance.id, serverName, selectedCity, interaction, initialMessage);
      }
      scheduleInteractionReplyCleanup(interaction, {
        deleteAfterMs: CREATE_REPLY_CLEANUP_MS
      });

    } catch (error) {
      logger.error('Create command failed:', error.message);
      return interaction.editReply(`There was an error creating the server: ${error.message}`);
    }
  }
};
