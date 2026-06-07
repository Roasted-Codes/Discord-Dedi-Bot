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
import { getDediSnapshotChoice, getDediSnapshotDiscordChoices } from '../../config/snapshots.js';
import {
  assignXlinkAccount,
  buildXlinkEnv,
  redactXlinkCredentials,
  releaseXlinkAssignment,
  updateXlinkAssignmentInstance
} from '../../xlink/credentials.js';

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

export const createCommand = {
  data: new SlashCommandBuilder()
    .setName('create')
    .setDescription('Create a new game server')
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
        .setAutocomplete(true))
    .addStringOption(option =>
      option
        .setName('snapshot')
        .setDescription('Snapshot to use (optional - defaults to Classic)')
        .setRequired(false)
        .addChoices(...getDediSnapshotDiscordChoices())),

  async execute(interaction) {
    try {
      const requestedName = interaction.options.getString('name');
      const selectedCity = interaction.options.getString('city') || 'dfw';
      const snapshotChoice = getDediSnapshotChoice(interaction.options.getString('snapshot'));

      await interaction.editReply(`Creating your ${snapshotChoice.label} server...`);

      const identity = createServerIdentity({
        gamertag: requestedName || undefined,
        sequence: await getNextIdentitySequence(),
        region: selectedCity,
        creator: interaction.user.username,
        domain: process.env.REALONES_DOMAIN || 'realones.gg'
      });
      const serverName = identity.display_name;
      const cityLabel = await resolveCityLabel(selectedCity);

      const xlink = await assignXlinkAccount({
        serverId: identity.server_id,
        region: selectedCity,
        cityLabel,
        creator: interaction.user.username
      });
      const xlinkEnv = buildXlinkEnv({
        credentials: xlink.credentials,
        cityLabel
      });

      let instance;
      try {
        instance = await createInstanceFromSnapshot(
          snapshotChoice.id,
          identity.server_id,
          selectedCity,
          { userData: buildVultrUserData(identity, { extraEnv: xlinkEnv }) }
        );
      } catch (error) {
        await releaseXlinkAssignment({ serverId: identity.server_id });
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
          snapshotKey: snapshotChoice.key,
          snapshotId: snapshotChoice.id,
          snapshotLabel: snapshotChoice.label,
          xlinkXtag: xlink.assignment.xtag,
          xlinkCityLabel: cityLabel
        }
      );

      const redactedXlink = redactXlinkCredentials(xlink.credentials);
      const initialMessage = await interaction.editReply(
        `Server "${serverName}" creation started in ${selectedCity.toUpperCase()}!\n` +
        `Server ID: \`${identity.server_id}\`\n` +
        `Snapshot: \`${snapshotChoice.label}\`\n` +
        `XLink Xtag: \`${redactedXlink.username}\`\n` +
        `XLink arena description: \`RealOnesV2 - ${cityLabel}\`\n` +
        `XLink auto-login: configured\n` +
        `Please be patient - server creation typically takes 15 minutes.\n` +
        `Checking status automatically...\n` +
        `Tip: The server will be ready when its status shows as "running"\n` +
        `Don't forget to use /destroy to delete your server when you're done!`
      );

      // Start automatic status polling if function is available
      if (startInstanceStatusPolling) {
        startInstanceStatusPolling(instance.id, serverName, selectedCity, interaction, initialMessage);
      }

    } catch (error) {
      logger.error('Create command failed:', error.message);
      return interaction.editReply(`There was an error creating the server: ${error.message}`);
    }
  }
};
