import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFixtureProgression, refreshFixtureProgression, nextFixtureBout, stageForSlots, validFixtureGraph } from '../src/fixtureProgression.js';

function fixture(rows) {
  const player = name => name ? { playerName: name, club: `${name} Club`, stateCode: '', district: '' } : null;
  const players = new Map();
  const result = {
    progressionMode: 'OPENING_FIXTURE', event: { division: 'SENIOR', gender: 'MALE', weightCategory: 'FLYWEIGHT', categoryGroup: '' },
    schedule: rows.map(([red, blue], index) => {
      const RED = player(red), BLUE = player(blue);
      for (const item of [RED, BLUE].filter(Boolean)) players.set(item.playerName, { ...item, id: item.playerName });
      return { boutNo: index + 1, officialBoutNo: `OPEN-${index + 1}`, stage: stageForSlots(rows.length * 2), RED, BLUE, redPlayerName: red || 'BYE', bluePlayerName: blue || 'BYE' };
    })
  };
  result.players = [...players.values()];
  return result;
}

test('opening fixtures progress in supplied order through every stage at all supported sizes', () => {
  for (const count of [1, 2, 4, 8, 16, 32, 64, 128, 256]) {
    const result = fixture(Array.from({ length: count }, (_, i) => [`Hong ${i}`, `Chung ${i}`]));
    buildFixtureProgression(result);
    assert.equal(result.schedule.length, count * 2 - 1);
    assert.ok(validFixtureGraph(result));
    let played = 0;
    for (let bout; (bout = nextFixtureBout(result));) {
      assert.ok(bout.RED && bout.BLUE);
      bout.winner = 'RED';
      bout.winnerName = bout.RED.playerName;
      bout.status = 'COMPLETED';
      refreshFixtureProgression(result);
      played += 1;
    }
    assert.equal(played, count * 2 - 1);
    assert.equal(result.schedule.at(-1).winnerName, 'Hong 0');
    assert.equal(result.schedule.at(-1).stage, 'FINAL');
    assert.ok(validFixtureGraph(result));
    if (count >= 8) assert.ok(result.schedule.some(bout => bout.stage === 'QUARTERFINAL'));
  }
});

test('explicit red and blue BYEs advance without creating scored matches', () => {
  const result = fixture([['A', 'B'], ['C', null], ['D', 'E'], [null, 'F']]);
  buildFixtureProgression(result);
  assert.equal(result.schedule[1].status, 'BYE');
  assert.equal(result.schedule[3].winner, 'BLUE');
  assert.equal(result.schedule[4].BLUE.playerName, 'C');
  assert.equal(result.schedule[5].BLUE.playerName, 'F');
  assert.equal(nextFixtureBout(result).boutNo, 1);
  Object.assign(result.schedule[0], { status: 'COMPLETED', winner: 'BLUE', winnerName: 'B' });
  refreshFixtureProgression(result);
  assert.equal(nextFixtureBout(result).boutNo, 3);
  assert.equal(result.schedule[4].RED.playerName, 'B');
  assert.ok(validFixtureGraph(result));
});

test('invalid opening positions and duplicated competitors are rejected', () => {
  assert.throws(() => buildFixtureProgression(fixture([['A', 'B'], ['C', 'D'], ['E', 'F']])), /BYE positions/);
  assert.throws(() => buildFixtureProgression(fixture([['A', 'B'], ['A', 'D']])), /appears more than once/);
  assert.throws(() => buildFixtureProgression(fixture([['A', null]])), /At least two/);
  const wrong = fixture([['A', 'B'], ['C', 'D']]);
  wrong.schedule[0].stage = 'PRELIMINARY';
  assert.throws(() => buildFixtureProgression(wrong), /starts at SEMIFINAL/);
});

test('winner changes update pending competitors and lock ancestors once a dependent match is loaded', () => {
  const result = fixture([['A', 'B'], ['C', 'D']]);
  buildFixtureProgression(result);
  Object.assign(result.schedule[0], { status: 'COMPLETED', winner: 'RED' });
  Object.assign(result.schedule[1], { status: 'COMPLETED', winner: 'BLUE' });
  refreshFixtureProgression(result);
  assert.equal(result.schedule[2].RED.playerName, 'A');
  result.schedule[0].winner = 'BLUE';
  refreshFixtureProgression(result);
  assert.equal(result.schedule[2].RED.playerName, 'B');
  assert.equal(result.schedule[0].correctionLocked, false);
  result.schedule[2].status = 'IN_PROGRESS';
  refreshFixtureProgression(result);
  assert.equal(result.schedule[0].correctionLocked, true);
  assert.equal(result.schedule[1].correctionLocked, true);
  result.schedule[2].redSourceBoutNo = 3;
  assert.equal(validFixtureGraph(result), false, 'saved progression must not contain cycles or altered links');
});
