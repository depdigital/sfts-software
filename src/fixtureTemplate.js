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
  if (!profiles.length || profiles.length > MAX_WORKBOOK_CATEGORIES || profiles.length * 8 > MAX_WORKBOOK_ROWS) {
    throw new Error(`The test template requires 1 to ${MAX_WORKBOOK_CATEGORIES} valid categories within ${MAX_WORKBOOK_ROWS} opening rows`);
  }
  const nextPlayer = { MALE: 0, FEMALE: 0 };
  const matches = [FIXTURE_HEADERS];
  const categories = [['Division', 'Age Eligibility', 'Gender', 'Weight Category', 'Weight Limit', 'Group', 'Group Age Limit', 'Test Players', 'BYEs', 'Opening Rows', 'Preliminary Matches', 'Quarterfinals', 'Semifinals', 'Finals']];
  for (const [profileIndex, { division, gender, category }] of profiles.entries()) {
    const weight = division.categoryType === 'WEIGHT' ? category.name : '';
    const group = division.categoryType === 'GROUP' ? category.name : '';
    const players = Array.from({ length: 15 }, () => {
      const number = nextPlayer[gender]++;
      const firstNames = FIRST_NAMES[gender];
      return [`${firstNames[number % firstNames.length]} ${SURNAMES[(number + Math.floor(number / firstNames.length)) % SURNAMES.length]}`, ...CLUBS[number % CLUBS.length]];
    });
    const bye = ['BYE', '', '', ''];
    let playerIndex = 0;
    for (let position = 0; position < 8; position += 1) {
      const hasBye = position === profileIndex % 8;
      const hongBye = profileIndex % 2 === 0;
      const hong = hasBye && hongBye ? bye : players[playerIndex++];
      const chung = hasBye && !hongBye ? bye : players[playerIndex++];
      matches.push([
        `TEST-${String(profileIndex + 1).padStart(3, '0')}-PRE-${String(position + 1).padStart(2, '0')}`,
        'PRELIMINARY', division.label, gender, weight, group,
        ...hong, ...chung
      ]);
    }
    categories.push([division.label, division.ageLabel, gender, weight, weight ? category.limit : '', group, group ? category.ageLabel : '', 15, 1, 8, 7, 4, 2, 1]);
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
  for (const { fixture } of fixtures) {
    const bouts = fixture.schedule.filter(bout => bout.status !== 'BYE');
    for (const [index, bout] of bouts.entries()) {
      bout.matchOrder = index + 1;
      const { division, gender, weightCategory, categoryGroup } = fixture.event;
      schedule.push([bout.matchOrder, bout.officialBoutNo, bout.stage, division, gender, weightCategory, categoryGroup, fixtureSourceLabel(fixture, bout, 'RED'), fixtureSourceLabel(fixture, bout, 'BLUE'), 1]);
    }
  }
  validateWorkbookSchedule({ categories: fixtures, schedulePolicy: { minimumMatchGap: 1, scope: 'CATEGORY' } });
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
    ['Format', 'SFTS category fixture. Matches defines bracket positions. Schedule lists the match order within each category. Import both sheets together as XLSX or XLS.'],
    ['Matches', 'Supply opening positions for each category, including BYEs. Preserve bracket row order within each category. SFTS pairs adjacent winners and builds later rounds.'],
    ['Schedule', 'Match Order starts at 1 within EACH category. Every scored bout appears once. BYEs do not appear. Selecting a category keeps its matches on screen until you manually select another.'],
    ['Rest rule', 'Minimum Match Gap is 1. If a player competed in the last completed match, SFTS shows REST REQUIRED. Manually play 1-2 matches in another category, then return. BYEs, practice and waiting time do not count.'],
    ['Category changes', 'No automatic category switching. Continue the selected division, gender and category through preliminary, quarterfinal, semifinal and final. For smaller brackets and before the final, manually switch categories to provide the rest gap.'],
    ['Coverage', `${profiles.length} valid division/gender/category combinations; ${profiles.length * 15} fictional players; ${profiles.length} BYEs; ${profiles.length * 8} opening rows; ${profiles.length * 14} scored matches.`],
    ['Each category', '15 players and exactly 1 preliminary BYE in 16 slots: 7 preliminary matches, 4 quarterfinals, 2 semifinals and 1 final.'],
    ['Categories', 'Checklist of every valid combination, its eligibility and weight/group definition, and expected player, BYE and match counts.'],
    ['Exclusions', 'Unsupported cross-combinations from the rulepack category names are listed for reference only. They are deliberately absent from Matches; do not copy them into the import sheet.'],
    ['Event details', 'Enter tournament name, date, venue, arena and competition in SFTS before importing.'],
    ['Required', 'Bout Number, Stage, Division, Gender, Weight Category (or Group), Hong Name, Hong Club, Chung Name, Chung Club.'],
    ['Optional', 'Hong/Chung State Code and District. State codes must be valid Indian state codes.'],
    ['Stage', 'Within EACH category use the same opening stage: 1 row FINAL, 2 SEMIFINAL, 4 QUARTERFINAL, 8 or more PRELIMINARY. Row counts include BYE positions.'],
    ['Test flow', 'Select Division, Gender and Category, review it, then Load Match. Continue that category through results. If REST REQUIRED appears, select another category manually, finish a match, and return to resume the waiting bout.'],
    ['Bye positions', 'Exactly one BYE per category. Its opening position rotates between categories; both Hong-side and Chung-side BYEs are covered across the workbook.'],
    ['Sides', 'Hong is RED; Chung is BLUE. All player and club names are fictional. Each player name is unique throughout this test workbook.'],
    ['BYEs', 'Put BYE (or leave the name blank) on the empty side, and leave its club, state and district blank. Include BYE rows so the opening row count is a power of two. Each competitor appears once.'],
    ['Progression', 'Adjacent row winners meet next: row 1 winner is HONG, row 2 winner is CHUNG. No reshuffle. SFTS continues locally through the final.'],
    ['Schedule references', 'Bout Number is scoped to Division, Gender and Weight Category or Group. Later rounds use AUTO-R2-001, AUTO-R2-002, etc., then AUTO-R3-001, etc. Source text is Winner of followed by the source bout number. Copy the exact references.'],
    ['Schedule validation', 'SFTS rejects missing/repeated bouts, incorrect sources and rounds out of order. Rest is checked against completed matches when loading. Never change a scored category match order.'],
    ['Results', 'Completed official bout numbers retain their results; their sides and stages cannot be changed.'],
    ['Limits', `Maximum ${MAX_WORKBOOK_CATEGORIES} categories, ${MAX_WORKBOOK_ROWS} opening rows, 8192 schedule rows and 4 MB per file; maximum 256 opening rows / 512 players per category. Matches must be the first worksheet. Schedule must have its exact sheet name.`],
    ['Legacy imports', 'Files without Schedule retain the opening-only flow. CSV cannot carry Schedule. Use this XLSX template for the category schedule and rest checks.'],
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
