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
  writeBatch, serverTimestamp, query, orderBy, arrayUnion
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

  list.innerHTML = entries.map(([id, c]) => {
    const isPersonal = c.type === "personal";
    const typeBadge = isPersonal
      ? `<span style="font-size:9px;font-weight:800;padding:3px 8px;border-radius:20px;background:rgba(176,133,245,.15);color:var(--purple);letter-spacing:.5px;margin-right:6px;">PESSOAL</span>`
      : `<span style="font-size:9px;font-weight:800;padding:3px 8px;border-radius:20px;background:rgba(0,212,255,.12);color:var(--accent);letter-spacing:.5px;margin-right:6px;">EMPRESA</span>`;
    return `
    <div class="company-row" data-company-id="${id}">
      <div class="company-color-dot" style="background:${c.themeColor || 'var(--accent)'}"></div>
      <div class="company-info">
        <div class="company-name">${typeBadge}${c.name}</div>
        <div class="company-meta">${id} · ${c.phone || "—"}</div>
      </div>
      <span class="badge-status ${c.active !== false ? 'badge-active' : 'badge-inactive'}">
        ${c.active !== false ? "Ativa" : "Inativa"}
      </span>
      <div style="display:flex;gap:6px;">
        <button class="btn-act edit" data-action="edit-company" data-id="${id}" title="Editar">✎</button>
        <button class="btn-act del"  data-action="del-company"  data-id="${id}" title="Deletar">✕</button>
      </div>
    </div>
  `;}).join("");

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
    const roleLabel = { master: "Master", tenant: "Empresa", personal: "Pessoal", hetros: "Hetros" }[u.role] || u.role;
    const roleColor = u.role === "master" ? "var(--accent)"
                     : u.role === "personal" ? "var(--purple)"
                     : u.role === "hetros" ? "var(--accent)"
                     : "var(--purple)";

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
      name, phone: phone || "", themeColor: color, type: "company",
      active: true, createdAt: serverTimestamp()
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

// ─── CRIAR USUÁRIO PESSOAL (conta individual, não vinculada a empresa) ─
async function createPersonalUser() {
  const name     = el("adm-pers-name")?.value.trim();
  const phone    = el("adm-pers-phone")?.value.trim();
  const username = el("adm-pers-login")?.value.trim().toLowerCase();
  const password = el("adm-pers-pass")?.value.trim();
  const color    = el("adm-pers-color-hex")?.value.trim() || "#b085f5";

  if (!name || !username || !password) {
    setMsg("adm-pers-msg", "Preencha Nome, Login e Senha.", false);
    return;
  }
  if (password.length < 6) {
    setMsg("adm-pers-msg", "A senha deve ter no mínimo 6 caracteres.", false);
    return;
  }

  btn("btn-adm-pers-save", true);
  setMsg("adm-pers-msg", "");

  try {
    const email      = `${username}@lumin.com`;
    const credential = await createUserWithEmailAndPassword(auth, email, password);
    const uid        = credential.user.uid;
    // Mesma coleção 'companies' mas marcada como 'personal' — reaproveita todo o dashboard
    const accountId  = "pessoal-" + slugify(name) + "-" + Date.now().toString(36);

    const batch = writeBatch(db);
    batch.set(doc(db, "companies", accountId), {
      name, phone: phone || "", themeColor: color, type: "personal",
      active: true, createdAt: serverTimestamp()
    });
    batch.set(doc(db, "users", uid), {
      username, displayName: name, email,
      role: "personal", companyId: accountId,
      active: true, createdAt: serverTimestamp()
    });
    await batch.commit();

    setMsg("adm-pers-msg", `✓ Usuário pessoal "${name}" criado com login "@${username}"!`, true);
    ["adm-pers-name","adm-pers-phone","adm-pers-login","adm-pers-pass"].forEach(id => { if (el(id)) el(id).value = ""; });
    if (el("adm-pers-color-hex")) el("adm-pers-color-hex").value = "#b085f5";
    if (el("adm-pers-color"))     el("adm-pers-color").value     = "#b085f5";

    await renderCompanies();
    await loadUsers();
    toast(`Usuário pessoal "${name}" criado!`);

  } catch (err) {
    console.error("[Admin] Erro ao criar usuário pessoal:", err);
    setMsg("adm-pers-msg", err.code === "auth/email-already-in-use"
      ? `O login "@${username}" já está em uso.`
      : `Erro: ${err.message}`, false);
  } finally {
    btn("btn-adm-pers-save", false);
  }
}

// ─── CRIAR OPERADOR HETROS (acesso só ao Controle Hetros) ────
async function createHetrosOperator() {
  const name     = el("adm-hetros-name")?.value.trim();
  const username = el("adm-hetros-login")?.value.trim().toLowerCase();
  const password = el("adm-hetros-pass")?.value.trim();

  if (!name || !username || !password) {
    setMsg("adm-hetros-msg", "Preencha Nome, Login e Senha.", false);
    return;
  }
  if (password.length < 6) {
    setMsg("adm-hetros-msg", "A senha deve ter no mínimo 6 caracteres.", false);
    return;
  }

  btn("btn-adm-hetros-save", true);
  setMsg("adm-hetros-msg", "");

  try {
    const email      = `${username}@lumin.com`;
    const credential = await createUserWithEmailAndPassword(auth, email, password);
    const uid        = credential.user.uid;

    await setDoc(doc(db, "users", uid), {
      username, displayName: name, email,
      role: "hetros",
      active: true,
      createdAt: serverTimestamp()
    });

    setMsg("adm-hetros-msg", `✓ Operador "${name}" criado com login "@${username}"!`, true);
    ["adm-hetros-name","adm-hetros-login","adm-hetros-pass"].forEach(id => { if (el(id)) el(id).value = ""; });
    await loadUsers();
    toast(`Operador "${name}" criado!`);

  } catch (err) {
    console.error("[Admin] Erro ao criar operador Hetros:", err);
    setMsg("adm-hetros-msg", err.code === "auth/email-already-in-use"
      ? `O login "@${username}" já está em uso.`
      : `Erro: ${err.message}`, false);
  } finally {
    btn("btn-adm-hetros-save", false);
  }
}

// ─── ADICIONAR UTILIZADOR A EMPRESA EXISTENTE ────────────────
async function createUserForCompany() {
  const companyId   = el("adm-add-user-company")?.value;
  const username    = el("adm-add-user-login")?.value.trim().toLowerCase();
  const displayName = el("adm-add-user-name")?.value.trim();
  const password    = el("adm-add-user-pass")?.value.trim();
  const phone       = el("adm-add-user-phone")?.value.replace(/\D/g, '');

  if (!companyId || !username || !displayName || !password) {
    setMsg("adm-add-user-msg", "Preencha Empresa, Nome, Login e Senha.", false);
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
      username, displayName, email, phone,
      role: "tenant", companyId, active: true, createdAt: serverTimestamp()
    });

    // CRUCIAL: adiciona o telefone no array phones[] da empresa
    // pra o bot WhatsApp identificar esse usuário e salvar nas transações da empresa
    if (phone) {
      await updateDoc(doc(db, "companies", companyId), {
        phones: arrayUnion(phone)
      });
    }

    const companyName = _allCompanies[companyId]?.name || companyId;
    setMsg("adm-add-user-msg", `✓ "@${username}" adicionado à empresa "${companyName}"!`, true);
    ["adm-add-user-login","adm-add-user-name","adm-add-user-pass","adm-add-user-phone"].forEach(id => {
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

// ─── EDITAR EMPRESA ───────────────────────────────────────────
let _editingCompanyPhones = []; // cópia local editável

function renderCompanyPhonesList() {
  const list = el("edit-company-phones-list");
  if (!list) return;
  if (_editingCompanyPhones.length === 0) {
    list.innerHTML = `<span style="font-size:12px;color:var(--muted);">Nenhum telefone cadastrado ainda.</span>`;
    return;
  }
  list.innerHTML = _editingCompanyPhones.map((p, i) => `
    <div style="display:flex;align-items:center;gap:8px;background:rgba(255,255,255,.04);border:1px solid var(--border);border-radius:8px;padding:8px 12px;">
      <span style="flex:1;font-family:monospace;font-size:13px;color:var(--text);">${p}</span>
      <button type="button" onclick="window._removeCompanyPhone(${i})" style="background:rgba(255,91,112,.12);border:1px solid rgba(255,91,112,.25);color:var(--alert);border-radius:6px;padding:3px 10px;font-size:12px;cursor:pointer;">Remover</button>
    </div>
  `).join("");
}

window._removeCompanyPhone = function(idx) {
  _editingCompanyPhones.splice(idx, 1);
  renderCompanyPhonesList();
};

function openEditCompanyModal(companyId) {
  const company = _allCompanies[companyId];
  if (!company) return;

  el("edit-company-id").value         = companyId;
  el("edit-company-name").value       = company.name        || "";
  el("edit-company-phone").value      = company.phone       || "";
  el("edit-company-color").value      = company.themeColor  || "#00d4ff";
  el("edit-company-color-hex").value  = company.themeColor  || "#00d4ff";

  // Carrega phones[] existentes
  _editingCompanyPhones = Array.isArray(company.phones) ? [...company.phones] : [];
  if (el("edit-company-new-phone")) el("edit-company-new-phone").value = "";
  renderCompanyPhonesList();

  el("modal-edit-company").classList.add("active");
}

function closeEditCompanyModal() {
  el("modal-edit-company").classList.remove("active");
}

async function saveCompanyEdit() {
  const companyId = el("edit-company-id").value;
  const name      = el("edit-company-name").value.trim();
  const phone     = el("edit-company-phone").value.trim().replace(/\D/g, "");
  const color     = el("edit-company-color").value;

  if (!name) { toast("Nome da empresa é obrigatório.", "err"); return; }

  try {
    await updateDoc(doc(db, "companies", companyId), {
      name,
      phone,
      themeColor: color,
      phones: _editingCompanyPhones
    });
    toast(`✓ Empresa "${name}" atualizada!`);
    closeEditCompanyModal();
    await renderCompanies();
  } catch (err) {
    console.error("[Admin] Erro ao editar empresa:", err);
    toast("Erro ao salvar. Tente novamente.", "err");
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
  el("btn-adm-pers-save")?.addEventListener("click", createPersonalUser);
  el("btn-adm-hetros-save")?.addEventListener("click", createHetrosOperator);
  el("btn-adm-add-user-save")?.addEventListener("click", createUserForCompany);

  el("adm-color")?.addEventListener("input", (e) => {
    if (el("adm-color-hex")) el("adm-color-hex").value = e.target.value;
  });
  el("adm-color-hex")?.addEventListener("input", (e) => {
    const v = e.target.value;
    if (/^#[0-9A-Fa-f]{6}$/.test(v) && el("adm-color")) el("adm-color").value = v;
  });

  // Color picker do usuário pessoal
  el("adm-pers-color")?.addEventListener("input", (e) => {
    if (el("adm-pers-color-hex")) el("adm-pers-color-hex").value = e.target.value;
  });
  el("adm-pers-color-hex")?.addEventListener("input", (e) => {
    const v = e.target.value;
    if (/^#[0-9A-Fa-f]{6}$/.test(v) && el("adm-pers-color")) el("adm-pers-color").value = v;
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
      case "edit-company": openEditCompanyModal(b.dataset.id); break;
      case "del-company":  await deleteCompany(b.dataset.id);      break;
    }
  });

  el("btn-save-edit")?.addEventListener("click", saveUserEdit);
  el("btn-close-edit-modal")?.addEventListener("click", closeEditModal);
  el("modal-edit-user")?.addEventListener("click", (e) => {
    if (e.target === el("modal-edit-user")) closeEditModal();
  });

  // ── Modal editar empresa
  el("btn-save-edit-company")?.addEventListener("click", saveCompanyEdit);
  el("btn-close-edit-company-modal")?.addEventListener("click", closeEditCompanyModal);

  el("btn-add-company-phone")?.addEventListener("click", () => {
    const input = el("edit-company-new-phone");
    const phone = (input?.value || "").trim().replace(/\D/g, "");
    if (!phone) { toast("Digite um número válido.", "err"); return; }
    if (_editingCompanyPhones.includes(phone)) { toast("Número já adicionado.", "err"); return; }
    _editingCompanyPhones.push(phone);
    renderCompanyPhonesList();
    if (input) input.value = "";
  });
  el("modal-edit-company")?.addEventListener("click", (e) => {
    if (e.target === el("modal-edit-company")) closeEditCompanyModal();
  });

  el("edit-company-color")?.addEventListener("input", (e) => {
    if (el("edit-company-color-hex")) el("edit-company-color-hex").value = e.target.value;
  });
  el("edit-company-color-hex")?.addEventListener("input", (e) => {
    const v = e.target.value;
    if (/^#[0-9A-Fa-f]{6}$/.test(v) && el("edit-company-color")) el("edit-company-color").value = v;
  });
}

// ─── INICIALIZAÇÃO ────────────────────────────────────────────
window.addEventListener("lumin:admin-ready", async (e) => {
  const user = e.detail?.user;
  // Permitir tanto master quanto hetros (hetros vê apenas Controle Hetros — restrito via CSS)
  if (!user || (user.role !== "master" && user.role !== "hetros")) return;

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

  // Todas as features: refletem exatamente o que está salvo no Firestore.
  // Se o campo não existir (empresa nova), assume false — sem defaults ocultos.
  const featFuncionario = el("feat-funcionario");
  if (featFuncionario) featFuncionario.checked = _featData.funcionario === true;
  updateToggleUI("funcionario", _featData.funcionario === true);

  const featPapelao = el("feat-papelao");
  if (featPapelao) featPapelao.checked = _featData.papelao === true;
  updateToggleUI("papelao", _featData.papelao === true);

  const featComida = el("feat-comida");
  if (featComida) featComida.checked = _featData.comida === true;
  updateToggleUI("comida", _featData.comida === true);

  const featLogisticaKm = el("feat-logistica_km");
  if (featLogisticaKm) featLogisticaKm.checked = _featData.logistica_km === true;
  updateToggleUI("logistica_km", _featData.logistica_km === true);
}

function updateToggleUI(feat, active) {
  const toggle = document.querySelector(`.feat-toggle[data-feat="${feat}"]`);
  if (!toggle) return;
  toggle.classList.toggle('active', active);

  // Atualiza o label de status ao lado da chavinha
  const label = el(`feat-${feat}-label`);
  if (label) {
    label.textContent = active ? "Ativado" : "Desativado";
    label.style.color = active ? "var(--success)" : "var(--muted)";
  }
}

async function saveFeatConfig() {
  if (!_featCompanyId) return;
  const features = {
    funcionario:  el("feat-funcionario")?.checked  === true,
    papelao:      el("feat-papelao")?.checked       === true,
    comida:       el("feat-comida")?.checked        === true,
    logistica_km: el("feat-logistica_km")?.checked  === true
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
    toggle.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const feat  = toggle.dataset.feat;
      const input = el(`feat-${feat}`);
      if (!input) return;
      // Inverte manualmente — impede o browser de processar o
      // checkbox nativo por baixo (evita duplo-toggle).
      input.checked = !input.checked;
      updateToggleUI(feat, input.checked);
    });
  });

  // Impede que cliques no próprio <input> (invisível mas clicável)
  // disparem um segundo toggle além do listener acima.
  ["feat-funcionario","feat-papelao","feat-comida","feat-logistica_km"].forEach(id => {
    el(id)?.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
  });

  el("btn-adm-feat-save")?.addEventListener("click", saveFeatConfig);
}




// ═══════════════════════════════════════════════════════════════
//  LUMIN LOG — Dashboard de Registros (Admin Master)
//  Fontes: controle_caixas (motoristas) + lumin-log (manual)
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

// ── Estado ────────────────────────────────────────────────────
let _llCache   = [];   // todos os registros (controle_caixas + lumin-log)
let _llFilter  = "all"; // filtro rápido de tipo: "all" | "ENTRADA" | "SAIDA"
let _llAdv     = {};   // filtros avançados
let _llUnsub1  = null;
let _llUnsub2  = null;
let _llPhotoModal = null; // modal de foto

const llFmt = v => Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const llEl  = id => document.getElementById(id);

// Normaliza tipo para comparação: remove acento de SAÍDA → SAIDA
function normTipo(t) { return String(t || "").toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, ""); }

// ── Modal de foto ─────────────────────────────────────────────
function ensurePhotoModal() {
  if (_llPhotoModal) return;
  const m = document.createElement("div");
  m.id = "ll-photo-modal";
  m.style.cssText = [
    "display:none;position:fixed;inset:0;z-index:99999",
    "background:rgba(0,0,0,.85);backdrop-filter:blur(8px)",
    "align-items:center;justify-content:center;padding:20px;cursor:pointer"
  ].join(";");
  m.innerHTML = `
    <div style="position:relative;max-width:92vw;max-height:88vh;">
      <img id="ll-photo-img" src="" alt="Foto do registro"
        style="max-width:92vw;max-height:85vh;border-radius:16px;display:block;
        box-shadow:0 8px 60px rgba(0,0,0,.8);object-fit:contain;" />
      <button id="ll-photo-close"
        style="position:absolute;top:-14px;right:-14px;width:36px;height:36px;
        border-radius:50%;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.25);
        color:#fff;font-size:18px;cursor:pointer;display:flex;align-items:center;justify-content:center;">
        ✕
      </button>
      <div id="ll-photo-label"
        style="position:absolute;bottom:-32px;left:0;right:0;text-align:center;
        font-size:12px;font-weight:700;color:rgba(255,255,255,.5);letter-spacing:.1em;">
      </div>
    </div>`;
  document.body.appendChild(m);
  _llPhotoModal = m;
  m.addEventListener("click", e => { if (e.target === m || e.target.id === "ll-photo-close") closePhotoModal(); });
}

function openPhotoModal(src, label) {
  ensurePhotoModal();
  llEl("ll-photo-img").src = src;
  if (llEl("ll-photo-label")) llEl("ll-photo-label").textContent = label || "";
  _llPhotoModal.style.display = "flex";
  document.body.style.overflow = "hidden";
}

function closePhotoModal() {
  if (_llPhotoModal) _llPhotoModal.style.display = "none";
  document.body.style.overflow = "";
}

// ── Aplica todos os filtros ativos sobre _llCache ─────────────
function applyFilters() {
  let data = [..._llCache];

  // Filtro rápido de tipo (botões Todos / Entradas / Saídas)
  if (_llFilter !== "all") {
    data = data.filter(r => normTipo(r.tipo) === normTipo(_llFilter));
  }

  // Filtros avançados
  const { dataIni, dataFim, tipo, cor, cliente, motorista } = _llAdv;

  if (dataIni) data = data.filter(r => r.data && r.data >= dataIni);
  if (dataFim) data = data.filter(r => r.data && r.data <= dataFim);
  if (tipo && tipo !== "all") data = data.filter(r => normTipo(r.tipo) === normTipo(tipo));
  if (cor && cor !== "all") {
    data = data.filter(r => String(r.cor || "").toLowerCase().includes(cor));
  }
  if (cliente && cliente.trim()) {
    const q = cliente.trim().toLowerCase();
    data = data.filter(r => String(r.cliente || "").toLowerCase().includes(q));
  }
  if (motorista && motorista.trim()) {
    const q = motorista.trim().toLowerCase();
    data = data.filter(r =>
      String(r.motorista || r.fornecedor || "").toLowerCase().includes(q)
    );
  }

  return data;
}

// ── Render principal ──────────────────────────────────────────
function renderLuminLog() {
  const tbody = llEl("ll-tbody");
  if (!tbody) return;

  // KPIs globais (sempre sobre _llCache completo)
  const entradas = _llCache.filter(r => normTipo(r.tipo) === "ENTRADA");
  const saidas   = _llCache.filter(r => normTipo(r.tipo) === "SAIDA");
  const revisares = _llCache.filter(r => r.status_processamento === "REVISAR");

  const totalQtdEntrada = entradas.reduce((a, r) => a + (Number(r.quantidade_cx || r.quantidadeCx) || 0), 0);
  const totalQtdSaida   = saidas.reduce((a, r)   => a + (Number(r.quantidade_cx || r.quantidadeCx) || 0), 0);
  const totalValor      = _llCache.reduce((a, r) => a + (Number(r.valor_total   || r.valorTotal)   || 0), 0);

  if (llEl("ll-total-entrada")) llEl("ll-total-entrada").textContent = totalQtdEntrada + " cx";
  if (llEl("ll-total-saida"))   llEl("ll-total-saida").textContent   = totalQtdSaida   + " cx";
  if (llEl("ll-total-valor"))   llEl("ll-total-valor").textContent   = llFmt(totalValor);
  if (llEl("ll-total-count"))   llEl("ll-total-count").textContent   = _llCache.length;

  const banner = llEl("ll-revisar-banner");
  if (banner) banner.style.display = revisares.length ? "block" : "none";
  if (llEl("ll-revisar-count")) llEl("ll-revisar-count").textContent = revisares.length;

  // Atualiza datalists de autocomplete
  const clientesUniq  = [...new Set(_llCache.map(r => r.cliente).filter(Boolean))].sort();
  const motoristasUniq = [...new Set(_llCache.map(r => r.motorista || r.fornecedor).filter(Boolean))].sort();
  const clList = llEl("ll-clientes-list");
  const mtList = llEl("ll-motoristas-list");
  if (clList) clList.innerHTML = clientesUniq.map(n => `<option value="${n}">`).join("");
  if (mtList) mtList.innerHTML = motoristasUniq.map(n => `<option value="${n}">`).join("");

  // Aplica filtros
  const data = applyFilters();

  // KPIs do filtro ativo
  const filtEntradas = data.filter(r => normTipo(r.tipo) === "ENTRADA");
  const filtSaidas   = data.filter(r => normTipo(r.tipo) === "SAIDA");
  const filtValor    = data.reduce((a, r) => a + (Number(r.valor_total || r.valorTotal) || 0), 0);
  const filtRow = llEl("ll-filt-row");
  const hasFilter = _llFilter !== "all" || Object.values(_llAdv).some(v => v && v !== "all");

  if (filtRow) filtRow.style.display = hasFilter ? "grid" : "none";
  if (llEl("ll-filt-entrada")) llEl("ll-filt-entrada").textContent =
    filtEntradas.reduce((a, r) => a + (Number(r.quantidade_cx || r.quantidadeCx) || 0), 0) + " cx";
  if (llEl("ll-filt-saida"))   llEl("ll-filt-saida").textContent =
    filtSaidas.reduce((a, r) => a + (Number(r.quantidade_cx || r.quantidadeCx) || 0), 0) + " cx";
  if (llEl("ll-filt-valor"))   llEl("ll-filt-valor").textContent = llFmt(filtValor);
  if (llEl("ll-filt-count"))   llEl("ll-filt-count").textContent = data.length + " reg.";

  // Botão limpar filtro
  const resetBtn = llEl("ll-filter-reset");
  if (resetBtn) resetBtn.style.display = hasFilter ? "flex" : "none";

  // Badge de filtros avançados
  const advCount = Object.values(_llAdv).filter(v => v && v !== "all").length;
  const badge = llEl("ll-filter-badge");
  if (badge) { badge.style.display = advCount > 0 ? "inline" : "none"; badge.textContent = advCount; }

  if (!data.length) {
    tbody.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;
        padding:60px 20px;gap:12px;color:var(--muted);">
        <div style="font-size:36px;opacity:.25;">🔍</div>
        <div style="font-size:14px;font-weight:600;">Nenhum registro encontrado para este filtro.</div>
        ${hasFilter ? `<button onclick="window.llResetFilters()" style="margin-top:6px;padding:8px 18px;border-radius:20px;background:rgba(0,212,255,.1);border:1px solid rgba(0,212,255,.25);color:var(--accent);font-size:12px;font-weight:700;cursor:pointer;">Limpar filtros</button>` : ""}
      </div>`;
    return;
  }

  const esc = s => String(s || "—").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  tbody.innerHTML = data.map(r => {
    const isEntrada  = normTipo(r.tipo) === "ENTRADA";
    const isRevisar  = r.status_processamento === "REVISAR";
    const tipoColor  = isEntrada ? "var(--success)" : "var(--alert)";
    const tipoBg     = isEntrada ? "rgba(0,229,160,.1)" : "rgba(255,91,112,.1)";
    const tipoBorder = isEntrada ? "rgba(0,229,160,.25)" : "rgba(255,91,112,.25)";
    const qtd        = r.quantidade_cx ?? r.quantidadeCx;
    const vlUnit     = r.valor_unitario ?? r.valorUnitario;
    const vlTotal    = r.valor_total    ?? r.valorTotal;
    const motorista  = r.motorista || r.fornecedor || "";
    const origem     = r.origem || "";

    // Fotos disponíveis neste registro
    const fotos = [];
    if (r.fotoUrl)      fotos.push({ src: r.fotoUrl,      label: "Foto CD" });
    if (r.fotoEntrega)  fotos.push({ src: r.fotoEntrega,  label: "Entrega" });
    if (r.fotoColeta)   fotos.push({ src: r.fotoColeta,   label: "Coleta"  });

    const fotosHtml = fotos.map((f, i) => `
      <button class="ll-foto-btn" data-foto-src="${encodeURIComponent(f.src)}" data-foto-label="${esc(f.label)}"
        style="display:inline-flex;align-items:center;gap:5px;padding:4px 10px;margin-right:4px;
        border-radius:8px;font-size:11px;font-weight:700;cursor:pointer;
        background:rgba(255,179,71,.1);border:1px solid rgba(255,179,71,.3);color:var(--warning);">
        📷 ${esc(f.label)}
      </button>`).join("");

    return `
      <div class="ll-card" data-ll-id="${r.id}"
        style="background:rgba(255,255,255,.025);border:1px solid ${isRevisar ? "rgba(255,179,71,.3)" : "rgba(255,255,255,.07)"};
        border-radius:14px;padding:16px 18px;transition:background .15s;cursor:pointer;"
        data-ll-expand="false">

        <!-- Linha principal -->
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">

          <!-- Badge tipo -->
          <span style="font-size:11px;font-weight:800;padding:4px 11px;border-radius:20px;
            background:${tipoBg};color:${tipoColor};border:1px solid ${tipoBorder};
            text-transform:uppercase;letter-spacing:.5px;flex-shrink:0;">
            ${isEntrada ? "▲" : "▼"} ${esc(r.tipo)}
          </span>

          <!-- Data -->
          <span style="font-family:'DM Mono',monospace;font-size:12px;color:var(--muted);flex-shrink:0;">
            ${esc(r.data)}
          </span>

          <!-- Cliente -->
          <span style="font-weight:700;font-size:14px;flex:1;min-width:100px;overflow:hidden;
            text-overflow:ellipsis;white-space:nowrap;">
            ${esc(r.cliente)}
          </span>

          <!-- Qtd -->
          <span style="font-family:'DM Mono',monospace;font-size:16px;font-weight:800;
            color:${tipoColor};flex-shrink:0;">
            ${qtd === null || qtd === undefined
              ? '<span style="color:var(--warning);">?</span>'
              : qtd + " cx"}
          </span>

          <!-- Valor -->
          <span style="font-family:'DM Mono',monospace;font-size:14px;font-weight:700;
            color:${tipoColor};flex-shrink:0;">
            ${llFmt(vlTotal)}
          </span>

          <!-- Ícone foto -->
          ${fotos.length ? `<span style="font-size:14px;flex-shrink:0;" title="${fotos.length} foto(s)">📷</span>` : ""}

          <!-- Expandir -->
          <svg class="ll-expand-icon" width="14" height="14" viewBox="0 0 24 24" fill="none"
            stroke="rgba(228,240,246,.35)" stroke-width="2.5" stroke-linecap="round"
            style="flex-shrink:0;transition:transform .2s;">
            <polyline points="6 9 12 15 18 9"/>
          </svg>

        </div>

        <!-- Detalhe expandido (oculto por padrão) -->
        <div class="ll-detail" style="display:none;margin-top:14px;padding-top:14px;
          border-top:1px solid rgba(255,255,255,.06);">
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:${fotos.length ? "14px" : "0"};">
            ${motorista ? `<div><div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.1em;margin-bottom:3px;">Motorista</div><div style="font-size:13px;font-weight:600;">${esc(motorista)}</div></div>` : ""}
            ${r.cor ? `<div><div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.1em;margin-bottom:3px;">Cor</div><div style="font-size:13px;font-weight:600;">${esc(r.cor)}</div></div>` : ""}
            ${vlUnit ? `<div><div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.1em;margin-bottom:3px;">Vl. Unit.</div><div style="font-family:'DM Mono',monospace;font-size:13px;font-weight:600;">${llFmt(vlUnit)}</div></div>` : ""}
            ${r.conferente ? `<div><div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.1em;margin-bottom:3px;">Conferente</div><div style="font-size:13px;font-weight:600;">${esc(r.conferente)}</div></div>` : ""}
            ${r.fornecedor && r.fornecedor !== motorista ? `<div><div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.1em;margin-bottom:3px;">Fornecedor</div><div style="font-size:13px;font-weight:600;">${esc(r.fornecedor)}</div></div>` : ""}
            ${origem ? `<div><div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.1em;margin-bottom:3px;">Origem</div><div style="font-size:13px;font-weight:600;">${esc(origem)}</div></div>` : ""}
            ${isRevisar ? `<div><div style="font-size:10px;font-weight:700;color:var(--warning);text-transform:uppercase;letter-spacing:.1em;margin-bottom:3px;">Status</div><div style="font-size:13px;font-weight:800;color:var(--warning);">⚠ REVISAR</div></div>` : ""}
          </div>

          <!-- Fotos -->
          ${fotos.length ? `
            <div style="margin-bottom:12px;">
              <div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;
                letter-spacing:.1em;margin-bottom:10px;">📷 Fotos</div>
              <div style="display:flex;gap:10px;flex-wrap:wrap;">
                ${fotos.map(f => `
                  <div class="ll-foto-thumb" data-foto-src="${encodeURIComponent(f.src)}"
                    data-foto-label="${esc(f.label)}"
                    style="cursor:pointer;border-radius:10px;overflow:hidden;
                    border:2px solid rgba(255,179,71,.3);flex-shrink:0;
                    width:100px;height:100px;position:relative;">
                    <img src="${f.src}" alt="${esc(f.label)}"
                      style="width:100%;height:100%;object-fit:cover;display:block;" />
                    <div style="position:absolute;bottom:0;left:0;right:0;
                      background:rgba(0,0,0,.55);padding:4px 6px;
                      font-size:10px;font-weight:700;color:#fff;text-align:center;">
                      ${esc(f.label)}
                    </div>
                  </div>`).join("")}
              </div>
            </div>` : ""}

          <!-- Ações -->
          <div style="display:flex;gap:8px;justify-content:flex-end;">
            <button class="btn-act del" data-ll-del="${r.id}" data-ll-col="${r._col || "controle_caixas"}"
              title="Excluir este registro"
              style="padding:6px 14px;font-size:12px;">
              🗑 Excluir
            </button>
          </div>
        </div>
      </div>`;
  }).join("");

  // Bind: expandir card ao clicar
  tbody.querySelectorAll(".ll-card").forEach(card => {
    card.addEventListener("click", e => {
      // Não propaga se clicou num botão filho
      if (e.target.closest("button[data-ll-del]") || e.target.closest(".ll-foto-thumb")) return;
      const detail = card.querySelector(".ll-detail");
      const icon   = card.querySelector(".ll-expand-icon");
      const open   = card.dataset.llExpand === "true";
      card.dataset.llExpand = open ? "false" : "true";
      detail.style.display  = open ? "none" : "block";
      if (icon) icon.style.transform = open ? "" : "rotate(180deg)";
      card.style.background = open ? "rgba(255,255,255,.025)" : "rgba(255,255,255,.045)";
    });
  });

  // Bind: fotos (thumbnail)
  tbody.querySelectorAll(".ll-foto-thumb").forEach(el => {
    el.addEventListener("click", e => {
      e.stopPropagation();
      openPhotoModal(decodeURIComponent(el.dataset.fotoSrc), el.dataset.fotoLabel);
    });
  });

  // Bind: excluir
  tbody.querySelectorAll("[data-ll-del]").forEach(btn => {
    btn.addEventListener("click", async e => {
      e.stopPropagation();
      const col = btn.dataset.llCol || "controle_caixas";
      if (!confirm("Excluir este registro permanentemente?")) return;
      try {
        await fsDeleteDoc(fsDoc(db, col, btn.dataset.llDel));
        toast("Registro excluído.");
      } catch (err) {
        toast("Erro ao excluir: " + err.message, "err");
      }
    });
  });
}

// ── Inicializa e escuta Firestore ─────────────────────────────
function initLuminLog() {
  if (_llUnsub1) return; // já inicializado

  ensurePhotoModal();

  // Escuta controle_caixas (motoristas) + lumin-log (manual)
  function merge(source, docs) {
    // remove entradas antigas deste source e substitui
    _llCache = _llCache.filter(r => r._source !== source);
    _llCache.push(...docs.map(d => ({ ...d, _source: source })));
    // ordena por data desc, depois por createdAt desc
    _llCache.sort((a, b) => {
      const da = a.data || "", db2 = b.data || "";
      if (da !== db2) return da > db2 ? -1 : 1;
      const ta = a.createdAt?.seconds || 0, tb = b.createdAt?.seconds || 0;
      return tb - ta;
    });
    if (llEl("tab-luminlog")?.classList.contains("active")) renderLuminLog();
  }

  _llUnsub1 = fsOnSnapshot(
    fsQuery(fsCollection(db, "controle_caixas"), fsOrderBy("createdAt", "desc")),
    snap => merge("controle_caixas", snap.docs.map(d => ({ id: d.id, ...d.data() }))),
    err  => console.error("[LuminLog] controle_caixas:", err)
  );

  _llUnsub2 = fsOnSnapshot(
    fsQuery(fsCollection(db, "lumin-log"), fsOrderBy("createdAt", "desc")),
    snap => merge("lumin-log", snap.docs.map(d => ({ id: d.id, ...d.data() }))),
    err  => console.error("[LuminLog] lumin-log:", err)
  );

  // ── Botões de filtro rápido ───────────────────────────────────
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
      _llFilter = btn.dataset.llFilter; // "all", "ENTRADA" ou "SAÍDA"
      renderLuminLog();
    });
  });

  // ── Filtros avançados ─────────────────────────────────────────
  const advIds = ["ll-f-data-ini", "ll-f-data-fim", "ll-f-tipo", "ll-f-cor", "ll-f-cliente", "ll-f-motorista"];
  function readAdv() {
    _llAdv = {
      dataIni:   llEl("ll-f-data-ini")?.value   || "",
      dataFim:   llEl("ll-f-data-fim")?.value   || "",
      tipo:      llEl("ll-f-tipo")?.value        || "all",
      cor:       llEl("ll-f-cor")?.value         || "all",
      cliente:   llEl("ll-f-cliente")?.value     || "",
      motorista: llEl("ll-f-motorista")?.value   || "",
    };
    renderLuminLog();
  }
  advIds.forEach(id => llEl(id)?.addEventListener("change", readAdv));
  advIds.forEach(id => llEl(id)?.addEventListener("input",  readAdv));

  // ── Limpar filtros ────────────────────────────────────────────
  window.llResetFilters = function() {
    _llFilter = "all";
    _llAdv    = {};
    document.querySelectorAll(".ll-filter-btn").forEach(b => {
      b.classList.remove("active");
      b.style.borderColor = "var(--border)";
      b.style.background  = "transparent";
      b.style.color       = "var(--muted)";
    });
    const allBtn = document.querySelector(".ll-filter-btn[data-ll-filter='all']");
    if (allBtn) {
      allBtn.classList.add("active");
      allBtn.style.borderColor = "var(--accent)";
      allBtn.style.background  = "rgba(0,212,255,.12)";
      allBtn.style.color       = "var(--accent)";
    }
    advIds.forEach(id => { const e = llEl(id); if (e) e.value = e.tagName === "SELECT" ? (id === "ll-f-cor" || id === "ll-f-tipo" ? "all" : "") : ""; });
    // Fecha filtros avançados se aberto
    const body = llEl("ll-filtros-body");
    if (body) { body.style.maxHeight = "0"; body.style.opacity = "0"; }
    renderLuminLog();
  };
  llEl("ll-filter-reset")?.addEventListener("click", window.llResetFilters);

  // ── Toggle filtros avançados ──────────────────────────────────
  llEl("ll-filtros-toggle")?.addEventListener("click", () => {
    const body  = llEl("ll-filtros-body");
    const arrow = document.querySelector(".ll-filtros-arrow");
    if (!body) return;
    const open = body.style.maxHeight !== "0px" && body.style.maxHeight !== "";
    if (open) {
      body.style.maxHeight = "0"; body.style.opacity = "0";
      if (arrow) arrow.style.transform = "";
    } else {
      body.style.maxHeight = "400px"; body.style.opacity = "1";
      if (arrow) arrow.style.transform = "rotate(180deg)";
    }
  });

  // ── Botões ação ───────────────────────────────────────────────
  llEl("ll-refresh")?.addEventListener("click", renderLuminLog);
  llEl("ll-export-excel")?.addEventListener("click", exportLuminLogExcel);
  llEl("ll-btn-add")?.addEventListener("click", openLLAddModal);
  llEl("ll-modal-close")?.addEventListener("click", closeLLAddModal);
  llEl("ll-modal-cancel")?.addEventListener("click", closeLLAddModal);
  llEl("ll-btn-save-add")?.addEventListener("click", saveLLRecord);
  llEl("ll-modal-add")?.addEventListener("click", e => {
    if (e.target === llEl("ll-modal-add")) closeLLAddModal();
  });

  // Auto-calcula valor total
  ["ll-add-quantidade", "ll-add-vl-unit"].forEach(id => {
    llEl(id)?.addEventListener("input", () => {
      const qtd  = parseFloat(llEl("ll-add-quantidade")?.value) || 0;
      const unit = parseFloat(llEl("ll-add-vl-unit")?.value)    || 0;
      const totalEl = llEl("ll-add-vl-total");
      if (qtd > 0 && unit > 0 && totalEl && !totalEl._manuallyEdited)
        totalEl.value = (qtd * unit).toFixed(2);
    });
  });

  const LL_PRECOS_COR = { "Preta": 20, "Branca": 28 };
  llEl("ll-add-cor")?.addEventListener("change", function() {
    const preco  = LL_PRECOS_COR[this.value];
    const unitEl = llEl("ll-add-vl-unit");
    const totalEl = llEl("ll-add-vl-total");
    if (preco && unitEl) {
      unitEl.value = preco.toFixed(2);
      const qtd = parseFloat(llEl("ll-add-quantidade")?.value) || 0;
      if (qtd > 0 && totalEl && !totalEl._manuallyEdited) totalEl.value = (qtd * preco).toFixed(2);
    } else if (unitEl && !preco) {
      unitEl.value = "";
    }
  });
  llEl("ll-add-vl-total")?.addEventListener("input", function() { this._manuallyEdited = this.value !== ""; });
}

// Tabela de preços
const LL_PRECOS_COR = { "Preta": 20, "Branca": 28 };

function openLLAddModal() {
  const modal = llEl("ll-modal-add");
  if (!modal) return;
  ["ll-add-tipo","ll-add-data","ll-add-cliente","ll-add-fornecedor",
   "ll-add-quantidade","ll-add-cor","ll-add-vl-unit","ll-add-vl-total",
   "ll-add-conferente"].forEach(id => {
    const e = llEl(id);
    if (!e) return;
    if (id === "ll-add-tipo") { e.value = "ENTRADA"; return; }
    if (id === "ll-add-cor")  { e.value = ""; return; }
    e.value = "";
    if (id === "ll-add-vl-total") e._manuallyEdited = false;
  });
  const dataEl = llEl("ll-add-data");
  if (dataEl) dataEl.valueAsDate = new Date();
  const msg = llEl("ll-add-msg");
  if (msg) msg.style.display = "none";
  modal.style.display = "grid";
  setTimeout(() => llEl("ll-add-cliente")?.focus(), 200);
}

function closeLLAddModal() {
  const modal = llEl("ll-modal-add");
  if (modal) modal.style.display = "none";
}

async function saveLLRecord() {
  const get = id => llEl(id);
  const setMsg = (msg, ok) => {
    const e = get("ll-add-msg"); if (!e) return;
    e.style.display = msg ? "block" : "none";
    e.textContent   = msg;
    e.style.background = ok ? "rgba(0,229,160,.1)" : "rgba(255,91,112,.1)";
    e.style.border     = ok ? "1px solid rgba(0,229,160,.25)" : "1px solid rgba(255,91,112,.25)";
    e.style.color      = ok ? "var(--success)" : "var(--alert)";
  };

  const tipo    = get("ll-add-tipo")?.value?.trim();
  const data    = get("ll-add-data")?.value?.trim();
  const cliente = get("ll-add-cliente")?.value?.trim();
  if (!tipo || !data || !cliente) { setMsg("Preencha ao menos: Tipo, Data e Cliente.", false); return; }

  const btn = get("ll-btn-save-add");
  if (btn) { btn.disabled = true; btn.style.opacity = ".6"; }

  try {
    await fsAddDoc(fsCollection(db, "controle_caixas"), {
      tipo,
      data,
      cliente,
      fornecedor:    get("ll-add-fornecedor")?.value?.trim() || "",
      quantidade_cx: get("ll-add-quantidade")?.value !== "" ? Number(get("ll-add-quantidade").value) : null,
      cor:           get("ll-add-cor")?.value?.trim() || "",
      valor_unitario: get("ll-add-vl-unit")?.value  !== "" ? Number(get("ll-add-vl-unit").value)  : null,
      valor_total:    get("ll-add-vl-total")?.value !== "" ? Number(get("ll-add-vl-total").value) : null,
      conferente:    get("ll-add-conferente")?.value?.trim() || "",
      status_processamento: "OK",
      origem: "manual_admin",
      createdAt: fsServerTimestamp()
    });
    toast("✓ Registro salvo!");
    closeLLAddModal();
  } catch (err) {
    setMsg("Erro: " + err.message, false);
  } finally {
    if (btn) { btn.disabled = false; btn.style.opacity = "1"; }
  }
}

function exportLuminLogExcel() {
  const data = applyFilters();
  if (!data.length) { toast("Nenhum dado para exportar.", "err"); return; }

  const rows = data.map(r => ({
    "Data":           r.data || "",
    "Tipo":           r.tipo || "",
    "Cliente":        r.cliente || "",
    "Motorista":      r.motorista || r.fornecedor || "",
    "Quantidade CX":  r.quantidade_cx ?? r.quantidadeCx ?? "",
    "Cor":            r.cor || "",
    "Valor Unitário": r.valor_unitario ?? r.valorUnitario ?? "",
    "Valor Total":    r.valor_total    ?? r.valorTotal    ?? "",
    "Conferente":     r.conferente || "",
    "Origem":         r.origem || "",
    "Tem Foto":       (r.fotoUrl || r.fotoEntrega || r.fotoColeta) ? "Sim" : "Não",
    "Status":         r.status_processamento || "OK",
    "ID":             r.id || "",
  }));

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  ws["!cols"] = [
    {wch:12},{wch:10},{wch:22},{wch:20},{wch:14},{wch:12},
    {wch:16},{wch:16},{wch:18},{wch:14},{wch:10},{wch:10},{wch:28}
  ];
  XLSX.utils.book_append_sheet(wb, ws, "Registros");
  const now = new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,"0")}${String(now.getDate()).padStart(2,"0")}`;
  XLSX.writeFile(wb, `lumin_log_${stamp}.xlsx`);
  toast(`✓ Exportado!`);
}

// ── Ativa ao clicar na aba ────────────────────────────────────
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

// ── Ativa automaticamente quando o admin estiver pronto ───────
window.addEventListener("lumin:admin-ready", () => {
  setTimeout(initLuminLog, 1000);
});