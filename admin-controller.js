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
  const q = query.toLowerCase().trim();
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


