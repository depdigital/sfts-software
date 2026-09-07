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
      lastState = msg.match;
      lastRemoteButtons = Array.isArray(msg.remoteButtons)
        ? msg.remoteButtons
        : [];
      currentArenaNumber = String(msg.arenaNumber || "");
      lastTournament = msg.tournament || null;
      historyCache = msg.matchHistory || [];
      usbImportOnly = msg.usbImportOnly === true;
      activeRuleset = msg.ruleset || msg.match?.ruleset || activeRuleset;
      scoringRules = msg.scoringRules || scoringRules;
      renderUsbImportMode();
      renderState(msg.match);
      renderActiveRuleset(activeRuleset);
      renderScoringControls();
      renderRemoteStatuses(msg.remotes, msg.match?.remoteCount);
      renderTournament(msg.tournament);
      if (!$("scheduleModal").classList.contains("hidden"))
        renderSchedule(msg.tournament);
    }
    if (msg.type === "error") {
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
  $("redName").textContent = "HONG";
  $("blueName").textContent = "CHUNG";
  $("redMeta").textContent = playerMetaText(match.red);
  $("blueMeta").textContent = playerMetaText(match.blue);
  $("redScore").textContent = match.red.score;
  $("blueScore").textContent = match.blue.score;
  $("redGam").textContent = match.red.gamjeom;
  $("blueGam").textContent = match.blue.gamjeom;
  $("matchNo").textContent = String(match.matchNo).padStart(3, "0");
  $("arenaNo").textContent = currentArenaNumber || "—";
  $("timer").textContent = formatTime(match.timerMs, match.phase === "ROUND");
  $("roundText").textContent =
    match.phase === "MATCH_END" ? "MATCH END" : `ROUND ${match.round}`;
  $("playBtn").textContent = match.running ? "❚❚ PAUSE" : "▶ PLAY";
  renderKyeShi(match.kyeShi, match);
  renderKyeShiWinnerButtons(match);
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

function playerMetaText(player) {
  const name = String(player.playerName || "").trim() || "PLAYER NAME —";
  const weight = String(player.weightCategory || "").trim() || "WEIGHT —";
  const stateCode = String(player.stateCode || "").trim() || "STATE —";
  const district = String(player.district || "").trim() || "DISTRICT —";
  return `${name} · ${weight} · ${stateCode} · ${district}`;
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
function toggleKyeShi() {
  if (!lastState?.kyeShi) return;
  if (lastState.kyeShi.running) {
    if (confirm("Suspend the Kye-shi timer?"))
      send({ type: "host", action: "pauseKyeShi" });
  } else {
    send({ type: "host", action: "resumeKyeShi" });
  }
}
function endKyeShi() {
  if (confirm("End Kye-shi and resume the match timer?"))
    send({ type: "host", action: "endKyeShi" });
}
function declareWinner(player) {
  const name = player === "RED" ? "HONG" : "CHUNG";
  if (confirm(`Declare ${name} the winner of the entire match?`)) {
    send({ type: "host", action: "declareKyeShiWinner", player });
  }
}
function manualPoint(player, points) {
  send({ type: "host", action: "point", player, points });
}
function manualConfiguredPoint(player, buttonId) {
  const button = $(buttonId);
  const points = Number(button?.dataset.scorePoint);
  if (!Number.isInteger(points) || !scoringRules?.basePointValues?.includes(points)) {
    toast("SCORING OPTION NOT AVAILABLE IN ACTIVE RULES");
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

function editScore(player) {
  if (!lastState) return;
  const current = player === "RED" ? lastState.red.score : lastState.blue.score;
  const value = prompt(`Set ${player} score`, current);
  if (value !== null)
    send({ type: "host", action: "editScore", player, value: Number(value) });
}
function editGam(player) {
  if (!lastState) return;
  const current =
    player === "RED" ? lastState.red.gamjeom : lastState.blue.gamjeom;
  const value = prompt(`Set ${player} gam-jeom`, current);
  if (value !== null)
    send({ type: "host", action: "editGamjeom", player, value: Number(value) });
}

function openSettings() {
  $("settingsModal").classList.remove("hidden");
}
function closeSettings() {
  $("settingsModal").classList.add("hidden");
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
  if (!lastState) return;
  $("playerRedName").value = lastState.red.playerName || "";
  $("playerRedWeight").value = lastState.red.weightCategory || "";
  $("playerRedDistrict").value = lastState.red.district || "";
  $("playerRedStateCode").value = lastState.red.stateCode || "";
  $("playerBlueName").value = lastState.blue.playerName || "";
  $("playerBlueWeight").value = lastState.blue.weightCategory || "";
  $("playerBlueDistrict").value = lastState.blue.district || "";
  $("playerBlueStateCode").value = lastState.blue.stateCode || "";
  renderTournament(lastTournament);
  renderUsbImportMode();
  $("playerSettingsModal").classList.remove("hidden");
  if (usbImportOnly) void refreshUsbFiles();
}
function closePlayerSettings() {
  $("playerSettingsModal").classList.add("hidden");
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
  if (!window.confirm("Apply this ruleset? The current match must be finished or reset first.")) return;
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
  if (!window.confirm("Load the default rules? The current match must be finished or reset first.")) return;
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
  if (!window.confirm("Unmount the USB drive safely before removing it?")) return;
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
  renderSchedule(lastTournament);
  $("scheduleModal").classList.remove("hidden");
}

function closeSchedule() {
  $("scheduleModal").classList.add("hidden");
}

function renderSchedule(tournament) {
  const summary = $("scheduleSummary");
  const table = $("scheduleTable");
  if (!summary || !table) return;
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
  summary.textContent = `${tournament.players.length} players · ${groups.length} groups · ${(tournament.schedule || []).length} bouts · ${byeCount} bye allocation(s) · seed ${tournament.seed}`;
  const entries = [
    ...(tournament.schedule || []),
    ...(tournament.byes || []).map((bye) => ({
      boutNo: "—",
      groupId: bye.groupId,
      gender: bye.gender,
      weightCategory: bye.weightCategory,
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
    <thead><tr><th>BOUT</th><th>GROUP</th><th>GENDER</th><th>WEIGHT</th><th>ROUND</th><th>RED</th><th>BLUE</th><th>WINNER</th><th>STATUS</th><th>ACTIONS</th></tr></thead>
    <tbody>${entries
      .map((bout) => {
        const canLoad =
          !bout.isBye &&
          (bout.status === "SCHEDULED" || bout.status === "IN_PROGRESS");
        const canAnnounce =
          !bout.isBye &&
          (bout.status === "SCHEDULED" || bout.status === "IN_PROGRESS");
        return `<tr class="${bout.status === "COMPLETED" ? "completed" : bout.status === "IN_PROGRESS" ? "inProgress" : ""}">
        <td>${bout.boutNo}</td><td>${escapeHtml(bout.groupId)}</td><td>${escapeHtml(bout.gender)}</td>
        <td>${escapeHtml(bout.weightCategory)}</td><td>${bout.round}</td>
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

function resolveScheduledTie(boutNo, winner) {
  if (!confirm(`Resolve this tied bout in favor of ${winner}?`)) return;
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
function resetCurrentMatch() {
  if (confirm("Reset the current match?"))
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
        <div>${item.rounds.length} round(s)</div>
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

function showRoundSummary(record) {
  currentRoundRecord = record;
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
  $("winnerSlide").classList.remove("redWinner", "blueWinner", "hidden");
  $("winnerSlide").classList.add(winner === "RED" ? "redWinner" : "blueWinner");
}
function startNewMatch() {
  send({ type: "host", action: "newMatch" });
  $("winnerSlide").classList.add("hidden");
  $("roundOverlay").classList.add("hidden");
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
window.manualPoint = manualPoint;
window.manualConfiguredPoint = manualConfiguredPoint;
window.manualHeadPoint = manualHeadPoint;
window.manualGam = manualGam;
window.editScore = editScore;
window.editGam = editGam;
window.openSettings = openSettings;
window.closeSettings = closeSettings;
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
window.closeRoundOverlay = closeRoundOverlay;
window.startNewMatch = startNewMatch;
window.openTestMode = openTestMode;
window.closeTestMode = closeTestMode;
window.changeRemoteMode = changeRemoteMode;
