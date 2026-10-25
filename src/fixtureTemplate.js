import { FIXTURE_HEADERS, MAX_WORKBOOK_CATEGORIES, MAX_WORKBOOK_ROWS } from './fixtureImport.js';
import { buildFixtureProgression } from './fixtureProgression.js';
import { SCHEDULE_HEADERS, fixtureSourceLabel, validateWorkbookSchedule } from './fixtureSchedule.js';

const FIRST_NAMES = {
  MALE: ['Arjun', 'Rohan', 'Kabir', 'Ishaan', 'Vivaan', 'Aarav', 'Neel', 'Dhruv', 'Aditya', 'Kunal', 'Soham', 'Sayan', 'Dev', 'Aryan', 'Ritwik', 'Anirban', 'Rahul', 'Vikram', 'Nikhil', 'Pranav', 'Rishabh', 'Siddharth', 'Yash', 'Harsh', 'Varun', 'Akash', 'Rudra', 'Abhinav', 'Shaurya', 'Manav', 'Tanmay', 'Aniket'],
  FEMALE: ['Ananya', 'Meera', 'Tara', 'Aditi', 'Ishita', 'Riya', 'Diya', 'Kavya', 'Nandini', 'Saanvi', 'Avni', 'Anika', 'Pooja', 'Shruti', 'Sneha', 'Tanvi', 'Mira', 'Priya', 'Shreya', 'Anushka', 'Mahi', 'Navya', 'Suhana', 'Kritika', 'Trisha', 'Ira', 'Siya', 'Aarohi', 'Vanya', 'Myra', 'Nisha', 'Roshni']
};
const SURNAMES = ['Sen', 'Das', 'Roy', 'Ghosh', 'Dutta', 'Bose', 'Banerjee', 'Pal', 'Saha', 'Dey', 'Paul', 'Mitra', 'Sanyal', 'Chatterjee', 'Malhotra', 'Sharma', 'Verma', 'Kapoor', 'Mehta', 'Shah', 'Patel', 'Rao', 'Nair', 'Menon', 'Pillai', 'Reddy', 'Iyer', 'Joshi', 'Kulkarni', 'Desai', 'Agarwal', 'Gupta', 'Saxena', 'Bhat', 'Prasad', 'Thakur', 'Singh', 'Chauhan', 'Sethi', 'Khanna'];
const CLUBS = [
  ['Falcon Taekwondo', 'WB', 'Nadia'], ['Riverfront Martial Arts', 'WB', 'Kolkata'],
  ['Summit Taekwondo', 'DL', 'New Delhi'], ['Lotus Martial Arts', 'MH', 'Pune'],
  ['Phoenix Taekwondo', 'TN', 'Chennai'], ['Eastern Tigers Academy', 'KA', 'Bengaluru'],
  ['Valley Taekwondo', 'KL', 'Ernakulam'], ['Horizon Martial Arts', 'UP', 'Lucknow']
];
const categoryKey = value => value.toUpperCase().replace(/[^A-Z0-9]/g, '');

export function createFixtureTemplateSheets(divisions) {
  const profiles = [];
  const candidates = new Map();
  for (const division of divisions) for (const gender of ['MALE', 'FEMALE']) {
    for (const category of division.categoryType === 'WEIGHT' ? division.weightCategories[gender] : division.groups) {
      profiles.push({ division, gender, category });
      candidates.set(`${division.categoryType}:${categoryKey(category.name)}`, { type: division.categoryType, name: category.name });
    }
  }
  if (profiles.length < 2 || profiles.length > MAX_WORKBOOK_CATEGORIES || profiles.length * 8 > MAX_WORKBOOK_ROWS) {
    throw new Error(`The rest-aware test template requires 2 to ${MAX_WORKBOOK_CATEGORIES} valid categories within ${MAX_WORKBOOK_ROWS} opening rows. Another category supplies the match gap before finals`);
  }
  const nextPlayer = { MALE: 0, FEMALE: 0 };
  const matches = [FIXTURE_HEADERS];
  const categories = [['Division', 'Age Eligibility', 'Gender', 'Weight Category', 'Weight Limit', 'Group', 'Group Age Limit', 'Test Players', 'BYEs', 'Opening Rows', 'Preliminary Matches', 'Quarterfinals', 'Semifinals', 'Finals']];
  for (const [profileIndex, { division, gender, category }] of profiles.entries()) {
    const weight = division.categoryType === 'WEIGHT' ? category.name : '';
    const group = division.categoryType === 'GROUP' ? category.name : '';
    const players = Array.from({ length: 9 }, () => {
      const number = nextPlayer[gender]++;
      const firstNames = FIRST_NAMES[gender];
      return [`${firstNames[number % firstNames.length]} ${SURNAMES[(number + Math.floor(number / firstNames.length)) % SURNAMES.length]}`, ...CLUBS[number % CLUBS.length]];
    });
    const bye = ['BYE', '', '', ''];
    let advancingPlayer = 2;
    for (let position = 0; position < 8; position += 1) {
      const contested = position === profileIndex % 8;
      const player = contested ? null : players[advancingPlayer++];
      const hongBye = (position + profileIndex) % 2 === 0;
      matches.push([
        `TEST-${String(profileIndex + 1).padStart(3, '0')}-PRE-${String(position + 1).padStart(2, '0')}`,
        'PRELIMINARY', division.label, gender, weight, group,
        ...(contested ? players[0] : hongBye ? bye : player),
        ...(contested ? players[1] : hongBye ? player : bye)
      ]);
    }
    categories.push([division.label, division.ageLabel, gender, weight, weight ? category.limit : '', group, group ? category.ageLabel : '', 9, 7, 8, 1, 4, 2, 1]);
  }
  const fixtures = profiles.map(({ division, gender, category }, index) => {
    const event = { division: division.label, gender, weightCategory: division.categoryType === 'WEIGHT' ? category.name : '', categoryGroup: division.categoryType === 'GROUP' ? category.name : '' };
    const player = (row, offset) => row[offset] === 'BYE' ? null : { playerName: row[offset], club: row[offset + 1], stateCode: row[offset + 2], district: row[offset + 3] };
    const fixture = {
      progressionMode: 'OPENING_FIXTURE', event, players: [],
      schedule: matches.slice(1 + index * 8, 9 + index * 8).map((row, position) => ({
        boutNo: position + 1, officialBoutNo: row[0], stage: row[1], RED: player(row, 6), BLUE: player(row, 10), redPlayerName: row[6], bluePlayerName: row[10]
      }))
    };
    buildFixtureProgression(fixture);
    return { key: String(index), fixture };
  });
  const schedule = [SCHEDULE_HEADERS];
  // Finish two categories together; an odd last group uses three. Alternating
  // categories also gives the second semifinal winner a gap before the final.
  for (let offset = 0; offset < fixtures.length;) {
    const size = fixtures.length - offset === 3 ? 3 : 2;
    const group = fixtures.slice(offset, offset + size);
    const bouts = group.map(({ fixture }) => fixture.schedule.filter(bout => bout.status !== 'BYE'));
    for (let index = 0; index < 8; index += 1) for (const [categoryIndex, { fixture }] of group.entries()) {
      const bout = bouts[categoryIndex][index];
      bout.matchOrder = schedule.length;
      const { division, gender, weightCategory, categoryGroup } = fixture.event;
      schedule.push([bout.matchOrder, bout.officialBoutNo, bout.stage, division, gender, weightCategory, categoryGroup, fixtureSourceLabel(fixture, bout, 'RED'), fixtureSourceLabel(fixture, bout, 'BLUE'), 1]);
    }
    offset += size;
  }
  validateWorkbookSchedule({ categories: fixtures, schedulePolicy: { minimumMatchGap: 1 } }, { contiguous: true });
  const exclusions = [['Division', 'Gender', 'Excluded Weight Category', 'Excluded Group', 'Reason']];
  for (const division of divisions) for (const gender of ['MALE', 'FEMALE']) {
    const valid = new Set((division.categoryType === 'WEIGHT' ? division.weightCategories[gender] : division.groups).map(category => categoryKey(category.name)));
    for (const candidate of candidates.values()) {
      if (candidate.type === division.categoryType && valid.has(categoryKey(candidate.name))) continue;
      exclusions.push([division.label, gender, candidate.type === 'WEIGHT' ? candidate.name : '', candidate.type === 'GROUP' ? candidate.name : '',
        candidate.type !== division.categoryType ? `This division uses ${division.categoryType === 'WEIGHT' ? 'weight categories' : 'groups'}.` : 'Not defined for this division and gender in the active rulepack.']);
    }
  }
  const instructions = [
    ['SFTS COMPLETE TOURNAMENT TEST', 'IMPORT AND TESTING GUIDE'],
    ['Format', 'SFTS scheduled fixture v1. Matches defines bracket positions. Schedule defines the official arena running order for every scored bout. Import both sheets together as XLSX or XLS.'],
    ['Matches', 'Supply opening positions for each category, including BYEs. Preserve bracket row order within each category. SFTS pairs adjacent winners and builds later rounds.'],
    ['Schedule', 'Follow numeric Match Order across all categories. Every scored bout appears exactly once. BYEs do not appear. SFTS follows this order without rearranging the fixture.'],
    ['Rest rule', 'Minimum Match Gap is 1 on every Schedule row. At least one other scored match must finish between a player\'s matches. BYEs and waiting time do not count. The order must work for either winner.'],
    ['Category changes', 'Two categories alternate matches, or three in the last group if needed. This supplies rest before quarterfinals and finals. Each category completes preliminary, quarterfinal, semifinal, then final in order.'],
    ['Coverage', `${profiles.length} valid division/gender/category combinations; ${profiles.length * 9} fictional players; ${profiles.length * 7} BYEs; ${profiles.length * 8} opening rows.`],
    ['Each category', '9 players and 7 BYEs in 16 slots: 1 contested preliminary, 4 quarterfinals, 2 semifinals and 1 final. Minimum players to exercise all four stages.'],
    ['Categories', 'Checklist of every valid combination, its eligibility and weight/group definition, and expected player, BYE and match counts.'],
    ['Exclusions', 'Unsupported cross-combinations from the rulepack category names are listed for reference only. They are deliberately absent from Matches; do not copy them into the import sheet.'],
    ['Event details', 'Enter tournament name, date, venue, arena and competition in SFTS before importing.'],
    ['Required', 'Bout Number, Stage, Division, Gender, Weight Category (or Group), Hong Name, Hong Club, Chung Name, Chung Club.'],
    ['Optional', 'Hong/Chung State Code and District. State codes must be valid Indian state codes.'],
    ['Stage', 'Within EACH category use the same opening stage: 1 row FINAL, 2 SEMIFINAL, 4 QUARTERFINAL, 8 or more PRELIMINARY. Row counts include BYE positions.'],
    ['Test flow', 'Review and confirm the workbook, then use Load Next Match to follow Schedule. The next card shows the scheduled category and switches to it when loaded. Every category starts at PRELIMINARY.'],
    ['Bye positions', 'Both Hong-side and Chung-side BYEs are included. The contested opening position rotates between categories.'],
    ['Sides', 'Hong is RED; Chung is BLUE. All player and club names are fictional. Each player name is unique throughout this test workbook.'],
    ['BYEs', 'Put BYE (or leave the name blank) on the empty side, and leave its club, state and district blank. Include BYE rows so the opening row count is a power of two. Each competitor appears once.'],
    ['Progression', 'Adjacent row winners meet next: row 1 winner is HONG, row 2 winner is CHUNG. No reshuffle. SFTS continues locally through the final.'],
    ['Schedule references', 'Bout Number is scoped to Division, Gender and Weight Category or Group. Later rounds use AUTO-R2-001, AUTO-R2-002, etc., then AUTO-R3-001, etc. Source text is Winner of followed by the source bout number. Copy the exact references.'],
    ['Schedule validation', 'SFTS rejects missing or repeated bouts, incorrect sources, rounds out of order and a possible back-to-back player. Never change a scored running order. Export a revised schedule if a category is removed.'],
    ['Results', 'Completed official bout numbers retain their results; their sides and stages cannot be changed.'],
    ['Limits', `Maximum ${MAX_WORKBOOK_CATEGORIES} categories, ${MAX_WORKBOOK_ROWS} opening rows, 8192 schedule rows and 4 MB per file; maximum 256 opening rows / 512 players per category. Matches must be the first worksheet. Schedule must have its exact sheet name.`],
    ['Legacy imports', 'Files without Schedule retain the older category-by-category flow and do not enforce a match gap. CSV cannot carry Schedule. Use the scheduled XLSX format for rest-aware fixtures.'],
    ['Competition', 'The competition selected manually in SFTS applies to the entire file. Keep KYORUGI and FRESHER KYORUGI in separate files.']
  ];
  return [
    { name: 'Matches', rows: matches, cols: [21, 18, 18, 12, 22, 15, 25, 28, 18, 20, 25, 28, 18, 20].map(wch => ({ wch })), filter: `A1:N${matches.length}` },
    { name: 'Schedule', rows: schedule, cols: [14, 24, 18, 18, 12, 22, 15, 36, 36, 20].map(wch => ({ wch })), filter: `A1:J${schedule.length}` },
    { name: 'Categories', rows: categories, cols: [18, 30, 12, 22, 32, 16, 28, 14, 10, 16, 23, 16, 16, 12].map(wch => ({ wch })), filter: `A1:N${categories.length}` },
    { name: 'Instructions', rows: instructions, cols: [{ wch: 30 }, { wch: 110 }] },
    { name: 'Exclusions', rows: exclusions, cols: [18, 12, 28, 24, 80].map(wch => ({ wch })), filter: `A1:E${exclusions.length}` }
  ];
}
