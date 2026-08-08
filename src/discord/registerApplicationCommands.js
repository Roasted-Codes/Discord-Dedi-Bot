import { Routes } from 'discord.js';

export async function registerApplicationCommands({ rest, applicationId, guildId, commands }) {
  if (guildId) {
    await rest.put(
      Routes.applicationGuildCommands(applicationId, guildId),
      { body: commands }
    );
    await rest.put(Routes.applicationCommands(applicationId), { body: [] });
    return 'guild';
  }

  await rest.put(Routes.applicationCommands(applicationId), { body: commands });
  return 'global';
}
