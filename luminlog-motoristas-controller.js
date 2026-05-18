/**
 * ═══════════════════════════════════════════════════════════════
 *  LUMIN — Controle Hetros Motoristas Controller
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
  onSnapshot, query, orderBy, limit, writeBatch, serverTimestamp, getDocs
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

// ── Coleções ────────────────────────────────────────────────────
const COL_DRIVERS  = 'll_drivers';
const COL_CLIENTS  = 'll_clients';
const COL_EVENTS   = 'll_events';
const COL_CAIXAS   = 'controle_caixas';

// ── Estado ──────────────────────────────────────────────────────
let _drivers = [];
let _clients = [];
let _events  = [];
let _registros = [];                      // registros do controle_caixas
let _weekOffset = 0;                      // 0 = semana atual, -1 = anterior, +1 = próxima
let _unsubDrivers = null;
let _unsubClients = null;
let _unsubEvents  = null;
let _unsubRegistros = null;

// ── Helpers de semana (segunda → domingo) ───────────────────────
function getWeekRange(offset = 0) {
  const now = new Date();
  const dow = now.getDay();              // 0=Dom, 1=Seg, ..., 6=Sáb
  const diffToMonday = (dow === 0) ? -6 : (1 - dow);
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + diffToMonday + offset * 7);
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6, 23, 59, 59, 999);
  monday.setHours(0,0,0,0);
  return { from: monday, to: sunday };
}
function fmtDate(d) {
  const dd = String(d.getDate()).padStart(2,'0');
  const mm = String(d.getMonth()+1).padStart(2,'0');
  return `${dd}/${mm}`;
}
function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

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

// SUB-TAB SWITCH
// ═══════════════════════════════════════════════════════════════
window.llmSwitchTab = function(tab) {
  const tabs = ['dashboard', 'registros', 'motoristas', 'clientes'];
  tabs.forEach(t => {
    const panel = document.getElementById(`llm-panel-${t}`);
    const btn   = document.getElementById(`llm-btn-${t}`);
    const isActive = t === tab;
    if (panel) panel.style.display = isActive ? 'block' : 'none';
    if (btn)   btn.classList.toggle('active', isActive);
  });
  if (tab === 'dashboard' && typeof window.llRenderCharts === 'function') {
    setTimeout(window.llRenderCharts, 80);
  }
};

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
// RESUMO DA SEMANA (segunda → domingo)
// ═══════════════════════════════════════════════════════════════
function renderWeekSummary() {
  const el = $('llm-week-list');
  if (!el) return;

  const { from, to } = getWeekRange(_weekOffset);
  const fromYmd = ymd(from);
  const toYmd   = ymd(to);

  // Atualiza label
  const lbl = $('llm-week-range');
  if (lbl) lbl.textContent = `${fmtDate(from)} — ${fmtDate(to)}`;
  const head = $('llm-week-label')?.querySelector('span:first-child');
  if (head) {
    head.textContent = _weekOffset === 0 ? 'Semana atual' :
                       _weekOffset === -1 ? 'Semana passada' :
                       _weekOffset > 0 ? `${_weekOffset} semana(s) à frente` :
                                          `${Math.abs(_weekOffset)} semanas atrás`;
  }

  // Filtra registros desta semana (campo 'data' = YYYY-MM-DD)
  const wkRegs = _registros.filter(r => {
    const d = r.data || '';
    return d >= fromYmd && d <= toYmd;
  });

  // Lista de motoristas com pelo menos cadastro (ou que aparecem nos registros)
  const driverNames = new Set(_drivers.map(d => d.name));
  wkRegs.forEach(r => { if (r.motorista) driverNames.add(r.motorista.trim()); });

  if (!driverNames.size) {
    el.innerHTML = '<p style="color:var(--muted);font-size:13px;padding:16px 0;text-align:center;letter-spacing:-.005em;">Sem motoristas cadastrados.</p>';
    return;
  }

  const sumByDriver = {};
  driverNames.forEach(name => {
    sumByDriver[name] = { entradas:0, saidas:0, pretas:0, brancas:0, valor:0, count:0, dias:new Set(), clientes:new Set() };
  });
  wkRegs.forEach(r => {
    const name = (r.motorista || '').trim();
    if (!name || !sumByDriver[name]) return;
    const cx = Number(r.quantidadeCx || 0);
    const tipo = r.tipo || '';
    const cor = (r.cor || '').toLowerCase();
    const bucket = sumByDriver[name];
    if (tipo === 'ENTRADA') bucket.entradas += cx;
    if (tipo === 'SAÍDA')   bucket.saidas   += cx;
    if (cor.includes('pret'))  bucket.pretas  += cx;
    if (cor.includes('branc')) bucket.brancas += cx;
    bucket.valor += Number(r.valorTotal || 0);
    bucket.count++;
    if (r.data) bucket.dias.add(r.data);
    if (r.cliente) bucket.clientes.add(r.cliente);
  });

  // Ordena por volume total movido na semana (mais ativo primeiro)
  const sorted = Array.from(driverNames).sort((a, b) => {
    const A = sumByDriver[a], B = sumByDriver[b];
    const totalA = A.entradas + A.saidas;
    const totalB = B.entradas + B.saidas;
    return totalB - totalA;
  });

  const fmt = v => Number(v).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
  el.innerHTML = sorted.map(name => {
    const s = sumByDriver[name];
    const total = s.entradas + s.saidas;
    const drvId = `wk-${name.replace(/[^a-z0-9]/gi,'_')}`;
    return `
      <div class="llm-week-compact" data-drv-id="${drvId}">
        <span class="llm-week-compact-name">${esc(name)}</span>
        <span class="llm-week-compact-meta">
          ${total > 0
            ? `<strong style="color:var(--success);">${s.entradas}↑</strong> · <strong style="color:var(--alert);">${s.saidas}↓</strong> · <strong>${total}</strong> total`
            : '<span style="color:var(--muted);">sem movimentação</span>'}
        </span>
        <svg class="llm-week-compact-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
      </div>
      <div class="llm-week-expand" data-drv-detail="${drvId}" style="display:none;">
        <div class="llm-week-stats">
          <div>Pretas <span class="llm-week-stat-val">${s.pretas}</span></div>
          <div>Brancas <span class="llm-week-stat-val">${s.brancas}</span></div>
          <div>Clientes <span class="llm-week-stat-val">${s.clientes.size}</span></div>
          <div>Dias ativos <span class="llm-week-stat-val">${s.dias.size}</span></div>
          <div>Valor <span class="llm-week-stat-val">${fmt(s.valor)}</span></div>
          <div>Registros <span class="llm-week-stat-val">${s.count}</span></div>
        </div>
      </div>`;
  }).join('');

  // Toggle de expansão por clique
  el.querySelectorAll('.llm-week-compact').forEach(row => {
    row.addEventListener('click', () => {
      const id = row.dataset.drvId;
      const detail = el.querySelector(`[data-drv-detail="${id}"]`);
      if (!detail) return;
      const open = detail.style.display !== 'none';
      detail.style.display = open ? 'none' : 'block';
      row.classList.toggle('open', !open);
    });
  });
}

window.llmEncerrarSemana = async function() {
  const { from, to } = getWeekRange(_weekOffset);
  const tambemClientes = confirm(
    `Encerrar a semana de ${fmtDate(from)} a ${fmtDate(to)}?\n\n` +
    `• Vai baixar o relatório Excel da semana\n` +
    `• Vai ZERAR os caixas em rota de TODOS os motoristas\n` +
    `• Os registros ficam preservados em "Registros"\n\n` +
    `OK = encerrar | Cancelar = abortar`
  );
  if (!tambemClientes) return;

  // Pergunta separada se quer zerar saldos dos clientes também
  const zerarClientes = confirm(
    `Também zerar SALDOS DEVEDORES dos clientes?\n\n` +
    `OK = zerar tudo (clientes + motoristas) — recomeço total\n` +
    `Cancelar = só zerar motoristas (mantém saldo dos clientes)`
  );

  toast('Gerando relatório...');

  // 1. Exporta Excel ANTES de zerar
  try { await exportWeekExcel(from, to); }
  catch (e) { console.error('[Excel]', e); toast('⚠ Falha ao gerar Excel — continuando reset', true); }

  // 2. Zera caixas em rota + opcionalmente saldos de clientes
  const batch = writeBatch(db);
  _drivers.forEach(d => {
    batch.update(doc(db, COL_DRIVERS, d.id), {
      truckBlack: 0, truckWhite: 0,
      lastReset: serverTimestamp(),
      lastWeekClose: ymd(to)
    });
    batch.set(doc(collection(db, COL_EVENTS)), {
      type: 'week_close',
      driverName: d.name,
      weekFrom: ymd(from),
      weekTo: ymd(to),
      timestamp: serverTimestamp()
    });
  });
  if (zerarClientes) {
    _clients.forEach(c => {
      if ((c.balanceBlack || 0) + (c.balanceWhite || 0) === 0) return;
      batch.update(doc(db, COL_CLIENTS, c.id), {
        balanceBlack: 0, balanceWhite: 0,
        zeradoEm: serverTimestamp(),
        zeradoBy: 'week_close'
      });
    });
  }
  await batch.commit();
  toast(zerarClientes ? '✓ Semana encerrada. Tudo zerado (motoristas + clientes).' : '✓ Semana encerrada. Motoristas zerados.');
};

// ─── Export Excel da semana (relatório com 2 abas: Resumo + Detalhes) ────
async function exportWeekExcel(from, to) {
  // Carrega ExcelJS sob demanda
  if (typeof ExcelJS === 'undefined') {
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js';
      s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    }).catch(() => { toast('❌ Falha ao carregar ExcelJS', true); throw new Error('ExcelJS load fail'); });
  }

  const fromYmd = ymd(from), toYmd = ymd(to);
  const wkRegs = _registros.filter(r => (r.data || '') >= fromYmd && (r.data || '') <= toYmd);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Lumin · Controle Hetros';
  wb.created = new Date();

  // ── Paleta
  const C = {
    headerBg: 'FF111114',  headerFg: 'FFFFFFFF',
    rowAlt:   'FFF7F7F7',  border:   'FFE5E5E5',
    accent:   'FF00D4FF',  success:  'FF22C55E',  alert: 'FFEF4444',
  };
  const fmtBRL = '"R$" #,##0.00';
  const border = { top:{style:'thin',color:{argb:C.border}}, bottom:{style:'thin',color:{argb:C.border}}, left:{style:'thin',color:{argb:C.border}}, right:{style:'thin',color:{argb:C.border}} };

  // ════════════════════════════════════════════════
  // ABA 1: RESUMO POR MOTORISTA
  // ════════════════════════════════════════════════
  const ws1 = wb.addWorksheet('Resumo', { views: [{ state: 'frozen', ySplit: 5 }] });
  ws1.columns = [
    { width: 28 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 },
    { width: 14 }, { width: 14 }, { width: 16 }, { width: 14 }
  ];

  // Título
  ws1.mergeCells('A1:I1');
  const t1 = ws1.getCell('A1');
  t1.value = 'CONTROLE HETROS · Resumo da Semana';
  t1.font = { name: 'Calibri', size: 16, bold: true, color: { argb: C.headerFg } };
  t1.alignment = { horizontal: 'left', vertical: 'middle' };
  t1.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.headerBg } };
  ws1.getRow(1).height = 30;

  ws1.mergeCells('A2:I2');
  const t2 = ws1.getCell('A2');
  t2.value = `Período: ${fmtDate(from)} a ${fmtDate(to)} · Gerado em ${new Date().toLocaleString('pt-BR')}`;
  t2.font = { name: 'Calibri', size: 10, italic: true, color: { argb: 'FF666666' } };

  // Aglomerar por motorista
  const sumByDriver = {};
  const driverNames = new Set(_drivers.map(d => d.name));
  wkRegs.forEach(r => { if (r.motorista) driverNames.add(String(r.motorista).trim()); });
  driverNames.forEach(name => {
    sumByDriver[name] = { entradas:0, saidas:0, pretas:0, brancas:0, valor:0, count:0, dias:new Set(), clientes:new Set() };
  });
  wkRegs.forEach(r => {
    const name = (r.motorista || '').trim();
    if (!name || !sumByDriver[name]) return;
    const cx = Number(r.quantidadeCx || 0);
    const bucket = sumByDriver[name];
    if (r.tipo === 'ENTRADA') bucket.entradas += cx;
    if (r.tipo === 'SAÍDA')   bucket.saidas   += cx;
    if ((r.cor||'').toLowerCase().includes('pret'))  bucket.pretas  += cx;
    if ((r.cor||'').toLowerCase().includes('branc')) bucket.brancas += cx;
    bucket.valor += Number(r.valorTotal || 0);
    bucket.count++;
    if (r.data) bucket.dias.add(r.data);
    if (r.cliente) bucket.clientes.add(r.cliente);
  });

  // Cabeçalho da tabela
  const headers1 = ['Motorista', 'Entradas', 'Saídas', 'Pretas', 'Brancas', 'Clientes', 'Dias ativos', 'Valor total', 'Nº registros'];
  ws1.addRow([]);
  ws1.addRow([]);
  ws1.addRow(headers1).eachCell(c => {
    c.font = { bold: true, color: { argb: C.headerFg } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.headerBg } };
    c.alignment = { horizontal: 'center', vertical: 'middle' };
    c.border = border;
  });
  ws1.getRow(5).height = 24;

  const sorted = Array.from(driverNames).sort((a,b) => {
    const A = sumByDriver[a], B = sumByDriver[b];
    return (B.entradas+B.saidas) - (A.entradas+A.saidas);
  });

  sorted.forEach((name, idx) => {
    const s = sumByDriver[name];
    const row = ws1.addRow([name, s.entradas, s.saidas, s.pretas, s.brancas, s.clientes.size, s.dias.size, s.valor, s.count]);
    row.eachCell((c, col) => {
      c.alignment = { horizontal: col === 1 ? 'left' : 'center', vertical: 'middle' };
      c.border = border;
      c.font = { name: 'Calibri', size: 11 };
      if (idx % 2 === 1) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.rowAlt } };
    });
    row.getCell(1).font = { bold: true };
    row.getCell(2).font = { color: { argb: C.success } };
    row.getCell(3).font = { color: { argb: C.alert } };
    row.getCell(8).numFmt = fmtBRL;
  });

  // Linha total
  const totalsRow = ws1.addRow([
    'TOTAL',
    sorted.reduce((a,n)=>a+sumByDriver[n].entradas,0),
    sorted.reduce((a,n)=>a+sumByDriver[n].saidas,0),
    sorted.reduce((a,n)=>a+sumByDriver[n].pretas,0),
    sorted.reduce((a,n)=>a+sumByDriver[n].brancas,0),
    new Set(wkRegs.map(r=>r.cliente).filter(Boolean)).size,
    new Set(wkRegs.map(r=>r.data).filter(Boolean)).size,
    sorted.reduce((a,n)=>a+sumByDriver[n].valor,0),
    sorted.reduce((a,n)=>a+sumByDriver[n].count,0)
  ]);
  totalsRow.eachCell(c => {
    c.font = { bold: true, color: { argb: C.headerFg } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.headerBg } };
    c.alignment = { horizontal: 'center', vertical: 'middle' };
    c.border = border;
  });
  totalsRow.getCell(8).numFmt = fmtBRL;

  // ════════════════════════════════════════════════
  // ABA 2: DETALHES (todos os registros da semana)
  // ════════════════════════════════════════════════
  const ws2 = wb.addWorksheet('Detalhes', { views: [{ state: 'frozen', ySplit: 5 }] });
  ws2.columns = [
    { width: 12 }, { width: 12 }, { width: 22 }, { width: 22 }, { width: 10 },
    { width: 10 }, { width: 12 }, { width: 16 }
  ];
  ws2.mergeCells('A1:H1');
  ws2.getCell('A1').value = 'CONTROLE HETROS · Detalhes da Semana';
  ws2.getCell('A1').font = { size: 16, bold: true, color: { argb: C.headerFg } };
  ws2.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.headerBg } };
  ws2.getCell('A1').alignment = { horizontal: 'left', vertical: 'middle' };
  ws2.getRow(1).height = 30;
  ws2.mergeCells('A2:H2');
  ws2.getCell('A2').value = `${fmtDate(from)} a ${fmtDate(to)} · ${wkRegs.length} registro(s)`;
  ws2.getCell('A2').font = { size: 10, italic: true, color: { argb: 'FF666666' } };

  ws2.addRow([]); ws2.addRow([]);
  const headers2 = ['Data', 'Tipo', 'Cliente', 'Motorista', 'Cor', 'Qtd', 'Valor unit.', 'Valor total'];
  ws2.addRow(headers2).eachCell(c => {
    c.font = { bold: true, color: { argb: C.headerFg } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.headerBg } };
    c.alignment = { horizontal: 'center', vertical: 'middle' };
    c.border = border;
  });

  const sortedRegs = [...wkRegs].sort((a,b) => (b.data||'').localeCompare(a.data||''));
  sortedRegs.forEach((r, idx) => {
    const row = ws2.addRow([
      r.data || '',
      r.tipo || '',
      r.cliente || '',
      r.motorista || '',
      r.cor || '',
      Number(r.quantidadeCx || 0),
      Number(r.valorUnitario || 0),
      Number(r.valorTotal || 0)
    ]);
    row.eachCell((c, col) => {
      c.alignment = { horizontal: col >= 6 ? 'right' : 'left', vertical: 'middle' };
      c.border = border;
      c.font = { name: 'Calibri', size: 10 };
      if (idx % 2 === 1) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.rowAlt } };
    });
    row.getCell(2).font = { color: { argb: r.tipo === 'ENTRADA' ? C.success : C.alert }, bold: true };
    row.getCell(7).numFmt = fmtBRL;
    row.getCell(8).numFmt = fmtBRL;
  });

  // Download
  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `controle-hetros-semana-${fromYmd}-a-${toYmd}.xlsx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

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

    // Fotos recentes deste motorista (últimos eventos com foto)
    const driverEvs = _events.filter(ev => ev.driverName === d.name);
    const fotos = [];
    driverEvs.forEach(ev => {
      if (ev.fotoUrl)      fotos.push({ url: ev.fotoUrl,      label: 'Retirada CD' });
      if (ev.fotoEntrega)  fotos.push({ url: ev.fotoEntrega,  label: 'Entrega' });
      if (ev.fotoColeta)   fotos.push({ url: ev.fotoColeta,   label: 'Coleta' });
    });
    // Máximo 4 fotos mais recentes
    const fotosRecentes = fotos.slice(0, 4);

    const fotosHtml = fotosRecentes.length ? `
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;">
        ${fotosRecentes.map((f, i) => `
          <div style="position:relative;cursor:pointer;" onclick="llmVerFoto('${encodeURIComponent(f.url)}','${esc(f.label)}','${esc(d.name)}')">
            <img src="${f.url}" alt="${esc(f.label)}"
              style="width:60px;height:60px;object-fit:cover;border-radius:10px;
              border:1.5px solid rgba(0,212,255,.3);display:block;"/>
            <div style="position:absolute;bottom:2px;left:0;right:0;text-align:center;
              font-size:8px;font-weight:700;color:#fff;background:rgba(0,0,0,.55);
              border-radius:0 0 8px 8px;padding:2px 0;">${esc(f.label)}</div>
          </div>
        `).join('')}
      </div>` : '';

    // ── Live location pin
    let liveHtml = '';
    if (d.currentLocation?.lat) {
      const ts = d.currentLocation.ts?.toDate?.() || (d.currentLocation.ts ? new Date(d.currentLocation.ts) : null);
      const ageMin = ts ? Math.round((Date.now() - ts.getTime()) / 60000) : null;
      const isLive = ageMin !== null && ageMin <= 5;
      const ageTxt = ageMin === null ? 'desconhecido' :
                     ageMin < 1 ? 'agora' :
                     ageMin === 1 ? 'há 1 min' :
                     ageMin < 60 ? `há ${ageMin} min` :
                     `há ${Math.floor(ageMin/60)}h`;
      const lat = d.currentLocation.lat.toFixed(5);
      const lng = d.currentLocation.lng.toFixed(5);
      const mapsUrl = `https://www.google.com/maps?q=${lat},${lng}`;
      liveHtml = `
        <a href="${mapsUrl}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border-radius:6px;background:${isLive?'rgba(74,222,128,.10)':'rgba(255,255,255,.04)'};border:1px solid ${isLive?'rgba(74,222,128,.25)':'var(--border)'};text-decoration:none;font-size:11.5px;font-weight:500;color:${isLive?'#4ade80':'var(--muted)'};letter-spacing:-.005em;">
          <span style="width:6px;height:6px;border-radius:50%;background:${isLive?'#4ade80':'var(--muted)'};${isLive?'animation:pulseGreen 2s infinite;':''}"></span>
          ${isLive?'Ao vivo':'Última posição'} · ${ageTxt}
        </a>`;
    }

    return `
      <div style="padding:14px 0;border-bottom:1px solid var(--border);" class="llm-driver-row">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">

          <div style="min-width:0;flex:1;">
            <div style="font-size:14px;font-weight:600;letter-spacing:-.015em;margin-bottom:6px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
              ${esc(d.name)}
              ${liveHtml}
            </div>
            <div style="display:flex;gap:14px;flex-wrap:wrap;align-items:center;font-size:12.5px;letter-spacing:-.005em;">
              <span style="color:var(--muted);">Pretas <strong style="color:var(--text);font-weight:500;margin-left:3px;">${b}</strong></span>
              <span style="color:var(--muted);">Brancas <strong style="color:var(--text);font-weight:500;margin-left:3px;">${w}</strong></span>
              ${total > 0
                ? `<span style="font-size:11px;font-weight:500;color:var(--accent);background:rgba(255,255,255,.04);border:1px solid var(--border);padding:1px 8px;border-radius:5px;letter-spacing:-.005em;">${total} em rota</span>`
                : `<span style="font-size:11px;color:var(--muted);letter-spacing:-.005em;">caminhão vazio</span>`}
            </div>
            ${fotosHtml}
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
// RENDER GALERIA DE FOTOS
// ═══════════════════════════════════════════════════════════════
function renderPhotos() {
  const el    = $('llm-photos-gallery');
  const cnt   = $('llm-photos-count');
  const card  = $('llm-photos-card');
  if (!el) return;

  // Monta lista: cada foto é um objeto {url, label, driver, ts}
  const fotos = [];
  _events.forEach(ev => {
    const ts = ev.timestamp?.toDate ? ev.timestamp.toDate() : new Date(ev.timestamp || 0);
    const driver = ev.driverName || '?';
    if (ev.fotoUrl)     fotos.push({ url: ev.fotoUrl,     label: 'Retirada CD', driver, ts });
    if (ev.fotoEntrega) fotos.push({ url: ev.fotoEntrega, label: 'Entrega → ' + (ev.clientName || ''), driver, ts });
    if (ev.fotoColeta)  fotos.push({ url: ev.fotoColeta,  label: 'Coleta ← '  + (ev.clientName || ''), driver, ts });
  });

  // Ordenar mais recentes primeiro
  fotos.sort((a, b) => b.ts - a.ts);

  if (cnt) cnt.textContent = fotos.length;
  if (card) card.style.display = fotos.length ? 'block' : 'none';

  if (!fotos.length) {
    el.innerHTML = '<p style="color:rgba(228,240,246,.4);font-size:13px;padding:6px 0;">Nenhuma foto enviada ainda.</p>';
    return;
  }

  el.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:12px;">
      ${fotos.map((f, i) => {
        const hora = f.ts.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        const dia  = f.ts.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
        return `
          <div style="cursor:pointer;border-radius:14px;overflow:hidden;
            border:1.5px solid rgba(255,255,255,.1);background:rgba(255,255,255,.03);
            transition:transform .15s,border-color .15s;"
            onmouseover="this.style.transform='scale(1.03)';this.style.borderColor='rgba(0,212,255,.4)'"
            onmouseout="this.style.transform='';this.style.borderColor='rgba(255,255,255,.1)'"
            onclick="llmVerFoto('${encodeURIComponent(f.url)}','${esc(f.label)}','${esc(f.driver)}')">
            <img src="${f.url}" alt="${esc(f.label)}"
              style="width:100%;aspect-ratio:1/1;object-fit:cover;display:block;"/>
            <div style="padding:8px 10px;">
              <div style="font-size:11px;font-weight:700;color:var(--text);
                white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(f.driver)}</div>
              <div style="font-size:10px;color:rgba(0,212,255,.8);font-weight:600;
                white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px;">${esc(f.label)}</div>
              <div style="font-size:10px;color:rgba(228,240,246,.4);margin-top:2px;">${dia} ${hora}</div>
            </div>
          </div>`;
      }).join('')}
    </div>`;
}

// ═══════════════════════════════════════════════════════════════
// MODAL DE FOTO (visualização em tela cheia)
// ═══════════════════════════════════════════════════════════════
window.llmVerFoto = function(encodedUrl, label, driverName) {
  const url = decodeURIComponent(encodedUrl);
  let modal = document.getElementById('llm-foto-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'llm-foto-modal';
    modal.style.cssText = [
      'display:none;position:fixed;inset:0;z-index:99999',
      'background:rgba(0,0,0,.9);backdrop-filter:blur(10px)',
      'align-items:center;justify-content:center;padding:20px;flex-direction:column;gap:16px'
    ].join(';');
    modal.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;
        width:100%;max-width:600px;margin-bottom:4px;">
        <div id="llm-foto-info" style="font-size:14px;font-weight:700;color:rgba(228,240,246,.8);"></div>
        <button id="llm-foto-close"
          style="width:36px;height:36px;border-radius:10px;font-size:20px;
          background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.15);
          color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;">✕</button>
      </div>
      <img id="llm-foto-img" style="max-width:100%;max-height:80vh;border-radius:16px;
        border:2px solid rgba(0,212,255,.3);display:block;object-fit:contain;"/>
    `;
    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if (e.target === modal) modal.style.display = 'none'; });
    document.getElementById('llm-foto-close').addEventListener('click', () => { modal.style.display = 'none'; });
  }
  document.getElementById('llm-foto-img').src = url;
  document.getElementById('llm-foto-info').textContent = `📷 ${label} — ${driverName}`;
  modal.style.display = 'flex';
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
      renderWeekSummary();
    },
    err => console.error('[LLM-Motoristas] Drivers:', err)
  );

  // Registros do controle_caixas (pra calcular performance semanal)
  _unsubRegistros = onSnapshot(
    collection(db, COL_CAIXAS),
    snap => {
      _registros = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      renderWeekSummary();
    },
    err => console.error('[LLM-Motoristas] Caixas:', err)
  );

  // Bind dos botões de navegação de semana (uma vez só)
  if (!window._llmWeekBound) {
    window._llmWeekBound = true;
    document.addEventListener('click', e => {
      if (e.target.closest('#llm-week-prev')) { _weekOffset--; renderWeekSummary(); }
      else if (e.target.closest('#llm-week-next')) { _weekOffset++; renderWeekSummary(); }
      else if (e.target.closest('#llm-week-today')) { _weekOffset = 0; renderWeekSummary(); }
      else if (e.target.closest('#llm-encerrar-semana')) { window.llmEncerrarSemana(); }
    });

    // Refresh periódico pra atualizar "há X min" das localizações ao vivo
    setInterval(() => {
      const panel = document.getElementById('llm-panel-motoristas');
      if (panel && panel.style.display !== 'none') renderDrivers();
    }, 30000);
  }

  _unsubClients = onSnapshot(
    collection(db, COL_CLIENTS),
    snap => {
      _clients = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      renderClients();
    },
    err => console.error('[LLM-Motoristas] Clients:', err)
  );

  // Eventos recentes com fotos
  _unsubEvents = onSnapshot(
    query(collection(db, COL_EVENTS), orderBy('timestamp', 'desc'), limit(60)),
    snap => {
      _events = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(ev => ev.fotoUrl || ev.fotoEntrega || ev.fotoColeta);
      window._llmEventsList = _events; // expõe para o radar de suspeitas
      renderDrivers();
      renderPhotos();
    },
    err => console.error('[LLM-Motoristas] Events:', err)
  );
}

// ═══════════════════════════════════════════════════════════════
// BOOT
// ═══════════════════════════════════════════════════════════════
window.addEventListener('lumin:admin-ready', () => {
  ensureEditModal();
  startListeners();
});
