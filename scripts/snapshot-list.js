#!/usr/bin/env node
import {
  getSnapshots,
  getCleanSnapshotName,
  isBotManagedSnapshot
} from '../src/vultr/index.js';

function parseArgs(argv) {
  const args = {
    json: false,
    raw: false,
    limit: null
  };

  for (const arg of argv) {
    if (arg === '--json') args.json = true;
    else if (arg === '--raw') args.raw = true;
    else if (arg.startsWith('--limit=')) args.limit = Number.parseInt(arg.slice('--limit='.length), 10);
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (args.limit !== null && (!Number.isFinite(args.limit) || args.limit < 1)) {
    throw new Error('--limit must be a positive integer.');
  }

  return args;
}

function formatSize(snapshot) {
  if (snapshot.size_gb) return `${snapshot.size_gb} GB`;
  if (snapshot.size) {
    const numericSize = Number(snapshot.size);
    if (Number.isFinite(numericSize) && numericSize > 1024 * 1024 * 1024) {
      const gb = numericSize / (1024 * 1024 * 1024);
      return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`;
    }
    return `${snapshot.size} GB`;
  }
  return 'size unknown';
}

function snapshotSummary(snapshot) {
  return {
    id: snapshot.id,
    id_suffix: snapshot.id ? snapshot.id.slice(-8) : '',
    name: getCleanSnapshotName(snapshot),
    description: snapshot.description || '',
    status: snapshot.status || 'unknown',
    created: snapshot.date_created || null,
    size: formatSize(snapshot)
  };
}

try {
  const args = parseArgs(process.argv.slice(2));
  const snapshots = await getSnapshots();
  const managed = snapshots.filter(isBotManagedSnapshot);
  const selected = args.raw ? snapshots : managed;
  const shown = args.limit ? selected.slice(0, args.limit) : selected;
  const result = {
    raw_snapshot_count: snapshots.length,
    bot_managed_count: managed.length,
    shown_count: shown.length,
    snapshots: shown.map(snapshotSummary)
  };

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('Bot-managed RealOnesV2 snapshots');
    console.log(`raw_snapshot_count: ${result.raw_snapshot_count}`);
    console.log(`bot_managed_count:  ${result.bot_managed_count}`);
    console.log(`shown_count:        ${result.shown_count}`);
    console.log('');

    if (shown.length === 0) {
      console.log(args.raw ? 'No snapshots found.' : 'No bot-managed snapshots found.');
    } else {
      shown.forEach((snapshot, index) => {
        const summary = snapshotSummary(snapshot);
        console.log(`${String(index + 1).padStart(2, ' ')}. ${summary.name}`);
        console.log(`    created: ${summary.created || 'unknown'}`);
        console.log(`    size:    ${summary.size}`);
        console.log(`    status:  ${summary.status}`);
        console.log(`    id:      ...${summary.id_suffix} (${summary.id})`);
      });
    }
  }
} catch (error) {
  console.error(`snapshot:list failed: ${error.message}`);
  process.exitCode = 1;
}
