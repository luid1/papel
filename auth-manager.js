/**
 * ═══════════════════════════════════════════════════════════════
 *  LUMIN SaaS — Auth Manager & Route Guard
 *  Arquivo: auth-manager.js
 *
 *  Responsabilidades:
 *  • Gerenciar o fluxo: Preloader → Validação → Login → Rota
 *  • Garantir que NENHUMA view seja injetada sem sessão válida
 *  • Forçar logout e travar tela em acesso não autorizado
 *  • Expor API global: LuminAuth
 * ═══════════════════════════════════════════════════════════════
 */

import { db, auth } from "./firebase-config.js";
import {
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  doc,
  getDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ─── CONSTANTES ───────────────────────────────────────────────
const MASTER_USERNAME = "luidoliver";
const MASTER_ROLE     = "master";

// ─── ESTADO INTERNO (nunca exposto ao DOM diretamente) ────────
let _currentUser  = null;   // objeto do Firestore (não o Firebase Auth)
let _authResolved = false;  // impede race conditions

// ─── HELPERS DOM ──────────────────────────────────────────────
const el  = (id) => document.getElementById(id);
const show = (id, display = "flex") => { const e = el(id); if (e) e.style.display = display; };
const hide = (id)  => { const e = el(id); if (e) e.style.display = "none"; };

// ─── CAMADAS DE TELA ──────────────────────────────────────────
function showLayer(name) {
  // Garante que apenas UMA camada seja visível por vez.
  // Nenhuma camada é injetada — todas existem no DOM mas ocultas por CSS.
  ["preloader", "login-screen", "admin-panel", "app-shell-wrapper"].forEach(id => {
    const e = el(id);
    if (!e) return;
    if (id === name) {
      e.classList.add("active");
    } else {
      e.classList.remove("active");
    }
  });
}

// ─── PRELOADER ────────────────────────────────────────────────
function hidePreloader() {
  const pl = el("preloader");
  if (!pl) return;
  pl.classList.add("out");
  setTimeout(() => { pl.style.display = "none"; }, 650);
}

// ─── LOADING OVERLAY ──────────────────────────────────────────
export function showLoading(msg = "Verificando sessão...") {
  const overlay = el("loadingOverlay");
  const msgEl   = el("lo-msg-text");
  if (overlay) overlay.classList.add("active");
  if (msgEl)   msgEl.textContent = msg;
}

export function hideLoading() {
  const overlay = el("loadingOverlay");
  if (overlay) overlay.classList.remove("active");
}

// ─── TRAVA DE SEGURANÇA ───────────────────────────────────────
/**
 * Chamado quando alguém tenta acessar uma rota sem permissão.
 * Faz logout completo, limpa estado e exibe tela de acesso negado.
 */
async function _securityBreach(reason = "Acesso não autorizado") {
  console.warn(`[LuminAuth] SECURITY BREACH: ${reason}`);

  // Limpa estado
  _currentUser = null;
  sessionStorage.clear();

  // Desloga do Firebase Auth (se estiver logado)
  try { await signOut(auth); } catch (_) {}

  // Mostra tela de acesso negado no lugar do login
  hideLoading();
  const loginScreen = el("login-screen");
  if (loginScreen) {
    loginScreen.classList.add("active");
    // Injeta aviso temporário de acesso bloqueado
    const errEl = el("l-err");
    if (errEl) {
      errEl.textContent = "⛔ Acesso bloqueado. Sessão encerrada por segurança.";
      errEl.style.display = "block";
      setTimeout(() => { errEl.textContent = "⚠ Credenciais inválidas."; errEl.style.display = "none"; }, 5000);
    }
  }

  // Remove todas as views ativas
  ["admin-panel", "app-shell-wrapper"].forEach(id => {
    const e = el(id);
    if (e) e.classList.remove("active");
  });
}

// ─── ROTEADOR SEGURO ──────────────────────────────────────────
/**
 * Recebe um usuário validado do Firestore e roteia para a view correta.
 * NUNCA renderiza nada sem um objeto _currentUser válido.
 */
async function _secureRoute(user) {
  if (!user || !user.role) {
    await _securityBreach("Objeto de usuário inválido ou sem role.");
    return;
  }

  _currentUser = user;

  hideLoading();
  hidePreloader();

  if (user.role === MASTER_ROLE) {
    // Rota exclusiva: Admin Master
    showLayer("admin-panel");
    // Dispara evento para o módulo Admin carregar os dados
    window.dispatchEvent(new CustomEvent("lumin:admin-ready", { detail: { user } }));
  } else if (user.role === "tenant" && user.active === true) {
    // Rota de cliente (próxima fase)
    showLayer("app-shell-wrapper");
    window.dispatchEvent(new CustomEvent("lumin:tenant-ready", { detail: { user } }));
  } else if (user.active === false) {
    await _securityBreach(`Conta suspensa: ${user.username}`);
  } else {
    await _securityBreach(`Role desconhecida: ${user.role}`);
  }
}

// ─── VALIDAÇÃO DE SESSÃO ──────────────────────────────────────
/**
 * Verifica se há uma sessão Firebase Auth ativa e busca o
 * perfil do usuário no Firestore. Fluxo principal do boot.
 */
function _validateSession() {
  showLoading("Verificando sessão...");

  onAuthStateChanged(auth, async (firebaseUser) => {
    if (_authResolved) return; // evita chamadas duplas
    _authResolved = true;

    if (!firebaseUser) {
      // Nenhuma sessão ativa → tela de login
      hideLoading();
      hidePreloader();
      showLayer("login-screen");
      return;
    }

    // Sessão existe — busca perfil no Firestore para validar role
    try {
      showLoading("Carregando perfil...");
      const userRef  = doc(db, "users", firebaseUser.uid);
      const userSnap = await getDoc(userRef);

      if (!userSnap.exists()) {
        // UID autenticado mas sem documento no Firestore = brecha
        await _securityBreach("UID sem perfil no Firestore.");
        return;
      }

      const userData = { uid: firebaseUser.uid, ...userSnap.data() };
      await _secureRoute(userData);

    } catch (err) {
      console.error("[LuminAuth] Erro ao validar sessão:", err);
      await _securityBreach("Falha na comunicação com o banco de dados.");
    }
  });
}

// ─── LOGIN ────────────────────────────────────────────────────
/**
 * Realiza login com e-mail e senha via Firebase Authentication.
 * O utilizador insere o e-mail completo no formulário (ex: luidoliver@lumin.com).
 */
async function _doLogin(email, password) {
  email = email.trim().toLowerCase();

  try {
    showLoading("Autenticando...");

    const credential = await signInWithEmailAndPassword(auth, email, password);
    const uid        = credential.user.uid;

    // Busca perfil no Firestore
    const userRef  = doc(db, "users", uid);
    const userSnap = await getDoc(userRef);

    if (!userSnap.exists()) {
      await signOut(auth);
      throw new Error("Perfil não encontrado no banco de dados.");
    }

    const userData = { uid, ...userSnap.data() };

    // Verificação extra: tenta acessar admin sem ser master?
    if (userData.role !== MASTER_ROLE && userData.role !== "tenant") {
      await signOut(auth);
      throw new Error(`Role inválida: ${userData.role}`);
    }

    // Verificação extra: conta suspensa?
    if (userData.active === false) {
      await signOut(auth);
      throw new Error("Conta suspensa pelo administrador.");
    }

    _authResolved = false; // permite onAuthStateChanged agir
    await _secureRoute(userData);
    return { success: true };

  } catch (err) {
    hideLoading();
    console.warn("[LuminAuth] Falha no login:", err.message);
    return { success: false, message: err.message };
  }
}

// ─── LOGOUT ───────────────────────────────────────────────────
async function _doLogout() {
  showLoading("Encerrando sessão...");
  window.dispatchEvent(new CustomEvent("lumin:logout"));
  _currentUser  = null;
  _authResolved = false;
  sessionStorage.clear();

  try { await signOut(auth); } catch (_) {}

  hideLoading();
  hidePreloader();

  // Limpa views ativas
  ["admin-panel", "app-shell-wrapper"].forEach(id => {
    const e = el(id);
    if (e) e.classList.remove("active");
  });

  showLayer("login-screen");
}

// ─── GETTER DE SESSÃO (para outros módulos) ───────────────────
function _getSession() {
  // Retorna uma CÓPIA do objeto (não a referência original)
  return _currentUser ? { ..._currentUser } : null;
}

// ─── GUARD DE ROTA (para módulos externos) ────────────────────
/**
 * Verifica se o usuário atual tem a role exigida.
 * Se não tiver, dispara breach de segurança imediatamente.
 */
async function _requireRole(role) {
  const session = _getSession();
  if (!session || session.role !== role) {
    await _securityBreach(`Tentativa de acesso à rota "${role}" sem permissão.`);
    return false;
  }
  return true;
}

// ─── BOOT ─────────────────────────────────────────────────────
function _boot() {
  // Aguarda animação do preloader (3s) para então validar sessão
  const PRELOADER_DURATION = 3100;
  setTimeout(_validateSession, PRELOADER_DURATION);
}

// ─── API PÚBLICA ──────────────────────────────────────────────
window.LuminAuth = {
  login:       _doLogin,
  logout:      _doLogout,
  getSession:  _getSession,
  requireRole: _requireRole,
  showLoading,
  hideLoading
};

// ─── INICIALIZAÇÃO ────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", _boot);
