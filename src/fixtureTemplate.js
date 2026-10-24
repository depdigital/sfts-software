import { FIXTURE_HEADERS, MAX_WORKBOOK_CATEGORIES, MAX_WORKBOOK_ROWS } from './fixtureImport.js';

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
    throw new Error(`The complete test template requires 1 to ${MAX_WORKBOOK_CATEGORIES} valid categories within ${MAX_WORKBOOK_ROWS} opening rows`);
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
    ['Matches', 'One tournament file can contain multiple divisions, genders and categories. Supply only opening positions for each category, including BYEs. Preserve bracket row order within each category. SFTS groups the rows and builds later rounds.'],
    ['Coverage', `${profiles.length} valid division/gender/category combinations; ${profiles.length * 9} fictional players; ${profiles.length * 7} BYEs; ${profiles.length * 8} opening rows.`],
    ['Each category', '9 players and 7 BYEs in 16 slots: 1 contested preliminary, 4 quarterfinals, 2 semifinals and 1 final. Minimum players to exercise all four stages.'],
    ['Categories', 'Checklist of every valid combination, its eligibility and weight/group definition, and expected player, BYE and match counts.'],
    ['Exclusions', 'Unsupported cross-combinations from the rulepack category names are listed for reference only. They are deliberately absent from Matches; do not copy them into the import sheet.'],
    ['Event details', 'Enter tournament name, date, venue, arena and competition in SFTS before importing.'],
    ['Required', 'Bout Number, Stage, Division, Gender, Weight Category (or Group), Hong Name, Hong Club, Chung Name, Chung Club.'],
    ['Optional', 'Hong/Chung State Code and District. State codes must be valid Indian state codes.'],
    ['Stage', 'Within EACH category use the same opening stage: 1 row FINAL, 2 SEMIFINAL, 4 QUARTERFINAL, 8 or more PRELIMINARY. Row counts include BYE positions.'],
    ['Test flow', 'Select Division, Gender and Category; review and start it. Complete all stages, review results, then select another category. Every category starts at PRELIMINARY.'],
    ['Bye positions', 'Both Hong-side and Chung-side BYEs are included. The contested opening position rotates between categories.'],
    ['Sides', 'Hong is RED; Chung is BLUE. All player and club names are fictional. Each player name is unique throughout this test workbook.'],
    ['BYEs', 'Put BYE (or leave the name blank) on the empty side, and leave its club, state and district blank. Include BYE rows so the opening row count is a power of two. Each competitor appears once.'],
    ['Progression', 'Adjacent row winners meet next: row 1 winner is HONG, row 2 winner is CHUNG. No reshuffle. SFTS continues locally through the final.'],
    ['Results', 'Completed official bout numbers retain their results; their sides and stages cannot be changed.'],
    ['Limits', `Maximum ${MAX_WORKBOOK_CATEGORIES} categories, ${MAX_WORKBOOK_ROWS} opening rows and 4 MB per file; maximum 256 opening rows / 512 players per category. Only the first worksheet is read.`],
    ['Competition', 'The competition selected manually in SFTS applies to the entire file. Keep KYORUGI and FRESHER KYORUGI in separate files.']
  ];
  return [
    { name: 'Matches', rows: matches, cols: [21, 18, 18, 12, 22, 15, 25, 28, 18, 20, 25, 28, 18, 20].map(wch => ({ wch })), filter: `A1:N${matches.length}` },
    { name: 'Categories', rows: categories, cols: [18, 30, 12, 22, 32, 16, 28, 14, 10, 16, 23, 16, 16, 12].map(wch => ({ wch })), filter: `A1:N${categories.length}` },
    { name: 'Instructions', rows: instructions, cols: [{ wch: 30 }, { wch: 110 }] },
    { name: 'Exclusions', rows: exclusions, cols: [18, 12, 28, 24, 80].map(wch => ({ wch })), filter: `A1:E${exclusions.length}` }
  ];
}
