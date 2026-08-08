import test from 'node:test';
import assert from 'node:assert/strict';

import { listCompleteInstanceInventory } from '../src/services/vultrInventory.js';

test('complete inventory follows every Vultr cursor before returning instances', async () => {
  const calls = [];
  const pages = [
    {
      instances: [{ id: 'one' }, { id: 'two' }],
      meta: { total: 3, links: { next: 'cursor-two', prev: '' } }
    },
    {
      instances: [{ id: 'three' }],
      meta: { total: 3, links: { next: '', prev: 'cursor-one' } }
    }
  ];

  const instances = await listCompleteInstanceInventory(async params => {
    calls.push(params);
    return pages.shift();
  });

  assert.deepEqual(calls, [
    { per_page: '100' },
    { per_page: '100', cursor: 'cursor-two' }
  ]);
  assert.deepEqual(instances.map(instance => instance.id), ['one', 'two', 'three']);
});

test('partial inventory without a next cursor is rejected', async () => {
  await assert.rejects(
    listCompleteInstanceInventory(async () => ({
      instances: [{ id: 'one' }],
      meta: { total: 2, links: { next: '', prev: '' } }
    })),
    /incomplete.*1 of 2/i
  );
});

test('malformed pagination metadata is rejected', async () => {
  await assert.rejects(
    listCompleteInstanceInventory(async () => ({ instances: [] })),
    /pagination metadata/i
  );
});

test('duplicate instances across pages are rejected as non-authoritative', async () => {
  const pages = [
    {
      instances: [{ id: 'one' }],
      meta: { total: 2, links: { next: 'next', prev: '' } }
    },
    {
      instances: [{ id: 'one' }],
      meta: { total: 2, links: { next: '', prev: '' } }
    }
  ];

  await assert.rejects(
    listCompleteInstanceInventory(async () => pages.shift()),
    /duplicate instance id/i
  );
});
