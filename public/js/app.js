let role = "unknown";
let hostToken = "";
let hostAccessToken = "";
let requestedRole = null;
let requestedCorner = 0;
let ws = null;
let reconnectTimer = null;
let reconnectDelay = 500;
let lastState = null;
let lastTournament = null;
let lastManualCompetition = { version: 1, categories: [] };
let manualRecordsCache = [];
let historyCache = [];
let currentRoundRecord = null;
let audioCtx;
let announcementAudio = null;
let powerAction = "";
let powerActionScheduled = false;
let powerDeadlineAt = 0;
let powerCountdownTimer = null;
let usbImportOnly = false;
let activeRuleset = null;
let scoringRules = null;
let remoteStatusSnapshot = null;
let remoteDisconnectPopupTimer = null;
let currentArenaNumber = "";
let lastRemoteButtons = [];
let remoteScoreHighlights = { RED: [], BLUE: [] };
let remoteScoreValues = { RED: null, BLUE: null };
let remoteScoreRevisions = { RED: 0, BLUE: 0 };
let displayedRemoteScoreHighlights = { RED: [], BLUE: [] };
let displayedRemoteScoreValues = { RED: null, BLUE: null };
let remoteScoreTransitionTimers = { RED: null, BLUE: null };
let displayedRemoteScoreRevisions = { RED: -1, BLUE: -1 };
let recoveryNoticeShown = false;
let displayedTieDecisionMode = null;
let tieDecisionView = "METHOD";
let manualDecisionCode = "";
let practiceLoadPending = false;
let manualWizardStep = 0;
let manualBoutSavePending = null;
let manualDeletePendingCategoryId = "";
let manualNextBoutPending = false;
let userPermissionResolver = null;
let userPermissionInputMode = false;
let cornerEditPlayer = "";
let launchBrandingTimers = [];
const REMOTE_SCORE_TRANSITION_MS = 300;
const LAUNCH_TITLE_SEQUENCE_MS = 6200;
const LAUNCH_LOGO_SEQUENCE_MS = 6000;

const $ = (id) => document.getElementById(id);

function connectSocket() {
  ws = new WebSocket(
    (location.protocol === "https:" ? "wss://" : "ws://") + location.host,
  );
  ws.onopen = () => {
    reconnectDelay = 500;
    if (requestedRole) {
      send({
        type: "role",
        role: requestedRole,
        corner: requestedCorner,
        accessToken: hostAccessToken,
      });
    }
  };
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "roleAccepted") {
      role = msg.role || role;
      if (msg.role === "host") hostToken = msg.hostToken || "";
    }
    if (msg.type === "state") {
      if (msg.recoveredFromUnexpectedShutdown === true && !recoveryNoticeShown) {
        recoveryNoticeShown = true;
        toast("RECOVERED AFTER UNEXPECTED SHUTDOWN - VERIFY MATCH STATE");
      }
      lastState = msg.match;
      lastRemoteButtons = Array.isArray(msg.remoteButtons)
        ? msg.remoteButtons
        : [];
      remoteScoreHighlights = msg.remoteScoreHighlights || { RED: [], BLUE: [] };
      remoteScoreValues = msg.remoteScoreValues || { RED: null, BLUE: null };
      // Preserve the raw awarded values as remoteScoreValues[player] for compatibility.
      remoteScoreRevisions = msg.remoteScoreRevisions || { RED: 0, BLUE: 0 };
      currentArenaNumber = String(msg.arenaNumber || "");
      lastTournament = msg.tournament || null;
      lastManualCompetition = msg.manualCompetition || { version: 1, categories: [] };
      historyCache = msg.matchHistory || [];
      usbImportOnly = msg.usbImportOnly === true;
      activeRuleset = msg.ruleset || msg.match?.ruleset || activeRuleset;
      scoringRules = msg.scoringRules || scoringRules;
      renderUsbImportMode();
      renderState(msg.match);
      if (practiceLoadPending && msg.match?.mode === "PRACTICE") {
        practiceLoadPending = false;
        $("practiceModeModal")?.classList.add("hidden");
      }
      if (!$('cornerRefereeHistoryModal')?.classList.contains('hidden'))
        renderCornerRefereeHistory();
      renderActiveRuleset(activeRuleset);
      renderScoringControls();
      renderRemoteStatuses(msg.remotes, msg.match?.remoteCount);
      renderTournament(msg.tournament);
      renderManualCategoryOptions();
      handleManualEntryState(msg.match);
      if (!$('manualCategoryResultsModal')?.classList.contains('hidden')) renderManualCategoryReport();
      if (!$("scheduleModal").classList.contains("hidden"))
        renderSchedule(msg.tournament);
    }
    if (msg.type === "error") {
      if (["MATCH_IN_PROGRESS", "INVALID_PRACTICE_PLAYER"].includes(msg.code)) practiceLoadPending = false;
      if (manualBoutSavePending) {
        manualBoutSavePending = null;
        if (["INVALID_MANUAL_CATEGORY", "MANUAL_CATEGORY_NOT_FOUND", "MANUAL_CATEGORY_FINALIZED"].includes(msg.code)) manualWizardStep = 0;
        if (["INVALID_MANUAL_BOUT", "DUPLICATE_OFFICIAL_BOUT"].includes(msg.code)) manualWizardStep = 1;
        if (msg.code === "INVALID_MANUAL_PLAYER") manualWizardStep = 2;
        showManualEntryError(msg.message || "COULD NOT LOAD THE MANUAL BOUT");
        renderManualWizard();
      }
      if (manualDeletePendingCategoryId) {
        manualDeletePendingCategoryId = "";
        showManualDeleteError(msg.message || "COULD NOT DELETE THE CATEGORY");
        updateManualCategoryDeleteConfirmation();
      }
      if (manualNextBoutPending) {
        manualNextBoutPending = false;
        showManualEntryError(msg.message || "COULD NOT PREPARE THE NEXT BOUT");
        renderManualWizard();
      }
      if (msg.code === "HOST_UNAUTHORIZED") {
        requestedRole = null;
        role = "unknown";
        showScreen("home");
      }
      if (
        [
          "INVALID_POWER_ACTION",
          "SYSTEM_POWER_PENDING",
          "NO_SYSTEM_POWER_PENDING",
        ].includes(msg.code)
      ) {
        powerActionScheduled = false;
        $("powerConfirmButton")?.classList.remove("hidden");
        $("powerConfirmButton").disabled = false;
        $("powerCancelButton").disabled = false;
        $("powerCountdownStatus").textContent =
          msg.message || "SYSTEM POWER ACTION FAILED";
      }
      toast(msg.message || "REQUEST FAILED");
    }
    if (msg.type === "award") {
      toast(`MAJORITY ${msg.player} +${msg.points} (${msg.count}/4)`);
    }
    if (msg.type === "scoreSound") playPointSound(msg.points);
    if (msg.type === "roundEndSound") playWhistle();
    if (msg.type === "roundEnd") showRoundSummary(msg.record);
    if (msg.type === "kyeShiLimit") {
      toast("KYE-SHI 1:00 LIMIT REACHED");
      beep(520, 0.35, "square", 0.18);
    }
    if (msg.type === "matchEnd") {
      if (msg.winner) showWinnerSlide(msg.winner, msg.match);
      else toast("MATCH TIED — RESOLVE IT IN THE SCHEDULE");
    }
    if (msg.type === "matchEnd" && msg.match?.manualBout?.categoryId)
      void refreshManualRecords(msg.match.manualBout.categoryId);
    if (msg.type === "testPress")
      markTest(msg.corner, msg.player, msg.points, msg.button);
    if (msg.type === "testReset") resetTestUi();
    if (msg.type === "announcement") announceText(msg.text, msg.audioUrl);
    if (msg.type === "systemPowerScheduled") beginPowerCountdown(msg);
    if (msg.type === "systemPowerExecuting") {
      $("powerCountdownStatus").textContent =
        `${powerActionLabel(msg.action)} STARTING...`;
    }
    if (msg.type === "systemPowerCancelled") {
      toast(`${powerActionLabel(msg.action || powerAction)} CANCELLED`);
      closePowerModal();
    }
    if (msg.type === "systemPowerFailed") {
      toast(msg.message || "SYSTEM POWER ACTION FAILED");
      closePowerModal();
    }
  };
  ws.onclose = () => {
    remoteStatusSnapshot = null;
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      reconnectDelay = Math.min(reconnectDelay * 2, 5000);
      connectSocket();
    }, reconnectDelay);
  };
  ws.onerror = () => {};
}
connectSocket();

function toggleScreensaver() {
  const screenSaver = $("screensaver");
  if (!screenSaver) return;
  const visible = !screenSaver.classList.contains("visible");
  screenSaver.classList.toggle("visible", visible);
  screenSaver.setAttribute("aria-hidden", String(!visible));
}

document.addEventListener("keydown", (event) => {
  if (!$("userPermissionModal")?.classList.contains("hidden")) return;
  if (
    !["Space", "KeyR", "KeyB", "KeyS"].includes(event.code) ||
    event.repeat ||
    role !== "host"
  ) return;
  const target = event.target;
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target.isContentEditable
  ) return;
  event.preventDefault();
  if (event.code === "Space") playPause();
  if (event.code === "KeyR") manualGam("RED");
  if (event.code === "KeyB") manualGam("BLUE");
  if (event.code === "KeyS") {
    if (lastState?.phase === "ROUND" && lastState.running === true) {
      toast("SCREENSAVER UNAVAILABLE DURING THE ACTIVE ROUND");
      return;
    }
    toggleScreensaver();
  }
});

document.addEventListener("keydown", (event) => {
  if ($("userPermissionModal")?.classList.contains("hidden")) return;
  if (event.key === "Escape") {
    event.preventDefault();
    resolveUserPermission(false);
  } else if (event.key === "Enter" && event.target !== $("userPermissionConfirmButton")) {
    event.preventDefault();
    resolveUserPermission(true);
  }
});

function send(data) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(data));
  else toast("NOT CONNECTED");
}

function toast(text) {
  const node = $("toast");
  node.textContent = text;
  node.classList.add("show");
  setTimeout(() => node.classList.remove("show"), 2200);
}

function requestUserPermission(message) {
  return new Promise((resolve) => {
    if (userPermissionResolver) userPermissionResolver(false);
    userPermissionResolver = resolve;
    userPermissionInputMode = false;
    $("userPermissionMessage").textContent = message;
    $("userPermissionInputLabel").classList.add("hidden");
    $("userPermissionConfirmButton").textContent = "CONFIRM";
    $("userPermissionModal").classList.remove("hidden");
    $("userPermissionConfirmButton").focus();
  });
}

function requestUserInput(message, current) {
  return new Promise((resolve) => {
    if (userPermissionResolver) userPermissionResolver(null);
    userPermissionResolver = resolve;
    userPermissionInputMode = true;
    $("userPermissionMessage").textContent = message;
    $("userPermissionInputLabel").classList.remove("hidden");
    $("userPermissionInput").value = current;
    $("userPermissionConfirmButton").textContent = "SAVE";
    $("userPermissionModal").classList.remove("hidden");
    $("userPermissionInput").focus();
    $("userPermissionInput").select();
  });
}

function resolveUserPermission(value) {
  const resolver = userPermissionResolver;
  const inputMode = userPermissionInputMode;
  userPermissionResolver = null;
  userPermissionInputMode = false;
  $("userPermissionModal").classList.add("hidden");
  if (resolver) {
    resolver(inputMode && value === true ? $("userPermissionInput").value : inputMode ? null : value);
  }
}

function showScreen(id) {
  document
    .querySelectorAll(".screen")
    .forEach((el) => el.classList.add("hidden"));
  $(id).classList.remove("hidden");
}

function renderState(match) {
  if (!match) return;
  $("host")?.classList.toggle(
    "matchClockRunning",
    match.phase === "ROUND" && match.running === true,
  );
  renderRemoteMode(match.remoteCount);
  renderCornerRefereeIndicators(match.remoteCount);
  const practiceMode = match.mode === "PRACTICE";
  $("practiceModeBadge")?.classList.toggle("hidden", !practiceMode);
  $("redName").textContent = "HONG";
  $("blueName").textContent = "CHUNG";
  $("redMeta").textContent = playerMetaText(match.red, practiceMode);
  $("blueMeta").textContent = playerMetaText(match.blue, practiceMode);
  $("redScore").textContent = match.red.score;
  $("blueScore").textContent = match.blue.score;
  $("redGam").textContent = match.red.gamjeom;
  $("blueGam").textContent = match.blue.gamjeom;
  $("matchNo").textContent = String(practiceMode ? match.practiceMatchNo || 1 : match.matchNo).padStart(3, "0");
  $("arenaNo").textContent = currentArenaNumber || "—";
  $("timer").textContent = formatTime(match.timerMs, match.phase === "ROUND");
  $("timer").classList.toggle(
    "timerWarning",
    match.phase === "ROUND" && match.timerMs > 0 && match.timerMs <= 10000,
  );
  $("roundText").textContent =
    match.phase === "MATCH_END"
      ? "MATCH END"
      : match.phase === "TIE_DECISION"
        ? "TIE DECISION"
        : match.phase === "BREAK" && match.breakTarget === "GOLDEN"
          ? "GOLDEN ROUND BREAK"
          : match.goldenRound?.active
            ? "GOLDEN ROUND"
            : `ROUND ${match.round}`;
  $("playBtn").textContent = match.running ? "❚❚ PAUSE" : "▶ PLAY";
  renderKyeShi(match.kyeShi, match);
  renderKyeShiWinnerButtons(match);
  renderTieDecision(match);
  if (match.phase === "MATCH_END") closeMatchDecision();
  const activeRemoteCount = Math.min(
    4,
    Math.max(1, Number(match.remoteCount) || 4),
  );
  $("voteStrip").textContent = [1, 2, 3, 4]
    .slice(0, activeRemoteCount)
    .map((c) => {
      const v = match.votes[c];
      return `C${c} ${lastRemoteButtons[c - 1] || v?.button || "—"}`;
    })
    .join("   ");

  if (match.phase === "BREAK") {
    $("breakTimeText").textContent =
      `BREAK ${formatTime(match.timerMs, false)}`;
  }

  const roundSummaryScoreboardButton = $("roundSummaryScoreboardButton");
  roundSummaryScoreboardButton?.classList.toggle("hidden", match.phase === "BREAK");
  if (match.phase === "ROUND" && !match.roundStarted) {
    $("roundOverlay")?.classList.add("hidden");
  }

  if (match.phase !== "MATCH_END") {
    $("winnerSlide").classList.add("hidden");
  }
}

function renderScoringControls() {
  if (!scoringRules?.basePointValues?.length) return;
  const controls = [
    ["redPunchButton", 1],
    ["redChestButton", 2],
    ["redHeadButton", 3],
    ["bluePunchButton", 1],
    ["blueChestButton", 2],
    ["blueHeadButton", 3],
  ];
  for (const [id, point] of controls) {
    const button = $(id);
    if (!button) continue;
    const enabled = scoringRules.basePointValues.includes(point);
    const label = scoringRules.basePointLabels?.[String(point)] || "POINTS";
    button.dataset.scorePoint = String(point);
    button.disabled = !enabled;
    const value = button.querySelector("b");
    const text = button.querySelector("span");
    if (value) value.textContent = `+${point}`;
    if (text) text.textContent = label;
  }
}

function playerMetaText(player, practiceMode = false) {
  if (practiceMode) {
    const name = String(player.playerName || "").trim() || "PLAYER NAME";
    const stateCode = String(player.stateCode || "").trim();
    const district = String(player.district || "").trim();
    return [name, stateCode, district].filter(Boolean).join(" · ");
  }
  const name = String(player.playerName || "").trim() || "PLAYER NAME —";
  const division = String(player.division || "").trim();
  const category = String(player.categoryGroup || player.weightCategory || "").trim() || "CATEGORY —";
  const stateCode = String(player.stateCode || "").trim() || "STATE —";
  const district = String(player.district || "").trim() || "DISTRICT —";
  return [name, division, category, stateCode, district].filter(Boolean).join(" · ");
}

function formatTime(ms, showTenths = true) {
  const remainingMs = Math.max(0, Number(ms) || 0);
  if (showTenths && remainingMs <= 10000)
    return `${(Math.ceil(remainingMs / 100) / 10).toFixed(1)}`;
  const s = Math.ceil(remainingMs / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function formatKyeShiTime(ms) {
  const elapsedSeconds = Math.floor(Math.max(0, Number(ms) || 0) / 1000);
  return `${Math.floor(elapsedSeconds / 60)}:${String(elapsedSeconds % 60).padStart(2, "0")}`;
}

function renderKyeShi(kyeShi, match) {
  const active = Boolean(kyeShi?.active);
  const panel = $("kyeShiPanel");
  const startButton = $("kyeShiStartBtn");
  if (!panel || !startButton) return;
  const canStart =
    !active &&
    match?.phase === "ROUND" &&
    Boolean(match.roundStarted || match.running);
  panel.classList.toggle("hidden", !active);
  startButton.classList.toggle("hidden", active);
  startButton.disabled = !canStart;
  if (!active) return;

  const limitReached = Boolean(kyeShi.limitReached);
  const running = Boolean(kyeShi.running);
  panel.classList.toggle("limitReached", limitReached);
  panel.classList.toggle("paused", !running && !limitReached);
  $("kyeShiStatus").textContent = limitReached
    ? "1:00 LIMIT"
    : running
      ? "RUNNING"
      : "SUSPENDED";
  $("kyeShiTimer").textContent = formatKyeShiTime(kyeShi.elapsedMs);
  $("kyeShiNotice").textContent = limitReached
    ? "MEDICAL TIME LIMIT REACHED — REFEREE DECISION REQUIRED"
    : kyeShi.elapsedMs >= 40000
      ? "ANNOUNCE ELAPSED TIME EVERY 5 SECONDS"
      : "MATCH CLOCK PAUSED";
  $("kyeShiToggleBtn").disabled = limitReached;
  $("kyeShiToggleBtn").textContent = running
    ? "SUSPEND KYE-SHI"
    : limitReached
      ? "LIMIT REACHED"
      : "RESUME KYE-SHI";
  $("kyeShiEndBtn").textContent = kyeShi.resumeMatch
    ? "END & RESUME MATCH"
    : "END KYE-SHI";
}

function renderKyeShiWinnerButtons(match) {
  const decisionAvailable =
    match?.phase === "ROUND" &&
    match.kyeShi?.active &&
    match.kyeShi.limitReached;
  $("redDeclareWinnerButton")?.classList.toggle("hidden", !decisionAvailable);
  $("blueDeclareWinnerButton")?.classList.toggle("hidden", !decisionAvailable);
}

function parseTime(value) {
  const text = String(value).trim();
  const parts = text.split(":");
  if (parts.length === 1) return Math.max(1000, Number(parts[0] || 0) * 1000);
  return Math.max(
    1000,
    (Number(parts[0] || 0) * 60 + Number(parts[1] || 0)) * 1000,
  );
}

function openHost() {
  role = "host";
  requestedRole = "host";
  requestedCorner = 0;
  hostAccessToken = $("hostAccessToken")?.value.trim() || "";
  send({ type: "role", role: "host", accessToken: hostAccessToken });
  showScreen("host");
  requestAnimationFrame(playLaunchBranding);
}

function playLaunchBranding() {
  const host = $("host");
  const title = $("launchBrandTitle");
  const heading = document.querySelector(".systemHeading");
  const arena = document.querySelector(".arenaText");
  if (!host || !title || !heading || !arena) return;

  for (const timer of launchBrandingTimers) clearTimeout(timer);
  launchBrandingTimers = [];
  host.classList.remove("launchBrandingActive", "launchLogoReveal");

  const headingRect = heading.getBoundingClientRect();
  const arenaRect = arena.getBoundingClientRect();
  const headingCenter = headingRect.top + headingRect.height / 2;
  const arenaCenter = arenaRect.top + arenaRect.height / 2;
  title.style.setProperty("--launch-title-top", `${headingCenter}px`);
  title.style.setProperty("--launch-title-start-offset", `${arenaCenter - headingCenter}px`);

  void title.offsetWidth;
  host.classList.add("launchBrandingActive");
  launchBrandingTimers.push(setTimeout(() => {
    host.classList.add("launchLogoReveal");
  }, LAUNCH_TITLE_SEQUENCE_MS));
  launchBrandingTimers.push(setTimeout(() => {
    host.classList.remove("launchBrandingActive", "launchLogoReveal");
    launchBrandingTimers = [];
  }, LAUNCH_TITLE_SEQUENCE_MS + LAUNCH_LOGO_SEQUENCE_MS));
}

function nameChange(player, value) {
  send({ type: "host", action: "name", player, name: value });
}
function playPause() {
  send({ type: "host", action: "playPause" });
}
function resetRoundTimer() {
  send({ type: "host", action: "resetRoundTimer" });
}
function startKyeShi() {
  send({ type: "host", action: "startKyeShi" });
}
async function toggleKyeShi() {
  if (!lastState?.kyeShi) return;
  if (lastState.kyeShi.running) {
    if (await requestUserPermission("Suspend the Kye-shi timer?"))
      send({ type: "host", action: "pauseKyeShi" });
  } else {
    send({ type: "host", action: "resumeKyeShi" });
  }
}
async function endKyeShi() {
  if (await requestUserPermission("End Kye-shi and resume the match timer?"))
    send({ type: "host", action: "endKyeShi" });
}
async function declareWinner(player) {
  const name = player === "RED" ? "HONG" : "CHUNG";
  if (await requestUserPermission(`Declare ${name} the winner of the entire match?`)) {
    send({ type: "host", action: "declareKyeShiWinner", player });
  }
}
function startGoldenRound() {
  send({ type: "host", action: "startGoldenRound" });
}
function showWooSeGirokChoices() {
  tieDecisionView = "WOO";
  renderTieDecision(lastState);
}
function showTieMethods() {
  tieDecisionView = "METHOD";
  renderTieDecision(lastState);
}
function backFromTieDecision() {
  $("tieDecisionModal")?.classList.add("hidden");
  openSettings();
}
async function decideTieWinner(player) {
  if (!lastState) return;
  const roundOnly = lastState.tieDecision?.mode === "ROUND_WOO_SE_GIROK";
  const action = lastState.tieDecision?.mode === "GOLDEN_SUPERIORITY"
    ? "decideGoldenRoundSuperiority"
    : "decideWooSeGirok";
  const name = displayPlayerName(lastState, player);
  if (await requestUserPermission(`Declare ${name} the ${roundOnly ? `Round ${lastState.round} ` : "match "}winner?`)) {
    send({ type: "host", action, player });
  }
}
function manualPoint(player, points) {
  send({ type: "host", action: "point", player, points });
}

function displayPlayerName(match, player) {
  const side = player === "RED" ? match.red : match.blue;
  return side?.playerName || side?.name || player;
}

function renderTieDecision(match) {
  const modal = $("tieDecisionModal");
  if (!modal) return;
  if (match?.phase !== "TIE_DECISION") {
    modal.classList.add("hidden");
    displayedTieDecisionMode = null;
    tieDecisionView = "METHOD";
    return;
  }

  const mode = match.tieDecision?.mode || "CHOOSE_METHOD";
  if (mode !== displayedTieDecisionMode) {
    displayedTieDecisionMode = mode;
    tieDecisionView = "METHOD";
  }
  const redName = displayPlayerName(match, "RED");
  const blueName = displayPlayerName(match, "BLUE");
  const tieOptions = Array.isArray(match.tieDecision?.options)
    ? match.tieDecision.options
    : scoringRules?.tieBreak?.afterRegulation?.options || [];
  const goldenAvailable = tieOptions.includes("GOLDEN_ROUND");
  const wooAvailable = tieOptions.includes("WOO_SE_GIROK");
  $("goldenRoundChoice")?.classList.toggle("hidden", !goldenAvailable);
  $("wooSeGirokChoice")?.classList.toggle("hidden", !wooAvailable);
  $("tieDecisionRedButton").textContent = `DECLARE "${redName}" WINNER`;
  $("tieDecisionBlueButton").textContent = `DECLARE "${blueName}" WINNER`;

  const choosingGoldenSuperiority = mode === "GOLDEN_SUPERIORITY";
  const choosingRoundWoo = mode === "ROUND_WOO_SE_GIROK";
  const choosingMatchWoo = mode === "MATCH_WOO_SE_GIROK";
  const directWooDecision = choosingRoundWoo || choosingMatchWoo;
  const showingWinners = choosingGoldenSuperiority || directWooDecision || tieDecisionView === "WOO";
  $("tieDecisionMethodActions").classList.toggle("hidden", showingWinners);
  $("tieDecisionWinnerActions").classList.toggle("hidden", !showingWinners);
  $("tieDecisionBackButton").classList.toggle("hidden", choosingGoldenSuperiority || directWooDecision);
  const finalRound = scoringRules?.match?.rounds || 3;
  $("tieDecisionTitle").textContent = choosingGoldenSuperiority
    ? "GOLDEN ROUND SUPERIORITY"
    : choosingRoundWoo
      ? `ROUND ${match.tieDecision?.round || match.round} WOO-SE-GIROK`
      : choosingMatchWoo
        ? `ROUND ${finalRound} TIED — WOO-SE-GIROK`
    : tieDecisionView === "WOO"
      ? "WOO-SE-GIROK"
      : `ROUND ${finalRound} TIED`;
  $("tieDecisionMessage").textContent = choosingGoldenSuperiority
    ? "REFEREE DECISION REQUIRED"
    : choosingRoundWoo
      ? "SELECT THE ROUND WINNER"
      : choosingMatchWoo
        ? "SELECT THE MATCH WINNER"
    : tieDecisionView === "WOO"
      ? "SELECT THE MATCH WINNER"
      : goldenAvailable && wooAvailable
        ? "SELECT GOLDEN ROUND OR WOO-SE-GIROK"
        : goldenAvailable
          ? "GOLDEN ROUND REQUIRED"
          : wooAvailable
            ? "WOO-SE-GIROK REQUIRED"
            : "MANUAL TOURNAMENT RESOLUTION REQUIRED";
  modal.classList.remove("hidden");
}
function manualConfiguredPoint(player, buttonId, event) {
  const button = $(buttonId);
  const points = Number(button?.dataset.scorePoint);
  if (!Number.isInteger(points) || !scoringRules?.basePointValues?.includes(points)) {
    toast("SCORING OPTION NOT AVAILABLE IN ACTIVE RULES");
    return;
  }
  if (event?.ctrlKey && (points === 2 || points === 3)) {
    send({ type: "host", action: "technicalPoint", player, basePoints: points });
    return;
  }
  manualPoint(player, points);
}
function manualHeadPoint(player) {
  send({ type: "host", action: "headPoint", player });
}
function manualGam(player) {
  send({ type: "host", action: "gamjeom", player });
}

function cornerName(player) {
  return player === "RED" ? "HONG" : "CHUNG";
}

function correctionEditError() {
  if (!lastState || lastState.phase !== "ROUND" || !lastState.roundStarted || lastState.timerMs <= 0) {
    return "CORRECTIONS ARE AVAILABLE AFTER THE ROUND STARTS AND BEFORE THE TIMER EXPIRES";
  }
  if (lastState.test?.active) return "CORRECTIONS ARE NOT AVAILABLE IN REMOTE TEST MODE";
  if (lastState.kyeShi?.active) return "CORRECTIONS ARE NOT AVAILABLE DURING KYE-SHI";
  return "";
}

function openCornerEditor(player) {
  if (!lastState || !["RED", "BLUE"].includes(player)) return;
  const error = correctionEditError();
  if (error) {
    toast(error);
    return;
  }
  cornerEditPlayer = player;
  $("cornerEditTitle").textContent = `CORRECT ${cornerName(player)}`;
  $("cornerCorrectionHint").textContent = "Every correction is recorded in the match operator history.";
  showCornerCorrectionMenu();
  $("cornerEditModal").classList.remove("hidden");
}

function closeCornerEditor() {
  $("cornerEditModal").classList.add("hidden");
  cornerEditPlayer = "";
}

function showCornerCorrectionMenu() {
  if (!cornerEditPlayer) return;
  $("cornerEditTitle").textContent = `CORRECT ${cornerName(cornerEditPlayer)}`;
  $("cornerCorrectionSummary").textContent = "Choose what needs to be corrected.";
  $("cornerCorrectionMenu").classList.remove("hidden");
  $("scoringCorrectionPanel").classList.add("hidden");
}

function scoringCorrectionDefinitions() {
  const baseLabels = scoringRules?.basePointLabels || {};
  const basePointValues = Array.isArray(scoringRules?.basePointValues)
    ? scoringRules.basePointValues
    : [];
  const technicalInput = scoringRules?.technicalInput || {};
  const technicalPoints = technicalInput.pointsByBasePoints || {};
  const eligibleTechnicalPoints = Array.isArray(technicalInput.eligibleBasePoints)
    ? technicalInput.eligibleBasePoints
    : [];
  const normal = basePointValues.map(basePoints => ({
    key: `NORMAL_${basePoints}`,
    label: String(baseLabels[String(basePoints)] || `${basePoints} POINT`).toUpperCase(),
    points: basePoints,
    statKey: `plus${basePoints}`,
    technical: false
  }));
  const technical = technicalInput.enabled
    ? eligibleTechnicalPoints
      .filter(basePoints => [2, 3].includes(basePoints))
      .map(basePoints => ({
        key: `TECHNICAL_${basePoints}`,
        label: `TECHNICAL ${String(baseLabels[String(basePoints)] || `${basePoints} POINT`).toUpperCase()}`,
        points: Number(technicalPoints[String(basePoints)]),
        statKey: basePoints === 2 ? "technicalChest" : "technicalHead",
        technical: true
      }))
      .filter(action => Number.isSafeInteger(action.points) && action.points > 0)
    : [];
  return [...normal, ...technical];
}

function openScoringCorrection(direction) {
  const player = cornerEditPlayer;
  const error = correctionEditError();
  if (error) {
    toast(error);
    return;
  }
  if (!["RED", "BLUE"].includes(player) || !["ADD", "REMOVE"].includes(direction)) return;
  const side = player === "RED" ? lastState.red : lastState.blue;
  const actions = $("scoringCorrectionActions");
  actions.replaceChildren();
  for (const definition of scoringCorrectionDefinitions()) {
    const button = document.createElement("button");
    const sign = direction === "ADD" ? "+" : "−";
    button.textContent = `${definition.label} (${sign}${definition.points})`;
    const count = Number(side.stats?.[definition.statKey] || 0);
    button.disabled = direction === "REMOVE" && (count <= 0 || side.score < definition.points);
    if (button.disabled) button.title = "No matching recorded scoring action can be removed";
    button.addEventListener("click", () => void confirmScoringCorrection(direction, definition.key));
    actions.appendChild(button);
  }
  $("cornerEditTitle").textContent = `${direction === "ADD" ? "ADD MISSED" : "REMOVE WRONG"} ${cornerName(player)} ACTION`;
  $("cornerCorrectionSummary").textContent = "Select the scoring action. Its points and recorded statistic will change together.";
  $("cornerCorrectionMenu").classList.add("hidden");
  $("scoringCorrectionPanel").classList.remove("hidden");
}

async function confirmScoringCorrection(direction, actionKey) {
  const player = cornerEditPlayer;
  const definition = scoringCorrectionDefinitions().find(action => action.key === actionKey);
  if (!definition || !["RED", "BLUE"].includes(player)) return;
  const side = player === "RED" ? lastState.red : lastState.blue;
  const multiplier = direction === "ADD" ? 1 : -1;
  const fromCount = Number(side.stats?.[definition.statKey] || 0);
  const confirmed = await requestUserPermission(
    `${direction === "ADD" ? "Add missed" : "Remove wrong"} ${cornerName(player)} ${definition.label}? ` +
    `Score ${side.score} to ${side.score + (multiplier * definition.points)}; ` +
    `recorded count ${fromCount} to ${fromCount + multiplier}.`
  );
  if (!confirmed) return;
  send({ type: "host", action: "correctScoringAction", player, direction, actionKey });
  closeCornerEditor();
}

async function correctSelectedGamjeom(direction) {
  const player = cornerEditPlayer;
  const error = correctionEditError();
  if (error) {
    toast(error);
    return;
  }
  if (!["RED", "BLUE"].includes(player) || !["ADD", "REMOVE"].includes(direction)) return;
  const penalized = player === "RED" ? lastState.red : lastState.blue;
  if (direction === "REMOVE" && Number(penalized.gamjeom || 0) <= 0) {
    toast(`NO RECORDED ${cornerName(player)} GAM-JEOM CAN BE REMOVED`);
    return;
  }
  const opponentPlayer = player === "RED" ? "BLUE" : "RED";
  const opponent = opponentPlayer === "RED" ? lastState.red : lastState.blue;
  const pointValue = scoringRules?.gamJeom?.awardsPointToOpponent
    ? Number(scoringRules?.gamJeomPointValue || 0)
    : 0;
  if (direction === "REMOVE" && pointValue > opponent.score) {
    toast("THE OPPONENT SCORE IS TOO LOW TO REMOVE THIS GAM-JEOM");
    return;
  }
  const multiplier = direction === "ADD" ? 1 : -1;
  const scoreEffect = pointValue
    ? ` ${cornerName(opponentPlayer)} score ${opponent.score} to ${opponent.score + (multiplier * pointValue)}.`
    : " The active rule pack does not award an opponent point.";
  const confirmed = await requestUserPermission(
    `${direction === "ADD" ? "Add missed" : "Remove wrong"} ${cornerName(player)} Gam-jeom? ` +
    `Count ${penalized.gamjeom} to ${penalized.gamjeom + multiplier}.${scoreEffect}`
  );
  if (!confirmed) return;
  send({ type: "host", action: "correctGamjeom", player, direction });
  closeCornerEditor();
}

function renderAdvancedCorrectionCurrent() {
  if (!lastState) return;
  const player = $("advancedCorrectionPlayer").value === "BLUE" ? "BLUE" : "RED";
  const side = player === "RED" ? lastState.red : lastState.blue;
  $("advancedCorrectionCurrent").textContent = `${cornerName(player)} CURRENT SCORE: ${side.score}`;
  $("advancedCorrectionScore").value = side.score;
}

function openAdvancedCorrections() {
  const error = correctionEditError();
  if (error) {
    toast(error);
    return;
  }
  closeSettings();
  $("advancedCorrectionPlayer").value = "RED";
  $("advancedCorrectionReason").value = "";
  renderAdvancedCorrectionCurrent();
  $("advancedCorrectionsModal").classList.remove("hidden");
}

function closeAdvancedCorrections() {
  $("advancedCorrectionsModal").classList.add("hidden");
}

async function saveAdvancedScoreCorrection() {
  const error = correctionEditError();
  if (error) {
    toast(error);
    return;
  }
  const player = $("advancedCorrectionPlayer").value === "BLUE" ? "BLUE" : "RED";
  const side = player === "RED" ? lastState.red : lastState.blue;
  const value = Number($("advancedCorrectionScore").value);
  const reason = $("advancedCorrectionReason").value.trim();
  if (!Number.isSafeInteger(value) || value < 0) {
    toast("THE NEW SCORE MUST BE A NON-NEGATIVE WHOLE NUMBER");
    $("advancedCorrectionScore").focus();
    return;
  }
  if (value === side.score) {
    toast("THE NEW SCORE MUST BE DIFFERENT FROM THE CURRENT SCORE");
    $("advancedCorrectionScore").focus();
    return;
  }
  if (!reason) {
    toast("A WRITTEN REASON IS REQUIRED");
    $("advancedCorrectionReason").focus();
    return;
  }
  const confirmed = await requestUserPermission(
    `Set ${cornerName(player)} score from ${side.score} to ${value}? ` +
    `Scoring-action counts and Gam-jeom totals will not change. Reason: ${reason}`
  );
  if (!confirmed) return;
  send({ type: "host", action: "advancedScoreCorrection", player, value, reason });
  closeAdvancedCorrections();
}

function openSettings() {
  $("settingsModal").classList.remove("hidden");
}
function closeSettings() {
  $("settingsModal").classList.add("hidden");
}
function openMatchDecision() {
  if (!lastState || lastState.phase === "MATCH_END") {
    toast("MATCH DECISION IS NOT AVAILABLE");
    return;
  }
  closeSettings();
  manualDecisionCode = "";
  const availableDecisions = scoringRules?.manualMatchDecisions || [];
  document.querySelectorAll("[data-manual-decision]").forEach((button) => {
    button.classList.toggle("hidden", !availableDecisions.includes(button.dataset.manualDecision));
  });
  if (!availableDecisions.length) {
    toast("MATCH DECISIONS ARE DISABLED BY ACTIVE RULES");
    return;
  }
  $("manualDecisionMessage").textContent = "SELECT THE REFEREE DECISION";
  $("manualDecisionOptions").classList.remove("hidden");
  $("manualDecisionWinnerActions").classList.add("hidden");
  $("manualDecisionCloseButton").classList.remove("hidden");
  $("matchDecisionModal").classList.remove("hidden");
}
function closeMatchDecision() {
  manualDecisionCode = "";
  $("matchDecisionModal").classList.add("hidden");
}
function selectManualDecision(code) {
  if (!lastState || !(scoringRules?.manualMatchDecisions || []).includes(code)) return;
  manualDecisionCode = code;
  $("manualDecisionMessage").textContent = `${code} - SELECT THE WINNER`;
  $("manualDecisionRedButton").textContent = `${displayPlayerName(lastState, "RED")} WIN`;
  $("manualDecisionBlueButton").textContent = `${displayPlayerName(lastState, "BLUE")} WIN`;
  $("manualDecisionOptions").classList.add("hidden");
  $("manualDecisionWinnerActions").classList.remove("hidden");
  $("manualDecisionCloseButton").classList.add("hidden");
}
async function submitManualDecision(player) {
  if (!manualDecisionCode || !lastState) return;
  const name = displayPlayerName(lastState, player);
  if (!await requestUserPermission(`Declare ${name} the winner by ${manualDecisionCode}?`)) return;
  send({ type: "host", action: "manualMatchDecision", player, decision: manualDecisionCode });
  closeMatchDecision();
}
function openArenaNumber() {
  closeSettings();
  $("arenaNumberInput").value = currentArenaNumber;
  $("arenaNumberModal").classList.remove("hidden");
  $("arenaNumberInput").focus();
}
function closeArenaNumber() {
  $("arenaNumberModal").classList.add("hidden");
}
function saveArenaNumber() {
  send({ type: "host", action: "setArenaNumber", value: $("arenaNumberInput").value });
  closeArenaNumber();
}
function openRules() {
  closeSettings();
  renderActiveRuleset(activeRuleset || lastState?.ruleset);
  $("rulesModal").classList.remove("hidden");
  void refreshRulesFiles();
}
function closeRules() {
  $("rulesModal").classList.add("hidden");
}
function powerActionLabel(action = powerAction) {
  return String(action || "").toUpperCase() === "SHUTDOWN"
    ? "SHUTDOWN"
    : "REBOOT";
}
function openPowerAction(action) {
  const normalized = String(action || "").toLowerCase();
  if (normalized !== "reboot" && normalized !== "shutdown") return;
  closeSettings();
  powerAction = normalized;
  powerActionScheduled = false;
  $("powerActionTitle").textContent = powerActionLabel(normalized);
  $("powerActionMessage").textContent =
    `${powerActionLabel(normalized)} SFTS? The scoreboard will become unavailable.`;
  $("powerCountdown").classList.add("hidden");
  $("powerCountdownStatus").textContent =
    "The action will begin after a 15-second countdown.";
  $("powerConfirmButton").textContent = `START ${powerActionLabel(normalized)}`;
  $("powerConfirmButton").disabled = false;
  $("powerCancelButton").disabled = false;
  $("powerModal").classList.remove("hidden");
}
function confirmPowerAction() {
  if (!powerAction || powerActionScheduled) return;
  powerActionScheduled = true;
  $("powerConfirmButton").disabled = true;
  $("powerCountdownStatus").textContent = "Requesting system power action...";
  send({ type: "host", action: "systemPower", powerAction });
}
function beginPowerCountdown(message) {
  powerAction = String(message.action || "").toLowerCase();
  powerActionScheduled = true;
  powerDeadlineAt = Number(message.deadlineAt) || Date.now() + 15000;
  $("powerActionTitle").textContent = powerActionLabel(powerAction);
  $("powerActionMessage").textContent =
    `${powerActionLabel(powerAction)} has been scheduled. Keep this window open to cancel.`;
  $("powerCountdown").classList.remove("hidden");
  $("powerConfirmButton").classList.add("hidden");
  $("powerCancelButton").disabled = false;
  $("powerCountdownStatus").textContent =
    `${powerActionLabel(powerAction)} will start in 15 seconds.`;
  $("powerModal").classList.remove("hidden");
  clearInterval(powerCountdownTimer);
  updatePowerCountdown();
  powerCountdownTimer = setInterval(updatePowerCountdown, 100);
}
function updatePowerCountdown() {
  const remainingMs = Math.max(0, powerDeadlineAt - Date.now());
  $("powerCountdown").textContent = String(Math.ceil(remainingMs / 1000));
  if (remainingMs <= 0) {
    clearInterval(powerCountdownTimer);
    powerCountdownTimer = null;
    $("powerCountdownStatus").textContent = `${powerActionLabel()} STARTING...`;
  }
}
function cancelPowerAction() {
  if (powerActionScheduled) {
    $("powerCancelButton").disabled = true;
    $("powerCountdownStatus").textContent = "Cancelling system power action...";
    send({ type: "host", action: "cancelSystemPower" });
    return;
  }
  closePowerModal();
}
function closePowerModal() {
  clearInterval(powerCountdownTimer);
  powerCountdownTimer = null;
  powerAction = "";
  powerActionScheduled = false;
  powerDeadlineAt = 0;
  $("powerModal").classList.add("hidden");
  $("powerCountdown").classList.add("hidden");
  $("powerConfirmButton").classList.remove("hidden");
  $("powerConfirmButton").disabled = false;
  $("powerCancelButton").disabled = false;
}
function openPlayerSettings() {
  closeSettings();
  $("playerSettingsModal").classList.remove("hidden");
}
function closePlayerSettings() {
  $("playerSettingsModal").classList.add("hidden");
}

function openDataImport() {
  closePlayerSettings();
  renderTournament(lastTournament);
  renderUsbImportMode();
  $("dataImportModal").classList.remove("hidden");
  if (usbImportOnly) void refreshUsbFiles();
}

function backFromDataImport() {
  $("dataImportModal").classList.add("hidden");
  $("playerSettingsModal").classList.remove("hidden");
}

function practicePlayerPayload(prefix) {
  return {
    playerName: $(`${prefix}Name`).value,
    stateCode: $(`${prefix}StateCode`).value,
    district: $(`${prefix}District`).value,
  };
}

function fillPracticePlayer(corner, player) {
  const prefix = corner === "RED" ? "practiceRed" : "practiceBlue";
  $(`${prefix}Name`).value = player?.playerName || "";
  $(`${prefix}StateCode`).value = player?.stateCode || "";
  $(`${prefix}District`).value = player?.district || "";
}

function practiceDetails() {
  return {
    RED: practicePlayerPayload("practiceRed"),
    BLUE: practicePlayerPayload("practiceBlue"),
  };
}

function practiceNamesAreReady(details) {
  if (!details.RED.playerName.trim() || !details.BLUE.playerName.trim()) {
    toast("ENTER BOTH HONG AND CHUNG PLAYER NAMES");
    return false;
  }
  return true;
}

function openPracticeMode() {
  closePlayerSettings();
  if (lastState?.mode === "PRACTICE") {
    fillPracticePlayer("RED", lastState.red);
    fillPracticePlayer("BLUE", lastState.blue);
  }
  $("practiceModeModal").classList.remove("hidden");
}

function backFromPracticeMode() {
  practiceLoadPending = false;
  $("practiceModeModal").classList.add("hidden");
  $("playerSettingsModal").classList.remove("hidden");
}

function announcePracticePlayers() {
  const details = practiceDetails();
  if (!practiceNamesAreReady(details)) return;
  send({ type: "host", action: "announcePractice", details });
}

function loadPracticeMatch() {
  const details = practiceDetails();
  if (!practiceNamesAreReady(details)) return;
  practiceLoadPending = true;
  send({ type: "host", action: "loadPractice", details });
}

function rulepackDivisions() {
  return Array.isArray(scoringRules?.tournament?.divisions)
    ? scoringRules.tournament.divisions
    : [];
}

function manualCategoryLabel(category) {
  const competition = category.competition === "FRESHER KYORUGI" ? "FRESHER" : "KYORUGI";
  return `${category.eventName} · ${category.divisionLabel || category.division} · ${category.gender} · ${category.categoryGroup || category.weightCategory} · ARENA ${category.arenaNumber} · ${competition}`;
}

function manualSelectedCategory() {
  const categoryId = $("manualCategoryId")?.value || "";
  return (lastManualCompetition?.categories || []).find(category => category.id === categoryId) || null;
}

function manualCategoryBoutCount(category) {
  return Array.isArray(category?.matchRecordIds) ? category.matchRecordIds.length : 0;
}

function renderManualCategoryOptions() {
  const categories = lastManualCompetition?.categories || [];
  for (const id of ["manualCategoryId", "manualResultsCategoryId"]) {
    const select = $(id);
    if (!select) continue;
    const previous = select.value;
    select.replaceChildren();
    if (id === "manualCategoryId") {
      const create = document.createElement("option");
      create.value = "";
      create.textContent = "CREATE NEW CATEGORY";
      select.appendChild(create);
    }
    for (const category of categories) {
      const option = document.createElement("option");
      option.value = category.id;
      option.textContent = `${manualCategoryLabel(category)}${category.status === "FINALIZED" ? " · FINALIZED" : ""}`;
      select.appendChild(option);
    }
    if ([...select.options].some(option => option.value === previous)) select.value = previous;
    else if (id === "manualResultsCategoryId" && categories[0]) select.value = categories[0].id;
  }
}

function populateManualDivisions() {
  const select = $("manualDivision");
  const previous = select.value;
  select.replaceChildren();
  for (const division of rulepackDivisions()) {
    const option = document.createElement("option");
    option.value = division.id;
    option.textContent = `${division.label} · ${division.ageLabel || ""}`;
    select.appendChild(option);
  }
  if ([...select.options].some(option => option.value === previous)) select.value = previous;
  renderManualCategories();
}

function renderManualCategories() {
  const division = rulepackDivisions().find(item => item.id === $("manualDivision")?.value);
  const gender = $("manualGender")?.value || "MALE";
  const isGroup = division?.categoryType === "GROUP";
  $("manualWeightField")?.classList.toggle("hidden", isGroup);
  $("manualGroupField")?.classList.toggle("hidden", !isGroup);
  const select = isGroup ? $("manualCategoryGroup") : $("manualWeightCategory");
  if (!select) return;
  const previous = select.value;
  const choices = isGroup ? division?.groups || [] : division?.weightCategories?.[gender] || [];
  select.replaceChildren();
  for (const choice of choices) {
    const option = document.createElement("option");
    option.value = choice.name;
    option.textContent = `${choice.name} · ${choice.ageLabel || choice.limit || ""}`;
    select.appendChild(option);
  }
  if ([...select.options].some(option => option.value === previous)) select.value = previous;
  const hint = $("manualRulepackHint");
  if (hint) hint.textContent = division
    ? `ACTIVE RULEPACK: ${activeRuleset?.name || "RULESET"} ${activeRuleset?.version || ""} · ${division.label} · ${division.ageLabel || ""} · ${isGroup ? "CATEGORY GROUP IS RULEPACK CONTROLLED" : "WEIGHT CATEGORY IS RULEPACK CONTROLLED"}`
    : "NO TOURNAMENT DIVISIONS ARE AVAILABLE IN THE ACTIVE RULEPACK";
}

function setManualCategoryFieldsDisabled(disabled) {
  for (const id of ["manualEventName", "manualEventDate", "manualVenue", "manualArenaNumber", "manualCompetition", "manualDivision", "manualGender", "manualWeightCategory", "manualCategoryGroup"]) {
    if ($(id)) $(id).disabled = disabled;
  }
}

function resetManualCategoryFields() {
  $("manualEventName").value = "";
  $("manualEventDate").value = new Date().toISOString().slice(0, 10);
  $("manualVenue").value = "";
  $("manualArenaNumber").value = currentArenaNumber || "";
  $("manualCompetition").value = "KYORUGI";
  $("manualGender").value = "MALE";
  populateManualDivisions();
}

function loadManualCategorySelection(resetNewCategory = false) {
  const category = manualSelectedCategory();
  setManualCategoryFieldsDisabled(Boolean(category));
  if (category) {
    $("manualEventName").value = category.eventName || "";
    $("manualEventDate").value = category.eventDate || "";
    $("manualVenue").value = category.venue || "";
    $("manualArenaNumber").value = category.arenaNumber || "";
    $("manualCompetition").value = category.competition || "KYORUGI";
    $("manualDivision").value = category.division || "";
    $("manualGender").value = category.gender || "MALE";
    renderManualCategories();
    if (category.categoryGroup) $("manualCategoryGroup").value = category.categoryGroup;
    if (category.weightCategory) $("manualWeightCategory").value = category.weightCategory;
  } else if (resetNewCategory) {
    resetManualCategoryFields();
  }
  renderManualCategoryState();
  renderManualWizard();
}

function fillManualPlayer(corner, player) {
  const prefix = corner === "RED" ? "manualRed" : "manualBlue";
  $(`${prefix}Name`).value = player?.playerName || "";
  $(`${prefix}Club`).value = player?.club || "";
  $(`${prefix}StateCode`).value = player?.stateCode || "";
  $(`${prefix}District`).value = player?.district || "";
}

function showManualEntryError(message) {
  const error = $("manualEntryError");
  if (!error) return;
  error.textContent = message;
  error.classList.toggle("hidden", !message);
  if (message) $("manualEntrySuccess")?.classList.add("hidden");
}

function showManualEntrySuccess(message) {
  const success = $("manualEntrySuccess");
  if (!success) return;
  success.textContent = message;
  success.classList.toggle("hidden", !message);
  if (message) $("manualEntryError")?.classList.add("hidden");
}

function clearManualEntryMessages() {
  showManualEntryError("");
  showManualEntrySuccess("");
}

function manualCategorySummary(category = manualSelectedCategory()) {
  if (category) {
    return `${category.divisionLabel || category.division} · ${category.gender} · ${category.categoryGroup || category.weightCategory} · ARENA ${category.arenaNumber}`;
  }
  const division = rulepackDivisions().find(item => item.id === $("manualDivision")?.value);
  const categoryName = division?.categoryType === "GROUP"
    ? $("manualCategoryGroup")?.value
    : $("manualWeightCategory")?.value;
  return `${division?.label || "DIVISION"} · ${$("manualGender")?.value || "GENDER"} · ${categoryName || "CATEGORY"} · ARENA ${$("manualArenaNumber")?.value || "—"}`;
}

function manualCategoryDeleteReason(category) {
  if (!category) return "";
  if (lastState?.manualBout?.categoryId === category.id) return "THIS CATEGORY IS CURRENTLY LOADED ON THE SCOREBOARD";
  return "";
}

function manualCategoryDeleteConfirmationPhrase(category) {
  const completedBouts = manualCategoryBoutCount(category);
  if (completedBouts > 0) return `DELETE ${completedBouts} BOUT${completedBouts === 1 ? "" : "S"}`;
  if (category?.status === "FINALIZED") return "DELETE FINALIZED CATEGORY";
  return "";
}

function renderManualCategoryState() {
  const category = manualSelectedCategory();
  const button = $("manualDeleteCategoryButton");
  const status = $("manualCategoryStatus");
  if (!button || !status) return;
  button.classList.toggle("hidden", !category);
  if (!category) {
    status.textContent = "A NEW CATEGORY WILL BE CREATED WHEN THIS BOUT IS LOADED.";
    return;
  }
  const reason = manualCategoryDeleteReason(category);
  const completedBouts = manualCategoryBoutCount(category);
  button.disabled = Boolean(reason);
  button.textContent = completedBouts > 0
    ? `DELETE CATEGORY + ${completedBouts} BOUT${completedBouts === 1 ? "" : "S"}`
    : category.status === "FINALIZED"
      ? "DELETE FINALIZED CATEGORY"
      : "DELETE CATEGORY";
  status.textContent = reason || (completedBouts > 0
    ? `${completedBouts} COMPLETED BOUT${completedBouts === 1 ? "" : "S"} · ADVANCED PERMANENT DELETE AVAILABLE`
    : category.status === "FINALIZED"
      ? "FINALIZED · ADVANCED PERMANENT DELETE AVAILABLE"
      : "OPEN · 0 COMPLETED BOUTS · SAFE TO DELETE");
}

function manualReviewRow(label, value) {
  return `<p><span>${escapeHtml(label)}</span><b>${escapeHtml(value || "—")}</b></p>`;
}

function renderManualReview() {
  const details = manualBoutPayload();
  const category = manualSelectedCategory();
  const division = category?.divisionLabel || rulepackDivisions().find(item => item.id === details.division)?.label || details.division;
  const categoryName = category?.categoryGroup || category?.weightCategory || details.categoryGroup || details.weightCategory;
  $("manualReviewCategory").innerHTML =
    manualReviewRow("DIVISION", division) +
    manualReviewRow("GENDER", category?.gender || details.gender) +
    manualReviewRow("CATEGORY", categoryName) +
    manualReviewRow("ARENA", category?.arenaNumber || details.arenaNumber);
  $("manualReviewBout").innerHTML =
    manualReviewRow("REFERENCE", details.officialBoutNo) +
    manualReviewRow("STAGE", details.stage) +
    manualReviewRow("RULESET", `${activeRuleset?.name || "RULESET"} ${activeRuleset?.version || ""}`.trim());
  $("manualReviewCompetitors").innerHTML =
    manualReviewRow("HONG", details.RED.playerName) +
    manualReviewRow("CHUNG", details.BLUE.playerName);
}

function renderLoadedManualBout(match = lastState) {
  if (!match?.manualBout) return;
  const category = (lastManualCompetition?.categories || []).find(item => item.id === match.manualBout.categoryId);
  const redName = match.red?.playerName || "HONG";
  const blueName = match.blue?.playerName || "CHUNG";
  $("manualLoadedTitle").textContent = `BOUT ${match.manualBout.officialBoutNo} LOADED`;
  $("manualLoadedSummary").textContent = `${redName}, HONG, versus ${blueName}, CHUNG · ${category ? manualCategorySummary(category) : "MANUAL BOUT"} · ${match.manualBout.stage}`;
  const editable = match.phase === "ROUND" && !match.roundStarted && !match.running;
  $("manualEditLoadedBoutButton").classList.toggle("hidden", !editable);
}

function renderManualWizard() {
  if (!$("manualEntryModal")) return;
  const panelIds = ["manualWizardCategory", "manualWizardBout", "manualWizardCompetitors", "manualWizardReview"];
  panelIds.forEach((id, index) => $(id).classList.toggle("hidden", manualWizardStep !== index));
  $("manualWizardLoaded").classList.toggle("hidden", manualWizardStep !== 4);
  [...$("manualWizardSteps").children].forEach((item, index) => {
    item.classList.toggle("active", manualWizardStep === index);
    item.classList.toggle("complete", manualWizardStep > index);
  });

  const loaded = manualWizardStep === 4;
  $("manualWizardFooter").classList.toggle("hidden", loaded);
  $("manualPrepareNextNotice").classList.toggle("hidden", lastState?.phase !== "MATCH_END");
  $("manualWizardBackButton").disabled = manualWizardStep === 0 || Boolean(manualBoutSavePending);
  $("manualWizardNextButton").disabled = Boolean(manualBoutSavePending) || lastState?.phase === "MATCH_END";
  $("manualWizardNextButton").textContent = manualBoutSavePending
    ? "LOADING..."
    : manualWizardStep === 3
      ? ($("manualAnnounceAfterLoad").checked ? "LOAD & ANNOUNCE" : "LOAD BOUT")
      : "CONTINUE";
  const labels = ["CATEGORY", "BOUT", "COMPETITORS", "REVIEW & LOAD"];
  $("manualWizardStatus").textContent = `STEP ${Math.min(manualWizardStep + 1, 4)} OF 4 · ${labels[Math.min(manualWizardStep, 3)]}`;
  $("manualRulesetSummary").textContent = `ACTIVE RULESET: ${activeRuleset?.name || "RULESET"} ${activeRuleset?.version || ""}`;
  $("manualBoutCategorySummary").textContent = manualCategorySummary();
  renderManualCategoryState();
  if (manualWizardStep === 3) renderManualReview();
  if (loaded) renderLoadedManualBout();
}

function manualWizardValidation(step) {
  if (lastState?.phase === "MATCH_END") return "PREPARE THE NEXT BOUT BEFORE ENTERING NEW DETAILS";
  if (step === 0) {
    const category = manualSelectedCategory();
    if (category?.status === "FINALIZED") return "THE SELECTED CATEGORY IS FINALIZED. CHOOSE OR CREATE AN OPEN CATEGORY";
    if (category) return "";
    const required = [
      ["manualEventName", "ENTER THE TOURNAMENT NAME"],
      ["manualEventDate", "CHOOSE THE TOURNAMENT DATE"],
      ["manualVenue", "ENTER THE VENUE"],
      ["manualArenaNumber", "ENTER THE ARENA NUMBER"],
      ["manualDivision", "CHOOSE A RULE-PACK DIVISION"],
    ];
    for (const [id, message] of required) if (!$(id).value.trim()) return message;
    const arena = Number($("manualArenaNumber").value);
    if (!Number.isInteger(arena) || arena < 1 || arena > 999) return "ARENA NUMBER MUST BE FROM 1 TO 999";
    const division = rulepackDivisions().find(item => item.id === $("manualDivision").value);
    const categoryValue = division?.categoryType === "GROUP" ? $("manualCategoryGroup").value : $("manualWeightCategory").value;
    if (!categoryValue) return "CHOOSE A CATEGORY FROM THE ACTIVE RULE PACK";
  }
  if (step === 1 && !$("manualOfficialBoutNo").value.trim()) return "ENTER THE OFFICIAL BOUT OR REFERENCE NUMBER";
  if (step === 2) {
    if (!$("manualRedName").value.trim()) return "ENTER THE HONG PLAYER NAME";
    if (!$("manualRedClub").value.trim()) return "ENTER THE HONG AFFILIATION OR CLUB";
    if (!$("manualBlueName").value.trim()) return "ENTER THE CHUNG PLAYER NAME";
    if (!$("manualBlueClub").value.trim()) return "ENTER THE CHUNG AFFILIATION OR CLUB";
  }
  return "";
}

function setManualWizardStep(step) {
  manualWizardStep = Math.max(0, Math.min(4, step));
  clearManualEntryMessages();
  renderManualWizard();
}

function manualWizardNext() {
  if (manualBoutSavePending || manualWizardStep === 4) return;
  const error = manualWizardValidation(manualWizardStep);
  if (error) {
    showManualEntryError(error);
    return;
  }
  if (manualWizardStep < 3) {
    setManualWizardStep(manualWizardStep + 1);
    return;
  }
  saveManualBout($("manualAnnounceAfterLoad").checked);
}

function manualWizardBack() {
  if (manualBoutSavePending || manualWizardStep <= 0) return;
  setManualWizardStep(manualWizardStep - 1);
}

function openManualEntry() {
  closePlayerSettings();
  populateManualDivisions();
  renderManualCategoryOptions();
  const activeCategoryId = lastState?.manualBout?.categoryId || "";
  if (activeCategoryId && [...$("manualCategoryId").options].some(option => option.value === activeCategoryId)) {
    $("manualCategoryId").value = activeCategoryId;
    loadManualCategorySelection(false);
  } else {
    const selectedCategory = manualSelectedCategory();
    if (selectedCategory) loadManualCategorySelection(false);
    else {
      setManualCategoryFieldsDisabled(false);
      if (!$("manualEventDate").value) $("manualEventDate").value = new Date().toISOString().slice(0, 10);
      if (!$("manualArenaNumber").value) $("manualArenaNumber").value = currentArenaNumber || "";
    }
  }
  fillManualPlayer("RED", lastState?.red);
  fillManualPlayer("BLUE", lastState?.blue);
  $("manualOfficialBoutNo").value = lastState?.manualBout?.officialBoutNo || "";
  $("manualStage").value = lastState?.manualBout?.stage || "PRELIMINARY";
  $("manualAnnounceAfterLoad").checked = false;
  manualWizardStep = lastState?.manualBout && lastState?.phase === "ROUND" ? 4 : 0;
  clearManualEntryMessages();
  $("manualEntryModal").classList.remove("hidden");
  renderManualWizard();
}

function backFromManualEntry() {
  $("manualEntryModal").classList.add("hidden");
  $("playerSettingsModal").classList.remove("hidden");
}

function closeManualEntryToScoreboard() {
  $("manualEntryModal").classList.add("hidden");
}

function editLoadedManualBout() {
  if (!lastState || lastState.phase !== "ROUND" || lastState.roundStarted || lastState.running) {
    showManualEntryError("BOUT DETAILS CANNOT BE CHANGED AFTER THE MATCH STARTS");
    return;
  }
  setManualWizardStep(0);
}

function manualPlayerPayload(prefix) {
  return {
    playerName: $(`${prefix}Name`).value,
    club: $(`${prefix}Club`).value,
    stateCode: $(`${prefix}StateCode`).value,
    district: $(`${prefix}District`).value,
  };
}

function manualBoutPayload() {
  return {
    categoryId: $("manualCategoryId").value,
    eventName: $("manualEventName").value,
    eventDate: $("manualEventDate").value,
    venue: $("manualVenue").value,
    arenaNumber: $("manualArenaNumber").value,
    competition: $("manualCompetition").value,
    division: $("manualDivision").value,
    gender: $("manualGender").value,
    weightCategory: $("manualWeightCategory").value,
    categoryGroup: $("manualCategoryGroup").value,
    officialBoutNo: $("manualOfficialBoutNo").value,
    stage: $("manualStage").value,
    RED: manualPlayerPayload("manualRed"),
    BLUE: manualPlayerPayload("manualBlue"),
  };
}

function saveManualBout(announce = false) {
  for (const step of [0, 1, 2]) {
    const error = manualWizardValidation(step);
    if (error) {
      manualWizardStep = step;
      showManualEntryError(error);
      renderManualWizard();
      return;
    }
  }
  const details = manualBoutPayload();
  manualBoutSavePending = { officialBoutNo: details.officialBoutNo, playerName: details.RED.playerName };
  clearManualEntryMessages();
  renderManualWizard();
  send({ type: "host", action: "saveManualBout", details, announce });
}

function swapManualPlayers() {
  const red = manualPlayerPayload("manualRed");
  const blue = manualPlayerPayload("manualBlue");
  fillManualPlayer("RED", blue);
  fillManualPlayer("BLUE", red);
}

function clearManualPlayers() {
  fillManualPlayer("RED", {});
  fillManualPlayer("BLUE", {});
}

function nextManualBout() {
  if (lastState?.phase !== "MATCH_END") {
    toast("FINISH THE CURRENT MATCH BEFORE PREPARING THE NEXT BOUT");
    return;
  }
  manualNextBoutPending = true;
  clearManualEntryMessages();
  renderManualWizard();
  send({ type: "host", action: "nextManualBout" });
}

function showManualDeleteError(message) {
  const error = $("manualDeleteCategoryError");
  error.textContent = message;
  error.classList.toggle("hidden", !message);
}

function openManualCategoryDelete() {
  const category = manualSelectedCategory();
  if (!category) return;
  const reason = manualCategoryDeleteReason(category);
  if (reason) {
    showManualEntryError(reason);
    return;
  }
  const completedBouts = manualCategoryBoutCount(category);
  const confirmation = manualCategoryDeleteConfirmationPhrase(category);
  const advanced = Boolean(confirmation);
  $("manualDeleteCategoryTitle").textContent = advanced ? "ADVANCED PERMANENT DELETE" : "DELETE CATEGORY?";
  $("manualDeleteCategoryMessage").textContent = completedBouts > 0
    ? `This will permanently delete this category, all ${completedBouts} official bout record${completedBouts === 1 ? "" : "s"}, and their entries in match history. This cannot be undone.`
    : category.status === "FINALIZED"
      ? "This will permanently delete the finalized category. This cannot be undone."
      : "This category has no completed bouts. Deletion is permanent and cannot be undone.";
  $("manualDeleteCategorySummary").textContent = manualCategoryLabel(category);
  $("manualDeleteCategoryModal").classList.toggle("advancedDelete", advanced);
  $("manualDeleteCategoryConfirmationField").classList.toggle("hidden", !advanced);
  $("manualDeleteCategoryConfirmationLabel").textContent = advanced ? `TYPE ${confirmation} TO CONFIRM` : "";
  $("manualDeleteCategoryConfirmation").value = "";
  $("manualConfirmDeleteCategoryButton").textContent = completedBouts > 0
    ? `DELETE CATEGORY + ${completedBouts} BOUT${completedBouts === 1 ? "" : "S"}`
    : "DELETE PERMANENTLY";
  showManualDeleteError("");
  $("manualDeleteCategoryModal").classList.remove("hidden");
  updateManualCategoryDeleteConfirmation();
  if (advanced) $("manualDeleteCategoryConfirmation").focus();
}

function closeManualCategoryDelete() {
  if (manualDeletePendingCategoryId) return;
  $("manualDeleteCategoryModal").classList.add("hidden");
  $("manualDeleteCategoryConfirmation").value = "";
  showManualDeleteError("");
}

function updateManualCategoryDeleteConfirmation() {
  const category = manualSelectedCategory();
  const confirmation = category ? manualCategoryDeleteConfirmationPhrase(category) : "";
  const typed = $("manualDeleteCategoryConfirmation")?.value.trim().toUpperCase() || "";
  const confirmed = !confirmation || typed === confirmation;
  if ($("manualConfirmDeleteCategoryButton")) {
    $("manualConfirmDeleteCategoryButton").disabled = Boolean(manualDeletePendingCategoryId) || !confirmed;
  }
}

function confirmManualCategoryDelete() {
  const category = manualSelectedCategory();
  if (!category || manualDeletePendingCategoryId) return;
  const reason = manualCategoryDeleteReason(category);
  if (reason) {
    showManualDeleteError(reason);
    return;
  }
  const confirmation = manualCategoryDeleteConfirmationPhrase(category);
  const typed = $("manualDeleteCategoryConfirmation")?.value.trim().toUpperCase() || "";
  if (confirmation && typed !== confirmation) {
    showManualDeleteError(`TYPE ${confirmation} EXACTLY TO CONTINUE`);
    updateManualCategoryDeleteConfirmation();
    return;
  }
  manualDeletePendingCategoryId = category.id;
  $("manualConfirmDeleteCategoryButton").disabled = true;
  showManualDeleteError("");
  send({
    type: "host",
    action: "deleteManualCategory",
    categoryId: category.id,
    deleteRecords: Boolean(confirmation),
    confirmation,
  });
}

function handleManualEntryState(match) {
  if (manualDeletePendingCategoryId) {
    const deletedId = manualDeletePendingCategoryId;
    const stillExists = (lastManualCompetition?.categories || []).some(category => category.id === deletedId);
    if (!stillExists) {
      manualDeletePendingCategoryId = "";
      $("manualDeleteCategoryModal")?.classList.add("hidden");
      if ($("manualCategoryId")?.value === deletedId) $("manualCategoryId").value = "";
      loadManualCategorySelection(true);
      showManualEntrySuccess("CATEGORY DELETED. CHOOSE ANOTHER CATEGORY OR CREATE A NEW ONE.");
    }
  }
  if (manualNextBoutPending && match?.phase === "ROUND" && !match.manualBout) {
    manualNextBoutPending = false;
    clearManualPlayers();
    $("manualOfficialBoutNo").value = "";
    $("manualStage").value = "PRELIMINARY";
    manualWizardStep = 0;
    showManualEntrySuccess("READY TO ENTER THE NEXT MANUAL BOUT.");
  }
  if (manualBoutSavePending && match?.manualBout) {
    const expected = manualBoutSavePending;
    const officialBoutNo = String(match.manualBout.officialBoutNo || "").trim().toUpperCase();
    const playerName = String(match.red?.playerName || "").trim().toUpperCase();
    if (officialBoutNo === String(expected.officialBoutNo).trim().toUpperCase() && playerName === String(expected.playerName).trim().toUpperCase()) {
      manualBoutSavePending = null;
      if ($("manualCategoryId")) $("manualCategoryId").value = match.manualBout.categoryId;
      loadManualCategorySelection(false);
      manualWizardStep = 4;
      showManualEntrySuccess("BOUT LOADED SUCCESSFULLY.");
    }
  }
  if (!$("manualEntryModal")?.classList.contains("hidden")) renderManualWizard();
}

function manualCategoryRecords(categoryId) {
  return manualRecordsCache
    .filter(record => record.manualBout?.categoryId === categoryId)
    .sort((left, right) => String(left.endedAt).localeCompare(String(right.endedAt)));
}

function manualParticipant(player) {
  if (!player?.playerName) return null;
  return {
    key: `${player.playerName.trim().toUpperCase()}|${String(player.club || "").trim().toUpperCase()}`,
    playerName: player.playerName,
    club: player.club || "",
  };
}

function manualPlacementSuggestions(records) {
  const suggestions = { gold: null, silver: null, bronze1: null, bronze2: null };
  const final = [...records].reverse().find(record => record.manualBout?.stage === "FINAL" && record.winner);
  if (final) {
    suggestions.gold = manualParticipant(final.winner === "RED" ? final.red : final.blue);
    suggestions.silver = manualParticipant(final.winner === "RED" ? final.blue : final.red);
  }
  const semifinalLosers = records
    .filter(record => record.manualBout?.stage === "SEMIFINAL" && record.winner)
    .map(record => manualParticipant(record.winner === "RED" ? record.blue : record.red))
    .filter(Boolean);
  suggestions.bronze1 = semifinalLosers[0] || null;
  suggestions.bronze2 = semifinalLosers[1] || null;
  return suggestions;
}

function manualReportCategory() {
  return (lastManualCompetition?.categories || []).find(item => item.id === $("manualResultsCategoryId")?.value) || null;
}

const manualPlacementFields = {
  manualPlaceGold: "gold",
  manualPlaceSilver: "silver",
  manualPlaceBronze1: "bronze1",
  manualPlaceBronze2: "bronze2",
};

function manualParticipants(records) {
  const participants = new Map();
  for (const record of records) {
    for (const player of [record.red, record.blue]) {
      const participant = manualParticipant(player);
      if (participant) participants.set(participant.key, participant);
    }
  }
  return participants;
}

function manualPlacementsWereSaved(category) {
  return Boolean(
    category?.placementsSavedAt ||
    category?.status === "FINALIZED" ||
    Object.values(category?.placements || {}).some(Boolean)
  );
}

function setPlacementOptions(category, records) {
  const participants = manualParticipants(records);
  const suggestions = manualPlacementSuggestions(records);
  const saved = category.placements || {};
  const useSaved = manualPlacementsWereSaved(category);
  for (const [id, place] of Object.entries(manualPlacementFields)) {
    const select = $(id);
    const previous = select.value;
    const sameCategory = select.dataset.categoryId === category.id;
    const savedAt = category.placementsSavedAt || "";
    const preserveUnsavedEdit = sameCategory && select.dataset.dirty === "true" && select.dataset.savedAt === savedAt;
    select.replaceChildren();
    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = "NOT AWARDED";
    select.appendChild(blank);
    for (const participant of participants.values()) {
      const option = document.createElement("option");
      option.value = participant.key;
      option.textContent = `${participant.playerName}${participant.club ? ` · ${participant.club}` : ""}`;
      select.appendChild(option);
    }
    const desired = preserveUnsavedEdit
      ? previous
      : useSaved
        ? saved[place]?.key || ""
        : sameCategory
          ? previous
          : suggestions[place]?.key || "";
    if ([...select.options].some(option => option.value === desired)) select.value = desired;
    select.dataset.categoryId = category.id;
    select.dataset.savedAt = savedAt;
    if (!preserveUnsavedEdit) select.dataset.dirty = "false";
    select.disabled = category.status === "FINALIZED";
  }
}

function currentManualPlacements(records) {
  const participants = manualParticipants(records);
  const placements = {};
  for (const [id, place] of Object.entries(manualPlacementFields)) {
    placements[place] = participants.get($(id)?.value || "") || null;
  }
  return placements;
}

function updateManualResultsControls(category, records) {
  const status = $("manualResultsCategoryStatus");
  const boutCount = $("manualResultsBoutCount");
  const guidance = $("manualPlacementGuidance");
  const saveButton = $("manualSavePlacementsButton");
  const finalizeButton = $("manualFinalizeCategoryButton");
  const historyOption = $("manualIncludeCornerRefereeHistory");
  const historyAvailability = $("manualCornerHistoryAvailability");
  const previewButton = $("manualToggleReportPreviewButton");
  const printSummaryButton = $("manualPrintSummaryButton");
  const printFullButton = $("manualPrintFullButton");
  const hasCategory = Boolean(category);
  const finalized = category?.status === "FINALIZED";
  const placementSelects = Object.keys(manualPlacementFields).map(id => $(id));
  const selectedPlacements = placementSelects.map(select => select?.value).filter(Boolean);
  const hasDuplicatePlacement = new Set(selectedPlacements).size !== selectedPlacements.length;
  const hasUnsavedChanges = manualPlacementsWereSaved(category)
    ? Object.entries(manualPlacementFields).some(([id, place]) => (
        ($(id)?.value || "") !== (category?.placements?.[place]?.key || "")
      ))
    : placementSelects.some(select => select?.dataset.dirty === "true");
  const totalCornerPresses = records.reduce(
    (total, record) => total + (record.cornerRefereeHistory || []).length,
    0,
  );

  status.textContent = !category ? "NO CATEGORY" : finalized ? "FINALIZED" : "OPEN";
  status.classList.toggle("finalized", finalized);
  status.classList.toggle("empty", !category);
  boutCount.textContent = `${records.length} completed bout${records.length === 1 ? "" : "s"}`;

  if (!category) guidance.textContent = "Create and complete a manual category before confirming results.";
  else if (finalized) guidance.textContent = "This official result is finalized and locked. You can still preview or print it.";
  else if (hasDuplicatePlacement) guidance.textContent = "Choose a different competitor for each awarded medal position.";
  else if (hasUnsavedChanges) guidance.textContent = "You have unsaved placement changes. Check them against the paper fixture, then save.";
  else if (category.placementsSavedAt) guidance.textContent = `Placements saved ${reportDateTime(category.placementsSavedAt)}. Finalize only after an official check.`;
  else guidance.textContent = "Suggestions are ready. Check every position against the official paper fixture before saving.";

  guidance.classList.toggle("warning", hasDuplicatePlacement);
  saveButton.disabled = !hasCategory || finalized || records.length === 0 || hasDuplicatePlacement;
  saveButton.textContent = finalized ? "PLACEMENTS SAVED" : hasUnsavedChanges ? "SAVE CHANGES" : "SAVE PLACEMENTS";
  finalizeButton.disabled = !hasCategory || finalized || hasDuplicatePlacement || !$("manualPlaceGold")?.value;
  finalizeButton.textContent = finalized ? "CATEGORY FINALIZED" : "FINALIZE CATEGORY";
  previewButton.disabled = !hasCategory;
  printSummaryButton.disabled = !hasCategory;
  printFullButton.disabled = !hasCategory;

  historyOption.disabled = !hasCategory || totalCornerPresses === 0;
  if (historyOption.disabled) historyOption.checked = false;
  historyAvailability.textContent = totalCornerPresses
    ? `${totalCornerPresses} recorded button press${totalCornerPresses === 1 ? "" : "es"} · full report only`
    : "No corner-referee history is recorded for this category.";
  updateManualResultsPrintOptions();
}

function manualPlacementChanged(select) {
  if (select) select.dataset.dirty = "true";
  renderManualCategoryReport();
}

function updateManualResultsPrintOptions() {
  const includeHistory = $("manualIncludeCornerRefereeHistory")?.checked === true;
  $("categoryPrintReport")?.classList.toggle("includeCornerRefereeHistory", includeHistory);
  const previewType = $("manualReportPreviewType");
  if (previewType) {
    previewType.textContent = includeHistory
      ? "Corner-referee history included in the full report"
      : "Corner-referee history excluded";
  }
}

function toggleManualReportPreview(forceOpen) {
  const panel = $("manualReportPreviewPanel");
  const button = $("manualToggleReportPreviewButton");
  if (!panel || !button) return;
  const open = typeof forceOpen === "boolean" ? forceOpen : panel.classList.contains("hidden");
  if (open) renderManualCategoryReport();
  panel.classList.toggle("hidden", !open);
  button.textContent = open ? "HIDE REPORT PREVIEW" : "SHOW REPORT PREVIEW";
  button.setAttribute("aria-expanded", String(open));
}

function reportDateTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? String(value) : date.toLocaleString();
}

function placementText(placement) {
  return placement ? `${placement.playerName}${placement.club ? ` · ${placement.club}` : ""}` : "NOT AWARDED";
}

function roundWins(record) {
  const wins = { RED: 0, BLUE: 0 };
  for (const round of record.rounds || []) if (round.winner) wins[round.winner] += 1;
  return `${wins.RED}–${wins.BLUE}`;
}

function roundScores(record) {
  return (record.rounds || []).map(round => `R${round.round}: ${round.red?.score ?? 0}–${round.blue?.score ?? 0}`).join("; ") || "—";
}

function resultCode(reason) {
  return /^[A-Z]+/.exec(String(reason || ""))?.[0] || "—";
}

function resultDescription(reason) {
  const code = resultCode(reason);
  const labels = {
    RSC: "REFEREE STOPS CONTEST",
    WDR: "WITHDRAWAL",
    DSQ: "DISQUALIFICATION",
    PUN: "PUNITIVE DECLARATION",
    DQB: "DISQUALIFICATION FOR UNSPORTSMANLIKE BEHAVIOR",
  };
  return labels[code] ? `${labels[code]} · ${reason}` : String(reason || "—");
}

function winnerReasonDescription(reason) {
  const text = String(reason || "—");
  const code = resultCode(text);
  const labels = {
    PTF: "WIN BY FINAL SCORE",
    PTG: "WIN BY POINT GAP",
    GDP: "WIN BY GOLDEN POINTS",
    SUP: "WIN BY SUPERIORITY",
    RSC: "WIN BY REFEREE STOPS CONTEST",
    WDR: "WIN BY WITHDRAWAL",
    DSQ: "WIN BY DISQUALIFICATION",
    PUN: "WIN BY REFEREE'S PUNITIVE DECLARATION",
    DQB: "WIN BY DISQUALIFICATION FOR UNSPORTSMANLIKE BEHAVIOR",
  };
  const label = labels[code];
  if (!label) return text;
  const detail = text.replace(/^[A-Z]+\s*-\s*/, "").trim();
  return detail && detail !== "REFEREE DECLARATION"
    ? `${label} - ${detail}`
    : label;
}

function renderManualCategoryReport() {
  const category = manualReportCategory();
  const report = $("categoryPrintReport");
  if (!category) {
    report.innerHTML = "<p>No manual category has been created.</p>";
    updateManualResultsControls(null, []);
    return;
  }
  const records = manualCategoryRecords(category.id);
  setPlacementOptions(category, records);
  const placements = currentManualPlacements(records);
  const boutRows = records.map(record => `<tr>
    <td>${escapeHtml(record.manualBout?.officialBoutNo || "—")}</td>
    <td>${escapeHtml(record.matchNo)}</td>
    <td>${escapeHtml(record.manualBout?.stage || "—")}</td>
    <td>${escapeHtml(record.redName)}<br><small>${escapeHtml(record.red?.club || "—")}</small></td>
    <td>${escapeHtml(record.blueName)}<br><small>${escapeHtml(record.blue?.club || "—")}</small></td>
    <td>${escapeHtml(roundScores(record))}</td><td>${escapeHtml(roundWins(record))}</td>
    <td>${escapeHtml(record.winnerName || "DRAW")}</td><td>${escapeHtml(record.defeatedName || "—")}</td>
    <td>${escapeHtml(resultCode(record.reason))}<br><small>${escapeHtml(resultDescription(record.reason))}</small></td>
    <td>${escapeHtml(reportDateTime(record.startedAt))}<br>${escapeHtml(reportDateTime(record.endedAt))}</td>
  </tr>`).join("");
  const audit = records.map(record => {
    const roundRows = (record.rounds || []).map(round => `<tr><td>${escapeHtml(round.round)}</td><td>${escapeHtml(round.red?.score ?? 0)}</td><td>${escapeHtml(round.blue?.score ?? 0)}</td><td>${escapeHtml(round.red?.gamjeom ?? 0)}</td><td>${escapeHtml(round.blue?.gamjeom ?? 0)}</td><td>${escapeHtml(round.winner || "DRAW")}</td><td>${escapeHtml(round.reason || "—")}</td></tr>`).join("");
    const refereeRows = (record.cornerRefereeHistory || []).map(entry => `<tr><td>${escapeHtml(entry.round || "—")}</td><td>${escapeHtml(entry.cornerReferee || `C${entry.corner}`)}</td><td>${escapeHtml(entry.button || "—")}</td><td>${escapeHtml(entry.score ?? "—")}</td><td>${escapeHtml(formatTime(entry.timerMs, false))}</td><td>${escapeHtml(reportDateTime(entry.pressedAt))}</td></tr>`).join("");
    const correctionRows = (record.operatorHistory || []).map(entry => `<tr><td>${escapeHtml(entry.round || "—")}</td><td>${escapeHtml(entry.player || "—")}</td><td>${escapeHtml(entry.action || "—")}</td><td>${escapeHtml(entry.from ?? "—")}</td><td>${escapeHtml(entry.to ?? "—")}</td><td>${escapeHtml(formatTime(entry.timerMs, false))}</td><td>${escapeHtml(reportDateTime(entry.recordedAt))}</td></tr>`).join("");
    return `<section class="categoryReportBout"><h3>BOUT ${escapeHtml(record.manualBout?.officialBoutNo || record.matchNo)} · INTERNAL MATCH ${escapeHtml(record.matchNo)} · RULESET ${escapeHtml(record.ruleset?.name || record.ruleset?.id || "—")} ${escapeHtml(record.ruleset?.version || "")}</h3>
      <h4>ROUND AND PENALTY DETAILS</h4><table><thead><tr><th>ROUND</th><th>RED SCORE</th><th>BLUE SCORE</th><th>RED GAM-JEOM</th><th>BLUE GAM-JEOM</th><th>WINNER</th><th>REASON</th></tr></thead><tbody>${roundRows || '<tr><td colspan="7">NO ROUND RECORDS</td></tr>'}</tbody></table>
      <h4>OPERATOR CORRECTIONS</h4><table><thead><tr><th>ROUND</th><th>PLAYER</th><th>ACTION</th><th>FROM</th><th>TO</th><th>MATCH CLOCK</th><th>TIME</th></tr></thead><tbody>${correctionRows || '<tr><td colspan="7">NO OPERATOR CORRECTIONS RECORDED</td></tr>'}</tbody></table>
      <div class="categoryReportRefereeHistory"><h4>CORNER REFEREE HISTORY</h4><table><thead><tr><th>ROUND</th><th>REFEREE</th><th>BUTTON</th><th>SCORE</th><th>MATCH CLOCK</th><th>TIME</th></tr></thead><tbody>${refereeRows || '<tr><td colspan="6">NO CORNER INPUTS RECORDED</td></tr>'}</tbody></table></div>
    </section>`;
  }).join("");
  report.innerHTML = `<header><h1>${escapeHtml(category.eventName)}</h1><h2>OFFICIAL CATEGORY RESULT</h2></header>
    <div class="categoryReportMeta"><span><b>DATE:</b> ${escapeHtml(category.eventDate)}</span><span><b>VENUE:</b> ${escapeHtml(category.venue)}</span><span><b>ARENA:</b> ${escapeHtml(category.arenaNumber)}</span><span><b>COMPETITION:</b> ${escapeHtml(category.competition)}</span><span><b>DIVISION:</b> ${escapeHtml(category.divisionLabel || category.division)}</span><span><b>GENDER:</b> ${escapeHtml(category.gender)}</span><span><b>CATEGORY:</b> ${escapeHtml(category.categoryGroup || category.weightCategory)}</span><span><b>RULESET:</b> ${escapeHtml(category.ruleset?.name || "—")} ${escapeHtml(category.ruleset?.version || "")}</span><span><b>GENERATED:</b> ${escapeHtml(reportDateTime(new Date().toISOString()))}</span></div>
    <h3>PLACEMENTS</h3><div class="categoryReportPlacements"><span><b>GOLD:</b> ${escapeHtml(placementText(placements.gold))}</span><span><b>SILVER:</b> ${escapeHtml(placementText(placements.silver))}</span><span><b>BRONZE 1:</b> ${escapeHtml(placementText(placements.bronze1))}</span><span><b>BRONZE 2:</b> ${escapeHtml(placementText(placements.bronze2))}</span><span><b>STATUS:</b> ${escapeHtml(category.status)}</span></div>
    <h3>BOUT SUMMARY</h3><table><thead><tr><th>OFFICIAL BOUT</th><th>SFTS MATCH</th><th>STAGE</th><th>RED / AFFILIATION</th><th>BLUE / AFFILIATION</th><th>ROUND SCORES</th><th>ROUND WINS</th><th>WINNER</th><th>DEFEATED</th><th>RESULT</th><th>START / END</th></tr></thead><tbody>${boutRows || '<tr><td colspan="11">NO COMPLETED BOUTS RECORDED</td></tr>'}</tbody></table>
    <div class="categoryReportAudit"><h2>FULL MATCH AUDIT</h2>${audit || "<p>NO COMPLETED BOUTS RECORDED</p>"}</div>
    <footer class="categoryReportSignatures"><span>TECHNICAL OFFICIAL</span><span>REFEREE CHAIR</span><span>FEDERATION REPRESENTATIVE</span></footer>`;
  updateManualResultsControls(category, records);
}

async function refreshManualRecords(categoryId = "") {
  if (!hostToken) return;
  try {
    const query = categoryId ? `?categoryId=${encodeURIComponent(categoryId)}` : "";
    const response = await fetch(`/api/manual/categories${query}`, {
      headers: { "X-SFTS-Host-Token": hostToken },
    });
    if (!response.ok) throw new Error(`CATEGORY ARCHIVE FAILED (${response.status})`);
    const result = await response.json();
    if (categoryId) {
      manualRecordsCache = manualRecordsCache
        .filter(record => record.manualBout?.categoryId !== categoryId)
        .concat(Array.isArray(result.records) ? result.records : []);
    }
    lastManualCompetition = result.manualCompetition || lastManualCompetition;
    renderManualCategoryOptions();
    if (!$("manualCategoryResultsModal")?.classList.contains("hidden")) renderManualCategoryReport();
  } catch (error) {
    toast(error.message || "COULD NOT LOAD CATEGORY ARCHIVE");
  }
}

async function openManualCategoryResults() {
  $("manualEntryModal").classList.add("hidden");
  renderManualCategoryOptions();
  const currentId = $("manualCategoryId")?.value;
  if (currentId && [...$("manualResultsCategoryId").options].some(option => option.value === currentId)) $("manualResultsCategoryId").value = currentId;
  $("manualIncludeCornerRefereeHistory").checked = false;
  toggleManualReportPreview(false);
  $("manualCategoryResultsModal").classList.remove("hidden");
  await refreshManualRecords($("manualResultsCategoryId").value);
  renderManualCategoryReport();
}

function closeManualCategoryResults() {
  $("manualCategoryResultsModal").classList.add("hidden");
  $("manualEntryModal").classList.remove("hidden");
}

async function saveManualPlacements(finalize = false) {
  const category = manualReportCategory();
  if (!category) return;
  if (finalize && !await requestUserPermission("Finalize this category? Placements will be locked and no more bouts can be added.")) return;
  send({
    type: "host",
    action: "saveManualCategoryPlacements",
    categoryId: category.id,
    finalize,
    placements: {
      gold: $("manualPlaceGold").value,
      silver: $("manualPlaceSilver").value,
      bronze1: $("manualPlaceBronze1").value,
      bronze2: $("manualPlaceBronze2").value,
    },
  });
}

function printManualCategory(mode) {
  renderManualCategoryReport();
  document.body.classList.add("printManualCategory", mode === "full" ? "printManualFull" : "printManualSummary");
  const cleanup = () => document.body.classList.remove("printManualCategory", "printManualFull", "printManualSummary");
  window.addEventListener("afterprint", cleanup, { once: true });
  setTimeout(() => window.print(), 100);
}
function savePlayerSettings() {
  send({
    type: "host",
    action: "playerSettings",
    players: {
      RED: {
        playerName: $("playerRedName").value,
        weightCategory: $("playerRedWeight").value,
        stateCode: $("playerRedStateCode").value,
        district: $("playerRedDistrict").value,
      },
      BLUE: {
        playerName: $("playerBlueName").value,
        weightCategory: $("playerBlueWeight").value,
        stateCode: $("playerBlueStateCode").value,
        district: $("playerBlueDistrict").value,
      },
    },
  });
  closePlayerSettings();
}

function announceManualPlayers() {
  const details = {
    RED: {
      playerName: $("playerRedName").value,
      weightCategory: $("playerRedWeight").value,
      stateCode: $("playerRedStateCode").value,
      district: $("playerRedDistrict").value,
    },
    BLUE: {
      playerName: $("playerBlueName").value,
      weightCategory: $("playerBlueWeight").value,
      stateCode: $("playerBlueStateCode").value,
      district: $("playerBlueDistrict").value,
    },
  };
  if (!details.RED.playerName.trim() || !details.BLUE.playerName.trim()) {
    toast("ENTER BOTH PLAYER NAMES FIRST");
    return;
  }
  send({ type: "host", action: "announcePlayers", details });
}

function renderTournament(tournament) {
  const status = $("tournamentImportStatus");
  if (!status) return;
  if (!tournament || !tournament.players || !tournament.players.length) {
    status.textContent = "NO TOURNAMENT SHEET IMPORTED";
    return;
  }
  const groupCount = (tournament.groups || []).length;
  status.textContent = `${tournament.players.length} PLAYERS · ${groupCount} GROUPS · ${(tournament.schedule || []).length} BOUTS · SEED ${tournament.seed}`;
}

async function downloadFile(path, fallbackName) {
  if (!hostToken) {
    toast("HOST SESSION REQUIRED");
    return;
  }
  try {
    const response = await fetch(path, {
      headers: { "X-SFTS-Host-Token": hostToken },
    });
    if (!response.ok) throw new Error(`DOWNLOAD FAILED (${response.status})`);
    const blob = await response.blob();
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = fallbackName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  } catch (error) {
    toast(error.message || "DOWNLOAD FAILED");
  }
}

function downloadPlayerTemplate() {
  if (usbImportOnly) {
    void savePlayerTemplateToUsb();
    return;
  }
  downloadFile("/api/tournament/template.xlsx", "sfts-player-template.xlsx");
}

function renderUsbImportMode() {
  $("nativeTournamentImport")?.classList.toggle("hidden", usbImportOnly);
  $("usbTournamentImport")?.classList.toggle("hidden", !usbImportOnly);
}

function renderUsbStatus(result) {
  const status = $("usbDriveStatus");
  const select = $("usbFileSelect");
  const importButton = $("usbImportButton");
  if (!status || !select || !importButton) return;
  const files = Array.isArray(result?.files) ? result.files : [];
  const mounted = result?.connected === true && result?.mounted === true;
  status.textContent = result?.message || (mounted ? `USB READY · ${files.length} FILE(S)` : "USB DRIVE NOT READY");
  status.classList.toggle("connected", mounted);
  status.classList.toggle("disconnected", !mounted);
  select.replaceChildren();
  if (!files.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = mounted ? "NO SPREADSHEET FILES FOUND" : "REFRESH USB TO CHECK AGAIN";
    select.appendChild(option);
  } else {
    for (const file of files) {
      const option = document.createElement("option");
      option.value = file.name;
      option.textContent = file.name;
      select.appendChild(option);
    }
  }
  select.disabled = !files.length;
  importButton.disabled = !files.length;
  if (Array.isArray(result?.rulesFiles)) renderRulesUsbStatus(result);
}

function renderActiveRuleset(ruleset) {
  const status = $("activeRulesStatus");
  if (!status) return;
  if (!ruleset) {
    status.textContent = "ACTIVE RULESET NOT AVAILABLE";
    return;
  }
  status.textContent = `ACTIVE: ${ruleset.name || ruleset.id || "UNKNOWN"} · ${ruleset.federation || ""} · VERSION ${ruleset.ruleVersion || "UNKNOWN"}`;
}

function renderRulesUsbStatus(result) {
  const status = $("rulesUsbStatus");
  const select = $("usbRulesFile");
  const refreshButton = $("refreshRulesButton");
  const applyButton = $("applyRulesButton");
  const defaultButton = $("defaultRulesButton");
  if (!status || !select || !refreshButton || !applyButton || !defaultButton) return;
  const files = Array.isArray(result?.rulesFiles) ? result.rulesFiles : [];
  const mounted = result?.connected === true && result?.mounted === true;
  status.textContent = result?.message || (mounted ? `USB READY · ${files.length} RULE PACK(S)` : "USB DRIVE NOT READY");
  status.classList.toggle("connected", mounted);
  status.classList.toggle("disconnected", !mounted);
  select.replaceChildren();
  if (!files.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = mounted ? "NO RULE PACKS FOUND" : "REFRESH USB TO CHECK AGAIN";
    select.appendChild(option);
  } else {
    for (const file of files) {
      const option = document.createElement("option");
      option.value = file.name;
      option.textContent = file.name;
      select.appendChild(option);
    }
  }
  select.disabled = !files.length;
  refreshButton.disabled = false;
  applyButton.disabled = !files.length;
  defaultButton.disabled = false;
  if (result?.activeRuleset) {
    activeRuleset = result.activeRuleset;
    renderActiveRuleset(activeRuleset);
  }
}

async function refreshRulesFiles() {
  if (!hostToken) {
    toast("HOST SESSION REQUIRED");
    return;
  }
  const status = $("rulesUsbStatus");
  if (status) {
    status.textContent = "CHECKING USB DRIVE...";
    status.classList.remove("connected", "disconnected");
  }
  try {
    const response = await fetch("/api/rules/status", {
      headers: { "X-SFTS-Host-Token": hostToken },
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.message || "RULE STATUS CHECK FAILED");
    renderRulesUsbStatus(result);
  } catch (error) {
    renderRulesUsbStatus({ rulesFiles: [], message: error.message || "RULE STATUS CHECK FAILED" });
    toast(error.message || "RULE STATUS CHECK FAILED");
  }
}

async function applyRulesFile() {
  const fileName = $("usbRulesFile")?.value;
  if (!fileName) {
    toast("SELECT A RULE PACK");
    return;
  }
  if (!await requestUserPermission("Apply this ruleset? The current match must be finished or reset first.")) return;
  if (!hostToken) {
    toast("HOST SESSION REQUIRED");
    return;
  }
  try {
    const response = await fetch("/api/rules/apply", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-SFTS-Host-Token": hostToken,
      },
      body: JSON.stringify({ fileName }),
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.message || "RULESET APPLY FAILED");
    activeRuleset = result.ruleset || activeRuleset;
    renderActiveRuleset(activeRuleset);
    toast(result.message || "RULESET APPLIED SUCCESSFULLY");
    void refreshRulesFiles();
  } catch (error) {
    toast(error.message || "RULESET APPLY FAILED");
  }
}

async function loadDefaultRules() {
  if (!await requestUserPermission("Load the default rules? The current match must be finished or reset first.")) return;
  if (!hostToken) {
    toast("HOST SESSION REQUIRED");
    return;
  }
  try {
    const response = await fetch("/api/rules/default", {
      method: "POST",
      headers: { "X-SFTS-Host-Token": hostToken },
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.message || "DEFAULT RULESET LOAD FAILED");
    activeRuleset = result.ruleset || activeRuleset;
    renderActiveRuleset(activeRuleset);
    toast(result.message || "DEFAULT RULESET LOADED");
  } catch (error) {
    toast(error.message || "DEFAULT RULESET LOAD FAILED");
  }
}

async function refreshUsbFiles() {
  if (!hostToken) {
    toast("HOST SESSION REQUIRED");
    return;
  }
  const status = $("usbDriveStatus");
  if (status) {
    status.textContent = "CHECKING USB DRIVE...";
    status.classList.remove("connected", "disconnected");
  }
  try {
    const response = await fetch("/api/usb/status", {
      headers: { "X-SFTS-Host-Token": hostToken },
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.message || "USB CHECK FAILED");
    renderUsbStatus(result);
  } catch (error) {
    renderUsbStatus({ files: [], message: error.message || "USB CHECK FAILED" });
    toast(error.message || "USB CHECK FAILED");
  }
}

async function importUsbFile() {
  const fileName = $("usbFileSelect")?.value;
  if (!fileName) {
    toast("SELECT A USB FILE");
    return;
  }
  if (!hostToken) {
    toast("HOST SESSION REQUIRED");
    return;
  }
  const status = $("tournamentImportStatus");
  if (status) status.textContent = "IMPORTING USB PLAYER SHEET...";
  try {
    const response = await fetch("/api/usb/import", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-SFTS-Host-Token": hostToken,
      },
      body: JSON.stringify({ fileName }),
    });
    const result = await response.json();
    if (!response.ok || !result.ok) {
      const details = result.errors?.length ? `: ${result.errors.join("; ")}` : "";
      throw new Error(`${result.message || "USB IMPORT FAILED"}${details}`);
    }
    lastTournament = result.tournament;
    renderTournament(result.tournament);
    toast("SCHEDULE GENERATED FROM USB");
  } catch (error) {
    if (status) status.textContent = error.message || "USB IMPORT FAILED";
    toast(error.message || "USB IMPORT FAILED");
  }
}

async function savePlayerTemplateToUsb() {
  if (!hostToken) {
    toast("HOST SESSION REQUIRED");
    return;
  }
  try {
    const response = await fetch("/api/usb/template", {
      method: "POST",
      headers: { "X-SFTS-Host-Token": hostToken },
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.message || "COULD NOT SAVE TEMPLATE TO USB");
    toast(result.message || "PLAYER TEMPLATE SAVED TO USB");
    void refreshUsbFiles();
  } catch (error) {
    toast(error.message || "COULD NOT SAVE TEMPLATE TO USB");
  }
}

async function unmountUsb() {
  if (!hostToken) {
    toast("HOST SESSION REQUIRED");
    return;
  }
  if (!await requestUserPermission("Unmount the USB drive safely before removing it?")) return;
  try {
    const response = await fetch("/api/usb/unmount", {
      method: "POST",
      headers: { "X-SFTS-Host-Token": hostToken },
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.message || "COULD NOT UNMOUNT USB DRIVE");
    renderUsbStatus({ files: [], message: result.message || "USB DRIVE UNMOUNTED SAFELY" });
    renderRulesUsbStatus({ rulesFiles: [], message: result.message || "USB DRIVE UNMOUNTED SAFELY" });
    toast(result.message || "USB DRIVE UNMOUNTED SAFELY");
  } catch (error) {
    toast(error.message || "COULD NOT UNMOUNT USB DRIVE");
  }
}

async function uploadPlayerSheet() {
  const input = $("playerSheetFile");
  const file = input && input.files[0];
  if (!file) {
    toast("SELECT AN EXCEL FILE");
    return;
  }
  if (!hostToken) {
    toast("HOST SESSION REQUIRED");
    return;
  }
  const status = $("tournamentImportStatus");
  status.textContent = "IMPORTING PLAYER SHEET...";
  try {
    const response = await fetch("/api/tournament/import", {
      method: "POST",
      headers: {
        "Content-Type": file.type || "application/octet-stream",
        "X-SFTS-Host-Token": hostToken,
      },
      body: file,
    });
    const result = await response.json();
    if (!response.ok || !result.ok) {
      const details =
        result.errors && result.errors.length
          ? `: ${result.errors.join("; ")}`
          : "";
      throw new Error(`${result.message || "IMPORT FAILED"}${details}`);
    }
    lastTournament = result.tournament;
    renderTournament(result.tournament);
    toast("SCHEDULE GENERATED");
  } catch (error) {
    status.textContent = error.message || "IMPORT FAILED";
    toast("PLAYER SHEET IMPORT FAILED");
  }
}

function openSchedule() {
  closePlayerSettings();
  $("dataImportModal")?.classList.add("hidden");
  renderSchedule(lastTournament);
  $("scheduleModal").classList.remove("hidden");
}

function closeSchedule() {
  $("scheduleModal").classList.add("hidden");
}

function renderTournamentResults(tournament) {
  const resultList = $("tournamentResultsList");
  if (!resultList) return;
  if (!tournament?.players?.length) {
    resultList.innerHTML = "<p>Import a player sheet to generate category results.</p>";
    return;
  }

  if (tournament.placementPolicy?.enabled === false) {
    resultList.innerHTML = "<p>Category placements are disabled by the tournament rule pack.</p>";
    return;
  }

  const labels = tournament.placementPolicy?.labels || {
    first: "1ST",
    second: "2ND",
    third: "3RD",
  };
  const players = new Map((tournament.players || []).map((player) => [player.id, player]));
  const results = (tournament.groups || []).flatMap((group) =>
    group.resultStatus !== "COMPLETED"
      ? []
      : (group.placements || []).map((placement) => ({
          ...placement,
          groupId: group.id,
          division: group.division,
          gender: group.gender,
          weightCategory: group.weightCategory,
          categoryGroup: group.categoryGroup,
          player: players.get(placement.playerId),
        })),
  );
  if (!results.length) {
    resultList.innerHTML = "<p>Results will appear when a category final is completed.</p>";
    return;
  }

  const placeLabel = (place) =>
    place === 1 ? labels.first : place === 2 ? labels.second : labels.third;
  resultList.innerHTML = `<table>
    <thead><tr><th>BRACKET</th><th>DIVISION</th><th>GENDER</th><th>WEIGHT CATEGORY</th><th>CATEGORY GROUP</th><th>PLACE</th><th>PLAYER</th><th>PLAYER ID</th><th>STATE</th><th>CLUB</th></tr></thead>
    <tbody>${results
      .map((result) => `<tr class="place${result.place}">
        <td>${escapeHtml(result.groupId)}</td>
        <td>${escapeHtml(result.division || "—")}</td>
        <td>${escapeHtml(result.gender)}</td>
        <td>${escapeHtml(result.weightCategory || "—")}</td>
        <td>${escapeHtml(result.categoryGroup || "—")}</td>
        <td>${escapeHtml(placeLabel(result.place))}</td>
        <td>${escapeHtml(result.playerName)}</td>
        <td>${escapeHtml(result.playerId)}</td>
        <td>${escapeHtml(result.player?.stateCode || "—")}</td>
        <td>${escapeHtml(result.player?.club || "—")}</td>
      </tr>`)
      .join("")}</tbody>
  </table>`;
}

function renderSchedule(tournament) {
  const summary = $("scheduleSummary");
  const table = $("scheduleTable");
  if (!summary || !table) return;
  renderTournamentResults(tournament);
  if (!tournament || !tournament.players || !tournament.players.length) {
    summary.textContent = "NO TOURNAMENT SHEET IMPORTED";
    table.innerHTML =
      "<p>Import a player sheet from PLAYER SETTINGS first.</p>";
    return;
  }
  const groups = tournament.groups || [];
  const byeCount = groups.reduce(
    (total, group) => total + (group.byePlayerIds || []).length,
    0,
  );
  summary.textContent = `${tournament.players.length} players · ${groups.length} brackets · ${(tournament.schedule || []).length} bouts · ${byeCount} bye allocation(s) · draw seed ${tournament.seed}`;
  const entries = [
    ...(tournament.schedule || []),
    ...(tournament.byes || []).map((bye) => ({
      boutNo: "—",
      groupId: bye.groupId,
      division: bye.division,
      gender: bye.gender,
      weightCategory: bye.weightCategory,
      categoryGroup: bye.categoryGroup,
      round: bye.round,
      redPlayerName: bye.playerName,
      bluePlayerName: "BYE",
      status: "BYE",
      isBye: true,
    })),
  ];
  if (!entries.length) {
    table.innerHTML =
      "<p>No bouts were generated. Check that each group has at least two players.</p>";
    return;
  }
  table.innerHTML = `<table>
    <thead><tr><th>BOUT</th><th>BRACKET</th><th>DIVISION</th><th>GENDER</th><th>WEIGHT CATEGORY</th><th>CATEGORY GROUP</th><th>ROUND</th><th>RED</th><th>BLUE</th><th>WINNER</th><th>STATUS</th><th>ACTIONS</th></tr></thead>
    <tbody>${entries
      .map((bout) => {
        const canLoad =
          !bout.isBye &&
          (bout.status === "SCHEDULED" || bout.status === "IN_PROGRESS");
        const canAnnounce =
          !bout.isBye &&
          (bout.status === "SCHEDULED" || bout.status === "IN_PROGRESS");
        return `<tr class="${bout.status === "COMPLETED" ? "completed" : bout.status === "IN_PROGRESS" ? "inProgress" : ""}">
        <td>${bout.boutNo}</td><td>${escapeHtml(bout.groupId)}</td><td>${escapeHtml(bout.division || "—")}</td><td>${escapeHtml(bout.gender)}</td>
        <td>${escapeHtml(bout.weightCategory || "—")}</td><td>${escapeHtml(bout.categoryGroup || "—")}</td><td>${bout.round}</td>
        <td>${escapeHtml(bout.redPlayerName)}</td><td>${escapeHtml(bout.bluePlayerName)}</td>
        <td>${escapeHtml(bout.winnerName || "—")}</td>
        <td>${escapeHtml(bout.status)}</td>
        <td class="scheduleRowActions">
          ${canLoad ? `<button onclick="loadScheduledBout(${bout.boutNo})">LOAD</button>` : ""}
          ${canAnnounce ? `<button onclick="announceScheduledBout(${bout.boutNo})">ANNOUNCE</button>` : ""}
          ${bout.status === "TIE_PENDING" ? `<button onclick="resolveScheduledTie(${bout.boutNo}, 'RED')">RED WINS</button><button onclick="resolveScheduledTie(${bout.boutNo}, 'BLUE')">BLUE WINS</button>` : ""}
        </td>
      </tr>`;
      })
      .join("")}</tbody>
  </table>`;
}

function downloadTournamentSchedule(format) {
  const extension = format === "csv" ? "csv" : "xlsx";
  downloadFile(
    `/api/tournament/schedule.${extension}`,
    `sfts-tournament-schedule.${extension}`,
  );
}

function printSchedule() {
  if ($("scheduleModal").classList.contains("hidden")) openSchedule();
  setTimeout(() => window.print(), 100);
}

function announceScheduledBout(boutNo) {
  send({ type: "host", action: "announceBout", boutNo });
}

async function resolveScheduledTie(boutNo, winner) {
  if (!await requestUserPermission(`Resolve this tied bout in favor of ${winner}?`)) return;
  send({ type: "host", action: "resolveTie", boutNo, winner });
}

function loadScheduledBout(boutNo) {
  send({ type: "host", action: "loadBout", boutNo });
  closeSchedule();
}

function browserAnnounce(text) {
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
}

function announceText(text, audioUrl = "") {
  if (!text) return;
  toast(text);
  if (announcementAudio) {
    announcementAudio.pause();
    announcementAudio.currentTime = 0;
    announcementAudio = null;
  }
  if (audioUrl && typeof Audio === "function") {
    const audio = new Audio(audioUrl);
    let fallbackUsed = false;
    const fallback = () => {
      if (fallbackUsed) return;
      fallbackUsed = true;
      browserAnnounce(text);
    };
    audio.addEventListener("error", fallback, { once: true });
    audio.addEventListener(
      "ended",
      () => {
        if (announcementAudio === audio) announcementAudio = null;
      },
      { once: true },
    );
    announcementAudio = audio;
    try {
      const playPromise = audio.play();
      if (playPromise && typeof playPromise.catch === "function")
        playPromise.catch(fallback);
    } catch {
      fallback();
    }
    return;
  }
  browserAnnounce(text);
}
async function resetCurrentMatch() {
  if (await requestUserPermission("Reset the current match?"))
    send({ type: "host", action: "resetMatch" });
  closeSettings();
}

function openTimerEditor() {
  closeSettings();
  if (lastState) $("timeInput").value = formatTime(lastState.configuredRoundMs);
  $("timerModal").classList.remove("hidden");
}
function closeTimerEditor() {
  $("timerModal").classList.add("hidden");
}
function saveTimer() {
  send({
    type: "host",
    action: "setTime",
    ms: parseTime($("timeInput").value),
  });
  closeTimerEditor();
}

function openHistory() {
  closeSettings();
  const box = $("historyList");
  if (!historyCache.length) {
    box.innerHTML = "<p>No completed matches yet.</p>";
  } else {
    box.innerHTML = historyCache
      .map(
        (item) => `
      <div class="historyItem">
        <div><b>MATCH ${String(item.matchNo).padStart(3, "0")}</b></div>
        <div>${escapeHtml(item.redName)} vs ${escapeHtml(item.blueName)}</div>
        <div><strong>${escapeHtml(item.winnerName)}</strong> — ${escapeHtml(item.reason || "")}</div>
        <div>${item.roundCount ?? item.rounds?.length ?? 0} round(s)</div>
      </div>
    `,
      )
      .join("");
  }
  $("historyModal").classList.remove("hidden");
}
function closeHistory() {
  $("historyModal").classList.add("hidden");
}

function renderCornerRefereeHistory() {
  const box = $("cornerRefereeHistoryList");
  if (!box) return;
  const history = Array.isArray(lastState?.cornerRefereeHistory)
    ? [...lastState.cornerRefereeHistory].sort((a, b) =>
        String(a.pressedAt || "").localeCompare(String(b.pressedAt || "")),
      )
    : [];
  if (!history.length) {
    box.innerHTML = "<p>No corner-referee button presses yet.</p>";
    return;
  }
  box.innerHTML = history
    .map((item) => {
      const pressedAt = String(item.pressedAt || "");
      const button = String(item.button || "");
      const side = /^(RED|BLUE)(?:-|_)/.exec(button)?.[1];
      const cornerReferee = side
        ? `C${item.corner || "?"}-${side}`
        : item.cornerReferee || `C${item.corner || "?"}`;
      const matchNo = lastState?.mode === "PRACTICE"
        ? String(lastState.practiceMatchNo || 1).padStart(3, "0")
        : Number.isInteger(item.matchNo)
        ? String(item.matchNo).padStart(3, "0")
        : String(lastState?.matchNo || "—").padStart(3, "0");
      const arenaNumber = String(item.arenaNumber || currentArenaNumber || "—");
      return `
        <div class="cornerRefereeHistoryItem">
          <span>${escapeHtml(matchNo)}</span>
          <span>${escapeHtml(arenaNumber)}</span>
          <strong>${escapeHtml(cornerReferee)}</strong>
          <span>${escapeHtml(button || "—")}</span>
          <span>${item.score === null || item.score === undefined ? "—" : `+${escapeHtml(item.score)}`}</span>
          <time datetime="${escapeHtml(pressedAt)}">${escapeHtml(formatCornerRefereeTimestamp(pressedAt))}</time>
        </div>`;
    })
    .join("");
}

function formatCornerRefereeTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  const hours = date.getHours();
  const hour12 = hours % 12 || 12;
  const pad = (number) => String(number).padStart(2, "0");
  return `${pad(date.getDate())} ${months[date.getMonth()]} ${date.getFullYear()}, ` +
    `${pad(hour12)}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${hours >= 12 ? "PM" : "AM"}`;
}

function openCornerRefereeHistory() {
  closeSettings();
  renderCornerRefereeHistory();
  $("cornerRefereeHistoryModal").classList.remove("hidden");
}
function closeCornerRefereeHistory() {
  $("cornerRefereeHistoryModal").classList.add("hidden");
}

function showRoundSummary(record) {
  currentRoundRecord = record;
  $("roundSummaryScoreboardButton")?.classList.add("hidden");
  const redName = record.red.playerName || record.red.name;
  const blueName = record.blue.playerName || record.blue.name;
  $("roundTitle").textContent = record.winner
    ? `${record.winner === "RED" ? redName : blueName} WON ROUND ${record.round}`
    : `ROUND ${record.round} COMPLETE`;
  $("roundReason").textContent = record.reason;
  $("summaryRedName").textContent = redName;
  $("summaryBlueName").textContent = blueName;
  $("summaryRedScore").textContent = record.red.score;
  $("summaryBlueScore").textContent = record.blue.score;
  $("summaryRedGam").textContent = record.red.gamjeom;
  $("summaryBlueGam").textContent = record.blue.gamjeom;
  for (const point of [1, 2, 3]) {
    const label = scoringRules?.basePointLabels?.[String(point)] || "POINTS";
    $(`summaryRedP${point}Label`).textContent = `+${point} ${label}`;
    $(`summaryBlueP${point}Label`).textContent = `+${point} ${label}`;
  }
  const technicalPoints = scoringRules?.technicalInput?.pointsByBasePoints || {};
  const technicalChestPoints = technicalPoints["2"] || 4;
  const technicalHeadPoints = technicalPoints["3"] || 6;
  $("summaryRedTechnicalChestLabel").textContent = `+${technicalChestPoints} TECHNICAL CHEST`;
  $("summaryBlueTechnicalChestLabel").textContent = `+${technicalChestPoints} TECHNICAL CHEST`;
  $("summaryRedTechnicalHeadLabel").textContent = `+${technicalHeadPoints} TECHNICAL HEAD`;
  $("summaryBlueTechnicalHeadLabel").textContent = `+${technicalHeadPoints} TECHNICAL HEAD`;
  $("summaryRedP1").textContent = record.red.stats.plus1;
  $("summaryRedP2").textContent = record.red.stats.plus2;
  $("summaryRedP3").textContent = record.red.stats.plus3;
  $("summaryRedTechnicalChest").textContent = record.red.stats.technicalChest || 0;
  $("summaryRedTechnicalHead").textContent = record.red.stats.technicalHead || 0;
  $("summaryBlueP1").textContent = record.blue.stats.plus1;
  $("summaryBlueP2").textContent = record.blue.stats.plus2;
  $("summaryBlueP3").textContent = record.blue.stats.plus3;
  $("summaryBlueTechnicalChest").textContent = record.blue.stats.technicalChest || 0;
  $("summaryBlueTechnicalHead").textContent = record.blue.stats.technicalHead || 0;
  $("roundOverlay").classList.remove("hidden");
}
function closeRoundOverlay() {
  $("roundOverlay").classList.add("hidden");
}

function showWinnerSlide(winner, match) {
  if (!winner) return;
  const side = winner === "RED" ? match.red : match.blue;
  const name = side.playerName || side.name;
  $("winnerNameText").textContent = name;
  $("winnerReasonText").textContent = winnerReasonDescription(match.matchReason);
  $("winnerSlide").classList.remove("redWinner", "blueWinner", "hidden");
  $("winnerSlide").classList.add(winner === "RED" ? "redWinner" : "blueWinner");
}
function startNewMatch() {
  send({ type: "host", action: "newMatch" });
  $("winnerSlide").classList.add("hidden");
  $("roundOverlay").classList.add("hidden");
  closeMatchDecision();
}

function openTestMode() {
  closeSettings();
  resetTestUi();
  showScreen("testMode");
  send({ type: "host", action: "testStart" });
}
function closeTestMode() {
  send({ type: "host", action: "testStop" });
  showScreen("host");
}
function changeRemoteMode(value) {
  send({ type: "host", action: "setRemoteMode", count: Number(value) });
}
function renderRemoteMode(count) {
  const activeCount = Math.min(4, Math.max(1, Number(count) || 4));
  const select = $("remoteMode");
  if (select) select.value = String(activeCount);
  for (let corner = 1; corner <= 4; corner += 1) {
    const card = $(`joy${corner}`);
    if (card) card.classList.toggle("hidden", corner > activeCount);
  }
}
function renderCornerRefereeIndicators(count) {
  for (const player of ["RED", "BLUE"]) {
    const revision = Number.isSafeInteger(remoteScoreRevisions?.[player])
      ? remoteScoreRevisions[player]
      : 0;
    if (displayedRemoteScoreRevisions[player] === revision) continue;
    displayedRemoteScoreRevisions[player] = revision;
    if (remoteScoreTransitionTimers[player]) clearTimeout(remoteScoreTransitionTimers[player]);
    remoteScoreTransitionTimers[player] = null;
    displayedRemoteScoreHighlights[player] = [];
    displayedRemoteScoreValues[player] = null;
    const hasAward = Array.isArray(remoteScoreHighlights?.[player]) &&
      remoteScoreHighlights[player].length > 0 &&
      remoteScoreValues?.[player] !== null &&
      remoteScoreValues?.[player] !== undefined;
    if (hasAward) {
      remoteScoreTransitionTimers[player] = setTimeout(() => {
        if (displayedRemoteScoreRevisions[player] !== revision) return;
        displayedRemoteScoreHighlights[player] = Array.isArray(remoteScoreHighlights?.[player])
          ? [...remoteScoreHighlights[player]]
          : [];
        displayedRemoteScoreValues[player] = remoteScoreValues?.[player] ?? null;
        remoteScoreTransitionTimers[player] = null;
        renderCornerRefereeIndicators(count);
      }, REMOTE_SCORE_TRANSITION_MS);
    }
  }
  const activeCount = Math.min(4, Math.max(1, Number(count) || 4));
  for (const player of ["RED", "BLUE"]) {
    const activeCorners = Array.isArray(displayedRemoteScoreHighlights?.[player])
      ? displayedRemoteScoreHighlights[player]
      : [];
    for (let corner = 1; corner <= 4; corner += 1) {
      const slot = $(`${player.toLowerCase()}CornerRefereeSlot${corner}`);
      const score = $(`${player.toLowerCase()}CornerScore${corner}`);
      if (!slot) continue;
      slot.classList.toggle("hidden", corner > activeCount);
      if (score) {
        const awarded = activeCorners.includes(corner) && displayedRemoteScoreValues?.[player] !== null;
        score.classList.toggle("active", awarded);
        score.textContent = awarded
          ? `+${displayedRemoteScoreValues[player]}`
          : "";
      }
    }
  }
}
function showRemoteDisconnectPopup(corner) {
  const popup = $("remoteDisconnectPopup");
  if (!popup) return;
  popup.textContent = `REMOTE ${corner} DISCONNECTED`;
  popup.classList.add("show");
  if (remoteDisconnectPopupTimer) clearTimeout(remoteDisconnectPopupTimer);
  remoteDisconnectPopupTimer = setTimeout(() => {
    popup.classList.remove("show");
    remoteDisconnectPopupTimer = null;
  }, 2000);
}

function renderRemoteStatuses(remotes, activeRemoteCount = lastState?.remoteCount) {
  const statuses = Array.isArray(remotes) ? remotes : [];
  const activeCount = Math.min(4, Math.max(1, Number(activeRemoteCount) || 4));
  const previousStatuses = remoteStatusSnapshot;
  const nextStatuses = new Map();
  for (let corner = 1; corner <= 4; corner += 1) {
    const info = $(`remoteInfo${corner}`);
    const status = statuses.find((item) => Number(item.corner) === corner);
    const connected = status?.connected === true;
    if (previousStatuses?.get(corner) === true && !connected && corner <= activeCount) {
      showRemoteDisconnectPopup(corner);
    }
    nextStatuses.set(corner, connected);
    if (!info) continue;
    const rssi = Number.isInteger(status?.rssi) ? `${status.rssi} dBm` : "—";
    const battery = Number.isFinite(status?.battery)
      ? `${status.battery}%`
      : "—";
    info.textContent = `${connected ? "CONNECTED" : "DISCONNECTED"} · RSSI ${rssi} · BATTERY ${battery}`;
    info.classList.toggle("connected", connected);
    info.classList.toggle("disconnected", !connected);
  }
  remoteStatusSnapshot = nextStatuses;
}
function resetTestUi() {
  for (let i = 1; i <= 4; i++) {
    const joy = $(`joy${i}`);
    if (!joy) continue;
    joy.classList.remove("passed");
    joy
      .querySelectorAll("i")
      .forEach((el) => el.classList.remove("litRed", "litBlue"));
  }
}
function markTest(corner, player, points, button = "") {
  const joy = $(`joy${corner}`);
  if (!joy) return;
  const buttonId = button || `${player}_${points}`;
  const item = joy.querySelector(`[data-key="${buttonId.replace("_", "-")}"]`);
  if (item) item.classList.add(player === "RED" ? "litRed" : "litBlue");
  const all = [
    "RED-1",
    "RED-2",
    "RED-3",
    "RED-TECHNICAL",
    "BLUE-1",
    "BLUE-2",
    "BLUE-3",
    "BLUE-TECHNICAL",
  ];
  const done = all.every((key) => {
    const el = joy.querySelector(`[data-key="${key}"]`);
    return (
      el &&
      (el.classList.contains("litRed") || el.classList.contains("litBlue"))
    );
  });
  if (done) joy.classList.add("passed");
}

function audio() {
  if (!audioCtx)
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
}
function beep(freq, dur, type = "sine", gain = 0.15) {
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
  if (points === 1) beep(620, 0.13, "square");
  if (points === 2) beep(800, 0.18, "square");
  if (points === 3) beep(980, 0.24, "square");
}
function playWhistle() {
  beep(1500, 0.65, "square", 0.11);
  setTimeout(() => beep(1750, 0.65, "square", 0.11), 650);
  setTimeout(() => beep(1500, 0.65, "square", 0.11), 1300);
}

function escapeHtml(text) {
  return String(text).replace(
    /[&<>"']/g,
    (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        ch
      ],
  );
}

window.openHost = openHost;
window.nameChange = nameChange;
window.playPause = playPause;
window.resetRoundTimer = resetRoundTimer;
window.startKyeShi = startKyeShi;
window.toggleKyeShi = toggleKyeShi;
window.endKyeShi = endKyeShi;
window.declareWinner = declareWinner;
window.startGoldenRound = startGoldenRound;
window.showWooSeGirokChoices = showWooSeGirokChoices;
window.backFromTieDecision = backFromTieDecision;
window.showTieMethods = showTieMethods;
window.decideTieWinner = decideTieWinner;
window.manualPoint = manualPoint;
window.manualConfiguredPoint = manualConfiguredPoint;
window.manualHeadPoint = manualHeadPoint;
window.manualGam = manualGam;
window.openCornerEditor = openCornerEditor;
window.closeCornerEditor = closeCornerEditor;
window.showCornerCorrectionMenu = showCornerCorrectionMenu;
window.openScoringCorrection = openScoringCorrection;
window.correctSelectedGamjeom = correctSelectedGamjeom;
window.openAdvancedCorrections = openAdvancedCorrections;
window.closeAdvancedCorrections = closeAdvancedCorrections;
window.renderAdvancedCorrectionCurrent = renderAdvancedCorrectionCurrent;
window.saveAdvancedScoreCorrection = saveAdvancedScoreCorrection;
window.openSettings = openSettings;
window.closeSettings = closeSettings;
window.resolveUserPermission = resolveUserPermission;
window.openMatchDecision = openMatchDecision;
window.closeMatchDecision = closeMatchDecision;
window.selectManualDecision = selectManualDecision;
window.submitManualDecision = submitManualDecision;
window.openArenaNumber = openArenaNumber;
window.closeArenaNumber = closeArenaNumber;
window.saveArenaNumber = saveArenaNumber;
window.openRules = openRules;
window.closeRules = closeRules;
window.openPowerAction = openPowerAction;
window.confirmPowerAction = confirmPowerAction;
window.cancelPowerAction = cancelPowerAction;
window.closePowerModal = closePowerModal;
window.openPlayerSettings = openPlayerSettings;
window.closePlayerSettings = closePlayerSettings;
window.openManualEntry = openManualEntry;
window.backFromManualEntry = backFromManualEntry;
window.openDataImport = openDataImport;
window.backFromDataImport = backFromDataImport;
window.openPracticeMode = openPracticeMode;
window.backFromPracticeMode = backFromPracticeMode;
window.announcePracticePlayers = announcePracticePlayers;
window.loadPracticeMatch = loadPracticeMatch;
window.loadManualCategorySelection = loadManualCategorySelection;
window.renderManualCategories = renderManualCategories;
window.renderManualWizard = renderManualWizard;
window.manualWizardNext = manualWizardNext;
window.manualWizardBack = manualWizardBack;
window.saveManualBout = saveManualBout;
window.swapManualPlayers = swapManualPlayers;
window.clearManualPlayers = clearManualPlayers;
window.nextManualBout = nextManualBout;
window.closeManualEntryToScoreboard = closeManualEntryToScoreboard;
window.editLoadedManualBout = editLoadedManualBout;
window.openManualCategoryDelete = openManualCategoryDelete;
window.closeManualCategoryDelete = closeManualCategoryDelete;
window.confirmManualCategoryDelete = confirmManualCategoryDelete;
window.openManualCategoryResults = openManualCategoryResults;
window.closeManualCategoryResults = closeManualCategoryResults;
window.renderManualCategoryReport = renderManualCategoryReport;
window.refreshManualRecords = refreshManualRecords;
window.saveManualPlacements = saveManualPlacements;
window.printManualCategory = printManualCategory;
window.manualPlacementChanged = manualPlacementChanged;
window.updateManualResultsPrintOptions = updateManualResultsPrintOptions;
window.toggleManualReportPreview = toggleManualReportPreview;
window.savePlayerSettings = savePlayerSettings;
window.announceManualPlayers = announceManualPlayers;
window.uploadPlayerSheet = uploadPlayerSheet;
window.downloadPlayerTemplate = downloadPlayerTemplate;
window.refreshUsbFiles = refreshUsbFiles;
window.refreshRulesFiles = refreshRulesFiles;
window.applyRulesFile = applyRulesFile;
window.loadDefaultRules = loadDefaultRules;
window.importUsbFile = importUsbFile;
window.savePlayerTemplateToUsb = savePlayerTemplateToUsb;
window.unmountUsb = unmountUsb;
window.openSchedule = openSchedule;
window.closeSchedule = closeSchedule;
window.downloadTournamentSchedule = downloadTournamentSchedule;
window.printSchedule = printSchedule;
window.announceScheduledBout = announceScheduledBout;
window.resolveScheduledTie = resolveScheduledTie;
window.loadScheduledBout = loadScheduledBout;
window.resetCurrentMatch = resetCurrentMatch;
window.openTimerEditor = openTimerEditor;
window.closeTimerEditor = closeTimerEditor;
window.saveTimer = saveTimer;
window.openHistory = openHistory;
window.closeHistory = closeHistory;
window.openCornerRefereeHistory = openCornerRefereeHistory;
window.closeCornerRefereeHistory = closeCornerRefereeHistory;
window.closeRoundOverlay = closeRoundOverlay;
window.startNewMatch = startNewMatch;
window.openTestMode = openTestMode;
window.closeTestMode = closeTestMode;
window.changeRemoteMode = changeRemoteMode;
