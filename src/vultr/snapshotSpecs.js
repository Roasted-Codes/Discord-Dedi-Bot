import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_SNAPSHOT_SPECS_FILE = './data/snapshot-specs.json';

function getSpecsFilePath() {
  return process.env.SNAPSHOT_SPECS_FILE || DEFAULT_SNAPSHOT_SPECS_FILE;
}

function emptyStore() {
  return {
    version: 1,
    snapshots: {}
  };
}

export function readSnapshotSpecs() {
  const filePath = getSpecsFilePath();
  if (!fs.existsSync(filePath)) {
    return emptyStore();
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return {
      version: parsed.version || 1,
      snapshots: parsed.snapshots || {}
    };
  } catch {
    return emptyStore();
  }
}

function writeSnapshotSpecs(store) {
  const filePath = getSpecsFilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
}

function sourceSpecFromInstance(instance = {}) {
  return {
    id: instance.id || null,
    label: instance.label || null,
    region: instance.region || null,
    plan: instance.plan || null,
    os_id: instance.os_id ?? null,
    app_id: instance.app_id ?? null,
    image_id: instance.image_id || null,
    vcpu_count: instance.vcpu_count ?? null,
    ram: instance.ram ?? null,
    disk: instance.disk ?? null,
    disk_type: instance.disk_type || null,
    gpu_type: instance.gpu_type || null,
    gpu_count: instance.gpu_count || null,
    tags: Array.isArray(instance.tags) ? instance.tags : []
  };
}

export function getSnapshotSpec(snapshotId) {
  if (!snapshotId) return null;
  return readSnapshotSpecs().snapshots[snapshotId] || null;
}

export function recordSnapshotSpec(snapshot, instance, options = {}) {
  if (!snapshot?.id || !instance) {
    return null;
  }

  const store = readSnapshotSpecs();
  const record = {
    snapshot_id: snapshot.id,
    snapshot_description: snapshot.description || options.description || '',
    snapshot_created: snapshot.date_created || null,
    visibility: options.visibility || null,
    source: sourceSpecFromInstance(instance),
    inferred: Boolean(options.inferred),
    note: options.note || null,
    recorded_by: options.recordedBy || 'dedi-bot',
    recorded_at: new Date().toISOString()
  };

  store.snapshots[snapshot.id] = record;
  writeSnapshotSpecs(store);
  return record;
}

export function getSnapshotRestorePlan(snapshotId) {
  return getSnapshotSpec(snapshotId)?.source?.plan || null;
}

export function formatSnapshotSourceSpec(record) {
  const source = record?.source || record;
  if (!source) return null;

  const parts = [];
  if (source.plan) parts.push(`plan ${source.plan}`);
  if (source.vcpu_count && source.ram) {
    parts.push(`${source.vcpu_count} vCPU / ${Math.round(source.ram / 1024)} GB RAM`);
  }
  if (source.disk) parts.push(`${source.disk} GB disk`);
  if (source.gpu_type) {
    parts.push(`${source.gpu_type}${source.gpu_count ? ` x ${source.gpu_count}` : ''}`);
  }
  if (source.region) parts.push(`source region ${source.region}`);

  return parts.join(', ') || null;
}
