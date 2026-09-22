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

const STORAGE_KEYS = new Set([
  "final_bookings_v5",
  "final_subjects_v5",
  "final_school_v5",
  "final_owner_v5",
  "final_notif_email",
  "final_notif_phone"
]);

let ready = false;
let applyingRemote = false;
let saving = false;
let saveRequested = false;
let saveTimer = null;
let baseline = null;
let queuedRemote = null;

const parse = (value, fallback) => {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
};

const normalize = (state = {}) => ({
  bookings: Array.isArray(state.bookings) ? state.bookings.filter(Boolean) : [],
  subjects: Array.isArray(state.subjects) ? state.subjects : [],
  schoolName: state.schoolName || "",
  ownerEmail: state.ownerEmail || null,
  notifEmail: state.notifEmail || "",
  notifPhone: state.notifPhone || ""
});

const localState = () => normalize({
  bookings: parse(localStorage.getItem("final_bookings_v5"), []),
  subjects: parse(localStorage.getItem("final_subjects_v5"), []),
  schoolName: localStorage.getItem("final_school_v5"),
  ownerEmail: localStorage.getItem("final_owner_v5"),
  notifEmail: localStorage.getItem("final_notif_email"),
  notifPhone: localStorage.getItem("final_notif_phone")
});

const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const bookingMap = (list) => new Map(
  (list || [])
    .filter((item) => item && item.id != null)
    .map((item) => [String(item.id), item])
);
const slotKey = (item) => `${item.date}__${Number(item.period)}`;

function publish(state) {
  const detail = normalize(state);
  window.__firebaseSharedState = detail;
  window.dispatchEvent(new CustomEvent("firebase-state-updated", { detail }));
}

function applyRemote(state, notify = true) {
  const remote = normalize(state);
  applyingRemote = true;
  try {
    localStorage.setItem("final_bookings_v5", JSON.stringify(remote.bookings));
    localStorage.setItem("final_subjects_v5", JSON.stringify(remote.subjects));
    localStorage.setItem("final_school_v5", remote.schoolName);
    remote.ownerEmail
      ? localStorage.setItem("final_owner_v5", remote.ownerEmail)
      : localStorage.removeItem("final_owner_v5");
    localStorage.setItem("final_notif_email", remote.notifEmail);
    localStorage.setItem("final_notif_phone", remote.notifPhone);
    baseline = remote;
  } finally {
    applyingRemote = false;
  }
  if (notify) publish(remote);
}

async function saveChanges() {
  if (!ready || applyingRemote) return;
  if (saving) {
    saveRequested = true;
    return;
  }

  saving = true;
  saveRequested = false;

  const local = localState();
  const base = normalize(baseline || local);
  const baseMap = bookingMap(base.bookings);
  const localMap = bookingMap(local.bookings);

  const removedIds = [...baseMap.keys()].filter((id) => !localMap.has(id));
  const changedBookings = [...localMap.entries()]
    .filter(([id, item]) => !baseMap.has(id) || !equal(baseMap.get(id), item))
    .map(([, item]) => item);

  try {
    const committed = await runTransaction(db, async (tx) => {
      const snapshot = await tx.get(stateRef);
      const remote = normalize(snapshot.exists() ? snapshot.data() : {});
      const remoteMap = bookingMap(remote.bookings);

      // Deletions are allowed only for bookings that existed in this device's last
      // confirmed Firebase snapshot. This prevents an old device from deleting
      // bookings created later on another device.
      for (const id of removedIds) {
        if (baseMap.has(id)) remoteMap.delete(id);
      }

      // First confirmed booking wins. A booking is accepted only when its
      // date/period slot is still empty in the transaction's latest snapshot.
      for (const booking of changedBookings) {
        const id = String(booking.id);
        const wantedSlot = slotKey(booking);
        const occupant = [...remoteMap.entries()].find(
          ([otherId, other]) => otherId !== id && slotKey(other) === wantedSlot
        );

        if (!occupant) remoteMap.set(id, booking);
      }

      const result = normalize({
        bookings: [...remoteMap.values()],
        subjects: equal(local.subjects, base.subjects) ? remote.subjects : local.subjects,
        schoolName: local.schoolName === base.schoolName ? remote.schoolName : local.schoolName,
        ownerEmail: local.ownerEmail === base.ownerEmail ? remote.ownerEmail : local.ownerEmail,
        notifEmail: local.notifEmail === base.notifEmail ? remote.notifEmail : local.notifEmail,
        notifPhone: local.notifPhone === base.notifPhone ? remote.notifPhone : local.notifPhone
      });

      tx.set(
        stateRef,
        { ...result, updatedAt: serverTimestamp() },
        { merge: true }
      );
      return result;
    });

    // The transaction result is authoritative. If another person booked the same
    // slot first, the optimistic local booking is removed here automatically.
    applyRemote(committed, true);
  } catch (error) {
    console.error("Firebase save failed:", error);
    // Restore the last confirmed shared state rather than leaving a local-only
    // booking that other devices cannot see.
    if (baseline) applyRemote(baseline, true);
  } finally {
    saving = false;

    if (queuedRemote) {
      const remote = queuedRemote;
      queuedRemote = null;
      if (!equal(remote, localState())) applyRemote(remote, true);
      else baseline = remote;
    }

    if (saveRequested) {
      saveRequested = false;
      queueMicrotask(saveChanges);
    }
  }
}

function requestSave(key) {
  if (!ready || applyingRemote || !STORAGE_KEYS.has(String(key))) return;
  clearTimeout(saveTimer);
  // A small delay lets React finish all state effects before one atomic save.
  saveTimer = setTimeout(saveChanges, key === "final_bookings_v5" ? 30 : 250);
}

const nativeSetItem = Storage.prototype.setItem;
const nativeRemoveItem = Storage.prototype.removeItem;

Storage.prototype.setItem = function (key, value) {
  nativeSetItem.call(this, key, value);
  if (this === localStorage) requestSave(String(key));
};

Storage.prototype.removeItem = function (key) {
  nativeRemoveItem.call(this, key);
  if (this === localStorage) requestSave(String(key));
};

try {
  const first = await getDoc(stateRef);

  if (first.exists()) {
    applyRemote(first.data(), true);
  } else {
    const initial = localState();
    await setDoc(
      stateRef,
      { ...initial, updatedAt: serverTimestamp() },
      { merge: true }
    );
    baseline = initial;
    publish(initial);
  }

  ready = true;

  // Publish once more after page modules have had a chance to register listeners.
  queueMicrotask(() => publish(baseline || localState()));

  onSnapshot(
    stateRef,
    (snapshot) => {
      if (!snapshot.exists()) return;
      const remote = normalize(snapshot.data());

      if (saving) {
        queuedRemote = remote;
        return;
      }

      if (!equal(remote, localState())) applyRemote(remote, true);
      else baseline = remote;
    },
    (error) => console.error("Firebase live sync failed:", error)
  );
} catch (error) {
  ready = true;
  console.error("Firebase initialization failed:", error);
}
