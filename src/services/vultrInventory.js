export async function listCompleteInstanceInventory(listPage, { perPage = '100' } = {}) {
  if (typeof listPage !== 'function') {
    throw new TypeError('listPage must be a function');
  }

  const instances = [];
  const instanceIds = new Set();
  const seenCursors = new Set();
  let cursor = null;
  let expectedTotal = null;

  while (true) {
    const params = cursor
      ? { per_page: perPage, cursor }
      : { per_page: perPage };
    const response = await listPage(params);

    if (!Array.isArray(response?.instances)) {
      throw new Error('Vultr inventory response must contain an instances array');
    }

    const total = response?.meta?.total;
    const links = response?.meta?.links;
    if (!Number.isInteger(total) || total < 0 || !links || typeof links !== 'object') {
      throw new Error('Vultr inventory response is missing valid pagination metadata');
    }
    if (expectedTotal === null) {
      expectedTotal = total;
    } else if (total !== expectedTotal) {
      throw new Error(`Vultr inventory total changed during pagination (${expectedTotal} to ${total})`);
    }

    for (const instance of response.instances) {
      if (typeof instance?.id !== 'string' || !instance.id) {
        throw new Error('Vultr inventory contains an instance without a valid ID');
      }
      if (instanceIds.has(instance.id)) {
        throw new Error(`Vultr inventory contains duplicate instance ID ${instance.id}`);
      }
      instanceIds.add(instance.id);
      instances.push(instance);
    }

    const nextCursor = links.next;
    if (nextCursor !== null && nextCursor !== undefined && typeof nextCursor !== 'string') {
      throw new Error('Vultr inventory next cursor must be a string');
    }
    if (!nextCursor) break;
    if (seenCursors.has(nextCursor)) {
      throw new Error(`Vultr inventory repeated pagination cursor ${nextCursor}`);
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  if (instances.length !== expectedTotal) {
    throw new Error(`Vultr inventory is incomplete: received ${instances.length} of ${expectedTotal} instances`);
  }

  return instances;
}
