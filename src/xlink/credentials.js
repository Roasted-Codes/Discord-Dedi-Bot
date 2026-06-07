import fs from 'fs';
import path from 'path';

const DEFAULT_ACCOUNTS_FILE = './secrets/xlink-accounts.json';
const DEFAULT_ASSIGNMENTS_FILE = './data/xlink-assignments.json';
const PENDING_ASSIGNMENT_TTL_MS = 30 * 60 * 1000;

let assignmentQueue = Promise.resolve();

function resolvePath(filePath) {
  return path.resolve(process.cwd(), filePath);
}

function readJsonFile(filePath, fallback) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid JSON in ${filePath}: ${error.message}`);
  }
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
}

function normalizeXtag(xtag) {
  return String(xtag || '').trim();
}

function normalizeAssignment(assignment) {
  return {
    server_id: assignment.server_id,
    vultr_instance_id: assignment.vultr_instance_id || null,
    xtag: assignment.xtag,
    region: assignment.region || null,
    city_label: assignment.city_label || null,
    creator: assignment.creator || null,
    assigned_at: assignment.assigned_at || new Date().toISOString()
  };
}

function validateAccountPool(pool, accountsFile) {
  if (!pool || !Array.isArray(pool.accounts)) {
    throw new Error(`XLink account pool ${accountsFile} must contain {"accounts":[...]}.`);
  }

  const seen = new Set();
  return pool.accounts.map((account, index) => {
    const xtag = normalizeXtag(account.xtag);
    const password = String(account.password || '');

    if (!xtag) {
      throw new Error(`XLink account ${index + 1} is missing xtag.`);
    }
    if (!password) {
      throw new Error(`XLink account ${xtag} is missing password.`);
    }

    const key = xtag.toLowerCase();
    if (seen.has(key)) {
      throw new Error(`Duplicate XLink account xtag in pool: ${xtag}`);
    }
    seen.add(key);

    return { xtag, password };
  });
}

function loadAccounts() {
  const accountsFile = resolvePath(process.env.XLINK_ACCOUNTS_FILE || DEFAULT_ACCOUNTS_FILE);
  if (!fs.existsSync(accountsFile)) {
    throw new Error(`XLink account pool not found: ${accountsFile}`);
  }

  return validateAccountPool(readJsonFile(accountsFile, null), accountsFile);
}

function loadAssignments() {
  const assignmentsFile = resolvePath(process.env.XLINK_ASSIGNMENTS_FILE || DEFAULT_ASSIGNMENTS_FILE);
  const data = readJsonFile(assignmentsFile, { assignments: [] });
  if (!data || !Array.isArray(data.assignments)) {
    throw new Error(`XLink assignments file ${assignmentsFile} must contain {"assignments":[...]}.`);
  }
  return data.assignments.map(normalizeAssignment);
}

function saveAssignments(assignments) {
  const assignmentsFile = resolvePath(process.env.XLINK_ASSIGNMENTS_FILE || DEFAULT_ASSIGNMENTS_FILE);
  writeJsonFile(assignmentsFile, { assignments: assignments.map(normalizeAssignment) });
}

async function withAssignmentLock(fn) {
  const run = assignmentQueue.then(fn, fn);
  assignmentQueue = run.catch(() => {});
  return run;
}

function isPendingFresh(assignment, now = Date.now()) {
  if (assignment.vultr_instance_id) {
    return true;
  }
  const assignedAt = Date.parse(assignment.assigned_at || '');
  return Number.isFinite(assignedAt) && now - assignedAt < PENDING_ASSIGNMENT_TTL_MS;
}

function chooseRandom(availableAccounts, random = Math.random) {
  return availableAccounts[Math.floor(random() * availableAccounts.length)];
}

export function redactXlinkCredentials(xlinkCredentials = null) {
  if (!xlinkCredentials) {
    return null;
  }

  return {
    ...xlinkCredentials,
    password: xlinkCredentials.password ? '[REDACTED]' : ''
  };
}

export async function assignXlinkAccount({
  serverId,
  region,
  cityLabel,
  creator,
  random = Math.random
}) {
  return withAssignmentLock(async () => {
    const accounts = loadAccounts();
    const assignments = loadAssignments().filter(isPendingFresh);
    const assignedXtags = new Set(assignments.map(item => item.xtag.toLowerCase()));
    const availableAccounts = accounts.filter(account => !assignedXtags.has(account.xtag.toLowerCase()));

    if (availableAccounts.length === 0) {
      throw new Error('No unassigned XLink accounts are available.');
    }

    const selected = chooseRandom(availableAccounts, random);
    const assignment = normalizeAssignment({
      server_id: serverId,
      xtag: selected.xtag,
      region,
      city_label: cityLabel,
      creator,
      assigned_at: new Date().toISOString()
    });

    saveAssignments([
      ...assignments.filter(item => item.server_id !== serverId),
      assignment
    ]);

    return {
      assignment,
      credentials: {
        username: selected.xtag,
        password: selected.password
      }
    };
  });
}

export async function updateXlinkAssignmentInstance(serverId, vultrInstanceId) {
  return withAssignmentLock(async () => {
    const assignments = loadAssignments();
    const updated = assignments.map(assignment =>
      assignment.server_id === serverId
        ? normalizeAssignment({ ...assignment, vultr_instance_id: vultrInstanceId })
        : assignment
    );
    saveAssignments(updated);
  });
}

export async function releaseXlinkAssignment({ serverId, vultrInstanceId, xtag } = {}) {
  return withAssignmentLock(async () => {
    const assignments = loadAssignments();
    const filtered = assignments.filter(assignment => {
      if (serverId && assignment.server_id === serverId) return false;
      if (vultrInstanceId && assignment.vultr_instance_id === vultrInstanceId) return false;
      if (xtag && assignment.xtag.toLowerCase() === String(xtag).toLowerCase()) return false;
      return true;
    });
    saveAssignments(filtered);
  });
}

export function getXlinkAvailability({ now = Date.now() } = {}) {
  const accountsFile = resolvePath(process.env.XLINK_ACCOUNTS_FILE || DEFAULT_ACCOUNTS_FILE);
  const assignmentsFile = resolvePath(process.env.XLINK_ASSIGNMENTS_FILE || DEFAULT_ASSIGNMENTS_FILE);
  const accounts = loadAccounts();
  const assignments = loadAssignments();
  const freshAssignments = assignments.filter(assignment => isPendingFresh(assignment, now));
  const assignedXtags = new Set(freshAssignments.map(item => item.xtag.toLowerCase()));
  const availableAccounts = accounts.filter(account => !assignedXtags.has(account.xtag.toLowerCase()));

  return {
    accounts_file: accountsFile,
    assignments_file: assignmentsFile,
    total_accounts: accounts.length,
    assignment_count: assignments.length,
    active_assignment_count: freshAssignments.length,
    available_count: availableAccounts.length,
    available_xtags: availableAccounts.map(account => account.xtag)
  };
}

export async function syncXlinkAssignmentsWithInstances(instances = []) {
  return withAssignmentLock(async () => {
    const activeIds = new Set(instances.map(instance => instance.id).filter(Boolean));
    const activeLabels = new Set(instances.map(instance => instance.label).filter(Boolean));
    const assignments = loadAssignments().filter(assignment => {
      if (assignment.vultr_instance_id && activeIds.has(assignment.vultr_instance_id)) {
        return true;
      }
      if (assignment.server_id && activeLabels.has(assignment.server_id)) {
        return true;
      }
      return isPendingFresh(assignment);
    });
    saveAssignments(assignments);
  });
}

export function buildXlinkEnv({ credentials, cityLabel } = {}) {
  if (!credentials?.username || !credentials?.password) {
    return {};
  }

  return {
    XLINK_KAI_USERNAME: credentials.username,
    XLINK_KAI_PASSWORD: credentials.password,
    XLINK_KAI_AUTO_LOGIN: '1',
    XLINK_PRIVATE_ARENA_DESCRIPTION: `RealOnesV2 - ${cityLabel || 'Unknown Region'}`
  };
}
