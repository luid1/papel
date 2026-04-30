/**
 * ═══════════════════════════════════════════════════════════════
 *  LUMIN SaaS — Admin Controller (CRUD + Filtro)
 *  Arquivo: admin-controller.js
 * ═══════════════════════════════════════════════════════════════
 */

import { db, auth } from "./firebase-config.js";
import {
  collection, doc, getDocs, getDoc,
  setDoc, updateDoc, deleteDoc,
  writeBatch, serverTimestamp, query, orderBy
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  deleteUser as deleteFirebaseUser
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

let _allUsers     = [];
let _allCompanies = {};
let _editingUserId = null;

const el = (id) => document.getElementById(id);

function toast(msg, type = "ok") {
  const t = el("toast");
  if (!t) return;
  t.textContent = msg;
  t.className = type === "err" ? "show err" : "show";
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.className = ""; }, 3500);
}

function setMsg(elementId, msg, ok = true) {
  const e = el(elementId);
  if (!e) return;
  e.style.display    = msg ? "block" : "none";
  e.textContent      = msg;
  e.style.background = ok ? "rgba(0,229,160,.1)"           : "rgba(255,91,112,.1)";
  e.style.border     = ok ? "1px solid rgba(0,229,160,.25)" : "1px solid rgba(255,91,112,.25)";
  e.style.color      = ok ? "var(--success)"                : "var(--alert)";
}

function btn(id, loading = false, label = "") {
  const b = el(id);
  if (!b) return;
  b.disabled      = loading;
  b.style.opacity = loading ? "0.6" : "1";
  if (label) b.textContent = loading ? "Aguarde..." : label;
}

function slugify(str) {
  return str.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "").slice(0, 32);
}

// ─── CARREGAR EMPRESAS ────────────────────────────────────────
async function loadCompanies() {
  try {
    const snap = await getDocs(collection(db, "companies"));
    _allCompanies = {};
    snap.forEach(d => { _allCompanies[d.id] = d.data(); });
    return _allCompanies;
  } catch (err) {
    console.error("[Admin] Erro ao carregar empresas:", err);
    return {};
  }
}

// ─── POPULAR SELECT DE EMPRESAS ───────────────────────────────
function populateCompanySelect() {
  const select = el("adm-add-user-company");
  if (!select) return;
  const current = select.value;
  select.innerHTML = `<option value="">Seleccione a empresa...</option>` +
    Object.entries(_allCompanies).map(([id, c]) =>
      `<option value="${id}" ${current === id ? "selected" : ""}>${c.name}</option>`
    ).join("");
}

// ─── RENDERIZAR LISTA DE EMPRESAS ────────────────────────────
async function renderCompanies() {
  const list = el("adm-companies-list");
  if (!list) return;

  await loadCompanies();
  const entries = Object.entries(_allCompanies);

  if (!entries.length) {
    list.innerHTML = `<p style="text-align:center;padding:40px;color:var(--muted);font-size:13px;">Nenhuma empresa cadastrada ainda.</p>`;
    return;
  }

  list.innerHTML = entries.map(([id, c]) => `
    <div class="company-row" data-company-id="${id}">
      <div class="company-color-dot" style="background:${c.themeColor || 'var(--accent)'}"></div>
      <div class="company-info">
        <div class="company-name">${c.name}</div>
        <div class="company-meta">${id} · ${c.phone || "—"}</div>
      </div>
      <span class="badge-status ${c.active !== false ? 'badge-active' : 'badge-inactive'}">
        ${c.active !== false ? "Ativa" : "Inativa"}
      </span>
      <div style="display:flex;gap:6px;">
        <button class="btn-act edit" data-action="edit-company" data-id="${id}" title="Editar empresa">✎</button>
        <button class="btn-act del"  data-action="del-company"  data-id="${id}" title="Deletar empresa">✕</button>
      </div>
    </div>
  `).join("");

  populateCompanySelect();
}

// ─── CARREGAR E RENDERIZAR UTILIZADORES ──────────────────────
async function loadUsers() {
  try {
    const snap = await getDocs(query(collection(db, "users"), orderBy("createdAt", "desc")));
    _allUsers = [];
    snap.forEach(d => _allUsers.push({ uid: d.id, ...d.data() }));
    renderUsersTable(_allUsers);

    const counter = el("adm-user-count");
    if (counter) counter.textContent = `${_allUsers.length} utilizador(es)`;
  } catch (err) {
    console.error("[Admin] Erro ao carregar usuários:", err);
    const tbody = el("adm-users-tbody");
    if (tbody) tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--alert);padding:20px;">Erro ao carregar usuários.</td></tr>`;
  }
}

function renderUsersTable(users) {
  const tbody = el("adm-users-tbody");
  if (!tbody) return;

  if (!users.length) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:28px;font-size:13px;">Nenhum usuário encontrado.</td></tr>`;
    return;
  }

  tbody.innerHTML = users.map(u => {
    const company   = u.companyId ? (_allCompanies[u.companyId]?.name || u.companyId) : "—";
    const roleLabel = { master: "Master", tenant: "Empresa" }[u.role] || u.role;
    const roleColor = u.role === "master" ? "var(--accent)" : "var(--purple)";

    return `
      <tr data-uid="${u.uid}">
        <td>
          <div style="font-weight:700;font-size:14px;">${u.displayName || u.username}</div>
          <div style="font-size:11px;color:var(--muted);">@${u.username}</div>
        </td>
        <td style="font-size:13px;">${company}</td>
        <td>
          <span style="font-size:10px;font-weight:800;padding:4px 10px;border-radius:20px;background:rgba(0,212,255,.1);color:${roleColor};border:1px solid ${roleColor}33;text-transform:uppercase;letter-spacing:.5px;">
            ${roleLabel}
          </span>
        </td>
        <td>
          <span class="badge-status ${u.active !== false ? 'badge-active' : 'badge-inactive'}">
            ${u.active !== false ? "Ativo" : "Suspenso"}
          </span>
        </td>
        <td>
          <div class="td-actions">
            <button class="btn-act edit" data-action="edit-user" data-uid="${u.uid}" title="Editar">✎</button>
            <button class="btn-act" data-action="toggle-user" data-uid="${u.uid}"
              style="color:var(--warning);border-color:rgba(255,179,71,.2);"
              title="${u.active !== false ? 'Suspender' : 'Reativar'}">
              ${u.active !== false ? "⏸" : "▶"}
            </button>
            <button class="btn-act" data-action="reset-pass" data-uid="${u.uid}"
              data-email="${u.email || ''}" title="Resetar senha"
              style="color:var(--purple);border-color:rgba(176,133,245,.2);">🔑</button>
            <button class="btn-act del" data-action="del-user" data-uid="${u.uid}" title="Deletar">✕</button>
          </div>
        </td>
      </tr>
    `;
  }).join("");
}

// ─── FILTRO INSTANTÂNEO ───────────────────────────────────────
function filterUsers(query) {
  // ✅ CORREÇÃO BUG BUSCA: (query || "") evita crash quando o valor
  //    chega como undefined. Com campo vazio, reseta para todos os
  //    registros originais em vez de exibir "nenhum encontrado".
  const q = (query || "").toLowerCase().trim();
  if (!q) { renderUsersTable(_allUsers); return; }
  const filtered = _allUsers.filter(u => {
    const name    = (u.displayName || u.username || "").toLowerCase();
    const company = (u.companyId ? (_allCompanies[u.companyId]?.name || "") : "").toLowerCase();
    const role    = (u.role || "").toLowerCase();
    return name.includes(q) || company.includes(q) || role.includes(q);
  });
  renderUsersTable(filtered);
}

// ─── CRIAR EMPRESA + UTILIZADOR (nova empresa) ───────────────
async function createCompanyAndUser() {
  const name     = el("adm-name")?.value.trim();
  const phone    = el("adm-phone")?.value.trim();
  const username = el("adm-login")?.value.trim().toLowerCase();
  const password = el("adm-pass")?.value.trim();
  const color    = el("adm-color-hex")?.value.trim() || "#00d4ff";

  if (!name || !username || !password) {
    setMsg("adm-msg", "Preencha Nome da Empresa, Login e Senha.", false);
    return;
  }
  if (password.length < 6) {
    setMsg("adm-msg", "A senha deve ter no mínimo 6 caracteres.", false);
    return;
  }

  btn("btn-adm-save", true);
  setMsg("adm-msg", "");

  try {
    const email      = `${username}@lumin.com`;
    const credential = await createUserWithEmailAndPassword(auth, email, password);
    const uid        = credential.user.uid;
    const companyId  = slugify(name) + "-" + Date.now().toString(36);

    const batch = writeBatch(db);
    batch.set(doc(db, "companies", companyId), {
      name, phone: phone || "", themeColor: color, active: true, createdAt: serverTimestamp()
    });
    batch.set(doc(db, "users", uid), {
      username, displayName: name, email,
      role: "tenant", companyId, active: true, createdAt: serverTimestamp()
    });
    await batch.commit();

    setMsg("adm-msg", `✓ Empresa "${name}" e utilizador "@${username}" criados!`, true);
    ["adm-name","adm-phone","adm-login","adm-pass"].forEach(id => { if (el(id)) el(id).value = ""; });
    if (el("adm-color-hex")) el("adm-color-hex").value = "#00d4ff";
    if (el("adm-color"))     el("adm-color").value     = "#00d4ff";

    await renderCompanies();
    await loadUsers();
    toast(`Empresa "${name}" criada!`);

  } catch (err) {
    console.error("[Admin] Erro ao criar empresa:", err);
    setMsg("adm-msg", err.code === "auth/email-already-in-use"
      ? `O login "@${username}" já está em uso.`
      : `Erro: ${err.message}`, false);
  } finally {
    btn("btn-adm-save", false);
  }
}

// ─── ADICIONAR UTILIZADOR A EMPRESA EXISTENTE ────────────────
async function createUserForCompany() {
  const companyId   = el("adm-add-user-company")?.value;
  const username    = el("adm-add-user-login")?.value.trim().toLowerCase();
  const displayName = el("adm-add-user-name")?.value.trim();
  const password    = el("adm-add-user-pass")?.value.trim();

  if (!companyId || !username || !displayName || !password) {
    setMsg("adm-add-user-msg", "Preencha todos os campos.", false);
    return;
  }
  if (password.length < 6) {
    setMsg("adm-add-user-msg", "A senha deve ter no mínimo 6 caracteres.", false);
    return;
  }

  btn("btn-adm-add-user-save", true);
  setMsg("adm-add-user-msg", "");

  try {
    const email      = `${username}@lumin.com`;
    const credential = await createUserWithEmailAndPassword(auth, email, password);
    const uid        = credential.user.uid;

    await setDoc(doc(db, "users", uid), {
      username, displayName, email,
      role: "tenant", companyId, active: true, createdAt: serverTimestamp()
    });

    const companyName = _allCompanies[companyId]?.name || companyId;
    setMsg("adm-add-user-msg", `✓ "@${username}" adicionado à empresa "${companyName}"!`, true);
    ["adm-add-user-login","adm-add-user-name","adm-add-user-pass"].forEach(id => {
      if (el(id)) el(id).value = "";
    });

    await loadUsers();
    toast(`Utilizador "@${username}" criado!`);

  } catch (err) {
    console.error("[Admin] Erro ao criar utilizador:", err);
    setMsg("adm-add-user-msg", err.code === "auth/email-already-in-use"
      ? `O login "@${username}" já está em uso.`
      : `Erro: ${err.message}`, false);
  } finally {
    btn("btn-adm-add-user-save", false);
  }
}

// ─── ABRIR MODAL DE EDIÇÃO ────────────────────────────────────
async function openEditUserModal(uid) {
  const guard = await window.LuminAuth?.requireRole("master");
  if (guard === false) return;
  _editingUserId = uid;

  try {
    const snap = await getDoc(doc(db, "users", uid));
    if (!snap.exists()) { toast("Usuário não encontrado.", "err"); return; }
    const u = { uid, ...snap.data() };

    if (el("edit-display-name")) el("edit-display-name").value = u.displayName || "";
    if (el("edit-username"))     el("edit-username").value     = u.username    || "";
    if (el("edit-role"))         el("edit-role").value         = u.role        || "tenant";
    if (el("edit-active"))       el("edit-active").value       = String(u.active !== false);

    const companySelect = el("edit-company");
    if (companySelect) {
      companySelect.innerHTML = `<option value="">Sem empresa</option>` +
        Object.entries(_allCompanies).map(([id, c]) =>
          `<option value="${id}" ${u.companyId === id ? "selected" : ""}>${c.name}</option>`
        ).join("");
    }

    el("modal-edit-user")?.classList.add("active");
  } catch (err) {
    console.error("[Admin] Erro ao abrir modal:", err);
    toast("Erro ao carregar dados do usuário.", "err");
  }
}

// ─── SALVAR EDIÇÃO ────────────────────────────────────────────
async function saveUserEdit() {
  if (!_editingUserId) return;
  const data = {
    displayName: el("edit-display-name")?.value.trim() || "",
    role:        el("edit-role")?.value        || "tenant",
    companyId:   el("edit-company")?.value     || "",
    active:      el("edit-active")?.value === "true"
  };
  if (!data.displayName) { toast("Nome obrigatório.", "err"); return; }
  btn("btn-save-edit", true);
  try {
    await updateDoc(doc(db, "users", _editingUserId), { ...data, updatedAt: serverTimestamp() });
    toast("Usuário atualizado com sucesso!");
    closeEditModal();
    await loadUsers();
  } catch (err) {
    console.error("[Admin] Erro ao salvar edição:", err);
    toast("Erro ao atualizar usuário.", "err");
  } finally {
    btn("btn-save-edit", false);
  }
}

function closeEditModal() {
  el("modal-edit-user")?.classList.remove("active");
  _editingUserId = null;
}

// ─── TOGGLE SUSPEND/REATIVAR ──────────────────────────────────
async function toggleUserActive(uid) {
  const user = _allUsers.find(u => u.uid === uid);
  if (!user) return;
  const newState = user.active === false;
  if (!confirm(`Deseja ${newState ? "reativar" : "suspender"} o utilizador @${user.username}?`)) return;
  try {
    await updateDoc(doc(db, "users", uid), { active: newState, updatedAt: serverTimestamp() });
    toast(`Utilizador @${user.username} ${newState ? "reativado" : "suspenso"}.`);
    await loadUsers();
  } catch (err) {
    toast("Erro ao alterar status.", "err");
  }
}

// ─── RESET DE SENHA ───────────────────────────────────────────
async function resetUserPassword(uid, email) {
  if (!email) { toast("E-mail não encontrado.", "err"); return; }
  if (!confirm(`Enviar e-mail de reset para ${email}?`)) return;
  try {
    await sendPasswordResetEmail(auth, email);
    toast(`Reset enviado para ${email}.`);
  } catch (err) {
    toast("Erro ao enviar reset de senha.", "err");
  }
}

// ─── DELETAR UTILIZADOR ───────────────────────────────────────
async function deleteUser(uid) {
  const user = _allUsers.find(u => u.uid === uid);
  if (!user) return;
  if (!confirm(`ATENÇÃO: Deletar permanentemente @${user.username}?`)) return;
  try {
    await deleteDoc(doc(db, "users", uid));
    toast(`Utilizador @${user.username} deletado.`);
    await loadUsers();
  } catch (err) {
    toast("Erro ao deletar utilizador.", "err");
  }
}

// ─── DELETAR EMPRESA ──────────────────────────────────────────
async function deleteCompany(companyId) {
  const company = _allCompanies[companyId];
  if (!company) return;
  if (!confirm(`ATENÇÃO: Deletar empresa "${company.name}"?`)) return;
  try {
    await deleteDoc(doc(db, "companies", companyId));
    toast(`Empresa "${company.name}" deletada.`);
    await renderCompanies();
    await loadUsers();
  } catch (err) {
    toast("Erro ao deletar empresa.", "err");
  }
}

// ─── BIND DE EVENTOS ─────────────────────────────────────────
function bindEvents() {
  el("btn-adm-save")?.addEventListener("click", createCompanyAndUser);
  el("btn-adm-add-user-save")?.addEventListener("click", createUserForCompany);

  el("adm-color")?.addEventListener("input", (e) => {
    if (el("adm-color-hex")) el("adm-color-hex").value = e.target.value;
  });
  el("adm-color-hex")?.addEventListener("input", (e) => {
    const v = e.target.value;
    if (/^#[0-9A-Fa-f]{6}$/.test(v) && el("adm-color")) el("adm-color").value = v;
  });

  el("btn-adm-refresh")?.addEventListener("click", async () => {
    await renderCompanies();
    await loadUsers();
    toast("Dados atualizados.");
  });

  el("adm-search")?.addEventListener("input", (e) => filterUsers(e.target.value));
  el("btn-admin-logout")?.addEventListener("click", () => window.LuminAuth?.logout());

  document.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-action]");
    if (!b) return;
    switch (b.dataset.action) {
      case "edit-user":    await openEditUserModal(b.dataset.uid); break;
      case "toggle-user":  await toggleUserActive(b.dataset.uid);  break;
      case "reset-pass":   await resetUserPassword(b.dataset.uid, b.dataset.email); break;
      case "del-user":     await deleteUser(b.dataset.uid);        break;
      case "edit-company": toast("Edição de empresa (próxima fase).", "ok"); break;
      case "del-company":  await deleteCompany(b.dataset.id);      break;
    }
  });

  el("btn-save-edit")?.addEventListener("click", saveUserEdit);
  el("btn-close-edit-modal")?.addEventListener("click", closeEditModal);
  el("modal-edit-user")?.addEventListener("click", (e) => {
    if (e.target === el("modal-edit-user")) closeEditModal();
  });
}

// ─── INICIALIZAÇÃO ────────────────────────────────────────────
window.addEventListener("lumin:admin-ready", async () => {
  const ok = await window.LuminAuth?.requireRole("master");
  if (!ok) return;

  await loadCompanies();
  await loadUsers();
  await renderCompanies();
  bindEvents();
  setTimeout(()=>{ bindFeatEvents(); populateFeatSelect(); }, 300);
});

// ─── FEATURES POR EMPRESA ─────────────────────────────────────
let _featCompanyId = null;
let _featData      = {};

function populateFeatSelect() {
  const sel = el("adm-feat-company");
  if (!sel) return;
  sel.innerHTML = `<option value="">Seleccione a empresa...</option>` +
    Object.entries(_allCompanies).map(([id, c]) =>
      `<option value="${id}">${c.name}</option>`
    ).join("");
}

async function loadCompanyFeatures(companyId) {
  _featCompanyId = companyId;
  const company  = _allCompanies[companyId];
  _featData      = company?.features || {};

  const list = el("adm-feat-list");
  if (list) list.style.display = "block";

  // Pagamento de Funcionário: activo por defeito (true) se não definido
  const featFuncionario = el("feat-funcionario");
  if (featFuncionario) featFuncionario.checked = _featData.funcionario !== false;
  updateToggleUI("funcionario", _featData.funcionario !== false);
}

function updateToggleUI(feat, active) {
  const toggle = document.querySelector(`.feat-toggle[data-feat="${feat}"]`);
  if (!toggle) return;
  toggle.style.background = active ? "var(--accent)" : "rgba(255,255,255,.12)";
  const knob = toggle.querySelector("div");
  if (knob) knob.style.left = active ? "23px" : "3px";
}

async function saveFeatConfig() {
  if (!_featCompanyId) return;
  const features = {
    funcionario: el("feat-funcionario")?.checked !== false
  };

  btn("btn-adm-feat-save", true);
  try {
    await updateDoc(doc(db, "companies", _featCompanyId), { features });
    _allCompanies[_featCompanyId] = { ..._allCompanies[_featCompanyId], features };
    setMsg("adm-feat-msg", "✓ Configurações guardadas com sucesso!", true);
    toast("Features actualizadas!");
  } catch (err) {
    setMsg("adm-feat-msg", `Erro: ${err.message}`, false);
  } finally {
    btn("btn-adm-feat-save", false);
  }
}

function bindFeatEvents() {
  el("adm-feat-company")?.addEventListener("change", (e) => {
    if (e.target.value) loadCompanyFeatures(e.target.value);
    else { const l = el("adm-feat-list"); if (l) l.style.display = "none"; }
  });

  document.querySelectorAll(".feat-toggle").forEach(toggle => {
    toggle.addEventListener("click", () => {
      const feat    = toggle.dataset.feat;
      const input   = el(`feat-${feat}`);
      if (!input) return;
      input.checked = !input.checked;
      updateToggleUI(feat, input.checked);
    });
  });

  el("btn-adm-feat-save")?.addEventListener("click", saveFeatConfig);
}




// ═══════════════════════════════════════════════════════════════
//  LUMIN LOG — Dashboard de Caixas Hetros (Admin Master)
// ═══════════════════════════════════════════════════════════════

import {
  collection as fsCollection,
  onSnapshot as fsOnSnapshot,
  query as fsQuery,
  orderBy as fsOrderBy,
  deleteDoc as fsDeleteDoc,
  doc as fsDoc,
  addDoc as fsAddDoc,
  serverTimestamp as fsServerTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

let _llCache = [];
let _llFilter = "all";
let _llUnsub = null;

const llFmt = v => Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const llEl  = id => document.getElementById(id);

function renderLuminLog() {
  const tbody = llEl("ll-tbody");
  if (!tbody) return;

  const data = _llFilter === "all"
    ? _llCache
    : _llCache.filter(r => (r.tipo || "").toUpperCase() === _llFilter.toUpperCase());

  // Totalizadores
  const entradas = _llCache.filter(r => (r.tipo || "").toUpperCase() === "ENTRADA");
  const saidas   = _llCache.filter(r => (r.tipo || "").toUpperCase() === "SAÍDA");
  const revisares = _llCache.filter(r => r.status_processamento === "REVISAR");

  const totalQtdEntrada = entradas.reduce((a, r) => a + (Number(r.quantidade_cx) || 0), 0);
  const totalQtdSaida   = saidas.reduce((a, r) => a + (Number(r.quantidade_cx) || 0), 0);
  const totalValor      = _llCache.reduce((a, r) => a + (Number(r.valor_total) || 0), 0);

  if (llEl("ll-total-entrada")) llEl("ll-total-entrada").textContent = totalQtdEntrada + " cx";
  if (llEl("ll-total-saida"))   llEl("ll-total-saida").textContent   = totalQtdSaida + " cx";
  if (llEl("ll-total-valor"))   llEl("ll-total-valor").textContent   = llFmt(totalValor);
  if (llEl("ll-total-count"))   llEl("ll-total-count").textContent   = _llCache.length;

  const banner = llEl("ll-revisar-banner");
  const bannerCount = llEl("ll-revisar-count");
  if (banner) banner.style.display = revisares.length ? "block" : "none";
  if (bannerCount) bannerCount.textContent = revisares.length;

  if (!data.length) {
    tbody.innerHTML = `<tr><td colspan="10" style="text-align:center;color:var(--muted);padding:28px;font-size:13px;">Nenhum registro encontrado.</td></tr>`;
    return;
  }

  const esc = s => String(s || "—").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  tbody.innerHTML = data.map(r => {
    const isEntrada  = (r.tipo || "").toUpperCase() === "ENTRADA";
    const isRevisar  = r.status_processamento === "REVISAR";
    const tipoColor  = isEntrada ? "var(--success)" : "var(--alert)";
    const tipoBg     = isEntrada ? "rgba(0,229,160,.1)" : "rgba(255,91,112,.1)";
    const tipoBorder = isEntrada ? "rgba(0,229,160,.25)" : "rgba(255,91,112,.25)";

    return `<tr data-ll-id="${r.id}" ${isRevisar ? 'style="background:rgba(255,179,71,.04);"' : ""}>
      <td style="font-family:'DM Mono',monospace;font-size:13px;">${esc(r.data)}</td>
      <td>
        <span style="font-size:11px;font-weight:800;padding:4px 10px;border-radius:20px;background:${tipoBg};color:${tipoColor};border:1px solid ${tipoBorder};text-transform:uppercase;letter-spacing:.5px;">
          ${esc(r.tipo)}
        </span>
      </td>
      <td style="font-weight:700;">${esc(r.cliente)}</td>
      <td style="font-family:'DM Mono',monospace;text-align:center;">
        ${r.quantidade_cx === null || r.quantidade_cx === undefined
          ? '<span style="color:var(--warning);font-weight:700;">?</span>'
          : r.quantidade_cx}
      </td>
      <td>${esc(r.cor)}</td>
      <td style="font-family:'DM Mono',monospace;">${r.valor_unitario ? llFmt(r.valor_unitario) : "—"}</td>
      <td style="font-family:'DM Mono',monospace;font-weight:700;color:${tipoColor};">${llFmt(r.valor_total)}</td>
      <td>${esc(r.conferente)}</td>
      <td>
        ${isRevisar
          ? '<span style="font-size:11px;font-weight:800;padding:3px 8px;border-radius:20px;background:rgba(255,179,71,.1);color:var(--warning);border:1px solid rgba(255,179,71,.3);">REVISAR</span>'
          : '<span style="font-size:11px;font-weight:800;padding:3px 8px;border-radius:20px;background:rgba(0,229,160,.1);color:var(--success);border:1px solid rgba(0,229,160,.2);">✓</span>'}
      </td>
      <td style="text-align:right;">
        <button class="btn-act del" data-ll-del="${r.id}" title="Excluir">✕</button>
      </td>
    </tr>`;
  }).join("");

  // Bind delete
  tbody.querySelectorAll("[data-ll-del]").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (!confirm("Excluir este registro?")) return;
      try {
        await fsDeleteDoc(fsDoc(db, "lumin-log", btn.dataset.llDel));
        toast("Registro excluído.");
      } catch (err) {
        toast("Erro ao excluir.", "err");
      }
    });
  });
}

function initLuminLog() {
  if (_llUnsub) return; // já inicializado

  _llUnsub = fsOnSnapshot(
    fsQuery(fsCollection(db, "lumin-log"), fsOrderBy("createdAt", "desc")),
    snap => {
      _llCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      if (document.getElementById("tab-luminlog")?.classList.contains("active")) {
        renderLuminLog();
      }
    },
    err => console.error("[LuminLog]", err)
  );

  // Filtros rápidos de tipo
  document.querySelectorAll(".ll-filter-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".ll-filter-btn").forEach(b => {
        b.classList.remove("active");
        b.style.borderColor = "var(--border)";
        b.style.background  = "transparent";
        b.style.color       = "var(--muted)";
      });
      btn.classList.add("active");
      btn.style.borderColor = "var(--accent)";
      btn.style.background  = "rgba(0,212,255,.12)";
      btn.style.color       = "var(--accent)";
      _llFilter = btn.dataset.llFilter;
      renderLuminLog();
    });
  });

  document.getElementById("ll-refresh")?.addEventListener("click", renderLuminLog);
  document.getElementById("ll-export-excel")?.addEventListener("click", exportLuminLogExcel);

  // ── Botão + Novo ──────────────────────────────────────────────
  // ✅ CORREÇÃO BOTÃO NOVO: openLLAddModal garante display:grid e
  //    limpeza dos campos antes de exibir o modal. Os listeners do
  //    modal ficam AQUI (admin-controller.js) para evitar conflito
  //    com luminlog-controller.js caso ambos sejam carregados.
  document.getElementById("ll-btn-add")?.addEventListener("click", openLLAddModal);
  document.getElementById("ll-modal-close")?.addEventListener("click", closeLLAddModal);
  document.getElementById("ll-modal-cancel")?.addEventListener("click", closeLLAddModal);
  document.getElementById("ll-btn-save-add")?.addEventListener("click", saveLLRecord);

  // Fechar clicando no backdrop
  document.getElementById("ll-modal-add")?.addEventListener("click", e => {
    if (e.target === document.getElementById("ll-modal-add")) closeLLAddModal();
  });

  // Auto-calcula valor total ao mudar qtd ou valor unitário
  ["ll-add-quantidade", "ll-add-vl-unit"].forEach(id => {
    document.getElementById(id)?.addEventListener("input", () => {
      const qtd  = parseFloat(document.getElementById("ll-add-quantidade")?.value) || 0;
      const unit = parseFloat(document.getElementById("ll-add-vl-unit")?.value)    || 0;
      if (qtd > 0 && unit > 0) {
        const totalEl = document.getElementById("ll-add-vl-total");
        if (totalEl && !totalEl._manuallyEdited) totalEl.value = (qtd * unit).toFixed(2);
      }
    });
  });

  // Preço fixo por cor: Preta → R$20 | Branca → R$28
  document.getElementById("ll-add-cor")?.addEventListener("change", function() {
    const preco   = LL_PRECOS_COR[this.value];
    const unitEl  = document.getElementById("ll-add-vl-unit");
    const totalEl = document.getElementById("ll-add-vl-total");
    if (preco && unitEl) {
      unitEl.value = preco.toFixed(2);
      // Recalcula total se quantidade já estiver preenchida
      const qtd = parseFloat(document.getElementById("ll-add-quantidade")?.value) || 0;
      if (qtd > 0 && totalEl && !totalEl._manuallyEdited) {
        totalEl.value = (qtd * preco).toFixed(2);
      }
    } else if (unitEl && !preco) {
      // "Outra" — limpa o preço para o usuário digitar
      unitEl.value = "";
    }
  });
  document.getElementById("ll-add-vl-total")?.addEventListener("input", function() {
    this._manuallyEdited = this.value !== "";
  });
}

// Tabela de preços fixos por cor de caixa
const LL_PRECOS_COR = {
  "Preta":  20,
  "Branca": 28,
};


function openLLAddModal() {
  const modal = document.getElementById("ll-modal-add");
  if (!modal) return;

  // Limpa campos
  ["ll-add-tipo","ll-add-data","ll-add-cliente","ll-add-fornecedor",
   "ll-add-quantidade","ll-add-cor","ll-add-vl-unit","ll-add-vl-total",
   "ll-add-conferente"].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    if (id === "ll-add-tipo") { el.value = "ENTRADA"; return; }
    if (id === "ll-add-cor")  { el.value = ""; return; }
    el.value = "";
    if (id === "ll-add-vl-total") el._manuallyEdited = false;
  });

  // Pré-preenche data de hoje
  const dataEl = document.getElementById("ll-add-data");
  if (dataEl) dataEl.valueAsDate = new Date();

  // Oculta msg de erro
  const msg = document.getElementById("ll-add-msg");
  if (msg) msg.style.display = "none";

  modal.style.display = "grid";
  setTimeout(() => document.getElementById("ll-add-cliente")?.focus(), 200);
}

function closeLLAddModal() {
  const modal = document.getElementById("ll-modal-add");
  if (modal) modal.style.display = "none";
}

// ─── MODAL ADD: SALVAR NO FIRESTORE ──────────────────────────
async function saveLLRecord() {
  const get   = id => document.getElementById(id);
  const setMsg = (msg, ok) => {
    const el = get("ll-add-msg");
    if (!el) return;
    el.style.display    = msg ? "block" : "none";
    el.textContent      = msg;
    el.style.background = ok ? "rgba(0,229,160,.1)"            : "rgba(255,91,112,.1)";
    el.style.border     = ok ? "1px solid rgba(0,229,160,.25)" : "1px solid rgba(255,91,112,.25)";
    el.style.color      = ok ? "var(--success)"                : "var(--alert)";
  };

  const tipo      = get("ll-add-tipo")?.value?.trim();
  const data      = get("ll-add-data")?.value?.trim();
  const cliente   = get("ll-add-cliente")?.value?.trim();
  const fornecedor= get("ll-add-fornecedor")?.value?.trim() || "";
  const qtd       = get("ll-add-quantidade")?.value;
  const cor       = get("ll-add-cor")?.value?.trim() || "";
  const vlUnit    = get("ll-add-vl-unit")?.value;
  const vlTotal   = get("ll-add-vl-total")?.value;
  const conferente= get("ll-add-conferente")?.value?.trim() || "";

  // Validações mínimas
  if (!tipo || !data || !cliente) {
    setMsg("Preencha ao menos: Tipo, Data e Cliente.", false);
    return;
  }

  const btn = get("ll-btn-save-add");
  if (btn) { btn.disabled = true; btn.style.opacity = ".6"; }

  try {
    await fsAddDoc(fsCollection(db, "caixas_hetros"), {
      tipo,
      data,
      cliente,
      fornecedor,
      quantidade_cx:  qtd    !== "" ? Number(qtd)    : null,
      cor,
      valor_unitario: vlUnit  !== "" ? Number(vlUnit)  : null,
      valor_total:    vlTotal !== "" ? Number(vlTotal) : null,
      conferente,
      status_processamento: "OK",
      origem: "manual_admin",
      createdAt: fsServerTimestamp()
    });

    toast("✓ Registro salvo com sucesso!");
    closeLLAddModal();
  } catch (err) {
    console.error("[LuminLog] Erro ao salvar:", err);
    setMsg("Erro ao salvar: " + err.message, false);
  } finally {
    if (btn) { btn.disabled = false; btn.style.opacity = "1"; }
  }
}

// ─── EXPORTAR PARA EXCEL ──────────────────────────────────────
function exportLuminLogExcel() {
  // Respeita o filtro de tipo ativo no momento da exportação
  const data = _llFilter === "all"
    ? _llCache
    : _llCache.filter(r => (r.tipo || "").toUpperCase() === _llFilter.toUpperCase());

  if (!data.length) {
    toast("Nenhum dado para exportar.", "err");
    return;
  }

  // Monta as linhas no formato desejado para edição no Excel
  const rows = data.map(r => ({
    "Data":            r.data            || "",
    "Tipo":            r.tipo            || "",
    "Cliente":         r.cliente         || "",
    "Quantidade CX":   r.quantidade_cx   ?? "",
    "Cor":             r.cor             || "",
    "Valor Unitário":  r.valor_unitario  ?? "",
    "Valor Total":     r.valor_total     ?? "",
    "Conferente":      r.conferente      || "",
    "Fornecedor":      r.fornecedor      || "",
    "Status":          r.status_processamento || "OK",
    "ID Documento":    r.id              || ""
  }));

  // Cria workbook e worksheet via SheetJS
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);

  // Larguras de coluna automáticas (estimada pelo conteúdo)
  const colWidths = [
    { wch: 12 }, // Data
    { wch: 10 }, // Tipo
    { wch: 22 }, // Cliente
    { wch: 14 }, // Qtd CX
    { wch: 12 }, // Cor
    { wch: 16 }, // Vl. Unitário
    { wch: 16 }, // Vl. Total
    { wch: 18 }, // Conferente
    { wch: 22 }, // Fornecedor
    { wch: 10 }, // Status
    { wch: 28 }, // ID
  ];
  ws["!cols"] = colWidths;

  XLSX.utils.book_append_sheet(wb, ws, "Caixas Hetros");

  // Nome do arquivo com data/hora atual
  const now      = new Date();
  const stamp    = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,"0")}${String(now.getDate()).padStart(2,"0")}_${String(now.getHours()).padStart(2,"0")}${String(now.getMinutes()).padStart(2,"0")}`;
  const fileName = `caixas_hetros_${_llFilter}_${stamp}.xlsx`;

  XLSX.writeFile(wb, fileName);
  toast(`✓ Exportado: ${fileName}`);
}

// Ativa ao clicar na aba
document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll(".admin-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      if (tab.dataset.tab === "tab-luminlog") {
        initLuminLog();
        setTimeout(renderLuminLog, 100);
      }
    });
  });
});

// Ativa automaticamente quando o admin estiver pronto
window.addEventListener("lumin:admin-ready", () => {
  // Pré-carrega em background para ter dados prontos
  setTimeout(initLuminLog, 1000);
});
