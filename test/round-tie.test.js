import assert from 'node:assert/strict';
import test from 'node:test';
import { roundTieSuperiority, ROUND_TIE_SUPERIORITY_CRITERIA } from '../src/roundTie.js';

const relationValues = Object.freeze({ less: 4, equal: 5, greater: 6 });

function side(technicalHead, technicalChest, normalHead) {
  return { stats: { technicalHead, technicalChest, plus3: normalHead } };
}

function expectedWinner(headRelation, chestRelation, normalRelation) {
  const firstDifference = [headRelation, chestRelation, normalRelation].find(value => value !== 'equal');
  if (!firstDifference) return null;
  return firstDifference === 'greater' ? 'RED' : 'BLUE';
}

test('all 27 superiority relation permutations obey strict priority order', () => {
  const relations = ['less', 'equal', 'greater'];
  let checked = 0;
  for (const headRelation of relations) {
    for (const chestRelation of relations) {
      for (const normalRelation of relations) {
        const red = side(
          relationValues[headRelation],
          relationValues[chestRelation],
          relationValues[normalRelation]
        );
        const blue = side(5, 5, 5);
        const result = roundTieSuperiority(red, blue, ROUND_TIE_SUPERIORITY_CRITERIA);
        assert.equal(
          result?.winner || null,
          expectedWinner(headRelation, chestRelation, normalRelation),
          `TH=${headRelation}, TC=${chestRelation}, NH=${normalRelation}`
        );
        checked += 1;
      }
    }
  }
  assert.equal(checked, 27);
});

test('the approved 6-6 and 12-12 examples select the expected winners', () => {
  const sixAll = roundTieSuperiority(
    side(1, 0, 0),
    side(0, 1, 0),
    ROUND_TIE_SUPERIORITY_CRITERIA
  );
  assert.deepEqual(sixAll, {
    winner: 'RED',
    criterion: 'TECHNICAL_HEAD_KICKS',
    reason: 'SUP - TECHNICAL HEAD'
  });

  const twelveAll = roundTieSuperiority(
    side(0, 0, 4),
    side(2, 0, 0),
    ROUND_TIE_SUPERIORITY_CRITERIA
  );
  assert.equal(twelveAll?.winner, 'BLUE');
  assert.equal(twelveAll?.reason, 'SUP - TECHNICAL HEAD');
});
