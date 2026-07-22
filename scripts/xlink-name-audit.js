#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { vultr, listAllInstances } from '../src/vultr/index.js';

const DEFAULT_ASSIGNMENTS_FILE = './data/xlink-assignments.json';

function resolvePath(filePath) {
  return path.resolve(process.cwd(), filePath);
}

function readJsonFile(filePath, fallback) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }

  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function normalizeAssignment(assignment) {
  return {
    server_id: String(assignment.server_id || '').trim(),
    vultr_instance_id: assignment.vultr_instance_id || null,
    xtag: String(assignment.xtag || '').trim()
  };
}

function decodeUserData(response) {
  const data = response?.user_data?.data || response?.user_data || response?.data || '';
  if (!data || typeof data !== 'string') {
    return '';
  }

  try {
    return Buffer.from(data, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

function unquoteEnvValue(value) {
  const trimmed = String(value || '').trim();
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/'\\''/g, "'");
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function extractEnv(text, key) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(text || '').match(new RegExp(`^\\s*${escapedKey}=([^\\n]+)$`, 'm'));
  return match ? unquoteEnvValue(match[1]) : '';
}

async function getInstanceIdentityFromUserData(instanceId) {
  try {
    const response = await vultr.instances.getInstanceUserData({ 'instance-id': instanceId });
    const text = decodeUserData(response);
    return {
      realonesServerId: extractEnv(text, 'REALONES_SERVER_ID'),
      xlinkUsername: extractEnv(text, 'XLINK_KAI_USERNAME')
    };
  } catch (error) {
    return {
      realonesServerId: '',
      xlinkUsername: '',
      error: error.message
    };
  }
}

function statusFor({ label, xlinkUsername }) {
  if (!xlinkUsername) {
    return 'unknown';
  }
  return label === xlinkUsername ? 'ok' : 'mismatch';
}

function printRow(row) {
  const source = row.sources.length ? row.sources.join('+') : 'none';
  const detail = [
    `status=${row.status}`,
    `instance_id=${row.instanceId || 'none'}`,
    `realones_id=${row.realonesServerId || 'unknown'}`,
    `source=${source}`
  ].join(' ');

  console.log(`${row.label.padEnd(28)} -> ${(row.xlinkUsername || 'unknown').padEnd(22)} ${detail}`);
}

try {
  const assignmentsFile = resolvePath(process.env.XLINK_ASSIGNMENTS_FILE || DEFAULT_ASSIGNMENTS_FILE);
  const assignmentData = readJsonFile(assignmentsFile, { assignments: [] });
  const assignments = Array.isArray(assignmentData.assignments)
    ? assignmentData.assignments.map(normalizeAssignment).filter(item => item.xtag)
    : [];
  const assignmentsByInstanceId = new Map(assignments
    .filter(item => item.vultr_instance_id)
    .map(item => [item.vultr_instance_id, item]));
  const assignmentsByServerId = new Map(assignments.map(item => [item.server_id, item]));

  const instances = await listAllInstances();
  const rows = [];

  for (const instance of instances) {
    const label = instance.label || instance.hostname || instance.id;
    const userDataIdentity = await getInstanceIdentityFromUserData(instance.id);
    const assignment = assignmentsByInstanceId.get(instance.id) || assignmentsByServerId.get(label);
    const xlinkUsername = userDataIdentity.xlinkUsername || assignment?.xtag || '';
    const realonesServerId = userDataIdentity.realonesServerId || assignment?.server_id || '';
    const sources = [];
    if (userDataIdentity.xlinkUsername) sources.push('user-data');
    if (assignment?.xtag) sources.push('assignment');

    rows.push({
      label,
      instanceId: instance.id,
      xlinkUsername,
      realonesServerId,
      sources,
      status: statusFor({ label, xlinkUsername })
    });
  }

  for (const assignment of assignments) {
    if (assignment.vultr_instance_id && rows.some(row => row.instanceId === assignment.vultr_instance_id)) {
      continue;
    }
    if (!assignment.vultr_instance_id && rows.some(row => row.label === assignment.server_id)) {
      continue;
    }
    rows.push({
      label: assignment.server_id || '(assignment-only)',
      instanceId: assignment.vultr_instance_id || '',
      xlinkUsername: assignment.xtag,
      realonesServerId: assignment.server_id,
      sources: ['assignment'],
      status: 'missing_instance'
    });
  }

  const relevantRows = rows.filter(row =>
    row.xlinkUsername ||
    String(row.label || '').startsWith('r1v2-') ||
    String(row.realonesServerId || '').startsWith('r1v2-')
  );
  relevantRows.sort((a, b) => a.label.localeCompare(b.label));

  console.log('XLink/Vultr naming audit');
  console.log('');
  console.log(`assignments_file: ${assignmentsFile}`);
  console.log(`active_instances: ${instances.length}`);
  console.log(`audited_rows:     ${relevantRows.length}`);
  console.log('');

  if (relevantRows.length === 0) {
    console.log('No XLink-managed or r1v2 instances found.');
  } else {
    for (const row of relevantRows) {
      printRow(row);
    }
  }

  const mismatchCount = relevantRows.filter(row => row.status === 'mismatch').length;
  console.log('');
  console.log(`mismatches: ${mismatchCount}`);
  console.log('would_rename_vultr: false');
  console.log('would_modify_assignments: false');
} catch (error) {
  console.error(`xlink:audit failed: ${error.message}`);
  process.exitCode = 1;
}
