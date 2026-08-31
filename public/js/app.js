let ws;
let role = 'unknown';
let lastState = null;
let historyCache = [];
let currentRoundRecord = null;
let audioCtx;

const $ = (id) => document.getElementById(id);

function connectSocket() {
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'state') {
      lastState = msg.match;
      historyCache = msg.matchHistory || [];
      renderState(msg.match);
    }
    if (msg.type === 'award') {
      toast(`MAJORITY ${msg.player} +${msg.points} (${msg.count}/4)`);
    }
    if (msg.type === 'scoreSound') playPointSound(msg.points);
    if (msg.type === 'roundEndSound') playWhistle();
    if (msg.type === 'roundEnd') showRoundSummary(msg.record);
    if (msg.type === 'matchEnd') showWinnerSlide(msg.winner, msg.match);
    if (msg.type === 'testPress') markTest(msg.corner, msg.player, msg.points);
    if (msg.type === 'testReset') resetTestUi();
  };
}
connectSocket();

function send(data) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(data));
  else toast('NOT CONNECTED');
}

function toast(text) {
  const node = $('toast');
  node.textContent = text;
  node.classList.add('show');
  setTimeout(() => node.classList.remove('show'), 2200);
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(el => el.classList.add('hidden'));
  $(id).classList.remove('hidden');
}

function renderState(match) {
  if (!match) return;
  $('redName').textContent = 'HONG';
  $('blueName').textContent = 'CHUNG';
  $('redMeta').textContent = playerMetaText(match.red);
  $('blueMeta').textContent = playerMetaText(match.blue);
  $('redScore').textContent = match.red.score;
  $('blueScore').textContent = match.blue.score;
  $('redGam').textContent = match.red.gamjeom;
  $('blueGam').textContent = match.blue.gamjeom;
  $('matchNo').textContent = String(match.matchNo).padStart(3, '0');
  $('timer').textContent = formatTime(match.timerMs);
  $('roundText').textContent = match.phase === 'MATCH_END' ? 'MATCH END' : `ROUND ${match.round}`;
  $('playBtn').textContent = match.running ? '❚❚ PAUSE' : '▶ PLAY';
  $('voteStrip').textContent = [1,2,3,4].map(c => {
    const v = match.votes[c];
    return `C${c} ${v ? v.player[0] + '+' + v.points : '—'}`;
  }).join('   ');

  if (match.phase === 'BREAK') {
    $('breakTimeText').textContent = `BREAK ${formatTime(match.timerMs)}`;
  }

  if (match.phase !== 'MATCH_END') {
    $('winnerSlide').classList.add('hidden');
  }
}

function playerMetaText(player) {
  const name = String(player.playerName || '').trim() || 'PLAYER NAME —';
  const weight = String(player.weightCategory || '').trim() || 'WEIGHT —';
  const stateCode = String(player.stateCode || '').trim() || 'STATE —';
  const district = String(player.district || '').trim() || 'DISTRICT —';
  return `${name} · ${weight} · ${stateCode} · ${district}`;
}

function formatTime(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function parseTime(value) {
  const text = String(value).trim();
  const parts = text.split(':');
  if (parts.length === 1) return Math.max(1000, Number(parts[0] || 0) * 1000);
  return Math.max(1000, ((Number(parts[0] || 0) * 60) + Number(parts[1] || 0)) * 1000);
}

function openHost() {
  role = 'host';
  send({ type: 'role', role: 'host' });
  showScreen('host');
}

function openRef() {
  role = 'referee';
  showScreen('ref');
}

function nameChange(player, value) {
  send({ type: 'host', action: 'name', player, name: value });
}
function playPause() { send({ type: 'host', action: 'playPause' }); }
function resetRoundTimer() { send({ type: 'host', action: 'resetRoundTimer' }); }
function manualPoint(player, points) { send({ type: 'host', action: 'point', player, points }); }
function manualGam(player) { send({ type: 'host', action: 'gamjeom', player }); }

function editScore(player) {
  if (!lastState) return;
  const current = player === 'RED' ? lastState.red.score : lastState.blue.score;
  const value = prompt(`Set ${player} score`, current);
  if (value !== null) send({ type: 'host', action: 'editScore', player, value: Number(value) });
}
function editGam(player) {
  if (!lastState) return;
  const current = player === 'RED' ? lastState.red.gamjeom : lastState.blue.gamjeom;
  const value = prompt(`Set ${player} gam-jeom`, current);
  if (value !== null) send({ type: 'host', action: 'editGamjeom', player, value: Number(value) });
}

function openSettings() { $('settingsModal').classList.remove('hidden'); }
function closeSettings() { $('settingsModal').classList.add('hidden'); }
function openPlayerSettings() {
  closeSettings();
  if (!lastState) return;
  $('playerRedName').value = lastState.red.playerName || '';
  $('playerRedWeight').value = lastState.red.weightCategory || '';
  $('playerRedDistrict').value = lastState.red.district || '';
  $('playerRedStateCode').value = lastState.red.stateCode || '';
  $('playerBlueName').value = lastState.blue.playerName || '';
  $('playerBlueWeight').value = lastState.blue.weightCategory || '';
  $('playerBlueDistrict').value = lastState.blue.district || '';
  $('playerBlueStateCode').value = lastState.blue.stateCode || '';
  $('playerSettingsModal').classList.remove('hidden');
}
function closePlayerSettings() { $('playerSettingsModal').classList.add('hidden'); }
function savePlayerSettings() {
  send({
    type: 'host',
    action: 'playerSettings',
    players: {
      RED: {
        playerName: $('playerRedName').value,
        weightCategory: $('playerRedWeight').value,
        stateCode: $('playerRedStateCode').value,
        district: $('playerRedDistrict').value
      },
      BLUE: {
        playerName: $('playerBlueName').value,
        weightCategory: $('playerBlueWeight').value,
        stateCode: $('playerBlueStateCode').value,
        district: $('playerBlueDistrict').value
      }
    }
  });
  closePlayerSettings();
}
function resetCurrentMatch() {
  if (confirm('Reset the current match?')) send({ type: 'host', action: 'resetMatch' });
  closeSettings();
}

function openTimerEditor() {
  closeSettings();
  if (lastState) $('timeInput').value = formatTime(lastState.configuredRoundMs);
  $('timerModal').classList.remove('hidden');
}
function closeTimerEditor() { $('timerModal').classList.add('hidden'); }
function saveTimer() {
  send({ type: 'host', action: 'setTime', ms: parseTime($('timeInput').value) });
  closeTimerEditor();
}

async function showQR() {
  closeSettings();
  const res = await fetch('/api/info');
  const data = await res.json();
  $('qrImage').src = data.qr;
  $('qrUrl').textContent = data.url;
  $('qrModal').classList.remove('hidden');
}
function closeQR() { $('qrModal').classList.add('hidden'); }

function openHistory() {
  closeSettings();
  const box = $('historyList');
  if (!historyCache.length) {
    box.innerHTML = '<p>No completed matches yet.</p>';
  } else {
    box.innerHTML = historyCache.map(item => `
      <div class="historyItem">
        <div><b>MATCH ${String(item.matchNo).padStart(3, '0')}</b></div>
        <div>${escapeHtml(item.redName)} vs ${escapeHtml(item.blueName)}</div>
        <div><strong>${escapeHtml(item.winnerName)}</strong> — ${escapeHtml(item.reason || '')}</div>
        <div>${item.rounds.length} round(s)</div>
      </div>
    `).join('');
  }
  $('historyModal').classList.remove('hidden');
}
function closeHistory() { $('historyModal').classList.add('hidden'); }

function showRoundSummary(record) {
  currentRoundRecord = record;
  const redName = record.red.playerName || record.red.name;
  const blueName = record.blue.playerName || record.blue.name;
  $('roundTitle').textContent = record.winner
    ? `${record.winner === 'RED' ? redName : blueName} WON ROUND ${record.round}`
    : `ROUND ${record.round} COMPLETE`;
  $('roundReason').textContent = record.reason;
  $('summaryRedName').textContent = redName;
  $('summaryBlueName').textContent = blueName;
  $('summaryRedScore').textContent = record.red.score;
  $('summaryBlueScore').textContent = record.blue.score;
  $('summaryRedGam').textContent = record.red.gamjeom;
  $('summaryBlueGam').textContent = record.blue.gamjeom;
  $('summaryRedP1').textContent = record.red.stats.plus1;
  $('summaryRedP2').textContent = record.red.stats.plus2;
  $('summaryRedP3').textContent = record.red.stats.plus3;
  $('summaryBlueP1').textContent = record.blue.stats.plus1;
  $('summaryBlueP2').textContent = record.blue.stats.plus2;
  $('summaryBlueP3').textContent = record.blue.stats.plus3;
  $('roundOverlay').classList.remove('hidden');
}
function closeRoundOverlay() { $('roundOverlay').classList.add('hidden'); }

function showWinnerSlide(winner, match) {
  if (!winner) return;
  const side = winner === 'RED' ? match.red : match.blue;
  const name = side.playerName || side.name;
  $('winnerNameText').textContent = name;
  $('winnerSlide').classList.remove('redWinner', 'blueWinner', 'hidden');
  $('winnerSlide').classList.add(winner === 'RED' ? 'redWinner' : 'blueWinner');
}
function startNewMatch() {
  send({ type: 'host', action: 'newMatch' });
  $('winnerSlide').classList.add('hidden');
  $('roundOverlay').classList.add('hidden');
}

function connectRef() {
  const corner = Number($('cornerSelect').value);
  send({ type: 'role', role: 'referee', corner });
  $('refStatus').textContent = `C${corner} CONNECTED`;
}
function refVote(player, points) {
  const corner = Number($('cornerSelect').value);
  send({ type: 'ref', action: 'vote', player, points });
  $('refVoteText').textContent = `C${corner}: ${player} +${points}`;
}
function cancelVote() {
  send({ type: 'ref', action: 'cancel' });
  $('refVoteText').textContent = 'VOTE CANCELLED';
}

function openTestMode() {
  closeSettings();
  resetTestUi();
  showScreen('testMode');
  send({ type: 'host', action: 'testStart' });
}
function closeTestMode() {
  send({ type: 'host', action: 'testStop' });
  showScreen('host');
}
function resetTestUi() {
  for (let i = 1; i <= 4; i++) {
    const joy = $(`joy${i}`);
    if (!joy) continue;
    joy.classList.remove('passed');
    joy.querySelectorAll('i').forEach(el => el.classList.remove('litRed', 'litBlue'));
  }
}
function markTest(corner, player, points) {
  const joy = $(`joy${corner}`);
  if (!joy) return;
  const item = joy.querySelector(`[data-key="${player}-${points}"]`);
  if (item) item.classList.add(player === 'RED' ? 'litRed' : 'litBlue');
  const all = ['RED-1','RED-2','RED-3','BLUE-1','BLUE-2','BLUE-3'];
  const done = all.every(key => {
    const el = joy.querySelector(`[data-key="${key}"]`);
    return el && (el.classList.contains('litRed') || el.classList.contains('litBlue'));
  });
  if (done) joy.classList.add('passed');
}

function audio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
}
function beep(freq, dur, type = 'sine', gain = 0.15) {
  try {
    audio();
    const osc = audioCtx.createOscillator();
    const amp = audioCtx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    amp.gain.setValueAtTime(0.0001, audioCtx.currentTime);
    amp.gain.exponentialRampToValueAtTime(gain, audioCtx.currentTime + 0.01);
    amp.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + dur);
    osc.connect(amp).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + dur + 0.02);
  } catch (e) {}
}
function playPointSound(points) {
  if (points === 1) beep(620, 0.13, 'square');
  if (points === 2) beep(800, 0.18, 'square');
  if (points === 3) beep(980, 0.24, 'square');
}
function playWhistle() {
  beep(1500, 0.65, 'square', 0.11);
  setTimeout(() => beep(1750, 0.65, 'square', 0.11), 650);
  setTimeout(() => beep(1500, 0.65, 'square', 0.11), 1300);
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

window.openHost = openHost;
window.openRef = openRef;
window.nameChange = nameChange;
window.playPause = playPause;
window.resetRoundTimer = resetRoundTimer;
window.manualPoint = manualPoint;
window.manualGam = manualGam;
window.editScore = editScore;
window.editGam = editGam;
window.openSettings = openSettings;
window.closeSettings = closeSettings;
window.openPlayerSettings = openPlayerSettings;
window.closePlayerSettings = closePlayerSettings;
window.savePlayerSettings = savePlayerSettings;
window.resetCurrentMatch = resetCurrentMatch;
window.openTimerEditor = openTimerEditor;
window.closeTimerEditor = closeTimerEditor;
window.saveTimer = saveTimer;
window.showQR = showQR;
window.closeQR = closeQR;
window.openHistory = openHistory;
window.closeHistory = closeHistory;
window.closeRoundOverlay = closeRoundOverlay;
window.startNewMatch = startNewMatch;
window.connectRef = connectRef;
window.refVote = refVote;
window.cancelVote = cancelVote;
window.openTestMode = openTestMode;
window.closeTestMode = closeTestMode;
