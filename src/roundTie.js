export const ROUND_TIE_SUPERIORITY_CRITERIA = Object.freeze([
  'TECHNICAL_HEAD_KICKS',
  'TECHNICAL_CHEST_KICKS',
  'NORMAL_HEAD_KICKS'
]);

const CRITERION_DETAILS = Object.freeze({
  TECHNICAL_HEAD_KICKS: { stat: 'technicalHead', reason: 'SUP - TECHNICAL HEAD' },
  TECHNICAL_CHEST_KICKS: { stat: 'technicalChest', reason: 'SUP - TECHNICAL CHEST' },
  NORMAL_HEAD_KICKS: { stat: 'plus3', reason: 'SUP - NORMAL HEAD' }
});

/**
 * Compare tied-round statistics in rule-pack order. The first unequal
 * criterion decides the round; lower-priority criteria are not considered.
 */
export function roundTieSuperiority(red, blue, criteria) {
  for (const criterion of criteria) {
    const details = CRITERION_DETAILS[criterion];
    if (!details) continue;
    const redCount = Number(red?.stats?.[details.stat] || 0);
    const blueCount = Number(blue?.stats?.[details.stat] || 0);
    if (redCount === blueCount) continue;
    return {
      winner: redCount > blueCount ? 'RED' : 'BLUE',
      criterion,
      reason: details.reason
    };
  }
  return null;
}
