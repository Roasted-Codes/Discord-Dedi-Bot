/**
 * Autocomplete Handler
 *
 * Handles autocomplete interactions for city and server selection.
 */

import { getGroupedRegions, listInstances } from '../../vultr/index.js';
import { logger } from '../../utils/logger.js';

export async function handleAutocomplete(interaction) {
  const focusedOption = interaction.options.getFocused(true);

  try {
    // City autocomplete for /create
    if (interaction.commandName === 'create' && focusedOption.name === 'city') {
      const focusedValue = focusedOption.value;
      const groupedRegions = await getGroupedRegions();

      const cities = Object.values(groupedRegions)
        .flatMap(countries => Object.values(countries))
        .flat()
        .filter(city =>
          city.city.toLowerCase().includes(focusedValue.toLowerCase()) ||
          city.id.toLowerCase().includes(focusedValue.toLowerCase())
        )
        .map(city => ({
          name: `${city.city} (${city.id.toUpperCase()})`,
          value: city.id
        }))
        .slice(0, 25);

      return await interaction.respond(cities);
    }

    // Server autocomplete for /snapshot
    if (interaction.commandName === 'snapshot' && focusedOption.name === 'server') {
      const focusedValue = focusedOption.value;
      const runningInstances = await listInstances();
      const runningServers = runningInstances.filter(instance =>
        instance.power_status === 'running'
      );

      const servers = runningServers
        .filter(instance => {
          const label = instance.label || 'Unnamed Server';
          return label.toLowerCase().includes(focusedValue.toLowerCase()) ||
                 instance.id.toLowerCase().includes(focusedValue.toLowerCase());
        })
        .map(instance => ({
          name: `${instance.label || 'Unnamed Server'} (${instance.region})`,
          value: instance.id
        }))
        .slice(0, 25);

      return await interaction.respond(servers);
    }

  } catch (error) {
    logger.debug('Error handling autocomplete:', error.message);
    await interaction.respond([]);
  }
}
