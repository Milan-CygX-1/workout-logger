// Minimal regenerated version (safe baseline)
// IndexedDB + export/import

const DB_NAME = "workout_logger";
const STORE_CONFIG = "config";
const STORE_SESSIONS = "sessions";

let db;

const DEFAULT_CONFIG = [
  { id: crypto.randomUUID(), exercise:"Pull-up", workout:"Workout 1", sets:5, repLow:2, repHigh:2 },
  { id: crypto.randomUUID(), exercise:"Push-up", workout:"Workout 1", sets:3, repLow:10, repHigh:15 }
];

function openDB(){
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore(STORE_CONFIG, { keyPath:"id" });
      db.createObjectStore(STORE_SESSIONS, { keyPath:"id" });
    };
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

async function init(){
  db = await openDB();
  const tx = db.transaction(STORE_CONFIG,"readwrite");
  const store = tx.objectStore(STORE_CONFIG);
  DEFAULT_CONFIG.forEach(r => store.put(r));
}

init();
