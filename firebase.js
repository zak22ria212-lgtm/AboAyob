import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  onSnapshot,
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
  "final_bookings_v5",
  "final_subjects_v5",
  "final_school_v5",
  "final_owner_v5",
  "final_notif_email",
  "final_notif_phone"
]);

let applyingRemoteState = false;
let writeTimer = null;
let lastRemoteJson = "";

function parseJson(value, fallback) {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function readLocalState() {
  return {
    bookings: parseJson(localStorage.getItem("final_bookings_v5"), []),
    subjects: parseJson(localStorage.getItem("final_subjects_v5"), []),
    schoolName: localStorage.getItem("final_school_v5") || "",
    ownerEmail: localStorage.getItem("final_owner_v5") || null,
    notifEmail: localStorage.getItem("final_notif_email") || "",
    notifPhone: localStorage.getItem("final_notif_phone") || ""
  };
}

function normalizedJson(state) {
  return JSON.stringify({
    bookings: Array.isArray(state.bookings) ? state.bookings : [],
    subjects: Array.isArray(state.subjects) ? state.subjects : [],
    schoolName: state.schoolName || "",
    ownerEmail: state.ownerEmail || null,
    notifEmail: state.notifEmail || "",
    notifPhone: state.notifPhone || ""
  });
}

function applyRemoteState(state) {
  applyingRemoteState = true;
  try {
    localStorage.setItem("final_bookings_v5", JSON.stringify(state.bookings || []));
    localStorage.setItem("final_subjects_v5", JSON.stringify(state.subjects || []));
    localStorage.setItem("final_school_v5", state.schoolName || "");
    if (state.ownerEmail) localStorage.setItem("final_owner_v5", state.ownerEmail);
    else localStorage.removeItem("final_owner_v5");
    localStorage.setItem("final_notif_email", state.notifEmail || "");
    localStorage.setItem("final_notif_phone", state.notifPhone || "");
  } finally {
    applyingRemoteState = false;
  }
}

async function saveLocalState() {
  const state = readLocalState();
  lastRemoteJson = normalizedJson(state);
  await setDoc(stateRef, { ...state, updatedAt: serverTimestamp() }, { merge: true });
}

function scheduleSave() {
  if (applyingRemoteState) return;
  clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    saveLocalState().catch((error) => console.error("Firebase save failed:", error));
  }, 350);
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
    const remoteState = initialSnapshot.data();
    lastRemoteJson = normalizedJson(remoteState);
    applyRemoteState(remoteState);
  } else {
    await saveLocalState();
  }

  onSnapshot(stateRef, (snapshot) => {
    if (!snapshot.exists()) return;
    const remoteState = snapshot.data();
    const remoteJson = normalizedJson(remoteState);
    const localJson = normalizedJson(readLocalState());
    lastRemoteJson = remoteJson;
    if (!applyingRemoteState && remoteJson !== localJson) {
      applyRemoteState(remoteState);
      window.location.reload();
    }
  }, (error) => console.error("Firebase live sync failed:", error));
} catch (error) {
  console.error("Firebase initialization failed; the site will continue with local storage:", error);
}
