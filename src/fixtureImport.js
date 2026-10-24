export const FIXTURE_HEADERS = [
  'Bout Number', 'Stage', 'Division', 'Gender', 'Weight Category', 'Group',
  'Hong Name', 'Hong Club', 'Hong State Code', 'Hong District',
  'Chung Name', 'Chung Club', 'Chung State Code', 'Chung District'
];

export function parseFixtureRows(rows, { categoryFromInput, playerDetails, event, maxBouts = 500, openingFixture = false }) {
  const errors = [];
  const headers = (rows[0] || []).map(value => String(value).toLowerCase().replace(/[^a-z0-9]/g, ''));
  const aliases = {
    boutnumber: ['officialboutno', 'boutno', 'bout'],
    hongname: ['redname', 'redplayer', 'hongplayer'], hongclub: ['redclub', 'hongaffiliation', 'redaffiliation'],
    hongstatecode: ['redstatecode'], hongdistrict: ['reddistrict'],
    chungname: ['bluename', 'blueplayer', 'chungplayer'], chungclub: ['blueclub', 'chungaffiliation', 'blueaffiliation'],
    chungstatecode: ['bluestatecode'], chungdistrict: ['bluedistrict']
  };
  const columns = Object.fromEntries(FIXTURE_HEADERS.map(label => {
    const key = label.toLowerCase().replace(/[^a-z0-9]/g, '');
    const matching = headers.map((header, index) => header === key || aliases[key]?.includes(header) ? index : -1).filter(index => index >= 0);
    if (matching.length > 1) errors.push(`Ambiguous column headers for ${label}`);
    return [key, matching[0] ?? -1];
  }));
  if (headers.some((key, index) => key && headers.indexOf(key) !== index)) errors.push('Duplicate column headers are not allowed');
  for (const key of ['boutnumber', 'stage', 'division', 'gender', 'hongname', 'hongclub', 'chungname', 'chungclub']) {
    if (columns[key] < 0) errors.push(`Missing required column: ${key}`);
  }
  if (rows.length < 2) errors.push('The first worksheet does not contain any matches');
  if (rows.length - 1 > maxBouts) errors.push(`Maximum ${maxBouts} matches per category file`);
  const bouts = [];
  const numbers = new Set();
  let category;
  for (const [index, row] of rows.slice(1, maxBouts + 1).entries()) {
    const get = key => String(row[columns[key]] ?? '').trim();
    const fail = message => errors.push(`Row ${index + 2}: ${message}`);
    const parsed = categoryFromInput({ ...event, division: get('division'), gender: get('gender'), weightCategory: get('weightcategory'), categoryGroup: get('group') });
    if (parsed.error) { fail(parsed.error); continue; }
    if (get('group') && parsed.value.weightCategory) fail('Group must be blank for a weight category');
    if (get('weightcategory') && parsed.value.categoryGroup) fail('Weight Category must be blank for a group category');
    if (category && ['division', 'gender', 'weightCategory', 'categoryGroup'].some(key => parsed.value[key] !== category[key])) {
      fail('Every match in a file must have the same division, gender and category');
    }
    category ||= parsed.value;
    const officialBoutNo = get('boutnumber');
    const numberKey = officialBoutNo.toUpperCase();
    if (!officialBoutNo || officialBoutNo.length > 40 || numbers.has(numberKey)) fail('Bout number is required, must be unique and at most 40 characters');
    numbers.add(numberKey);
    const stage = get('stage').toUpperCase().replace(/[ -]/g, '');
    if (!['PRELIMINARY', 'QUARTERFINAL', 'SEMIFINAL', 'FINAL'].includes(stage)) fail('Stage must be PRELIMINARY, QUARTERFINAL, SEMIFINAL or FINAL');
    const players = {};
    for (const [side, prefix] of [['RED', 'hong'], ['BLUE', 'chung']]) {
      const details = { playerName: get(`${prefix}name`), club: get(`${prefix}club`), stateCode: get(`${prefix}statecode`), district: get(`${prefix}district`) };
      if (openingFixture && (!details.playerName || details.playerName.toUpperCase() === 'BYE')) {
        if (details.club || details.stateCode || details.district) fail(`${side} BYE must not contain club, state or district details`);
        players[side] = null;
        continue;
      }
      if (details.playerName.length > 64 || details.club.length > 64 || details.stateCode.length > 2 || details.district.length > 48) fail(`${side} player detail exceeds the supported length`);
      if (/^(?:(?:BYE|TBD|TBA)$|WINNER(?:\s+OF)?\s+(?:BOUT|MATCH|SF|QF|R\d))/i.test(details.playerName)) fail(`${side} must name an actual competitor; BYEs and unresolved winner placeholders are not supported`);
      players[side] = playerDetails(details, side);
      if (players[side].error) fail(players[side].error);
    }
    if (!players.RED && !players.BLUE) fail('A match must contain at least one competitor');
    if (players.RED && players.BLUE && players.RED.playerName?.toUpperCase() === players.BLUE.playerName?.toUpperCase() && players.RED.club?.toUpperCase() === players.BLUE.club?.toUpperCase()) fail('HONG and CHUNG must be different competitors');
    bouts.push({ officialBoutNo, stage, ...players });
  }
  return { category, bouts, errors: errors.slice(0, 30) };
}
