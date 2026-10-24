let importWizardStep = 0;
let pendingImportReview = null;
let importRequestBusy = false;
let pendingImportedLoad = null;
let selectedImportCategoryKey = '';
let importSelectionSequence = 0;
let importedCategoryDeleteTarget = null;
let importedCategoryDeleteBusy = false;
const importSelectorMarkup = new Map();

function importSelectionLocked() {
  return Boolean(importRequestBusy || importedCategoryDeleteBusy || pendingImportedLoad || lastTournament?.activeBoutNo ||
    (lastState && lastState.phase !== 'MATCH_END' && (lastState.running || lastState.roundStarted ||
      lastState.phase === 'BREAK' || lastState.phase === 'TIE_DECISION' || lastState.test?.active ||
      lastState.red?.score || lastState.blue?.score || lastState.red?.gamjeom || lastState.blue?.gamjeom ||
      lastState.roundHistory?.length || lastState.kyeShi?.running || lastState.kyeShi?.elapsedMs)));
}

function importCategoryEntries() {
  const workbook = pendingImportReview?.workbook || lastFixtureWorkbook;
  if (workbook) return workbook.categories;
  const fixture = pendingImportReview?.fixture || lastTournament;
  return fixture?.event ? [{ key: 'single', event: fixture.event, fixture, categoryId: fixture.categoryId, status: '' }] : [];
}

function renderImportCategorySelectors() {
  const entries = importCategoryEntries();
  $('importCategoryPicker').classList.toggle('hidden', !entries.length || importWizardStep < 2);
  $('importDeleteCategoryButton').classList.toggle('hidden', !entries.length || Boolean(pendingImportReview && !pendingImportReview.existing));
  $('importDeleteCategoryButton').disabled = importSelectionLocked();
  if (!entries.length) return;
  const selected = entries.find(item => item.key === selectedImportCategoryKey) || entries[0];
  selectedImportCategoryKey = selected.key;
  const fill = (id, items, value) => {
    const markup = items.map(([key, label]) => `<option value="${escapeHtml(key)}">${escapeHtml(label)}</option>`).join('');
    if (importSelectorMarkup.get(id) !== markup) {
      $(id).innerHTML = markup;
      importSelectorMarkup.set(id, markup);
    }
    if ($(id).value !== value) $(id).value = value;
    $(id).disabled = importSelectionLocked();
  };
  const divisions = [...new Map(entries.map(item => [item.event.division, item.event.divisionLabel || item.event.division]))];
  const divisionEntries = entries.filter(item => item.event.division === selected.event.division);
  const genders = [...new Set(divisionEntries.map(item => item.event.gender))].map(value => [value, value]);
  const categories = divisionEntries.filter(item => item.event.gender === selected.event.gender).map(item => [item.key,
    `${item.event.categoryGroup || item.event.weightCategory}${item.status ? ' · ' + item.status : ''}`]);
  fill('importDivision', divisions, selected.event.division);
  fill('importGender', genders, selected.event.gender);
  fill('importWeightCategory', categories, selected.key);
  $('importCategoryLabel').textContent = selected.event.categoryGroup ? 'CATEGORY GROUP' : 'WEIGHT CATEGORY';
  $('importWorkbookSummary').textContent = `${entries.length} ${entries.length === 1 ? 'category' : 'categories'} available. Select a division, gender and category to review or continue.`;
  $('importCategoryLockHint').classList.toggle('hidden', !importSelectionLocked());
}

async function changeImportCategory(level) {
  if (importSelectionLocked()) { renderImportCategorySelectors(); return; }
  const previousSelection = selectedImportCategoryKey;
  const entries = importCategoryEntries();
  const selected = level === 'category'
    ? entries.find(item => item.key === $('importWeightCategory').value)
    : entries.find(item => item.event.division === $('importDivision').value && (level === 'division' || item.event.gender === $('importGender').value));
  if (!selected) return;
  selectedImportCategoryKey = selected.key;
  if (pendingImportReview && !pendingImportReview.existing) {
    pendingImportReview.fixture = selected.fixture;
    setImportStep(2);
    return;
  }
  if (!lastFixtureWorkbook) return;
  const sequence = ++importSelectionSequence;
  const workbookId = lastFixtureWorkbook.sourceDigest;
  importRequestBusy = true;
  importWizardError();
  renderImportWizard();
  try {
    const response = await fetch(`/api/tournament/category/${encodeURIComponent(selected.key)}?workbookId=${encodeURIComponent(workbookId)}`, {
      headers: { 'X-SFTS-Host-Token': hostToken }
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.message || 'COULD NOT REVIEW CATEGORY');
    if (sequence !== importSelectionSequence || lastFixtureWorkbook?.sourceDigest !== workbookId) return;
    pendingImportReview = { existing: true, fixture: result.tournament, workbook: result.workbook };
    setImportStep(2);
  } catch (error) {
    selectedImportCategoryKey = previousSelection;
    importWizardError(error.message);
  } finally { importRequestBusy = false; renderImportWizard(); }
}

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
  selectedImportCategoryKey = lastFixtureWorkbook?.selectedKey || '';
  setImportStep(lastTournament?.schedule?.every(bout => ['COMPLETED', 'BYE'].includes(bout.status)) ? 4 : 3);
}

function prepareAnotherCategory() {
  if (importSelectionLocked()) { importWizardError('Finish or reset the current match before switching categories.'); return; }
  if (!lastFixtureWorkbook) { pendingImportReview = null; setImportStep(0); return; }
  selectedImportCategoryKey = lastFixtureWorkbook.selectedKey;
  pendingImportReview = { existing: true, fixture: lastTournament, workbook: lastFixtureWorkbook };
  setImportStep(2);
}

function openImportedCategoryDelete() {
  if (importSelectionLocked()) { importWizardError('Finish or reset the current match before deleting a category.'); return; }
  if (pendingImportReview && !pendingImportReview.existing) return;
  const selected = importCategoryEntries().find(item => item.key === selectedImportCategoryKey);
  if (!selected || !hostToken) return;
  const fixture = selected.fixture || pendingImportReview?.fixture || lastTournament;
  const category = lastManualCompetition.categories.find(item => item.id === (selected.categoryId || fixture.categoryId));
  const count = selected.completedBoutCount ?? category?.matchRecordIds?.length ?? 0;
  const confirmation = count ? `DELETE ${count} BOUT${count === 1 ? '' : 'S'}` : (selected.status === 'FINALIZED' || category?.status === 'FINALIZED') ? 'DELETE FINALIZED CATEGORY' : '';
  importedCategoryDeleteTarget = { workbookId: lastFixtureWorkbook?.sourceDigest || fixture.sourceDigest, categoryKey: selected.key, confirmation };
  $('importDeleteCategoryMessage').textContent = count
    ? `This will permanently delete this category, its bracket, all ${count} saved bout record${count === 1 ? '' : 's'} and their match-history entries. This cannot be undone.`
    : 'This will permanently remove this category and its bracket from Data Import. This cannot be undone.';
  const event = selected.event;
  $('importDeleteCategorySummary').textContent = `${event.eventName} · ${event.divisionLabel || event.division} · ${event.gender} · ${event.categoryGroup || event.weightCategory}`;
  $('importDeleteConfirmationField').classList.toggle('hidden', !confirmation);
  $('importDeleteConfirmationLabel').textContent = confirmation ? `TYPE ${confirmation} TO CONFIRM` : '';
  $('importDeleteConfirmation').value = '';
  $('importDeleteCategoryError').textContent = '';
  $('importDeleteCategoryError').classList.add('hidden');
  $('importDeleteCategoryModal').classList.remove('hidden');
  updateImportedCategoryDeleteConfirmation();
  if (confirmation) $('importDeleteConfirmation').focus?.();
}

function closeImportedCategoryDelete() {
  if (importedCategoryDeleteBusy) return;
  importedCategoryDeleteTarget = null;
  $('importDeleteCategoryModal').classList.add('hidden');
  $('importDeleteConfirmation').value = '';
}

function updateImportedCategoryDeleteConfirmation() {
  const expected = importedCategoryDeleteTarget?.confirmation || '';
  $('importConfirmDeleteCategoryButton').disabled = importedCategoryDeleteBusy || !importedCategoryDeleteTarget || Boolean(expected && $('importDeleteConfirmation').value.trim().toUpperCase() !== expected);
}

async function confirmImportedCategoryDelete() {
  const target = importedCategoryDeleteTarget;
  if (!target || importSelectionLocked()) return;
  if (target.confirmation && $('importDeleteConfirmation').value.trim().toUpperCase() !== target.confirmation) {
    updateImportedCategoryDeleteConfirmation();
    return;
  }
  importedCategoryDeleteBusy = true;
  updateImportedCategoryDeleteConfirmation();
  renderImportWizard();
  try {
    const response = await fetch('/api/tournament/category/delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SFTS-Host-Token': hostToken },
      body: JSON.stringify({ ...target, deleteRecords: Boolean(target.confirmation) })
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.message || 'COULD NOT DELETE CATEGORY');
    lastTournament = result.tournament;
    lastFixtureWorkbook = result.workbook || null;
    pendingImportReview = null;
    selectedImportCategoryKey = lastFixtureWorkbook?.selectedKey || '';
    importSelectionSequence += 1;
    importedCategoryDeleteBusy = false;
    closeImportedCategoryDelete();
    renderTournament(lastTournament);
    setImportStep(lastTournament?.event ? lastTournament.schedule.every(bout => ['COMPLETED', 'BYE'].includes(bout.status)) ? 4 : 3 : 0);
    toast(result.message || 'CATEGORY AND ITS SAVED MATCHES DELETED');
  } catch (error) {
    $('importDeleteCategoryError').textContent = error.message;
    $('importDeleteCategoryError').classList.remove('hidden');
  } finally {
    importedCategoryDeleteBusy = false;
    updateImportedCategoryDeleteConfirmation();
    renderImportWizard();
  }
}

function importPlayerCard(player, label) {
  return `<div><b>${label}</b><strong>${escapeHtml(player?.playerName || 'BYE')}</strong><span>${escapeHtml(player?.club || 'Advances without a match')}</span></div>`;
}

function renderImportWizard() {
  const modal = $('dataImportModal');
  if (!modal || modal.classList.contains('hidden')) return;
  if (importWizardStep >= 3 && !lastTournament?.event) importWizardStep = 0;
  for (let step = 0; step < 5; step += 1) {
    $(`importStep${step}`).classList.toggle('hidden', step !== importWizardStep);
    const marker = $('importWizardSteps').children[step];
    marker.classList.toggle('active', step === importWizardStep);
    marker.classList.toggle('complete', step < importWizardStep);
    if (step === importWizardStep) marker.setAttribute('aria-current', 'step');
    else marker.removeAttribute('aria-current');
  }
  $('importResumeButton').classList.toggle('hidden', !lastTournament?.event);
  renderImportCategorySelectors();
  $('importStartButton').disabled = importSelectionLocked() || !pendingImportReview;
  const reviewedComplete = pendingImportReview?.fixture.schedule.every(bout => ['COMPLETED', 'BYE'].includes(bout.status));
  const reviewedStarted = pendingImportReview?.fixture.schedule.some(bout => ['COMPLETED', 'TIE_PENDING'].includes(bout.status));
  $('importStartButton').textContent = reviewedComplete ? 'VIEW CATEGORY RESULTS' : reviewedStarted ? 'CONTINUE CATEGORY' : pendingImportReview?.existing ? 'START CATEGORY' : 'CONFIRM & START CATEGORY';
  if (pendingImportReview) {
    const fixture = pendingImportReview.fixture;
    const event = fixture.event;
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

async function requestFixtureImport(source, event, preview, digest, categoryKey) {
  const headers = { 'X-SFTS-Host-Token': hostToken };
  let url;
  let body;
  if (source.fileName) {
    url = '/api/usb/import';
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify({ fileName: source.fileName, event, preview, digest, categoryKey });
  } else {
    url = `/api/tournament/import${preview ? '?preview=true' : ''}`;
    headers['Content-Type'] = source.file.type || 'application/octet-stream';
    headers['X-SFTS-Import-Event'] = encodeURIComponent(JSON.stringify(event));
    if (digest) headers['X-SFTS-Import-Digest'] = digest;
    if (categoryKey) headers['X-SFTS-Import-Category'] = categoryKey;
    body = source.file;
  }
  const response = await fetch(url, { method: 'POST', headers, body });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(`${result.message || 'FIXTURE IMPORT FAILED'}${result.errors?.length ? ': ' + result.errors.join('; ') : ''}`);
  return result;
}

async function reviewImportFile(source) {
  if (importRequestBusy) return;
  if (!hostToken) { importWizardError('HOST SESSION REQUIRED'); return; }
  const event = importEventDetails();
  if (!event) return;
  importRequestBusy = true;
  pendingImportReview = null;
  importWizardError();
  $('tournamentImportStatus').textContent = 'READING TOURNAMENT FILE…';
  try {
    const result = await requestFixtureImport(source, event, true);
    pendingImportReview = { source, event, fixture: result.tournament, workbook: result.workbook || null };
    selectedImportCategoryKey = result.workbook?.selectedKey || 'single';
    setImportStep(2);
  } catch (error) { importWizardError(error.message); }
  finally { importRequestBusy = false; renderImportWizard(); }
}

async function startImportedCategory() {
  if (importSelectionLocked() || !pendingImportReview) return;
  const review = pendingImportReview;
  if (!review.existing && JSON.stringify(importEventDetails()) !== JSON.stringify(review.event)) {
    importWizardError('Event details changed. Go back and review the file again.');
    return;
  }
  importRequestBusy = true;
  renderImportWizard();
  try {
    let result;
    if (review.existing) {
      const response = await fetch('/api/tournament/category', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SFTS-Host-Token': hostToken },
        body: JSON.stringify({ workbookId: review.workbook.sourceDigest, categoryKey: selectedImportCategoryKey })
      });
      result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.message || 'COULD NOT SELECT CATEGORY');
    } else result = await requestFixtureImport(review.source, review.event, false, review.fixture.sourceDigest, review.workbook ? selectedImportCategoryKey : undefined);
    lastTournament = result.tournament;
    lastFixtureWorkbook = result.workbook || null;
    pendingImportReview = null;
    renderTournament(lastTournament);
    selectedImportCategoryKey = lastFixtureWorkbook?.selectedKey || 'single';
    setImportStep(lastTournament.schedule.every(bout => ['COMPLETED', 'BYE'].includes(bout.status)) ? 4 : 3);
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
  if (pendingImportReview?.existing && (pendingImportReview.workbook.sourceDigest !== lastFixtureWorkbook?.sourceDigest || !lastFixtureWorkbook?.categories.some(item => item.key === selectedImportCategoryKey))) {
    pendingImportReview = null;
    selectedImportCategoryKey = lastFixtureWorkbook?.selectedKey || '';
    importSelectionSequence += 1;
    setImportStep(lastTournament?.event ? 3 : 0);
  }
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
