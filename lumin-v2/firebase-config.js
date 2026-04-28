/**
 * ═══════════════════════════════════════════════════════════════
 *  LUMIN SaaS — Firebase V10 Modular Config
 *  Arquivo: firebase-config.js
 *  Instrução: Substitua os valores abaixo pelas credenciais do
 *             seu projeto no Firebase Console.
 * ═══════════════════════════════════════════════════════════════
 */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getFirestore }   from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getAuth }        from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

// ─── SUBSTITUA COM SUAS CREDENCIAIS ───────────────────────────
const firebaseConfig = {
  apiKey:            "AIzaSyAeAOjFZSHy28uZFgH1PyoJaxPRyS-N1Kw",
  authDomain:        "lumin-a5b29.firebaseapp.com",
  projectId:         "lumin-a5b29",
  storageBucket:     "lumin-a5b29.firebasestorage.app",
  messagingSenderId: "413860601418",
  appId:             "1:413860601418:web:0b5cce923491e50fdf50b3"
};
// ──────────────────────────────────────────────────────────────

const app  = initializeApp(firebaseConfig);
const db   = getFirestore(app);
const auth = getAuth(app);

export { app, db, auth };
