/**
 * ═══════════════════════════════════════════════════════════════
 *  LUMIN SaaS — LuminLog Controller v2 (Caixas Hetros)
 *  Arquivo: luminlog-controller.js
 *
 *  Responsabilidades:
 *  • CRUD completo na coleção `controle_caixas` (Firestore)
 *  • Listener em tempo real (onSnapshot)
 *  • Filtros simultâneos: Data, Tipo, Cliente, Cor, Motorista
 *  • Modal de Edição inline com recálculo automático de fórmulas
 *  • Exportação Excel via ExcelJS — espelho exato do Pasta1.xlsx
 *    (fórmulas IF, SUMIF, células mescladas, cores, larguras)
 *  • Ativado pelo evento lumin:admin-ready
 * ═══════════════════════════════════════════════════════════════
 */

import { db } from './firebase-config.js';
import {
  collection, doc, addDoc, updateDoc, deleteDoc, setDoc, getDoc,
  onSnapshot, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

// ─── CONSTANTES ────────────────────────────────────────────────
const COLECAO         = 'controle_caixas';
const COL_FREQUENTES  = 'luminlog_frequentes';   // motoristas e clientes salvos
const PRICE_PRETA  = 20.00;
const PRICE_BRANCA = 28.00;

// ─── ESTADO ────────────────────────────────────────────────────
let _registros      = [];
let _dadosCarregados= false;   // true após primeiro snapshot do Firestore
let _editandoId     = null;
let _unsubscribe    = null;
let _motoristasFreq = [];      // cache de motoristas frequentes (Firestore)
let _clientesFreq   = [];      // cache de clientes frequentes (Firestore)

// Filtros simultâneos
let _filtros = {
  dataInicio: '',
  dataFim:    '',
  tipo:       'all',
  cliente:    '',
  cor:        'all',
  motorista:  ''
};

// ─── UTILITÁRIOS ───────────────────────────────────────────────
const $     = id => document.getElementById(id);
const esc   = s  => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const fmt   = v  => Number(v || 0).toLocaleString('pt-BR', { style:'currency', currency:'BRL' });
const fmtDt = s  => s ? s.split('-').reverse().join('/') : '—';

function toast(msg, isErr = false) {
  const t = $('toast'); if (!t) return;
  t.textContent = msg;
  t.className   = 'show' + (isErr ? ' err' : '');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.className = ''; }, 3200);
}

function setMsg(id, msg, ok = true) {
  const e = $(id); if (!e) return;
  e.style.display    = msg ? 'block' : 'none';
  e.textContent      = msg;
  e.style.background = ok ? 'rgba(0,229,160,.1)'            : 'rgba(255,91,112,.1)';
  e.style.border     = ok ? '1px solid rgba(0,229,160,.25)' : '1px solid rgba(255,91,112,.25)';
  e.style.color      = ok ? 'var(--success)'                : 'var(--alert)';
}

function precoPorCor(cor) {
  if (!cor) return 0;
  const c = cor.toLowerCase();
  if (c.includes('pret'))  return PRICE_PRETA;
  if (c.includes('branc')) return PRICE_BRANCA;
  return 0;
}

// ─── FREQUENTES (motoristas e clientes persistidos) ────────────
/**
 * Carrega a lista de motoristas e clientes frequentes do Firestore.
 * Fica em luminlog_frequentes/index — um único documento simples.
 */
async function carregarFrequentes() {
  try {
    const snap = await getDoc(doc(db, COL_FREQUENTES, 'index'));
    if (snap.exists()) {
      const d = snap.data();
      _motoristasFreq = d.motoristas || [];
      _clientesFreq   = d.clientes   || [];
    }
  } catch(e) { console.warn('[LuminLog] Frequentes não carregados:', e); }
  atualizarAutocompleteLists();
}

/**
 * Salva um nome de motorista ou cliente como frequente.
 * Merge — não apaga os outros.
 */
async function salvarFrequente(tipo, nome) {
  if (!nome) return;
  nome = nome.trim().toUpperCase();
  if (tipo === 'motorista') {
    if (_motoristasFreq.includes(nome)) return; // já existe
    _motoristasFreq = [..._motoristasFreq, nome].sort();
  } else {
    if (_clientesFreq.includes(nome)) return;
    _clientesFreq = [..._clientesFreq, nome].sort();
  }
  try {
    await setDoc(doc(db, COL_FREQUENTES, 'index'), {
      motoristas: _motoristasFreq,
      clientes:   _clientesFreq,
      updatedAt:  serverTimestamp()
    });
    atualizarAutocompleteLists();
  } catch(e) { console.warn('[LuminLog] Erro ao salvar frequente:', e); }
}


function aplicarFiltros() {
  return _registros.filter(r => {
    if (_filtros.dataInicio && r.data && r.data < _filtros.dataInicio) return false;
    if (_filtros.dataFim    && r.data && r.data > _filtros.dataFim)    return false;
    if (_filtros.tipo !== 'all' && r.tipo !== _filtros.tipo)           return false;
    if (_filtros.cliente && !(r.cliente || '').toLowerCase().includes(_filtros.cliente.toLowerCase())) return false;
    if (_filtros.cor !== 'all' && !(r.cor || '').toLowerCase().includes(_filtros.cor.toLowerCase()))   return false;
    if (_filtros.motorista && !(r.motorista || '').toLowerCase().includes(_filtros.motorista.toLowerCase())) return false;
    return true;
  });
}

function temFiltroAtivo() {
  return _filtros.dataInicio || _filtros.dataFim ||
         _filtros.tipo !== 'all' || _filtros.cliente ||
         _filtros.cor !== 'all' || _filtros.motorista;
}

function atualizarBadgeFiltros() {
  const badge = $('ll-filter-badge');
  const btnReset = $('ll-filter-reset');
  const ativo = temFiltroAtivo();
  if (badge) {
    const count = [
      _filtros.dataInicio || _filtros.dataFim ? 1 : 0,
      _filtros.tipo !== 'all' ? 1 : 0,
      _filtros.cliente ? 1 : 0,
      _filtros.cor !== 'all' ? 1 : 0,
      _filtros.motorista ? 1 : 0
    ].reduce((a,b) => a+b, 0);
    badge.textContent = count;
    badge.style.display = count > 0 ? 'inline-flex' : 'none';
  }
  if (btnReset) btnReset.style.display = ativo ? 'flex' : 'none';
}

function resetarFiltros() {
  _filtros = { dataInicio:'', dataFim:'', tipo:'all', cliente:'', cor:'all', motorista:'' };

  const set = (id, val) => { const e = $(id); if (e) e.value = val; };
  set('ll-f-data-ini', '');
  set('ll-f-data-fim', '');
  set('ll-f-cliente',  '');
  set('ll-f-motorista','');

  // Reset selects
  const selTipo = $('ll-f-tipo');
  const selCor  = $('ll-f-cor');
  if (selTipo) selTipo.value = 'all';
  if (selCor)  selCor.value  = 'all';

  // Reset botões de tipo rápido
  document.querySelectorAll('.ll-filter-btn').forEach(b => {
    const isAll = b.dataset.llFilter === 'all';
    b.classList.toggle('active', isAll);
    b.style.borderColor = isAll ? 'var(--accent)' : 'var(--border)';
    b.style.background  = isAll ? 'rgba(0,212,255,.12)' : 'transparent';
    b.style.color       = isAll ? 'var(--accent)' : 'var(--muted)';
  });

  atualizarBadgeFiltros();
  atualizarAutocompleteLists();
  renderTabela();
}

// ─── AUTOCOMPLETE LISTS ────────────────────────────────────────
function atualizarAutocompleteLists() {
  // Mescla frequentes salvos + extraídos dos registros existentes
  const clientesHist  = _registros.map(r => r.cliente).filter(Boolean);
  const motoristasHist= _registros.map(r => r.motorista).filter(Boolean);

  const clientes  = [...new Set([..._clientesFreq, ...clientesHist])].sort();
  const motoristas= [...new Set([..._motoristasFreq, ...motoristasHist])].sort();

  const dlC = $('ll-clientes-list');
  const dlM = $('ll-motoristas-list');
  const dlCa= $('ll-add-clientes-list');
  const dlMa= $('ll-add-motoristas-list');
  const dlCe= $('ll-edit-clientes-list');
  const dlMe= $('ll-edit-motoristas-list');

  const optsC = clientes.map(c => `<option value="${esc(c)}">`).join('');
  const optsM = motoristas.map(m => `<option value="${esc(m)}">`).join('');

  [dlC, dlCa, dlCe].forEach(dl => { if (dl) dl.innerHTML = optsC; });
  [dlM, dlMa, dlMe].forEach(dl => { if (dl) dl.innerHTML = optsM; });
}

// ─── CAIXAS NO CAMINHÃO POR MOTORISTA ─────────────────────────
// Calcula quantas caixas cada motorista ainda tem no caminhão:
// ENTRADA carregou, SAÍDA entregou. Saldo = entradas - saídas.
function calcCaixasNoCaminhao() {
  const saldo = {}; // motorista → { total, porCliente: { cliente → cx } }
  _registros.forEach(r => {
    if (!r.motorista) return;
    const mot = r.motorista.trim().toUpperCase();
    const cli = (r.cliente || '—').trim().toUpperCase();
    const cx  = r.quantidadeCx || 0;
    if (!saldo[mot]) saldo[mot] = { total: 0, porCliente: {} };
    if (!saldo[mot].porCliente[cli]) saldo[mot].porCliente[cli] = 0;
    if (r.tipo === 'ENTRADA') {
      saldo[mot].total += cx;
      saldo[mot].porCliente[cli] += cx;
    } else {
      saldo[mot].total -= cx;
      saldo[mot].porCliente[cli] -= cx;
    }
  });
  return saldo;
}

// ─── RENDER KPIs TOPO ─────────────────────────────────────────
function renderKpis() {
  const totEntrada = _registros.filter(r => r.tipo === 'ENTRADA').reduce((a, r) => a + (r.quantidadeCx || 0), 0);
  const totSaida   = _registros.filter(r => r.tipo === 'SAÍDA').reduce((a, r)   => a + (r.quantidadeCx || 0), 0);
  const totValor   = _registros.reduce((a, r) => a + (r.valorTotal || 0), 0);
  const totCount   = _registros.length;

  const el_ent = $('ll-total-entrada'); if (el_ent) el_ent.textContent = `${totEntrada} cx`;
  const el_sai = $('ll-total-saida');   if (el_sai) el_sai.textContent = `${totSaida} cx`;
  const el_val = $('ll-total-valor');   if (el_val) el_val.textContent = fmt(totValor);
  const el_cnt = $('ll-total-count');   if (el_cnt) el_cnt.textContent = totCount;

  // ── Painel: caixas no caminhão por motorista ───────────────────
  const saldoMot = calcCaixasNoCaminhao();
  const motPanel  = $('ll-motoristas-panel');
  if (motPanel) {
    const motoristas = Object.entries(saldoMot).filter(([, v]) => v.total > 0);
    if (!motoristas.length) {
      motPanel.innerHTML = `<div style="color:var(--muted);font-size:13px;padding:12px 0;">Nenhuma caixa em trânsito no momento.</div>`;
    } else {
      motPanel.innerHTML = motoristas.map(([mot, v]) => {
        const clientesComSaldo = Object.entries(v.porCliente)
          .filter(([, cx]) => cx > 0)
          .sort((a, b) => b[1] - a[1]);
        const clientesHtml = clientesComSaldo.map(([cli, cx]) =>
          `<div style="display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.04);font-size:13px;">
            <span style="color:var(--muted);">${esc(cli)}</span>
            <span style="font-family:'DM Mono',monospace;font-weight:700;color:var(--text);">${cx} cx</span>
          </div>`
        ).join('');
        return `
          <div style="background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:16px 20px;min-width:220px;flex:1;">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
              <div style="font-size:14px;font-weight:800;">🚚 ${esc(mot)}</div>
              <div style="font-family:'DM Mono',monospace;font-size:20px;font-weight:900;color:var(--warning);">${v.total} <span style="font-size:12px;font-weight:600;color:var(--muted);">cx</span></div>
            </div>
            ${clientesHtml || '<div style="font-size:12px;color:var(--muted);">Sem clientes pendentes</div>'}
          </div>`;
      }).join('');
    }
  }
}

// ─── RENDER CARDS ──────────────────────────────────────────────
function renderTabela() {
  const tbody = $('ll-tbody'); if (!tbody) return;
  const dados = aplicarFiltros();

  // KPIs sempre no topo
  renderKpis();

  // ── Totalizadores filtrados ────────────────────────────────────
  const filtEntrada = dados.filter(r => r.tipo === 'ENTRADA').reduce((a, r) => a + (r.quantidadeCx || 0), 0);
  const filtSaida   = dados.filter(r => r.tipo === 'SAÍDA').reduce((a, r)   => a + (r.quantidadeCx || 0), 0);
  const filtValor   = dados.reduce((a, r) => a + (r.valorTotal || 0), 0);
  const el_fe = $('ll-filt-entrada'); if (el_fe) el_fe.textContent = `${filtEntrada} cx`;
  const el_fs = $('ll-filt-saida');   if (el_fs) el_fs.textContent = `${filtSaida} cx`;
  const el_fv = $('ll-filt-valor');   if (el_fv) el_fv.textContent = fmt(filtValor);
  const el_fc = $('ll-filt-count');   if (el_fc) el_fc.textContent = `${dados.length} reg.`;

  const filtrosAtivos = $('ll-filt-row');
  if (filtrosAtivos) filtrosAtivos.style.display = temFiltroAtivo() ? 'grid' : 'none';

  // ── Badge nos filtros colapsáveis ──────────────────────────────
  atualizarBadgeFiltros();

  // ── Banner REVISAR ─────────────────────────────────────────────
  const pendentes = _registros.filter(r => r.status === 'REVISAR').length;
  const banner    = $('ll-revisar-banner');
  const bannerCnt = $('ll-revisar-count');
  if (banner)    banner.style.display  = pendentes ? 'block' : 'none';
  if (bannerCnt) bannerCnt.textContent = pendentes;

  // ── Estado vazio ───────────────────────────────────────────────
  if (!dados.length) {
    tbody.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:60px 20px;gap:12px;color:var(--muted);">
        <div style="font-size:40px;opacity:.35;">${temFiltroAtivo() ? '🔍' : '📦'}</div>
        <div style="font-size:15px;font-weight:600;">${temFiltroAtivo() ? 'Nenhum registro com esses filtros.' : 'Nenhum registro ainda.'}</div>
        ${temFiltroAtivo() ? `<div style="font-size:13px;opacity:.6;">Tente ajustar ou limpar os filtros.</div>` : ''}
      </div>`;
    return;
  }

  // ── Injetar estilos de card uma única vez ──────────────────────
  if (!document.getElementById('ll-card-styles')) {
    const style = document.createElement('style');
    style.id = 'll-card-styles';
    style.textContent = `
      .ll-card {
        background: rgba(255,255,255,.04);
        border: 1px solid rgba(255,255,255,.08);
        border-radius: 16px;
        padding: 16px 18px;
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 10px 16px;
        transition: border-color .2s, transform .15s;
        position: relative;
        overflow: hidden;
      }
      .ll-card:hover { border-color: rgba(255,255,255,.16); transform: translateY(-1px); }
      .ll-card.is-revisar { border-color: rgba(255,179,71,.25); background: rgba(255,179,71,.04); }
      .ll-card::before {
        content: ''; position: absolute; left: 0; top: 0; bottom: 0;
        width: 3px; border-radius: 16px 0 0 16px;
      }
      .ll-card.is-entrada::before { background: var(--success); }
      .ll-card.is-saida::before   { background: var(--alert); }
      .ll-card.is-revisar::before { background: var(--warning); }
      .ll-card-body   { display:flex; flex-direction:column; gap:8px; min-width:0; }
      .ll-card-top    { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
      .ll-card-nome   {
        font-size:15px; font-weight:800; letter-spacing:.1px;
        white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:260px;
      }
      .ll-card-badge  {
        font-size:10px; font-weight:800; padding:3px 9px;
        border-radius:20px; text-transform:uppercase; letter-spacing:.5px;
        white-space:nowrap; flex-shrink:0;
      }
      .ll-card-meta   {
        display:flex; gap:14px; flex-wrap:wrap; align-items:center; font-size:12px; color:var(--muted);
      }
      .ll-card-meta-item { display:flex; align-items:center; gap:4px; }
      .ll-card-meta-label{ font-size:10px; text-transform:uppercase; letter-spacing:.4px; opacity:.55; }
      .ll-card-meta-val  { font-weight:600; color:var(--text); }
      .ll-card-cx-badge  {
        display:inline-flex; align-items:center; gap:5px;
        font-family:'DM Mono',monospace; font-size:13px; font-weight:800;
        padding:4px 12px; border-radius:20px; white-space:nowrap;
      }
      .ll-card-valor  { font-family:'DM Mono',monospace; font-size:20px; font-weight:800; letter-spacing:-.5px; }
      .ll-card-actions{ display:flex; gap:6px; }
      .ll-card-actions button {
        padding:6px 14px; border-radius:9px; font-size:12px; font-weight:700;
        cursor:pointer; transition:.15s; border-width:1px; border-style:solid; white-space:nowrap;
      }
      .ll-card-actions button:hover { opacity:.8; transform:scale(.97); }
      .ll-card-pill {
        display:inline-flex; align-items:center; gap:5px;
        font-size:11px; font-weight:700; padding:3px 9px; border-radius:20px; white-space:nowrap;
      }
      /* Painel de caixas no caminhão */
      #ll-motoristas-panel { display:flex; gap:10px; flex-wrap:wrap; }
      /* Filtros colapsáveis */
      #ll-filtros-body { overflow:hidden; transition: max-height .3s ease, opacity .3s ease; }
      #ll-filtros-body.collapsed { max-height:0!important; opacity:0; pointer-events:none; }
      #ll-filtros-body.expanded  { opacity:1; }
      #ll-tbody { display:flex; flex-direction:column; gap:8px; padding:4px 0; }
    `;
    document.head.appendChild(style);
  }

  // ── Renderiza cada registro como card ─────────────────────────
  // Para ENTRADA: mostra fornecedor (de onde veio) + motorista
  // Para SAÍDA: mostra CLIENTE (para quem foi entregue) + caixas ainda
  //             com esse motorista no caminhão
  const saldoMot = calcCaixasNoCaminhao();

  tbody.innerHTML = dados.map(r => {
    const isEntrada  = r.tipo === 'ENTRADA';
    const isRevisar  = r.status === 'REVISAR';
    const tipoColor  = isEntrada ? 'var(--success)' : 'var(--alert)';
    const tipoBg     = isEntrada ? 'rgba(0,229,160,.12)' : 'rgba(255,91,112,.12)';
    const tipoBorder = isEntrada ? 'rgba(0,229,160,.3)'  : 'rgba(255,91,112,.3)';
    const tipoIcon   = isEntrada ? '▲' : '▼';

    const corIcon = (r.cor||'').toLowerCase().includes('pret') ? '⬛'
                  : (r.cor||'').toLowerCase().includes('branc') ? '⬜' : '🔲';

    const statusBadge = isRevisar
      ? `<span class="ll-card-pill" style="background:rgba(255,179,71,.15);border:1px solid rgba(255,179,71,.3);color:var(--warning);">⚠ REVISAR</span>`
      : `<span class="ll-card-pill" style="background:rgba(0,229,160,.1);border:1px solid rgba(0,229,160,.2);color:var(--success);">✓ OK</span>`;

    // Para SAÍDA: exibe cliente em destaque + caixas ainda com esse motorista
    let extraInfoHtml = '';
    if (!isEntrada && r.motorista) {
      const mot = r.motorista.trim().toUpperCase();
      const saldo = saldoMot[mot];
      const cxRestantes = saldo ? Math.max(0, saldo.total) : 0;
      if (cxRestantes > 0) {
        extraInfoHtml = `
          <div class="ll-card-meta-item" style="margin-top:2px;">
            <span class="ll-card-cx-badge" style="background:rgba(255,179,71,.12);border:1px solid rgba(255,179,71,.25);color:var(--warning);">
              🚚 ${cxRestantes} cx ainda no caminhão
            </span>
          </div>`;
      } else {
        extraInfoHtml = `
          <div class="ll-card-meta-item" style="margin-top:2px;">
            <span class="ll-card-cx-badge" style="background:rgba(0,229,160,.08);border:1px solid rgba(0,229,160,.2);color:var(--success);">
              ✓ Caminhão zerado
            </span>
          </div>`;
      }
    }

    // Para ENTRADA: mostra fornecedor se existir
    const fornecedorHtml = (isEntrada && r.fornecedor)
      ? `<div class="ll-card-meta-item">
           <span class="ll-card-meta-label">Fornec.</span>
           <span class="ll-card-meta-val">${esc(r.fornecedor)}</span>
         </div>`
      : '';

    const motoristaHtml = r.motorista
      ? `<div class="ll-card-meta-item">
           <span class="ll-card-meta-label">Motorista</span>
           <span class="ll-card-meta-val">${esc(r.motorista)}</span>
         </div>`
      : '';

    // Nome principal: para SAÍDA mostra CLIENTE, para ENTRADA mostra CLIENTE também
    // (o cliente é sempre quem recebeu/pediu — igual ao comportamento atual)
    const nomePrincipal = r.cliente || '—';

    return `
      <div class="ll-card ${isEntrada ? 'is-entrada' : 'is-saida'} ${isRevisar ? 'is-revisar' : ''}" data-ll-id="${r.id}">
        <div class="ll-card-body">
          <div class="ll-card-top">
            <span class="ll-card-badge" style="background:${tipoBg};border:1px solid ${tipoBorder};color:${tipoColor};">
              ${tipoIcon} ${esc(r.tipo)}
            </span>
            <span class="ll-card-nome" title="${esc(nomePrincipal)}">${esc(nomePrincipal)}</span>
            ${statusBadge}
          </div>
          <div class="ll-card-meta">
            <div class="ll-card-meta-item">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" opacity=".5"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
              <span style="font-family:'DM Mono',monospace;font-weight:600;color:var(--text);font-size:12px;">${fmtDt(r.data)}</span>
            </div>
            <div class="ll-card-meta-item">
              <span class="ll-card-meta-label">Qtd</span>
              <span style="font-family:'DM Mono',monospace;font-size:14px;font-weight:800;color:var(--text);">${r.quantidadeCx ?? '—'} cx</span>
            </div>
            <div class="ll-card-meta-item">
              ${corIcon}
              <span class="ll-card-meta-val">${esc(r.cor||'—')}</span>
            </div>
            <div class="ll-card-meta-item">
              <span class="ll-card-meta-label">Unit.</span>
              <span style="font-family:'DM Mono',monospace;font-weight:600;color:var(--text);font-size:12px;">${fmt(r.valorUnitario)}</span>
            </div>
            ${fornecedorHtml}
            ${motoristaHtml}
          </div>
          ${extraInfoHtml}
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;justify-content:space-between;gap:8px;flex-shrink:0;">
          <div class="ll-card-valor" style="color:${tipoColor};">${fmt(r.valorTotal)}</div>
          <div class="ll-card-actions">
            <button data-ll-action="edit" data-ll-id="${r.id}"
              style="background:rgba(0,212,255,.1);border-color:rgba(0,212,255,.25);color:var(--accent);">
              ✎ Editar
            </button>
            <button data-ll-action="del" data-ll-id="${r.id}"
              style="background:rgba(255,91,112,.08);border-color:rgba(255,91,112,.2);color:var(--alert);padding:6px 10px;">
              ✕
            </button>
          </div>
        </div>
      </div>`;
  }).join('');
}

// ─── TOGGLE FILTROS COLAPSÁVEL ─────────────────────────────────
function initFiltrosColapsaveis() {
  const btn  = $('ll-filtros-toggle');
  const body = $('ll-filtros-body');
  if (!btn || !body) return;

  // Começa recolhido
  body.classList.add('collapsed');
  body.style.maxHeight = '0';
  let aberto = false;

  btn.addEventListener('click', () => {
    aberto = !aberto;
    if (aberto) {
      body.classList.remove('collapsed');
      body.classList.add('expanded');
      body.style.maxHeight = body.scrollHeight + 'px';
      btn.querySelector('.ll-filtros-arrow').style.transform = 'rotate(180deg)';
    } else {
      body.classList.remove('expanded');
      body.classList.add('collapsed');
      body.style.maxHeight = '0';
      btn.querySelector('.ll-filtros-arrow').style.transform = 'rotate(0deg)';
    }
  });
}

// ─── LISTENER FIRESTORE ────────────────────────────────────────
function startListener() {
  if (_unsubscribe) { _unsubscribe(); _unsubscribe = null; }

  // ⚠ FIX SINCRONIZAÇÃO: Não usamos apenas orderBy('createdAt') porque registros
  // vindos do bot (Admin SDK) podem ter serverTimestamp() = null durante a latência
  // de escrita (pending writes). Isso faz o Firestore colocá-los em posição errada
  // no snapshot ordenado, gerando "dados fantasmas" ou registros fora de ordem.
  //
  // Solução: buscar sem orderBy do lado do servidor e ordenar em memória,
  // usando `data` (campo string YYYY-MM-DD) como critério primário e
  // `createdAt` como desempate (com fallback para Date.now() em caso de null).
  _unsubscribe = onSnapshot(
    collection(db, COLECAO),
    snap => {
      const agora = Date.now();
      _registros = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) => {
          // Critério 1: data do registro (string YYYY-MM-DD) — descendente
          const dA = a.data || '0000-00-00';
          const dB = b.data || '0000-00-00';
          if (dB !== dA) return dB.localeCompare(dA);
          // Critério 2: createdAt — null/pending tratado como "agora"
          const tA = a.createdAt?.toMillis?.() ?? agora;
          const tB = b.createdAt?.toMillis?.() ?? agora;
          return tB - tA;
        });
      _dadosCarregados = true;
      atualizarAutocompleteLists();
      renderTabela();
    },
    err => console.error('[LuminLog] Firestore error:', err)
  );
}

// ─── MODAIS ADICIONAR ──────────────────────────────────────────
function openAddModal() {
  const modal = $('ll-modal-add'); if (!modal) return;
  modal.classList.add('active');
  const dataEl = $('ll-add-data');
  if (dataEl && !dataEl.value) dataEl.value = new Date().toISOString().split('T')[0];
  $('ll-add-cor')?.dispatchEvent(new Event('change'));
  setTimeout(() => $('ll-add-cliente')?.focus(), 280);
}

function closeAddModal() {
  const modal = $('ll-modal-add'); if (modal) modal.classList.remove('active');
  setMsg('ll-add-msg', '');
  ['ll-add-tipo','ll-add-data','ll-add-cliente','ll-add-fornecedor',
   'll-add-quantidade','ll-add-cor','ll-add-vl-unit','ll-add-vl-total',
   'll-add-conferente'].forEach(id => {
    const e = $(id); if (!e) return;
    if (e.tagName === 'SELECT') e.selectedIndex = 0; else e.value = '';
  });
}

async function saveNewRecord() {
  const tipo        = $('ll-add-tipo')?.value          || 'ENTRADA';
  const data        = $('ll-add-data')?.value           || '';
  const cliente     = ($('ll-add-cliente')?.value       || '').trim().toUpperCase();
  const fornecedor  = ($('ll-add-fornecedor')?.value    || '').trim().toUpperCase();
  const quantidadeCx= parseInt($('ll-add-quantidade')?.value || 0, 10);
  const cor         = ($('ll-add-cor')?.value           || '');
  const motorista   = ($('ll-add-conferente')?.value    || '').trim().toUpperCase();

  let valorUnitario = parseFloat($('ll-add-vl-unit')?.value || 0);
  let valorTotal    = parseFloat($('ll-add-vl-total')?.value || 0);

  if (!data)              { setMsg('ll-add-msg','Informe a data.',false); return; }
  if (!cliente)           { setMsg('ll-add-msg','Informe o cliente.',false); return; }
  if (!quantidadeCx||quantidadeCx<=0) { setMsg('ll-add-msg','Informe a quantidade.',false); return; }

  // Fórmula espelhada: IF(cor=PRETA,20,IF(cor=BRANCA,28,0))
  if (!valorUnitario) valorUnitario = precoPorCor(cor);
  if (valorUnitario > 0) valorTotal = valorUnitario * quantidadeCx;

  const btn = $('ll-btn-save-add'); if (btn) btn.disabled = true;
  try {
    await addDoc(collection(db, COLECAO), {
      tipo, data, cliente, fornecedor, quantidadeCx, cor,
      valorUnitario, valorTotal, motorista,
      status: 'OK', origem: 'manual', createdAt: serverTimestamp()
    });
    // Salva motorista e cliente como frequentes para autocomplete futuro
    if (motorista) salvarFrequente('motorista', motorista);
    if (cliente)   salvarFrequente('cliente', cliente);
    toast('✓ Registro salvo!');
    closeAddModal();
  } catch(err) {
    console.error('[LuminLog] Erro ao salvar:', err);
    setMsg('ll-add-msg','Erro ao salvar registro.',false);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ─── MODAL EDITAR ──────────────────────────────────────────────
function openEditModal(id) {
  const reg = _registros.find(r => r.id === id);
  if (!reg) { toast('Registro não encontrado.',true); return; }
  _editandoId = id;

  // Popula campos de texto/número
  const set = (elId, val) => { const e = $(elId); if (e) e.value = val ?? ''; };
  set('ll-edit-data',       reg.data          || '');
  set('ll-edit-cliente',    reg.cliente       || '');
  set('ll-edit-fornecedor', reg.fornecedor    || '');
  set('ll-edit-quantidade', reg.quantidadeCx  ?? '');
  set('ll-edit-vl-unit',    reg.valorUnitario ?? '');
  set('ll-edit-vl-total',   reg.valorTotal    ?? '');
  set('ll-edit-motorista',  reg.motorista     || '');

  // Popula selects com fallback case-insensitive para o campo Cor
  const setSelect = (elId, val) => {
    const e = $(elId); if (!e) return;
    e.value = val ?? '';
    // Se não encontrou exato, tenta match case-insensitive
    if (e.value !== String(val ?? '')) {
      const opt = [...e.options].find(o =>
        o.value.toLowerCase() === String(val ?? '').toLowerCase()
      );
      if (opt) opt.selected = true;
    }
  };
  setSelect('ll-edit-tipo',   reg.tipo   || 'ENTRADA');
  setSelect('ll-edit-cor',    reg.cor    || '');
  setSelect('ll-edit-status', reg.status || 'OK');

  setMsg('ll-edit-msg','');

  const modal = $('ll-modal-edit');
  if (modal) {
    modal.classList.add('active');
  }
  setTimeout(() => $('ll-edit-cliente')?.focus(), 200);
}

function closeEditModal() {
  const modal = $('ll-modal-edit'); if (modal) modal.classList.remove('active');
  _editandoId = null;
}

async function saveEdit() {
  if (!_editandoId) return;
  const tipo        = $('ll-edit-tipo')?.value          || 'ENTRADA';
  const data        = $('ll-edit-data')?.value           || '';
  const cliente     = ($('ll-edit-cliente')?.value       || '').trim().toUpperCase();
  const fornecedor  = ($('ll-edit-fornecedor')?.value    || '').trim().toUpperCase();
  const quantidadeCx= parseInt($('ll-edit-quantidade')?.value || 0, 10);
  const corRaw      = ($('ll-edit-cor')?.value           || '');
  // Normaliza para Title Case para manter compatibilidade com o select
  const cor         = corRaw ? corRaw.charAt(0).toUpperCase() + corRaw.slice(1).toLowerCase() : '';
  const motorista   = ($('ll-edit-motorista')?.value     || '').trim().toUpperCase();
  const status      = $('ll-edit-status')?.value         || 'OK';

  let valorUnitario = parseFloat($('ll-edit-vl-unit')?.value || 0);
  let valorTotal    = parseFloat($('ll-edit-vl-total')?.value || 0);

  if (!data)    { setMsg('ll-edit-msg','Informe a data.',false); return; }
  if (!cliente) { setMsg('ll-edit-msg','Informe o cliente.',false); return; }

  // Recalcula automaticamente (mesma lógica da fórmula IF do Excel)
  if (!valorUnitario) valorUnitario = precoPorCor(cor);
  if (valorUnitario > 0 && quantidadeCx > 0) valorTotal = valorUnitario * quantidadeCx;

  const btn = $('ll-btn-save-edit'); if (btn) btn.disabled = true;
  try {
    await updateDoc(doc(db, COLECAO, _editandoId), {
      tipo, data, cliente, fornecedor, quantidadeCx, cor,
      valorUnitario, valorTotal, motorista, status,
      updatedAt: serverTimestamp()
    });
    // Persiste motorista e cliente como frequentes
    if (motorista) salvarFrequente('motorista', motorista);
    if (cliente)   salvarFrequente('cliente', cliente);
    toast('✓ Registro atualizado!');
    closeEditModal();
  } catch(err) {
    console.error('[LuminLog] Erro ao editar:', err);
    setMsg('ll-edit-msg','Erro ao atualizar.',false);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ─── EXCLUIR ───────────────────────────────────────────────────
async function deleteRecord(id) {
  const reg = _registros.find(r => r.id === id); if (!reg) return;
  if (!confirm(`Excluir registro de "${reg.cliente||'desconhecido'}" em ${fmtDt(reg.data)}?`)) return;
  try {
    await deleteDoc(doc(db, COLECAO, id));
    toast('Registro excluído.');
  } catch(err) {
    toast('Erro ao excluir.',true);
  }
}

// ─── EXPORTAR EXCEL — ESPELHO EXATO DO Pasta1.xlsx ─────────────
async function exportarExcel() {
  // 1. Verifica ExcelJS
  if (typeof ExcelJS === 'undefined') {
    toast('⏳ Carregando biblioteca Excel...', true);
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js';
      s.onload  = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    }).catch(() => { toast('❌ Falha ao carregar ExcelJS. Verifique sua conexão.', true); return; });
    // Tenta de novo depois de carregar
    if (typeof ExcelJS === 'undefined') return;
  }

  // 2. Se dados ainda não chegaram do Firestore, aguarda até 5s
  if (!_dadosCarregados) {
    toast('⏳ Aguardando dados do servidor...', true);
    let tentativas = 0;
    await new Promise(resolve => {
      const check = setInterval(() => {
        tentativas++;
        if (_dadosCarregados || tentativas >= 50) { clearInterval(check); resolve(); }
      }, 100);
    });
  }

  // 3. Seleciona dados: todos ou filtrados
  // ⚠ FIX EXPORTAÇÃO: Usamos _registros diretamente (já normalizado em memória
  // pelo startListener). Registros do bot têm os mesmos campos que os manuais,
  // então não há distinção — ambos entram na exportação.
  const dados = temFiltroAtivo() ? aplicarFiltros() : [..._registros];
  if (!dados.length) {
    toast(`⚠ Nenhum dado encontrado (${_registros.length} registros no total, filtro ativo: ${temFiltroAtivo()}).`, true);
    return;
  }

  const wb = new ExcelJS.Workbook();
  wb.creator  = 'Lumin SaaS';
  wb.created  = new Date();
  const ws = wb.addWorksheet('Planilha1');

  // ── LARGURAS DE COLUNA (espelho do Pasta1.xlsx) ──────────────
  ws.columns = [
    { key:'A', width:30.0  },   // Data
    { key:'B', width:10.57 },   // Tipo
    { key:'C', width:27.29 },   // Cliente
    { key:'D', width:16.57 },   // Quantidade CX
    { key:'E', width:8.14  },   // Cor
    { key:'F', width:15.29 },   // Valor Unitário
    { key:'G', width:12.57 },   // Valor Total
    { key:'H', width:19.29 },   // Motorista
    { key:'I', width:11.0  },
    { key:'J', width:8.0   },
    { key:'K', width:8.0   },
    { key:'L', width:8.0   },
    { key:'M', width:23.86 },
    { key:'N', width:8.0   },
    { key:'O', width:8.0   },
    { key:'P', width:8.0   },
    { key:'Q', width:8.0   },
    { key:'R', width:19.29 },
  ];

  // ── FORMATO MOEDA R$ (espelho do Pasta1.xlsx) ────────────────
  const fmtBRL = '_-"R$" * #,##0.00_-;\\-"R$" * #,##0.00_-;_-"R$" * "-"??_-;_-@_-';
  const fmtDate= 'dd/mm/yyyy';

  // Estilos reutilizáveis
  const boldHeader = { bold: true, size: 11, name: 'Calibri' };
  const centrado   = { horizontal: 'center', vertical: 'middle' };
  const vermelho   = 'C00000';   // dark red das células SAÍDA

  // ── LINHA 1: CABEÇALHO ───────────────────────────────────────
  const row1 = ws.getRow(1);
  row1.height = 30;

  const headers = [
    ['A1','CONTROLE DE CAIXA HETROS'],
    ['B1','Tipo'],
    ['C1','Cliente'],
    ['D1','Quantidade CX'],
    ['E1','Cor'],
    ['F1','Valor Unitário'],
    ['G1','Valor Total'],
    ['H1','Motorista'],
  ];

  headers.forEach(([addr, val]) => {
    const c = ws.getCell(addr);
    c.value = val;
    c.font  = boldHeader;
    c.alignment = { vertical:'middle' };
    c.border = _thinBorder();
  });

  // I1:R3 mesclado — "UNIDADES DE CADA" (fonte 36, centralizado)
  ws.mergeCells('I1:R3');
  const cUnid = ws.getCell('I1');
  cUnid.value     = 'UNIDADES DE CADA';
  cUnid.font      = { size:36, name:'Calibri', bold:false };
  cUnid.alignment = centrado;
  cUnid.border    = _thinBorder();

  // ── LINHAS DE DADOS ──────────────────────────────────────────
  const dataRows = [];
  dados.forEach((r, idx) => {
    const rowNum = idx + 2;   // dados começam na linha 2
    const rExcel = ws.getRow(rowNum);
    rExcel.height = 18;
    dataRows.push(rowNum);

    // ⚠ FIX CAMPOS BOT: registros do WhatsApp podem ter campos com nomes
    // ligeiramente diferentes ou valores null/undefined. Normalizamos aqui
    // para que tanto registros manuais quanto do bot exportem corretamente.
    const cliente   = r.cliente   || r.remetente || 'Não identificado';
    const motorista = r.motorista || r.conferente || '';
    const cor       = r.cor       || '';
    const origem    = r.origem    || 'manual'; // usado como info auxiliar no status

    // A — Data (formato dd/mm/yyyy)
    const cellA = ws.getCell(`A${rowNum}`);
    if (r.data) {
      const [y,m,d] = r.data.split('-').map(Number);
      cellA.value          = new Date(y, m-1, d);
      cellA.numFmt         = fmtDate;
    }
    cellA.border = _thinBorder();

    // B — Tipo
    const cellB = ws.getCell(`B${rowNum}`);
    cellB.value  = r.tipo || 'ENTRADA';
    cellB.border = _thinBorder();

    // C — Cliente (normalizado)
    const cellC = ws.getCell(`C${rowNum}`);
    cellC.value  = cliente;
    cellC.border = _thinBorder();

    // D — Quantidade CX
    const cellD = ws.getCell(`D${rowNum}`);
    cellD.value     = r.quantidadeCx || 0;
    cellD.alignment = { horizontal:'center', vertical:'middle' };
    cellD.border    = _thinBorder();

    // E — Cor (uppercase para fórmula IF do Excel funcionar)
    const cellE = ws.getCell(`E${rowNum}`);
    cellE.value  = cor.toUpperCase();
    cellE.border = _thinBorder();

    // F — Valor Unitário (fórmula IF idêntica ao Pasta1.xlsx)
    const cellF = ws.getCell(`F${rowNum}`);
    cellF.value  = { formula: `IF(E${rowNum}="PRETA", 20, IF(E${rowNum}="BRANCA", 28, 0))` };
    cellF.numFmt = fmtBRL;
    cellF.border = _thinBorder();

    // G — Valor Total (fórmula F*D idêntica ao Pasta1.xlsx)
    const cellG = ws.getCell(`G${rowNum}`);
    cellG.value  = { formula: `F${rowNum}*D${rowNum}` };
    cellG.numFmt = fmtBRL;
    cellG.border = _thinBorder();

    // H — Motorista (normalizado)
    const cellH = ws.getCell(`H${rowNum}`);
    cellH.value  = motorista;
    cellH.border = _thinBorder();

    // ── COLORAÇÃO CONDICIONAL DAS LINHAS (espelho do Pasta1.xlsx) ──
    // • ENTRADA  → azul claro (BDD7EE — theme:6 do Excel)
    // • SAÍDA sem motorista OU sem cliente → vermelho escuro (C00000)
    // • SAÍDA normal → sem fill (branco)
    const isEntrada = (r.tipo || '').toUpperCase().includes('ENTRADA');
    const isSaida   = !isEntrada;
    const faltaMotorista = !motorista || !motorista.trim();
    const faltaCliente   = !cliente || cliente === 'Não identificado' || cliente === 'NÃO IDENTIFICADO';

    let fillColor = null;
    if (isEntrada) {
      fillColor = 'FFBDD7EE';  // azul claro — todas as ENTRADAs
    } else if (isSaida && (faltaMotorista || faltaCliente)) {
      fillColor = 'FFC00000';  // vermelho — SAÍDA incompleta (sem motorista ou cliente)
    }
    // SAÍDA normal + completa: sem fill (branco padrão)

    if (fillColor) {
      const fillStyle = { type: 'pattern', pattern: 'solid', fgColor: { argb: fillColor } };
      ['A','B','C','D','E','F','G','H'].forEach(col => {
        ws.getCell(`${col}${rowNum}`).fill = fillStyle;
      });
    }
  });

  // ── PAINEL "UNIDADES DE CADA" (mesclados + SUMIF) ────────────
  // Posição base do painel — logo após os dados (ou mínimo linha 4)
  const painelBase = Math.max(dataRows.length > 0 ? dataRows[dataRows.length-1] + 2 : 4, 4);

  // Bloco SAÍDA — I mesclado vermelho
  const r_saidaVal  = painelBase;
  const r_saidaLbl  = painelBase + 3;
  const r_saidaMon  = painelBase + 5;

  // Merge e estilo: SAÍDA QTD (vermelho)
  ws.mergeCells(`I${r_saidaVal}:M${r_saidaVal+2}`);
  const cSaidaQtd = ws.getCell(`I${r_saidaVal}`);
  cSaidaQtd.value     = { formula: '-SUMIF(B:B, "*SAÍDA*", D:D)' };
  cSaidaQtd.font      = { size:48, name:'Calibri', color:{ argb:'FFFFFFFF' } };
  cSaidaQtd.alignment = centrado;
  cSaidaQtd.fill      = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFC00000' } };

  // Merge: ENTRADA QTD (sem fill)
  ws.mergeCells(`N${r_saidaVal}:R${r_saidaVal+2}`);
  const cEntQtd = ws.getCell(`N${r_saidaVal}`);
  cEntQtd.value     = { formula: 'SUMIF(B:B, "*ENTRADA*", D:D)' };
  cEntQtd.font      = { size:48, name:'Calibri' };
  cEntQtd.alignment = centrado;

  // Label SAÍDA
  ws.mergeCells(`I${r_saidaLbl}:M${r_saidaLbl+1}`);
  const cSaidaLbl = ws.getCell(`I${r_saidaLbl}`);
  cSaidaLbl.value     = 'SAÍDA';
  cSaidaLbl.font      = { size:28, name:'Calibri', color:{ argb:'FFFFFFFF' } };
  cSaidaLbl.alignment = centrado;
  cSaidaLbl.fill      = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFC00000' } };

  // Label ENTRADA
  ws.mergeCells(`N${r_saidaLbl}:R${r_saidaLbl+1}`);
  const cEntLbl = ws.getCell(`N${r_saidaLbl}`);
  cEntLbl.value     = 'ENTRADA';
  cEntLbl.font      = { size:28, name:'Calibri' };
  cEntLbl.alignment = centrado;

  // SAÍDA Valor Monetário
  ws.mergeCells(`I${r_saidaMon}:M${r_saidaMon+3}`);
  const cSaidaMon = ws.getCell(`I${r_saidaMon}`);
  cSaidaMon.value     = { formula: '-SUMIF(B:B, "*SAÍDA*", G:G)' };
  cSaidaMon.font      = { size:48, name:'Calibri', color:{ argb:'FFFFFFFF' } };
  cSaidaMon.numFmt    = fmtBRL;
  cSaidaMon.alignment = centrado;
  cSaidaMon.fill      = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFC00000' } };

  // ENTRADA Valor Monetário
  ws.mergeCells(`N${r_saidaMon}:R${r_saidaMon+3}`);
  const cEntMon = ws.getCell(`N${r_saidaMon}`);
  cEntMon.value     = { formula: 'SUMIF(B:B, "*ENTRADA*", G:G)' };
  cEntMon.font      = { size:48, name:'Calibri' };
  cEntMon.numFmt    = fmtBRL;
  cEntMon.alignment = centrado;

  // ── GERAR ARQUIVO E DOWNLOAD ─────────────────────────────────
  const buffer = await wb.xlsx.writeBuffer();
  const blob   = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  });
  const url  = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href     = url;
  link.download = `controle_caixas_${new Date().toISOString().split('T')[0]}.xlsx`;
  link.click();
  URL.revokeObjectURL(url);
  toast('✓ Excel exportado com sucesso!');
}

// Helper: borda fina
function _thinBorder() {
  const t = { style:'thin' };
  return { top:t, left:t, bottom:t, right:t };
}

// ─── BIND EVENTOS ──────────────────────────────────────────────
function bindEvents() {

  // ── Botão Novo ───────────────────────────────────────────────
  $('ll-btn-add')?.addEventListener('click', openAddModal);

  // ── Modal adicionar ──────────────────────────────────────────
  $('ll-modal-close')?.addEventListener('click', closeAddModal);
  $('ll-modal-cancel')?.addEventListener('click', closeAddModal);
  $('ll-modal-add')?.addEventListener('click', e => {
    if (e.target === $('ll-modal-add')) closeAddModal();
  });
  // Auto-preencher valor ao selecionar cor (modal adicionar)
  $('ll-add-cor')?.addEventListener('change', function () {
    const preco = precoPorCor(this.value);
    const qtd   = parseFloat($('ll-add-quantidade')?.value || 0);
    const unit  = $('ll-add-vl-unit');
    const total = $('ll-add-vl-total');
    if (unit && preco > 0)             unit.value  = preco.toFixed(2);
    if (total && preco > 0 && qtd > 0) total.value = (preco * qtd).toFixed(2);
  });

  // Recalcular total ao mudar qtd / unit (modal adicionar)
  ['ll-add-quantidade','ll-add-vl-unit'].forEach(id => {
    $(id)?.addEventListener('input', () => {
      const qtd  = parseFloat($('ll-add-quantidade')?.value || 0);
      const unit = parseFloat($('ll-add-vl-unit')?.value    || 0);
      const tot  = $('ll-add-vl-total');
      if (tot && unit > 0 && qtd > 0) tot.value = (unit * qtd).toFixed(2);
    });
  });

  $('ll-btn-save-add')?.addEventListener('click', saveNewRecord);

  // ── Modal editar ─────────────────────────────────────────────
  $('ll-edit-modal-close')?.addEventListener('click', closeEditModal);
  $('ll-edit-modal-cancel')?.addEventListener('click', closeEditModal);
  $('ll-modal-edit')?.addEventListener('click', e => {
    if (e.target === $('ll-modal-edit')) closeEditModal();
  });

  // Recalcular total ao mudar qtd/cor/unit (modal editar)
  $('ll-edit-cor')?.addEventListener('change', function () {
    const preco = precoPorCor(this.value);
    const qtd   = parseFloat($('ll-edit-quantidade')?.value || 0);
    const unit  = $('ll-edit-vl-unit');
    const total = $('ll-edit-vl-total');
    if (unit && preco > 0)             unit.value  = preco.toFixed(2);
    if (total && preco > 0 && qtd > 0) total.value = (preco * qtd).toFixed(2);
  });

  ['ll-edit-quantidade','ll-edit-vl-unit'].forEach(id => {
    $(id)?.addEventListener('input', () => {
      const qtd  = parseFloat($('ll-edit-quantidade')?.value || 0);
      const unit = parseFloat($('ll-edit-vl-unit')?.value    || 0);
      const tot  = $('ll-edit-vl-total');
      if (tot && unit > 0 && qtd > 0) tot.value = (unit * qtd).toFixed(2);
    });
  });

  $('ll-btn-save-edit')?.addEventListener('click', saveEdit);

  // ── Exportar ─────────────────────────────────────────────────
  $('ll-export-excel')?.addEventListener('click', exportarExcel);

  // ── Atualizar ────────────────────────────────────────────────
  $('ll-refresh')?.addEventListener('click', () => {
    renderTabela();
    toast('Dados atualizados.');
  });

  // ── Filtros rápidos Todos / ENTRADA / SAÍDA ──────────────────
  document.querySelectorAll('.ll-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.ll-filter-btn').forEach(b => {
        b.classList.remove('active');
        b.style.borderColor = 'var(--border)';
        b.style.background  = 'transparent';
        b.style.color       = 'var(--muted)';
      });
      btn.classList.add('active');
      btn.style.borderColor = 'var(--accent)';
      btn.style.background  = 'rgba(0,212,255,.12)';
      btn.style.color       = 'var(--accent)';
      _filtros.tipo = btn.dataset.llFilter === 'all' ? 'all' : btn.dataset.llFilter;
      // Sincroniza com select avançado
      const selTipo = $('ll-f-tipo');
      if (selTipo) selTipo.value = _filtros.tipo;
      atualizarBadgeFiltros();
      renderTabela();
    });
  });

  // ── Filtros avançados ────────────────────────────────────────
  const bindFiltroInput = (id, campo) => {
    $(id)?.addEventListener('input', e => {
      _filtros[campo] = e.target.value;
      atualizarBadgeFiltros();
      renderTabela();
    });
  };
  const bindFiltroChange = (id, campo) => {
    $(id)?.addEventListener('change', e => {
      _filtros[campo] = e.target.value;
      // Sincroniza botões rápidos de tipo
      if (campo === 'tipo') {
        document.querySelectorAll('.ll-filter-btn').forEach(b => {
          const match = b.dataset.llFilter === (e.target.value === 'all' ? 'all' : e.target.value);
          b.classList.toggle('active', match);
          b.style.borderColor = match ? 'var(--accent)' : 'var(--border)';
          b.style.background  = match ? 'rgba(0,212,255,.12)' : 'transparent';
          b.style.color       = match ? 'var(--accent)' : 'var(--muted)';
        });
      }
      atualizarBadgeFiltros();
      renderTabela();
    });
  };

  bindFiltroInput('ll-f-data-ini', 'dataInicio');
  bindFiltroInput('ll-f-data-fim', 'dataFim');
  bindFiltroInput('ll-f-cliente',  'cliente');
  bindFiltroInput('ll-f-motorista','motorista');
  bindFiltroChange('ll-f-tipo',    'tipo');
  bindFiltroChange('ll-f-cor',     'cor');

  $('ll-filter-reset')?.addEventListener('click', resetarFiltros);

  // ── Delegação de eventos na tabela ───────────────────────────
  $('ll-tbody')?.addEventListener('click', e => {
    const btn = e.target.closest('[data-ll-action]'); if (!btn) return;
    const id  = btn.dataset.llId;
    if (btn.dataset.llAction === 'edit') openEditModal(id);
    if (btn.dataset.llAction === 'del')  deleteRecord(id);
  });

  // ── Observer: renderiza quando a aba fica ativa ──────────────
  const tabPanel = $('tab-luminlog');
  if (tabPanel) {
    new MutationObserver(() => {
      if (tabPanel.classList.contains('active')) renderTabela();
    }).observe(tabPanel, { attributes: true, attributeFilter: ['class'] });
  }
}

// ─── INICIALIZAÇÃO ─────────────────────────────────────────────
window.addEventListener('lumin:admin-ready', async () => {
  const ok = await window.LuminAuth?.requireRole('master');
  if (!ok) return;
  bindEvents();
  initFiltrosColapsaveis();  // filtros colapsáveis
  carregarFrequentes();      // carrega motoristas/clientes salvos
  startListener();

  // Expõe renderTabela globalmente para o script inline do index.html
  window.renderLuminLog  = renderTabela;
  window.initLuminLog    = () => {};  // já inicializado, no-op
});
