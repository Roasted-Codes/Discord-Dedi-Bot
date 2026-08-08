function truncateDiscordText(value, maxLength) {
  const text = String(value || '');
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function formatServerPanelHeading({
  statusEmoji,
  serverName,
  statusText = '',
  locked = false
}) {
  const protectionEmoji = locked ? ' 🔒' : '';
  return `${statusEmoji}${protectionEmoji} **${serverName || 'Unnamed Server'}**${statusText}\n`;
}

export function formatServerProtectionLine(locked) {
  return locked ? '> Protection: Locked by an administrator\n' : '';
}

export function buildDestroyOption(instance, locked = false) {
  const label = truncateDiscordText(instance?.label || 'Unnamed Server', 100);
  if (locked) {
    return {
      label,
      description: 'LOCKED — protected by an administrator; select for details',
      value: instance.id,
      emoji: { name: '🔒' }
    };
  }

  const status = instance?.power_status || instance?.status || 'unknown';
  const region = String(instance?.region || 'unknown').toUpperCase();
  const ip = instance?.main_ip && instance.main_ip !== '0.0.0.0'
    ? ` | IP: ${instance.main_ip}`
    : '';

  return {
    label,
    description: truncateDiscordText(`Status: ${status}${ip} | Region: ${region}`, 100),
    value: instance.id
  };
}

export function buildServerLockOption(instance, locked = false) {
  return {
    label: truncateDiscordText(instance?.label || 'Unnamed Server', 100),
    description: locked
      ? 'Locked — select to unlock this server'
      : 'Unlocked — select to lock and cancel its self-destruct timer',
    value: `${locked ? 'unlock' : 'lock'}:${instance.id}`,
    emoji: { name: locked ? '🔒' : '🔓' }
  };
}
