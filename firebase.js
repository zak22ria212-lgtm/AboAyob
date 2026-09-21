import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  onSnapshot,
  runTransaction,
  serverTimestamp
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

const managedKeys = new Set([
  "final_bookings_v5", "final_subjects_v5", "final_school_v5",
  "final_owner_v5", "final_notif_email", "final_notif_phone"
]);

let applyingRemoteState = false;
let writeTimer = null;
let baselineState = null;

function parseJson(value, fallback) {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}
function normalize(state = {}) {
  return {
    bookings: Array.isArray(state.bookings) ? state.bookings : [],
    subjects: Array.isArray(state.subjects) ? state.subjects : [],
    schoolName: state.schoolName || "",
    ownerEmail: state.ownerEmail || null,
    notifEmail: state.notifEmail || "",
    notifPhone: state.notifPhone || ""
  };
}
function readLocalState() {
  return normalize({
    bookings: parseJson(localStorage.getItem("final_bookings_v5"), []),
    subjects: parseJson(localStorage.getItem("final_subjects_v5"), []),
    schoolName: localStorage.getItem("final_school_v5") || "",
    ownerEmail: localStorage.getItem("final_owner_v5") || null,
    notifEmail: localStorage.getItem("final_notif_email") || "",
    notifPhone: localStorage.getItem("final_notif_phone") || ""
  });
}
function stateJson(state) { return JSON.stringify(normalize(state)); }
function applyRemoteState(state, notify = true) {
  const clean = normalize(state);
  applyingRemoteState = true;
  try {
    localStorage.setItem("final_bookings_v5", JSON.stringify(clean.bookings));
    localStorage.setItem("final_subjects_v5", JSON.stringify(clean.subjects));
    localStorage.setItem("final_school_v5", clean.schoolName);
    clean.ownerEmail ? localStorage.setItem("final_owner_v5", clean.ownerEmail) : localStorage.removeItem("final_owner_v5");
    localStorage.setItem("final_notif_email", clean.notifEmail);
    localStorage.setItem("final_notif_phone", clean.notifPhone);
    baselineState = clean;
  } finally {
    applyingRemoteState = false;
  }
  if (notify) window.dispatchEvent(new CustomEvent("firebase-state-updated", { detail: clean }));
}
function bookingMap(items) {
  return new Map((items || []).filter(x => x && x.id).map(x => [String(x.id), x]));
}
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

async function saveLocalChanges() {
  if (applyingRemoteState) return;
  const local = readLocalState();
  const base = normalize(baselineState || local);
  const baseMap = bookingMap(base.bookings);
  const localMap = bookingMap(local.bookings);

  const removedIds = [...baseMap.keys()].filter(id => !localMap.has(id));
  const changedBookings = [...localMap.entries()]
    .filter(([id, item]) => !baseMap.has(id) || !same(baseMap.get(id), item))
    .map(([, item]) => item);

  const committed = await runTransaction(db, async transaction => {
    const snapshot = await transaction.get(stateRef);
    const remote = normalize(snapshot.exists() ? snapshot.data() : {});
    const mergedMap = bookingMap(remote.bookings);

    removedIds.forEach(id => mergedMap.delete(id));
    changedBookings.forEach(item => {
      const occupied = [...mergedMap.values()].some(existing =>
        String(existing.id) !== String(item.id) &&
        existing.date === item.date && Number(existing.period) === Number(item.period)
      );
      if (!occupied) mergedMap.set(String(item.id), item);
    });

    const merged = {
      bookings: [...mergedMap.values()],
      subjects: same(local.subjects, base.subjects) ? remote.subjects : local.subjects,
      schoolName: local.schoolName === base.schoolName ? remote.schoolName : local.schoolName,
      ownerEmail: local.ownerEmail === base.ownerEmail ? remote.ownerEmail : local.ownerEmail,
      notifEmail: local.notifEmail === base.notifEmail ? remote.notifEmail : local.notifEmail,
      notifPhone: local.notifPhone === base.notifPhone ? remote.notifPhone : local.notifPhone
    };
    transaction.set(stateRef, { ...merged, updatedAt: serverTimestamp() }, { merge: true });
    return merged;
  });

  applyRemoteState(committed, true);
}
function scheduleSave() {
  if (applyingRemoteState) return;
  clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    saveLocalChanges().catch(error => console.error("Firebase save failed:", error));
  }, 400);
}

const nativeSetItem = Storage.prototype.setItem;
const nativeRemoveItem = Storage.prototype.removeItem;
Storage.prototype.setItem = function(key, value) {
  nativeSetItem.call(this, key, value);
  if (this === localStorage && managedKeys.has(String(key))) scheduleSave();
};
Storage.prototype.removeItem = function(key) {
  nativeRemoveItem.call(this, key);
  if (this === localStorage && managedKeys.has(String(key))) scheduleSave();
};

try {
  const initialSnapshot = await getDoc(stateRef);
  if (initialSnapshot.exists()) {
    applyRemoteState(initialSnapshot.data(), false);
  } else {
    const initial = readLocalState();
    await setDoc(stateRef, { ...initial, updatedAt: serverTimestamp() }, { merge: true });
    baselineState = initial;
  }

  onSnapshot(stateRef, snapshot => {
    if (!snapshot.exists()) return;
    const remote = normalize(snapshot.data());
    if (stateJson(remote) !== stateJson(readLocalState())) applyRemoteState(remote, true);
    else baselineState = remote;
  }, error => console.error("Firebase live sync failed:", error));
} catch (error) {
  console.error("Firebase initialization failed; local storage remains available:", error);
}
