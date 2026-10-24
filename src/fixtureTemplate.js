import { FIXTURE_HEADERS } from './fixtureImport.js';

export function createFixtureTemplateSheets(divisions) {
  const definition = divisions.find(item => item.categoryType === 'WEIGHT' && item.weightCategories.MALE.length > 1)
    || divisions.find(item => item.categoryType === 'GROUP' && item.groups.length > 1)
    || divisions[0];
  const weightCategory = definition.categoryType === 'WEIGHT' ? definition.weightCategories.MALE[0].name : '';
  const categoryGroup = definition.categoryType === 'GROUP' ? definition.groups[0].name : '';
  const playerHeaders = FIXTURE_HEADERS;
  const dummyPlayers = [
    ['Arjun Sen', 'Falcon Taekwondo'],
    ['Rohan Das', 'Riverfront Martial Arts'],
    ['Kabir Roy', 'Summit Taekwondo'],
    ['Ishaan Ghosh', 'Falcon Taekwondo'],
    ['Vivaan Dutta', 'Riverfront Martial Arts'],
    ['Aarav Bose', 'Summit Taekwondo'],
    ['Neel Banerjee', 'Falcon Taekwondo'],
    ['Dhruv Pal', 'Riverfront Martial Arts'],
    ['Aditya Saha', 'Summit Taekwondo']
  ];
  const dummyPlayer = number => [...dummyPlayers[number - 1], 'WB', 'Nadia'];
  const playerExamples = Array.from({ length: 8 }, (_, index) => [
    `DEMO-PRE-${String(index + 1).padStart(2, '0')}`, 'PRELIMINARY', definition.label, 'MALE', weightCategory, categoryGroup,
    ...dummyPlayer(index === 0 ? 1 : index + 2),
    ...(index === 0 ? dummyPlayer(2) : ['BYE', '', '', ''])
  ]);
  const secondDivision = divisions.find(item => item.id !== definition.id);
  const extraCategories = [
    { division: definition, gender: 'MALE', index: 1, players: [['Kunal Dey', 'Riverfront Martial Arts'], ['Soham Paul', 'Summit Taekwondo']] },
    { division: definition, gender: 'FEMALE', index: 0, players: [['Ananya Mitra', 'Falcon Taekwondo'], ['Meera Sanyal', 'Summit Taekwondo']] },
    { division: secondDivision, gender: 'MALE', index: 0, players: [['Sayan Chatterjee', 'Falcon Taekwondo'], ['Dev Malhotra', 'Riverfront Martial Arts']] }
  ].filter(({ division, gender, index }) => division && (division.categoryType === 'WEIGHT' ? division.weightCategories[gender][index] : division.groups[index]));
  for (const [index, { division, gender, index: categoryIndex, players }] of extraCategories.entries()) {
    const weight = division.categoryType === 'WEIGHT' ? division.weightCategories[gender][categoryIndex].name : '';
    const group = division.categoryType === 'GROUP' ? division.groups[categoryIndex].name : '';
    playerExamples.push([`SAMPLE-FINAL-${String(index + 1).padStart(2, '0')}`, 'FINAL', division.label, gender, weight, group,
      ...players[0], 'WB', 'Nadia', ...players[1], 'WB', 'Nadia']);
  }
  const playerCols = playerHeaders.map(() => ({ wch: 22 }));

  const categoryRows = [['Division', 'Age Eligibility', 'Gender', 'Weight Category', 'Weight Limit', 'Group', 'Group Age Limit']];
  for (const division of divisions) {
    if (division.categoryType === 'WEIGHT') {
      for (const gender of ['MALE', 'FEMALE']) {
        for (const category of division.weightCategories[gender]) {
          categoryRows.push([division.label, division.ageLabel, gender, category.name, category.limit, '', '']);
        }
      }
    } else {
      for (const group of division.groups) {
        categoryRows.push([division.label, division.ageLabel, 'MALE / FEMALE', '', '', group.name, group.ageLabel]);
      }
    }
  }
  const categoryCols = [
    { wch: 16 }, { wch: 27 }, { wch: 18 }, { wch: 22 }, { wch: 29 }, { wch: 14 }, { wch: 25 }
  ];

  const instructions = [
    ['SFTS TOURNAMENT FIXTURE IMPORT'],
    ['Matches', 'One tournament file can contain multiple divisions, genders and categories. Supply only opening positions for each category, including BYEs. Preserve bracket row order within each category. SFTS groups the rows and builds later rounds.'],
    ['Test tournament', `${9 + extraCategories.length * 2} fictional players across ${1 + extraCategories.length} categories: a 9-player male bracket with 7 BYEs to test all rounds, plus 2-player finals for selector testing. Replace all sample rows for your tournament.`],
    ['Test the selectors', 'Within the first division, select MALE and switch between its available categories. Then switch to FEMALE within that division. Finally select the other division. Extra samples use only categories available in the active rulepack.'],
    ['Event details', 'Enter tournament name, date, venue, arena and competition in SFTS before importing.'],
    ['Required', 'Bout Number, Stage, Division, Gender, Weight Category (or Group), Hong Name, Hong Club, Chung Name, Chung Club.'],
    ['Optional', 'Hong/Chung State Code and District. State codes must be valid Indian state codes.'],
    ['Stage', 'Within EACH category use the same opening stage: 1 row FINAL, 2 SEMIFINAL, 4 QUARTERFINAL, 8 or more PRELIMINARY. Row counts include BYE positions.'],
    ['Sides', 'Hong is RED; Chung is BLUE. Supply actual competitors from the fixture software.'],
    ['BYEs', 'Put BYE (or leave the name blank) on the empty side, and leave its club, state and district blank. Include BYE rows so the opening row count is a power of two. Each competitor appears once.'],
    ['Progression', 'Adjacent row winners meet next: row 1 winner is HONG, row 2 winner is CHUNG. No reshuffle. SFTS continues locally through the final.'],
    ['Results', 'Completed official bout numbers retain their results; their sides and stages cannot be changed.'],
    ['Limits', 'Maximum 128 categories, 4096 opening rows and 4 MB per file; maximum 256 opening rows / 512 competitors per category. At least two actual competitors per category. Only the first worksheet is read.'],
    ['Competition', 'The competition selected manually in SFTS applies to the entire file. Keep KYORUGI and FRESHER KYORUGI in separate files.']
  ];
  return [
    { name: 'Matches', rows: [playerHeaders, ...playerExamples], cols: playerCols, filter: `A1:N${playerExamples.length + 1}` },
    { name: 'Categories', rows: categoryRows, cols: categoryCols, filter: `A1:G${categoryRows.length}` },
    { name: 'Instructions', rows: instructions, cols: [{ wch: 30 }, { wch: 105 }] }
  ];
}
