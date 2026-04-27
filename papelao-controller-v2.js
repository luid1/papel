/**
 * ═══════════════════════════════════════════════════════════════
 *  LUMIN — Papelão Controller v2
 *  Arquivo: papelao-controller-v2.js
 *
 *  Novidades v2:
 *  • Toggle para ativar/desativar módulo "A Pagar Papelão"
 *  • Preço fixo R$ 0,40/kg (padrão) com campo editável pelo cliente
 *  • Agrupamento robusto por nome de empresa (case-insensitive + trim)
 *    — empresas com mesmo nome têm valores somados corretamente
 *  • Preço personalizado salvo por fornecedor no Firestore
 * ═══════════════════════════════════════════════════════════════
 */

import { db } from './firebase-config.js';
import {
  collection, doc, addDoc, updateDoc, deleteDoc,
  onSnapshot, query, orderBy, serverTimestamp, getDoc, setDoc
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

// ─── CONSTANTES ────────────────────────────────────────────────
const DEFAULT_PRICE_KG = 0.40;
const SETTINGS_DOC_ID  = 'papelao_settings'; // documento em companies/{cId}/settings

const fmt   = v => Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtKg = v => Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc   = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const $     = id => document.getElementById(id);

function addEv(id, fn) {
  const el = typeof id === 'string' ? $(id) : id;
  if (!el) return;
  el.addEventListener('touchstart', e => { e.preventDefault(); fn(e); }, { passive: false });
  el.addEventListener('click', fn);
}

function toast(msg, isErr = false) {
  const t = $('toast'); if (!t) return;
  t.textContent = msg;
  t.className = 'show' + (isErr ? ' err' : '');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.className = '', 2800);
}

// ─── NORMALIZA NOME DE FORNECEDOR ─────────────────────────────
// Garante que "Eco Mix", "eco mix", "ECO MIX  " sejam tratados como o MESMO fornecedor
function normalizeSupplier(name) {
  return (name || 'aleatório/avulso').trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, ''); // remove acentos para comparação
}

function displaySupplier(name) {
  return (name || 'Aleatório/Avulso').trim();
}

// ─── ESTADO INTERNO ────────────────────────────────────────────
let _cId        = null;
let _col        = null;
let _settingsCol = null;
let _papelao    = [];
let _tab        = 'apagar';
let _filter     = 'weekend';
let _moduleEnabled = true;   // toggle do módulo
let _priceKg    = DEFAULT_PRICE_KG; // preço/kg atual

// ─── CARREGAR CONFIGURAÇÕES ────────────────────────────────────
async function loadSettings() {
  if (!_settingsCol) return;
  try {
    const snap = await getDoc(doc(db, _settingsCol, SETTINGS_DOC_ID));
    if (snap.exists()) {
      const data = snap.data();
      _moduleEnabled = data.enabled !== false; // padrão: ativado
      _priceKg       = typeof data.priceKg === 'number' ? data.priceKg : DEFAULT_PRICE_KG;
    } else {
      // Primeira vez: cria com padrões
      await saveSettings();
    }
  } catch (e) {
    console.warn('[Papelão] Erro ao carregar configurações:', e);
  }
}

async function saveSettings() {
  if (!_settingsCol) return;
  try {
    await setDoc(doc(db, _settingsCol, SETTINGS_DOC_ID), {
      enabled: _moduleEnabled,
      priceKg: _priceKg,
      updatedAt: serverTimestamp()
    }, { merge: true });
  } catch (e) {
    console.warn('[Papelão] Erro ao salvar configurações:', e);
  }
}

// ─── RENDER TOGGLE + CONFIGURAÇÕES ────────────────────────────
function renderSettings() {
  const panel = $('pap-settings-panel');
  if (!panel) return;

  panel.innerHTML = `
    <!-- Toggle principal do módulo -->
    <div class="glass pap-setting-card" style="
      display:flex; align-items:center; justify-content:space-between;
      padding:24px 28px; border-radius:20px; margin-bottom:16px;
      border:1px solid rgba(0,212,255,.15);
    ">
      <div style="flex:1;">
        <div style="font-size:18px; font-weight:800; margin-bottom:4px; color:var(--text);">
          📦 Módulo A Pagar Papelão
        </div>
        <div style="font-size:13px; color:var(--muted);">
          Ativa ou desativa completamente a aba "A Pagar" do painel de papelão.
        </div>
      </div>
      <label class="pap-toggle" style="margin-left:24px; flex-shrink:0;">
        <input type="checkbox" id="pap-toggle-enabled" ${_moduleEnabled ? 'checked' : ''}>
        <span class="pap-toggle-slider"></span>
      </label>
    </div>

    <!-- Preço por KG -->
    <div class="glass pap-setting-card" style="
      padding:24px 28px; border-radius:20px; margin-bottom:16px;
      border:1px solid rgba(255,179,71,.15);
    ">
      <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:16px;">
        <div style="flex:1; min-width:200px;">
          <div style="font-size:18px; font-weight:800; margin-bottom:4px; color:var(--text);">
            💰 Preço por Quilograma
          </div>
          <div style="font-size:13px; color:var(--muted);">
            Padrão do sistema: <strong style="color:var(--warning);">R$ 0,40/kg</strong>.
            Personalize conforme o seu fornecedor.
          </div>
        </div>
        <div style="display:flex; align-items:center; gap:10px;">
          <span style="color:var(--muted); font-size:15px; font-weight:600;">R$</span>
          <input
            id="pap-price-input"
            type="number"
            min="0.01"
            step="0.01"
            value="${_priceKg.toFixed(2)}"
            style="
              width:110px; padding:12px 14px; border-radius:12px;
              background:var(--bg2); border:1.5px solid rgba(255,179,71,.3);
              color:var(--warning); font-family:'DM Mono',monospace;
              font-size:18px; font-weight:700; text-align:center;
              outline:none; transition:.2s;
            "
          >
          <span style="color:var(--muted); font-size:14px;">/kg</span>
        </div>
      </div>

      <!-- Preview -->
      <div style="
        margin-top:16px; padding:14px 18px; border-radius:12px;
        background:rgba(255,179,71,.05); border:1px solid rgba(255,179,71,.1);
        display:flex; gap:20px; flex-wrap:wrap;
      ">
        <div style="font-size:13px; color:var(--muted);">Simulação rápida:</div>
        <div id="pap-price-preview" style="font-size:13px; color:var(--text); font-family:'DM Mono',monospace;">
          ${_buildPricePreview(_priceKg)}
        </div>
      </div>
    </div>

    <!-- Botão salvar -->
    <button id="btn-save-pap-settings" style="
      padding:16px 32px; border-radius:14px; border:none; cursor:pointer;
      background:linear-gradient(135deg, #00d4ff, #0099cc);
      color:#000; font-weight:800; font-size:16px;
      box-shadow:0 4px 20px rgba(0,212,255,.3); transition:.2s;
    ">
      ✓ Salvar Configurações
    </button>
  `;

  // Bind toggle
  const toggleEl = $('pap-toggle-enabled');
  if (toggleEl) {
    toggleEl.addEventListener('change', () => {
      _moduleEnabled = toggleEl.checked;
      _updateModuleVisibility();
    });
  }

  // Bind preço — preview em tempo real
  const priceEl = $('pap-price-input');
  if (priceEl) {
    priceEl.addEventListener('input', () => {
      const v = parseFloat(priceEl.value) || DEFAULT_PRICE_KG;
      const prev = $('pap-price-preview');
      if (prev) prev.textContent = _buildPricePreview(v);
    });
    priceEl.addEventListener('focus', function() { this.style.borderColor = 'var(--warning)'; });
    priceEl.addEventListener('blur',  function() { this.style.borderColor = 'rgba(255,179,71,.3)'; });
  }

  // Bind salvar
  addEv('btn-save-pap-settings', async () => {
    const newPrice = parseFloat($('pap-price-input')?.value);
    if (isNaN(newPrice) || newPrice <= 0) {
      toast('⚠ Informe um preço válido por kg.', true);
      return;
    }
    _priceKg = newPrice;
    await saveSettings();
    toast('✓ Configurações salvas!');
    _updateModuleVisibility();
    render(); // re-render com novo preço
  });
}

function _buildPricePreview(price) {
  const examples = [10, 25, 50, 100];
  return examples.map(kg => `${kg}kg → ${fmt(kg * price)}`).join('  ·  ');
}

// ─── VISIBILIDADE DO MÓDULO ────────────────────────────────────
function _updateModuleVisibility() {
  const aPagarTab = document.querySelector('[data-pap-tab="apagar"]');
  const aPagarPanel = $('pap-apagar-panel');
  const disabledNotice = $('pap-disabled-notice');

  if (_moduleEnabled) {
    if (aPagarTab) { aPagarTab.style.opacity = '1'; aPagarTab.style.pointerEvents = 'auto'; }
    if (disabledNotice) disabledNotice.style.display = 'none';
  } else {
    // Se a aba A Pagar estava ativa, muda para Dashboard
    if (_tab === 'apagar') {
      _tab = 'dashboard';
      if (aPagarPanel) aPagarPanel.style.display = 'none';
      const dashPanel = $('pap-dash-panel');
      if (dashPanel) dashPanel.style.display = 'block';
    }
    if (aPagarTab) { aPagarTab.style.opacity = '0.35'; aPagarTab.style.pointerEvents = 'none'; }
    if (disabledNotice) disabledNotice.style.display = 'block';
  }
}

// ─── MODAL PESAGEM ─────────────────────────────────────────────
function openPapModal() {
  if (!_moduleEnabled) { toast('⚠ Módulo A Pagar está desativado nas configurações.', true); return; }
  const modal = $('pap-modal-add');
  if (!modal) return;
  modal.classList.add('active');
  const dataEl = $('pap-data');
  if (dataEl && !dataEl.value) dataEl.valueAsDate = new Date();

  // Atualiza preview do preço no modal
  const priceLabel = $('pap-modal-price-label');
  if (priceLabel) priceLabel.textContent = `R$ ${_priceKg.toFixed(2)}/kg`;
  setTimeout(() => $('pap-mercado')?.focus(), 280);
}

function closePapModal() {
  const modal = $('pap-modal-add');
  if (modal) modal.classList.remove('active');
}

// ─── RENDER A PAGAR — AGRUPADO POR FORNECEDOR ─────────────────
function renderAPagar() {
  const list = $('pap-apagar-list'); if (!list) return;

  // Módulo desativado?
  if (!_moduleEnabled) {
    list.innerHTML = `
      <div id="pap-disabled-notice" style="
        text-align:center; padding:60px 20px; color:var(--muted);
      ">
        <div style="font-size:48px; margin-bottom:16px;">🔒</div>
        <div style="font-size:18px; font-weight:700; margin-bottom:8px; color:var(--text);">
          Módulo Desativado
        </div>
        <div style="font-size:14px;">
          O módulo "A Pagar Papelão" está desativado.<br>
          Ative-o na aba <strong>Configurações</strong>.
        </div>
      </div>`;
    return;
  }

  const items = _papelao.filter(p => p.status === 'apagar');

  if (!items.length) {
    list.innerHTML = `
      <div style="text-align:center; padding:60px; color:var(--success); font-size:17px; font-weight:700;">
        ✓ Tudo em dia! Sem pendências.
      </div>`;
    return;
  }

  // ── AGRUPAMENTO ROBUSTO ──────────────────────────────────────
  // Usa chave normalizada (sem acentos, lowercase, trimmed) para comparar,
  // mas exibe o nome original do primeiro item do grupo
  const groupMap = new Map(); // chave normalizada → { label, items, totalKg, totalVal }

  items.forEach(p => {
    const key      = normalizeSupplier(p.mercado);
    const label    = displaySupplier(p.mercado);
    const kg       = Number(p.kg) || 0;
    const total    = Number(p.total) || 0;

    if (!groupMap.has(key)) {
      groupMap.set(key, { label, items: [], totalKg: 0, totalVal: 0, priceKg: p.preco || _priceKg });
    }
    const g = groupMap.get(key);
    g.items.push(p);
    g.totalKg  += kg;
    g.totalVal += total;
  });

  const groups = Array.from(groupMap.values());

  list.innerHTML = groups.map(g => `
    <div class="glass ob-item" style="
      margin-bottom:14px; gap:18px; padding:24px 28px; border-radius:20px;
      border:1px solid rgba(255,179,71,.15); flex-wrap:wrap;
    ">
      <div style="
        width:48px; height:48px; border-radius:14px;
        background:rgba(255,179,71,.1); border:1px solid rgba(255,179,71,.2);
        display:grid; place-items:center; font-size:24px; flex-shrink:0;
      ">📦</div>

      <div style="flex:1; min-width:0;">
        <div style="font-size:19px; font-weight:700; margin-bottom:4px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
          ${esc(g.label)}
        </div>
        <div style="font-size:13px; color:var(--muted);">
          ${g.items.length} pesagem(ns)
          &nbsp;·&nbsp;
          ${fmtKg(g.totalKg)} kg
          &nbsp;·&nbsp;
          <span style="color:var(--warning);">R$ ${(g.priceKg || _priceKg).toFixed(2)}/kg</span>
        </div>
      </div>

      <div style="
        font-family:'DM Mono',monospace;
        font-size:clamp(20px,4vw,28px);
        font-weight:700; color:var(--warning);
        flex-shrink:0; margin:0 8px;
      ">${fmt(g.totalVal)}</div>

      <button
        data-baixar-grupo="${esc(normalizeSupplier(g.label))}"
        style="
          padding:14px 22px; border-radius:12px; min-height:52px;
          background:rgba(0,229,160,.1); border:1.5px solid rgba(0,229,160,.25);
          color:var(--success); font-weight:800; font-size:15px;
          display:flex; align-items:center; gap:8px; cursor:pointer;
          white-space:nowrap; transition:.2s;
        "
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
        Dar Baixa
      </button>
    </div>
  `).join('');

  // Dar Baixa — quita todo o grupo usando chave normalizada
  list.querySelectorAll('[data-baixar-grupo]').forEach(btn => {
    addEv(btn, async () => {
      const normKey = btn.dataset.baixarGrupo;
      const grupo   = _papelao.filter(
        p => p.status === 'apagar' && normalizeSupplier(p.mercado) === normKey
      );
      const labelEx = displaySupplier(grupo[0]?.mercado);
      if (!confirm(`Dar baixa em ${grupo.length} pesagem(ns) do fornecedor "${labelEx}"?`)) return;
      try {
        await Promise.all(
          grupo.map(p => updateDoc(doc(db, _col, p.id), {
            status: 'pago',
            pagoEm: serverTimestamp()
          }))
        );
        toast('✓ Grupo quitado com sucesso!');
      } catch (e) {
        toast('Erro ao dar baixa', true);
        console.error(e);
      }
    });
  });
}

// ─── RENDER DASHBOARD PAGOS ────────────────────────────────────
function renderDash() {
  const now = new Date();
  let pagos = _papelao.filter(p => p.status === 'pago');

  if (_filter === 'weekend') {
    const day = now.getDay();
    const mon = new Date(now); mon.setDate(now.getDate() - day);
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
    pagos = pagos.filter(p => {
      if (!p.data) return false;
      const d = new Date(p.data + 'T12:00:00');
      return d >= mon && d <= sun;
    });
  } else if (_filter === 'month') {
    pagos = pagos.filter(p => {
      if (!p.data) return false;
      const [y, m] = p.data.split('-').map(Number);
      return y === now.getFullYear() && m - 1 === now.getMonth();
    });
  }

  const totalKg   = pagos.reduce((a, p) => a + (Number(p.kg) || 0), 0);
  const totalPago = pagos.reduce((a, p) => a + (Number(p.total) || 0), 0);
  const kgEl  = $('pap-dash-kg');    if (kgEl)  kgEl.textContent  = fmtKg(totalKg) + ' kg';
  const totEl = $('pap-dash-total'); if (totEl) totEl.textContent = fmt(totalPago);
  const cntEl = $('pap-dash-count'); if (cntEl) cntEl.textContent = pagos.length;

  // ── AGRUPAMENTO ROBUSTO (Dashboard) ─────────────────────────
  const groupMap = new Map();
  pagos.forEach(p => {
    const key   = normalizeSupplier(p.mercado);
    const label = displaySupplier(p.mercado);
    if (!groupMap.has(key)) groupMap.set(key, { label, items: [], total: 0, kg: 0 });
    const g = groupMap.get(key);
    g.items.push(p);
    g.total += Number(p.total) || 0;
    g.kg    += Number(p.kg)    || 0;
  });

  const dg = $('pap-dash-groups'); if (!dg) return;
  const entries = Array.from(groupMap.values());

  if (!entries.length) {
    dg.innerHTML = `<p style="color:var(--muted); font-size:17px; padding:20px 0;">Nenhum pagamento neste período.</p>`;
    return;
  }

  dg.innerHTML = entries.map(g => `
    <div class="glass" style="border-radius:20px; margin-bottom:14px; overflow:hidden;">
      <div style="
        padding:22px 28px; display:flex; align-items:center;
        justify-content:space-between; background:rgba(255,255,255,.03);
      ">
        <div>
          <div style="font-size:20px; font-weight:800; margin-bottom:4px;">${esc(g.label)}</div>
          <div style="font-size:14px; color:var(--muted);">${g.items.length} pesagem(ns) &nbsp;·&nbsp; ${fmtKg(g.kg)} kg</div>
        </div>
        <div style="font-family:'DM Mono',monospace; font-size:24px; font-weight:700; color:var(--success);">
          ${fmt(g.total)}
        </div>
      </div>
      <div style="padding:0 28px 20px;">
        ${g.items.map(p => `
          <div style="
            display:flex; align-items:center; justify-content:space-between;
            padding:14px 0; border-bottom:1px solid rgba(255,255,255,.04); font-size:15px;
          ">
            <span style="color:var(--muted); font-family:'DM Mono',monospace;">${p.data || '—'}</span>
            <span>${fmtKg(p.kg)} kg</span>
            <span style="color:var(--success); font-family:'DM Mono',monospace; font-weight:700;">
              ${fmt(p.total)}
            </span>
          </div>
        `).join('')}
      </div>
    </div>
  `).join('');
}

// ─── RENDER PRINCIPAL ──────────────────────────────────────────
function render() {
  if (_tab === 'apagar')      renderAPagar();
  else if (_tab === 'dashboard') renderDash();
  else if (_tab === 'config') renderSettings();
  updateAutocomplete();
}

function updateAutocomplete() {
  const dl = $('pap-mercados-list'); if (!dl) return;
  const nomes = [...new Set(_papelao.map(p => displaySupplier(p.mercado)).filter(Boolean))];
  dl.innerHTML = ['Aleatório/Avulso', ...nomes].map(n => `<option value="${esc(n)}">`).join('');
}

// ─── BIND EVENTOS ──────────────────────────────────────────────
function bindEvents() {
  addEv('btn-open-pap-modal', openPapModal);

  addEv('pap-modal-close', closePapModal);
  $('pap-modal-add')?.addEventListener('click', e => {
    if (e.target === $('pap-modal-add')) closePapModal();
  });

  // Preview KG no modal
  $('pap-kg')?.addEventListener('input', function () {
    const kg   = parseFloat(this.value) || 0;
    const prev = $('pap-total-preview');
    if (prev) prev.textContent = fmt(kg * _priceKg);
  });

  // Registrar pesagem
  addEv('btn-registrar-pap', async () => {
    if (!_moduleEnabled) { toast('⚠ Módulo desativado.', true); return; }
    const mercado = ($('pap-mercado')?.value || '').trim() || 'Aleatório/Avulso';
    const kg      = parseFloat($('pap-kg')?.value || 0);
    const data    = $('pap-data')?.value;
    // Permite preço customizado no modal (campo opcional)
    const precoCustom = parseFloat($('pap-preco-custom')?.value || '');
    const precoFinal  = (!isNaN(precoCustom) && precoCustom > 0) ? precoCustom : _priceKg;

    if (!kg || kg <= 0) { toast('⚠ Informe o peso em KG', true); return; }
    if (!data)           { toast('⚠ Informe a data', true); return; }

    const btn = $('btn-registrar-pap'); if (btn) btn.disabled = true;
    try {
      await addDoc(collection(db, _col), {
        mercado,
        kg,
        preco:     precoFinal,
        total:     kg * precoFinal,
        data,
        status:    'apagar',
        companyId: _cId || null,
        createdAt: serverTimestamp()
      });
      toast('✓ Pesagem registrada!');
      if ($('pap-mercado'))     $('pap-mercado').value     = '';
      if ($('pap-kg'))          $('pap-kg').value          = '';
      if ($('pap-preco-custom')) $('pap-preco-custom').value = '';
      if ($('pap-total-preview')) $('pap-total-preview').textContent = 'R$ 0,00';
      closePapModal();
    } catch (e) {
      toast('Erro ao registrar', true);
      console.error(e);
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  // Tabs: A Pagar / Dashboard / Configurações
  document.querySelectorAll('.pap-tab-btn').forEach(btn => {
    addEv(btn, () => {
      // Se tentando ir para "A Pagar" com módulo desativado
      if (btn.dataset.papTab === 'apagar' && !_moduleEnabled) {
        toast('⚠ Módulo A Pagar está desativado. Ative nas Configurações.', true);
        return;
      }

      document.querySelectorAll('.pap-tab-btn').forEach(b => {
        b.classList.remove('active');
        b.style.background = 'transparent';
        b.style.color      = 'var(--muted)';
        b.style.boxShadow  = 'none';
      });
      btn.classList.add('active');
      btn.style.background = 'var(--bg2)';
      btn.style.color      = 'var(--text)';
      btn.style.boxShadow  = '0 2px 8px rgba(0,0,0,.3)';

      _tab = btn.dataset.papTab;
      $('pap-apagar-panel').style.display  = _tab === 'apagar'    ? 'block' : 'none';
      $('pap-dash-panel').style.display    = _tab === 'dashboard' ? 'block' : 'none';
      $('pap-config-panel').style.display  = _tab === 'config'    ? 'block' : 'none';
      render();
    });
  });

  // Filtros dashboard
  document.querySelectorAll('.pap-filter-btn').forEach(btn => {
    addEv(btn, () => {
      document.querySelectorAll('.pap-filter-btn').forEach(b => {
        b.classList.remove('active');
        b.style.borderColor = 'var(--border)';
        b.style.background  = 'transparent';
        b.style.color       = 'var(--muted)';
      });
      btn.classList.add('active');
      btn.style.borderColor = 'var(--accent)';
      btn.style.background  = 'rgba(0,212,255,.12)';
      btn.style.color       = 'var(--accent)';
      _filter = btn.dataset.papFilter;
      renderDash();
    });
  });
}

// ─── CSS DO TOGGLE ─────────────────────────────────────────────
function injectToggleCSS() {
  if ($('pap-toggle-style')) return;
  const style = document.createElement('style');
  style.id = 'pap-toggle-style';
  style.textContent = `
    .pap-toggle {
      position: relative;
      display: inline-block;
      width: 56px;
      height: 30px;
      cursor: pointer;
    }
    .pap-toggle input { opacity: 0; width: 0; height: 0; }
    .pap-toggle-slider {
      position: absolute;
      inset: 0;
      background: rgba(255,255,255,.1);
      border-radius: 30px;
      transition: .3s;
      border: 1.5px solid rgba(255,255,255,.15);
    }
    .pap-toggle-slider::before {
      content: '';
      position: absolute;
      width: 22px; height: 22px;
      left: 3px; bottom: 3px;
      background: #fff;
      border-radius: 50%;
      transition: .3s;
    }
    .pap-toggle input:checked + .pap-toggle-slider {
      background: rgba(0,212,255,.4);
      border-color: rgba(0,212,255,.6);
    }
    .pap-toggle input:checked + .pap-toggle-slider::before {
      transform: translateX(26px);
      background: var(--accent, #00d4ff);
    }
  `;
  document.head.appendChild(style);
}

// ─── INICIALIZAÇÃO ─────────────────────────────────────────────
async function init(user) {
  _cId         = user.companyId || null;
  _col         = _cId ? `companies/${_cId}/papelao` : 'papelao';
  _settingsCol = _cId ? `companies/${_cId}/settings` : 'settings';

  injectToggleCSS();
  await loadSettings();
  bindEvents();
  _updateModuleVisibility();

  // Realtime listener
  onSnapshot(
    query(collection(db, _col), orderBy('createdAt', 'desc')),
    snap => {
      _papelao = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      const view = document.getElementById('v-papelao');
      if (view && view.classList.contains('active')) render();
    },
    err => console.error('[Papelão]', err)
  );
}

// ─── LISTENERS ─────────────────────────────────────────────────
window.addEventListener('lumin:tenant-ready', e => {
  const user = e.detail?.user;
  if (!user) return;
  init(user);
});

const _observer = new MutationObserver(() => {
  const view = document.getElementById('v-papelao');
  if (view && view.classList.contains('active')) render();
});

document.addEventListener('DOMContentLoaded', () => {
  const view = document.getElementById('v-papelao');
  if (view) _observer.observe(view, { attributes: true, attributeFilter: ['class'] });
});
