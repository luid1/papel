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
// Chart.js instances
let _chartDaily   = null;
let _chartDrivers = null;
let _chartClients = null;
// Radar
let _radarFiltro  = 'risco';
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


function renderMotChips() {
  const wrap = $('ll-mot-chips');
  if (!wrap) return;
  // Pega motoristas únicos dos registros (já inclui não-cadastrados)
  const motoristas = [...new Set(_registros.map(r => (r.motorista || '').trim()).filter(Boolean))].sort();
  const motoristaAtivo = (_filtros.motorista || '').trim();

  const chip = (label, value, isActive) => `
    <button data-mot-chip="${esc(value)}" style="
      padding:5px 14px;border-radius:8px;font-size:12px;font-weight:600;letter-spacing:-.005em;cursor:pointer;
      background:${isActive?'rgba(0,212,255,.12)':'rgba(255,255,255,.03)'};
      border:1px solid ${isActive?'var(--accent)':'var(--border)'};
      color:${isActive?'var(--accent)':'var(--muted)'};
      transition:.15s;">${label}</button>`;

  wrap.innerHTML =
    chip('Todos', '', !motoristaAtivo) +
    motoristas.map(m => chip(esc(m), m, motoristaAtivo.toLowerCase() === m.toLowerCase())).join('');

  // Bind clicks
  wrap.querySelectorAll('[data-mot-chip]').forEach(btn => {
    btn.onclick = () => {
      _filtros.motorista = btn.dataset.motChip || '';
      const inp = $('ll-f-motorista');
      if (inp) inp.value = _filtros.motorista;
      renderTabela();
    };
  });
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
// "Em trânsito" = caixas que saíram do CD e ainda NÃO voltaram.
// Para cada motorista:
//   retiradoCD = soma ENTRADAs com cliente "CD/depósito/retirada"
//   devolvidoCD = soma SAÍDAs com cliente "CD/devolução/retorno"
//   emTransito = max(0, retiradoCD - devolvidoCD)
// Por cliente (em pendência):
//   Para cada cliente NÃO-CD, mostra caixas que foram entregues e NÃO foram
//   coletadas de volta (saídas - entradas para esse cliente).
function calcCaixasNoCaminhao() {
  const ehOpCD = (nome) => {
    const n = (nome || '').toUpperCase();
    return /\b(CD|DEPOSITO|DEPÓSITO|RETIRADA|DEVOLU[CÇ][AÃ]O|RETORNO)\b/.test(n) || n === '—';
  };

  const saldo = {};
  _registros.forEach(r => {
    if (!r.motorista) return;
    const mot = r.motorista.trim().toUpperCase();
    const cli = (r.cliente || '—').trim().toUpperCase();
    const cx  = r.quantidadeCx || 0;
    if (!saldo[mot]) saldo[mot] = { total: 0, retiradoCD: 0, devolvidoCD: 0, porCliente: {} };

    if (ehOpCD(cli)) {
      if (r.tipo === 'ENTRADA') saldo[mot].retiradoCD  += cx;
      else                       saldo[mot].devolvidoCD += cx;
    } else {
      if (!saldo[mot].porCliente[cli]) saldo[mot].porCliente[cli] = 0;
      // Por cliente: SAÍDA = entregou (cliente ficou devendo) | ENTRADA = coletou
      if (r.tipo === 'SAÍDA')  saldo[mot].porCliente[cli] += cx;  // entregou
      else                      saldo[mot].porCliente[cli] -= cx;  // coletou de volta
    }
  });

  // Total em trânsito = retiradoCD - devolvidoCD
  Object.values(saldo).forEach(s => {
    s.total = Math.max(0, s.retiradoCD - s.devolvidoCD);
  });
  return saldo;
}

// ─── RENDER KPIs TOPO ─────────────────────────────────────────
function renderKpis() {
  // ── Helpers de data ─────────────────────────────────────────
  const todayD = new Date();
  const todayYmd = `${todayD.getFullYear()}-${String(todayD.getMonth()+1).padStart(2,'0')}-${String(todayD.getDate()).padStart(2,'0')}`;
  const dow = todayD.getDay();
  const mondayD = new Date(todayD.getFullYear(), todayD.getMonth(), todayD.getDate() + ((dow === 0) ? -6 : (1 - dow)));
  const mondayYmd = `${mondayD.getFullYear()}-${String(mondayD.getMonth()+1).padStart(2,'0')}-${String(mondayD.getDate()).padStart(2,'0')}`;
  const sundayD = new Date(mondayD.getFullYear(), mondayD.getMonth(), mondayD.getDate() + 6);
  const sundayYmd = `${sundayD.getFullYear()}-${String(sundayD.getMonth()+1).padStart(2,'0')}-${String(sundayD.getDate()).padStart(2,'0')}`;

  // ── Hoje ────────────────────────────────────────────────────
  const todayRegs = _registros.filter(r => r.data === todayYmd);
  const tEnt = todayRegs.filter(r => r.tipo === 'ENTRADA').reduce((a,r)=>a+(r.quantidadeCx||0),0);
  const tSai = todayRegs.filter(r => r.tipo === 'SAÍDA').reduce((a,r)=>a+(r.quantidadeCx||0),0);
  const tDrivers = new Set(todayRegs.map(r=>r.motorista).filter(Boolean)).size;

  const $ = id => document.getElementById(id);
  $('ll-today-entrada') && ($('ll-today-entrada').textContent = `${tEnt} cx`);
  $('ll-today-saida')   && ($('ll-today-saida').textContent   = `${tSai} cx`);
  $('ll-today-drivers') && ($('ll-today-drivers').textContent = tDrivers);
  $('ll-today-count')   && ($('ll-today-count').textContent   = `${Math.max(0, tEnt - tSai)} cx`);
  const todayDateEl = $('ll-today-date');
  if (todayDateEl) todayDateEl.textContent = todayD.toLocaleDateString('pt-BR', {weekday:'long',day:'2-digit',month:'long'});

  // Resumo agregado de hoje — sem listar cada lançamento individualmente
  const feed = $('ll-today-feed');
  if (feed) {
    if (!todayRegs.length) {
      feed.innerHTML = '<p style="color:var(--muted);font-size:13px;padding:8px 0;letter-spacing:-.005em;">Nenhum lançamento hoje ainda.</p>';
    } else {
      // Agrupa por motorista
      const porMotorista = {};
      todayRegs.forEach(r => {
        const m = (r.motorista || '— sem motorista —').trim().toUpperCase();
        if (!porMotorista[m]) porMotorista[m] = { saiu: 0, voltou: 0, clientes: new Set() };
        const qtd = r.quantidadeCx || 0;
        if (r.tipo === 'ENTRADA') porMotorista[m].saiu += qtd;
        else porMotorista[m].voltou += qtd;
        if (r.cliente) porMotorista[m].clientes.add(r.cliente);
      });

      const totalSaiu   = todayRegs.filter(r => r.tipo === 'ENTRADA').reduce((a, r) => a + (r.quantidadeCx||0), 0);
      const totalVoltou = todayRegs.filter(r => r.tipo === 'SAÍDA').reduce((a, r) => a + (r.quantidadeCx||0), 0);
      const emRota = Math.max(0, totalSaiu - totalVoltou);

      const blocos = Object.entries(porMotorista)
        .sort(([,a],[,b]) => (b.saiu+b.voltou) - (a.saiu+a.voltou))
        .map(([m, v]) => {
          const emRotaM = Math.max(0, v.saiu - v.voltou);
          return `
            <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 0;border-bottom:1px solid var(--border);">
              <div style="min-width:0;flex:1;">
                <div style="font-size:13px;font-weight:600;color:var(--text);letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(m)}</div>
                <div style="font-size:11.5px;color:var(--muted);letter-spacing:-.005em;margin-top:2px;">
                  ${v.clientes.size} cliente${v.clientes.size!==1?'s':''} visitado${v.clientes.size!==1?'s':''}
                </div>
              </div>
              <div style="display:flex;gap:14px;flex-shrink:0;font-size:12px;font-family:'DM Mono',monospace;">
                <span style="color:var(--success);">↑${v.saiu}</span>
                <span style="color:var(--alert);">↓${v.voltou}</span>
                <span style="color:${emRotaM>0?'var(--warning)':'var(--muted)'};min-width:36px;text-align:right;">${emRotaM} rota</span>
              </div>
            </div>`;
        }).join('');

      feed.innerHTML = `
        <div style="display:flex;gap:12px;flex-wrap:wrap;padding:8px 0 14px;border-bottom:1px solid var(--border);margin-bottom:6px;">
          <div style="flex:1;min-width:90px;">
            <div style="font-size:10.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;">Saíram</div>
            <div style="font-family:'DM Mono',monospace;font-size:18px;font-weight:600;color:var(--success);">${totalSaiu} cx</div>
          </div>
          <div style="flex:1;min-width:90px;">
            <div style="font-size:10.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;">Voltaram</div>
            <div style="font-family:'DM Mono',monospace;font-size:18px;font-weight:600;color:var(--alert);">${totalVoltou} cx</div>
          </div>
          <div style="flex:1;min-width:90px;">
            <div style="font-size:10.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;">Em rota</div>
            <div style="font-family:'DM Mono',monospace;font-size:18px;font-weight:600;color:${emRota>0?'var(--warning)':'var(--muted)'};">${emRota} cx</div>
          </div>
        </div>
        ${blocos}`;
      const lastChild = feed.lastElementChild;
      if (lastChild && lastChild.style) lastChild.style.borderBottom = 'none';
    }
  }

  // ── Esta semana ────────────────────────────────────────────
  const weekRegs = _registros.filter(r => (r.data||'') >= mondayYmd && (r.data||'') <= sundayYmd);
  const totEntrada = weekRegs.filter(r => r.tipo === 'ENTRADA').reduce((a, r) => a + (r.quantidadeCx || 0), 0);
  const totSaida   = weekRegs.filter(r => r.tipo === 'SAÍDA').reduce((a, r)   => a + (r.quantidadeCx || 0), 0);
  const totValor   = weekRegs.reduce((a, r) => a + (r.valorTotal || 0), 0);
  const totCount   = weekRegs.length;

  $('ll-total-entrada') && ($('ll-total-entrada').textContent = `${totEntrada} cx`);
  $('ll-total-saida')   && ($('ll-total-saida').textContent   = `${totSaida} cx`);
  $('ll-total-valor')   && ($('ll-total-valor').textContent   = `${Math.max(0, totEntrada - totSaida)} cx`);
  $('ll-total-count')   && ($('ll-total-count').textContent   = totCount);
  const wkLbl = $('ll-week-date');
  if (wkLbl) {
    const fmt2 = d => `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}`;
    wkLbl.textContent = `${fmt2(mondayD)} a ${fmt2(sundayD)}`;
  }

  // ── Painel: caixas no caminhão por motorista ───────────────────
  const saldoMot = calcCaixasNoCaminhao();
  const motPanel  = $('ll-motoristas-panel');
  if (motPanel) {
    const motoristas = Object.entries(saldoMot).filter(([, v]) => v.total > 0);
    if (!motoristas.length) {
      motPanel.innerHTML = `<div style="color:var(--muted);font-size:13px;padding:12px 0;">Nenhuma caixa em trânsito no momento.</div>`;
    } else {
      motPanel.innerHTML = motoristas.map(([mot, v]) => {
        // Clientes que receberam caixas e ainda não devolveram (entregou - coletou > 0)
        const clientesPendentes = Object.entries(v.porCliente)
          .filter(([, cx]) => cx > 0)
          .sort((a, b) => b[1] - a[1]);
        const totalEmClientes = clientesPendentes.reduce((a, [,cx]) => a + cx, 0);
        const noCaminhao = Math.max(0, v.total - totalEmClientes);

        const clientesHtml = clientesPendentes.map(([cli, cx]) =>
          `<div style="display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.04);font-size:13px;">
            <span style="color:var(--muted);">${esc(cli)}</span>
            <span style="font-family:'DM Mono',monospace;font-weight:700;color:var(--text);">${cx} cx</span>
          </div>`
        ).join('');

        return `
          <div style="background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:16px 20px;min-width:220px;flex:1;">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
              <div style="font-size:14px;font-weight:800;">🚚 ${esc(mot)}</div>
              <div style="font-family:'DM Mono',monospace;font-size:20px;font-weight:900;color:var(--warning);">${v.total} <span style="font-size:12px;font-weight:600;color:var(--muted);">cx</span></div>
            </div>
            <div style="display:flex;gap:8px;font-size:11px;color:var(--muted);margin-bottom:10px;flex-wrap:wrap;">
              <span>Retirou CD: <b style="color:var(--text);">${v.retiradoCD}</b></span>
              <span>Devolveu: <b style="color:var(--text);">${v.devolvidoCD}</b></span>
              ${noCaminhao > 0 ? `<span>No caminhão: <b style="color:var(--accent);">${noCaminhao}</b></span>` : ''}
            </div>
            ${clientesHtml ? `<div style="font-size:10.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px;">Em clientes</div>${clientesHtml}` : '<div style="font-size:12px;color:var(--muted);">Sem pendência em clientes</div>'}
          </div>`;
      }).join('');
    }
  }

  // Atualiza dashboard se estiver visível
  const dashPanel = document.getElementById('llm-panel-dashboard');
  if (dashPanel && dashPanel.style.display !== 'none') {
    if (typeof window.llRenderCharts === 'function') window.llRenderCharts();
    _renderRadar();
  }
}

// ─── RENDER CARDS ──────────────────────────────────────────────
function renderTabela() {
  const tbody = $('ll-tbody'); if (!tbody) return;
  const dados = aplicarFiltros();

  // KPIs sempre no topo
  renderKpis();
  renderMotChips();

  // ── Totalizadores filtrados ────────────────────────────────────
  const filtEntrada = dados.filter(r => r.tipo === 'ENTRADA').reduce((a, r) => a + (r.quantidadeCx || 0), 0);
  const filtSaida   = dados.filter(r => r.tipo === 'SAÍDA').reduce((a, r)   => a + (r.quantidadeCx || 0), 0);
  const filtValor   = dados.reduce((a, r) => a + (r.valorTotal || 0), 0);
  const el_fe = $('ll-filt-entrada'); if (el_fe) el_fe.textContent = `${filtEntrada} cx`;
  const el_fs = $('ll-filt-saida');   if (el_fs) el_fs.textContent = `${filtSaida} cx`;
  const el_fv = $('ll-filt-valor');   if (el_fv) el_fv.textContent = `${Math.max(0, filtEntrada - filtSaida)} cx`;
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
        background: rgba(255,255,255,.03);
        border: 1px solid rgba(255,255,255,.07);
        border-radius: 13px;
        display: flex;
        flex-direction: column;
        transition: border-color .18s, box-shadow .18s;
        position: relative;
        overflow: hidden;
      }
      .ll-card:hover { border-color: rgba(255,255,255,.13); box-shadow: 0 2px 16px rgba(0,0,0,.15); }
      .ll-card.is-revisar { border-color: rgba(255,179,71,.18); background: rgba(255,179,71,.02); }
      .ll-card-stripe { position:absolute; left:0; top:0; bottom:0; width:3px; }
      .ll-card.is-entrada .ll-card-stripe { background: var(--success); }
      .ll-card.is-saida   .ll-card-stripe { background: var(--alert); }
      .ll-card.is-revisar .ll-card-stripe { background: var(--warning); }
      /* ── Corpo ── */
      .ll-card-body { padding: 11px 14px 10px 18px; display:flex; flex-direction:column; gap:5px; }
      .ll-r1 { display:flex; align-items:center; gap:7px; min-width:0; }
      .ll-r2 { display:flex; align-items:center; gap:0; flex-wrap:wrap; padding-left:1px; }
      .ll-tipo-badge {
        font-size:10px; font-weight:800; padding:2px 9px; border-radius:5px;
        white-space:nowrap; flex-shrink:0; letter-spacing:.4px;
      }
      .ll-nome { font-size:14px; font-weight:700; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; margin:0 6px; }
      .ll-data { font-family:'DM Mono',monospace; font-size:11px; color:rgba(228,240,246,.38); white-space:nowrap; flex-shrink:0; }
      .ll-chip { font-size:11px; font-weight:600; color:rgba(228,240,246,.45); padding:0 7px 0 0; white-space:nowrap; }
      .ll-chip-val { font-family:'DM Mono',monospace; font-weight:800; color:var(--text); }
      .ll-chip-sep { display:inline-block; width:1px; height:10px; background:rgba(255,255,255,.09); margin:0 6px 0 0; vertical-align:middle; flex-shrink:0; }
      /* ── Rodapé ── */
      .ll-card-footer {
        display:flex; align-items:center; justify-content:space-between; gap:10px;
        padding: 8px 14px 10px 18px;
        border-top: 1px solid rgba(255,255,255,.05);
        background: rgba(255,255,255,.01);
      }
      .ll-valor { font-family:'DM Mono',monospace; font-size:15px; font-weight:800; letter-spacing:-.3px; }
      .ll-btns { display:flex; gap:5px; }
      .ll-btns button {
        padding:5px 12px; border-radius:7px; font-size:11px; font-weight:700;
        cursor:pointer; transition:.15s; border-width:1px; border-style:solid;
        display:inline-flex; align-items:center; gap:4px;
      }
      .ll-btns button:hover { opacity:.8; transform:scale(.97); }
      /* Painel trânsito */
      #ll-motoristas-panel { display:flex; gap:10px; flex-wrap:wrap; }
      /* Filtros colapsáveis */
      #ll-filtros-body { overflow:hidden; transition: max-height .3s ease, opacity .3s ease; }
      #ll-filtros-body.collapsed { max-height:0!important; opacity:0; pointer-events:none; }
      #ll-filtros-body.expanded  { opacity:1; }
      #ll-tbody { display:flex; flex-direction:column; gap:6px; padding:4px 0; }
    `;
    document.head.appendChild(style);
  }

  // ── Se NENHUM motorista filtrado: mostra RESUMO agrupado por motorista
  // (estilo "Atividade de hoje"). Se um motorista estiver filtrado,
  // mostra lista detalhada dos lançamentos desse motorista.
  if (!(_filtros.motorista || '').trim()) {
    const porMotorista = {};
    dados.forEach(r => {
      const m = (r.motorista || '— sem motorista —').trim().toUpperCase();
      if (!porMotorista[m]) porMotorista[m] = { saiu: 0, voltou: 0, clientes: new Set(), count: 0, datas: new Set() };
      const qtd = r.quantidadeCx || 0;
      if (r.tipo === 'ENTRADA') porMotorista[m].saiu += qtd;
      else porMotorista[m].voltou += qtd;
      if (r.cliente) porMotorista[m].clientes.add(r.cliente);
      if (r.data) porMotorista[m].datas.add(r.data);
      porMotorista[m].count++;
    });

    tbody.innerHTML = Object.entries(porMotorista)
      .sort(([,a],[,b]) => (b.saiu+b.voltou) - (a.saiu+a.voltou))
      .map(([m, v]) => {
        const emRota = Math.max(0, v.saiu - v.voltou);
        return `
          <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 12px;border-bottom:1px solid var(--border);cursor:pointer;transition:background .15s;"
            onmouseover="this.style.background='rgba(255,255,255,.02)'"
            onmouseout="this.style.background=''"
            onclick="(function(btn){btn.click();})(document.querySelector('[data-mot-chip=&quot;${esc(m)}&quot;]'))">
            <div style="min-width:0;flex:1;">
              <div style="font-size:13.5px;font-weight:600;color:var(--text);letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(m)}</div>
              <div style="font-size:11.5px;color:var(--muted);letter-spacing:-.005em;margin-top:3px;">
                ${v.clientes.size} cliente${v.clientes.size!==1?'s':''} · ${v.count} lançamento${v.count!==1?'s':''} · ${v.datas.size} dia${v.datas.size!==1?'s':''}
              </div>
            </div>
            <div style="display:flex;gap:14px;flex-shrink:0;font-family:'DM Mono',monospace;font-size:13px;align-items:center;">
              <span style="color:var(--success);">↑${v.saiu}</span>
              <span style="color:var(--alert);">↓${v.voltou}</span>
              <span style="color:${emRota>0?'var(--warning)':'var(--muted)'};min-width:42px;text-align:right;font-weight:600;">${emRota} rota</span>
              <span style="color:var(--muted);">›</span>
            </div>
          </div>`;
      }).join('');
    return;
  }

  // ── Lista detalhada (motorista específico filtrado) ─────────────
  // Para ENTRADA: mostra fornecedor (de onde veio) + motorista
  // Para SAÍDA: mostra CLIENTE (para quem foi entregue) + caixas ainda
  //             com esse motorista no caminhão
  const saldoMot = calcCaixasNoCaminhao();

  tbody.innerHTML = dados.map(r => {
    const isEntrada  = r.tipo === 'ENTRADA';
    const isRevisar  = r.status === 'REVISAR';
    const tipoColor  = isEntrada ? 'var(--success)' : 'var(--alert)';
    const tipoBg     = isEntrada ? 'rgba(0,229,160,.12)' : 'rgba(255,91,112,.12)';
    const tipoBorder = isEntrada ? 'rgba(0,229,160,.28)'  : 'rgba(255,91,112,.28)';
    const tipoIcon   = isEntrada ? '▲' : '▼';

    const corIcon = (r.cor||'').toLowerCase().includes('pret') ? '⬛'
                  : (r.cor||'').toLowerCase().includes('branc') ? '⬜' : '🔲';

    // Nome principal do card
    const nomePrincipal = r.cliente || '—';

    // Caixas em rota (inline no r2, só para SAÍDA)
    let extraCxHtml = '';
    if (!isEntrada && r.motorista) {
      const mot = r.motorista.trim().toUpperCase();
      const saldo = saldoMot[mot];
      const cxR = saldo ? Math.max(0, saldo.total) : 0;
      extraCxHtml = cxR > 0
        ? `<span class="ll-chip-sep"></span><span class="ll-chip" style="color:var(--warning);">🚚 ${cxR} cx em rota</span>`
        : `<span class="ll-chip-sep"></span><span class="ll-chip" style="color:var(--success);">✓ Zerado</span>`;
    }

    // Linha 2: motorista + cor + qtd + extras
    const r2Parts = [];
    if (r.motorista) r2Parts.push(`<span class="ll-chip">🚚 ${esc(r.motorista)}</span><span class="ll-chip-sep"></span>`);
    r2Parts.push(`<span class="ll-chip">${corIcon} ${esc(r.cor||'—')}</span>`);
    r2Parts.push(`<span class="ll-chip-sep"></span>`);
    r2Parts.push(`<span class="ll-chip ll-chip-val">${r.quantidadeCx ?? '—'} cx</span>`);
    if (isRevisar) r2Parts.push(`<span class="ll-chip-sep"></span><span class="ll-chip" style="color:var(--warning);">⚠ Revisar</span>`);
    r2Parts.push(extraCxHtml);

    // Layout linha única — visual limpo, similar ao tenant
    return `
      <div class="ll-row ${isEntrada ? 'is-entrada' : 'is-saida'} ${isRevisar ? 'is-revisar' : ''}" data-ll-id="${r.id}"
        style="display:flex;align-items:center;gap:12px;padding:11px 12px;border-bottom:1px solid var(--border);border-left:3px solid ${tipoColor};background:rgba(255,255,255,.02);transition:background .15s;">
        <div style="display:flex;flex-direction:column;min-width:64px;flex-shrink:0;">
          <span style="font-size:9.5px;font-weight:700;letter-spacing:.4px;color:${tipoColor};text-transform:uppercase;">${tipoIcon} ${esc(r.tipo)}</span>
          <span style="font-family:'DM Mono',monospace;font-size:11px;color:var(--muted);margin-top:2px;">${fmtDt(r.data)}</span>
        </div>
        <div style="min-width:0;flex:1;">
          <div style="font-size:13.5px;font-weight:600;color:var(--text);letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(nomePrincipal)}</div>
          <div style="font-size:11.5px;color:var(--muted);letter-spacing:-.005em;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
            ${r.motorista ? esc(r.motorista) + ' · ' : ''}${corIcon} ${esc(r.cor||'—')}${isRevisar ? ' · <span style="color:var(--warning);">⚠ Revisar</span>' : ''}
          </div>
        </div>
        <div style="font-family:'DM Mono',monospace;font-size:14px;font-weight:600;color:${tipoColor};flex-shrink:0;min-width:50px;text-align:right;">
          ${r.quantidadeCx ?? '—'}<span style="font-size:10px;color:var(--muted);margin-left:2px;">cx</span>
        </div>
        <div style="display:flex;gap:4px;flex-shrink:0;">
          <button data-ll-action="edit" data-ll-id="${r.id}" title="Editar"
            style="width:28px;height:28px;border-radius:7px;background:transparent;border:1px solid var(--border);color:var(--muted);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;font-size:12px;">✎</button>
          <button data-ll-action="del" data-ll-id="${r.id}" title="Excluir"
            style="width:28px;height:28px;border-radius:7px;background:transparent;border:1px solid var(--border);color:var(--muted);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;font-size:12px;">🗑</button>
        </div>
      </div>`;
  }).join('');
}

// ─── TOGGLE FILTROS COLAPSÁVEL ─────────────────────────────────
// ─── RADAR DE SUSPEITAS ────────────────────────────────────────
window.llSetRadarFiltro = function(filtro) {
  _radarFiltro = filtro;
  ['risco','saldo','taxa','semfoto'].forEach(f => {
    const btn = document.getElementById(`ll-radar-f-${f}`);
    if (btn) btn.classList.toggle('active', f === filtro);
  });
  _renderRadar();
};

function _renderRadar() {
  const el = document.getElementById('ll-radar-list');
  if (!el) return;

  // ── Computa stats por motorista a partir dos registros ─────────
  const stats = {};
  _registros.forEach(r => {
    if (!r.motorista) return;
    const m = r.motorista.trim().toUpperCase();
    if (!stats[m]) stats[m] = { nome: m, carregou: 0, entregou: 0, ultimaData: '0000-00-00', saidasTotal: 0 };
    if (r.tipo === 'ENTRADA') {
      stats[m].carregou += (r.quantidadeCx || 0);
    } else {
      stats[m].entregou  += (r.quantidadeCx || 0);
      stats[m].saidasTotal++;
    }
    if (r.data && r.data > stats[m].ultimaData) stats[m].ultimaData = r.data;
  });

  if (!Object.keys(stats).length) {
    el.innerHTML = `<div style="color:var(--muted);font-size:13px;text-align:center;padding:24px 0;">Nenhum motorista com registros ainda.</div>`;
    return;
  }

  // ── Pega eventos com foto expostos pelo motoristas-controller ──
  const eventos = Array.isArray(window._llmEventsList) ? window._llmEventsList : [];

  Object.values(stats).forEach(s => {
    s.saldo = Math.max(0, s.carregou - s.entregou);
    s.taxa  = s.carregou > 0 ? Math.round((s.entregou / s.carregou) * 100) : 0;

    // Fotos: conta eventos com foto para este motorista
    const evMotorista = eventos.filter(ev =>
      (ev.driverName || '').trim().toUpperCase() === s.nome
    );
    s.fotosCount = evMotorista.length;
    s.taxaFoto   = s.saidasTotal > 0
      ? Math.round((s.fotosCount / s.saidasTotal) * 100)
      : null; // null = sem dados suficientes

    // ── Score de risco (0-10 pts) ──────────────────────────────
    let pts = 0;
    // Saldo alto em rota
    if      (s.saldo > 50)  pts += 4;
    else if (s.saldo > 25)  pts += 2;
    else if (s.saldo > 10)  pts += 1;
    // Taxa de entrega baixa
    if (s.carregou >= 15) {
      if      (s.taxa < 40) pts += 4;
      else if (s.taxa < 65) pts += 2;
      else if (s.taxa < 80) pts += 1;
    }
    // Sem foto nas entregas
    if (s.saidasTotal >= 3) {
      if      (s.taxaFoto < 20) pts += 3;
      else if (s.taxaFoto < 50) pts += 1;
    }

    s.pontos = pts;
    s.risco  = pts >= 6 ? 'alto' : pts >= 3 ? 'medio' : 'baixo';
  });

  let drivers = Object.values(stats);

  // ── Ordenação por filtro ────────────────────────────────────
  if (_radarFiltro === 'risco') {
    drivers.sort((a, b) => b.pontos - a.pontos || b.saldo - a.saldo);
  } else if (_radarFiltro === 'saldo') {
    drivers.sort((a, b) => b.saldo - a.saldo);
  } else if (_radarFiltro === 'taxa') {
    drivers.sort((a, b) => a.taxa - b.taxa || b.saldo - a.saldo);
  } else if (_radarFiltro === 'semfoto') {
    drivers.sort((a, b) => {
      const fa = a.taxaFoto ?? 101;
      const fb = b.taxaFoto ?? 101;
      return fa - fb || b.saldo - a.saldo;
    });
  }

  // ── Render ──────────────────────────────────────────────────
  el.innerHTML = drivers.map(s => {
    const isAlto = s.risco === 'alto';
    const isMed  = s.risco === 'medio';
    const cor    = isAlto ? 'rgba(255,91,112,1)'   : isMed ? 'rgba(255,179,71,1)'  : 'rgba(0,229,160,1)';
    const bg     = isAlto ? 'rgba(255,91,112,.06)'  : isMed ? 'rgba(255,179,71,.05)' : 'rgba(0,229,160,.04)';
    const bdr    = isAlto ? 'rgba(255,91,112,.18)'  : isMed ? 'rgba(255,179,71,.18)' : 'rgba(0,229,160,.12)';
    const icon   = isAlto ? '🔴' : isMed ? '🟡' : '🟢';
    const label  = isAlto ? 'SUSPEITO' : isMed ? 'ATENÇÃO' : 'NORMAL';

    const taxaBarW = Math.min(100, Math.max(0, s.taxa));
    const taxaCor  = s.taxa >= 80 ? 'var(--success)' : s.taxa >= 50 ? 'var(--warning)' : 'var(--alert)';
    const fotoBarW = s.taxaFoto != null ? Math.min(100, Math.max(0, s.taxaFoto)) : 0;
    const fotoCor  = s.taxaFoto == null ? 'var(--muted)'
                   : s.taxaFoto >= 70 ? 'var(--success)'
                   : s.taxaFoto >= 35 ? 'var(--warning)' : 'var(--alert)';
    const fotoLabel = s.taxaFoto == null ? '— sem dados' : `${s.taxaFoto}% (${s.fotosCount}/${s.saidasTotal} entregas)`;

    // Alertas textuais
    const alertas = [];
    if (s.saldo > 25) alertas.push(`📦 ${s.saldo} caixas em rota sem retorno`);
    if (s.taxa < 60 && s.carregou >= 15) alertas.push(`📉 Entrega menos do que carrega (${s.taxa}%)`);
    if (s.taxaFoto != null && s.taxaFoto < 30 && s.saidasTotal >= 3) alertas.push(`📷 Raramente tira foto nas entregas`);

    // Linha compacta — sem dashboards visuais redundantes
    const alertaTxt = alertas.length
      ? alertas.join(' · ')
      : `${s.taxa}% entrega · ${s.taxaFoto != null ? s.taxaFoto + '% fotos' : 'sem fotos'}`;

    return `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;border-bottom:1px solid var(--border);">
        <div style="display:flex;align-items:center;gap:10px;min-width:0;flex:1;">
          <span style="font-size:13px;line-height:1;flex-shrink:0;">${icon}</span>
          <div style="min-width:0;flex:1;">
            <div style="font-size:13px;font-weight:600;color:var(--text);letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(s.nome)}</div>
            <div style="font-size:11px;color:${alertas.length ? cor : 'var(--muted)'};letter-spacing:-.005em;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${alertaTxt}</div>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:12px;flex-shrink:0;">
          <div style="text-align:right;">
            <div style="font-size:11px;color:var(--muted);letter-spacing:-.005em;">em rota</div>
            <div style="font-family:'DM Mono',monospace;font-size:14px;font-weight:600;color:${cor};">${s.saldo}</div>
          </div>
        </div>
      </div>`;
  }).join('');
}

// ─── GRÁFICOS (Chart.js) ───────────────────────────────────────
window.llRenderCharts = function() {
  _renderChartDaily();
  _renderChartDrivers();
  _renderChartClients();
};

function _renderChartDaily() {
  const canvas = document.getElementById('ll-chart-daily');
  if (!canvas) return;

  // Últimos 14 dias
  const days = [];
  const today = new Date();
  for (let i = 13; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    days.push(d.toISOString().split('T')[0]);
  }

  const entrada = days.map(day =>
    _registros.filter(r => r.data === day && r.tipo === 'ENTRADA')
              .reduce((a, r) => a + (r.quantidadeCx || 0), 0)
  );
  const saida = days.map(day =>
    _registros.filter(r => r.data === day && r.tipo === 'SAÍDA')
              .reduce((a, r) => a + (r.quantidadeCx || 0), 0)
  );
  const labels = days.map(d => d.slice(5).split('-').reverse().join('/'));

  if (_chartDaily) { _chartDaily.destroy(); _chartDaily = null; }
  _chartDaily = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Entradas',
          data: entrada,
          backgroundColor: 'rgba(0,229,160,.55)',
          borderColor: 'rgba(0,229,160,.9)',
          borderWidth: 1,
          borderRadius: 4,
        },
        {
          label: 'Saídas',
          data: saida,
          backgroundColor: 'rgba(255,91,112,.55)',
          borderColor: 'rgba(255,91,112,.9)',
          borderWidth: 1,
          borderRadius: 4,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: 'rgba(228,240,246,.65)', font: { size: 11 } } },
      },
      scales: {
        x: {
          grid: { color: 'rgba(255,255,255,.05)' },
          ticks: { color: 'rgba(228,240,246,.45)', font: { size: 9 } },
        },
        y: {
          grid: { color: 'rgba(255,255,255,.05)' },
          ticks: { color: 'rgba(228,240,246,.45)', font: { size: 9 } },
          beginAtZero: true,
        },
      },
    },
  });
}

function _renderChartDrivers() {
  const wrap   = document.getElementById('ll-chart-drivers-wrap');
  const canvas = document.getElementById('ll-chart-drivers');
  if (!canvas || !wrap) return;

  const saldo = calcCaixasNoCaminhao();
  const motoristas = Object.entries(saldo)
    .filter(([, v]) => v.total > 0)
    .sort((a, b) => b[1].total - a[1].total);

  if (!motoristas.length) {
    wrap.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:rgba(228,240,246,.35);font-size:12px;">Nenhuma caixa em trânsito</div>`;
    return;
  }

  // Garantir que o canvas existe (pode ter sido substituído pelo innerHTML acima)
  let c = document.getElementById('ll-chart-drivers');
  if (!c) {
    wrap.innerHTML = `<canvas id="ll-chart-drivers" style="width:100%;height:100%;"></canvas>`;
    c = document.getElementById('ll-chart-drivers');
  }

  const palette = [
    'rgba(0,212,255,.7)',
    'rgba(0,229,160,.7)',
    'rgba(255,179,71,.7)',
    'rgba(167,139,250,.7)',
    'rgba(255,91,112,.7)',
    'rgba(251,146,60,.7)',
  ];

  if (_chartDrivers) { _chartDrivers.destroy(); _chartDrivers = null; }
  _chartDrivers = new Chart(c, {
    type: 'doughnut',
    data: {
      labels: motoristas.map(([name]) => name),
      datasets: [{
        data: motoristas.map(([, v]) => v.total),
        backgroundColor: motoristas.map((_, i) => palette[i % palette.length]),
        borderWidth: 0,
        hoverOffset: 6,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '62%',
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            color: 'rgba(228,240,246,.65)',
            font: { size: 10 },
            padding: 8,
            boxWidth: 10,
          },
        },
      },
    },
  });
}

function _renderChartClients() {
  const wrap   = document.getElementById('ll-chart-clients-wrap');
  const canvas = document.getElementById('ll-chart-clients');
  if (!canvas || !wrap) return;

  // Saldo por cliente: ENTRADA = caixas entregues (positivo = caixas que foram para o cliente)
  // SAÍDA = caixas que voltaram do cliente
  const totals = {};
  _registros.forEach(r => {
    if (!r.cliente) return;
    if (!totals[r.cliente]) totals[r.cliente] = 0;
    totals[r.cliente] += r.tipo === 'ENTRADA'
      ? (r.quantidadeCx || 0)
      : -(r.quantidadeCx || 0);
  });

  const sorted = Object.entries(totals)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, 7);

  if (!sorted.length) {
    wrap.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:rgba(228,240,246,.35);font-size:12px;">Sem dados de clientes</div>`;
    return;
  }

  let c = document.getElementById('ll-chart-clients');
  if (!c) {
    wrap.innerHTML = `<canvas id="ll-chart-clients" style="width:100%;height:100%;"></canvas>`;
    c = document.getElementById('ll-chart-clients');
  }

  if (_chartClients) { _chartClients.destroy(); _chartClients = null; }
  _chartClients = new Chart(c, {
    type: 'bar',
    data: {
      labels: sorted.map(([name]) => name.length > 16 ? name.slice(0, 14) + '…' : name),
      datasets: [{
        label: 'Saldo (cx)',
        data: sorted.map(([, v]) => v),
        backgroundColor: sorted.map(([, v]) => v > 0
          ? 'rgba(255,179,71,.6)'
          : 'rgba(0,229,160,.6)'
        ),
        borderRadius: 4,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: 'y',
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => `${ctx.parsed.x > 0 ? '+' : ''}${ctx.parsed.x} cx`,
          },
        },
      },
      scales: {
        x: {
          grid: { color: 'rgba(255,255,255,.05)' },
          ticks: { color: 'rgba(228,240,246,.45)', font: { size: 9 } },
          beginAtZero: true,
        },
        y: {
          grid: { display: false },
          ticks: { color: 'rgba(228,240,246,.65)', font: { size: 9 } },
        },
      },
    },
  });
}

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

// ─── EXPORTAR EXCEL — RELATÓRIO COMPLETO ─────────────────────
async function exportarExcel() {
  if (typeof ExcelJS === 'undefined') {
    toast('⏳ Carregando biblioteca Excel...', true);
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js';
      s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    }).catch(() => { toast('❌ Falha ao carregar ExcelJS.', true); return; });
    if (typeof ExcelJS === 'undefined') return;
  }

  if (!_dadosCarregados) {
    toast('⏳ Aguardando dados...', true);
    let t = 0;
    await new Promise(r => {
      const c = setInterval(() => { t++; if (_dadosCarregados || t >= 50) { clearInterval(c); r(); }}, 100);
    });
  }

  const dados = temFiltroAtivo() ? aplicarFiltros() : [..._registros];
  if (!dados.length) { toast('⚠ Nenhum dado encontrado.', true); return; }

  toast('⏳ Gerando relatório...', true);

  // ── PALETA DE CORES ──────────────────────────────────────────
  const C = {
    navyDark  : 'FF1F3864',  // cabeçalho principal (azul marinho)
    navyMid   : 'FF243F60',  // sub-cabeçalho
    navyLight : 'FF2E75B6',  // ENTRADA
    red       : 'FFC00000',  // SAÍDA
    redLight  : 'FFFCE4D6',  // linha SAÍDA (fill suave)
    blueLight : 'FFD9E1F2',  // linha ENTRADA (fill suave)
    blueAlt   : 'FFEEF2FA',  // linha alternada
    green     : 'FF375623',  // positivo
    greenBg   : 'FFE2EFDA',  // fundo positivo
    amber     : 'FFBF8F00',  // alerta
    amberBg   : 'FFFFF2CC',  // fundo alerta
    white     : 'FFFFFFFF',
    gray1     : 'FFF2F2F2',
    gray2     : 'FFD9D9D9',
    textDark  : 'FF1A1A2E',
  };

  const fmtBRL  = '"R$" #,##0.00';
  const fmtDate = 'dd/mm/yyyy';
  const fmtPct  = '0.0"%"';
  const mid = { horizontal:'center', vertical:'middle' };
  const midL= { horizontal:'left',   vertical:'middle' };
  const midR= { horizontal:'right',  vertical:'middle' };

  function fill(argb) { return { type:'pattern', pattern:'solid', fgColor:{ argb } }; }
  function font(opts) { return { name:'Calibri', size:11, ...opts }; }
  function border(style='thin') {
    const s = { style };
    return { top:s, left:s, bottom:s, right:s };
  }
  function hdrCell(ws, addr, val, bgArgb=C.navyDark, fSize=11) {
    const c = ws.getCell(addr);
    c.value = val;
    c.font  = font({ bold:true, color:{ argb:C.white }, size:fSize });
    c.fill  = fill(bgArgb);
    c.alignment = mid;
    c.border = border();
    return c;
  }
  function dataCell(ws, addr, val, opts={}) {
    const c = ws.getCell(addr);
    c.value = val;
    if (opts.numFmt)    c.numFmt    = opts.numFmt;
    if (opts.fill)      c.fill      = fill(opts.fill);
    if (opts.font)      c.font      = font(opts.font);
    if (opts.align)     c.alignment = opts.align;
    else                c.alignment = midL;
    c.border = border();
    return c;
  }

  // ── PRÉ-PROCESSAMENTO DOS DADOS ──────────────────────────────
  // Agrupa por semana (Seg-Dom), motorista e cliente
  const nn = v => Math.max(0, Number(v)||0);

  // Dias da semana dos dados
  const porDia = {};   // 'YYYY-MM-DD' → { ent_cx, sai_cx, ent_val, sai_val }
  const porMotorista = {}; // nome → { ent_cx, sai_cx, ent_val, sai_val, clientes:Set }
  const porCliente   = {}; // nome → { ent_cx, sai_cx, ent_val, sai_val, motoristas:Set }

  dados.forEach(r => {
    const cliente   = r.cliente   || r.remetente || 'Não identificado';
    const motorista = r.motorista || r.conferente || '—';
    const cor       = (r.cor || '').toUpperCase();
    const isEnt     = (r.tipo || '').toUpperCase().includes('ENTRADA');
    const cx        = nn(r.quantidadeCx);
    const unitario  = cor === 'PRETA' ? 20 : cor === 'BRANCA' ? 28 : 0;
    const val       = cx * unitario;
    const data      = r.data || '';

    // Por dia
    if (!porDia[data]) porDia[data] = { ent_cx:0, sai_cx:0, ent_val:0, sai_val:0 };
    if (isEnt) { porDia[data].ent_cx += cx; porDia[data].ent_val += val; }
    else       { porDia[data].sai_cx += cx; porDia[data].sai_val += val; }

    // Por motorista
    if (!porMotorista[motorista]) porMotorista[motorista] = { ent_cx:0, sai_cx:0, ent_val:0, sai_val:0, clientes:new Set() };
    if (isEnt) { porMotorista[motorista].ent_cx += cx; porMotorista[motorista].ent_val += val; }
    else       { porMotorista[motorista].sai_cx += cx; porMotorista[motorista].sai_val += val; }
    porMotorista[motorista].clientes.add(cliente);

    // Por cliente
    if (!porCliente[cliente]) porCliente[cliente] = { ent_cx:0, sai_cx:0, ent_val:0, sai_val:0, motoristas:new Set() };
    if (isEnt) { porCliente[cliente].ent_cx += cx; porCliente[cliente].ent_val += val; }
    else       { porCliente[cliente].sai_cx += cx; porCliente[cliente].sai_val += val; }
    porCliente[cliente].motoristas.add(motorista);
  });

  // Semanas: agrupar dias por semana ISO
  function isoWeek(dateStr) {
    if (!dateStr) return 'sem-data';
    const d = new Date(dateStr + 'T00:00:00');
    const dow = (d.getDay() + 6) % 7; // 0=seg
    const monday = new Date(d); monday.setDate(d.getDate() - dow);
    return monday.toISOString().split('T')[0];
  }
  const porSemana = {}; // 'YYYY-MM-DD' (segunda) → { dias:[], totais }
  Object.entries(porDia).forEach(([data, v]) => {
    const seg = isoWeek(data);
    if (!porSemana[seg]) porSemana[seg] = { dias:[], ent_cx:0, sai_cx:0, ent_val:0, sai_val:0 };
    porSemana[seg].dias.push({ data, ...v });
    porSemana[seg].ent_cx  += v.ent_cx;  porSemana[seg].sai_cx  += v.sai_cx;
    porSemana[seg].ent_val += v.ent_val; porSemana[seg].sai_val += v.sai_val;
  });

  // ── WORKBOOK ─────────────────────────────────────────────────
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Lumin SaaS'; wb.created = new Date();

  /* ══════════════════════════════════════════════════════════════
     SHEET 1 — 📋 REGISTROS
  ══════════════════════════════════════════════════════════════ */
  const ws1 = wb.addWorksheet('📋 Registros', { views:[{ state:'frozen', ySplit:2 }] });
  ws1.columns = [
    { width:14 }, // A Data
    { width:10 }, // B Tipo
    { width:30 }, // C Cliente
    { width:14 }, // D Motorista
    { width:8  }, // E Qtd CX
    { width:8  }, // F Cor
    { width:14 }, // G Valor Unit.
    { width:14 }, // H Valor Total
    { width:12 }, // I Status
  ];

  // Título
  ws1.mergeCells('A1:I1');
  const ws1Title = ws1.getCell('A1');
  ws1Title.value = '📋  CONTROLE DE CAIXAS — LUMIN LOG';
  ws1Title.font  = font({ bold:true, size:14, color:{ argb:C.white } });
  ws1Title.fill  = fill(C.navyDark);
  ws1Title.alignment = midL;
  ws1.getRow(1).height = 28;

  // Cabeçalhos col
  const hdrs1 = ['Data','Tipo','Cliente','Motorista','Qtd CX','Cor','Valor Unit.','Valor Total','Status'];
  ws1.getRow(2).height = 22;

  function hdrCellRC(ws, row, col, val, bg=C.navyDark, sz=11) {
    const c = row.getCell(col);
    c.value = val;
    c.font  = font({ bold:true, color:{ argb:C.white }, size:sz });
    c.fill  = fill(bg);
    c.alignment = mid;
    c.border = border();
    return c;
  }
  const r2 = ws1.getRow(2);
  hdrs1.forEach((h,i) => hdrCellRC(ws1, r2, i+1, h, C.navyMid));

  // Auto-filter
  ws1.autoFilter = { from:'A2', to:'I2' };

  // Dados
  dados.forEach((r, idx) => {
    const rowNum = idx + 3;
    const rw = ws1.getRow(rowNum);
    rw.height = 17;
    const cliente   = r.cliente   || r.remetente || 'Não identificado';
    const motorista = r.motorista || r.conferente || '—';
    const cor       = (r.cor || '').toUpperCase();
    const isEnt     = (r.tipo || '').toUpperCase().includes('ENTRADA');
    const cx        = nn(r.quantidadeCx);
    const unitario  = cor === 'PRETA' ? 20 : cor === 'BRANCA' ? 28 : 0;
    const isAlt     = idx % 2 === 1;
    const rowFill   = isEnt ? (isAlt ? C.blueAlt : C.blueLight) : (isAlt ? C.gray1 : C.white);
    const faltaInfo = (!motorista || motorista==='—') || cliente==='Não identificado';
    const finalFill = faltaInfo && !isEnt ? C.redLight : rowFill;

    function dc(col, val, extra={}) {
      const c = rw.getCell(col);
      c.value = val; c.border = border();
      c.fill  = fill(finalFill);
      c.alignment = extra.align || midL;
      if (extra.numFmt) c.numFmt = extra.numFmt;
      if (extra.font)   c.font   = font(extra.font);
      return c;
    }

    // A — Data
    if (r.data) {
      const [y,m,d] = r.data.split('-').map(Number);
      dc(1, new Date(y,m-1,d), { numFmt:fmtDate, align:mid });
    } else { dc(1,'—',{align:mid}); }

    // B — Tipo
    const cTipo = dc(2, r.tipo || 'ENTRADA', { align:mid });
    cTipo.font = font({ bold:true, color:{ argb: isEnt ? C.navyLight : C.red } });

    dc(3, cliente);
    dc(4, motorista);
    dc(5, cx, { align:mid, font:{ bold:true } });
    dc(6, cor, { align:mid });
    dc(7, unitario, { numFmt:fmtBRL, align:midR });
    dc(8, cx*unitario, { numFmt:fmtBRL, align:midR, font:{ bold:true } });

    // I — Status
    const statusVal = faltaInfo && !isEnt ? '⚠ Incompleto' : isEnt ? '✓ Retorno' : '✓ Saída';
    const statusFill= faltaInfo && !isEnt ? C.redLight : isEnt ? C.blueLight : C.gray1;
    const cSt = dc(9, statusVal, { align:mid });
    cSt.font = font({ bold:true, color:{ argb: faltaInfo&&!isEnt ? C.red : isEnt ? C.navyLight : C.textDark } });
  });

  // Linha totais
  const totRow1 = dados.length + 3;
  ws1.mergeCells(`A${totRow1}:D${totRow1}`);
  const cTotLbl = ws1.getCell(`A${totRow1}`);
  cTotLbl.value = 'TOTAIS DO PERÍODO';
  cTotLbl.font  = font({ bold:true, color:{ argb:C.white } });
  cTotLbl.fill  = fill(C.navyDark); cTotLbl.alignment = midL; cTotLbl.border = border();

  function totCell(ws, row, col, formula, fmt) {
    const c = ws.getRow(row).getCell(col);
    c.value = { formula };
    c.font  = font({ bold:true, color:{ argb:C.white } });
    c.fill  = fill(C.navyDark);
    c.alignment = midR; c.border = border();
    if (fmt) c.numFmt = fmt;
    return c;
  }
  totCell(ws1, totRow1, 5, `SUM(E3:E${totRow1-1})`);
  totCell(ws1, totRow1, 7, `SUM(G3:G${totRow1-1})`, fmtBRL);
  totCell(ws1, totRow1, 8, `SUM(H3:H${totRow1-1})`, fmtBRL);
  ws1.getRow(totRow1).height = 20;

  /* ══════════════════════════════════════════════════════════════
     SHEET 2 — 📊 RESUMO SEMANAL
  ══════════════════════════════════════════════════════════════ */
  const ws2 = wb.addWorksheet('📊 Resumo Semanal', { views:[{ state:'frozen', ySplit:3 }] });
  ws2.columns = [
    { width:22 }, // A Semana / Indicador
    { width:12 }, // B Seg
    { width:12 }, // C Ter
    { width:12 }, // D Qua
    { width:12 }, // E Qui
    { width:12 }, // F Sex
    { width:12 }, // G Sáb
    { width:12 }, // H Dom
    { width:14 }, // I TOTAL
  ];

  ws2.mergeCells('A1:I1');
  const ws2T = ws2.getCell('A1');
  ws2T.value = '📊  RESUMO SEMANAL — LUMIN LOG';
  ws2T.font  = font({ bold:true, size:14, color:{ argb:C.white } });
  ws2T.fill  = fill(C.navyDark); ws2T.alignment = midL;
  ws2.getRow(1).height = 28;

  const diasNomes = ['Seg','Ter','Qua','Qui','Sex','Sáb','Dom'];
  hdrCellRC(ws2, ws2.getRow(2), 1, 'Semana / Dia', C.navyMid);
  diasNomes.forEach((d,i) => hdrCellRC(ws2, ws2.getRow(2), i+2, d, C.navyMid));
  hdrCellRC(ws2, ws2.getRow(2), 9, '▸ TOTAL', C.navyDark);
  ws2.getRow(2).height = 20;

  // Gera sub-cabeçalho de datas por semana
  hdrCellRC(ws2, ws2.getRow(3), 1, 'Indicador', C.navyMid, 10);
  ws2.getRow(3).height = 16;

  let ws2Row = 4;
  const semanasOrdenadas = Object.keys(porSemana).sort();

  semanasOrdenadas.forEach((seg, si) => {
    const sem = porSemana[seg];
    const monday = new Date(seg + 'T00:00:00');
    const sunday = new Date(monday); sunday.setDate(monday.getDate()+6);
    const fmt = d => d.toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit'});
    const semLabel = `📅 ${fmt(monday)} – ${fmt(sunday)}`;

    // Header da semana
    ws2.mergeCells(`A${ws2Row}:I${ws2Row}`);
    const cSemHdr = ws2.getCell(`A${ws2Row}`);
    cSemHdr.value = semLabel;
    cSemHdr.font  = font({ bold:true, size:12, color:{ argb:C.white } });
    cSemHdr.fill  = fill(si%2===0 ? C.navyMid : C.navyLight);
    cSemHdr.alignment = midL; cSemHdr.border = border();
    ws2.getRow(ws2Row).height = 20; ws2Row++;

    // Monta mapa dia→dados
    const mapDia = {};
    sem.dias.forEach(d => { mapDia[d.data] = d; });

    const blocos = [
      { label:'📦 Caixas Saídas (cx)',  key:'sai_cx',  fmt:null,   bg:C.redLight,  fgLabel:C.red },
      { label:'📦 Caixas Entradas (cx)',key:'ent_cx',  fmt:null,   bg:C.blueLight, fgLabel:C.navyLight },
      { label:'💰 Valor Saído (R$)',    key:'sai_val', fmt:fmtBRL, bg:C.redLight,  fgLabel:C.red },
      { label:'💰 Valor Entrado (R$)',  key:'ent_val', fmt:fmtBRL, bg:C.blueLight, fgLabel:C.navyLight },
      { label:'📈 Taxa Retorno',        key:'taxa',    fmt:fmtPct, bg:C.amberBg,   fgLabel:C.amber },
    ];

    blocos.forEach(bloco => {
      const rw = ws2.getRow(ws2Row); rw.height = 18;
      // Label
      const cLbl = rw.getCell(1);
      cLbl.value = bloco.label;
      cLbl.font  = font({ bold:true, color:{ argb:bloco.fgLabel } });
      cLbl.fill  = fill(bloco.bg); cLbl.alignment = midL; cLbl.border = border();

      let total = 0;
      // 7 dias da semana
      for (let dow=0;dow<7;dow++) {
        const dayDate = new Date(monday); dayDate.setDate(monday.getDate()+dow);
        const dayStr  = dayDate.toISOString().split('T')[0];
        const d = mapDia[dayStr] || {};
        let v;
        if (bloco.key === 'taxa') {
          v = d.sai_cx > 0 ? Math.round((d.ent_cx||0)/(d.sai_cx)*100) : null;
        } else { v = d[bloco.key] || 0; total += v||0; }
        const c = rw.getCell(dow+2);
        c.value = v !== null ? v : '—';
        c.fill  = fill(bloco.bg);
        c.alignment = mid; c.border = border();
        if (bloco.fmt && typeof v === 'number') c.numFmt = bloco.fmt;
        if (bloco.key === 'taxa' && typeof v === 'number') {
          c.font = font({ bold:true, color:{ argb: v>=60?C.green : v>=30?C.amber : C.red } });
        }
      }

      // Total da semana
      const cTot = rw.getCell(9);
      if (bloco.key === 'taxa') {
        const t = sem.sai_cx > 0 ? Math.round(sem.ent_cx/sem.sai_cx*100) : 0;
        cTot.value = t; cTot.numFmt = fmtPct;
        cTot.font  = font({ bold:true, color:{ argb: t>=60?C.green : t>=30?C.amber : C.red } });
      } else {
        cTot.value = bloco.key.includes('val') ? sem[bloco.key] : total;
        if (bloco.fmt) cTot.numFmt = bloco.fmt;
        cTot.font = font({ bold:true });
      }
      cTot.fill = fill(C.gray2); cTot.alignment = midR; cTot.border = border();
      ws2Row++;
    });

    // Linha separadora
    ws2.mergeCells(`A${ws2Row}:I${ws2Row}`);
    ws2.getRow(ws2Row).height = 6; ws2Row++;
  });

  // Grande total final
  ws2.mergeCells(`A${ws2Row}:H${ws2Row}`);
  const cGrandLbl = ws2.getCell(`A${ws2Row}`);
  cGrandLbl.value = '▸ GRANDE TOTAL DO PERÍODO';
  cGrandLbl.font  = font({ bold:true, size:12, color:{ argb:C.white } });
  cGrandLbl.fill  = fill(C.navyDark); cGrandLbl.alignment = midL; cGrandLbl.border = border();
  const cGrandTot = ws2.getCell(`I${ws2Row}`);
  const totEntCx  = Object.values(porDia).reduce((a,v)=>a+v.ent_cx,0);
  const totSaiCx  = Object.values(porDia).reduce((a,v)=>a+v.sai_cx,0);
  const totEntVal = Object.values(porDia).reduce((a,v)=>a+v.ent_val,0);
  const totSaiVal = Object.values(porDia).reduce((a,v)=>a+v.sai_val,0);
  cGrandTot.value = `⬇${totSaiCx}cx / ⬆${totEntCx}cx`;
  cGrandTot.font  = font({ bold:true, color:{argb:C.white} });
  cGrandTot.fill  = fill(C.navyDark); cGrandTot.alignment = mid; cGrandTot.border = border();
  ws2.getRow(ws2Row).height = 22;

  /* ══════════════════════════════════════════════════════════════
     SHEET 3 — 🚚 POR MOTORISTA
  ══════════════════════════════════════════════════════════════ */
  const ws3 = wb.addWorksheet('🚚 Por Motorista', { views:[{ state:'frozen', ySplit:2 }] });
  ws3.columns = [
    { width:22 }, // A Motorista
    { width:12 }, // B Caixas Saídas
    { width:12 }, // C Caixas Entrada
    { width:12 }, // D Saldo
    { width:12 }, // E Taxa Retorno
    { width:14 }, // F Valor Saído
    { width:14 }, // G Valor Entrado
    { width:12 }, // H Clientes únicos
    { width:14 }, // I Valor Líquido
  ];

  ws3.mergeCells('A1:I1');
  const ws3T = ws3.getCell('A1');
  ws3T.value = '🚚  DESEMPENHO POR MOTORISTA';
  ws3T.font  = font({ bold:true, size:14, color:{ argb:C.white } });
  ws3T.fill  = fill(C.navyDark); ws3T.alignment = midL;
  ws3.getRow(1).height = 28;

  const hdrs3 = ['Motorista','↓ Saídas (cx)','↑ Entradas (cx)','Saldo','Taxa Retorno','↓ Val. Saído','↑ Val. Entrado','Clientes','Val. Líquido'];
  const r3h = ws3.getRow(2);
  hdrs3.forEach((h,i) => hdrCellRC(ws3, r3h, i+1, h, C.navyMid));
  r3h.height = 20;
  ws3.autoFilter = { from:'A2', to:'I2' };

  const motoristasSort = Object.entries(porMotorista).sort((a,b)=>b[1].sai_cx-a[1].sai_cx);
  motoristasSort.forEach(([mot, v], idx) => {
    const rw = ws3.getRow(idx+3); rw.height = 18;
    const taxa = v.sai_cx > 0 ? Math.round(v.ent_cx/v.sai_cx*100) : 0;
    const saldo = v.sai_cx - v.ent_cx;
    const isAlt = idx%2===1;
    const bg = isAlt ? C.gray1 : C.white;

    function mc(col, val, opts={}) {
      const c = rw.getCell(col); c.value = val;
      c.fill = fill(opts.bg||bg); c.border = border();
      c.alignment = opts.align||midL;
      if (opts.numFmt) c.numFmt = opts.numFmt;
      if (opts.font)   c.font   = font(opts.font);
      else             c.font   = font({});
      return c;
    }

    mc(1, mot, { font:{ bold:true } });
    mc(2, v.sai_cx, { align:mid, font:{ bold:true, color:{ argb:C.red } } });
    mc(3, v.ent_cx, { align:mid, font:{ bold:true, color:{ argb:C.navyLight } } });
    mc(4, saldo,    { align:mid, bg: saldo>30?C.redLight : saldo>10?C.amberBg : C.greenBg,
                      font:{ bold:true, color:{ argb: saldo>30?C.red : saldo>10?C.amber : C.green } } });
    const cTaxa = rw.getCell(5);
    cTaxa.value = taxa; cTaxa.numFmt = fmtPct;
    cTaxa.fill  = fill(taxa<40?C.redLight : taxa<70?C.amberBg : C.greenBg);
    cTaxa.font  = font({ bold:true, color:{ argb: taxa<40?C.red : taxa<70?C.amber : C.green } });
    cTaxa.alignment = mid; cTaxa.border = border();
    mc(6, v.sai_val, { numFmt:fmtBRL, align:midR, font:{ color:{ argb:C.red } } });
    mc(7, v.ent_val, { numFmt:fmtBRL, align:midR, font:{ color:{ argb:C.navyLight } } });
    mc(8, v.clientes.size, { align:mid });
    mc(9, v.sai_val-v.ent_val, { numFmt:fmtBRL, align:midR,
      font:{ bold:true, color:{ argb: v.sai_val-v.ent_val>0?C.green:C.red } } });
  });

  // Totais motoristas
  const totMRow = motoristasSort.length + 3;
  ws3.mergeCells(`A${totMRow}:C${totMRow}`);
  const cTMlbl = ws3.getCell(`A${totMRow}`);
  cTMlbl.value = `TOTAL — ${motoristasSort.length} motoristas`;
  cTMlbl.font  = font({ bold:true, color:{ argb:C.white } });
  cTMlbl.fill  = fill(C.navyDark); cTMlbl.alignment = midL; cTMlbl.border = border();
  [
    [2, totSaiCx, null, C.red],
    [3, totEntCx, null, C.navyLight],
    [4, totSaiCx-totEntCx, null, C.white],
    [6, totSaiVal, fmtBRL, C.white],
    [7, totEntVal, fmtBRL, C.white],
    [9, totSaiVal-totEntVal, fmtBRL, C.white],
  ].forEach(([col,val,fmt,fg]) => {
    const c = ws3.getRow(totMRow).getCell(col);
    c.value = val; c.fill = fill(C.navyDark); c.border = border();
    c.font  = font({ bold:true, color:{ argb:fg||C.white } });
    c.alignment = midR; if (fmt) c.numFmt = fmt;
  });
  ws3.getRow(totMRow).height = 20;

  /* ══════════════════════════════════════════════════════════════
     SHEET 4 — 👥 POR CLIENTE
  ══════════════════════════════════════════════════════════════ */
  const ws4 = wb.addWorksheet('👥 Por Cliente', { views:[{ state:'frozen', ySplit:2 }] });
  ws4.columns = [
    { width:30 }, // A Cliente
    { width:12 }, // B Saídas cx
    { width:12 }, // C Entradas cx
    { width:12 }, // D Saldo cx
    { width:12 }, // E Taxa Retorno
    { width:14 }, // F Valor Saído
    { width:14 }, // G Valor Entrado
    { width:12 }, // H Motoristas
    { width:14 }, // I Valor Devendo
  ];

  ws4.mergeCells('A1:I1');
  const ws4T = ws4.getCell('A1');
  ws4T.value = '👥  RESUMO POR CLIENTE';
  ws4T.font  = font({ bold:true, size:14, color:{ argb:C.white } });
  ws4T.fill  = fill(C.navyDark); ws4T.alignment = midL;
  ws4.getRow(1).height = 28;

  const hdrs4 = ['Cliente','↓ Recebeu (cx)','↑ Devolveu (cx)','Saldo Devedor','Taxa Devol.','↓ Val. Recebido','↑ Val. Devolvido','Motoristas','💰 Devendo'];
  const r4h = ws4.getRow(2);
  hdrs4.forEach((h,i) => hdrCellRC(ws4, r4h, i+1, h, C.navyMid));
  r4h.height = 20;
  ws4.autoFilter = { from:'A2', to:'I2' };

  const clientesSort = Object.entries(porCliente).sort((a,b)=>(b[1].sai_cx-b[1].ent_cx)-(a[1].sai_cx-a[1].ent_cx));
  clientesSort.forEach(([cli, v], idx) => {
    const rw = ws4.getRow(idx+3); rw.height = 18;
    const saldo = v.sai_cx - v.ent_cx;
    const taxa  = v.sai_cx > 0 ? Math.round(v.ent_cx/v.sai_cx*100) : 0;
    const devendo = v.sai_val - v.ent_val;
    const isAlt = idx%2===1;
    const bg = saldo > 30 ? C.redLight : saldo > 10 ? C.amberBg : (isAlt ? C.gray1 : C.white);

    function cc(col, val, opts={}) {
      const c = rw.getCell(col); c.value = val;
      c.fill = fill(opts.bg||bg); c.border = border();
      c.alignment = opts.align||midL;
      if (opts.numFmt) c.numFmt = opts.numFmt;
      if (opts.font)   c.font   = font(opts.font);
      return c;
    }
    cc(1, cli, { font:{ bold:true } });
    cc(2, v.sai_cx,   { align:mid, font:{ bold:true, color:{ argb:C.red } } });
    cc(3, v.ent_cx,   { align:mid, font:{ bold:true, color:{ argb:C.navyLight } } });
    const cSaldo4 = rw.getCell(4);
    cSaldo4.value = saldo;
    cSaldo4.fill  = fill(saldo>30?C.redLight : saldo>10?C.amberBg : C.greenBg);
    cSaldo4.font  = font({ bold:true, color:{ argb: saldo>30?C.red : saldo>10?C.amber : C.green } });
    cSaldo4.alignment = mid; cSaldo4.border = border();
    const cTaxa4 = rw.getCell(5);
    cTaxa4.value = taxa; cTaxa4.numFmt = fmtPct;
    cTaxa4.fill  = fill(taxa<40?C.redLight : taxa<70?C.amberBg : C.greenBg);
    cTaxa4.font  = font({ bold:true, color:{ argb: taxa<40?C.red : taxa<70?C.amber : C.green } });
    cTaxa4.alignment = mid; cTaxa4.border = border();
    cc(6, v.sai_val, { numFmt:fmtBRL, align:midR, font:{ color:{ argb:C.red } } });
    cc(7, v.ent_val, { numFmt:fmtBRL, align:midR, font:{ color:{ argb:C.navyLight } } });
    cc(8, v.motoristas.size, { align:mid });
    const cDev = rw.getCell(9);
    cDev.value = devendo; cDev.numFmt = fmtBRL;
    cDev.fill  = fill(devendo>500?C.redLight : devendo>0?C.amberBg : C.greenBg);
    cDev.font  = font({ bold:true, color:{ argb: devendo>500?C.red : devendo>0?C.amber : C.green } });
    cDev.alignment = midR; cDev.border = border();
  });

  // Totais clientes
  const totCRow = clientesSort.length + 3;
  ws4.mergeCells(`A${totCRow}:C${totCRow}`);
  const cTClbl = ws4.getCell(`A${totCRow}`);
  cTClbl.value = `TOTAL — ${clientesSort.length} clientes`;
  cTClbl.font  = font({ bold:true, color:{ argb:C.white } });
  cTClbl.fill  = fill(C.navyDark); cTClbl.alignment = midL; cTClbl.border = border();
  [[2,totSaiCx],[3,totEntCx],[6,totSaiVal,fmtBRL],[7,totEntVal,fmtBRL],[9,totSaiVal-totEntVal,fmtBRL]].forEach(([col,val,fmt])=>{
    const c = ws4.getRow(totCRow).getCell(col);
    c.value = val; c.fill = fill(C.navyDark); c.border = border();
    c.font  = font({ bold:true, color:{ argb:C.white } });
    c.alignment = midR; if (fmt) c.numFmt = fmt;
  });
  ws4.getRow(totCRow).height = 20;

  /* ══════════════════════════════════════════════════════════════
     SHEET 5 — 📈 PAINEL EXECUTIVO
  ══════════════════════════════════════════════════════════════ */
  const ws5 = wb.addWorksheet('📈 Painel Executivo');
  ws5.columns = [{ width:28 },{ width:20 },{ width:20 },{ width:20 },{ width:20 }];

  ws5.mergeCells('A1:E1');
  const ws5T = ws5.getCell('A1');
  ws5T.value = '📈  PAINEL EXECUTIVO — LUMIN LOG';
  ws5T.font  = font({ bold:true, size:16, color:{ argb:C.white } });
  ws5T.fill  = fill(C.navyDark); ws5T.alignment = midL;
  ws5.getRow(1).height = 34;

  ws5.mergeCells('A2:E2');
  ws5.getCell('A2').value = `Gerado em: ${new Date().toLocaleString('pt-BR')}   |   Total de registros: ${dados.length}`;
  ws5.getCell('A2').font  = font({ italic:true, color:{ argb:'FF666666' } });
  ws5.getRow(2).height = 18;

  const kpis = [
    ['📦 Total Saídas', totSaiCx + ' cx', totSaiVal, C.red, C.redLight],
    ['📦 Total Entradas', totEntCx + ' cx', totEntVal, C.navyLight, C.blueLight],
    ['📊 Taxa Global Retorno', (totSaiCx>0?Math.round(totEntCx/totSaiCx*100):0)+'%', null, C.amber, C.amberBg],
    ['💰 Saldo em Aberto', (totSaiCx-totEntCx)+' cx', totSaiVal-totEntVal, C.red, C.redLight],
    ['🚚 Motoristas Ativos', motoristasSort.length, null, C.green, C.greenBg],
    ['👥 Clientes Únicos', clientesSort.length, null, C.navyLight, C.blueLight],
    ['📅 Semanas no Período', semanasOrdenadas.length, null, C.navyMid, C.gray1],
    ['⭐ Maior Volume (Cliente)', clientesSort[0]?.[0]||'—', null, C.navyMid, C.gray1],
    ['🏆 Maior Volume (Motorista)', motoristasSort[0]?.[0]||'—', null, C.navyMid, C.gray1],
  ];

  let kpiRow = 4;
  kpis.forEach(([label, val1, val2, fg, bg]) => {
    const rw = ws5.getRow(kpiRow); rw.height = 28;
    ws5.mergeCells(`A${kpiRow}:B${kpiRow}`);
    const cL = ws5.getCell(`A${kpiRow}`);
    cL.value = label; cL.font = font({ bold:true, size:12 });
    cL.alignment = midL; cL.border = border(); cL.fill = fill(C.gray1);

    ws5.mergeCells(`C${kpiRow}:D${kpiRow}`);
    const cV = ws5.getCell(`C${kpiRow}`);
    cV.value = val1; cV.font = font({ bold:true, size:13, color:{ argb:fg } });
    cV.alignment = mid; cV.border = border(); cV.fill = fill(bg);

    const cV2 = ws5.getCell(`E${kpiRow}`);
    cV2.value = val2 !== null ? val2 : '';
    if (val2 !== null) { cV2.numFmt = fmtBRL; }
    cV2.font = font({ bold:true, color:{ argb:fg } });
    cV2.alignment = midR; cV2.border = border(); cV2.fill = fill(bg);
    kpiRow++;
  });

  // ── DOWNLOAD ─────────────────────────────────────────────────
  const buffer = await wb.xlsx.writeBuffer();
  const blob   = new Blob([buffer], { type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url    = URL.createObjectURL(blob);
  const link   = document.createElement('a');
  link.href     = url;
  link.download = `lumin_relatorio_${new Date().toISOString().split('T')[0]}.xlsx`;
  link.click();
  URL.revokeObjectURL(url);
  toast('✓ Relatório Excel exportado com sucesso! (5 abas)');
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
window.addEventListener('lumin:admin-ready', async (e) => {
  const user = e.detail?.user;
  if (!user || (user.role !== 'master' && user.role !== 'hetros')) return;
  bindEvents();
  initFiltrosColapsaveis();  // filtros colapsáveis
  carregarFrequentes();      // carrega motoristas/clientes salvos
  startListener();

  // Expõe renderTabela globalmente para o script inline do index.html
  window.renderLuminLog  = renderTabela;
  window.initLuminLog    = () => {};  // já inicializado, no-op
});
