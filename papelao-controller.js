/**
 * ═══════════════════════════════════════════════════════════════
 *  LUMIN — Papelão Controller
 *  Arquivo: papelao-controller.js
 *
 *  Regras de negócio:
 *  • KG × R$ 0,40 = Total a Pagar (automático)
 *  • Nova pesagem → status "apagar"
 *  • "Dar Baixa" → status "pago" → some de A Pagar
 *  • Dashboard mostra só "pagos", agrupado por mercado
 *  • Filtro por final de semana / mês / todos
 * ═══════════════════════════════════════════════════════════════
 */

import { db } from './firebase-config.js';
import {
  collection, doc, addDoc, updateDoc, deleteDoc,
  onSnapshot, query, orderBy, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const PRICE_KG   = 0.40;
const fmt = v => Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtKg = v => Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const $ = id => document.getElementById(id);
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

/* ─── ESTADO ──────────────────────────────────────────────── */
let _cId = null;            // companyId do tenant
let _col  = null;           // coleção Firestore
let _papelao = [];          // cache local
let _tab  = 'apagar';      // tab activa
let _filter = 'weekend';   // filtro dashboard

/* ─── MODAL PESAGEM ──────────────────────────────────────── */
function openPapModal() {
  const modal = $('pap-modal-add');
  if (!modal) return;
  modal.classList.add('active');
  const dataEl = $('pap-data');
  if (dataEl && !dataEl.value) dataEl.valueAsDate = new Date();
  setTimeout(() => $('pap-mercado')?.focus(), 280);
}
function closePapModal() {
  const modal = $('pap-modal-add');
  if (modal) modal.classList.remove('active');
}

/* ─── RENDER A PAGAR (AGRUPADO POR FORNECEDOR) ───────────── */
function renderAPagar() {
  const list = $('pap-apagar-list'); if (!list) return;
  const items = _papelao.filter(p => p.status === 'apagar');

  if (!items.length) {
    list.innerHTML = `<div style="text-align:center;padding:60px;color:var(--success);font-size:17px;font-weight:700;">✓ Tudo em dia! Sem pendências.</div>`;
    return;
  }

  // Group by supplier (case-insensitive)
  const groups = {};
  items.forEach(p => {
    const key = (p.mercado || 'Aleatório/Avulso').trim().toLowerCase();
    if (!groups[key]) groups[key] = { label: p.mercado || 'Aleatório/Avulso', items: [], totalKg: 0, totalVal: 0 };
    groups[key].items.push(p);
    groups[key].totalKg += Number(p.kg) || 0;
    groups[key].totalVal += Number(p.total) || 0;
  });

  list.innerHTML = Object.values(groups).map(g => `
    <div class="glass ob-item" style="margin-bottom:14px;gap:18px;padding:24px 28px;border-radius:20px;border:1px solid rgba(255,179,71,.15);flex-wrap:wrap;">
      <div style="width:48px;height:48px;border-radius:14px;background:rgba(255,179,71,.1);border:1px solid rgba(255,179,71,.2);display:grid;place-items:center;font-size:24px;flex-shrink:0;">📦</div>
      <div style="flex:1;min-width:0;">
        <div style="font-size:19px;font-weight:700;margin-bottom:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(g.label)}</div>
        <div style="font-size:13px;color:var(--muted);">${g.items.length} pesagem(ns) &nbsp;·&nbsp; ${fmtKg(g.totalKg)} kg &nbsp;·&nbsp; R$ ${PRICE_KG.toFixed(2)}/kg</div>
      </div>
      <div style="font-family:'DM Mono',monospace;font-size:clamp(20px,4vw,28px);font-weight:700;color:var(--warning);flex-shrink:0;margin:0 8px;">${fmt(g.totalVal)}</div>
      <button data-baixar-grupo="${encodeURIComponent(g.label.trim().toLowerCase())}" style="padding:14px 22px;border-radius:12px;min-height:52px;background:rgba(0,229,160,.1);border:1.5px solid rgba(0,229,160,.25);color:var(--success);font-weight:800;font-size:15px;display:flex;align-items:center;gap:8px;cursor:pointer;white-space:nowrap;transition:.2s;">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>
        Dar Baixa
      </button>
    </div>
  `).join('');

  // Dar Baixa — quita todo o grupo
  list.querySelectorAll('[data-baixar-grupo]').forEach(btn => {
    addEv(btn, async () => {
      const grupKey = decodeURIComponent(btn.dataset.baixarGrupo);
      const grupo = _papelao.filter(p => p.status === 'apagar' && (p.mercado||'aleatório/avulso').trim().toLowerCase() === grupKey);
      if (!confirm(`Dar baixa em ${grupo.length} pesagem(ns) do fornecedor "${grupo[0]?.mercado || grupKey}"?`)) return;
      try {
        await Promise.all(grupo.map(p => updateDoc(doc(db, _col, p.id), { status: 'pago', pagoEm: serverTimestamp() })));
        toast('✓ Grupo quitado com sucesso!');
      } catch (e) { toast('Erro ao dar baixa', true); }
    });
  });
}

/* ─── RENDER DASHBOARD PAGOS ──────────────────────────────── */
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

  const totalKg    = pagos.reduce((a, p) => a + (p.kg || 0), 0);
  const totalPago  = pagos.reduce((a, p) => a + (p.total || 0), 0);
  const kgEl = $('pap-dash-kg');     if (kgEl) kgEl.textContent = fmtKg(totalKg) + ' kg';
  const totEl = $('pap-dash-total'); if (totEl) totEl.textContent = fmt(totalPago);
  const cntEl = $('pap-dash-count'); if (cntEl) cntEl.textContent = pagos.length;

  // Agrupa por mercado
  const groups = {};
  pagos.forEach(p => {
    if (!groups[p.mercado]) groups[p.mercado] = { items: [], total: 0, kg: 0 };
    groups[p.mercado].items.push(p);
    groups[p.mercado].total += p.total || 0;
    groups[p.mercado].kg   += p.kg    || 0;
  });

  const dg = $('pap-dash-groups'); if (!dg) return;
  const entries = Object.entries(groups);
  if (!entries.length) {
    dg.innerHTML = `<p style="color:var(--muted);font-size:17px;padding:20px 0;">Nenhum pagamento neste período.</p>`;
    return;
  }

  dg.innerHTML = entries.map(([nome, g]) => `
    <div class="glass" style="border-radius:20px;margin-bottom:14px;overflow:hidden;">
      <div style="padding:22px 28px;display:flex;align-items:center;justify-content:space-between;background:rgba(255,255,255,.03);">
        <div>
          <div style="font-size:20px;font-weight:800;margin-bottom:4px;">${esc(nome)}</div>
          <div style="font-size:14px;color:var(--muted);">${g.items.length} pesagem(ns) &nbsp;·&nbsp; ${fmtKg(g.kg)} kg</div>
        </div>
        <div style="font-family:'DM Mono',monospace;font-size:24px;font-weight:700;color:var(--success);">${fmt(g.total)}</div>
      </div>
      <div style="padding:0 28px 20px;">
        ${g.items.map(p => `
          <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 0;border-bottom:1px solid rgba(255,255,255,.04);font-size:15px;">
            <span style="color:var(--muted);font-family:'DM Mono',monospace;">${p.data || '—'}</span>
            <span>${fmtKg(p.kg)} kg</span>
            <span style="color:var(--success);font-family:'DM Mono',monospace;font-weight:700;">${fmt(p.total)}</span>
          </div>
        `).join('')}
      </div>
    </div>
  `).join('');
}

/* ─── RENDER PRINCIPAL ────────────────────────────────────── */
function render() {
  if (_tab === 'apagar') renderAPagar();
  else renderDash();
  updateAutocomplete();
}

function updateAutocomplete() {
  const dl = $('pap-mercados-list'); if (!dl) return;
  const nomes = [...new Set(_papelao.map(p => p.mercado).filter(Boolean))];
  dl.innerHTML = ['Aleatório/Avulso', ...nomes].map(n => `<option value="${esc(n)}">`).join('');
}

/* ─── BIND EVENTOS ───────────────────────────────────────── */
function bindEvents() {
  // Abrir modal via botão no topo da seção
  addEv('btn-open-pap-modal', () => openPapModal());

  // Fechar modal
  addEv('pap-modal-close', closePapModal);
  $('pap-modal-add')?.addEventListener('click', e => {
    if (e.target === $('pap-modal-add')) closePapModal();
  });

  // KG → calcula total (dentro do modal)
  $('pap-kg')?.addEventListener('input', function () {
    const kg = parseFloat(this.value) || 0;
    const prev = $('pap-total-preview');
    if (prev) prev.textContent = fmt(kg * PRICE_KG);
  });

  // Registrar pesagem
  addEv('btn-registrar-pap', async () => {
    const mercado = ($('pap-mercado')?.value || '').trim() || 'Aleatório/Avulso';
    const kg      = parseFloat($('pap-kg')?.value || 0);
    const data    = $('pap-data')?.value;
    if (!kg || kg <= 0) { toast('⚠ Informe o peso em KG', true); return; }
    if (!data)           { toast('⚠ Informe a data', true); return; }

    const btn = $('btn-registrar-pap'); if (btn) btn.disabled = true;
    try {
      await addDoc(collection(db, _col), {
        mercado, kg, preco: PRICE_KG, total: kg * PRICE_KG,
        data, status: 'apagar', companyId: _cId || null,
        createdAt: serverTimestamp()
      });
      toast('✓ Pesagem registrada!');
      const m = $('pap-mercado'); if (m) m.value = '';
      const k = $('pap-kg');     if (k) k.value = '';
      const p = $('pap-total-preview'); if (p) p.textContent = 'R$ 0,00';
      closePapModal();
    } catch (e) { toast('Erro ao registrar', true); console.error(e); }
    finally { if (btn) btn.disabled = false; }
  });

  // Tabs A Pagar / Dashboard
  document.querySelectorAll('.pap-tab-btn').forEach(btn => {
    addEv(btn, () => {
      document.querySelectorAll('.pap-tab-btn').forEach(b => {
        b.classList.remove('active');
        b.style.background = 'transparent';
        b.style.color = 'var(--muted)';
        b.style.boxShadow = 'none';
      });
      btn.classList.add('active');
      btn.style.background = 'var(--bg2)';
      btn.style.color = 'var(--text)';
      btn.style.boxShadow = '0 2px 8px rgba(0,0,0,.3)';
      _tab = btn.dataset.papTab;
      $('pap-apagar-panel').style.display = _tab === 'apagar'  ? 'block' : 'none';
      $('pap-dash-panel').style.display   = _tab === 'dashboard' ? 'block' : 'none';
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

/* ─── INICIALIZAÇÃO ──────────────────────────────────────── */
function init(user) {
  _cId  = user.companyId || null;
  _col  = _cId ? `companies/${_cId}/papelao` : 'papelao';

  bindEvents();

  // onSnapshot em tempo real
  onSnapshot(
    query(collection(db, _col), orderBy('createdAt', 'desc')),
    snap => {
      _papelao = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      // Só renderiza se a view estiver activa
      const view = document.getElementById('v-papelao');
      if (view && view.classList.contains('active')) render();
    },
    err => console.error('[Papelão]', err)
  );
}

/* ─── LISTENER — activado pelo tenant-controller ─────────── */
window.addEventListener('lumin:tenant-ready', e => {
  const user = e.detail?.user;
  if (!user) return;
  init(user);
});

/* ─── HOOK para o tenant-controller disparar render ────────
   Quando o utilizador clica em "Compra Papelão", o switchV
   do tenant-controller.js activa v-papelao. Observamos a
   classe 'active' para renderizar na altura certa.
──────────────────────────────────────────────────────────── */
const _observer = new MutationObserver(() => {
  const view = document.getElementById('v-papelao');
  if (view && view.classList.contains('active')) render();
});
document.addEventListener('DOMContentLoaded', () => {
  const view = document.getElementById('v-papelao');
  if (view) _observer.observe(view, { attributes: true, attributeFilter: ['class'] });
});
