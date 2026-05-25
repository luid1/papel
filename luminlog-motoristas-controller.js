/**
 * ═══════════════════════════════════════════════════════════════
 *  LUMIN — Lumin Log Motoristas Controller
 *  Arquivo: luminlog-motoristas-controller.js
 *
 *  Integração entre o app de motoristas e o painel admin.
 *  • Gerencia ll_drivers, ll_clients, ll_events
 *  • Injeta sub-aba "Motoristas" dentro do tab-luminlog
 *  • Ativado pelo evento lumin:admin-ready
 * ═══════════════════════════════════════════════════════════════
 */

import { db } from './firebase-config.js';
import {
  collection, doc, addDoc, updateDoc, setDoc, deleteDoc,
  onSnapshot, query, orderBy, where, writeBatch, serverTimestamp, getDocs
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

// ── Coleções ────────────────────────────────────────────────────
const COL_DRIVERS  = 'll_drivers';
const COL_CLIENTS  = 'll_clients';
const COL_EVENTS   = 'll_events';
const COL_CAIXAS   = 'controle_caixas';

// ── Estado ──────────────────────────────────────────────────────
let _drivers = [];
let _clients = [];
let _pendingAlerts = [];
let _unsubDrivers = null;
let _unsubClients = null;
let _unsubAlerts  = null;

// ── Helpers ─────────────────────────────────────────────────────
const $   = id => document.getElementById(id);
const nn  = v  => Math.max(0, v || 0);
const esc = s  => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

function toast(msg, isErr = false) {
  const t = $('toast'); if (!t) return;
  t.textContent = msg;
  t.className   = 'show' + (isErr ? ' err' : '');
  clearTimeout(t._t);
  t._t = setTimeout(() => { t.className = ''; }, 3000);
}

// ═══════════════════════════════════════════════════════════════
// MODAL DE EDIÇÃO (injetado uma vez no DOM)
// ═══════════════════════════════════════════════════════════════
function ensureEditModal() {
  if ($('llm-edit-modal')) return; // já existe

  const modal = document.createElement('div');
  modal.id = 'llm-edit-modal';
  modal.style.cssText = [
    'display:none;position:fixed;inset:0;z-index:99999',
    'background:rgba(0,0,0,.65);backdrop-filter:blur(6px)',
    'align-items:center;justify-content:center;padding:20px'
  ].join(';');

  modal.innerHTML = `
    <div style="width:100%;max-width:440px;background:var(--bg2,#08141d);
      border:1px solid rgba(255,255,255,.1);border-radius:20px;padding:28px 24px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">
        <h3 style="font-size:17px;font-weight:800;margin:0;">✏️ Editar Motorista</h3>
        <button id="llm-edit-close"
          style="width:32px;height:32px;border-radius:8px;font-size:18px;
          background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);
          color:rgba(228,240,246,.6);cursor:pointer;display:flex;align-items:center;justify-content:center;">
          ✕
        </button>
      </div>
      <label style="font-size:12px;font-weight:700;color:rgba(228,240,246,.5);
        text-transform:uppercase;letter-spacing:.08em;display:block;margin-bottom:8px;">
        Nome do motorista
      </label>
      <input id="llm-edit-name" type="text"
        style="width:100%;box-sizing:border-box;background:rgba(255,255,255,.05);
        border:1px solid rgba(255,255,255,.12);border-radius:10px;padding:12px 14px;
        font-size:15px;color:var(--text,#e4f0f6);outline:none;margin-bottom:20px;"
        placeholder="Nome completo"/>
      <input id="llm-edit-id" type="hidden"/>
      <div style="display:flex;gap:10px;">
        <button id="llm-edit-cancel"
          style="flex:1;padding:13px;border-radius:10px;font-size:14px;font-weight:700;
          background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);
          color:rgba(228,240,246,.6);cursor:pointer;">
          Cancelar
        </button>
        <button id="llm-edit-save"
          style="flex:1;padding:13px;border-radius:10px;font-size:14px;font-weight:700;
          background:linear-gradient(135deg,#00d4ff,#008fb5);border:none;
          color:#050d12;cursor:pointer;">
          Salvar
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  const closeModal = () => { modal.style.display = 'none'; };
  modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
  $('llm-edit-close').addEventListener('click', closeModal);
  $('llm-edit-cancel').addEventListener('click', closeModal);

  $('llm-edit-save').addEventListener('click', async () => {
    const oldId   = $('llm-edit-id').value;
    const newName = $('llm-edit-name').value.trim();
    if (!newName) { toast('⚠ Digite um nome.', true); return; }

    const driver = _drivers.find(d => d.id === oldId);
    if (!driver) { toast('Motorista não encontrado.', true); return; }

    if (newName === driver.name) { closeModal(); return; }

    const btn = $('llm-edit-save');
    btn.disabled = true;
    btn.textContent = 'Salvando…';

    try {
      const batch = writeBatch(db);

      // Cria novo doc com nome atualizado (ID = nome no Firestore)
      batch.set(doc(db, COL_DRIVERS, newName), {
        ...driver,
        name: newName,
        updatedAt: serverTimestamp()
      });

      // Remove o doc antigo
      batch.delete(doc(db, COL_DRIVERS, oldId));

      // Registra evento
      batch.set(doc(collection(db, COL_EVENTS)), {
        type: 'driver_rename',
        oldName: driver.name,
        newName,
        timestamp: serverTimestamp()
      });

      await batch.commit();
      toast(`✓ Renomeado para "${newName}".`);
      closeModal();

    } catch (err) {
      console.error('[LLM] Erro ao editar motorista:', err);
      toast('Erro ao salvar. Tente novamente.', true);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Salvar';
    }
  });

  $('llm-edit-name').addEventListener('keydown', e => {
    if (e.key === 'Enter') $('llm-edit-save').click();
  });
}

function openEditModal(driverId, driverName) {
  ensureEditModal();
  $('llm-edit-id').value   = driverId;
  $('llm-edit-name').value = driverName;
  $('llm-edit-modal').style.display = 'flex';
  setTimeout(() => $('llm-edit-name')?.select(), 80);
}

// ═══════════════════════════════════════════════════════════════
// SUB-TAB SWITCH — versão definitiva está em index.html (inline)
// que conhece os 4 painéis (dashboard/registros/motoristas/clientes).
// Esta função antiga foi removida para evitar conflito.
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
// GERAR LINK
// ═══════════════════════════════════════════════════════════════
window.llmGenLink = async function() {
  const input = $('llm-new-driver');
  const name  = input?.value.trim();
  if (!name) { toast('⚠ Digite o nome do motorista.', true); return; }

  await setDoc(doc(db, COL_DRIVERS, name), {
    name, truckBlack: 0, truckWhite: 0,
    createdAt: serverTimestamp()
  }, { merge: true });

  const link = `${location.origin}${location.pathname.replace('index.html', '')}lumin-log.html?user=${encodeURIComponent(name)}`;
  if ($('llm-link-txt'))  $('llm-link-txt').textContent = link;
  if ($('llm-link-href')) $('llm-link-href').href = link;
  if ($('llm-link-box'))  $('llm-link-box').style.display = 'block';
  if (input) input.value = '';
  toast(`✓ ${name} cadastrado!`);
};

window.llmCopyLink = function() {
  const txt = $('llm-link-txt')?.textContent;
  if (txt) navigator.clipboard.writeText(txt).then(() => toast('📋 Link copiado!'));
};

// ═══════════════════════════════════════════════════════════════
// RESET INDIVIDUAL
// ═══════════════════════════════════════════════════════════════
window.llmResetDriver = async function(driverId, driverName) {
  if (!confirm(`Zerar caminhão de "${driverName}"?\nFaça isso somente após conferência física.`)) return;
  const batch = writeBatch(db);
  batch.update(doc(db, COL_DRIVERS, driverId), {
    truckBlack: 0, truckWhite: 0, lastReset: serverTimestamp()
  });
  batch.set(doc(collection(db, COL_EVENTS)), {
    type: 'truck_reset', driverName, timestamp: serverTimestamp()
  });
  await batch.commit();
  toast(`✓ Caminhão de ${driverName} zerado.`);
};

// ═══════════════════════════════════════════════════════════════
// EXCLUIR MOTORISTA
// ═══════════════════════════════════════════════════════════════
window.llmDeleteDriver = async function(driverId, driverName) {
  if (!confirm(`Excluir o motorista "${driverName}" permanentemente?\n\nEsta ação não pode ser desfeita.`)) return;
  try {
    await deleteDoc(doc(db, COL_DRIVERS, driverId));
    toast(`✓ Motorista "${driverName}" excluído.`);
  } catch (err) {
    console.error('[LLM] Erro ao excluir motorista:', err);
    toast('Erro ao excluir. Tente novamente.', true);
  }
};

// ═══════════════════════════════════════════════════════════════
// ZERAR TODOS OS CAMINHÕES
// ═══════════════════════════════════════════════════════════════
window.llmZerarTudo = async function() {
  if (!_drivers.length) { toast('Nenhum motorista para zerar.', true); return; }
  const nomes = _drivers.map(d => d.name).join(', ');
  if (!confirm(`Zerar TODOS os caminhões?\n\n${nomes}\n\nFaça isso somente após conferência física.`)) return;
  const batch = writeBatch(db);
  _drivers.forEach(d => {
    batch.update(doc(db, COL_DRIVERS, d.id), {
      truckBlack: 0, truckWhite: 0, lastReset: serverTimestamp()
    });
    batch.set(doc(collection(db, COL_EVENTS)), {
      type: 'truck_reset', driverName: d.name, timestamp: serverTimestamp()
    });
  });
  await batch.commit();
  toast('✓ Todos os caminhões zerados.');
};

// ═══════════════════════════════════════════════════════════════
// ZERAR SALDOS DE CLIENTES
// ═══════════════════════════════════════════════════════════════
window.llmZerarClientes = async function() {
  const comSaldo = _clients.filter(c => nn(c.balanceBlack) + nn(c.balanceWhite) > 0);
  if (!comSaldo.length) { toast('Nenhum saldo para zerar.', true); return; }
  if (!confirm(`Zerar saldo de ${comSaldo.length} cliente(s)?`)) return;
  const batch = writeBatch(db);
  comSaldo.forEach(c => {
    batch.update(doc(db, COL_CLIENTS, c.id), {
      balanceBlack: 0, balanceWhite: 0, zeradoEm: serverTimestamp()
    });
  });
  await batch.commit();
  toast('✓ Saldos dos clientes zerados.');
};

// ═══════════════════════════════════════════════════════════════
// RENDER MOTORISTAS
// ═══════════════════════════════════════════════════════════════
function renderDrivers() {
  const el  = $('llm-drivers-list');
  const cnt = $('llm-driver-count');
  if (!el) return;
  if (cnt) cnt.textContent = _drivers.length;

  if (!_drivers.length) {
    el.innerHTML = '<p style="color:rgba(228,240,246,.4);font-size:13px;padding:6px 0;">Nenhum motorista cadastrado.</p>';
    return;
  }

  el.innerHTML = _drivers.map(d => {
    const b = nn(d.truckBlack), w = nn(d.truckWhite), total = b + w;
    const link = `${location.origin}${location.pathname.replace('index.html','')}lumin-log.html?user=${encodeURIComponent(d.name)}`;
    return `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;
        padding:16px 0;border-bottom:1px solid rgba(255,255,255,.08);" class="llm-driver-row">

        <div style="min-width:0;flex:1;">
          <div style="font-size:15px;font-weight:700;margin-bottom:6px;">${esc(d.name)}</div>
          <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;">
            <span style="font-size:13px;color:rgba(228,240,246,.5);">
              Pretas: <strong style="color:var(--text);">${b}</strong>
            </span>
            <span style="font-size:13px;color:rgba(228,240,246,.5);">
              Brancas: <strong style="color:var(--text);">${w}</strong>
            </span>
            ${total > 0
              ? `<span style="font-size:11px;font-weight:800;color:var(--accent);background:rgba(0,212,255,.1);
                  padding:2px 10px;border-radius:20px;border:1px solid rgba(0,212,255,.2);">${total} total</span>`
              : `<span style="font-size:11px;color:rgba(228,240,246,.35);">caminhão vazio</span>`}
          </div>
        </div>

        <div style="display:flex;gap:6px;flex-shrink:0;flex-wrap:wrap;justify-content:flex-end;">
          <a href="${link}" target="_blank"
            style="font-size:11px;font-weight:700;color:var(--accent);
            padding:8px 12px;border:1px solid rgba(0,212,255,.2);border-radius:8px;
            background:rgba(0,212,255,.06);display:inline-flex;align-items:center;gap:4px;
            text-decoration:none;">
            ↗ Link
          </a>
          <button class="llm-edit-btn"
            data-driver-id="${esc(d.id)}" data-driver-name="${esc(d.name)}"
            style="padding:8px 12px;border-radius:8px;background:rgba(255,179,71,.08);
            border:1px solid rgba(255,179,71,.2);color:#ffb347;font-size:11px;
            font-weight:700;cursor:pointer;">
            ✏️ Editar
          </button>
          <button class="llm-reset-btn"
            data-driver-id="${esc(d.id)}" data-driver-name="${esc(d.name)}"
            style="padding:8px 12px;border-radius:8px;background:rgba(255,91,112,.08);
            border:1px solid rgba(255,91,112,.2);color:var(--alert,#ff5b70);font-size:11px;
            font-weight:700;cursor:pointer;">
            ↺ Reset
          </button>
          <button class="llm-delete-btn"
            data-driver-id="${esc(d.id)}" data-driver-name="${esc(d.name)}"
            style="padding:8px 12px;border-radius:8px;background:rgba(180,40,60,.1);
            border:1px solid rgba(180,40,60,.25);color:#ff3355;font-size:11px;
            font-weight:700;cursor:pointer;">
            🗑 Excluir
          </button>
        </div>
      </div>
    `;
  }).join('');

  // Event delegation — sem onclick inline (sem bug de escaping)
  el.querySelectorAll('.llm-edit-btn').forEach(btn => {
    btn.addEventListener('click', () => openEditModal(btn.dataset.driverId, btn.dataset.driverName));
  });
  el.querySelectorAll('.llm-reset-btn').forEach(btn => {
    btn.addEventListener('click', () => llmResetDriver(btn.dataset.driverId, btn.dataset.driverName));
  });
  el.querySelectorAll('.llm-delete-btn').forEach(btn => {
    btn.addEventListener('click', () => llmDeleteDriver(btn.dataset.driverId, btn.dataset.driverName));
  });

  // Remove borda do último item
  const rows = el.querySelectorAll('.llm-driver-row');
  if (rows.length) rows[rows.length - 1].style.borderBottom = 'none';
}

// ═══════════════════════════════════════════════════════════════
// RENDER CLIENTES
// ═══════════════════════════════════════════════════════════════
function renderClients() {
  const el  = $('llm-clients-list');
  const cnt = $('llm-client-count');
  if (!el) return;

  const comSaldo = _clients
    .filter(c => nn(c.balanceBlack) + nn(c.balanceWhite) > 0)
    .sort((a, b) => (nn(b.balanceBlack)+nn(b.balanceWhite)) - (nn(a.balanceBlack)+nn(a.balanceWhite)));

  if (cnt) cnt.textContent = comSaldo.length;

  if (!comSaldo.length) {
    el.innerHTML = '<p style="color:rgba(228,240,246,.4);font-size:13px;padding:6px 0;">✓ Todos os saldos zerados.</p>';
    return;
  }

  el.innerHTML = comSaldo.map((c, idx) => {
    const b = nn(c.balanceBlack), w = nn(c.balanceWhite), total = b + w;
    const isLast = idx === comSaldo.length - 1;
    return `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;
        padding:14px 0;${isLast ? '' : 'border-bottom:1px solid rgba(255,255,255,.08);'}">
        <div style="min-width:0;flex:1;">
          <div style="font-size:15px;font-weight:700;margin-bottom:4px;">${esc(c.name)}</div>
          <div style="font-size:13px;color:rgba(228,240,246,.5);">
            Pretas: ${b} &nbsp;·&nbsp; Brancas: ${w}
          </div>
        </div>
        <div style="text-align:right;flex-shrink:0;">
          <div style="font-family:'DM Mono',monospace;font-size:28px;font-weight:700;
            color:var(--warning);line-height:1;">${total}</div>
          <div style="font-size:11px;color:rgba(228,240,246,.4);margin-top:3px;">caixas</div>
        </div>
      </div>
    `;
  }).join('');
}

// ═══════════════════════════════════════════════════════════════
// ALERTAS — MOTORISTA ESQUECEU CAIXAS NO CD
// ═══════════════════════════════════════════════════════════════
function ensureAlertsContainer() {
  if (!$('llm-alerts-container')) {
    const panel = $('llm-panel-motoristas');
    if (panel) {
      const div = document.createElement('div');
      div.id = 'llm-alerts-container';
      panel.insertBefore(div, panel.firstChild);
    }
  }
}

function buildAlertsHtml() {
  if (!_pendingAlerts.length) return '';
  return `
    <div style="margin-bottom:18px;">
      <div style="font-size:12px;font-weight:800;color:#ffb347;text-transform:uppercase;
        letter-spacing:.08em;margin-bottom:10px;">⚠️ Alertas — Esqueceu caixas no CD</div>
      ${_pendingAlerts.map(a => {
        const dt = a.date ? a.date.split('-').reverse().join('/') : '?';
        return `
          <div style="background:rgba(255,179,71,.08);border:1.5px solid rgba(255,179,71,.3);
            border-radius:14px;padding:16px 18px;margin-bottom:10px;">
            <div style="font-size:14px;font-weight:700;margin-bottom:10px;color:#e4f0f6;">
              📦 <strong>${esc(a.driverName)}</strong> tinha
              <strong style="color:#ffb347;">${a.cxEsquecidas} caixas</strong>
              no caminhão em ${dt} — esqueceu de deixar no CD!
            </div>
            <div style="display:flex;gap:8px;">
              <button onclick="window.llmAprovarAlerta('${a.id}')"
                style="flex:1;padding:10px;border-radius:9px;font-size:12px;font-weight:800;
                cursor:pointer;background:rgba(0,229,160,.12);
                border:1px solid rgba(0,229,160,.3);color:#00e5a0;">
                ✓ Ciente — OK
              </button>
              <button onclick="window.llmReprovarAlerta('${a.id}')"
                style="flex:1;padding:10px;border-radius:9px;font-size:12px;font-weight:800;
                cursor:pointer;background:rgba(255,91,112,.1);
                border:1px solid rgba(255,91,112,.3);color:#ff5b70;">
                ✕ Registrar Problema
              </button>
            </div>
          </div>`;
      }).join('')}
    </div>`;
}

function renderAlerts() {
  ensureAlertsContainer();
  const html = buildAlertsHtml();
  // Renderiza nos dois containers: aba Motoristas e Dashboard
  ['llm-alerts-container', 'll-alerts-container'].forEach(id => {
    const el = $(id);
    if (el) el.innerHTML = html;
  });
}

window.llmAprovarAlerta = async function(alertId) {
  try {
    await updateDoc(doc(db, COL_EVENTS, alertId), {
      status: 'approved', respondedAt: serverTimestamp()
    });
    toast('✓ Alerta marcado como OK.');
  } catch(e) { toast('Erro ao responder alerta.', true); }
};

window.llmReprovarAlerta = async function(alertId) {
  try {
    await updateDoc(doc(db, COL_EVENTS, alertId), {
      status: 'denied', respondedAt: serverTimestamp()
    });
    toast('✓ Problema registrado.');
  } catch(e) { toast('Erro ao responder alerta.', true); }
};

// ═══════════════════════════════════════════════════════════════
// LISTENERS FIRESTORE
// ═══════════════════════════════════════════════════════════════
function startListeners() {
  _unsubDrivers = onSnapshot(
    query(collection(db, COL_DRIVERS), orderBy('createdAt', 'asc')),
    snap => {
      _drivers = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      renderDrivers();
    },
    err => console.error('[LLM-Motoristas] Drivers:', err)
  );

  _unsubClients = onSnapshot(
    collection(db, COL_CLIENTS),
    snap => {
      _clients = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      renderClients();
    },
    err => console.error('[LLM-Motoristas] Clients:', err)
  );

  _unsubAlerts = onSnapshot(
    query(collection(db, COL_EVENTS),
      where('type',   '==', 'driver_forgot_cd'),
      where('status', '==', 'pending')
    ),
    snap => {
      _pendingAlerts = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      renderAlerts();
    },
    err => console.error('[LLM-Motoristas] Alerts:', err)
  );
}

// ═══════════════════════════════════════════════════════════════
// BOOT
// ═══════════════════════════════════════════════════════════════
window.addEventListener('lumin:admin-ready', () => {
  ensureEditModal();
  startListeners();
});
