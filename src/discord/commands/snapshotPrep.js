/**
 * /snapshot-prep Command
 *
 * Admin-only check/apply workflow for cleaning a source VPS before snapshotting.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { getAnyInstance, hasSnapshotPermission } from '../../vultr/index.js';
import { logger } from '../../utils/logger.js';

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 3 * 60 * 1000;
const MAX_OUTPUT = 1024 * 256;
const PREP_SCRIPT = '/usr/local/sbin/realones-prep-snapshot';

function redactOutput(value = '') {
  return String(value)
    .replace(/(XLINK_KAI_PASSWORD=)[^\s\n]+/gi, '$1[REDACTED]')
    .replace(/("password"\s*:\s*")[^"]+"/gi, '$1[REDACTED]"')
    .replace(/(password\s*[:=]\s*)[^\s\n]+/gi, '$1[REDACTED]');
}

function truncate(value, maxLength = 900) {
  const text = String(value || '');
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`;
}

function isMissingPrepScript({ code, stderr, stdout }) {
  const text = `${stderr || ''}\n${stdout || ''}`.toLowerCase();
  return code === 127 || text.includes('no such file') || text.includes('not found');
}

function parsePrepPayload(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(text.slice(start, end + 1));
    }
  }

  return null;
}

function formatList(title, values = [], limit = 8) {
  if (!values.length) return '';
  const shown = values.slice(0, limit).map(value => `- ${value}`).join('\n');
  const extra = values.length > limit ? `\n- ...${values.length - limit} more` : '';
  return `\n${title}\n${shown}${extra}`;
}

function formatPrepReply({ instance, mode, payload, code, stderr, stdout }) {
  if (!payload) {
    const details = truncate(redactOutput(stderr || stdout || `exit code ${code}`));
    return (
      `Snapshot prep ${mode} did not return valid JSON for "${instance.label || instance.id}".\n` +
      `\`\`\`\n${details}\n\`\`\``
    );
  }

  const status = payload.safe ? 'SAFE TO SNAPSHOT' : 'NOT SAFE TO SNAPSHOT';
  const actions = Array.isArray(payload.actions) ? payload.actions : [];
  const issues = Array.isArray(payload.issues) ? payload.issues : [];
  const content =
    `**Snapshot Prep: ${status}**\n\n` +
    `Server: ${instance.label || 'Unnamed Server'}\n` +
    `IP: ${instance.main_ip || 'unknown'}\n` +
    `Mode: ${mode}\n` +
    formatList('Actions:', actions) +
    formatList('Issues:', issues);

  return truncate(content, 1900);
}

async function runSnapshotPrep(instance, mode) {
  const sshUser = process.env.SNAPSHOT_PREP_SSH_USER || 'root';
  const sshKey = process.env.SNAPSHOT_PREP_SSH_KEY || '';
  const timeout = Number.parseInt(process.env.SNAPSHOT_PREP_TIMEOUT_MS || '', 10) || DEFAULT_TIMEOUT_MS;
  const host = instance.main_ip;

  if (!host || host === '0.0.0.0') {
    throw new Error('Selected server does not have a usable public IP yet.');
  }

  const args = [
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=10'
  ];

  if (sshKey) {
    args.push('-i', sshKey);
  }

  args.push(`${sshUser}@${host}`, PREP_SCRIPT, `--${mode}`, '--json');

  try {
    const result = await execFileAsync('ssh', args, {
      timeout,
      maxBuffer: MAX_OUTPUT
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: error.code,
      stdout: error.stdout || '',
      stderr: error.stderr || error.message || ''
    };
  }
}

export const snapshotPrepCommand = {
  data: new SlashCommandBuilder()
    .setName('snapshot-prep')
    .setDescription('Prepare a server image for snapshotting (Admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addStringOption(option =>
      option
        .setName('server')
        .setDescription('Server to check or prep')
        .setRequired(true)
        .setAutocomplete(true))
    .addStringOption(option =>
      option
        .setName('mode')
        .setDescription('Check only or apply the cleanup')
        .setRequired(true)
        .addChoices(
          { name: 'check', value: 'check' },
          { name: 'apply', value: 'apply' }
        )),

  async execute(interaction) {
    try {
      if (!hasSnapshotPermission(interaction.user.id)) {
        return interaction.editReply('You do not have permission to prep snapshots. Contact an administrator.');
      }

      const serverId = interaction.options.getString('server');
      const mode = interaction.options.getString('mode');
      const instance = await getAnyInstance(serverId);

      if (!instance) {
        return interaction.editReply('Server not found.');
      }

      await interaction.editReply(
        `Running snapshot prep \`${mode}\` on "${instance.label || instance.id}" (${instance.main_ip || 'no IP'})...`
      );

      const result = await runSnapshotPrep(instance, mode);
      if (isMissingPrepScript(result)) {
        return interaction.editReply('Snapshot prep script is not installed on this image yet.');
      }

      const payload = parsePrepPayload(result.stdout);
      const reply = formatPrepReply({
        instance,
        mode,
        payload,
        code: result.code,
        stderr: result.stderr,
        stdout: result.stdout
      });

      if (!payload && result.code !== 0) {
        logger.warn(`Snapshot prep ${mode} returned non-JSON failure for ${instance.id}: ${redactOutput(result.stderr)}`);
      }

      return interaction.editReply(reply);
    } catch (error) {
      logger.error('Snapshot prep command failed:', error.message);
      return interaction.editReply(`There was an error running snapshot prep: ${error.message}`);
    }
  }
};
