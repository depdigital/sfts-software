// A full snapshot replaces cached bulk data. A patch only follows a full
// snapshot, preserving tournament, category and history data until it changes.
globalThis.SftsState = Object.freeze({
  merge(previous, incoming) {
    if (incoming.type === 'state') return incoming;
    if (incoming.type !== 'statePatch') return incoming;
    return previous ? { ...previous, ...incoming, type: 'state' } : null;
  }
});
