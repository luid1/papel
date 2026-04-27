/**
 * ═══════════════════════════════════════════════════════════════
 *  LUMIN SaaS — Combustível / Logística Controller
 *  Arquivo: combustivel-controller.js
 *
 *  Regras de negócio:
 *  • KM Rodado × R$/Litro × Litros Abastecidos = Total Gasto
 *  • Alternativa simplificada: KM Rodado × Custo/KM = Total
 *  • Tenant (Wallace) registra viagens e abastecimentos
 *  • Admin/Owner pode editar preço padrão do combustível
 *    e editar/excluir registros antigos
 *  • Dashboard consolida por período (semana / mês / todos)
 *  • Admin Master (Luid) vê consolidado via painel admin
 * ═══════════════════════════════════════════════════════════════
 */

import { db } from './firebase-config.js';
import {
  collection, doc, addDoc, updateDoc, deleteDoc, setDoc, getDoc,
  onSnapshot, query, orderBy, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

// ─── CONSTANTES ───────────────────────────────────────────────
const DEFAULT_FUEL_PRICE = 6.19;   // R$/litro padrão
const DEFAULT_EFFICIENCY = 10.0;   // km/litro padrão (consumo médio)
const MODULE_CONFIG_DOC  = 'config_combustivel'; // doc na coleção da empresa

const fmt   = v => Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtN  = (v, d=2) => Number(v).toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });
const esc   = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const $     = id => document.getElementById(id);
const fDate = iso => iso ? iso.split('-').reverse().join('/') : '—';

function addEv(id, fn) {
  const el = typeof id === 'string' ? $(id) : id;
  if (!el) return;
  el.addEventListener('touchstart', e => { e.preventDefault(); fn(e); }, { passive: false });
  el.addEventListener('click', fn);
}

function toast(msg, isErr = false) {
  const t = $('toast'); if (!t) return;
  t.textContent = msg; t.className = 'show' + (isErr ? ' err' : '');
  clearTimeout(t._t); t._t = setTimeout(() => t.className = '', 2800);
}

// ─── ESTADO ───────────────────────────────────────────────────
let _cId       = null;   // companyId do tenant
let _col       = null;   // coleção Firestore das viagens
let _colConfig = null;   // coleção de configuração
let _registros = [];     // cache local das viagens
let _tab       = 'registrar';  // tab ativa
let _filter    = 'month';      // filtro dashboard
let _config    = {             // configuração editável
  precoLitro:  DEFAULT_FUEL_PRICE,
  consumoMedio: DEFAULT_EFFICIENCY,
  veiculo:     'Veículo Padrão',
  updatedAt:   null
};
let _userRole  = 'tenant'; // role do usuário atual

// ─── CÁLCULO PRINCIPAL ────────────────────────────────────────
/**
 * Dado km rodado, litros abastecidos e preço/litro,
 * calcula o custo total. Se litros não informado, estima
 * com base no consumo médio configurado.
 */
function calcTotal(km, litros, precoLitro) {
  const km_    = parseFloat(km)    || 0;
  const lit_   = parseFloat(litros) > 0 ? parseFloat(litros) : (km_ / (_config.consumoMedio || DEFAULT_EFFICIENCY));
  const preco_ = parseFloat(precoLitro) > 0 ? parseFloat(precoLitro) : (_config.precoLitro || DEFAULT_FUEL_PRICE);
  return lit_ * preco_;
}

// ─── LOAD CONFIG ──────────────────────────────────────────────
async function loadConfig() {
  if (!_colConfig) return;
  try {
    const snap = await getDoc(doc(db, _colConfig, MODULE_CONFIG_DOC));
    if (snap.exists()) {
      _config = { ..._config, ...snap.data() };
      _applyConfigToUI();
    }
  } catch (e) {
    console.warn('[Combustível] Config não encontrada, usando padrão.');
  }
}

function _applyConfigToUI() {
  const priceEl = $('comb-config-preco');
  const consumEl = $('comb-config-consumo');
  const veicEl = $('comb-config-veiculo');
  const labelEl = $('comb-modal-price-label');
  const inputEl = $('comb-preco-custom');

  if (priceEl) priceEl.value = _config.precoLitro;
  if (consumEl) consumEl.value = _config.consumoMedio;
  if (veicEl) veicEl.value = _config.veiculo || '';
  if (labelEl) labelEl.textContent = `R$ ${fmtN(_config.precoLitro)}/L`;
  if (inputEl) inputEl.placeholder = fmtN(_config.precoLitro);
}

// ─── MODAL REGISTRO ───────────────────────────────────────────
function openCombModal(editData = null) {
  const modal = $('comb-modal-add');
  if (!modal) return;
  modal.classList.add('active');

  // Preenche data padrão
  const dataEl = $('comb-data');
  if (dataEl && !editData) dataEl.valueAsDate = new Date();

  if (editData) {
    // Modo edição
    if ($('comb-km'))    $('comb-km').value      = editData.km || '';
    if ($('comb-litros')) $('comb-litros').value  = editData.litros || '';
    if ($('comb-origem')) $('comb-origem').value  = editData.origem || '';
    if ($('comb-destino')) $('comb-destino').value = editData.destino || '';
    if (dataEl)          dataEl.value             = editData.data || '';
    if ($('comb-preco-custom')) $('comb-preco-custom').value = editData.precoLitro !== _config.precoLitro ? editData.precoLitro : '';

    const btn = $('btn-registrar-comb');
    if (btn) {
      btn._editId = editData.id;
      btn.textContent = '✏️ Atualizar Registro';
    }
    updateTotalPreview();
  }

  setTimeout(() => $('comb-origem')?.focus(), 280);
}

function closeCombModal() {
  const modal = $('comb-modal-add');
  if (modal) modal.classList.remove('active');
  ['comb-km','comb-litros','comb-origem','comb-destino','comb-preco-custom'].forEach(id => {
    const el = $(id); if (el) el.value = '';
  });
  const prev = $('comb-total-preview');
  if (prev) prev.textContent = 'R$ 0,00';
  const btn = $('btn-registrar-comb');
  if (btn) { btn._editId = null; btn.textContent = '⛽ Registrar Viagem'; }
}

function updateTotalPreview() {
  const km     = parseFloat($('comb-km')?.value)    || 0;
  const litros = parseFloat($('comb-litros')?.value) || 0;
  const preco  = parseFloat($('comb-preco-custom')?.value) || _config.precoLitro;
  const total  = calcTotal(km, litros, preco);

  const prev = $('comb-total-preview');
  if (prev) prev.textContent = fmt(total);

  // Mostra estimativa de litros
  const litEst = $('comb-litros-est');
  if (litEst) {
    if (km > 0 && litros === 0) {
      const est = km / (_config.consumoMedio || DEFAULT_EFFICIENCY);
      litEst.textContent = `≈ ${fmtN(est)} L estimado`;
      litEst.style.display = 'block';
    } else {
      litEst.style.display = 'none';
    }
  }
}

// ─── RENDER: TAB REGISTRAR ────────────────────────────────────
function renderRegistros() {
  const list = $('comb-list'); if (!list) return;

  const canEdit = _userRole === 'master' || _userRole === 'admin' || _userRole === 'owner';
  const items = _registros.slice(0, 20); // últimos 20

  if (!items.length) {
    list.innerHTML = `
      <div style="text-align:center;padding:60px 20px;color:var(--muted);">
        <div style="font-size:56px;margin-bottom:16px;">🛣️</div>
        <div style="font-size:18px;font-weight:700;color:var(--text);margin-bottom:8px;">Nenhuma viagem registrada</div>
        <div style="font-size:14px;">Registre sua primeira viagem clicando no botão acima.</div>
      </div>`;
    return;
  }

  list.innerHTML = items.map(r => {
    const totalReal = r.total || calcTotal(r.km, r.litros, r.precoLitro);
    const litrosReal = r.litros || (r.km / (_config.consumoMedio || DEFAULT_EFFICIENCY));
    return `
    <div class="glass ob-item comb-card" style="margin-bottom:12px;gap:16px;padding:20px 24px;border-radius:20px;border:1px solid rgba(0,212,255,.12);flex-wrap:wrap;align-items:center;">
      <div style="width:48px;height:48px;border-radius:14px;background:rgba(0,212,255,.08);border:1px solid rgba(0,212,255,.18);display:grid;place-items:center;font-size:22px;flex-shrink:0;">⛽</div>

      <div style="flex:1;min-width:0;">
        <div style="font-size:16px;font-weight:700;margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
          ${esc(r.origem || '—')} → ${esc(r.destino || '—')}
        </div>
        <div style="font-size:12px;color:var(--muted);display:flex;gap:12px;flex-wrap:wrap;">
          <span>📅 ${fDate(r.data)}</span>
          <span>🛣️ ${fmtN(r.km)} km</span>
          <span>🧴 ${fmtN(litrosReal)} L</span>
          <span>R$ ${fmtN(r.precoLitro || _config.precoLitro)}/L</span>
        </div>
      </div>

      <div style="font-family:'DM Mono',monospace;font-size:clamp(18px,3.5vw,24px);font-weight:700;color:var(--accent);flex-shrink:0;">${fmt(totalReal)}</div>

      ${canEdit ? `
      <div style="display:flex;gap:8px;flex-shrink:0;">
        <button data-comb-edit="${r.id}" title="Editar" style="width:40px;height:40px;border-radius:10px;background:rgba(0,212,255,.08);border:1px solid rgba(0,212,255,.2);color:var(--accent);display:grid;place-items:center;cursor:pointer;font-size:16px;">✏️</button>
        <button data-comb-del="${r.id}" title="Excluir" style="width:40px;height:40px;border-radius:10px;background:rgba(255,91,112,.08);border:1px solid rgba(255,91,112,.2);color:var(--alert);display:grid;place-items:center;cursor:pointer;font-size:16px;">🗑️</button>
      </div>` : ''}
    </div>`;
  }).join('');

  // Bind edit/delete
  list.querySelectorAll('[data-comb-edit]').forEach(btn => {
    addEv(btn, () => {
      const reg = _registros.find(r => r.id === btn.dataset.combEdit);
      if (reg) openCombModal(reg);
    });
  });

  list.querySelectorAll('[data-comb-del]').forEach(btn => {
    addEv(btn, async () => {
      if (!confirm('Excluir este registro de viagem?')) return;
      try {
        await deleteDoc(doc(db, _col, btn.dataset.combDel));
        toast('✓ Registro excluído.');
      } catch (e) { toast('Erro ao excluir', true); }
    });
  });
}

// ─── RENDER: DASHBOARD ────────────────────────────────────────
function renderDash() {
  const now = new Date();
  let filtered = [..._registros];

  if (_filter === 'week') {
    const day = now.getDay();
    const mon = new Date(now); mon.setDate(now.getDate() - day);
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
    filtered = filtered.filter(r => {
      if (!r.data) return false;
      const d = new Date(r.data + 'T12:00:00');
      return d >= mon && d <= sun;
    });
  } else if (_filter === 'month') {
    filtered = filtered.filter(r => {
      if (!r.data) return false;
      const [y, m] = r.data.split('-').map(Number);
      return y === now.getFullYear() && m - 1 === now.getMonth();
    });
  }

  const totalKm    = filtered.reduce((a, r) => a + (parseFloat(r.km) || 0), 0);
  const totalLit   = filtered.reduce((a, r) => a + (parseFloat(r.litros) || (r.km / (_config.consumoMedio || DEFAULT_EFFICIENCY))), 0);
  const totalGasto = filtered.reduce((a, r) => a + (r.total || calcTotal(r.km, r.litros, r.precoLitro)), 0);

  // Cards de resumo
  const el = id => $(id);
  if (el('comb-dash-km'))    el('comb-dash-km').textContent    = fmtN(totalKm) + ' km';
  if (el('comb-dash-litros')) el('comb-dash-litros').textContent = fmtN(totalLit, 1) + ' L';
  if (el('comb-dash-gasto')) el('comb-dash-gasto').textContent  = fmt(totalGasto);
  if (el('comb-dash-count')) el('comb-dash-count').textContent  = filtered.length;

  // Custo médio por km
  const custoPorKm = totalKm > 0 ? totalGasto / totalKm : 0;
  if (el('comb-dash-cpkm')) el('comb-dash-cpkm').textContent = `R$ ${fmtN(custoPorKm, 3)}/km`;

  // Lista agrupada por semana/período
  const dashList = $('comb-dash-list'); if (!dashList) return;
  if (!filtered.length) {
    dashList.innerHTML = `<p style="color:var(--muted);font-size:17px;padding:20px 0;">Nenhuma viagem neste período.</p>`;
    return;
  }

  dashList.innerHTML = filtered.map(r => {
    const totalR = r.total || calcTotal(r.km, r.litros, r.precoLitro);
    const litR   = r.litros || (r.km / (_config.consumoMedio || DEFAULT_EFFICIENCY));
    return `
    <div style="display:flex;align-items:center;gap:14px;padding:16px 0;border-bottom:1px solid var(--border);flex-wrap:wrap;">
      <span style="color:var(--muted);font-family:'DM Mono',monospace;font-size:13px;min-width:72px;">${fDate(r.data)}</span>
      <span style="flex:1;font-size:14px;font-weight:600;">${esc(r.origem||'—')} → ${esc(r.destino||'—')}</span>
      <span style="font-size:13px;color:var(--muted);">${fmtN(r.km)} km · ${fmtN(litR,1)} L</span>
      <span style="font-family:'DM Mono',monospace;font-weight:700;color:var(--accent);font-size:15px;">${fmt(totalR)}</span>
    </div>`;
  }).join('');
}

// ─── RENDER: CONFIGURAÇÕES ────────────────────────────────────
function renderConfig() {
  const panel = $('comb-config-panel'); if (!panel) return;
  const canEdit = _userRole === 'master' || _userRole === 'admin' || _userRole === 'owner';

  if (!canEdit) {
    panel.innerHTML = `
      <div style="text-align:center;padding:60px 20px;">
        <div style="font-size:48px;margin-bottom:16px;">🔒</div>
        <div style="font-size:18px;font-weight:700;color:var(--text);margin-bottom:8px;">Acesso Restrito</div>
        <div style="font-size:14px;color:var(--muted);">Apenas administradores podem editar as configurações do módulo.</div>
      </div>`;
    return;
  }

  panel.innerHTML = `
    <div class="glass" style="border-radius:24px;padding:28px;margin-bottom:20px;border:1px solid rgba(255,179,71,.15);">
      <h4 style="font-size:17px;font-weight:800;margin-bottom:6px;">⚙️ Configurações do Módulo</h4>
      <p style="color:var(--muted);font-size:13px;margin-bottom:24px;">Estes valores são usados como padrão para novos registros.</p>

      <div style="display:grid;gap:20px;">
        <div>
          <label style="font-size:11px;font-weight:800;color:var(--muted);text-transform:uppercase;letter-spacing:1px;display:block;margin-bottom:8px;">Preço Padrão do Combustível (R$/L)</label>
          <div style="display:flex;align-items:center;gap:10px;">
            <span style="color:var(--muted);font-size:14px;">R$</span>
            <input id="comb-config-preco" type="number" min="0.01" step="0.01" value="${_config.precoLitro}"
              style="flex:1;padding:14px 16px;border-radius:12px;background:var(--bg2);border:1.5px solid rgba(255,179,71,.3);color:var(--warning);font-family:'DM Mono',monospace;font-size:16px;font-weight:700;outline:none;">
            <span style="color:var(--muted);font-size:14px;">/L</span>
          </div>
        </div>

        <div>
          <label style="font-size:11px;font-weight:800;color:var(--muted);text-transform:uppercase;letter-spacing:1px;display:block;margin-bottom:8px;">Consumo Médio Padrão (km/L)</label>
          <div style="display:flex;align-items:center;gap:10px;">
            <input id="comb-config-consumo" type="number" min="1" step="0.1" value="${_config.consumoMedio}"
              style="flex:1;padding:14px 16px;border-radius:12px;background:var(--bg2);border:1.5px solid var(--border);color:var(--text);font-family:'DM Mono',monospace;font-size:16px;font-weight:700;outline:none;">
            <span style="color:var(--muted);font-size:14px;">km/L</span>
          </div>
          <p style="font-size:12px;color:var(--muted);margin-top:6px;">Usado para estimar litros quando não informado manualmente.</p>
        </div>

        <div>
          <label style="font-size:11px;font-weight:800;color:var(--muted);text-transform:uppercase;letter-spacing:1px;display:block;margin-bottom:8px;">Veículo / Placa</label>
          <input id="comb-config-veiculo" type="text" placeholder="Ex: Fiat Strada · ABC-1234" value="${esc(_config.veiculo || '')}"
            style="width:100%;padding:14px 16px;border-radius:12px;background:var(--bg2);border:1.5px solid var(--border);color:var(--text);font-size:16px;outline:none;box-sizing:border-box;">
        </div>

        <button id="btn-salvar-config-comb" style="width:100%;padding:16px;border-radius:12px;background:linear-gradient(135deg,#ffb347,#ff8c00);color:#000;font-weight:800;font-size:15px;border:none;cursor:pointer;margin-top:4px;">
          💾 Salvar Configurações
        </button>
      </div>
    </div>

    ${_config.updatedAt ? `<p style="font-size:12px;color:var(--muted);text-align:center;">Última atualização: ${new Date(_config.updatedAt).toLocaleString('pt-BR')}</p>` : ''}
  `;

  // Bind salvar config
  addEv('btn-salvar-config-comb', async () => {
    const preco   = parseFloat($('comb-config-preco')?.value)   || DEFAULT_FUEL_PRICE;
    const consumo = parseFloat($('comb-config-consumo')?.value) || DEFAULT_EFFICIENCY;
    const veiculo = $('comb-config-veiculo')?.value?.trim() || 'Veículo Padrão';

    try {
      await setDoc(doc(db, _colConfig, MODULE_CONFIG_DOC), {
        precoLitro:   preco,
        consumoMedio: consumo,
        veiculo,
        updatedAt:    Date.now()
      });
      _config = { precoLitro: preco, consumoMedio: consumo, veiculo, updatedAt: Date.now() };
      _applyConfigToUI();
      toast('✓ Configurações salvas!');
      renderConfig(); // re-render para atualizar timestamp
    } catch (e) {
      toast('Erro ao salvar configurações', true);
      console.error(e);
    }
  });
}

// ─── RENDER PRINCIPAL ─────────────────────────────────────────
function render() {
  if (_tab === 'registrar')   renderRegistros();
  if (_tab === 'dashboard')   renderDash();
  if (_tab === 'config')      renderConfig();
}

// ─── BIND EVENTOS ─────────────────────────────────────────────
function bindEvents() {
  // Abrir modal
  addEv('btn-open-comb-modal', () => openCombModal());

  // Fechar modal
  addEv('comb-modal-close', closeCombModal);
  $('comb-modal-add')?.addEventListener('click', e => {
    if (e.target === $('comb-modal-add')) closeCombModal();
  });

  // Live preview do total
  ['comb-km','comb-litros','comb-preco-custom'].forEach(id => {
    $(id)?.addEventListener('input', updateTotalPreview);
  });

  // Registrar / Atualizar viagem
  addEv('btn-registrar-comb', async () => {
    const km      = parseFloat($('comb-km')?.value) || 0;
    const litros  = parseFloat($('comb-litros')?.value) || 0;
    const origem  = $('comb-origem')?.value?.trim() || '';
    const destino = $('comb-destino')?.value?.trim() || '';
    const data    = $('comb-data')?.value || '';
    const precoC  = parseFloat($('comb-preco-custom')?.value);
    const precoLitro = precoC > 0 ? precoC : _config.precoLitro;

    if (km <= 0) { toast('⚠ Informe a quilometragem', true); return; }
    if (!data)   { toast('⚠ Informe a data', true); return; }

    const total = calcTotal(km, litros, precoLitro);
    const btn   = $('btn-registrar-comb');
    if (btn) btn.disabled = true;

    const payload = {
      km, litros: litros || null, origem, destino, data, precoLitro, total,
      consumoMedio: _config.consumoMedio,
      companyId: _cId || null,
      updatedAt: serverTimestamp()
    };

    try {
      if (btn?._editId) {
        await updateDoc(doc(db, _col, btn._editId), payload);
        toast('✓ Registro atualizado!');
      } else {
        payload.createdAt = serverTimestamp();
        await addDoc(collection(db, _col), payload);
        toast('✓ Viagem registrada!');
      }
      closeCombModal();
    } catch (e) { toast('Erro ao salvar', true); console.error(e); }
    finally { if (btn) btn.disabled = false; }
  });

  // Tabs
  document.querySelectorAll('.comb-tab-btn').forEach(btn => {
    addEv(btn, () => {
      document.querySelectorAll('.comb-tab-btn').forEach(b => {
        b.classList.remove('active');
        b.style.background = 'transparent';
        b.style.color = 'var(--muted)';
        b.style.boxShadow = 'none';
      });
      btn.classList.add('active');
      btn.style.background = 'var(--bg2)';
      btn.style.color = 'var(--text)';
      btn.style.boxShadow = '0 2px 8px rgba(0,0,0,.3)';
      _tab = btn.dataset.combTab;

      $('comb-list-panel').style.display   = _tab === 'registrar'  ? 'block' : 'none';
      $('comb-dash-panel').style.display   = _tab === 'dashboard'  ? 'block' : 'none';
      $('comb-config-panel').style.display = _tab === 'config'     ? 'block' : 'none';

      render();
    });
  });

  // Filtros dashboard
  document.querySelectorAll('.comb-filter-btn').forEach(btn => {
    addEv(btn, () => {
      document.querySelectorAll('.comb-filter-btn').forEach(b => {
        b.classList.remove('active');
        b.style.borderColor = 'var(--border)';
        b.style.background  = 'transparent';
        b.style.color       = 'var(--muted)';
      });
      btn.classList.add('active');
      btn.style.borderColor = 'var(--accent)';
      btn.style.background  = 'rgba(0,212,255,.12)';
      btn.style.color       = 'var(--accent)';
      _filter = btn.dataset.combFilter;
      renderDash();
    });
  });
}

// ─── INICIALIZAÇÃO ────────────────────────────────────────────
async function init(user) {
  _cId       = user.companyId || null;
  _userRole  = user.role || 'tenant';
  _col       = _cId ? `companies/${_cId}/combustivel` : 'combustivel';
  _colConfig = _cId ? `companies/${_cId}/config`      : 'config';

  await loadConfig();
  bindEvents();

  // Listener em tempo real
  onSnapshot(
    query(collection(db, _col), orderBy('createdAt', 'desc')),
    snap => {
      _registros = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      const view = document.getElementById('v-combustivel');
      if (view && view.classList.contains('active')) render();
    },
    err => console.error('[Combustível]', err)
  );
}

// ─── LISTENER — ativado pelo tenant-controller ────────────────
window.addEventListener('lumin:tenant-ready', e => {
  const user = e.detail?.user;
  if (!user) return;
  init(user);
});

// ─── HOOK MutationObserver (render quando view ativa) ─────────
const _observer = new MutationObserver(() => {
  const view = document.getElementById('v-combustivel');
  if (view && view.classList.contains('active')) render();
});
document.addEventListener('DOMContentLoaded', () => {
  const view = document.getElementById('v-combustivel');
  if (view) _observer.observe(view, { attributes: true, attributeFilter: ['class'] });
});

// ─── API PÚBLICA (para o Admin Master consolidar dados) ───────
window.CombustivelModule = {
  getRegistros: () => [..._registros],
  getConfig:    () => ({ ..._config }),
  calcTotal
};
