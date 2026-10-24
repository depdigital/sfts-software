export const isAutomaticFixture = fixture => fixture?.progressionMode === 'OPENING_FIXTURE';
export const participantKey = player => player ? `${player.playerName.trim().toUpperCase()}|${player.club.trim().toUpperCase()}` : '';
export const stageForSlots = slots => slots > 8 ? 'PRELIMINARY' : slots === 8 ? 'QUARTERFINAL' : slots === 4 ? 'SEMIFINAL' : 'FINAL';

export function buildFixtureProgression(fixture) {
  const opening = fixture.schedule;
  const count = opening.length;
  if (!count || (count & (count - 1))) throw new Error('Include BYE positions so the opening fixture contains 1, 2, 4, 8, 16, 32, 64, 128 or 256 rows');
  if (count > 256) throw new Error('Maximum 512 competitors in an opening fixture');
  const seen = new Set();
  const expectedStage = stageForSlots(count * 2);
  for (const bout of opening) {
    if (bout.stage !== expectedStage) throw new Error(`This fixture starts at ${expectedStage}. Use that stage for every opening row, including BYEs`);
    for (const player of [bout.RED, bout.BLUE].filter(Boolean)) {
      const key = participantKey(player);
      if (seen.has(key)) throw new Error(`${player.playerName} appears more than once in the opening fixture`);
      seen.add(key);
    }
    if (!bout.RED && !bout.BLUE) throw new Error('A BYE position must contain one actual competitor');
    bout.round = 1;
    bout.status = bout.RED && bout.BLUE ? 'SCHEDULED' : 'BYE';
    bout.winner = bout.status === 'BYE' ? (bout.RED ? 'RED' : 'BLUE') : null;
    bout.winnerName = bout.winner ? bout[bout.winner].playerName : null;
  }
  if (seen.size < 2) throw new Error('At least two competitors are required for a scored category');
  const usedNumbers = new Set(opening.map(bout => bout.officialBoutNo.toUpperCase()));
  let previous = [...opening];
  let round = 2;
  while (previous.length > 1) {
    const next = [];
    for (let index = 0; index < previous.length; index += 2) {
      const base = `AUTO-R${round}-${String(index / 2 + 1).padStart(3, '0')}`;
      let officialBoutNo = base;
      for (let suffix = 1; usedNumbers.has(officialBoutNo.toUpperCase()); suffix += 1) officialBoutNo = `${base}-${suffix}`;
      usedNumbers.add(officialBoutNo.toUpperCase());
      const bout = {
        boutNo: fixture.schedule.length + 1, officialBoutNo, stage: stageForSlots(previous.length), round,
        division: fixture.event.division, gender: fixture.event.gender,
        weightCategory: fixture.event.weightCategory, categoryGroup: fixture.event.categoryGroup,
        groupId: '', RED: null, BLUE: null, redPlayerId: null, bluePlayerId: null,
        redPlayerName: '', bluePlayerName: '', redSourceBoutNo: previous[index].boutNo,
        blueSourceBoutNo: previous[index + 1].boutNo, status: 'PENDING', winner: null, winnerName: null,
        announcement: ''
      };
      fixture.schedule.push(bout);
      next.push(bout);
    }
    previous = next;
    round += 1;
  }
  fixture.openingBoutCount = count;
  refreshFixtureProgression(fixture);
}

export function nextFixtureBout(fixture) {
  const bout = fixture.schedule.find(item => !['COMPLETED', 'BYE'].includes(item.status));
  return bout?.status === 'SCHEDULED' ? bout : null;
}

export function fixtureDescendants(fixture, boutNo) {
  const related = new Set([boutNo]);
  return fixture.schedule.filter(bout => {
    if (!related.has(bout.redSourceBoutNo) && !related.has(bout.blueSourceBoutNo)) return false;
    related.add(bout.boutNo);
    return true;
  });
}

export function validFixtureGraph(fixture) {
  const count = fixture.openingBoutCount;
  if (!Number.isInteger(count) || count < 1 || count > 256 || (count & (count - 1)) || fixture.schedule.length !== count * 2 - 1) return false;
  const seen = new Set();
  for (const bout of fixture.schedule.slice(0, count)) {
    if (bout.round !== 1 || bout.stage !== stageForSlots(count * 2) || bout.redSourceBoutNo || bout.blueSourceBoutNo || (!bout.RED && !bout.BLUE)) return false;
    for (const player of [bout.RED, bout.BLUE].filter(Boolean)) {
      const key = participantKey(player);
      if (seen.has(key)) return false;
      seen.add(key);
    }
    if ((!bout.RED || !bout.BLUE) && (bout.status !== 'BYE' || bout.winner !== (bout.RED ? 'RED' : 'BLUE'))) return false;
    if (bout.RED && bout.BLUE && bout.status === 'BYE') return false;
  }
  if (seen.size < 2) return false;
  let previous = fixture.schedule.slice(0, count);
  let offset = count;
  let round = 2;
  while (previous.length > 1) {
    const next = fixture.schedule.slice(offset, offset + previous.length / 2);
    for (let index = 0; index < next.length; index += 1) {
      const bout = next[index];
      if (bout.round !== round || bout.stage !== stageForSlots(previous.length) || bout.status === 'BYE' || bout.redSourceBoutNo !== previous[index * 2].boutNo || bout.blueSourceBoutNo !== previous[index * 2 + 1].boutNo) return false;
    }
    offset += next.length;
    previous = next;
    round += 1;
  }
  return fixture.schedule.every(bout => {
    if (['SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'TIE_PENDING'].includes(bout.status) && (!bout.RED || !bout.BLUE)) return false;
    if (bout.status === 'COMPLETED' && !bout.winner) return false;
    if (bout.status === 'TIE_PENDING' && bout.winner) return false;
    return true;
  });
}

export function refreshFixtureProgression(fixture, { records, validateRecord = () => {} } = {}) {
  if (!isAutomaticFixture(fixture)) return;
  const byNumber = new Map(fixture.schedule.map(bout => [bout.boutNo, bout]));
  const playerIds = new Map(fixture.players.map(player => [participantKey(player), player.id]));
  for (const bout of fixture.schedule) {
    for (const [side, prefix] of [['RED', 'red'], ['BLUE', 'blue']]) {
      const sourceNumber = bout[`${prefix}SourceBoutNo`];
      if (!sourceNumber) continue;
      const source = byNumber.get(sourceNumber);
      const player = source && ['COMPLETED', 'BYE'].includes(source.status) && source.winner ? source[source.winner] : null;
      bout[side] = player ? { ...player } : null;
      bout[`${prefix}PlayerName`] = player?.playerName || `Winner of ${source?.officialBoutNo || sourceNumber}`;
      bout[`${prefix}PlayerId`] = player ? playerIds.get(participantKey(player)) || null : null;
    }
    if (['PENDING', 'SCHEDULED'].includes(bout.status)) bout.status = bout.RED && bout.BLUE ? 'SCHEDULED' : 'PENDING';
    const record = records?.get(bout.officialBoutNo.toUpperCase());
    if (record && bout.status !== 'BYE') {
      validateRecord(bout, record);
      bout.status = record.winner ? 'COMPLETED' : 'TIE_PENDING';
      bout.winner = record.winner;
      bout.winnerName = record.winner ? bout[record.winner].playerName : null;
    }
    bout.announcement = `${bout.redPlayerName || 'BYE'}, HONG, red chest guard, versus ${bout.bluePlayerName || 'BYE'}, CHUNG, blue chest guard; contestants, prepare for the match.`;
  }
  for (const bout of fixture.schedule) bout.correctionLocked = false;
  for (let index = fixture.schedule.length - 1; index >= 0; index -= 1) {
    const bout = fixture.schedule[index];
    const locked = bout.correctionLocked || ['IN_PROGRESS', 'COMPLETED', 'TIE_PENDING'].includes(bout.status);
    for (const source of [bout.redSourceBoutNo, bout.blueSourceBoutNo]) {
      if (source && locked) byNumber.get(source).correctionLocked = true;
    }
  }
}
