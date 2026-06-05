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
  collection, doc, addDoc, updateDoc, setDoc, deleteDoc, deleteField,
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
let _caixasRegs = [];   // registros de controle_caixas para saldo por cliente
let _pendingAlerts = [];
let _unsubDrivers = null;
let _unsubClients = null;
let _unsubAlerts  = null;
let _unsubCaixas  = null;

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

  const CD_RE = /\b(CD|DEPOSITO|DEPÓSITO|RETIRADA|DEVOLU[CÇ][AÃ]O|RETORNO|HETROS)\b/;

  // Filtra período selecionado
  const periodoSel = ($('llm-cli-periodo') || {}).value || 'tudo';
  const hoje  = new Date();
  const hojeYmd = hoje.toLocaleDateString('en-CA');
  const dow   = hoje.getDay();
  const seg   = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate() + ((dow===0)?-6:(1-dow)));
  const segYmd = seg.toLocaleDateString('en-CA');

  const regs = _caixasRegs.filter(r => {
    if (!r.data) return false;
    if (periodoSel === 'hoje')   return r.data === hojeYmd;
    if (periodoSel === 'semana') return r.data >= segYmd && r.data <= hojeYmd;
    return true;
  });

  // Calcula saldo: SAÍDA para cliente = entregou (cliente deve) | ENTRADA = coletou de volta
  const saldo = {};
  regs.forEach(r => {
    const cli = (r.cliente || '').trim();
    if (!cli || CD_RE.test(cli.toUpperCase()) || cli === '—') return;
    if (!saldo[cli]) saldo[cli] = { entregue: 0, coletado: 0, motoristas: new Set() };
    if (r.tipo === 'SAÍDA')  saldo[cli].entregue  += nn(r.quantidadeCx);
    else                      saldo[cli].coletado  += nn(r.quantidadeCx);
    if (r.motorista) saldo[cli].motoristas.add(r.motorista);
  });

  // Só exibe clientes com saldo != 0
  const lista = Object.entries(saldo)
    .map(([nome, v]) => ({ nome, entregue: v.entregue, coletado: v.coletado,
      saldo: v.entregue - v.coletado, motoristas: [...v.motoristas] }))
    .filter(c => c.saldo !== 0)
    .sort((a, b) => b.saldo - a.saldo);

  if (cnt) cnt.textContent = lista.filter(c => c.saldo > 0).length;

  if (!lista.length) {
    el.innerHTML = '<p style="color:rgba(228,240,246,.4);font-size:13px;padding:6px 0;">✓ Todos os saldos zerados.</p>';
    return;
  }

  el.innerHTML = lista.map((c, idx) => {
    const devendo = c.saldo > 0;
    const cor     = devendo ? '#ff9f43' : '#00e5a0';
    const bgRow   = devendo ? 'rgba(255,159,67,.07)' : 'rgba(0,229,160,.05)';
    const borda   = devendo ? 'rgba(255,159,67,.22)'  : 'rgba(0,229,160,.18)';
    const label   = devendo ? `⚠ deve ${c.saldo} cx` : `✓ ${Math.abs(c.saldo)} cx a mais`;
    const mots    = c.motoristas.length
      ? `<span style="font-size:11px;color:rgba(228,240,246,.35);">🚚 ${c.motoristas.join(', ')}</span>` : '';
    const isLast  = idx === lista.length - 1;
    return `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;
        padding:12px 14px;border-radius:10px;margin-bottom:${isLast?'0':'6px'};
        background:${bgRow};border:1px solid ${borda};">
        <div style="min-width:0;flex:1;">
          <div style="font-size:14px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(c.nome)}</div>
          <div style="display:flex;gap:10px;margin-top:3px;flex-wrap:wrap;">
            <span style="font-size:11px;color:rgba(228,240,246,.45);">Entregue: <b style="color:rgba(228,240,246,.7);">${c.entregue}</b></span>
            <span style="font-size:11px;color:rgba(228,240,246,.45);">Coletado: <b style="color:rgba(228,240,246,.7);">${c.coletado}</b></span>
            ${mots}
          </div>
        </div>
        <div style="font-family:'DM Mono',monospace;font-size:14px;font-weight:800;color:${cor};
          white-space:nowrap;text-align:right;">${label}</div>
      </div>`;
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
// MAPA AO VIVO (Leaflet — localização dos motoristas)
// ═══════════════════════════════════════════════════════════════
let _leafMap      = null;
let _leafMarkers  = {};     // driverId → L.marker

function refreshMap() {
  const mapEl    = document.getElementById('ll-map');
  const emptyEl  = document.getElementById('ll-map-empty');
  const countEl  = document.getElementById('ll-map-count');
  if (!mapEl || typeof L === 'undefined') return;

  // Motoristas com localização válida (máx 2h de idade)
  const agora = Date.now();
  const comLoc = _drivers.filter(d => {
    const loc = d.currentLocation;
    if (!loc?.lat || !loc?.lng) return false;
    // Aceita se não tem timestamp OU se tem e é recente (< 2h)
    if (loc.ts?.toMillis) return (agora - loc.ts.toMillis()) < 2 * 60 * 60 * 1000;
    return true;
  });

  if (countEl) countEl.textContent = comLoc.length;
  if (emptyEl) emptyEl.style.display = comLoc.length ? 'none' : 'flex';

  if (!comLoc.length) return;

  // Inicializa mapa na 1ª vez
  if (!_leafMap) {
    _leafMap = L.map('ll-map', { zoomControl: true, attributionControl: false });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18, attribution: '© OSM'
    }).addTo(_leafMap);
    document.getElementById('ll-map-fit')?.addEventListener('click', () => {
      if (Object.keys(_leafMarkers).length) {
        const grp = L.featureGroup(Object.values(_leafMarkers));
        _leafMap.fitBounds(grp.getBounds().pad(0.2));
      }
    });
  }

  // Ícone personalizado
  const mkIcon = name => L.divIcon({
    className: '',
    html: `<div style="
      background:var(--accent,#00d4ff);color:#021824;font-weight:800;
      font-size:10px;padding:4px 7px;border-radius:20px;white-space:nowrap;
      box-shadow:0 2px 8px rgba(0,0,0,.5);font-family:'Inter',sans-serif;
      border:2px solid rgba(255,255,255,.3);">${esc(name.split(' ')[0])}</div>`,
    iconAnchor: [0, 0],
  });

  // Atualiza / cria markers
  const idsAtivos = new Set(comLoc.map(d => d.id));

  // Remove markers de drivers que saíram
  Object.keys(_leafMarkers).forEach(id => {
    if (!idsAtivos.has(id)) {
      _leafMarkers[id].remove();
      delete _leafMarkers[id];
    }
  });

  comLoc.forEach(d => {
    const { lat, lng } = d.currentLocation;
    const label = d.name || d.id;
    if (_leafMarkers[d.id]) {
      _leafMarkers[d.id].setLatLng([lat, lng]);
      _leafMarkers[d.id].setIcon(mkIcon(label));
    } else {
      _leafMarkers[d.id] = L.marker([lat, lng], { icon: mkIcon(label) })
        .addTo(_leafMap)
        .bindPopup(`<b>${esc(label)}</b>`);
    }
  });

  // Centraliza automaticamente na 1ª vez que há dados
  if (comLoc.length && !_leafMap._lumCentered) {
    _leafMap._lumCentered = true;
    const grp = L.featureGroup(Object.values(_leafMarkers));
    _leafMap.fitBounds(grp.getBounds().pad(0.25));
  }
}

// Expõe para outros módulos (luminlog-controller pode chamar também)
window.llmRefreshMap = refreshMap;

// ═══════════════════════════════════════════════════════════════
// LISTENERS FIRESTORE
// ═══════════════════════════════════════════════════════════════
function startListeners() {
  _unsubDrivers = onSnapshot(
    query(collection(db, COL_DRIVERS), orderBy('createdAt', 'asc')),
    snap => {
      _drivers = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      renderDrivers();
      refreshMap();          // ← atualiza mapa toda vez que um driver muda
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

  // Listener controle_caixas — saldo real por cliente
  _unsubCaixas = onSnapshot(
    query(collection(db, COL_CAIXAS), orderBy('createdAt', 'desc')),
    snap => {
      _caixasRegs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      renderClients();
    },
    err => console.error('[LLM-Motoristas] Caixas:', err)
  );
}

// ═══════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════
// FUSÃO DE NOMES DE CLIENTES
// ═══════════════════════════════════════════════════════════════
function _normNome(s) {
  return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

function _levenshtein(a, b) {
  if (!a) return b.length; if (!b) return a.length;
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++)
    dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j-1], dp[i-1][j], dp[i][j-1]);
  return dp[m][n];
}

function _similaridade(a, b) {
  const na = _normNome(a), nb = _normNome(b);
  if (na === nb) return 100;
  if (nb.includes(na) || na.includes(nb)) return 88;
  const wa = na.split(/\s+/), wb = nb.split(/\s+/);
  const comuns = wa.filter(w => w.length > 2 && wb.some(x => x.includes(w) || w.includes(x)));
  if (comuns.length > 0) return Math.min(85, 60 + comuns.length * 12);
  const dist = _levenshtein(na, nb);
  const maxLen = Math.max(na.length, nb.length);
  return maxLen > 0 ? Math.round((1 - dist / maxLen) * 55) : 0;
}

window.llmAnalisarNomes = async function() {
  const listEl = document.getElementById('llm-nomes-suspeitos-list');
  const cntEl  = document.getElementById('llm-suspeitos-count');
  if (!listEl) return;
  listEl.innerHTML = '<p style="color:var(--muted);font-size:13px;padding:6px 0;">⏳ Carregando nomes...</p>';

  try {
    // 1. Coleta todos os nomes de clientes do Firestore
    const [snapCc, snapCl] = await Promise.all([
      getDocs(query(collection(db, 'controle_caixas'))),
      getDocs(collection(db, 'll_clients'))
    ]);

    const nomesSet = new Set();
    const CD_REGEX = /\b(CD|DEPOSITO|DEPÓSITO|RETIRADA|DEVOLU|RETORNO|HETROS)\b/;
    snapCc.docs.forEach(d => {
      const c = (d.data().cliente || '').trim().toUpperCase();
      if (c && c.length > 2 && !CD_REGEX.test(c) && c !== '—') nomesSet.add(c);
    });
    snapCl.docs.forEach(d => { if (d.id) nomesSet.add(d.id.trim().toUpperCase()); });

    const nomes = Array.from(nomesSet).sort();
    if (!nomes.length) {
      listEl.innerHTML = '<p style="color:var(--muted);font-size:13px;padding:6px 0;">Nenhum cliente encontrado.</p>';
      return;
    }

    // 2. Envia para a IA analisar
    listEl.innerHTML = `<p style="color:var(--muted);font-size:13px;padding:6px 0;">🤖 IA analisando ${nomes.length} nomes...</p>`;

    const resp = await fetch('/api/analisar-nomes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nomes })
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.detail || err.error || `HTTP ${resp.status}`);
    }

    const data = await resp.json();
    const grupos = (data.grupos || []).filter(g => g.variantes?.length > 0);

    if (cntEl) cntEl.textContent = grupos.length;

    if (!grupos.length) {
      listEl.innerHTML = '<p style="color:#00e5a0;font-size:13px;padding:6px 0;">✓ Nenhum nome duplicado encontrado pela IA.</p>';
      return;
    }

    // Salva os grupos para uso no fundir
    window._llmGruposIA = grupos;

    listEl.innerHTML = grupos.map((grupo, gi) => {
      const todos = [grupo.canonico, ...grupo.variantes];
      const itens = todos.map((nome, ni) => `
        <label style="display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid rgba(255,255,255,.05);cursor:pointer;">
          <input type="radio" name="llm-grupo-${gi}" value="${esc(nome)}" ${ni===0?'checked':''}
            style="accent-color:var(--accent);width:15px;height:15px;flex-shrink:0;"/>
          <span style="font-size:13px;font-weight:${ni===0?'800':'600'};color:${ni===0?'var(--text)':'var(--muted)'};">${esc(nome)}</span>
          ${ni===0?'<span style="font-size:10px;color:var(--accent);background:rgba(0,212,255,.1);border:1px solid rgba(0,212,255,.2);border-radius:20px;padding:1px 7px;">sugerido</span>':''}
        </label>`).join('');

      return `
        <div id="llm-grupo-${gi}" style="background:rgba(255,179,71,.05);border:1.5px solid rgba(255,179,71,.2);border-radius:14px;padding:14px 16px;margin-bottom:12px;">
          <div style="font-size:11px;font-weight:800;color:#ffb347;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px;">Grupo ${gi+1}</div>
          <div style="font-size:12px;color:rgba(228,240,246,.5);margin-bottom:10px;font-style:italic;">${esc(grupo.motivo || '')}</div>
          <div style="margin-bottom:12px;">${itens}</div>
          <div style="display:flex;gap:8px;">
            <button onclick="window.llmFundirGrupo(${gi},'llm-grupo-${gi}')"
              style="flex:1;padding:9px;border-radius:9px;font-size:12px;font-weight:800;cursor:pointer;
              background:rgba(0,229,160,.1);border:1px solid rgba(0,229,160,.3);color:#00e5a0;">
              ✓ Fundir — usar nome selecionado
            </button>
            <button onclick="document.getElementById('llm-grupo-${gi}').remove();window.llmAjustarContadorSuspeitos();"
              style="padding:9px 14px;border-radius:9px;font-size:12px;font-weight:800;cursor:pointer;
              background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);color:var(--muted);">
              Ignorar
            </button>
          </div>
        </div>`;
    }).join('');

  } catch(err) {
    console.error('[LLM] Analisar nomes:', err);
    listEl.innerHTML = `<p style="color:var(--alert);font-size:13px;padding:6px 0;">Erro: ${err.message}. Tente novamente.</p>`;
  }
};

window.llmRenderCliPeriodo = function() { renderClients(); };

window.llmAjustarContadorSuspeitos = function() {
  const cntEl = document.getElementById('llm-suspeitos-count');
  if (!cntEl) return;
  const grupos = document.querySelectorAll('[id^="llm-grupo-"]').length;
  cntEl.textContent = grupos;
};

window.llmFundirGrupo = async function(gi, grupoId) {
  const grupoEl = document.getElementById(grupoId);
  if (!grupoEl) return;
  const radio = grupoEl.querySelector(`input[name="llm-grupo-${gi}"]:checked`);
  if (!radio) { toast('Selecione um nome canônico.', true); return; }
  const nomeCanon = radio.value;

  // Todos os outros nomes do grupo
  const outros = Array.from(grupoEl.querySelectorAll(`input[name="llm-grupo-${gi}"]`))
    .map(r => r.value).filter(v => v !== nomeCanon);

  if (!outros.length) { grupoEl.remove(); window.llmAjustarContadorSuspeitos(); return; }

  const confirmMsg = `Renomear:\n${outros.join('\n')}\n\n→ para: "${nomeCanon}"\n\nIsso vai atualizar todos os registros de caixas.`;
  if (!confirm(confirmMsg)) return;

  const btn = grupoEl.querySelector('button');
  if (btn) { btn.disabled = true; btn.textContent = 'Fundindo...'; }

  try {
    // Busca todos os registros com os nomes antigos e renomeia em batch
    for (const nomeAntigo of outros) {
      const snap = await getDocs(
        query(collection(db, 'controle_caixas'), where('cliente', '==', nomeAntigo))
      );
      if (snap.empty) continue;
      const batch = writeBatch(db);
      snap.docs.forEach(d => batch.update(d.ref, { cliente: nomeCanon }));
      await batch.commit();

      // Renomeia também em ll_clients se existir
      try {
        const clienteDoc = await getDocs(query(collection(db, 'll_clients'), where('name', '==', nomeAntigo)));
        if (!clienteDoc.empty) {
          const batch2 = writeBatch(db);
          clienteDoc.docs.forEach(d => {
            batch2.set(doc(db, 'll_clients', nomeCanon), { ...d.data(), name: nomeCanon }, { merge: true });
            batch2.delete(d.ref);
          });
          await batch2.commit();
        }
      } catch(_) {}
    }

    toast(`✓ "${outros.join('", "')}" fundidos em "${nomeCanon}".`);
    grupoEl.remove();
    window.llmAjustarContadorSuspeitos();
  } catch(err) {
    console.error('[LLM] Fusão:', err);
    toast('Erro ao fundir. Tente novamente.', true);
    if (btn) { btn.disabled = false; btn.textContent = '✓ Fundir — usar nome selecionado'; }
  }
};

// ═══════════════════════════════════════════════════════════════
// GALERIA DE FOTOS
// ═══════════════════════════════════════════════════════════════
let _allFotos = [];   // cache de todos os eventos com foto
let _unsubFotos = null;

function startFotosListener() {
  if (_unsubFotos) return;
  // Ouve ll_events ordenado por timestamp desc (últimas 500)
  const q = query(collection(db, COL_EVENTS), orderBy('timestamp', 'desc'));
  _unsubFotos = onSnapshot(q, snap => {
    _allFotos = [];
    snap.docs.forEach(d => {
      const ev = { id: d.id, ...d.data() };
      const ts = ev.timestamp?.toDate ? ev.timestamp.toDate() : new Date(ev.timestamp || 0);
      const base = { id: ev.id, tipo: ev.type, motorista: ev.driverName || ev.motorista || '', ts };

      if (ev.type === 'cd_departure' && ev.fotoUrl) {
        _allFotos.push({ ...base, url: ev.fotoUrl, campo: 'fotoUrl', label: '📦 Saída do CD', color: '#0af' });
      }
      if (ev.type === 'cd_return' && ev.fotoUrl) {
        _allFotos.push({ ...base, url: ev.fotoUrl, campo: 'fotoUrl', label: '🏠 Devolução ao CD', color: '#00e5a0' });
      }
      if (ev.type === 'client_transaction') {
        if (ev.fotoEntrega) {
          _allFotos.push({ ...base, url: ev.fotoEntrega, campo: 'fotoEntrega', label: '🤝 Entrega', color: '#f5a623',
            cliente: ev.clientName || ev.cliente || '' });
        }
        if (ev.fotoColeta) {
          _allFotos.push({ ...base, url: ev.fotoColeta, campo: 'fotoColeta', label: '📥 Coleta', color: '#c084fc',
            cliente: ev.clientName || ev.cliente || '' });
        }
      }
    });
    window.llmFiltrarFotos();
  }, err => console.error('[LLM-Fotos]', err));
}

window.llmFiltrarFotos = function() {
  const gallery = document.getElementById('llm-photos-gallery');
  if (!gallery) return;

  const tipoFiltro = (document.getElementById('llm-foto-filtro-tipo') || {}).value || '';
  const dataFiltro = (document.getElementById('llm-foto-filtro-data') || {}).value || 'hoje';

  const agora = new Date();
  const inicioHoje = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate());
  const inicioSemana = new Date(inicioHoje); inicioSemana.setDate(inicioHoje.getDate() - inicioHoje.getDay());

  const fotos = _allFotos.filter(f => {
    if (tipoFiltro && f.tipo !== tipoFiltro) return false;
    if (dataFiltro === 'hoje' && f.ts < inicioHoje) return false;
    if (dataFiltro === 'semana' && f.ts < inicioSemana) return false;
    return true;
  });

  // Atualiza contador
  const cnt = document.getElementById('llm-photos-count');
  if (cnt) cnt.textContent = fotos.length;

  if (!fotos.length) {
    gallery.innerHTML = `<p style="color:rgba(228,240,246,.4);font-size:13px;grid-column:1/-1;padding:8px 0;">
      Nenhuma foto encontrada para o filtro selecionado.</p>`;
    return;
  }

  gallery.innerHTML = fotos.map(f => {
    const hora = f.ts.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    const data = f.ts.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
    const sub  = f.cliente ? `<div style="font-size:10px;color:rgba(228,240,246,.45);margin-top:2px;
      white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(f.cliente)}</div>` : '';
    return `
      <div style="background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);
        border-radius:12px;overflow:hidden;position:relative;">
        <div style="position:relative;cursor:pointer;"
          onclick="window.llmVerFotoGrande('${f.url}','${esc(f.label)} — ${esc(f.motorista)}')">
          <img src="${f.url}" loading="lazy"
            style="width:100%;height:120px;object-fit:cover;display:block;"
            onerror="this.closest('div[style*=border-radius]').style.display='none'"/>
          <button onclick="event.stopPropagation();window.llmApagarFoto('${f.id}','${f.campo}')"
            title="Apagar foto"
            style="position:absolute;top:6px;right:6px;width:28px;height:28px;border-radius:7px;
            background:rgba(0,0,0,.65);border:1px solid rgba(255,255,255,.15);color:#ff5b70;
            font-size:14px;cursor:pointer;display:flex;align-items:center;justify-content:center;
            backdrop-filter:blur(4px);z-index:2;">🗑</button>
        </div>
        <div style="padding:8px 10px;">
          <div style="font-size:10px;font-weight:800;color:${f.color};
            text-transform:uppercase;letter-spacing:.05em;">${f.label}</div>
          <div style="font-size:11px;color:rgba(228,240,246,.8);margin-top:3px;
            white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(f.motorista)}</div>
          ${sub}
          <div style="font-size:10px;color:rgba(228,240,246,.35);margin-top:4px;">${data} ${hora}</div>
        </div>
      </div>`;
  }).join('');
};

window.llmVerFotoGrande = function(url, titulo) {
  let ov = document.getElementById('llm-foto-overlay');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'llm-foto-overlay';
    ov.style.cssText = 'display:none;position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.92);' +
      'align-items:center;justify-content:center;flex-direction:column;padding:20px;cursor:zoom-out;';
    ov.onclick = () => { ov.style.display = 'none'; };
    document.body.appendChild(ov);
  }
  ov.innerHTML = `
    <div style="font-size:13px;font-weight:700;color:rgba(228,240,246,.7);margin-bottom:12px;">${esc(titulo)}</div>
    <img src="${url}" style="max-width:100%;max-height:80vh;border-radius:12px;box-shadow:0 8px 40px rgba(0,0,0,.6);"
      onerror="this.src='';this.alt='Foto indisponível'"/>
    <div style="font-size:11px;color:rgba(228,240,246,.35);margin-top:10px;">Clique para fechar</div>`;
  ov.style.display = 'flex';
};

window.llmApagarFoto = async function(eventId, campo) {
  if (!confirm('Apagar esta foto? A ação não pode ser desfeita.')) return;
  try {
    await updateDoc(doc(db, COL_EVENTS, eventId), { [campo]: deleteField() });
    toast('🗑 Foto removida.');
  } catch(err) {
    console.error('[LLM] Apagar foto:', err);
    toast('Erro ao apagar foto.', true);
  }
};

// BOOT
// ═══════════════════════════════════════════════════════════════
window.addEventListener('lumin:admin-ready', () => {
  ensureEditModal();
  startListeners();
  startFotosListener();
});
