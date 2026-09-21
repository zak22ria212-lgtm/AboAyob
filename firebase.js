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
const keys = new Set(["final_bookings_v5","final_subjects_v5","final_school_v5","final_owner_v5","final_notif_email","final_notif_phone"]);

let ready = false;
let applyingRemote = false;
let pendingLocal = false;
let saving = false;
let saveAgain = false;
let settingsTimer = null;
let baseline = null;

const parse = (v, fallback) => { try { return v ? JSON.parse(v) : fallback; } catch { return fallback; } };
const normalize = (s = {}) => ({
  bookings: Array.isArray(s.bookings) ? s.bookings : [],
  subjects: Array.isArray(s.subjects) ? s.subjects : [],
  schoolName: s.schoolName || "",
  ownerEmail: s.ownerEmail || null,
  notifEmail: s.notifEmail || "",
  notifPhone: s.notifPhone || ""
});
const localState = () => normalize({
  bookings: parse(localStorage.getItem("final_bookings_v5"), []),
  subjects: parse(localStorage.getItem("final_subjects_v5"), []),
  schoolName: localStorage.getItem("final_school_v5"),
  ownerEmail: localStorage.getItem("final_owner_v5"),
  notifEmail: localStorage.getItem("final_notif_email"),
  notifPhone: localStorage.getItem("final_notif_phone")
});
const equal = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const mapBookings = list => new Map((list || []).filter(x => x && x.id).map(x => [String(x.id), x]));

function publish(state) {
  window.dispatchEvent(new CustomEvent("firebase-state-updated", { detail: normalize(state) }));
}
function applyRemote(state, notify = true) {
  const s = normalize(state);
  applyingRemote = true;
  try {
    localStorage.setItem("final_bookings_v5", JSON.stringify(s.bookings));
    localStorage.setItem("final_subjects_v5", JSON.stringify(s.subjects));
    localStorage.setItem("final_school_v5", s.schoolName);
    s.ownerEmail ? localStorage.setItem("final_owner_v5", s.ownerEmail) : localStorage.removeItem("final_owner_v5");
    localStorage.setItem("final_notif_email", s.notifEmail);
    localStorage.setItem("final_notif_phone", s.notifPhone);
    baseline = s;
  } finally { applyingRemote = false; }
  if (notify) publish(s);
}

async function saveChanges() {
  if (!ready || applyingRemote) return;
  if (saving) { saveAgain = true; return; }
  saving = true;
  pendingLocal = true;
  const local = localState();
  const base = normalize(baseline || local);
  const baseMap = mapBookings(base.bookings);
  const localMap = mapBookings(local.bookings);
  const removed = [...baseMap.keys()].filter(id => !localMap.has(id));
  const changed = [...localMap.entries()].filter(([id,item]) => !baseMap.has(id) || !equal(baseMap.get(id), item)).map(([,item]) => item);

  try {
    const merged = await runTransaction(db, async tx => {
      const snap = await tx.get(stateRef);
      const remote = normalize(snap.exists() ? snap.data() : {});
      const remoteMap = mapBookings(remote.bookings);
      removed.forEach(id => remoteMap.delete(id));
      changed.forEach(item => {
        const conflict = [...remoteMap.values()].some(x => String(x.id) !== String(item.id) && x.date === item.date && Number(x.period) === Number(item.period));
        if (!conflict) remoteMap.set(String(item.id), item);
      });
      const result = {
        bookings: [...remoteMap.values()],
        subjects: equal(local.subjects, base.subjects) ? remote.subjects : local.subjects,
        schoolName: local.schoolName === base.schoolName ? remote.schoolName : local.schoolName,
        ownerEmail: local.ownerEmail === base.ownerEmail ? remote.ownerEmail : local.ownerEmail,
        notifEmail: local.notifEmail === base.notifEmail ? remote.notifEmail : local.notifEmail,
        notifPhone: local.notifPhone === base.notifPhone ? remote.notifPhone : local.notifPhone
      };
      tx.set(stateRef, { ...result, updatedAt: serverTimestamp() }, { merge: true });
      return result;
    });
    applyRemote(merged, true);
  } catch (error) {
    console.error("Firebase save failed:", error);
    publish(localState());
  } finally {
    saving = false;
    pendingLocal = false;
    if (saveAgain) { saveAgain = false; queueMicrotask(saveChanges); }
  }
}

function requestSave(key) {
  if (!ready || applyingRemote) return;
  pendingLocal = true;
  if (key === "final_bookings_v5") {
    clearTimeout(settingsTimer);
    queueMicrotask(saveChanges);
  } else {
    clearTimeout(settingsTimer);
    settingsTimer = setTimeout(saveChanges, 300);
  }
}

const nativeSet = Storage.prototype.setItem;
const nativeRemove = Storage.prototype.removeItem;
Storage.prototype.setItem = function(key, value) {
  nativeSet.call(this, key, value);
  if (this === localStorage && keys.has(String(key))) requestSave(String(key));
};
Storage.prototype.removeItem = function(key) {
  nativeRemove.call(this, key);
  if (this === localStorage && keys.has(String(key))) requestSave(String(key));
};

try {
  const first = await getDoc(stateRef);
  if (first.exists()) applyRemote(first.data(), true);
  else {
    const initial = localState();
    await setDoc(stateRef, { ...initial, updatedAt: serverTimestamp() }, { merge: true });
    baseline = initial;
    publish(initial);
  }
  ready = true;

  onSnapshot(stateRef, snap => {
    if (!snap.exists()) return;
    const remote = normalize(snap.data());
    if (pendingLocal || saving) return;
    if (!equal(remote, localState())) applyRemote(remote, true);
    else baseline = remote;
  }, error => console.error("Firebase live sync failed:", error));
} catch (error) {
  ready = true;
  console.error("Firebase initialization failed:", error);
}


// 1. استيراد الدالة من ملف firebase_2.js في بداية الملف
import { addBookingDirectly } from './firebase_2.js';

// 2. ربط الدالة بزر الحجز أو نموذج الحجز (Form)
const bookingForm = document.getElementById('bookingForm'); // استخدم id النموذج لديك

bookingForm.addEventListener('submit', async function(event) {
  event.preventDefault(); // منع إعادة تحميل الصفحة

  // جمع بيانات الحجز من المدخلات
  const bookingData = {
    id: Date.now().toString(),
    name: document.getElementById('nameInput').value,
    date: document.getElementById('dateInput').value,
    // ... باقي حقول الحجز الخاصة بك
  };

  // 3. استدعاء الكود الأخير هنا بدلاً من الاعتماد على localStorage
  const success = await addBookingDirectly(bookingData);
  
  if (success) {
    alert("تم الحجز بنجاح!");
    bookingForm.reset(); // إعادة ضبط النموذج
  } else {
    alert("حدث خطأ أثناء الحفظ، يرجى المحاولة مرة أخرى.");
  }
});