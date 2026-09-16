/* MedTime Service Worker
 * ----------------------
 * What this gives us:
 *  - Notifications keep firing while the tab is backgrounded, minimised, or
 *    even closed, AS LONG AS the browser process is still running.
 *  - On browsers that support Notification Triggers (showTrigger), doses are
 *    handed to the OS in advance, so they fire even with the browser closed.
 *    This is feature-detected; it is not available everywhere.
 *  - Tapping a notification opens/focuses the app.
 *
 * What it CANNOT do: wake itself up after the browser is fully quit on
 * platforms without Notification Triggers. That needs Web Push + a server.
 */

const DB_NAME = "medtime-sw";
const STORE = "kv";

/* ---------- tiny IndexedDB key/value helper ---------- */
function idb(mode, fn){
  return new Promise((resolve, reject)=>{
    const open = indexedDB.open(DB_NAME, 1);
    open.onupgradeneeded = () => {
      if(!open.result.objectStoreNames.contains(STORE)) open.result.createObjectStore(STORE);
    };
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => { open.result.close(); resolve(req && req.result); };
      tx.onerror = () => { open.result.close(); reject(tx.error); };
    };
  });
}
const kvGet = (k) => idb("readonly", s => s.get(k));
const kvSet = (k, v) => idb("readwrite", s => s.put(v, k));

/* ---------- lifecycle ---------- */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim().then(checkDueDoses)));

/* ---------- receive the schedule from the page ---------- */
self.addEventListener("message", (event) => {
  const data = event.data || {};
  if(data.type === "SCHEDULE"){
    event.waitUntil(
      kvSet("schedule", data.schedule || [])
        .then(() => scheduleWithTriggers(data.schedule || []))
        .then(checkDueDoses)
        .catch(()=>{})
    );
  }
  if(data.type === "CHECK_NOW"){ event.waitUntil(checkDueDoses().catch(()=>{})); }
});

/* ---------- Notification Triggers (best-effort, feature-detected) ----------
 * Where supported, this hands future doses straight to the OS so they fire
 * even if the browser is closed. Where not supported this is a no-op, and
 * checkDueDoses() on wake events is the fallback.
 */
async function scheduleWithTriggers(schedule){
  if(typeof self.TimestampTrigger === "undefined") return;
  try{
    const existing = await self.registration.getNotifications({ includeTriggered: true });
    existing.forEach(n => { if(n.tag && n.tag.indexOf("medtime-dose-")===0) n.close(); });
  }catch(e){}

  const now = Date.now();
  for(const item of schedule){
    if(item.at <= now) continue;
    try{
      await self.registration.showNotification(item.title, {
        body: item.body,
        tag: "medtime-dose-" + item.id,
        requireInteraction: true,
        showTrigger: new self.TimestampTrigger(item.at),
        data: { id: item.id, url: "./#/home" },
      });
    }catch(e){ /* trigger unsupported or rejected — fallback handles it */ }
  }
}

/* ---------- fallback: check on every wake event ---------- */
async function checkDueDoses(){
  let schedule = [], fired = [];
  try{ schedule = (await kvGet("schedule")) || []; fired = (await kvGet("fired")) || []; }
  catch(e){ return; }

  const now = Date.now();
  let changed = false;

  for(const item of schedule){
    if(item.at > now) continue;               // not due yet
    if(now - item.at > 60*60*1000) continue;  // >1h late: don't spam on a late wake
    if(fired.indexOf(item.id) !== -1) continue; // duplicate guard

    try{
      await self.registration.showNotification(item.title, {
        body: item.body,
        tag: "medtime-dose-" + item.id,
        requireInteraction: true,
        data: { id: item.id, url: "./#/home" },
      });
      fired.push(item.id);
      changed = true;
    }catch(e){}
  }

  if(changed){
    try{ await kvSet("fired", fired.slice(-200)); }catch(e){}
  }
}

/* Any navigation wakes the SW — a cheap chance to re-check without a timer. */
self.addEventListener("fetch", (event) => {
  if(event.request.mode === "navigate"){ event.waitUntil(checkDueDoses().catch(()=>{})); }
});

/* Periodic Background Sync: Chrome/Android, installed PWA only, and the
   browser picks the real interval (often ~12h). Best-effort extra net. */
self.addEventListener("periodicsync", (event) => {
  if(event.tag === "medtime-check"){ event.waitUntil(checkDueDoses().catch(()=>{})); }
});

/* ---------- notification click ---------- */
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "./#/home";
  event.waitUntil(
    self.clients.matchAll({ type:"window", includeUncontrolled:true }).then((list)=>{
      for(const client of list){
        if("focus" in client){
          client.postMessage({ type:"notification-click", tag:event.notification.tag });
          return client.focus();
        }
      }
      if(self.clients.openWindow) return self.clients.openWindow(target);
    })
  );
});
