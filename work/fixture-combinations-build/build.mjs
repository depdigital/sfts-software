import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Workbook, SpreadsheetFile } from '@oai/artifact-tool';
import { loadRules } from '../../src/rules.js';
import { createFixtureTemplateSheets } from '../../src/fixtureTemplate.js';

const outputDir = path.resolve('outputs/fixture-combinations-20261024');
const rules = await loadRules();
const sourceSheets = createFixtureTemplateSheets(rules.tournament.divisions);
const workbook = Workbook.create();
await fs.mkdir(outputDir, { recursive: true });
for (const [sheetIndex, source] of sourceSheets.entries()) {
  const sheet = workbook.worksheets.add(source.name);
  const columns = Math.max(...source.rows.map(row => row.length));
  const rows = source.rows.map(row => Array.from({ length: columns }, (_, index) => row[index] ?? ''));
  const range = sheet.getRangeByIndexes(0, 0, rows.length, columns);
  range.values = rows;
  range.format.font = { name: 'Arial', size: 10, color: '#172033' };
  range.format.rowHeight = 23;
  range.format.verticalAlignment = 'center';
  sheet.showGridLines = false;
  sheet.tabColor = ['#26364A', '#506682', '#7C8796', '#A36A34'][sheetIndex];
  for (let index = 0; index < columns; index += 1) {
    sheet.getRangeByIndexes(0, index, rows.length, 1).format.columnWidth = source.cols[index]?.wch || 20;
  }
  const header = sheet.getRangeByIndexes(0, 0, 1, columns);
  header.format.fill = '#26364A';
  header.format.font = { name: 'Arial', size: 10, bold: true, color: '#FFFFFF' };
  header.format.horizontalAlignment = 'center';
  header.format.wrapText = true;
  header.format.rowHeight = 38;
  sheet.freezePanes.freezeRows(1);
  if (source.name !== 'Instructions') {
    const table = sheet.tables.add(source.filter, true, `${source.name}Table`);
    table.showFilterButton = true;
  }
  if (source.name === 'Matches') {
    sheet.freezePanes.freezeColumns(1);
    sheet.getRange(`A2:A${rows.length}`).setNumberFormat('@');
    sheet.getRange('G1:J1').format.fill = '#7D3039';
    sheet.getRange('K1:N1').format.fill = '#245875';
    for (let start = 1; start < rows.length; start += 8) {
      sheet.getRangeByIndexes(start, 0, 8, columns).format.fill = (start - 1) / 8 % 2 ? '#F0F4F8' : '#FFFFFF';
      sheet.getRangeByIndexes(start + 7, 0, 1, columns).format.borders = { bottom: { style: 'thin', color: '#B8C5D3' } };
    }
    for (const column of ['G', 'K']) sheet.getRange(`${column}2:${column}${rows.length}`).conditionalFormats.add('containsText', {
      text: 'BYE', format: { fill: '#FFF3D6', font: { color: '#835414', bold: true } }
    });
  } else if (source.name === 'Categories') {
    sheet.getRange(`H2:N${rows.length}`).setNumberFormat('0');
    sheet.getRange(`H2:N${rows.length}`).format.horizontalAlignment = 'right';
  } else if (source.name === 'Instructions') {
    sheet.getRange(`B2:B${rows.length}`).format.wrapText = true;
    sheet.getRange(`A2:B${rows.length}`).format.rowHeight = 42;
    sheet.getRange(`A2:A${rows.length}`).format.font = { name: 'Arial', size: 10, bold: true, color: '#26364A' };
  } else {
    sheet.getRange(`E2:E${rows.length}`).format.wrapText = true;
    sheet.getRange(`A2:E${rows.length}`).format.rowHeight = 32;
  }
}
workbook.recalculate();
const matches = workbook.worksheets.getItem('Matches');
assert.deepEqual(matches.getRange('A1:N1').values[0], sourceSheets[0].rows[0]);
for (const source of sourceSheets) {
  const sheet = workbook.worksheets.getItem(source.name);
  const actual = sheet.getRangeByIndexes(0, 0, source.rows.length, source.rows[0].length).values;
  for (let row = 0; row < source.rows.length; row += 1) {
    assert.deepEqual(actual[row].map(value => value ?? ''), source.rows[row]);
  }
}
const inspection = await workbook.inspect({ kind: 'region', sheetId: 'Matches', range: 'A1:N10', maxChars: 1600, tableMaxRows: 3, tableMaxCols: 6 });
console.log(inspection.ndjson);
const errors = await workbook.inspect({ kind: 'match', searchTerm: '#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A|#NUM!|#NULL!|#SPILL!|#CALC!', options: { useRegex: true, maxResults: 20 }, maxChars: 800 });
console.log(errors.ndjson);
for (const [sheetName, range] of [['Matches', 'A1:N10'], ['Categories', 'A1:N9'], ['Instructions', 'A1:B15'], ['Exclusions', 'A1:E9']]) {
  const preview = await workbook.render({ sheetName, range, scale: 1, format: 'png' });
  await fs.writeFile(path.join(outputDir, `${sheetName.toLowerCase()}-preview.png`), new Uint8Array(await preview.arrayBuffer()));
}
const filePath = path.join(outputDir, 'sfts-complete-tournament-test.xlsx');
await (await SpreadsheetFile.exportXlsx(workbook)).save(filePath);
console.log(JSON.stringify({ filePath, ruleset: rules.ruleset.name, categories: sourceSheets[1].rows.length - 1, players: (sourceSheets[1].rows.length - 1) * 9, byes: (sourceSheets[1].rows.length - 1) * 7, openingRows: sourceSheets[0].rows.length - 1, exclusions: sourceSheets[3].rows.length - 1, bytes: (await fs.stat(filePath)).size }));
