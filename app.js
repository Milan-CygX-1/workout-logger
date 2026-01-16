/**
 * Workout Logger (Local / IndexedDB)
 * Features:
 * - Logging page: date + workout dropdown, per-exercise reps-by-set grid, live auto sets-done calc
 * - Config page: editable plan + reorder without editing numbers (↑/↓ on mobile + drag handle on desktop)
 * - History page: all saved sessions
 * - Export/Import JSON (config + sessions)
 */

const DB_NAME = "workout_logger_db";
const DB_VERSION = 2;
const STORE_CONFIG = "config";
const STORE_SESSIONS = "sessions";
const STORE_SETTINGS = "settings";
const BACKUP_KEY = "workout_logger_backup_v1";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

let db;
let configRows = [];
let workoutTypes = [];
const exerciseTimers = new Map();
const restTimerState = { totalElapsedMs: 0, active: null };
let timerTickId = null;

const SETTINGS_KEY = "app_settings";
const DEFAULT_SETTINGS = {
  restCompletionDurationSec: 2,
  restCompletionMode: "both"
};
let appSettings = { ...DEFAULT_SETTINGS };
let restAudioContext = null;
let restBannerTimeoutId = null;

/* ----------------- Defaults (preloaded config) ----------------- */

const DEFAULT_CONFIG = [
  // Workout 1 – Full Body
  { exercise:"Pull-up", workout:"Workout 1 – Full Body", sets:5, repLow:2, repHigh:2, restMin:5 },
  { exercise:"Lunge", workout:"Workout 1 – Full Body", sets:2, repLow:null, repHigh:null, restMin:5 },
  { exercise:"Push-up", workout:"Workout 1 – Full Body", sets:3, repLow:12, repHigh:15, restMin:5 },
  { exercise:"Glute Bridge", workout:"Workout 1 – Full Body", sets:3, repLow:6, repHigh:20, restMin:5 },
  { exercise:"TRX Lateral Raise", workout:"Workout 1 – Full Body", sets:3, repLow:15, repHigh:20, restMin:3 },
  { exercise:"Calf Raise", workout:"Workout 1 – Full Body", sets:2, repLow:6, repHigh:30, restMin:3 },
  { exercise:"TRX Crunch", workout:"Workout 1 – Full Body", sets:2, repLow:null, repHigh:null, restMin:3 },

  // Workout 2 – Upper Body
  { exercise:"Pull-up", workout:"Workout 2 – Upper Body", sets:5, repLow:2, repHigh:2, restMin:5 },
  { exercise:"Push-up", workout:"Workout 2 – Upper Body", sets:3, repLow:12, repHigh:15, restMin:5 },
  { exercise:"TRX Row", workout:"Workout 2 – Upper Body", sets:3, repLow:12, repHigh:15, restMin:5 },
  { exercise:"TRX Bicep Curl", workout:"Workout 2 – Upper Body", sets:3, repLow:15, repHigh:20, restMin:3 },
  { exercise:"TRX Triceps Extension", workout:"Workout 2 – Upper Body", sets:3, repLow:15, repHigh:20, restMin:3 },
  { exercise:"TRX Lateral Raise", workout:"Workout 2 – Upper Body", sets:3, repLow:15, repHigh:20, restMin:3 },

  // Workout 3 – Lower Body
  { exercise:"Lunge", workout:"Workout 3 – Lower Body", sets:2, repLow:null, repHigh:null, restMin:5 },
  { exercise:"Glute Bridge", workout:"Workout 3 – Lower Body", sets:3, repLow:6, repHigh:20, restMin:5 },
  { exercise:"Calf Raise", workout:"Workout 3 – Lower Body", sets:2, repLow:6, repHigh:30, restMin:3 },
  { exercise:"TRX Crunch", workout:"Workout 3 – Lower Body", sets:2, repLow:null, repHigh:null, restMin:3 },
];

/* ----------------- Utils ----------------- */

function uid(){
  return crypto.randomUUID ? crypto.randomUUID() : (Date.now()+"-"+Math.random().toString(16).slice(2));
}
function todayISO(){
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,"0");
  const day = String(d.getDate()).padStart(2,"0");
  return `${y}-${m}-${day}`;
}
function formatDateTimeForFilename(date = new Date()){
  const y = date.getFullYear();
  const m = String(date.getMonth()+1).padStart(2,"0");
  const day = String(date.getDate()).padStart(2,"0");
  const h = String(date.getHours()).padStart(2,"0");
  const min = String(date.getMinutes()).padStart(2,"0");
  const s = String(date.getSeconds()).padStart(2,"0");
  return `${y}-${m}-${day}_${h}${min}${s}`;
}
function escapeHtml(s){
  if(s===null || s===undefined) return "";
  return String(s)
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}
function toast(msg, kind="info"){
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  t.style.borderColor =
    kind==="ok" ? "rgba(52,211,153,.7)" :
    kind==="danger" ? "rgba(251,113,133,.7)" :
    kind==="warn" ? "rgba(251,191,36,.7)" :
    "rgba(56,189,248,.7)";
  setTimeout(()=> t.classList.remove("show"), 2200);
}
function debounce(fn, ms){
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(()=>fn(...args), ms); };
}
function updateTopbarOffset(){
  const topbar = document.querySelector(".topbar");
  if(!topbar) return;
  const height = Math.ceil(topbar.getBoundingClientRect().height);
  document.documentElement.style.setProperty("--topbar-height", `${height}px`);
}
function wireTopbarOffset(){
  const topbar = document.querySelector(".topbar");
  if(!topbar) return;
  updateTopbarOffset();
  if("ResizeObserver" in window){
    const observer = new ResizeObserver(() => updateTopbarOffset());
    observer.observe(topbar);
    return;
  }
  window.addEventListener("resize", debounce(updateTopbarOffset, 120));
}
function uniqueWorkouts(rows){
  return Array.from(new Set(rows.map(r => (r.workout||"").trim()).filter(Boolean))).sort();
}
function computeTarget(row){
  const low = row.repLow ?? "";
  const high = row.repHigh ?? "";
  const effectiveHigh = high === "" ? low : high;
  if(low !== "" && effectiveHigh !== "" && low !== effectiveHigh) return `${row.sets} × ${low}–${effectiveHigh}`;
  if(low !== "" && effectiveHigh !== "" && low === effectiveHigh) return `${row.sets} × ${low}`;
  return `${row.sets} sets`;
}
function formatDuration(ms){
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if(hours > 0){
    return `${hours}:${String(minutes).padStart(2,"0")}:${String(seconds).padStart(2,"0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2,"0")}`;
}
function getExerciseTimerState(exerciseId){
  if(!exerciseTimers.has(exerciseId)){
    exerciseTimers.set(exerciseId, { elapsedMs: 0, running: false, startedAt: null });
  }
  return exerciseTimers.get(exerciseId);
}
function getExerciseElapsedMs(state){
  if(!state) return 0;
  const active = state.running && state.startedAt ? (Date.now() - state.startedAt) : 0;
  return state.elapsedMs + active;
}
function getTotalExerciseElapsedMs(){
  let total = 0;
  exerciseTimers.forEach(state => { total += getExerciseElapsedMs(state); });
  return total;
}
function getTotalRestElapsedMs(){
  const active = restTimerState.active;
  if(!active) return restTimerState.totalElapsedMs;
  const elapsed = Math.min(Date.now() - active.startedAt, active.durationMs);
  return restTimerState.totalElapsedMs + elapsed;
}
function ensureRestAudioContext(){
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if(!AudioContext) return null;
  if(restAudioContext && restAudioContext.state !== "closed"){
    if(restAudioContext.state === "suspended"){
      restAudioContext.resume().catch((err) => {
        console.warn("Audio context resume failed", err);
      });
    }
    return restAudioContext;
  }
  restAudioContext = new AudioContext();
  if(restAudioContext.state === "suspended"){
    restAudioContext.resume().catch((err) => {
      console.warn("Audio context resume failed", err);
    });
  }
  return restAudioContext;
}

function playRestAlarm(durationMs){
  try{
    const audioCtx = ensureRestAudioContext();
    if(!audioCtx) throw new Error("AudioContext not supported");
    const oscillator = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = 880;
    gain.gain.value = 0.0001;
    oscillator.connect(gain);
    gain.connect(audioCtx.destination);
    oscillator.start();
    gain.gain.exponentialRampToValueAtTime(0.2, audioCtx.currentTime + 0.02);
    const durationSec = Math.max(0.2, durationMs / 1000);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + durationSec);
    oscillator.stop(audioCtx.currentTime + durationSec);
    oscillator.onended = () => audioCtx.close();
  }catch(err){
    console.warn("Audio alarm unavailable", err);
  }
}

function triggerRestCompletionNotification(){
  const durationSec = Number(appSettings.restCompletionDurationSec || 0);
  if(!Number.isFinite(durationSec) || durationSec <= 0) return;
  const durationMs = durationSec * 1000;
  const mode = appSettings.restCompletionMode;
  if(mode === "sound" || mode === "both"){
    playRestAlarm(durationMs);
  }
  if(mode === "vibrate" || mode === "both"){
    if("vibrate" in navigator){
      navigator.vibrate(durationMs);
    } else {
      console.warn("Vibration not supported on this device.");
    }
  }
  if(mode === "banner"){
    showRestCompletionBanner(durationMs);
  }
}

function showRestCompletionBanner(durationMs){
  const banner = $("#restCompletionBanner");
  if(!banner) return;
  if(restBannerTimeoutId) clearTimeout(restBannerTimeoutId);
  banner.classList.add("show","flash");
  const displayMs = Math.max(400, durationMs);
  restBannerTimeoutId = setTimeout(() => {
    banner.classList.remove("show","flash");
  }, displayMs);
}

/* ----------------- IndexedDB helpers ----------------- */

function openDB(){
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if(!db.objectStoreNames.contains(STORE_CONFIG)){
        const s = db.createObjectStore(STORE_CONFIG, { keyPath:"id" });
        s.createIndex("workout","workout",{unique:false});
      }
      if(!db.objectStoreNames.contains(STORE_SESSIONS)){
        const s = db.createObjectStore(STORE_SESSIONS, { keyPath:"id" });
        s.createIndex("dateISO","dateISO",{unique:false});
        s.createIndex("workout","workout",{unique:false});
      }
      if(!db.objectStoreNames.contains(STORE_SETTINGS)){
        db.createObjectStore(STORE_SETTINGS, { keyPath:"id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function tx(store, mode="readonly"){ return db.transaction(store, mode).objectStore(store); }
function getAll(store){
  return new Promise((resolve,reject) => {
    const req = tx(store).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}
function getByKey(store, key){
  return new Promise((resolve, reject) => {
    const req = tx(store).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}
function put(store, value){
  return new Promise((resolve,reject) => {
    const req = tx(store,"readwrite").put(value);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}
function clearStore(store){
  return new Promise((resolve,reject) => {
    const req = tx(store,"readwrite").clear();
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}
function bulkPut(store, values){
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, "readwrite");
    const s = t.objectStore(store);
    values.forEach(v => s.put(v));
    t.oncomplete = () => resolve(true);
    t.onerror = () => reject(t.error);
  });
}
async function ensureDefaults(){
  const existing = await getAll(STORE_CONFIG);
  if(existing.length) return;
  const counters = new Map();
  const rows = DEFAULT_CONFIG.map(r => {
    const w = (r.workout||"").trim();
    const n = (counters.get(w)||0)+1; counters.set(w,n);
    return { id: uid(), ...r, workout:w, sortOrder:n };
  });
  await bulkPut(STORE_CONFIG, rows);
}

function normalizeSettings(raw){
  const normalized = { ...DEFAULT_SETTINGS };
  if(raw && typeof raw === "object"){
    const duration = Number(raw.restCompletionDurationSec);
    if(Number.isFinite(duration) && duration >= 0) normalized.restCompletionDurationSec = duration;
    const mode = String(raw.restCompletionMode || "").toLowerCase();
    if(["sound","vibrate","both","banner"].includes(mode)) normalized.restCompletionMode = mode;
  }
  return normalized;
}

async function ensureSettingsDefaults(){
  const existing = await getByKey(STORE_SETTINGS, SETTINGS_KEY);
  if(existing) return;
  await put(STORE_SETTINGS, { id: SETTINGS_KEY, ...DEFAULT_SETTINGS });
}

async function loadSettings(){
  const stored = await getByKey(STORE_SETTINGS, SETTINGS_KEY);
  const normalized = normalizeSettings(stored);
  if(!stored){
    await put(STORE_SETTINGS, { id: SETTINGS_KEY, ...normalized });
  } else if(
    stored.restCompletionDurationSec !== normalized.restCompletionDurationSec ||
    stored.restCompletionMode !== normalized.restCompletionMode
  ){
    await put(STORE_SETTINGS, { id: SETTINGS_KEY, ...normalized });
  }
  return normalized;
}

async function saveSettings(settings){
  const normalized = normalizeSettings(settings);
  await put(STORE_SETTINGS, { id: SETTINGS_KEY, ...normalized });
  return normalized;
}

/* ----------------- Ordering (Config -> Logging) ----------------- */

function rowsForWorkout(workout){
  return configRows
    .filter(r => r.workout === workout)
    .sort((a,b) => (a.sortOrder ?? 999999) - (b.sortOrder ?? 999999));
}

/* ----------------- Rendering: dropdowns + KPIs ----------------- */

function setDBStatus(text, kind){
  const el = $("#dbStatus");
  el.textContent = text;
  el.classList.remove("ok","warn","danger");
  el.classList.add(kind);
}
function renderWorkoutTypeDropdown(){
  const sel = $("#workoutType");
  sel.innerHTML = workoutTypes.map(w => `<option value="${escapeHtml(w)}">${escapeHtml(w)}</option>`).join("");
}
function renderHistoryWorkoutFilter(){
  const sel = $("#historyFilterWorkout");
  sel.innerHTML =
    `<option value="">All workouts</option>` +
    workoutTypes.map(w => `<option value="${escapeHtml(w)}">${escapeHtml(w)}</option>`).join("");
}

async function loadSessions(){
  const sessions = await getAll(STORE_SESSIONS);
  sessions.sort((a,b)=> (b.dateISO||"").localeCompare(a.dateISO||"") || (b.createdAt||"").localeCompare(a.createdAt||""));
  return sessions;
}
function renderKPIs(sessions){
  const el = $("#kpis");
  const total = sessions.length;
  const last = sessions[0];
  const lastDate = last ? last.dateISO : "—";
  const workouts = new Set(sessions.map(s=>s.workout).filter(Boolean)).size;

  let painSum=0, painN=0;
  for(const s of sessions){
    for(const it of (s.items||[])){
      const p = Number(it.pain0to5);
      if(!Number.isNaN(p)){ painSum += p; painN++; }
    }
  }
  const painAvg = painN ? (painSum/painN).toFixed(2) : "—";

  el.innerHTML = `
    <div class="card">
      <div class="k">Sessions logged</div>
      <div class="v">${total}</div>
      <div class="sub">Workouts used: ${workouts}</div>
    </div>
    <div class="card">
      <div class="k">Last session date</div>
      <div class="v">${escapeHtml(lastDate)}</div>
      <div class="sub">Auto backup runs after saves</div>
    </div>
    <div class="card">
      <div class="k">Avg pain (all exercises)</div>
      <div class="v">${escapeHtml(painAvg)}</div>
      <div class="sub">0 = none, 5 = stop-worthy</div>
    </div>
  `;
}
async function refreshKPIs(){
  const sessions = await loadSessions();
  renderKPIs(sessions);
}

/* ----------------- Logging UI ----------------- */

function startTimerTicker(){
  if(timerTickId) return;
  timerTickId = setInterval(updateTimerDisplays, 500);
}
function stopTimerTicker(){
  if(!timerTickId) return;
  clearInterval(timerTickId);
  timerTickId = null;
}
function stopOtherExerciseTimers(exerciseId){
  exerciseTimers.forEach((state, key) => {
    if(key === exerciseId) return;
    if(!state.running) return;
    state.elapsedMs += Date.now() - state.startedAt;
    state.running = false;
    state.startedAt = null;
  });
}
function startExerciseTimer(exerciseId){
  const state = getExerciseTimerState(exerciseId);
  if(state.running) return;
  stopOtherExerciseTimers(exerciseId);
  state.running = true;
  state.startedAt = Date.now();
  updateTimerDisplays();
  startTimerTicker();
}
function stopExerciseTimer(exerciseId){
  const state = getExerciseTimerState(exerciseId);
  if(!state.running) return;
  state.elapsedMs += Date.now() - state.startedAt;
  state.running = false;
  state.startedAt = null;
  updateTimerDisplays();
}
function resetExerciseTimer(exerciseId){
  const state = getExerciseTimerState(exerciseId);
  state.elapsedMs = 0;
  state.running = false;
  state.startedAt = null;
  updateTimerDisplays();
}
function stopActiveRestTimer(){
  const active = restTimerState.active;
  if(!active) return;
  clearTimeout(active.timeoutId);
  const elapsed = Math.min(Date.now() - active.startedAt, active.durationMs);
  restTimerState.totalElapsedMs += elapsed;
  restTimerState.active = null;
}
function finishRestTimer(){
  const active = restTimerState.active;
  if(!active) return;
  stopActiveRestTimer();
  triggerRestCompletionNotification();
  toast("Rest timer done", "ok");
}
function startRestTimer(exerciseId, durationMs){
  if(!exerciseId) return;
  if(!Number.isFinite(durationMs) || durationMs <= 0) return;
  ensureRestAudioContext();
  stopActiveRestTimer();
  restTimerState.active = {
    exerciseId,
    durationMs,
    startedAt: Date.now(),
    timeoutId: setTimeout(finishRestTimer, durationMs)
  };
  updateTimerDisplays();
  startTimerTicker();
}
function resetSessionTimers(){
  stopActiveRestTimer();
  restTimerState.totalElapsedMs = 0;
  exerciseTimers.clear();
  stopTimerTicker();
}
function updateTimerDisplays(){
  const cards = $$("#exerciseList .exercise-card");
  const totalExerciseMs = getTotalExerciseElapsedMs();
  const totalRestMs = getTotalRestElapsedMs();
  const totalMs = totalExerciseMs + totalRestMs;

  cards.forEach(card => {
    const exerciseId = card.getAttribute("data-exercise-id");
    const state = getExerciseTimerState(exerciseId);
    const timerEl = card.querySelector("[data-exercise-timer]");
    if(timerEl) timerEl.textContent = formatDuration(getExerciseElapsedMs(state));

    const startBtn = card.querySelector('[data-timer-action="start"]');
    const stopBtn = card.querySelector('[data-timer-action="stop"]');
    const resetBtn = card.querySelector('[data-timer-action="reset"]');
    if(startBtn) startBtn.disabled = state.running;
    if(stopBtn) stopBtn.disabled = !state.running;
    if(resetBtn) resetBtn.disabled = state.running || getExerciseElapsedMs(state) === 0;

    const restEl = card.querySelector("[data-rest-display]");
    if(restEl){
      const active = restTimerState.active;
      if(active && active.exerciseId === exerciseId){
        const remainingMs = Math.max(0, active.durationMs - (Date.now() - active.startedAt));
        restEl.textContent = formatDuration(remainingMs);
        restEl.classList.add("active");
      } else {
        restEl.textContent = "—";
        restEl.classList.remove("active");
      }
    }
  });

  $$("#exerciseList [data-total-time]").forEach(el => {
    el.textContent = `${formatDuration(totalMs)} total`;
  });

  const summary = $("#sessionSummary");
  if(summary){
    summary.innerHTML = `
      <div class="summary-main">Total session time: <strong>${formatDuration(totalMs)}</strong></div>
      <div class="summary-sub">Exercise time: ${formatDuration(totalExerciseMs)} · Rest time: ${formatDuration(totalRestMs)}</div>
    `;
  }
}

function renderExerciseList(){
  const workout = $("#workoutType").value;
  const list = $("#exerciseList");
  const rows = rowsForWorkout(workout);

  if(!rows.length){
    list.innerHTML = `<div class="muted">No exercises configured for this workout. Add them in Config.</div>`;
    resetSessionTimers();
    updateTimerDisplays();
    return;
  }

  list.innerHTML = rows.map((r, idx) => {
    const target = computeTarget(r);
    const defaultRest = (r.restMin ?? "");
    const setsPlanned = Math.max(1, Number(r.sets ?? 1));
    const exerciseId = `exercise-${idx + 1}`;

    const repCells = Array.from({length: setsPlanned}, (_, i) => {
      const setNo = i + 1;
      return `
        <div class="rep-cell">
          <div class="rep-label">Set ${setNo}</div>
          <input inputmode="numeric" pattern="[0-9]*" class="repInput" data-set="${setNo}" placeholder="—" />
        </div>
      `;
    }).join("");

    return `
      <div class="exercise-card"
        data-exercise-id="${exerciseId}"
        data-exercise="${escapeHtml(r.exercise)}"
        data-target="${escapeHtml(target)}"
        data-default-rest="${escapeHtml(defaultRest)}"
        data-sets-planned="${setsPlanned}">
        <div class="ex-top">
          <div>
            <div class="ex-name">${escapeHtml(r.exercise)}</div>
            <div class="muted small">Target: <b>${escapeHtml(target)}</b></div>
          </div>
          <div class="ex-meta">
            <span class="pill" data-total-time>0:00 total</span>
          </div>
        </div>

        <div>
          <label>Reps in set (grid)</label>
          <div class="reps-grid">${repCells}</div>
          <div class="sub">Track each set separately to see progression.</div>
        </div>

        <div class="timer-panel">
          <div>
            <label>Exercise timer</label>
            <div class="timer-controls">
              <span class="timer-display" data-exercise-timer>0:00</span>
              <div class="timer-buttons">
                <button class="btn small" type="button" data-timer-action="start">Start</button>
                <button class="btn small" type="button" data-timer-action="stop">Stop</button>
                <button class="btn small" type="button" data-timer-action="reset">Reset</button>
              </div>
            </div>
          </div>
          <div>
            <label>Rest countdown</label>
            <div class="rest-display" data-rest-display>—</div>
            <div class="sub">Starts after logging reps (except final set).</div>
          </div>
        </div>

        <div class="ex-grid">
          <div>
            <label>Rest (min)</label>
            <input inputmode="decimal" class="restMin" placeholder="${escapeHtml(defaultRest)}" />
          </div>

          <div>
            <label>Pain (0–5)</label>
            <select class="pain">
              ${[0,1,2,3,4,5].map(n => `<option value="${n}">${n}</option>`).join("")}
            </select>
          </div>
        </div>

        <div>
          <label>Sets done</label>
          <input inputmode="numeric" class="setsDone" placeholder="${setsPlanned}" />
          <div class="sub">Auto-calculates from reps unless you type here.</div>
        </div>

        <div>
          <label>Comment</label>
          <textarea class="itemComment" placeholder="Anything specific for this exercise?"></textarea>
        </div>
      </div>
    `;
  }).join("");

  resetSessionTimers();
  $$("#exerciseList .exercise-card").forEach(card => {
    const exerciseId = card.getAttribute("data-exercise-id");
    if(exerciseId) exerciseTimers.set(exerciseId, { elapsedMs: 0, running: false, startedAt: null });
  });
  updateTimerDisplays();
}

function clearLoggingInputs(){
  $("#sessionComment").value = "";
  $$("#exerciseList .exercise-card").forEach(c => {
    const sd = c.querySelector(".setsDone");
    sd.value = "";
    delete sd.dataset.manual;

    c.querySelectorAll(".repInput").forEach(i => i.value = "");
    c.querySelector(".restMin").value = "";
    c.querySelector(".pain").value = "0";
    c.querySelector(".itemComment").value = "";
    c.querySelectorAll(".repInput").forEach(i => delete i.dataset.filled);
  });
  resetSessionTimers();
  $$("#exerciseList .exercise-card").forEach(card => {
    const exerciseId = card.getAttribute("data-exercise-id");
    if(exerciseId) exerciseTimers.set(exerciseId, { elapsedMs: 0, running: false, startedAt: null });
  });
  updateTimerDisplays();
}

function readExerciseInputs(){
  const cards = $$("#exerciseList .exercise-card");
  const items = [];

  for(const c of cards){
    const exercise = c.getAttribute("data-exercise");
    const target = c.getAttribute("data-target");
    const defaultRest = c.getAttribute("data-default-rest");
    const setsPlanned = Number(c.getAttribute("data-sets-planned") || "1");
    const exerciseId = c.getAttribute("data-exercise-id");
    const timerState = exerciseId ? exerciseTimers.get(exerciseId) : null;
    const exerciseTimeMs = getExerciseElapsedMs(timerState);

    const reps = Array.from({length: setsPlanned}, (_, i) => {
      const setNo = i + 1;
      const inp = c.querySelector(`.repInput[data-set="${setNo}"]`);
      const v = (inp?.value ?? "").trim();
      if(v === "") return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    });

    const sdEl = c.querySelector(".setsDone");
    const setsDoneRaw = sdEl.value.trim();
    const inferred = reps.filter(x => x !== null).length;
    const setsDone = setsDoneRaw === "" ? (inferred || null) : Number(setsDoneRaw);

    const restMinRaw = c.querySelector(".restMin").value.trim() || defaultRest || "";
    const restMin = restMinRaw === "" ? null : Number(restMinRaw);

    const pain0to5 = Number(c.querySelector(".pain").value);
    const comment = c.querySelector(".itemComment").value.trim();

    items.push({
      exercise,
      target,
      setsPlanned,
      setsDone: Number.isFinite(setsDone) ? setsDone : null,
      repsBySet: reps,
      restMin: Number.isFinite(restMin) ? restMin : null,
      pain0to5: Number.isFinite(pain0to5) ? pain0to5 : 0,
      comment,
      timeMs: exerciseTimeMs > 0 ? exerciseTimeMs : null
    });
  }

  return items;
}

async function saveSession(){
  const dateISO = $("#logDate").value;
  const workout = $("#workoutType").value;
  const comment = $("#sessionComment").value.trim();

  if(!dateISO){ toast("Pick a date first", "warn"); $("#logDate").focus(); return; }
  if(!workout){ toast("Select a workout type", "warn"); $("#workoutType").focus(); return; }

  const items = readExerciseInputs();
  const meaningful = items.filter(it => {
    const anyRep = (it.repsBySet || []).some(x => x !== null);
    return anyRep || it.setsDone !== null || (it.comment && it.comment.length) || (it.restMin !== null) || (it.pain0to5 && it.pain0to5 > 0) || (it.timeMs && it.timeMs > 0);
  });
  if(!meaningful.length){ toast("Nothing entered yet (fill some reps/sets/comment)", "warn"); return; }

  const totalExerciseMs = getTotalExerciseElapsedMs();
  const totalRestMs = getTotalRestElapsedMs();
  const session = {
    id: uid(),
    dateISO,
    workout,
    comment,
    items,
    totalTimeMs: totalExerciseMs + totalRestMs,
    createdAt: new Date().toISOString()
  };

  await put(STORE_SESSIONS, session);
  await saveLocalBackup();
  toast("Session saved ✓", "ok");
  clearLoggingInputs();
  await refreshKPIs();
}

/* Live auto-calc Sets Done */
function wireLiveSetsDoneAutocalc(){
  const list = $("#exerciseList");

  list.addEventListener("input", (e) => {
    const rep = e.target.closest(".repInput");
    if(!rep) return;

    const card = e.target.closest(".exercise-card");
    if(!card) return;

    const setNo = Number(rep.getAttribute("data-set") || "0");
    const setsPlanned = Number(card.getAttribute("data-sets-planned") || "1");
    const wasFilled = rep.dataset.filled === "1";
    const isFilled = rep.value.trim() !== "";
    if(isFilled && !wasFilled && setNo < setsPlanned){
      const restInput = card.querySelector(".restMin");
      const restRaw = (restInput?.value ?? "").trim();
      const defaultRest = card.getAttribute("data-default-rest") || "";
      const restMin = restRaw !== "" ? Number(restRaw) : Number(defaultRest);
      if(Number.isFinite(restMin) && restMin > 0){
        const exerciseId = card.getAttribute("data-exercise-id");
        startRestTimer(exerciseId, restMin * 60 * 1000);
      }
    }
    rep.dataset.filled = isFilled ? "1" : "0";

    const setsDoneEl = card.querySelector(".setsDone");
    if(!setsDoneEl) return;

    if(setsDoneEl.dataset.manual === "1") return;

    const filled = Array.from(card.querySelectorAll(".repInput"))
      .filter(inp => inp.value.trim() !== "").length;

    setsDoneEl.value = filled > 0 ? String(filled) : "";
  });

  list.addEventListener("input", (e) => {
    const sd = e.target.closest(".setsDone");
    if(!sd) return;

    if(sd.value.trim() !== "") sd.dataset.manual = "1";
    else delete sd.dataset.manual;
  });
}

/* ----------------- History UI ----------------- */

function repsArrayToString(repsBySet){
  if(!Array.isArray(repsBySet)) return "";
  return repsBySet.map(v => v===null ? "—" : String(v)).join("/");
}

function sessionCardHTML(s){
  const date = s.dateISO || "";
  const workout = s.workout || "";
  const sessionComment = s.comment || "";

  const items = (s.items||[]).filter(it => it.exercise);
  const totalTimeMs = Number(s.totalTimeMs);
  const totalTimeLabel = Number.isFinite(totalTimeMs) && totalTimeMs > 0
    ? formatDuration(totalTimeMs)
    : "—";

  const rows = items.map(it => {
    const repsStr = repsArrayToString(it.repsBySet);
    const setsDone = it.setsDone ?? "—";
    const rest = it.restMin ?? "—";
    const pain = it.pain0to5 ?? 0;
    const timeMs = Number(it.timeMs);
    const timeLabel = Number.isFinite(timeMs) && timeMs > 0 ? formatDuration(timeMs) : "—";
    const cmt = it.comment ? ` · <span class="muted">${escapeHtml(it.comment)}</span>` : "";
    return `<li style="margin:6px 0; line-height:1.4">
      <b>${escapeHtml(it.exercise)}</b>
      <span class="muted small">(${escapeHtml(it.target||"")})</span><br/>
      <span class="muted small">
        Sets done: <b>${escapeHtml(setsDone)}</b> · Reps: <b>${escapeHtml(repsStr || "—")}</b>
        · Rest: <b>${escapeHtml(rest)}</b> · Pain: <b>${escapeHtml(pain)}</b> · Time: <b>${escapeHtml(timeLabel)}</b>${cmt}
      </span>
    </li>`;
  }).join("");

  return `
    <div class="exercise-card">
      <div class="ex-top">
        <div>
          <div class="ex-name">${escapeHtml(date)} · ${escapeHtml(workout)}</div>
          <div class="muted small">${escapeHtml(sessionComment)}</div>
        </div>
        <div class="ex-meta">
          <span class="pill">Total time: ${totalTimeLabel}</span>
          <button class="btn danger small" data-del="${escapeHtml(s.id)}">Delete</button>
        </div>
      </div>
      <div class="divider"></div>
      <ul style="margin:0; padding-left:18px">${rows || `<li class="muted">No items recorded</li>`}</ul>
    </div>
  `;
}

function deleteSession(id){
  return new Promise((resolve,reject) => {
    const req = tx(STORE_SESSIONS,"readwrite").delete(id);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}

async function renderHistory(){
  const filterWorkout = $("#historyFilterWorkout").value;
  const q = $("#historySearch").value.trim().toLowerCase();

  let sessions = await loadSessions();
  if(filterWorkout) sessions = sessions.filter(s => s.workout === filterWorkout);
  if(q){
    sessions = sessions.filter(s => {
      if((s.comment||"").toLowerCase().includes(q)) return true;
      return (s.items||[]).some(it =>
        (it.exercise||"").toLowerCase().includes(q) ||
        (it.comment||"").toLowerCase().includes(q)
      );
    });
  }

  const list = $("#historyList");
  if(!sessions.length){ list.innerHTML = `<div class="muted">No sessions yet.</div>`; return; }

  list.innerHTML = sessions.map(s => sessionCardHTML(s)).join("");

  $$("#historyList button[data-del]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-del");
      if(!confirm("Delete this session?")) return;
      await deleteSession(id);
      await saveLocalBackup();
      toast("Deleted", "ok");
      await renderHistory();
      await refreshKPIs();
    });
  });
}

async function deleteAllSessions(){
  if(!confirm("Delete ALL sessions? This cannot be undone.")) return;
  await clearStore(STORE_SESSIONS);
  await saveLocalBackup();
  toast("All sessions deleted", "ok");
  await renderHistory();
  await refreshKPIs();
}

/* ----------------- Config UI + Reordering ----------------- */

function configRowHTML(r){
  return `
    <tr data-id="${escapeHtml(r.id)}" data-workout="${escapeHtml(r.workout ?? "")}">
      <td class="w-move">
        <div class="movebox">
          <span class="handle" title="Drag to reorder (desktop)">≡</span>
          <div class="updown">
            <button class="btn small moveUp" type="button" title="Move up">↑</button>
            <button class="btn small moveDown" type="button" title="Move down">↓</button>
          </div>
        </div>
      </td>

      <td><input value="${escapeHtml(r.exercise ?? "")}" data-field="exercise" /></td>
      <td class="w-num"><input inputmode="numeric" value="${escapeHtml(r.sets ?? "")}" data-field="sets" /></td>
      <td class="w-num"><input inputmode="numeric" value="${escapeHtml(r.repLow ?? "")}" data-field="repLow" /></td>
      <td class="w-num"><input inputmode="numeric" value="${escapeHtml(r.repHigh ?? "")}" data-field="repHigh" /></td>
      <td class="w-num"><input inputmode="decimal" value="${escapeHtml(r.restMin ?? "")}" data-field="restMin" /></td>
      <td class="w-actions"><button class="btn danger small deleteRowBtn" type="button">Delete</button></td>
    </tr>
  `;
}

function renderConfigTable(){
  const tbody = $("#configTable tbody");

  const byWorkout = new Map();
  const workoutOrder = new Map();
  let nextOrder = 1;
  for(const r of configRows){
    const w = (r.workout||"").trim();
    if(!byWorkout.has(w)) byWorkout.set(w, []);
    byWorkout.get(w).push(r);
    if(!workoutOrder.has(w)){
      const orderValue = Number.isFinite(r.workoutOrder) ? r.workoutOrder : nextOrder;
      workoutOrder.set(w, orderValue);
      nextOrder = Math.max(nextOrder, orderValue + 1);
    }
  }

  const workoutList = Array.from(byWorkout.keys())
    .sort((a,b) => (workoutOrder.get(a) ?? 0) - (workoutOrder.get(b) ?? 0));
  const htmlParts = [];

  for(const w of workoutList){
    const arr = byWorkout.get(w)
      .slice()
      .sort((a,b)=> (a.sortOrder ?? 999999) - (b.sortOrder ?? 999999));

    htmlParts.push(`
      <tr class="workout-header" data-workout-header="${escapeHtml(w)}">
        <td colspan="7" style="background: rgba(3,7,18,.55); font-weight:1000; color: var(--text);">
          <div class="workout-header-row">
            <div class="movebox">
              <span class="handle workout-handle" title="Drag to reorder workouts">≡</span>
              <div class="updown">
                <button class="btn small moveWorkoutUp" type="button" title="Move workout up">↑</button>
                <button class="btn small moveWorkoutDown" type="button" title="Move workout down">↓</button>
              </div>
            </div>
            <span class="workout-header-label">Workout</span>
            <input
              class="workout-name-input"
              data-workout-name
              value="${escapeHtml(w)}"
              placeholder="Workout name"
            />
            <span class="muted" style="font-weight:800;">(reorder within this workout)</span>
            <button class="btn danger small deleteWorkoutBtn" type="button">Delete workout</button>
          </div>
        </td>
      </tr>
    `);

    htmlParts.push(arr.map(r => configRowHTML(r)).join(""));
  }

  tbody.innerHTML = htmlParts.join("");
}

function readConfigFromTable(){
  const trs = Array.from($("#configTable tbody").querySelectorAll("tr"));
  const out = [];
  const counters = new Map();
  let workoutIndex = 0;
  let currentWorkoutOrder = 0;
  let currentWorkout = "";

  for(const tr of trs){
    if(tr.hasAttribute("data-workout-header")){
      const headerInput = tr.querySelector("input[data-workout-name]");
      const headerValue = (headerInput?.value || tr.getAttribute("data-workout-header") || "").trim();
      currentWorkout = headerValue || "Workout";
      workoutIndex += 1;
      currentWorkoutOrder = workoutIndex;
      continue;
    }

    const id = tr.getAttribute("data-id") || uid();
    const obj = { id };

    tr.querySelectorAll("input, select").forEach(el => {
      const field = el.getAttribute("data-field");
      if(!field) return;

      let val = el.value;
      if(["sets","repLow","repHigh","restMin"].includes(field)){
        val = val.trim()==="" ? null : Number(val);
      } else {
        val = val.trim();
      }
      obj[field] = val;
    });

    if(!obj.exercise) continue;
    if(!obj.workout) obj.workout = currentWorkout || "Workout 1 – Full Body";
    const w = obj.workout;
    const n = (counters.get(w) || 0) + 1;
    counters.set(w, n);
    obj.sortOrder = n;
    obj.workoutOrder = currentWorkoutOrder;

    out.push(obj);
  }
  return out;
}

function renderSettingsForm(){
  const durationInput = $("#restCompletionDuration");
  const modeSelect = $("#restCompletionMode");
  if(durationInput) durationInput.value = String(appSettings.restCompletionDurationSec ?? 0);
  if(modeSelect) modeSelect.value = appSettings.restCompletionMode || "both";
}

function readSettingsFromForm(){
  const durationInput = $("#restCompletionDuration");
  const modeSelect = $("#restCompletionMode");
  const duration = durationInput ? Number(durationInput.value) : DEFAULT_SETTINGS.restCompletionDurationSec;
  const mode = modeSelect ? modeSelect.value : DEFAULT_SETTINGS.restCompletionMode;
  return {
    restCompletionDurationSec: Number.isFinite(duration) ? duration : DEFAULT_SETTINGS.restCompletionDurationSec,
    restCompletionMode: mode
  };
}

async function saveConfig(){
  const rows = readConfigFromTable();
  await clearStore(STORE_CONFIG);
  await bulkPut(STORE_CONFIG, rows);

  appSettings = await saveSettings(readSettingsFromForm());
  await hydrateFromDB();
  await saveLocalBackup();
  toast("Config saved ✓", "ok");
}

async function resetDefaults(){
  if(!confirm("Reset config to defaults? (Your sessions are kept.)")) return;
  await clearStore(STORE_CONFIG);
  const counters = new Map();
  const rows = DEFAULT_CONFIG.map(r => {
    const w = (r.workout||"").trim();
    const n = (counters.get(w)||0)+1; counters.set(w,n);
    return { id: uid(), ...r, workout:w, sortOrder:n };
  });
  await bulkPut(STORE_CONFIG, rows);
  appSettings = await saveSettings(DEFAULT_SETTINGS);
  await hydrateFromDB();
  await saveLocalBackup();
  toast("Defaults restored ✓", "ok");
}

function addConfigRow(){
  const w = workoutTypes[0] || "Workout 1 – Full Body";
  const maxOrder = Math.max(
    0,
    ...configRows.filter(r => r.workout === w).map(r => Number(r.sortOrder||0))
  );
  configRows.push({
    id: uid(),
    exercise:"",
    workout: w,
    sets: 1,
    repLow: null,
    repHigh: null,
    restMin: null,
    sortOrder: maxOrder + 1
  });

  renderConfigTable();
}

function nextWorkoutName(){
  const base = "New Workout";
  const existing = new Set(uniqueWorkouts(configRows));
  let name = base;
  let counter = 1;
  while(existing.has(name)){
    counter += 1;
    name = `${base} ${counter}`;
  }
  return name;
}

function addWorkoutGroup(){
  syncWorkoutOrderFromDOM();
  const workout = nextWorkoutName();
  const maxOrder = Math.max(
    0,
    ...configRows.map(r => Number(r.workoutOrder || 0))
  );
  configRows.push({
    id: uid(),
    exercise:"",
    workout,
    sets: 1,
    repLow: null,
    repHigh: null,
    restMin: null,
    sortOrder: 1,
    workoutOrder: maxOrder + 1
  });

  renderConfigTable();
  requestAnimationFrame(() => {
    const tbody = $("#configTable tbody");
    if(!tbody) return;
    const header = tbody.querySelector(`tr[data-workout-header="${CSS.escape(workout)}"]`);
    if(header){
      header.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  });
}

/* Reorder helpers */

function getWorkoutValueFromRow(tr){
  return (tr.getAttribute("data-workout") || "").trim();
}

function moveRow(tr, direction){
  const workout = getWorkoutValueFromRow(tr);
  const tbody = tr.parentElement;
  const rows = Array.from(tbody.children);
  const idx = rows.indexOf(tr);
  if(idx === -1) return;

  if(direction < 0){
    for(let i = idx-1; i >= 0; i--){
      const r = rows[i];
      if(r.hasAttribute("data-workout-header")) break;
      if(getWorkoutValueFromRow(r) === workout){
        tbody.insertBefore(tr, r);
        return;
      }
    }
  } else {
    for(let i = idx+1; i < rows.length; i++){
      const r = rows[i];
      if(r.hasAttribute("data-workout-header")) break;
      if(getWorkoutValueFromRow(r) === workout){
        tbody.insertBefore(r, tr);
        return;
      }
    }
  }
}

function getWorkoutHeaders(tbody){
  return Array.from(tbody.querySelectorAll("tr[data-workout-header]"));
}

function getWorkoutGroupRows(headerRow){
  const group = [headerRow];
  let row = headerRow.nextElementSibling;
  while(row && !row.hasAttribute("data-workout-header")){
    group.push(row);
    row = row.nextElementSibling;
  }
  return group;
}

function moveWorkoutGroup(headerRow, direction){
  const tbody = headerRow.parentElement;
  const headers = getWorkoutHeaders(tbody);
  const idx = headers.indexOf(headerRow);
  if(idx === -1) return;
  const targetIdx = direction < 0 ? idx - 1 : idx + 1;
  if(targetIdx < 0 || targetIdx >= headers.length) return;

  const targetHeader = headers[targetIdx];
  const group = getWorkoutGroupRows(headerRow);
  const targetGroup = getWorkoutGroupRows(targetHeader);

  if(direction < 0){
    const insertBefore = targetGroup[0];
    group.forEach(row => tbody.insertBefore(row, insertBefore));
  } else {
    const insertBefore = targetGroup[targetGroup.length - 1].nextSibling;
    group.forEach(row => tbody.insertBefore(row, insertBefore));
  }

  updateWorkoutOrderFromDOM(tbody);
}

function updateWorkoutOrderFromDOM(tbody){
  const headers = getWorkoutHeaders(tbody);
  headers.forEach((header, index) => {
    const workout = header.getAttribute("data-workout-header") || "";
    const order = index + 1;
    configRows.forEach(row => {
      if((row.workout || "").trim() === workout){
        row.workoutOrder = order;
      }
    });
  });
}

function syncWorkoutOrderFromDOM(){
  const tbody = $("#configTable tbody");
  if(!tbody) return;
  const headers = getWorkoutHeaders(tbody);
  headers.forEach((header, index) => {
    const input = header.querySelector("input[data-workout-name]");
    const workout = (input?.value || header.getAttribute("data-workout-header") || "").trim();
    if(!workout) return;
    const order = index + 1;
    configRows.forEach(row => {
      if((row.workout || "").trim() === workout){
        row.workoutOrder = order;
      }
    });
  });
}

function wireConfigReorder(){
  const tbody = $("#configTable tbody");
  let dragSrc = null;
  let dragPointerId = null;
  let dragHandle = null;
  let lastTarget = null;
  let dragWorkoutHeader = null;
  let dragWorkoutPointerId = null;
  let dragWorkoutHandle = null;

  const clearDrag = () => {
    if(!dragSrc) return;
    dragSrc.classList.remove("dragging");
    tbody.classList.remove("is-dragging");
    if(dragHandle && dragPointerId !== null){
      try{ dragHandle.releasePointerCapture(dragPointerId); } catch{}
    }
    dragSrc = null;
    dragPointerId = null;
    dragHandle = null;
    lastTarget = null;
  };

  const clearWorkoutDrag = () => {
    if(!dragWorkoutHeader) return;
    dragWorkoutHeader.classList.remove("dragging");
    tbody.classList.remove("is-dragging");
    if(dragWorkoutHandle && dragWorkoutPointerId !== null){
      try{ dragWorkoutHandle.releasePointerCapture(dragWorkoutPointerId); } catch{}
    }
    dragWorkoutHeader = null;
    dragWorkoutPointerId = null;
    dragWorkoutHandle = null;
  };

  tbody.addEventListener("click", (e) => {
    const up = e.target.closest(".moveUp");
    const down = e.target.closest(".moveDown");
    if(!up && !down) return;

    const tr = e.target.closest("tr");
    if(!tr || tr.hasAttribute("data-workout-header")) return;

    moveRow(tr, up ? -1 : +1);
  });

  tbody.addEventListener("click", (e) => {
    const up = e.target.closest(".moveWorkoutUp");
    const down = e.target.closest(".moveWorkoutDown");
    if(!up && !down) return;

    const headerRow = e.target.closest("tr[data-workout-header]");
    if(!headerRow) return;
    moveWorkoutGroup(headerRow, up ? -1 : +1);
  });

  tbody.addEventListener("input", (e) => {
    const input = e.target.closest("input[data-workout-name]");
    if(!input) return;

    const headerRow = input.closest("tr");
    if(!headerRow) return;

    const nextWorkout = input.value.trim() || "Workout";
    headerRow.setAttribute("data-workout-header", nextWorkout);

    let row = headerRow.nextElementSibling;
    while(row && !row.hasAttribute("data-workout-header")){
      row.setAttribute("data-workout", nextWorkout);
      row = row.nextElementSibling;
    }
  });

  tbody.addEventListener("click", (e) => {
    const del = e.target.closest(".deleteRowBtn");
    if(!del) return;
    const tr = e.target.closest("tr");
    if(!tr || tr.hasAttribute("data-workout-header")) return;
    if(!confirm("Delete this config row?")) return;
    tr.remove();
    configRows = readConfigFromTable();
  });

  tbody.addEventListener("click", (e) => {
    const delWorkout = e.target.closest(".deleteWorkoutBtn");
    if(!delWorkout) return;
    const headerRow = delWorkout.closest("tr");
    if(!headerRow || !headerRow.hasAttribute("data-workout-header")) return;
    const workoutName = headerRow.getAttribute("data-workout-header") || "this workout";
    if(!confirm(`Delete "${workoutName}" and all its exercises?`)) return;
    let row = headerRow.nextElementSibling;
    while(row && !row.hasAttribute("data-workout-header")){
      const next = row.nextElementSibling;
      row.remove();
      row = next;
    }
    headerRow.remove();
    configRows = readConfigFromTable();
  });

  tbody.addEventListener("pointerdown", (e) => {
    const handle = e.target.closest(".handle");
    if(!handle) return;
    if(handle.classList.contains("workout-handle")){
      const headerRow = handle.closest("tr[data-workout-header]");
      if(!headerRow) return;
      dragWorkoutHeader = headerRow;
      dragWorkoutHandle = handle;
      dragWorkoutPointerId = e.pointerId;
      headerRow.classList.add("dragging");
      tbody.classList.add("is-dragging");
      handle.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }
    const tr = handle.closest("tr");
    if(!tr || tr.hasAttribute("data-workout-header")) return;
    dragSrc = tr;
    dragHandle = handle;
    dragPointerId = e.pointerId;
    lastTarget = null;
    tr.classList.add("dragging");
    tbody.classList.add("is-dragging");
    handle.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  tbody.addEventListener("pointermove", (e) => {
    if(dragWorkoutHeader && e.pointerId === dragWorkoutPointerId){
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const targetHeader = el?.closest("tr[data-workout-header]");
      if(!targetHeader || targetHeader === dragWorkoutHeader) return;

      const rect = targetHeader.getBoundingClientRect();
      const before = (e.clientY - rect.top) < rect.height / 2;
      const group = getWorkoutGroupRows(dragWorkoutHeader);
      const tbody = targetHeader.parentElement;

      if(before){
        group.forEach(row => tbody.insertBefore(row, targetHeader));
      } else {
        const targetGroup = getWorkoutGroupRows(targetHeader);
        const insertBefore = targetGroup[targetGroup.length - 1].nextSibling;
        group.forEach(row => tbody.insertBefore(row, insertBefore));
      }
      return;
    }
    if(!dragSrc || e.pointerId !== dragPointerId) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const targetTr = el?.closest("tr");
    if(!targetTr || targetTr === dragSrc) return;
    if(targetTr.hasAttribute("data-workout-header")) return;

    const srcW = getWorkoutValueFromRow(dragSrc);
    const tgtW = getWorkoutValueFromRow(targetTr);
    if(srcW !== tgtW){
      lastTarget = targetTr;
      return;
    }

    lastTarget = targetTr;
    const rect = targetTr.getBoundingClientRect();
    const before = (e.clientY - rect.top) < rect.height / 2;
    const tbody = targetTr.parentElement;

    if(before) tbody.insertBefore(dragSrc, targetTr);
    else tbody.insertBefore(dragSrc, targetTr.nextSibling);
  });

  tbody.addEventListener("pointerup", (e) => {
    if(dragWorkoutHeader && e.pointerId === dragWorkoutPointerId){
      updateWorkoutOrderFromDOM(tbody);
      clearWorkoutDrag();
      return;
    }
    if(!dragSrc || e.pointerId !== dragPointerId) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const targetTr = el?.closest("tr") || lastTarget;
    if(targetTr && !targetTr.hasAttribute("data-workout-header")){
      const srcW = getWorkoutValueFromRow(dragSrc);
      const tgtW = getWorkoutValueFromRow(targetTr);
      if(srcW !== tgtW){
        toast("Drag only within the same workout group (rename the workout header to regroup).", "warn");
      }
    }
    clearDrag();
  });

  tbody.addEventListener("pointercancel", (e) => {
    if(dragWorkoutHeader && e.pointerId === dragWorkoutPointerId) clearWorkoutDrag();
    if(dragSrc && e.pointerId === dragPointerId) clearDrag();
  });
}

/* ----------------- Export / Import ----------------- */

function updateBackupStatus(){
  const el = $("#backupStatus");
  const btn = $("#downloadBackupBtn");
  if(!el) return;
  const stored = localStorage.getItem(BACKUP_KEY);
  if(!stored){
    el.textContent = "No backup yet.";
    if(btn) btn.disabled = true;
    return;
  }
  let payload;
  try{ payload = JSON.parse(stored); }
  catch{
    el.textContent = "Backup unavailable.";
    if(btn) btn.disabled = true;
    return;
  }
  const when = payload?.exportedAt ? new Date(payload.exportedAt) : null;
  el.textContent = when ? `Last backup: ${when.toLocaleString()}` : "Backup saved.";
  if(btn) btn.disabled = false;
}

async function buildExportPayload(){
  const config = await getAll(STORE_CONFIG);
  const sessions = await getAll(STORE_SESSIONS);
  const settingsRecord = await getByKey(STORE_SETTINGS, SETTINGS_KEY);
  const settings = normalizeSettings(settingsRecord);
  return {
    schema: 4,
    exportedAt: new Date().toISOString(),
    config,
    sessions,
    settings
  };
}

function downloadPayload(payload, prefix){
  const blob = new Blob([JSON.stringify(payload, null, 2)], {type:"application/json"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const exportedAt = payload?.exportedAt ? new Date(payload.exportedAt) : new Date();
  a.download = `${prefix}-${formatDateTimeForFilename(exportedAt)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function exportAll(){
  const payload = await buildExportPayload();
  downloadPayload(payload, "workout-logger-export");
  toast("Exported ✓", "ok");
}

async function saveLocalBackup(){
  const payload = await buildExportPayload();
  try{
    localStorage.setItem(BACKUP_KEY, JSON.stringify(payload));
    updateBackupStatus();
  }catch(err){
    console.error(err);
    toast("Local backup failed (storage full)", "warn");
  }
}

function downloadLatestBackup(){
  const stored = localStorage.getItem(BACKUP_KEY);
  if(!stored){
    toast("No backup yet", "warn");
    return;
  }
  let payload;
  try{ payload = JSON.parse(stored); }
  catch{
    toast("Backup is corrupted", "danger");
    return;
  }
  downloadPayload(payload, "workout-logger-backup");
  toast("Backup downloaded ✓", "ok");
}

async function importAll(file){
  const text = await file.text();
  let payload;
  try{ payload = JSON.parse(text); }
  catch{ toast("Invalid JSON file", "danger"); return; }

  if(!payload || !payload.config || !payload.sessions){
    toast("Missing config/sessions in import", "danger");
    return;
  }
  if(!confirm("Import will overwrite current config AND sessions. Continue?")) return;

  await clearStore(STORE_CONFIG);
  await clearStore(STORE_SESSIONS);
  await clearStore(STORE_SETTINGS);

  const config = payload.config.map(r => ({ id: r.id || uid(), ...r }));
  const sessions = payload.sessions.map(s => ({ id: s.id || uid(), ...s }));
  const settings = normalizeSettings(payload.settings);

  await bulkPut(STORE_CONFIG, config);
  await bulkPut(STORE_SESSIONS, sessions);
  await put(STORE_SETTINGS, { id: SETTINGS_KEY, ...settings });

  await hydrateFromDB();
  await saveLocalBackup();
  toast("Imported ✓", "ok");
}

/* ----------------- Tabs ----------------- */

function showTab(name){
  $("#page-log").style.display = "none";
  $("#page-config").style.display = "none";
  $("#page-history").style.display = "none";
  $("#page-" + name).style.display = "block";

  $$(".tab").forEach(t => t.classList.remove("active"));
  const tab = $(`.tab[data-tab="${name}"]`);
  tab.classList.add("active");
  tab.setAttribute("aria-selected", "true");
  $$(".tab").filter(t=>t!==tab).forEach(t=>t.setAttribute("aria-selected","false"));
}

/* ----------------- Hydration ----------------- */

async function hydrateFromDB(){
  configRows = await getAll(STORE_CONFIG);
  appSettings = await loadSettings();

  if(!configRows.length){
    await ensureDefaults();
    configRows = await getAll(STORE_CONFIG);
  }

  workoutTypes = uniqueWorkouts(configRows);

  $("#logDate").value = todayISO();
  renderWorkoutTypeDropdown();
  $("#workoutType").value = workoutTypes[0] || "";
  renderExerciseList();

  renderConfigTable();
  renderSettingsForm();

  renderHistoryWorkoutFilter();
  $("#historyFilterWorkout").value = "";
  $("#historySearch").value = "";
  await renderHistory();

  await refreshKPIs();
}

/* ----------------- Wiring ----------------- */

function wireEvents(){
  $$(".tab").forEach(btn => {
    btn.addEventListener("click", () => {
      showTab(btn.dataset.tab);
      if(btn.dataset.tab === "history") renderHistory();
    });
  });

  $("#exerciseList").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-timer-action]");
    if(!btn) return;
    const card = btn.closest(".exercise-card");
    if(!card) return;
    const exerciseId = card.getAttribute("data-exercise-id");
    if(!exerciseId) return;

    const action = btn.getAttribute("data-timer-action");
    if(action === "start") startExerciseTimer(exerciseId);
    if(action === "stop") stopExerciseTimer(exerciseId);
    if(action === "reset") resetExerciseTimer(exerciseId);
  });

  $("#workoutType").addEventListener("change", () => {
    renderExerciseList();
    clearLoggingInputs();
  });
  $("#saveSessionBtn").addEventListener("click", saveSession);
  $("#clearFormBtn").addEventListener("click", () => { clearLoggingInputs(); toast("Cleared form", "ok"); });

  $("#saveConfigBtn").addEventListener("click", saveConfig);
  $("#resetDefaultsBtn").addEventListener("click", resetDefaults);
  $("#addRowBtn").addEventListener("click", addConfigRow);
  $("#addWorkoutBtn").addEventListener("click", addWorkoutGroup);

  $("#exportBtn").addEventListener("click", exportAll);
  $("#downloadBackupBtn").addEventListener("click", downloadLatestBackup);
  $("#importFile").addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    if(!file) return;
    await importAll(file);
    e.target.value = "";
  });

  $("#refreshHistoryBtn").addEventListener("click", renderHistory);
  $("#historyFilterWorkout").addEventListener("change", renderHistory);
  $("#historySearch").addEventListener("input", debounce(renderHistory, 250));
  $("#deleteAllBtn").addEventListener("click", deleteAllSessions);

  const logDatePickerBtn = $("#logDatePickerBtn");
  if(logDatePickerBtn){
    logDatePickerBtn.addEventListener("click", () => {
      const logDate = $("#logDate");
      if(typeof logDate.showPicker === "function"){
        logDate.showPicker();
        return;
      }
      logDate.focus();
      logDate.click();
    });
  }
}

(async function init(){
  try{
    setDBStatus("Opening DB…", "warn");
    db = await openDB();
    await ensureDefaults();
    await ensureSettingsDefaults();
    await hydrateFromDB();
    updateBackupStatus();

    wireTopbarOffset();
    wireEvents();
    wireLiveSetsDoneAutocalc();
    wireConfigReorder();

    setDBStatus("Ready (local)", "ok");
    toast("Ready ✓", "ok");
  }catch(err){
    console.error(err);
    setDBStatus("DB error", "danger");
    toast("Failed to open local DB", "danger");
  }
})();
