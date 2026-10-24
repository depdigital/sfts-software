let importWizardStep = 0;
let pendingImportReview = null;
let importRequestBusy = false;
let pendingImportedLoad = null;

function importWizardError(message = '') {
  const node = document.getElementById('importWizardError');
  node.textContent = message;
  node.classList.toggle('hidden', !message);
}

function setImportStep(step) {
  if (step === 2 && !pendingImportReview) step = 1;
  if (step >= 3 && !lastTournament?.event) step = 0;
  importWizardStep = Math.max(0, Math.min(4, step));
  importWizardError();
  renderImportWizard();
}

function importEventNext() {
  const event = importEventDetails();
  if (!event) return;
  const date = new Date(`${event.eventDate}T00:00:00Z`);
  if (!Number.isFinite(date.valueOf()) || date.toISOString().slice(0, 10) !== event.eventDate || !/^[1-9]\d{0,2}$/.test(event.arenaNumber)) {
    importWizardError('Enter a valid event date and an arena number from 1 to 999.');
    return;
  }
  pendingImportReview = null;
  setImportStep(1);
  if (usbImportOnly) void refreshUsbFiles();
}

function resumeImportedCategory() {
  pendingImportReview = null;
  setImportStep(lastTournament?.schedule?.every(bout => ['COMPLETED', 'BYE'].includes(bout.status)) ? 4 : 3);
}

function prepareAnotherCategory() {
  pendingImportReview = null;
  setImportStep(0);
}

function importPlayerCard(player, label) {
  return `<div><b>${label}</b><strong>${escapeHtml(player?.playerName || 'BYE')}</strong><span>${escapeHtml(player?.club || 'Advances without a match')}</span></div>`;
}

function renderImportWizard() {
  const modal = $('dataImportModal');
  if (!modal || modal.classList.contains('hidden')) return;
  for (let step = 0; step < 5; step += 1) {
    $(`importStep${step}`).classList.toggle('hidden', step !== importWizardStep);
    const marker = $('importWizardSteps').children[step];
    marker.classList.toggle('active', step === importWizardStep);
    marker.classList.toggle('complete', step < importWizardStep);
    if (step === importWizardStep) marker.setAttribute('aria-current', 'step');
    else marker.removeAttribute('aria-current');
  }
  $('importResumeButton').classList.toggle('hidden', !lastTournament?.event);
  $('importStartButton').disabled = importRequestBusy || !pendingImportReview;
  if (pendingImportReview) {
    const fixture = pendingImportReview.fixture;
    const event = fixture.event;
    $('importDivision').value = event.divisionLabel || event.division;
    $('importGender').value = event.gender;
    $('importWeightCategory').value = event.categoryGroup || event.weightCategory;
    $('importCategoryLabel').textContent = event.categoryGroup ? 'CATEGORY GROUP' : 'WEIGHT CATEGORY';
    $('importCategorySummary').textContent = `${event.eventName} · ${event.eventDate} · ${event.venue} · ARENA ${event.arenaNumber} · ${event.competition}`;
    const opening = fixture.schedule.slice(0, fixture.openingBoutCount);
    $('importReviewSummary').textContent = `${fixture.players.length} competitors · ${opening.filter(bout => bout.status === 'BYE').length} BYEs · ${fixture.schedule.filter(bout => bout.status !== 'BYE').length} matches through the final`;
    $('importReviewTable').innerHTML = `<table><thead><tr><th>POSITION / BOUT</th><th>HONG</th><th>CHUNG</th><th>STAGE</th></tr></thead><tbody>${opening.map(bout => `<tr><td>${escapeHtml(bout.officialBoutNo)}</td><td>${escapeHtml(bout.RED?.playerName || 'BYE')}<br>${escapeHtml(bout.RED?.club || '')}</td><td>${escapeHtml(bout.BLUE?.playerName || 'BYE')}<br>${escapeHtml(bout.BLUE?.club || '')}</td><td>${escapeHtml(bout.stage)}</td></tr>`).join('')}</tbody></table>`;
  }
  if (importWizardStep < 3) return;
  const fixture = lastTournament;
  const active = fixture.schedule.find(bout => bout.boutNo === fixture.activeBoutNo);
  const unfinished = fixture.schedule.find(bout => !['COMPLETED', 'BYE'].includes(bout.status));
  const next = active || unfinished;
  const category = lastManualCompetition.categories.find(item => item.id === fixture.categoryId);
  const event = fixture.event;
  const context = `${event.eventName} · ${event.divisionLabel || event.division} · ${event.gender} · ${event.categoryGroup || event.weightCategory}`;
  if (next) {
    const round = fixture.schedule.filter(bout => bout.round === next.round && bout.status !== 'BYE');
    const progress = `${next.stage} — MATCH ${round.findIndex(bout => bout.boutNo === next.boutNo) + 1} OF ${round.length}`;
    const canLoad = next.status === 'SCHEDULED' && !category?.finalizedAt && !pendingImportedLoad && !fixture.recoveryError;
    $('importRunCard').innerHTML = `<p class="manualHint">${escapeHtml(context)}</p><p class="importProgress">${escapeHtml(progress)}</p><h3>BOUT ${escapeHtml(next.officialBoutNo)}</h3><div class="importMatchSides">${importPlayerCard(next.RED, 'HONG / RED')}${importPlayerCard(next.BLUE, 'CHUNG / BLUE')}</div><p>${escapeHtml(fixture.recoveryError || (next.status === 'TIE_PENDING' ? 'Confirm the winner below before continuing.' : active ? 'This match is loaded on the scoreboard.' : 'Review these competitors, then load the next match.'))}</p><button onclick="${active ? 'returnToImportedScoreboard()' : 'loadNextImportedBout()'}" ${!active && !canLoad ? 'disabled' : ''}>${active ? 'RETURN TO SCOREBOARD' : pendingImportedLoad ? 'LOADING…' : 'LOAD NEXT MATCH'}</button>`;
  } else {
    $('importRunCard').innerHTML = `<p>${escapeHtml(context)}</p><h3>CATEGORY MATCHES COMPLETE</h3><p>Review the category results and finalize the placements.</p><button onclick="setImportStep(4)">CONTINUE TO RESULTS</button>`;
  }
  const completed = fixture.schedule.filter(bout => ['COMPLETED', 'TIE_PENDING'].includes(bout.status));
  const selected = $('importCorrectBout').value;
  $('importCorrectionPanel').classList.toggle('hidden', fixture.progressionMode !== 'OPENING_FIXTURE' || !completed.length);
  $('importCorrectBout').innerHTML = [...completed].reverse().map(bout => `<option value="${bout.boutNo}">${escapeHtml(bout.officialBoutNo)} · ${escapeHtml(bout.winnerName || 'WINNER REQUIRED')}</option>`).join('');
  if (completed.some(bout => String(bout.boutNo) === selected)) $('importCorrectBout').value = selected;
  renderImportCorrection();
  const labels = { gold: 'GOLD', silver: 'SILVER', bronze1: 'BRONZE', bronze2: 'BRONZE' };
  const medals = Object.entries(category?.placements || {}).filter(([, player]) => player);
  $('importResultsCard').innerHTML = `<p>${escapeHtml(context)}</p><p>${unfinished ? 'Category is still in progress. Placements will update as semifinal and final results are recorded.' : 'All matches are complete. Review and finalize these results.'}</p>${medals.map(([place, player]) => `<p><b>${labels[place]}</b> · ${escapeHtml(player.playerName)} · ${escapeHtml(player.club)}</p>`).join('')}`;
}

function renderImportCorrection() {
  const bout = lastTournament?.schedule.find(item => String(item.boutNo) === $('importCorrectBout').value);
  const category = lastManualCompetition.categories.find(item => item.id === lastTournament?.categoryId);
  const locked = !bout || bout.correctionLocked || category?.status === 'FINALIZED';
  $('importCorrectRed').disabled = locked;
  $('importCorrectBlue').disabled = locked;
  $('importCorrectionHint').textContent = !bout ? '' : locked ? 'This result is locked because a dependent match was loaded/completed or the category is finalized.' : `Recorded winner: ${bout.winnerName || 'not decided'}. Confirm any correction before loading the dependent match.`;
}

async function correctImportedResult(winner) {
  const bout = lastTournament?.schedule.find(item => String(item.boutNo) === $('importCorrectBout').value);
  if (!bout || !await requestUserPermission(`Correct bout ${bout.officialBoutNo}: declare ${bout[winner].playerName} the winner? This updates the next match and category results.`)) return;
  send({ type: 'host', action: 'correctImportedWinner', boutNo: bout.boutNo, winner });
}

async function requestFixtureImport(source, event, preview, digest) {
  const headers = { 'X-SFTS-Host-Token': hostToken };
  let url;
  let body;
  if (source.fileName) {
    url = '/api/usb/import';
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify({ fileName: source.fileName, event, preview, digest });
  } else {
    url = `/api/tournament/import${preview ? '?preview=true' : ''}`;
    headers['Content-Type'] = source.file.type || 'application/octet-stream';
    headers['X-SFTS-Import-Event'] = encodeURIComponent(JSON.stringify(event));
    if (digest) headers['X-SFTS-Import-Digest'] = digest;
    body = source.file;
  }
  const response = await fetch(url, { method: 'POST', headers, body });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(`${result.message || 'FIXTURE IMPORT FAILED'}${result.errors?.length ? ': ' + result.errors.join('; ') : ''}`);
  return result.tournament;
}

async function reviewImportFile(source) {
  if (importRequestBusy) return;
  if (!hostToken) { importWizardError('HOST SESSION REQUIRED'); return; }
  const event = importEventDetails();
  if (!event) return;
  importRequestBusy = true;
  importWizardError();
  $('tournamentImportStatus').textContent = 'READING OPENING FIXTURE…';
  try {
    const fixture = await requestFixtureImport(source, event, true);
    pendingImportReview = { source, event, fixture };
    setImportStep(2);
  } catch (error) { importWizardError(error.message); }
  finally { importRequestBusy = false; renderImportWizard(); }
}

async function startImportedCategory() {
  if (importRequestBusy || !pendingImportReview) return;
  const review = pendingImportReview;
  if (JSON.stringify(importEventDetails()) !== JSON.stringify(review.event)) {
    importWizardError('Event details changed. Go back and review the file again.');
    return;
  }
  importRequestBusy = true;
  renderImportWizard();
  try {
    lastTournament = await requestFixtureImport(review.source, review.event, false, review.fixture.sourceDigest);
    pendingImportReview = null;
    renderTournament(lastTournament);
    setImportStep(3);
  } catch (error) { importWizardError(error.message); }
  finally { importRequestBusy = false; renderImportWizard(); }
}

function loadNextImportedBout(expectedBoutNo) {
  const bout = lastTournament?.schedule.find(item => !['COMPLETED', 'BYE'].includes(item.status));
  if (!bout || bout.status !== 'SCHEDULED' || pendingImportedLoad) return;
  if (expectedBoutNo && expectedBoutNo !== bout.boutNo) { renderImportWizard(); return; }
  if (!hostToken || !ws || ws.readyState !== 1) { importWizardError('Wait for the server connection before loading the next match.'); return; }
  pendingImportedLoad = bout.boutNo;
  send({ type: 'host', action: 'loadBout', boutNo: bout.boutNo });
  renderImportWizard();
}

function returnToImportedScoreboard() {
  $('dataImportModal').classList.add('hidden');
  $('scheduleModal').classList.add('hidden');
  $('winnerSlide').classList.add('hidden');
  $('roundOverlay').classList.add('hidden');
}

function handleImportedState(match) {
  if (pendingImportedLoad && match.manualBout?.importedBoutNo === pendingImportedLoad && lastTournament?.activeBoutNo === pendingImportedLoad) {
    pendingImportedLoad = null;
    returnToImportedScoreboard();
  }
  renderImportWizard();
}

function importedRequestFailed(message) {
  if (pendingImportedLoad) pendingImportedLoad = null;
  if (!$('dataImportModal')?.classList.contains('hidden')) {
    renderImportWizard();
    importWizardError(message);
  }
}
