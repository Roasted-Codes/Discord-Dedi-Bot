import test from 'node:test';
import assert from 'node:assert/strict';

import { reconcileSelkiesRoutes } from '../src/selkies/routes.js';

test('empty provider inventory never prunes persisted Selkies routes', async () => {
  assert.deepEqual(
    await reconcileSelkiesRoutes([]),
    { skipped: true, reason: 'empty_inventory' }
  );
});
