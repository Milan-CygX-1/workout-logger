/**
 * Workout Logger (Local / IndexedDB)
 * Features:
 * - Logging page: date + workout dropdown, per-exercise reps-by-set grid, live auto sets-done calc
 * - Config page: editable plan + reorder without editing numbers (↑/↓ on mobile + drag handle on desktop)
 * - History page: all saved sessions
 * - Export/Import JSON (config + sessions)
 */

const DB_NAME = "workout_logger_db";
const DB_VERSION = 1;
const STORE_CONFIG = "config";
const STORE_SESSIONS = "sessions";
const BACKUP_KEY = "workout_logger_backup_v1";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

let db;
let configRows = [];
let workoutTypes = [];

/* ----------------- Defaults (preloaded config) ----------------- */

const DEFAULT_CONFIG = [
  // Workout 1 – Full Body
  { exercise:"Pull-up", workout:"Workout 1 – Full Body", sets:5, repLow:2, repHigh:2, type:"Strength", restMin:5 },
  { exercise:"Lunge", workout:"Workout 1 – Full Body", sets:2, repLow:null, repHigh:null, type:"AMRAP", restMin:5 },
  { exercise:"Push-up", workout:"Workout 1 – Full Body", sets:3, repLow:12, repHigh:15, type:"Rep Range", restMin:5 },
  { exercise:"Glute Bridge", workout:"Workout 1 – Full Body", sets:3, repLow:6, repHigh:20, type:"Rep Range", restMin:5 },
  { exercise:"TRX Lateral Raise", workout:"Workout 1 – Full Body", sets:3, repLow:15, repHigh:20, type:"Rep Range", restMin:3 },
  { exercise:"Calf Raise", workout:"Workout 1 – Full Body", sets:2, repLow:6, repHigh:30, type:"Rep Range", restMin:3 },
  { exercise:"TRX Crunch", workout:"Workout 1 – Full Body", sets:2, repLow:null, repHigh:null, type:"AMRAP", restMin:3 },

  // Workout 2 – Upper Body
  { exercise:"Pull-up", workout:"Workout 2 – Upper Body", sets:5, repLow:2, repHigh:2, type:"Strength", restMin:5 },
  { exercise:"Push-up", workout:"Workout 2 – Upper Body", sets:3, repLow:12, repHigh:15, type:"Rep Range", restMin:5 },
  { exercise:"TRX Row", workout:"Workout 2 – Upper Body", sets:3, repLow:12, repHigh:15, type:"Rep Range", restMin:5 },
  { exercise:"TRX Bicep Curl", workout:"Workout 2 – Upper Body", sets:3, repLow:15, repHigh:20, type:"Rep Range", restMin:3 },
  { exercise:"TRX Triceps Extension", workout:"Workout 2 – Upper Body", sets:3, repLow:15, repHigh:20, type:"Rep Range", restMin:3 },
  { exercise:"TRX Lateral Raise", workout:"Workout 2 – Upper Body", sets:3, repLow:15, repHigh:20, type:"Rep Range", restMin:3 },

  // Workout 3 – Lower Body
  { exercise:"Lunge", workout:"Workout 3 – Lower Body", sets:2, repLow:null, repHigh:null, type:"AMRAP", restMin:5 },
  { exercise:"Glute Bridge", workout:"Workout 3 – Lower Body", sets:3, repLow:6, repHigh:20, type:"Rep Range", restMin:5 },
  { exercise:"Calf Raise", workout:"Workout 3 – Lower Body", sets:2, repLow:6, repHigh:30, type:"Rep Range", restMin:3 },
  { exercise:"TRX Crunch", workout:"Workout 3 – Lower Body", sets:2, repLow:null, repHigh:null, type:"AMRAP", restMin:3 },
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
function uniqueWorkouts(rows){
  return Array.from(new Set(rows.map(r => (r.workout||"").trim()).filter(Boolean))).sort();
}
function computeTarget(row){
  if(row.type === "AMRAP") return `${row.sets} × AMRAP`;
  if(row.type === "Strength"){
    if(row.repLow != null && row.repHigh != null && row.repLow === row.repHigh) return `${row.sets} × ${row.repLow}`;
    return `${row.sets} × ${row.repLow ?? "?"}`;
  }
  const low = row.repLow ?? "";
  const high = row.repHigh ?? "";
  if(low !== "" && high !== "" && low !== high) return `${row.sets} × ${low}–${high}`;
  if(low !== "" && high !== "" && low === high) return `${row.sets} × ${low}`;
  return `${row.sets} sets`;
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

function renderExerciseList(){
  const workout = $("#workoutType").value;
  const list = $("#exerciseList");
  const rows = rowsForWorkout(workout);

  if(!rows.length){
    list.innerHTML = `<div class="muted">No exercises configured for this workout. Add them in Config.</div>`;
    return;
  }

  list.innerHTML = rows.map((r) => {
    const target = computeTarget(r);
    const defaultRest = (r.restMin ?? "");
    const setsPlanned = Math.max(1, Number(r.sets ?? 1));

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
            <span class="pill">${escapeHtml(r.type || "")}</span>
            <span class="pill">${escapeHtml(defaultRest ? `${defaultRest} min rest` : "rest n/a")}</span>
          </div>
        </div>

        <div>
          <label>Reps in set (grid)</label>
          <div class="reps-grid">${repCells}</div>
          <div class="sub">Track each set separately to see progression.</div>
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
  });
}

function readExerciseInputs(){
  const cards = $$("#exerciseList .exercise-card");
  const items = [];

  for(const c of cards){
    const exercise = c.getAttribute("data-exercise");
    const target = c.getAttribute("data-target");
    const defaultRest = c.getAttribute("data-default-rest");
    const setsPlanned = Number(c.getAttribute("data-sets-planned") || "1");

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
      comment
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
    return anyRep || it.setsDone !== null || (it.comment && it.comment.length) || (it.restMin !== null) || (it.pain0to5 && it.pain0to5 > 0);
  });
  if(!meaningful.length){ toast("Nothing entered yet (fill some reps/sets/comment)", "warn"); return; }

  const session = {
    id: uid(),
    dateISO,
    workout,
    comment,
    items,
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
  const painMax = items.reduce((m,it)=> Math.max(m, Number(it.pain0to5||0)), 0);
  const pillClass = painMax >= 4 ? "danger" : painMax >= 2 ? "warn" : "ok";

  const rows = items.map(it => {
    const repsStr = repsArrayToString(it.repsBySet);
    const setsDone = it.setsDone ?? "—";
    const rest = it.restMin ?? "—";
    const pain = it.pain0to5 ?? 0;
    const cmt = it.comment ? ` · <span class="muted">${escapeHtml(it.comment)}</span>` : "";
    return `<li style="margin:6px 0; line-height:1.4">
      <b>${escapeHtml(it.exercise)}</b>
      <span class="muted small">(${escapeHtml(it.target||"")})</span><br/>
      <span class="muted small">
        Sets done: <b>${escapeHtml(setsDone)}</b> · Reps: <b>${escapeHtml(repsStr || "—")}</b>
        · Rest: <b>${escapeHtml(rest)}</b> · Pain: <b>${escapeHtml(pain)}</b>${cmt}
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
          <span class="pill ${pillClass}">Pain max: ${painMax}</span>
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
    <tr data-id="${escapeHtml(r.id)}" draggable="true">
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
      <td class="w-workout">
        <input value="${escapeHtml(r.workout ?? "")}" data-field="workout" list="workoutDatalist" placeholder="Workout name" />
        <input type="hidden" value="${escapeHtml(r.type ?? "")}" data-field="type" />
      </td>
      <td class="w-num"><input inputmode="numeric" value="${escapeHtml(r.sets ?? "")}" data-field="sets" /></td>
      <td class="w-num"><input inputmode="numeric" value="${escapeHtml(r.repLow ?? "")}" data-field="repLow" /></td>
      <td class="w-num"><input inputmode="numeric" value="${escapeHtml(r.repHigh ?? "")}" data-field="repHigh" /></td>
      <td class="w-num"><input inputmode="decimal" value="${escapeHtml(r.restMin ?? "")}" data-field="restMin" /></td>
      <td class="w-actions"><button class="btn danger small deleteRowBtn" type="button">Delete</button></td>
    </tr>
  `;
}

function buildWorkoutDatalist(){
  let dl = $("#workoutDatalist");
  if(!dl){
    dl = document.createElement("datalist");
    dl.id = "workoutDatalist";
    document.body.appendChild(dl);
  }
  dl.innerHTML = uniqueWorkouts(configRows).map(w => `<option value="${escapeHtml(w)}"></option>`).join("");
}

function renderConfigTable(){
  const tbody = $("#configTable tbody");

  const byWorkout = new Map();
  for(const r of configRows){
    const w = (r.workout||"").trim();
    if(!byWorkout.has(w)) byWorkout.set(w, []);
    byWorkout.get(w).push(r);
  }

  const workoutList = Array.from(byWorkout.keys()).sort();
  const htmlParts = [];

  for(const w of workoutList){
    const arr = byWorkout.get(w)
      .slice()
      .sort((a,b)=> (a.sortOrder ?? 999999) - (b.sortOrder ?? 999999));

    htmlParts.push(`
      <tr class="workout-header" data-workout-header="${escapeHtml(w)}">
        <td colspan="8" style="background: rgba(3,7,18,.55); font-weight:1000; color: var(--text);">
          ${escapeHtml(w)}
          <span class="muted" style="font-weight:800; margin-left:10px;">(reorder within this workout)</span>
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

  for(const tr of trs){
    if(tr.hasAttribute("data-workout-header")) continue;

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
    if(!obj.workout) obj.workout = "Workout 1 – Full Body";
    if(!obj.type) obj.type = "Other";

    const w = obj.workout;
    const n = (counters.get(w) || 0) + 1;
    counters.set(w, n);
    obj.sortOrder = n;

    out.push(obj);
  }
  return out;
}

async function saveConfig(){
  const rows = readConfigFromTable();
  await clearStore(STORE_CONFIG);
  await bulkPut(STORE_CONFIG, rows);

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
    type: "Rep Range",
    restMin: null,
    sortOrder: maxOrder + 1
  });

  renderConfigTable();
  buildWorkoutDatalist();
}

/* Reorder helpers */

function getWorkoutValueFromRow(tr){
  const input = tr.querySelector('input[data-field="workout"]');
  return (input?.value || "").trim();
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

function wireConfigReorder(){
  const tbody = $("#configTable tbody");
  let dragSrc = null;

  tbody.addEventListener("click", (e) => {
    const up = e.target.closest(".moveUp");
    const down = e.target.closest(".moveDown");
    if(!up && !down) return;

    const tr = e.target.closest("tr");
    if(!tr || tr.hasAttribute("data-workout-header")) return;

    moveRow(tr, up ? -1 : +1);
  });

  tbody.addEventListener("click", (e) => {
    const del = e.target.closest(".deleteRowBtn");
    if(!del) return;
    const tr = e.target.closest("tr");
    if(!tr || tr.hasAttribute("data-workout-header")) return;
    if(!confirm("Delete this config row?")) return;
    tr.remove();
  });

  tbody.addEventListener("dragstart", (e) => {
    const handle = e.target.closest(".handle");
    const tr = e.target.closest("tr");
    if(!handle || !tr || tr.hasAttribute("data-workout-header")){
      e.preventDefault();
      return;
    }
    dragSrc = tr;
    tr.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", tr.getAttribute("data-id") || "");
  });

  tbody.addEventListener("dragend", () => {
    if(dragSrc) dragSrc.classList.remove("dragging");
    dragSrc = null;
  });

  tbody.addEventListener("dragover", (e) => {
    if(!dragSrc) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  });

  tbody.addEventListener("drop", (e) => {
    if(!dragSrc) return;
    e.preventDefault();

    const targetTr = e.target.closest("tr");
    if(!targetTr || targetTr === dragSrc) return;
    if(targetTr.hasAttribute("data-workout-header")) return;

    const srcW = getWorkoutValueFromRow(dragSrc);
    const tgtW = getWorkoutValueFromRow(targetTr);
    if(srcW !== tgtW){
      toast("Drag only within the same workout group (use workout field to change group).", "warn");
      return;
    }

    const rect = targetTr.getBoundingClientRect();
    const before = (e.clientY - rect.top) < rect.height / 2;
    const tbody = targetTr.parentElement;

    if(before) tbody.insertBefore(dragSrc, targetTr);
    else tbody.insertBefore(dragSrc, targetTr.nextSibling);
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
  return {
    schema: 3,
    exportedAt: new Date().toISOString(),
    config,
    sessions
  };
}

function downloadPayload(payload, prefix){
  const blob = new Blob([JSON.stringify(payload, null, 2)], {type:"application/json"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${prefix}-${todayISO()}.json`;
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

  const config = payload.config.map(r => ({ id: r.id || uid(), ...r }));
  const sessions = payload.sessions.map(s => ({ id: s.id || uid(), ...s }));

  await bulkPut(STORE_CONFIG, config);
  await bulkPut(STORE_SESSIONS, sessions);

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

  if(!configRows.length){
    await ensureDefaults();
    configRows = await getAll(STORE_CONFIG);
  }

  workoutTypes = uniqueWorkouts(configRows);

  $("#logDate").value = todayISO();
  renderWorkoutTypeDropdown();
  $("#workoutType").value = workoutTypes[0] || "";
  renderExerciseList();

  buildWorkoutDatalist();
  renderConfigTable();

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

  $("#workoutType").addEventListener("change", () => {
    renderExerciseList();
    clearLoggingInputs();
  });
  $("#saveSessionBtn").addEventListener("click", saveSession);
  $("#clearFormBtn").addEventListener("click", () => { clearLoggingInputs(); toast("Cleared form", "ok"); });

  $("#saveConfigBtn").addEventListener("click", saveConfig);
  $("#resetDefaultsBtn").addEventListener("click", resetDefaults);
  $("#addRowBtn").addEventListener("click", addConfigRow);

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
    await hydrateFromDB();
    updateBackupStatus();

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
