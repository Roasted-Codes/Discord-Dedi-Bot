/**
 * Discord Client Setup
 *
 * Creates and exports the Discord.js client instance with required intents.
 * Also re-exports common Discord.js components for use throughout the application.
 */

import {
  Client,
  GatewayIntentBits,
  Collection,
  REST,
  Routes,
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags
} from 'discord.js';

/**
 * Create and configure the Discord client
 * @returns {Client} Configured Discord client instance
 */
export function createDiscordClient() {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds]
  });

  // Collection to store command handlers
  client.commands = new Collection();

  return client;
}

// Re-export Discord.js components for use in other modules
export {
  Client,
  GatewayIntentBits,
  Collection,
  REST,
  Routes,
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags
};
