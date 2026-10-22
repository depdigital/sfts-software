import assert from 'node:assert/strict';
import test from 'node:test';
import { createManualCategoryPdf, manualCategoryPdfFileName } from '../src/manualCategoryPdf.js';

function player(playerName, club, stateCode, district) {
  return { playerName, club, stateCode, district };
}

function sampleCategory() {
  return {
    id: 'sample-category',
    eventName: 'SFTS National Championship',
    eventDate: '2026-10-22',
    venue: 'Central Indoor Stadium',
    arenaNumber: '2',
    competition: 'KYORUGI',
    division: 'SENIOR',
    divisionLabel: 'SENIOR',
    gender: 'MALE',
    weightCategory: 'FEATHERWEIGHT',
    status: 'FINALIZED',
    placementSource: 'AUTOMATIC_CONFIRMED',
    ruleset: { name: 'SFTS Default Rules', ruleVersion: '2026.1' },
    calculatedPlacements: {},
    placements: {
      gold: { key: 'ARJUN RAO|STRIKE CLUB', playerName: 'Arjun Rao', club: 'Strike Club' },
      silver: { key: 'ROHAN DAS|FORCE ACADEMY', playerName: 'Rohan Das', club: 'Force Academy' },
      bronze1: { key: 'VIKRAM SEN|CITY TKD', playerName: 'Vikram Sen', club: 'City TKD' },
      bronze2: null
    }
  };
}

function sampleRecords() {
  return [{
    id: 'match-1',
    matchNo: 17,
    manualBout: { categoryId: 'sample-category', officialBoutNo: 'F-1', stage: 'FINAL' },
    red: player('Arjun Rao', 'Strike Club', 'KA', 'Bengaluru'),
    blue: player('Rohan Das', 'Force Academy', 'DL', 'New Delhi'),
    redName: 'Arjun Rao',
    blueName: 'Rohan Das',
    winner: 'RED',
    winnerName: 'Arjun Rao',
    defeatedName: 'Rohan Das',
    reason: 'PTF - WON 2 ROUNDS',
    startedAt: '2026-10-22T08:00:00.000Z',
    endedAt: '2026-10-22T08:05:00.000Z',
    rounds: [
      { round: 1, winner: 'RED', reason: 'TIME 0:00', red: { score: 8, gamjeom: 0 }, blue: { score: 5, gamjeom: 1 } },
      { round: 2, winner: 'RED', reason: 'PTG - 15-POINT GAP', red: { score: 18, gamjeom: 0 }, blue: { score: 3, gamjeom: 0 } }
    ],
    operatorHistory: [{ round: 1, player: 'RED', action: 'SCORE CORRECTION', from: 6, to: 8, timerMs: 22000, recordedAt: '2026-10-22T08:02:00.000Z' }],
    cornerRefereeHistory: [{ round: 1, cornerReferee: 'C1', button: 'RED HEAD', score: 3, timerMs: 44000, pressedAt: '2026-10-22T08:01:00.000Z' }]
  }, {
    id: 'match-2',
    matchNo: 16,
    manualBout: { categoryId: 'sample-category', officialBoutNo: 'SF-1', stage: 'SEMIFINAL' },
    red: player('Arjun Rao', 'Strike Club', 'KA', 'Bengaluru'),
    blue: player('Vikram Sen', 'City TKD', 'MH', 'Pune'),
    redName: 'Arjun Rao',
    blueName: 'Vikram Sen',
    winner: 'RED',
    winnerName: 'Arjun Rao',
    defeatedName: 'Vikram Sen',
    reason: 'SUP - WOO-SE-GIROK',
    startedAt: '2026-10-22T07:40:00.000Z',
    endedAt: '2026-10-22T07:46:00.000Z',
    rounds: [{ round: 1, winner: 'RED', reason: 'SUP - WOO-SE-GIROK', red: { score: 6, gamjeom: 0 }, blue: { score: 6, gamjeom: 0 } }],
    operatorHistory: [],
    cornerRefereeHistory: []
  }];
}

test('manual category PDF is generated with all optional report sections', async () => {
  const pdf = await createManualCategoryPdf({
    category: sampleCategory(),
    records: sampleRecords(),
    options: { includeBoutSummary: true, includeFullAudit: true, includeCornerRefereeHistory: true },
    generatedAt: '2026-10-22T09:30:00.000Z'
  });

  assert.equal(pdf.subarray(0, 5).toString('ascii'), '%PDF-');
  assert.ok(pdf.length > 5000);
  const pageCount = (pdf.toString('latin1').match(/\/Type \/Page\b/g) || []).length;
  assert.ok(pageCount >= 3);
  assert.ok(pageCount <= 5, `PDF unexpectedly expanded to ${pageCount} pages`);
});

test('manual category PDF filename is USB-safe and deterministic', () => {
  assert.equal(
    manualCategoryPdfFileName(sampleCategory(), new Date('2026-10-22T09:30:00.000Z')),
    'SFTS_Category_Result_SENIOR_MALE_FEATHERWEIGHT_20261022_093000.pdf'
  );
});
