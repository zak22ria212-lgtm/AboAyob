import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getFirestore, doc, getDoc, setDoc, onSnapshot,
  runTransaction, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyAqwkxA3PpDY_LDJqOePlySPY8KBWTGtZY",
  authDomain: "zak1-6cfb9.firebaseapp.com",
  projectId: "zak1-6cfb9",
  storageBucket: "zak1-6cfb9.firebasestorage.app",
  messagingSenderId: "633095299612",
  appId: "1:633095299612:web:b1fc8f6f45ab0067cdb5d9",
  measurementId: "G-HXM48K86X3"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
const stateRef = doc(db, "learning_resources_app", "main");

const KEYS = new Set([
  "final_bookings_v5", "final_subjects_v5", "final_school_v5",
  "final_owner_v5", "final_notif_email", "final_notif_phone"
]);
const BOOKING_KEY = "final_bookings_v5";

let ready = false;
let applyingRemote = false;
let saving = false;
let saveAgain = false;
let settingsTimer = null;
let baseline = null;
let lastPublished = "";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const parse = (value, fallback) => {
  try { return value ? JSON.parse(value) : fallback; }
  catch { return fallback; }
};
const normalize = (state = {}) => ({
  bookings: Array.isArray(state.bookings) ? state.bookings : [],
  subjects: Array.isArray(state.subjects) ? state.subjects : [],
  schoolName: state.schoolName || "",
  ownerEmail: state.ownerEmail || null,
  notifEmail: state.notifEmail || "",
  notifPhone: state.notifPhone || ""
});
const localState = () => normalize({
  bookings: parse(localStorage.getItem(BOOKING_KEY), []),
  subjects: parse(localStorage.getItem("final_subjects_v5"), []),
  schoolName: localStorage.getItem("final_school_v5"),
  ownerEmail: localStorage.getItem("final_owner_v5"),
  notifEmail: localStorage.getItem("final_notif_email"),
  notifPhone: localStorage.getItem("final_notif_phone")
});
const json = value => JSON.stringify(normalize(value));
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const bookingMap = list => new Map(
  (Array.isArray(list) ? list : [])
    .filter(item => item && item.id != null)
    .map(item => [String(item.id), item])
);
const sameSlot = (a, b) =>
  String(a?.date || "") === String(b?.date || "") &&
  Number(a?.period) === Number(b?.period);

function publish(state, extra = {}) {
  const clean = normalize(state);
  const signature = json(clean);
  if (signature === lastPublished && !extra.force) return;
  lastPublished = signature;
  window.dispatchEvent(new CustomEvent("firebase-state-updated", {
    detail: { ...clean, ...extra }
  }));
}

function applyRemote(state, notify = true) {
  const clean = normalize(state);
  applyingRemote = true;
  try {
    localStorage.setItem(BOOKING_KEY, JSON.stringify(clean.bookings));
    localStorage.setItem("final_subjects_v5", JSON.stringify(clean.subjects));
    localStorage.setItem("final_school_v5", clean.schoolName);
    clean.ownerEmail
      ? localStorage.setItem("final_owner_v5", clean.ownerEmail)
      : localStorage.removeItem("final_owner_v5");
    localStorage.setItem("final_notif_email", clean.notifEmail);
    localStorage.setItem("final_notif_phone", clean.notifPhone);
    baseline = clean;
  } finally {
    applyingRemote = false;
  }
  if (notify) publish(clean);
}

async function withRetry(action, attempts = 3) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try { return await action(); }
    catch (error) {
      lastError = error;
      if (i < attempts - 1) await sleep(250 * (i + 1));
    }
  }
  throw lastError;
}

async function saveChanges() {
  if (!ready || applyingRemote) return;
  if (saving) { saveAgain = true; return; }

  saving = true;
  const local = localState();
  const base = normalize(baseline || local);
  const baseMap = bookingMap(base.bookings);
  const localMap = bookingMap(local.bookings);

  const removedIds = [...baseMap.keys()].filter(id => !localMap.has(id));
  const changedBookings = [...localMap.entries()]
    .filter(([id, item]) => !baseMap.has(id) || !equal(baseMap.get(id), item))
    .map(([, item]) => item);

  try {
    const result = await withRetry(() => runTransaction(db, async transaction => {
      const snap = await transaction.get(stateRef);
      const remote = normalize(snap.exists() ? snap.data() : {});
      const remoteMap = bookingMap(remote.bookings);
      const rejectedIds = [];

      removedIds.forEach(id => remoteMap.delete(id));

      for (const item of changedBookings) {
        const conflict = [...remoteMap.values()].some(existing =>
          String(existing.id) !== String(item.id) && sameSlot(existing, item)
        );
        if (conflict) rejectedIds.push(String(item.id));
        else remoteMap.set(String(item.id), item);
      }

      const merged = {
        bookings: [...remoteMap.values()],
        subjects: equal(local.subjects, base.subjects) ? remote.subjects : local.subjects,
        schoolName: local.schoolName === base.schoolName ? remote.schoolName : local.schoolName,
        ownerEmail: local.ownerEmail === base.ownerEmail ? remote.ownerEmail : local.ownerEmail,
        notifEmail: local.notifEmail === base.notifEmail ? remote.notifEmail : local.notifEmail,
        notifPhone: local.notifPhone === base.notifPhone ? remote.notifPhone : local.notifPhone
      };

      transaction.set(stateRef, {
        ...merged,
        updatedAt: serverTimestamp()
      }, { merge: true });

      return { merged, rejectedIds };
    }));

    applyRemote(result.merged, false);
    publish(result.merged, {
      force: true,
      rejectedBookingIds: result.rejectedIds,
      syncStatus: result.rejectedIds.length ? "conflict" : "saved"
    });
  } catch (error) {
    console.error("Firebase save failed:", error);
    try {
      const latest = await getDoc(stateRef);
      if (latest.exists()) applyRemote(latest.data(), true);
    } catch (refreshError) {
      console.error("Firebase refresh failed:", refreshError);
    }
    publish(localState(), { force: true, syncStatus: "error" });
  } finally {
    saving = false;
    if (saveAgain) {
      saveAgain = false;
      queueMicrotask(saveChanges);
    }
  }
}

function requestSave(key) {
  if (!ready || applyingRemote) return;
  if (key === BOOKING_KEY) {
    clearTimeout(settingsTimer);
    queueMicrotask(saveChanges);
  } else {
    clearTimeout(settingsTimer);
    settingsTimer = setTimeout(saveChanges, 250);
  }
}

const nativeSetItem = Storage.prototype.setItem;
const nativeRemoveItem = Storage.prototype.removeItem;
Storage.prototype.setItem = function(key, value) {
  nativeSetItem.call(this, key, value);
  if (this === localStorage && KEYS.has(String(key))) requestSave(String(key));
};
Storage.prototype.removeItem = function(key) {
  nativeRemoveItem.call(this, key);
  if (this === localStorage && KEYS.has(String(key))) requestSave(String(key));
};

async function initializeSync() {
  try {
    const first = await getDoc(stateRef);
    if (first.exists()) {
      applyRemote(first.data(), true);
    } else {
      const initial = localState();
      await setDoc(stateRef, { ...initial, updatedAt: serverTimestamp() }, { merge: true });
      baseline = initial;
      publish(initial);
    }

    ready = true;

    onSnapshot(stateRef, snapshot => {
      if (!snapshot.exists()) return;
      const remote = normalize(snapshot.data());
      if (saving) return;
      if (!equal(remote, localState())) applyRemote(remote, true);
      else baseline = remote;
    }, error => console.error("Firebase live sync failed:", error));

    window.addEventListener("online", async () => {
      try {
        const latest = await getDoc(stateRef);
        if (latest.exists() && !saving) applyRemote(latest.data(), true);
        await saveChanges();
      } catch (error) {
        console.error("Firebase reconnect failed:", error);
      }
    });
  } catch (error) {
    ready = true;
    console.error("Firebase initialization failed:", error);
    publish(localState(), { force: true, syncStatus: "offline" });
  }
}

await initializeSync();
