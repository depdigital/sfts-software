// Test-mode pairing is independent of live votes and never awards points.
// Four entries at most, with lazy expiry instead of extra timers on the Pi.
export function createRemoteTestTracker({ windowMs, technicalPointsFor }) {
  const pending = new Map();

  function press(corner, vote, now) {
    if (!Number.isInteger(corner) || corner < 1 || corner > 4) return null;
    const previous = pending.get(corner);
    const matching = previous && previous.player === vote.player &&
      now >= previous.at && now - previous.at <= windowMs();
    pending.delete(corner);

    if (vote.combined) return vote.button;
    if (vote.technical) {
      if (matching && previous.basePoints !== undefined) {
        return `${vote.player}_TECHNICAL_${previous.basePoints}`;
      }
      pending.set(corner, { player: vote.player, at: now, technical: true });
      return null;
    }

    if (technicalPointsFor(vote.points) !== null) {
      if (matching && previous.technical) return `${vote.player}_TECHNICAL_${vote.points}`;
      pending.set(corner, { player: vote.player, at: now, basePoints: vote.points });
    }
    return vote.button;
  }

  return { press, clear: corner => pending.delete(corner), reset: () => pending.clear() };
}
