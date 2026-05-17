/**
 * ═══════════════════════════════════════════════════════════════
 *  LUMIN SaaS — Tenant Controller v2
 *  Arquivo: tenant-controller.js
 * ═══════════════════════════════════════════════════════════════
 */

import { db } from "./firebase-config.js";
import {
  collection, doc, getDoc, addDoc, updateDoc, deleteDoc, setDoc,
  query, orderBy, onSnapshot, where, getDocs, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ─── CATEGORIAS ───────────────────────────────────────────────
const CATS = {
  'entrada':     { label:'Entrada',              color:'#00e5a0', isRec:false },
  'saida-fixa':  { label:'Saída Fixa',           color:'#ff5b70', isRec:true  },
  'funcionario': { label:'Pagto. Funcionário',   color:'#ffb347', isRec:true  },
  'comida':      { label:'Comida',               color:'#4ecdc4', isRec:false },
  'variavel':    { label:'Despesa Variável',     color:'#b085f5', isRec:false }
};
const MONTHS = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho',
                'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

// ─── ESTADO ───────────────────────────────────────────────────
const s = {
  user:null, companyId:null, company:null,
  view:'v-home', txs:[], obs:[], pagamentos:[],
  fM:new Date().getMonth()+1, fY:new Date().getFullYear(),
  cM:new Date().getMonth()+1, cY:new Date().getFullYear(),
  repFilter:'mes_atual', repCat:'all', repCustomIni:'', repCustomFim:'', features:{},
  dashCat:'all', dashSort:'createdAt', dashOrigem:'all', dashShowAll:false
};
let charts={}, _unsubTxs=null, _unsubObs=null, _unsubPag=null, _unsubCompany=null;

// ─── HELPERS ──────────────────────────────────────────────────
const $   = id  => document.getElementById(id);
const $$  = sel => document.querySelectorAll(sel);
const fmt = v   => Number(v).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
const fmtN= v   => Number(v).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2});
const fD  = iso => iso ? iso.split('-').reverse().join('/') : '—';
const esc = str => String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

// ─── HELPERS DE ORIGEM / CREATED-AT ───────────────────────────
function getCreatedAtMs(t){
  const c = t.createdAt;
  if(!c) return 0;
  if(typeof c === 'number') return c;                    // Date.now() do frontend
  if(c && typeof c.toMillis === 'function') return c.toMillis(); // Firestore Timestamp
  if(c && c.seconds) return c.seconds * 1000;           // Timestamp serializado
  return 0;
}

function getOrigem(t){
  if(t.origem==='whatsapp' || t.createdBy==='whatsapp-bot') return 'whatsapp';
  if(t.origem==='pluggy') return 'banco';
  return 'manual';
}

function getOrigemBadge(t){
  const o = getOrigem(t);
  if(o==='whatsapp') return `<span title="Enviado pelo WhatsApp" style="font-size:10px;padding:2px 6px;border-radius:5px;background:rgba(0,212,255,.10);color:var(--accent);font-weight:700;white-space:nowrap;">📱 WA</span>`;
  if(o==='banco')    return `<span title="Importado do banco" style="font-size:10px;padding:2px 6px;border-radius:5px;background:rgba(255,179,71,.10);color:var(--warning);font-weight:700;white-space:nowrap;">🏦 Banco</span>`;
  return `<span title="Adicionado manualmente" style="font-size:10px;padding:2px 6px;border-radius:5px;background:rgba(255,255,255,.06);color:var(--muted);font-weight:700;white-space:nowrap;">✎ Manual</span>`;
}

function addEvents(elOrId, fn){
  // click-only — touchstart caused double-fires and swallowed scroll events
  const el = typeof elOrId==='string' ? $(elOrId) : elOrId;
  if(!el) return;
  el.addEventListener('click', fn);
}

function animateVal(id, target){
  const el=$(id); if(!el) return;
  const start=Date.now(), dur=700;
  (function tick(){
    const p=Math.min((Date.now()-start)/dur,1), ease=1-Math.pow(1-p,3);
    el.textContent=fmt(target*ease);
    if(p<1) requestAnimationFrame(tick); else el.textContent=fmt(target);
  })();
}

function toast(msg, isErr=false){
  const el=$('toast'); if(!el) return;
  el.textContent=msg; el.className='show'+(isErr?' err':'');
  clearTimeout(el._t); el._t=setTimeout(()=>el.className='',2800);
}

function getGreeting(){
  const h=new Date().getHours();
  if(h>=5&&h<12) return 'Bom dia';
  if(h>=12&&h<18) return 'Boa tarde';
  return 'Boa noite';
}

// ─── SIDEBAR / NAV ────────────────────────────────────────────
function openSidebar(){
  $('t-sidebar').classList.add('open');
  $('t-sb-overlay').classList.add('active');
}
function closeSidebar(){
  $('t-sidebar').classList.remove('open');
  $('t-sb-overlay').classList.remove('active');
}

function switchV(id){
  if(!id) return;
  s.view=id;
  $$('.t-view').forEach(v=>v.classList.remove('active'));
  $(id)?.classList.add('active');
  $$('.t-nav-item').forEach(b=>b.classList.toggle('active',b.dataset.view===id));
  const titles={'v-home':'Dashboard','v-cal':'Calendário','v-obrig':'Obrigações','v-rep':'Relatórios','v-papelao':'Compra Papelão','v-users':'Segurança'};
  const tEl=$('t-v-title'); if(tEl) tEl.textContent=titles[id]||'Lumin';
  closeSidebar();
  render();
}

// ─── MODAL TRANSAÇÃO ──────────────────────────────────────────
function toggleModal(open){
  const o=$('t-m-add');
  if(open){
    o.classList.add('active');
    $('t-a-date').valueAsDate=new Date();
    // Aplica feature flags (mostra/oculta opção funcionário e outros)
    applyFeatures();
    // ❌ Sem focus automático — teclado só sobe quando o utilizador
    //    toca num campo de texto (desc ou valor) manualmente.
    // Blur explícito nos inputs para garantir que o teclado não
    // reaparece por foco residual de interação anterior.
    setTimeout(()=>{
      const desc=$('t-a-desc'), val=$('t-a-val');
      if(desc&&document.activeElement===desc) desc.blur();
      if(val &&document.activeElement===val)  val.blur();
    }, 50);
  } else {
    o.classList.remove('active');
    const b=$('t-btn-save');
    if(b){b._editId=null;b.textContent='✓ Registrar no Sistema';}
    // Garante que o teclado fecha ao fechar o modal
    if(document.activeElement instanceof HTMLElement) document.activeElement.blur();
  }
}

// ─── RENDER PRINCIPAL ─────────────────────────────────────────
let _appReady = false; // set true after initTenantDashboard completes first render
function render(){
  if(!_appReady) return; // boot not complete yet — ignore premature calls
  applyFeatures();
  buildPills();
  if(s.view==='v-home')  renderHome();
  if(s.view==='v-cal')   renderCal();
  if(s.view==='v-obrig') renderOb();
  if(s.view==='v-rep')   renderRep();
  if(s.view==='v-users') renderUsers();
}

function buildPills(){
  const months=new Set();
  const now=new Date();
  const nowYM=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  months.add(nowYM);
  s.txs.forEach(t=>{if(t.date) months.add(t.date.slice(0,7));});
  const sorted=[...months].sort().reverse();
  const pills=$('t-filter-pills'); if(!pills) return;
  pills.innerHTML='';
  sorted.forEach(ym=>{
    const [y,m]=ym.split('-').map(Number);
    const active=m===s.fM&&y===s.fY;
    const btn=document.createElement('button');
    btn.className='fpill'+(active?' active':'');
    btn.textContent=`${MONTHS[m-1].slice(0,3)} ${y}`;
    btn.style.flexShrink='0';
    btn.addEventListener('click',()=>{s.fM=m;s.fY=y;s.dashShowAll=false;render();});
    pills.appendChild(btn);
  });
  // Rola para o pill activo
  const activePill=pills.querySelector('.fpill.active');
  if(activePill) setTimeout(()=>activePill.scrollIntoView({inline:'center',behavior:'smooth'}),100);
}

// ─── PESQUISA INTELIGENTE ─────────────────────────────────────
const SEARCH_KEY = 'lumin_saved_filters';
function getSaved(){ try{ return JSON.parse(localStorage.getItem(SEARCH_KEY)||'[]'); }catch(e){return [];} }
function saveFilter(t){ if(!t||t.length<2)return; let f=getSaved().filter(x=>x.toLowerCase()!==t.toLowerCase()); f.unshift(t); localStorage.setItem(SEARCH_KEY,JSON.stringify(f.slice(0,8))); }
function removeFilter(t){ localStorage.setItem(SEARCH_KEY,JSON.stringify(getSaved().filter(x=>x.toLowerCase()!==t.toLowerCase()))); }
function normQ(s){ return String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,''); }
function scoreMatch(tx,q){
  const d=normQ(tx.description||''), cat=normQ(CATS[tx.category]?.label||''), dt=tx.date||'';
  if(d===q||cat===q) return 100;
  if(d.startsWith(q)||cat.startsWith(q)) return 80;
  if(d.includes(q)||cat.includes(q)) return 60;
  if(dt.includes(q)) return 40;
  const terms=q.split(/\s+/).filter(Boolean);
  if(terms.length>1&&terms.every(t=>d.includes(t)||cat.includes(t))) return 50;
  return 0;
}

function bindSmartSearch(){
  const inp=$('t-smart-search'), dd=$('t-search-dropdown');
  const clrBtn=$('t-search-clear'), savedEl=$('t-search-saved'), resultsEl=$('t-search-results');
  if(!inp||!dd) return;

  function hi(text,q){
    if(!q) return esc(text);
    try{ return esc(text).replace(new RegExp('('+q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+')','gi'),'<mark style="background:rgba(0,212,255,.2);color:var(--accent);border-radius:2px;padding:0 1px;">$1</mark>'); }
    catch(e){ return esc(text); }
  }

  function renderTags(){
    if(!savedEl) return;
    const f=getSaved();
    if(!f.length){savedEl.style.display='none';return;}
    savedEl.style.display='block';
    savedEl.innerHTML='<div style="font-size:10px;font-weight:700;color:rgba(228,240,246,.3);text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px;">Filtros salvos</div>'
      +f.map(x=>'<span class="saved-tag" data-tag="'+esc(x)+'">'+esc(x)+'<span class="del-tag" data-del="'+esc(x)+'"> ✕</span></span> ').join('');
    savedEl.querySelectorAll('.saved-tag').forEach(tag=>{
      tag.addEventListener('click',function(e){
        if(e.target.classList.contains('del-tag')){ e.stopPropagation(); removeFilter(e.target.dataset.del); renderSearch(inp.value); return; }
        inp.value=tag.dataset.tag; renderSearch(tag.dataset.tag);
      });
    });
  }

  function renderSearch(rawQ){
    const q=normQ(rawQ.trim());
    if(clrBtn) clrBtn.style.display=rawQ.trim()?'block':'none';
    if(!rawQ.trim()){
      renderTags(); if(resultsEl) resultsEl.innerHTML='';
      dd.style.display=getSaved().length?'block':'none'; return;
    }
    const cats=activeCats();
    const scored=s.txs.filter(t=>t.date).map(t=>({t,score:scoreMatch(t,q)})).filter(x=>x.score>0)
      .sort((a,b)=>b.score-a.score||b.t.date.localeCompare(a.t.date)).slice(0,8);
    renderTags();
    if(!scored.length){
      if(resultsEl) resultsEl.innerHTML='<div style="padding:18px;text-align:center;">'
        +'<div style="font-size:20px;opacity:.2;margin-bottom:8px;">🔍</div>'
        +'<div style="font-size:12px;color:var(--muted);">Nenhum resultado encontrado</div>'
        +'<button id="t-save-f" style="margin-top:10px;padding:5px 14px;border-radius:20px;background:rgba(0,212,255,.08);border:1px solid rgba(0,212,255,.2);color:var(--accent);font-size:11px;font-weight:700;cursor:pointer;">💾 Salvar filtro</button></div>';
      dd.style.display='block';
      document.getElementById('t-save-f')?.addEventListener('click',()=>{ saveFilter(rawQ.trim()); renderSearch(rawQ); toast('✓ Filtro salvo!'); });
      return;
    }
    if(resultsEl) resultsEl.innerHTML=scored.map(function(obj){
      var t=obj.t, cat=cats[t.category]||CATS.variavel, isIn=t.category==='entrada', vc=isIn?'var(--success)':'var(--alert)';
      return '<div class="sr-item" data-id="'+t.id+'" style="display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:9px;cursor:pointer;transition:background .1s;">'
        +'<div style="width:28px;height:28px;border-radius:8px;flex-shrink:0;display:grid;place-items:center;font-size:11px;font-weight:800;background:'+cat.color+'18;color:'+cat.color+';">'+(isIn?'▲':'▼')+'</div>'
        +'<div style="flex:1;min-width:0;"><div style="font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">'+hi(t.description||'—',rawQ.trim())+'</div>'
        +'<div style="font-size:11px;color:var(--muted);margin-top:2px;">'+fD(t.date)+' · <span style="color:'+cat.color+';">'+cat.label+'</span></div></div>'
        +'<div style="font-family:\'DM Mono\',monospace;font-weight:700;color:'+vc+';font-size:12px;flex-shrink:0;">'+(isIn?'+':'-')+' '+fmt(t.amount)+'</div></div>';
    }).join('')
    +'<div style="border-top:1px solid rgba(255,255,255,.05);padding:7px 10px 4px;display:flex;justify-content:space-between;align-items:center;">'
    +'<span style="font-size:10px;color:rgba(228,240,246,.3);">'+scored.length+' resultado(s)</span>'
    +'<button id="t-save-f" style="padding:3px 10px;border-radius:20px;background:rgba(0,212,255,.06);border:1px solid rgba(0,212,255,.15);color:rgba(0,212,255,.7);font-size:10px;font-weight:700;cursor:pointer;">💾 Salvar</button></div>';
    dd.style.display='block';
    resultsEl.querySelectorAll('.sr-item').forEach(item=>{
      item.addEventListener('click',function(){
        var tx=s.txs.find(t=>t.id===item.dataset.id);
        if(tx&&tx.date){ var parts=tx.date.split('-').map(Number); s.fM=parts[1];s.fY=parts[0];
          saveFilter(rawQ.trim()); switchV('v-home');
          setTimeout(function(){ var row=document.querySelector('[data-id="'+tx.id+'"]'); row&&row.closest('tr')&&row.closest('tr').scrollIntoView({behavior:'smooth',block:'center'}); },400);
        }
        dd.style.display='none'; inp.value=''; if(clrBtn) clrBtn.style.display='none';
      });
    });
    document.getElementById('t-save-f')?.addEventListener('click',()=>{ saveFilter(rawQ.trim()); renderSearch(rawQ); toast('✓ Filtro salvo!'); });
  }

  inp.addEventListener('input',()=>{
    renderSearch(inp.value);
    // Filtra a tabela do dashboard em tempo real
    s.dashSearch = inp.value;
    if (s.view === 'v-home') renderHome();
  });
  inp.addEventListener('focus',()=>renderSearch(inp.value));
  inp.addEventListener('keydown',function(e){
    if(e.key==='Enter'){ var q=inp.value.trim(); if(q){ saveFilter(q); var rs=document.getElementById('rep-search'); if(rs)rs.value=q; s.repFilter='anual'; switchV('v-rep'); renderRep(); dd.style.display='none'; toast('Buscando "'+q+'" em Relatórios…'); } }
    if(e.key==='Escape'){ dd.style.display='none'; inp.blur(); }
  });
  if(clrBtn) clrBtn.addEventListener('click',function(){ inp.value=''; renderSearch(''); s.dashSearch=''; if(s.view==='v-home') renderHome(); inp.focus(); });
  document.addEventListener('click',function(e){ if(!inp.contains(e.target)&&!dd.contains(e.target)&&e.target!==clrBtn) dd.style.display='none'; });
}


// ─── CATEGORIAS ACTIVAS (respeita feature flags) ──────────────
function activeCats() {
  const hasFuncionario = s.features?.funcionario === true;
  const hasComida      = s.features?.comida === true;
  return Object.fromEntries(
    Object.entries(CATS).filter(([k]) => {
      if (k === 'funcionario') return hasFuncionario;
      if (k === 'comida')      return hasComida;
      return true;
    })
  );
}

// ─── APLICAR FEATURES (nav + bottom nav + modal) ─────────────
// Mostra/oculta elementos com data-feature="X" conforme features
// carregadas da empresa. Também filtra a opção do modal.
function applyFeatures() {
  const features = s.features || {};

  // Itens com data-feature="papelao|logistica_km|..." (sidebar + bottom nav)
  // A classe feat-hidden usa display:none !important — por isso removemos/
  // adicionamos a classe em vez de usar style.display (que seria sobrescrito).
  document.querySelectorAll('[data-feature]').forEach(el => {
    const feat = el.dataset.feature;
    const active = features[feat] === true;
    if (active) {
      el.classList.remove('feat-hidden');
    } else {
      el.classList.add('feat-hidden');
    }
  });

  // Opção "Funcionário" no select do modal de transação
  // display:none em <option> não funciona em mobile (iOS/Android ignoram).
  // Solução: remove/reinsere o elemento do DOM conforme a feature.
  const sel = document.getElementById('t-a-cat');
  if (sel) {
    const hasFuncionario = features.funcionario === true;
    const optExistente   = sel.querySelector('option[value="funcionario"]');

    if (hasFuncionario && !optExistente) {
      // Reinsere entre saida-fixa e variavel
      const optVariavel = sel.querySelector('option[value="variavel"]');
      const opt = document.createElement('option');
      opt.value       = 'funcionario';
      opt.textContent = 'Pagamento Funcionário';
      sel.insertBefore(opt, optVariavel);
    } else if (!hasFuncionario && optExistente) {
      // Se estava seleccionado, volta para entrada antes de remover
      if (sel.value === 'funcionario') sel.value = 'entrada';
      optExistente.remove();
    }

    // Opção "Comida" — mesma lógica (insere/remove conforme feature)
    const hasComida    = features.comida === true;
    const optComida    = sel.querySelector('option[value="comida"]');

    if (hasComida && !optComida) {
      const optVariavel2 = sel.querySelector('option[value="variavel"]');
      const opt = document.createElement('option');
      opt.value       = 'comida';
      opt.textContent = 'Comida';
      sel.insertBefore(opt, optVariavel2);
    } else if (!hasComida && optComida) {
      if (sel.value === 'comida') sel.value = 'variavel';
      optComida.remove();
    }
  }
}

// ─── SALDO CUMULATIVO + RECORRENTES VIRTUAIS ─────────────────
// Verifica se uma categoria está activa para o tenant actual
function _catActive(cat) {
  if (cat === 'funcionario') return s.features?.funcionario === true;
  if (cat === 'comida')      return s.features?.comida === true;
  return true;
}

// Gera as instâncias virtuais de transações recorrentes para um mês alvo.
// Toda transação com isRecorrente:true cuja data ORIGINAL é anterior ao
// mês alvo gera uma "instância virtual" naquele mês (mesmo dia).
function getMonthRecurrentInstances(year, month) {
  const targetMonthKey = `${year}-${String(month).padStart(2,'0')}`;
  const out = [];
  for (const t of s.txs) {
    if (!t.isRecorrente || !t.date) continue;
    if (!_catActive(t.category)) continue;
    const [ty, tm] = t.date.split('-').map(Number);
    if (!ty || !tm) continue;
    // Apenas se a recorrência originou ANTES do mês alvo
    if (ty > year || (ty === year && tm >= month)) continue;
    const day = (t.date.split('-')[2] || '01');
    out.push({
      ...t,
      id: `${t.id}__virt__${targetMonthKey}`,
      date: `${targetMonthKey}-${day}`,
      isVirtual: true,
      sourceTxId: t.id
    });
  }
  return out;
}

// Saldo cumulativo até o FIM do mês ANTERIOR ao [year, month] selecionado.
// Conta cada transação não-recorrente uma vez (na sua data) e cada
// transação recorrente uma vez por mês desde a origem até o mês anterior.
function calcPreviousBalance(year, month) {
  // "Mês limite" = mês anterior ao selecionado
  const limitMonths = year * 12 + month - 1; // p.ex. fev/2025 → jan/2025 = 24301

  let balance = 0;
  for (const t of s.txs) {
    if (!t.date) continue;
    if (!_catActive(t.category)) continue;
    const [ty, tm] = t.date.split('-').map(Number);
    if (!ty || !tm) continue;

    const sign = t.category === 'entrada' ? 1 : -1;
    const amount = Number(t.amount || 0);
    const startIdx = ty * 12 + tm;

    if (t.isRecorrente) {
      // Conta uma vez para cada mês de [origem] até [mês anterior ao actual]
      if (startIdx > limitMonths) continue;
      const count = limitMonths - startIdx + 1;
      balance += sign * amount * count;
    } else {
      if (startIdx <= limitMonths) {
        balance += sign * amount;
      }
    }
  }
  return balance;
}

// Expande recorrentes para um intervalo de datas [iniIso, fimIso] — usado
// pelos relatórios para que recorrentes apareçam em todos os meses do período.
function getExpandedTxsInRange(iniIso, fimIso) {
  if (!iniIso || !fimIso) return [];
  const out = [];

  // 1. Transações reais cuja data está dentro do range
  for (const t of s.txs) {
    if (!t.date) continue;
    if (!_catActive(t.category)) continue;
    if (t.date >= iniIso && t.date <= fimIso) out.push(t);
  }

  // 2. Para cada recorrente, gerar virtuais nos meses do range que sejam
  //    POSTERIORES ao mês de origem (o mês de origem já foi contado em #1).
  const [iy, im] = iniIso.split('-').map(Number);
  const [fy, fm] = fimIso.split('-').map(Number);

  for (const t of s.txs) {
    if (!t.isRecorrente || !t.date) continue;
    if (!_catActive(t.category)) continue;
    const [oy, om] = t.date.split('-').map(Number);
    if (!oy || !om) continue;

    // Itera meses do range
    let cy = iy, cm = im;
    while (cy < fy || (cy === fy && cm <= fm)) {
      // Se este mês é POSTERIOR ao mês de origem da recorrente
      if (cy > oy || (cy === oy && cm > om)) {
        const mk = `${cy}-${String(cm).padStart(2,'0')}`;
        const day = (t.date.split('-')[2] || '01');
        const virtualDate = `${mk}-${day}`;
        if (virtualDate >= iniIso && virtualDate <= fimIso) {
          out.push({
            ...t,
            id: `${t.id}__virt__${mk}`,
            date: virtualDate,
            isVirtual: true,
            sourceTxId: t.id
          });
        }
      }
      cm++;
      if (cm > 12) { cm = 1; cy++; }
    }
  }
  return out;
}

// ─── FILTROS DO DASHBOARD ─────────────────────────────────────
function renderDashFilters(txs){
  const el = $('t-dash-filter-row'); if(!el) return;

  // Totais rápidos para o mini-resumo do filtro
  const inF  = txs.filter(t=>t.category==='entrada').reduce((a,t)=>a+Number(t.amount||0),0);
  const outF = txs.filter(t=>t.category!=='entrada').reduce((a,t)=>a+Number(t.amount||0),0);

  // Pílula com bolinha colorida em vez de emoji
  const pill = (active, color, label, onclick) => {
    const dot = color
      ? `<span style="width:6px;height:6px;border-radius:50%;background:${color};display:inline-block;margin-right:6px;vertical-align:middle;"></span>`
      : '';
    const activeStyle = active
      ? 'border-color:var(--accent);background:rgba(0,212,255,.10);color:var(--text);'
      : 'border-color:rgba(255,255,255,.08);background:transparent;color:var(--muted);';
    return `<button onclick="${onclick}" style="padding:5px 12px;border-radius:8px;font-size:12px;font-weight:500;cursor:pointer;white-space:nowrap;border:1px solid;transition:.15s;letter-spacing:-.005em;${activeStyle}">${dot}${label}</button>`;
  };

  const cats = [
    {k:'all',         label:'Todas',     color:null},
    {k:'entrada',     label:'Entrada',   color:'#00e5a0'},
    {k:'saida-fixa',  label:'Saída fixa',color:'#ff5b70'},
    {k:'variavel',    label:'Variável',  color:'#b085f5'},
    {k:'funcionario', label:'Funcionário',color:'#ffb347'},
    {k:'comida',      label:'Comida',    color:'#4ecdc4'},
  ].map(c => pill(s.dashCat===c.k, c.color, c.label, `window._dashSetCat('${c.k}')`)).join('');

  const origens = [
    {k:'all',      label:'Todos'},
    {k:'whatsapp', label:'WhatsApp'},
    {k:'manual',   label:'Manual'},
    {k:'banco',    label:'Banco'},
  ].map(o => pill(s.dashOrigem===o.k, null, o.label, `window._dashSetOrigem('${o.k}')`)).join('');

  const sortOpts = [
    {k:'createdAt',   label:'Mais recente'},
    {k:'date_desc',   label:'Data ↓'},
    {k:'date_asc',    label:'Data ↑'},
    {k:'amount_desc', label:'Maior valor'},
    {k:'amount_asc',  label:'Menor valor'},
  ].map(o=>`<option value="${o.k}" ${s.dashSort===o.k?'selected':''}>${o.label}</option>`).join('');

  el.innerHTML = `
    <div style="margin-bottom:14px;">
      <!-- Linha única de filtros -->
      <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:10px;">
        ${cats}
        <span style="width:1px;height:18px;background:rgba(255,255,255,.08);margin:0 4px;"></span>
        ${origens}
        <select onchange="window._dashSetSort(this.value)" style="margin-left:auto;padding:5px 10px;border-radius:8px;font-size:12px;font-weight:500;background:transparent;border:1px solid rgba(255,255,255,.08);color:var(--muted);cursor:pointer;outline:none;letter-spacing:-.005em;">${sortOpts}</select>
      </div>
      <!-- Resumo discreto -->
      <div style="display:flex;gap:20px;flex-wrap:wrap;font-size:12px;color:var(--muted);padding-left:2px;">
        <span>Entradas <strong class="num" style="color:var(--success);font-weight:600;margin-left:4px;">${fmt(inF)}</strong></span>
        <span>Saídas <strong class="num" style="color:var(--alert);font-weight:600;margin-left:4px;">${fmt(outF)}</strong></span>
        <span>Saldo <strong class="num" style="${inF-outF>=0?'color:var(--success)':'color:var(--alert)'};font-weight:600;margin-left:4px;">${fmt(inF-outF)}</strong></span>
      </div>
    </div>`;

  // Handlers globais (simples, sem EventListener duplicado)
  window._dashSetCat    = cat  => { s.dashCat    = cat;  s.dashShowAll=false; renderHome(); };
  window._dashSetSort   = sort => { s.dashSort   = sort; s.dashShowAll=false; renderHome(); };
  window._dashSetOrigem = or   => { s.dashOrigem = or;   s.dashShowAll=false; renderHome(); };
}

// ─── DASHBOARD ────────────────────────────────────────────────
function renderHome(){
  const cats = activeCats();

  // Transações reais do mês selecionado
  const realF = s.txs.filter(t=>{
    if(!t.date)return false;
    const[y,m]=t.date.split('-').map(Number);
    return y===s.fY&&m===s.fM && _catActive(t.category);
  });
  // Instâncias virtuais de recorrentes (originaram em meses anteriores)
  const virtF = getMonthRecurrentInstances(s.fY, s.fM);
  const f = [...realF, ...virtF];

  const sum=cat=>f.filter(t=>t.category===cat).reduce((a,t)=>a+Number(t.amount||0),0);
  const tIn=f.filter(t=>t.category==='entrada').reduce((a,t)=>a+Number(t.amount||0),0);
  const tOut=f.filter(t=>t.category!=='entrada').reduce((a,t)=>a+Number(t.amount||0),0);

  // Saldo anterior cumulativo (todos os meses antes do selecionado)
  const prevBal  = calcPreviousBalance(s.fY, s.fM);
  const monthNet = tIn - tOut;       // resultado só deste mês
  const netNow   = prevBal + monthNet; // saldo atual considerando tudo

  // Label do mês corrente (chip ao lado de "Saldo Atual")
  const mLabel = $('t-resumo-month');
  if(mLabel) mLabel.textContent = `${MONTHS[s.fM-1]} ${s.fY}`;

  // Detalhes por categoria
  animateVal('t-s-in',sum('entrada')); animateVal('t-s-out-f',sum('saida-fixa'));
  animateVal('t-s-staff', cats['funcionario'] ? sum('funcionario') : 0);
  animateVal('t-s-food',  cats['comida']      ? sum('comida')      : 0);
  animateVal('t-s-var',sum('variavel'));

  // Totais do mês
  animateVal('t-t-in',tIn);
  animateVal('t-t-out',tOut);

  // Saldo anterior + resultado do mês + saldo atual
  animateVal('t-prev-bal',  prevBal);
  animateVal('t-month-net', monthNet);
  animateVal('t-t-net',     netNow);

  // Cores dinâmicas (verde/vermelho) — usa classes em vez de style inline
  const setCls = (id, val) => {
    const el = $(id); if(!el) return;
    el.classList.remove('pos','neg');
    el.classList.add(val>=0?'pos':'neg');
  };
  setCls('t-t-net',     netNow);
  setCls('t-prev-bal',  prevBal);
  setCls('t-month-net', monthNet);

  // Oculta linhas (bd-row) das features desativadas
  const staffRow = $('t-s-staff')?.closest('.bd-row');
  if(staffRow) staffRow.style.display = cats['funcionario']?'':'none';
  const foodRow = $('t-s-food')?.closest('.bd-row');
  if(foodRow)  foodRow.style.display  = cats['comida']?'':'none';

  // ── Filtros do dashboard ──────────────────────────────────────
  renderDashFilters(f);

  let filtered = [...f];

  // Filtro por categoria
  if(s.dashCat !== 'all') filtered = filtered.filter(t => t.category === s.dashCat);

  // Filtro por origem
  if(s.dashOrigem !== 'all') filtered = filtered.filter(t => getOrigem(t) === s.dashOrigem);

  // Filtro por busca em tempo real (descrição/categoria)
  if (s.dashSearch && s.dashSearch.trim()) {
    const q = normQ(s.dashSearch.trim());
    filtered = filtered.filter(t => {
      const d = normQ(t.description || '');
      const c = normQ(CATS[t.category]?.label || '');
      return d.includes(q) || c.includes(q);
    });
  }

  // Ordenação
  if(s.dashSort === 'createdAt'){
    filtered.sort((a,b) => (getCreatedAtMs(b) || 0) - (getCreatedAtMs(a) || 0));
  } else if(s.dashSort === 'date_desc'){
    filtered.sort((a,b) => (b.date||'').localeCompare(a.date||''));
  } else if(s.dashSort === 'date_asc'){
    filtered.sort((a,b) => (a.date||'').localeCompare(b.date||''));
  } else if(s.dashSort === 'amount_desc'){
    filtered.sort((a,b) => Number(b.amount||0) - Number(a.amount||0));
  } else if(s.dashSort === 'amount_asc'){
    filtered.sort((a,b) => Number(a.amount||0) - Number(b.amount||0));
  }

  // Contagem
  const cEl=$('t-tx-count'); if(cEl) cEl.textContent=`${filtered.length} registro${filtered.length!==1?'s':''}`;

  const txList=$('t-tx-list'); if(!txList) return;

  // Paginação
  const PAGE = 25;
  const paged = s.dashShowAll ? filtered : filtered.slice(0, PAGE);

  // "Ver mais"
  const vmWrap = $('t-dash-ver-mais-wrap');
  if(vmWrap){
    if(!s.dashShowAll && filtered.length > PAGE){
      vmWrap.style.display = 'block';
      vmWrap.innerHTML = `<button onclick="window._dashVerMais()" style="padding:8px 24px;border-radius:20px;border:1px solid rgba(0,212,255,.25);background:rgba(0,212,255,.06);color:var(--accent);font-size:12px;font-weight:700;cursor:pointer;">Ver todas as ${filtered.length} transações ↓</button>`;
    } else {
      vmWrap.style.display = 'none';
    }
  }
  window._dashVerMais = () => { s.dashShowAll = true; renderHome(); };

  txList.innerHTML = paged.map(t=>{
    const cat=cats[t.category]||CATS.variavel, isIn=t.category==='entrada', vc=isIn?'var(--success)':'var(--alert)';
    const isVirt = t.isVirtual===true;
    const badge  = isVirt ? '' : getOrigemBadge(t);
    const actions = isVirt
      ? `<span title="Recorrente automático" style="font-size:10px;padding:3px 8px;border-radius:6px;background:rgba(255,179,71,.12);color:var(--warning);font-weight:700;">🔄 RECORRENTE</span>`
      : `<button class="btn-act edit" data-id="${t.id}" data-action="edit">✎</button>
         <button class="btn-act del"  data-id="${t.id}" data-action="delete">🗑</button>`;
    return `<tr style="--card-accent:${cat.color};">
      <td data-label="Data" style="color:var(--muted);font-family:'DM Mono',monospace;font-size:13px;white-space:nowrap;">${fD(t.date)}</td>
      <td data-label="Categoria"><span class="cat-badge" style="background:${cat.color}22;color:${cat.color};">${cat.label}</span></td>
      <td data-label="Descrição" style="font-weight:600;">${esc(t.description||'—')}${isVirt?' <span style="font-size:10px;color:var(--muted);">·rec</span>':''}<div style="margin-top:2px;">${badge}</div></td>
      <td data-label="Valor" style="text-align:right;font-family:'DM Mono',monospace;font-weight:700;color:${vc};white-space:nowrap;">${isIn?'+':'-'} ${fmt(t.amount)}</td>
      <td data-label="Ações" class="td-actions-cell" style="text-align:right;"><div class="td-actions">${actions}</div></td></tr>`;
  }).join('')||`<tr><td colspan="5" style="text-align:center;padding:56px;color:var(--muted);">Sem registros para este período.</td></tr>`;

  if(!window.Chart) return;
  if(charts.pie){charts.pie.destroy();charts.pie=null;}
  if(charts.bar){charts.bar.destroy();charts.bar=null;}

  const pieC=$('t-c-pie'), barC=$('t-c-bar');
  // Gráfico usa apenas as categorias activas
  const catEntries = Object.entries(cats);
  if(pieC) charts.pie=new window.Chart(pieC,{type:'doughnut',data:{labels:catEntries.map(([,c])=>c.label),datasets:[{data:catEntries.map(([k])=>sum(k)),backgroundColor:catEntries.map(([,c])=>c.color),borderWidth:0,hoverOffset:10}]},options:{cutout:'72%',responsive:true,maintainAspectRatio:false,animation:{duration:700},plugins:{legend:{display:true,position:'bottom',labels:{color:'rgba(228,240,246,.5)',font:{size:11},padding:14,boxWidth:10}},tooltip:{backgroundColor:'rgba(5,13,18,.92)',borderColor:'rgba(0,212,255,.2)',borderWidth:1,callbacks:{label:ctx=>` ${ctx.label}: ${fmt(ctx.parsed)}`}}}}});

  // Gráfico de 6 meses — também considera recorrentes virtuais
  const last6=[];
  for(let i=5;i>=0;i--){
    const d=new Date(); d.setDate(1); d.setMonth(d.getMonth()-i);
    const m=d.getMonth()+1, y=d.getFullYear();
    const real = s.txs.filter(t=>{
      if(!t.date) return false;
      const[ty,tm]=t.date.split('-').map(Number);
      return ty===y&&tm===m && _catActive(t.category);
    });
    const virt = getMonthRecurrentInstances(y, m);
    const all = [...real, ...virt];
    last6.push({
      label: MONTHS[m-1].slice(0,3),
      in:  all.filter(t=>t.category==='entrada').reduce((a,t)=>a+Number(t.amount||0),0),
      out: all.filter(t=>t.category!=='entrada').reduce((a,t)=>a+Number(t.amount||0),0)
    });
  }
  if(barC) charts.bar=new window.Chart(barC,{type:'bar',data:{labels:last6.map(d=>d.label),datasets:[{label:'Entradas',data:last6.map(d=>d.in),backgroundColor:'rgba(0,229,160,.55)',borderRadius:6,borderSkipped:false},{label:'Saídas',data:last6.map(d=>d.out),backgroundColor:'rgba(255,91,112,.5)',borderRadius:6,borderSkipped:false}]},options:{responsive:true,maintainAspectRatio:false,animation:{duration:600},scales:{y:{display:false},x:{grid:{display:false},border:{display:false},ticks:{color:'rgba(255,255,255,.38)',font:{size:11}}}},plugins:{legend:{display:false},tooltip:{backgroundColor:'rgba(5,13,18,.92)',borderColor:'rgba(0,212,255,.2)',borderWidth:1,callbacks:{label:c=>`${c.dataset.label}: ${fmt(c.parsed.y)}`}}}}});
}

// ─── CALENDÁRIO ───────────────────────────────────────────────
function renderCal(){
  const mEl=$('t-cal-m'); if(mEl) mEl.textContent=`${MONTHS[s.cM-1]} ${s.cY}`;
  const first=new Date(s.cY,s.cM-1,1).getDay(), days=new Date(s.cY,s.cM,0).getDate(), todayStr=new Date().toISOString().slice(0,10);
  const grid=$('t-cal-g'); if(!grid) return;
  grid.innerHTML='';
  ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'].forEach(d=>{grid.innerHTML+=`<div class="cal-day-header-label">${d}</div>`;});

  // Células vazias antes do dia 1
  for(let i=0;i<first;i++) grid.innerHTML+=`<div class="cal-day" style="opacity:.15;"></div>`;

  // Recorrentes deste mês: usa o dia cadastrado como dia do mês
  const cats=activeCats();
  const rec=s.txs.filter(t=>t.isRecorrente && _catActive(t.category));

  for(let d=1;d<=days;d++){
    const ds=`${s.cY}-${String(s.cM).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const dT=s.txs.filter(t=>t.date===ds), isT=ds===todayStr;

    // Pagamentos recorrentes que vencem neste dia do mês
    const recToday=rec.filter(t=>{
      const recDay=Number((t.date||'').split('-')[2]||0);
      return recDay===d && !dT.find(x=>x.id===t.id); // não duplicar se já tem entrada
    });
    const obKey=key=>s.obs.find(o=>o.monthKey===key);
    const allEvents=[...dT, ...recToday];

    const div=document.createElement('div');
    div.className='cal-day'+(isT?' today':'');
    if(recToday.length) div.style.outline='1.5px dashed rgba(255,179,71,.35)';

    const pills=allEvents.slice(0,2).map(t=>{
      const isPending=t.isRecorrente&&!obKey(`${t.id}_${s.cY}-${String(s.cM).padStart(2,'0')}`)?.done;
      const clr=CATS[t.category]?.color||'#888';
      return `<div class="cal-event-pill" style="--ev-color:${clr};${t.isRecorrente?'opacity:.7;':''}" title="${esc(t.description||'')}">${esc(t.description||'')}</div>`;
    }).join('');
    const extra=allEvents.length>2?`<div class="cal-more-label">+${allEvents.length-2}</div>`:'';

    div.innerHTML=`<div class="cal-day-num">${d}</div><div style="display:flex;flex-direction:column;gap:3px;margin-top:6px;overflow:hidden;">${pills}${extra}</div>`;

    div.addEventListener('click',()=>openCalDayModal(ds,allEvents));
    grid.appendChild(div);
  }
}


function openCalDayModal(ds,txs){
  const modal=$('t-cal-day-modal'), title=$('t-cal-modal-title'), body=$('t-cal-modal-body');
  if(!modal) return;
  const [y,m,d]=ds.split('-').map(Number);
  title.textContent=`${d} de ${MONTHS[m-1]} de ${y}`;

  // Botão de ação "Nova transação neste dia"
  const newTxBtn = `<button id="t-cal-day-add" style="display:inline-flex;align-items:center;gap:6px;padding:8px 14px;border-radius:8px;background:var(--accent);color:var(--bg);border:1px solid color-mix(in srgb,var(--accent) 70%,black);font-size:13px;font-weight:600;cursor:pointer;letter-spacing:-.005em;margin-bottom:16px;">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
    Nova transação neste dia
  </button>`;

  if(!txs.length){
    body.innerHTML = newTxBtn + `<div style="text-align:center;padding:36px 0;color:var(--muted);font-size:13px;letter-spacing:-.005em;">Nenhuma movimentação neste dia.</div>`;
  } else {
    const inc=txs.filter(t=>t.category==='entrada').reduce((a,t)=>a+Number(t.amount||0),0);
    const out=txs.filter(t=>t.category!=='entrada').reduce((a,t)=>a+Number(t.amount||0),0);
    body.innerHTML = newTxBtn
      + `<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px;">
          <div style="padding:10px 12px;border-radius:10px;border:1px solid var(--border);">
            <p style="font-size:11px;color:var(--muted);margin-bottom:4px;letter-spacing:-.005em;">Entradas</p>
            <p class="num" style="font-size:16px;color:var(--success);font-weight:600;">${fmt(inc)}</p>
          </div>
          <div style="padding:10px 12px;border-radius:10px;border:1px solid var(--border);">
            <p style="font-size:11px;color:var(--muted);margin-bottom:4px;letter-spacing:-.005em;">Saídas</p>
            <p class="num" style="font-size:16px;color:var(--alert);font-weight:600;">${fmt(out)}</p>
          </div>
        </div>`
      + txs.map(t=>{
          const cat=CATS[t.category]||CATS.variavel, isIn=t.category==='entrada';
          return `<div style="display:flex;align-items:center;gap:12px;padding:10px 12px;border-radius:10px;border:1px solid var(--border);margin-bottom:6px;">
            <span style="width:5px;height:24px;border-radius:3px;background:${cat.color};flex-shrink:0;"></span>
            <div style="flex:1;min-width:0;">
              <div style="font-size:13.5px;font-weight:500;letter-spacing:-.005em;">${esc(t.description||'—')}</div>
              <div style="font-size:11px;color:var(--muted);margin-top:2px;letter-spacing:-.005em;">${cat.label}</div>
            </div>
            <div class="num" style="font-weight:600;color:${isIn?'var(--success)':'var(--alert)'};font-size:14px;">${isIn?'+':'−'} ${fmt(t.amount)}</div>
          </div>`;
        }).join('');
  }
  modal.classList.add('active');

  // Wire up: clica em "Nova transação neste dia" → fecha modal do calendário,
  // pré-preenche data e abre o modal de nova transação
  setTimeout(() => {
    const btn = $('t-cal-day-add');
    btn?.addEventListener('click', () => {
      modal.classList.remove('active');
      // Pré-define a data no modal de nova transação
      const dateInput = $('t-a-date');
      if (dateInput) dateInput.value = ds; // YYYY-MM-DD
      // Abre o modal
      $('t-m-add')?.classList.add('active');
    });
  }, 0);
}

// ─── OBRIGAÇÕES ───────────────────────────────────────────────
function renderOb(){
  const rec=s.txs.filter(t=>t.isRecorrente && _catActive(t.category));
  const list=$('t-ob-list'); if(!list) return;
  if(!rec.length){list.innerHTML=`<div style="text-align:center;padding:60px;color:var(--muted);">Nenhuma obrigação recorrente cadastrada.</div>`;return;}
  list.innerHTML=rec.map(t=>{
    const key=`${t.id}_${s.fY}-${String(s.fM).padStart(2,'0')}`;
    const ob=s.obs.find(o=>o.monthKey===key), done=ob?.done||false, cat=CATS[t.category]||CATS.variavel;
    return `<div class="ob-item" style="opacity:${done?.6:1};">
      <button class="ob-check${done?' done':''}" data-id="${t.id}" aria-label="${done?'Marcar pendente':'Marcar pago'}"></button>
      <div style="flex:1;min-width:0;line-height:1.35;">
        <div style="font-size:14px;font-weight:500;color:var(--text);letter-spacing:-.005em;${done?'text-decoration:line-through;color:var(--muted);':''}">${esc(t.description||'—')}</div>
        <div style="font-size:12px;color:var(--muted);margin-top:3px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;letter-spacing:-.005em;">
          <span style="display:inline-flex;align-items:center;gap:5px;"><span style="width:6px;height:6px;border-radius:50%;background:${cat.color};display:inline-block;"></span>${cat.label}</span>
          <span style="opacity:.6;">·</span>
          <span>Vence dia ${(t.date||'').split('-')[2]||'—'}</span>
          ${done?'<span style="opacity:.6;">·</span><span style="color:var(--success);">Pago</span>':''}
        </div>
      </div>
      <div class="num" style="font-weight:600;color:var(--text);font-size:14px;flex-shrink:0;">${fmt(t.amount)}</div>
      <button class="ob-del" data-id="${t.id}" aria-label="Excluir recorrência" title="Excluir esta recorrência" style="width:30px;height:30px;border-radius:7px;background:transparent;border:1px solid var(--border);color:var(--muted);cursor:pointer;flex-shrink:0;display:grid;place-items:center;transition:color .15s, border-color .15s;">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>
      </button>
    </div>`;
  }).join('');

  $$('.ob-check').forEach(btn=>{
    btn.addEventListener('click',async()=>{
      const id=btn.dataset.id, key=`${id}_${s.fY}-${String(s.fM).padStart(2,'0')}`, ob=s.obs.find(o=>o.monthKey===key);
      try{
        if(ob) await updateDoc(doc(db,'obrigacoes',ob.id),{done:!ob.done,updatedAt:Date.now()});
        else{ const tx=s.txs.find(t=>t.id===id); await setDoc(doc(db,'obrigacoes',key),{monthKey:key,txId:id,desc:tx?.description||'',amount:tx?.amount||0,category:tx?.category||'',month:s.fM,year:s.fY,done:true,createdAt:Date.now(),companyId:s.companyId}); }
        toast(ob?.done?'↺ Marcado como pendente':'✓ Marcado como pago');
      }catch(e){toast('Erro ao atualizar',true);}
    });
  });

  // Botão de excluir recorrência (ex: funcionário que saiu)
  $$('.ob-del').forEach(btn=>{
    btn.addEventListener('click',async()=>{
      const id=btn.dataset.id;
      const tx=s.txs.find(t=>t.id===id);
      if(!tx) return;
      const msg=`Excluir a recorrência "${tx.description}" (${fmt(tx.amount)})?\n\n` +
                `⚠ Isso vai REMOVER esta saída fixa para sempre.\n` +
                `Os meses anteriores onde ela já foi descontada vão deixar de contar.\n\n` +
                `Use isso quando o funcionário saiu, o contrato encerrou, etc.`;
      if(!confirm(msg)) return;
      try{
        // 1. Apaga a transação original
        await deleteDoc(doc(db,'transactions',id));
        // 2. Apaga TODOS os registros de obrigação relacionados
        //    (busca por txId no cache local)
        const obsToDelete = s.obs.filter(o=>o.txId===id);
        await Promise.all(obsToDelete.map(o=>deleteDoc(doc(db,'obrigacoes',o.id))));
        toast('🗑 Recorrência excluída');
      }catch(e){
        console.error(e);
        toast('Erro ao excluir',true);
      }
    });
  });
}

// ─── RELATÓRIOS ───────────────────────────────────────────────

// Retorna as datas [ini, fim] ISO para o filtro activo
function repDateRange(){
  const now=new Date();
  const iso=d=>d.toISOString().slice(0,10);
  const y=now.getFullYear(), m=now.getMonth();
  if(s.repFilter==='semanal'){
    const d=new Date(now);d.setDate(d.getDate()-6);
    return [iso(d), iso(now)];
  }
  if(s.repFilter==='mes_atual'){
    return [`${y}-${String(m+1).padStart(2,'0')}-01`, iso(now)];
  }
  if(s.repFilter==='mes_passado'){
    const pm=m===0?12:m, py=m===0?y-1:y;
    const last=new Date(y,m,0).getDate();
    return [`${py}-${String(pm).padStart(2,'0')}-01`, `${py}-${String(pm).padStart(2,'0')}-${String(last).padStart(2,'0')}`];
  }
  if(s.repFilter==='trimestre'){
    const d=new Date(now);d.setMonth(d.getMonth()-3);
    return [iso(d), iso(now)];
  }
  if(s.repFilter==='anual'){
    return [`${y}-01-01`, `${y}-12-31`];
  }
  if(s.repFilter==='personalizado'){
    return [s.repCustomIni||`${y}-01-01`, s.repCustomFim||iso(now)];
  }
  return [`${y}-${String(m+1).padStart(2,'0')}-01`, iso(now)];
}

// Rótulo legível do período
function repPeriodLabel(){
  const [ini,fim]=repDateRange();
  const fmt2=iso=>iso.split('-').reverse().join('/');
  const labels={semanal:'Últimos 7 dias',mes_atual:'Mês atual',mes_passado:'Mês passado',trimestre:'Últimos 3 meses',anual:'Ano atual',personalizado:'Período personalizado'};
  return `${labels[s.repFilter]||''} · ${fmt2(ini)} a ${fmt2(fim)}`;
}

function filterForRep(txt=''){
  const cats=activeCats();
  const [ini,fim]=repDateRange();
  // Expande recorrentes virtuais para que apareçam em todos os meses do range
  const expanded = getExpandedTxsInRange(ini, fim);
  let data = expanded.filter(t=>{
    if(!t.date) return false;
    if(t.category==='funcionario'&&!cats['funcionario']) return false;
    if(t.category==='comida'&&!cats['comida']) return false;
    if(s.repCat!=='all'&&t.category!==s.repCat) return false;
    if(txt){const q=txt.toLowerCase();if(!(t.description||'').toLowerCase().includes(q)&&!(t.category||'').toLowerCase().includes(q)&&!(t.date||'').includes(q)) return false;}
    return true;
  });
  data.sort((a,b)=>(b.date||'').localeCompare(a.date||''));
  return data;
}

function renderRep(){
  const searchTxt=($('rep-search')?.value||'').trim();
  const filtered=filterForRep(searchTxt);
  const cats=activeCats();
  const tIn  = filtered.filter(t=>t.category==='entrada').reduce((a,t)=>a+Number(t.amount||0),0);
  const tOut = filtered.filter(t=>t.category!=='entrada').reduce((a,t)=>a+Number(t.amount||0),0);
  const net  = tIn-tOut;
  const setEl=(id,val,color)=>{const el=$(id);if(!el)return;el.textContent=fmt(val);el.style.color=color;};
  setEl('t-rep-in',tIn,'var(--success)'); setEl('t-rep-out',tOut,'var(--alert)'); setEl('t-rep-net',net,net>=0?'var(--success)':'var(--alert)');
  const cEl=$('t-rep-count'); if(cEl){cEl.textContent=filtered.length;cEl.style.color='var(--warning)';}
  const lblEl=$('rep-period-label'); if(lblEl) lblEl.textContent=repPeriodLabel();

  // Botões de filtro de período
  $$('.t-rep-filter').forEach(btn=>{
    const a=btn.dataset.rep===s.repFilter;
    btn.style.borderColor=a?'var(--accent)':'var(--border)';
    btn.style.background=a?'rgba(0,212,255,.12)':'transparent';
    btn.style.color=a?'var(--accent)':'var(--muted)';
  });
  // Botões de filtro de categoria
  $$('.t-rep-cat-filter').forEach(btn=>{
    const a=btn.dataset.cat===s.repCat;
    btn.style.borderColor=a?'var(--accent)':'var(--border)';
    btn.style.background=a?'rgba(0,212,255,.12)':'transparent';
    btn.style.color=a?'var(--accent)':'var(--muted)';
  });
  // Painel de datas personalizadas
  const cdEl=$('rep-custom-dates');
  if(cdEl) cdEl.style.display=s.repFilter==='personalizado'?'flex':'none';
  // Botão limpar
  const hasFilter=s.repFilter!=='mes_atual'||s.repCat!=='all'||searchTxt;
  const clrBtn=$('rep-clear-filters'); if(clrBtn) clrBtn.style.display=hasFilter?'inline-flex':'none';

  const repList=$('t-rep-list'); if(!repList) return;
  repList.innerHTML=filtered.map(t=>{
    const cat=cats[t.category]||CATS.variavel,isIn=t.category==='entrada',vc=isIn?'var(--success)':'var(--alert)';
    const isVirt = t.isVirtual===true;
    // Highlight search term
    let desc=esc(t.description||'—');
    if(searchTxt){const re=new RegExp('('+searchTxt.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+')','gi');desc=desc.replace(re,'<mark style="background:rgba(0,212,255,.25);color:var(--accent);border-radius:3px;padding:0 2px;">$1</mark>');}
    const actions = isVirt
      ? `<span title="Recorrente automático" style="font-size:10px;padding:3px 8px;border-radius:6px;background:rgba(255,179,71,.12);color:var(--warning);font-weight:700;">🔄 REC</span>`
      : `<button class="btn-act edit" data-id="${t.id}" data-action="edit">✎</button>
         <button class="btn-act del"  data-id="${t.id}" data-action="delete">🗑</button>`;
    return `<tr style="--card-accent:${cat.color};">
      <td data-label="Data" style="color:var(--muted);font-family:'DM Mono',monospace;font-size:13px;white-space:nowrap;">${fD(t.date)}</td>
      <td data-label="Categoria"><span class="cat-badge" style="background:${cat.color}22;color:${cat.color};">${cat.label}</span></td>
      <td data-label="Descrição" style="font-weight:600;">${desc}${isVirt?' <span style="font-size:10px;color:var(--muted);">·rec</span>':''}</td>
      <td data-label="Valor" style="text-align:right;font-family:'DM Mono',monospace;font-weight:700;color:${vc};white-space:nowrap;">${isIn?'+':'-'} ${fmt(t.amount)}</td>
      <td data-label="Ações" class="td-actions-cell" style="text-align:right;"><div class="td-actions">${actions}</div></td>
    </tr>`;
  }).join('')||`<tr><td colspan="5" style="text-align:center;padding:56px;color:var(--muted);">
    <div style="font-size:28px;opacity:.25;margin-bottom:12px;">🔍</div>
    Nenhuma transação encontrada para este filtro.
    ${hasFilter?'<br><button onclick="window._repClearFilters&&window._repClearFilters()" style="margin-top:12px;padding:7px 16px;border-radius:20px;background:rgba(0,212,255,.1);border:1px solid rgba(0,212,255,.25);color:var(--accent);font-size:12px;font-weight:700;cursor:pointer;">Limpar filtros</button>':''}
  </td></tr>`;
}

// ─── ABA A PAGAR ──────────────────────────────────────────────
function renderPagar(){
  // Calcula obrigações pendentes do mês actual
  const rec=s.txs.filter(t=>t.isRecorrente && _catActive(t.category));
  let totalPendente=0, totalPago=0;

  const items=rec.map(t=>{
    const key=`${t.id}_${s.fY}-${String(s.fM).padStart(2,'0')}`;
    const ob=s.obs.find(o=>o.monthKey===key);
    const done=ob?.done||false;
    const val=Number(t.amount||0);
    if(done) totalPago+=val; else totalPendente+=val;
    const cat=CATS[t.category]||CATS.variavel;
    return {t, done, val, cat};
  });

  // KPIs
  const kpiPend=$('t-pagar-pendente'); if(kpiPend){kpiPend.textContent=fmt(totalPendente);}
  const kpiPago=$('t-pagar-pago');     if(kpiPago){kpiPago.textContent=fmt(totalPago);}
  const kpiTotal=$('t-pagar-total');   if(kpiTotal){kpiTotal.textContent=fmt(totalPendente+totalPago);}

  // Lista pendentes
  const pendList=$('t-pagar-pend-list');
  if(pendList){
    const pendentes=items.filter(i=>!i.done);
    pendList.innerHTML=pendentes.length ? pendentes.map(({t,val,cat})=>`
      <div class="glass ob-item" style="margin-bottom:12px;">
        <div style="width:10px;height:10px;border-radius:50%;background:var(--alert);flex-shrink:0;"></div>
        <div style="flex:1;min-width:0;">
          <div style="font-size:15px;font-weight:700;">${esc(t.description||'—')}</div>
          <div style="font-size:11px;color:var(--muted);margin-top:4px;display:flex;gap:8px;flex-wrap:wrap;">
            <span style="padding:3px 8px;border-radius:5px;background:${cat.color}22;color:${cat.color};">${cat.label}</span>
            <span>Vence dia ${(t.date||'').split('-')[2]||'—'}</span>
          </div>
        </div>
        <div style="font-family:'DM Mono',monospace;font-weight:800;color:var(--alert);font-size:18px;flex-shrink:0;">${fmt(val)}</div>
      </div>`).join('')
    : `<div style="text-align:center;padding:40px;color:var(--success);font-size:14px;font-weight:700;">✓ Tudo em dia! Nenhuma pendência este mês.</div>`;
  }

  // Lista pagas
  const pagoList=$('t-pagar-pago-list');
  if(pagoList){
    const pagos=items.filter(i=>i.done);
    pagoList.innerHTML=pagos.length ? pagos.map(({t,val,cat})=>`
      <div class="glass ob-item" style="opacity:.6;margin-bottom:12px;">
        <div style="width:10px;height:10px;border-radius:50%;background:var(--success);flex-shrink:0;"></div>
        <div style="flex:1;min-width:0;">
          <div style="font-size:15px;font-weight:700;text-decoration:line-through;color:var(--muted);">${esc(t.description||'—')}</div>
          <div style="font-size:11px;color:var(--muted);margin-top:4px;"><span style="color:var(--success);">✓ Pago</span></div>
        </div>
        <div style="font-family:'DM Mono',monospace;font-weight:800;color:var(--muted);font-size:18px;flex-shrink:0;text-decoration:line-through;">${fmt(val)}</div>
      </div>`).join('')
    : `<div style="text-align:center;padding:40px;color:var(--muted);font-size:14px;">Nenhum pagamento confirmado este mês ainda.</div>`;
  }
}

// ─── CONTA / USUÁRIOS AUTORIZADOS ─────────────────────────────
async function renderUsers(){
  const grid=$('t-u-grid'); if(!grid) return;
  const u=s.user; if(!u){grid.innerHTML='<p style="color:var(--muted);font-size:13px;padding:20px;">Carregando...</p>';return;}
  const displayName=u.displayName||u.username||'Usuário';
  const initial=displayName.charAt(0).toUpperCase();
  const roleLabel = u.role==='master' ? 'Administrador'
                   : u.role==='personal' ? 'Pessoal' : 'Usuário';

  // Busca foto do Firestore (fonte da verdade)
  let photoBase64 = '';
  try {
    const snap = await getDoc(doc(db,'users',u.uid));
    photoBase64 = snap.data()?.photoBase64 || '';
  } catch (e) {}

  const avatarInner = photoBase64
    ? `<img src="${photoBase64}" style="width:100%;height:100%;object-fit:cover;display:block;">`
    : `<span style="font-size:18px;font-weight:600;color:var(--accent);">${initial}</span>`;

  grid.innerHTML = `
    <div style="background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:14px;display:flex;align-items:center;gap:14px;">
      <div style="width:44px;height:44px;border-radius:10px;background:var(--bg3);border:1px solid var(--border);overflow:hidden;display:grid;place-items:center;flex-shrink:0;">${avatarInner}</div>
      <div style="flex:1;min-width:0;line-height:1.3;">
        <div style="font-size:14px;font-weight:600;color:var(--text);letter-spacing:-.015em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(displayName)}</div>
        <div style="font-size:12px;color:var(--muted);margin-top:2px;letter-spacing:-.005em;">@${esc(u.username||displayName.toLowerCase())} · ${roleLabel}</div>
      </div>
      <span style="padding:2px 8px;border-radius:6px;background:rgba(74,222,128,.12);color:#4ade80;font-size:10px;font-weight:500;letter-spacing:.02em;flex-shrink:0;">Você</span>
    </div>`;
}

// ─── SAVE / EDIT / DELETE TX ──────────────────────────────────
async function saveTx(){
  const cat=$('t-a-cat').value, desc=$('t-a-desc').value.trim();
  const raw=$('t-a-val').value.replace(/[R$\s.]/g,'').replace(',','.'), val=parseFloat(raw), date=$('t-a-date').value;
  if(!desc){toast('⚠ Preencha a descrição',true);return;}
  if(!val||val<=0){toast('⚠ Valor inválido',true);return;}
  if(!date){toast('⚠ Selecione a data',true);return;}
  try{
    await addDoc(collection(db,'transactions'),{category:cat,description:desc,amount:val,date,isRecorrente:CATS[cat]?.isRec||false,createdBy:s.user?.username||'unknown',createdAt:Date.now(),companyId:s.companyId});
    $('t-a-desc').value='';$('t-a-val').value='';$('t-a-date').valueAsDate=new Date();$('t-rec-hint').style.display='none';
    toggleModal(false);toast('✓ Transação registrada');
  }catch(e){toast('Erro ao salvar',true);}
}

async function editTxSave(id){
  const cat=$('t-a-cat').value, desc=$('t-a-desc').value.trim();
  const raw=$('t-a-val').value.replace(/[R$\s.]/g,'').replace(',','.'), val=parseFloat(raw), date=$('t-a-date').value;
  if(!desc){toast('⚠ Preencha a descrição',true);return;}
  if(!val||val<=0){toast('⚠ Valor inválido',true);return;}
  try{
    await updateDoc(doc(db,'transactions',id),{category:cat,description:desc,amount:val,date,isRecorrente:CATS[cat]?.isRec||false,updatedBy:s.user?.username||'unknown',updatedAt:Date.now()});
    const b=$('t-btn-save');if(b){b._editId=null;b.textContent='✓ Registrar no Sistema';}
    $('t-a-desc').value='';$('t-a-val').value='';$('t-a-date').valueAsDate=new Date();$('t-rec-hint').style.display='none';
    toggleModal(false);toast('✓ Transação atualizada');
  }catch(e){toast('Erro ao atualizar',true);}
}

async function deleteTx(id){
  const tx=s.txs.find(t=>t.id===id);
  if(!confirm(`Excluir "${tx?.description}" (${fmt(tx?.amount)})?`)) return;
  try{await deleteDoc(doc(db,'transactions',id));toast('🗑 Transação excluída');}
  catch(e){toast('Erro ao excluir',true);}
}

// ─── EXCEL EXPORT ─────────────────────────────────────────────
function exportRepExcel(){
  if(!window.XLSX){toast('XLSX não disponível',true);return;}
  const data=filterForRep(($('rep-search')?.value||'').trim());
  if(!data.length){toast('Nenhum dado para exportar.',true);return;}
  const cats=activeCats();
  const rows=data.map(t=>({
    'Data':t.date||'',
    'Descrição':t.description||'',
    'Categoria':cats[t.category]?.label||t.category||'',
    'Tipo':t.category==='entrada'?'ENTRADA':'SAÍDA',
    'Valor':Number(t.amount||0),
    'Recorrente':t.isRecorrente?'Sim':'Não',
  }));
  const wb=XLSX.utils.book_new();
  const ws=XLSX.utils.json_to_sheet(rows);
  ws['!cols']=[{wch:12},{wch:30},{wch:20},{wch:10},{wch:14},{wch:12}];
  XLSX.utils.book_append_sheet(wb,ws,'Transações');
  const [ini,fim]=repDateRange();
  XLSX.writeFile(wb,`lumin_${ini}_${fim}.xlsx`);
  toast('✓ Excel exportado com sucesso!');
}

// ─── PDF ──────────────────────────────────────────────────────
function generatePDF(period){
  if(!window.jspdf){toast('PDF não disponível',true);return;}
  // Normaliza texto para PDF — remove acentos que causam espaçamento quebrado
  const N=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^\x00-\xFF]/g,'?');
  const filtered=filterForRep(($('rep-search')?.value||'').trim());
  const now=new Date();
  const inc=filtered.filter(t=>t.category==='entrada').reduce((a,t)=>a+Number(t.amount||0),0);
  const out=filtered.filter(t=>t.category!=='entrada').reduce((a,t)=>a+Number(t.amount||0),0);
  const bal=inc-out;
  const{jsPDF}=window.jspdf;
  const pd=new jsPDF({orientation:'portrait',unit:'mm',format:'a4'});
  const today=now.toLocaleDateString('pt-BR');
  const pNames={semanal:'Últimos 7 Dias',mes_atual:'Mês Atual',mes_passado:'Mês Passado',trimestre:'Trimestre',anual:'Ano Atual',personalizado:'Período Personalizado'};
  const cn=s.company?.name||'Lumin';
  pd.setFillColor(5,13,18);pd.rect(0,0,210,297,'F');
  pd.setFillColor(0,100,140);pd.rect(0,0,210,42,'F');
  pd.setFont('helvetica','bold');pd.setFontSize(26);pd.setTextColor(255,255,255);pd.text('LUMIN',14,20);
  pd.setFont('helvetica','normal');pd.setFontSize(10);pd.setTextColor(180,230,255);
  pd.text('Relatorio Financeiro - '+(pNames[period]||period)+' - '+N(cn),14,30);pd.text('Gerado em '+today,196,30,{align:'right'});
  [{x:14,label:'Total Entradas',val:'R$ '+fmtN(inc),fc:[235,252,245],tc:[0,120,70]},{x:80,label:'Total Saídas',val:'R$ '+fmtN(out),fc:[255,235,238],tc:[160,30,40]},{x:146,label:'Saldo Líquido',val:'R$ '+fmtN(bal),fc:bal>=0?[235,252,245]:[255,235,238],tc:bal>=0?[0,120,70]:[160,30,40]}].forEach(({x,label,val,fc,tc})=>{pd.setFillColor(...fc);pd.roundedRect(x,48,56,24,2,2,'F');pd.setFontSize(7.5);pd.setFont('helvetica','normal');pd.setTextColor(80,80,80);pd.text(label,x+4,55);pd.setFontSize(11);pd.setFont('helvetica','bold');pd.setTextColor(...tc);pd.text(val,x+4,65);});
  if(filtered.length){pd.autoTable({startY:80,
    head:[['Data','Descricao','Categoria','Valor']],
    body:filtered.sort((a,b)=>b.date.localeCompare(a.date)).map(t=>[
      fD(t.date),N(t.description)||'-',N(CATS[t.category]?.label||t.category),
      (t.category==='entrada'?'+ ':'- ')+'R$ '+fmtN(t.amount)
    ]),
    styles:{fontSize:9,cellPadding:4,font:'helvetica',overflow:'linebreak'},
    headStyles:{fillColor:[0,100,140],textColor:[255,255,255],fontStyle:'bold',font:'helvetica'},
    alternateRowStyles:{fillColor:[246,250,253]},
    columnStyles:{0:{cellWidth:24},1:{cellWidth:'auto'},2:{cellWidth:36},3:{halign:'right',cellWidth:32}},
    foot:[['','','Entradas','R$ '+fmtN(inc)],['','','Saidas','R$ '+fmtN(out)],['','','Saldo','R$ '+fmtN(bal)]],
    footStyles:{fillColor:[240,248,255],textColor:[0,80,120],fontStyle:'bold',font:'helvetica'}
  });}
  const ph=pd.internal.pageSize.height;pd.setDrawColor(0,100,140);pd.line(14,ph-14,196,ph-14);
  pd.setFontSize(8);pd.setFont('helvetica','normal');pd.setTextColor(80,80,80);
  pd.text('Lumin - '+N(cn),14,ph-8);pd.text(today,196,ph-8,{align:'right'});
  pd.save(`lumin-${period}-${today.replace(/\//g,'-')}.pdf`);
  toast('✓ PDF gerado com sucesso');
}

// ─── COMPRESSÃO DE IMAGEM ─────────────────────────────────────
function compressImage(file,maxPx=300,quality=0.78){
  return new Promise((res,rej)=>{
    const r=new FileReader();
    r.onerror=()=>rej(new Error('Leitura falhou'));
    r.onload=e=>{
      const img=new Image();
      img.onerror=()=>rej(new Error('Imagem inválida'));
      img.onload=()=>{
        const ratio=Math.min(maxPx/img.width,maxPx/img.height,1);
        const canvas=document.createElement('canvas');
        canvas.width=Math.round(img.width*ratio);canvas.height=Math.round(img.height*ratio);
        canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);
        res(canvas.toDataURL('image/jpeg',quality));
      };
      img.src=e.target.result;
    };
    r.readAsDataURL(file);
  });
}

// ─── INIT ─────────────────────────────────────────────────────
async function initTenantDashboard(user){
  s.user=user; s.companyId=user.companyId;

  // Reset de filtros — evita vazamento entre contas no mesmo navegador
  s.dashCat = 'all';
  s.dashOrigem = 'all';
  s.dashSort = 'createdAt';
  s.dashSearch = '';
  s.dashShowAll = false;
  s.repFilter = 'mes_atual';
  s.repCat = 'all';
  s.repCustomIni = '';
  s.repCustomFim = '';
  s.fM = new Date().getMonth()+1;
  s.fY = new Date().getFullYear();
  s.cM = new Date().getMonth()+1;
  s.cY = new Date().getFullYear();
  // Limpa input de busca da topbar
  const searchInp = $('t-smart-search'); if (searchInp) searchInp.value = '';
  const repSearchInp = $('rep-search'); if (repSearchInp) repSearchInp.value = '';

  // Ouve empresa em tempo real — features/cor actualizadas pelo admin
  // reflectem imediatamente no tenant sem precisar recarregar.
  if(_unsubCompany) _unsubCompany();
  await new Promise(resolve => {
    let firstCall = true;
    _unsubCompany = onSnapshot(doc(db,'companies',user.companyId), snap => {
      s.company  = snap.exists() ? snap.data() : null;
      s.features = s.company?.features || {};

      // Aplica tema completo (preset + cor de acento custom)
      if (s.company) {
        const preset = s.company.themePreset || 'default';
        applyTheme(preset, s.company.themeColor);
      }

      // Aplica features (mostra/oculta opções e nav items)
      applyFeatures();

      if(firstCall){ firstCall=false; resolve(); }
      else {
        // Atualização em tempo real vinda do admin master:
        // applyFeatures primeiro (DOM), depois render (dados)
        applyFeatures();
        render();
      }
    }, e => { console.error('[Tenant] empresa:', e); resolve(); });
  });

  // Preenche UI
  const displayName=user.displayName||user.username;
  const initial=displayName.charAt(0).toUpperCase();
  const uName=$('t-u-name'); if(uName) uName.textContent=displayName;
  const uRole=$('t-u-role'); if(uRole) uRole.textContent=s.company?.name||'Empresa';
  const uAv=$('t-u-av');    if(uAv)   uAv.textContent=initial;
  const tbDate=$('t-tb-date');
  if(tbDate&&window.innerWidth>768) {
    // Pega o primeiro nome real — se for "Pessoal Financeiro X", usa o último (X)
    const parts = displayName.split(' ').filter(Boolean);
    const isPersonalPrefix = parts[0]?.toLowerCase() === 'pessoal';
    const firstName = isPersonalPrefix ? parts[parts.length-1] : parts[0];
    const today = new Date().toLocaleDateString('pt-BR',{weekday:'long',day:'numeric',month:'long'});
    tbDate.textContent = `${getGreeting()}, ${firstName} · ${today}`;
  }
  const tbAv=$('t-tb-avatar'); if(tbAv){tbAv.textContent=initial;tbAv.style.backgroundImage='';}

  // Foto de perfil
  try{
    const snap=await getDoc(doc(db,'users',user.uid));
    const ud=snap.data();
    if(ud?.photoBase64){
      if(tbAv){tbAv.style.backgroundImage=`url(${ud.photoBase64})`;tbAv.style.backgroundSize='cover';tbAv.style.backgroundPosition='center';tbAv.textContent='';}
      if(uAv){uAv.style.backgroundImage=`url(${ud.photoBase64})`;uAv.style.backgroundSize='cover';uAv.style.backgroundPosition='center';uAv.textContent='';}
    }
  }catch(e){}

// ─── FILTRO RIGOROSO POR UTILIZADOR ───
 if(_unsubTxs) _unsubTxs();
  if(_unsubObs) _unsubObs();

  // 1. Transações: Filtra primeiro pela EMPRESA (companyId)
  _unsubTxs = onSnapshot(
    query(
      collection(db, 'transactions'),
      where('companyId', '==', s.companyId) // 🔥 Trava na empresa do usuário logado
    ),
    snap => {
      s.txs = snap.docs.map(d => ({id: d.id, ...d.data()}));
      if(_appReady) render();
      // if not ready yet, switchV('v-home') at end of init will trigger render
    },
    err => console.error('[Tenant] txs:', err)
  );

  // 3. Obrigações: Mesmo filtro por EMPRESA
  _unsubObs = onSnapshot(
    query(
      collection(db, 'obrigacoes'),
      where('companyId', '==', s.companyId) // 🔥 Trava na empresa do usuário logado
    ),
    snap => {
      s.obs = snap.docs.map(d => ({id: d.id, ...d.data()}));
      if(_appReady && s.view === 'v-obrig') render();
    },
    err => console.error('[Tenant] obrig:', err)
  );

  bindEvents();
  bindThemeColor();   // seletor de cor configurável pelo usuário
  _appReady = true;   // unlock render() — all state is ready

  // Re-populate UI now that company data is confirmed loaded
  // (the HTML defaults "Usuário / Empresa" only show if this was skipped)
  const _dn2 = user.displayName || user.username || 'Usuário';
  const _ini2 = _dn2.charAt(0).toUpperCase();
  const _uName2 = $('t-u-name'); if(_uName2) _uName2.textContent = _dn2;
  const _uRole2 = $('t-u-role'); if(_uRole2) _uRole2.textContent = s.company?.name || user.companyId || 'Empresa';
  const _uAv2   = $('t-u-av');   if(_uAv2 && !_uAv2.style.backgroundImage) _uAv2.textContent = _ini2;
  const _tbAv2  = $('t-tb-avatar'); if(_tbAv2 && !_tbAv2.style.backgroundImage) _tbAv2.textContent = _ini2;

  switchV('v-home');  // triggers first real render
}

// ─── TEMAS PRESETS ────────────────────────────────────────────
// Cada tema muda múltiplas variáveis CSS de uma vez
const THEMES = {
  default: { name: 'Grafite',  bg:'#0a0a0c', bg2:'#111114', bg3:'#1a1a1f', accent:'#00d4ff' },
  emerald: { name: 'Esmeralda',bg:'#08120e', bg2:'#0e1a14', bg3:'#16241c', accent:'#34d399' },
  violet:  { name: 'Violeta',  bg:'#0d0a14', bg2:'#15101f', bg3:'#1f1830', accent:'#a78bfa' },
  amber:   { name: 'Âmbar',    bg:'#100e08', bg2:'#1a1610', bg3:'#272018', accent:'#fbbf24' },
  rose:    { name: 'Rosa',     bg:'#120a0c', bg2:'#1d1014', bg3:'#2a181d', accent:'#f472b6' },
  mono:    { name: 'Mono',     bg:'#000000', bg2:'#0e0e0e', bg3:'#1a1a1a', accent:'#e5e5e5' },
};

function applyTheme(themeKey, customAccent) {
  const t = THEMES[themeKey] || THEMES.default;
  const root = document.documentElement.style;
  root.setProperty('--bg',  t.bg);
  root.setProperty('--bg2', t.bg2);
  root.setProperty('--bg3', t.bg3);
  const accent = customAccent || t.accent;
  root.setProperty('--accent', accent);
  root.setProperty('--accent2', accent + 'cc');
}

// ─── CONFIGURAÇÕES: TEMA + FOTO DE PERFIL ─────────────────────
function bindThemeColor() {
  // ── Foto de perfil ──
  const avatarWrap    = $('t-profile-avatar-wrap');
  const avatarPreview = $('t-profile-avatar');
  const uploadBtn     = $('t-profile-upload-btn');
  const avatarInput   = $('t-profile-avatar-input');
  const removeBtn     = $('t-profile-remove-photo');
  const nameEl        = $('t-profile-name');
  const emailEl       = $('t-profile-email');

  // Popula nome/email
  if (nameEl) nameEl.textContent = s.user?.displayName || s.user?.username || '—';
  if (emailEl) emailEl.textContent = s.user?.email || '';

  // Mostra foto/inicial atual
  const updateAvatarPreview = (base64) => {
    if (!avatarPreview) return;
    if (base64) {
      avatarPreview.style.backgroundImage = `url(${base64})`;
      avatarPreview.textContent = '';
      if (removeBtn) removeBtn.style.display = 'inline-block';
    } else {
      avatarPreview.style.backgroundImage = '';
      avatarPreview.textContent = (s.user?.displayName || s.user?.username || 'U').charAt(0).toUpperCase();
      if (removeBtn) removeBtn.style.display = 'none';
    }
  };

  // Carrega foto atual do Firestore
  if (s.user?.uid) {
    getDoc(doc(db, 'users', s.user.uid)).then(snap => {
      const ud = snap.data();
      updateAvatarPreview(ud?.photoBase64);
    }).catch(() => updateAvatarPreview(null));
  }

  // Clique no avatar OU no botão "Alterar foto" abre o seletor
  const openFilePicker = () => avatarInput?.click();
  avatarWrap?.addEventListener('click', openFilePicker);
  uploadBtn?.addEventListener('click', e => { e.stopPropagation(); openFilePicker(); });

  avatarInput?.addEventListener('change', async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 800_000) {
      alert('Imagem muito grande (max 800KB). Comprima antes.');
      return;
    }
    // Lê como base64
    const reader = new FileReader();
    reader.onload = async () => {
      const base64 = reader.result;
      // Redimensiona pra 256x256 antes de salvar
      const img = new Image();
      img.onload = async () => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 256;
        const ctx = canvas.getContext('2d');
        const scale = Math.min(256/img.width, 256/img.height);
        const w = img.width * scale, h = img.height * scale;
        ctx.drawImage(img, (256-w)/2, (256-h)/2, w, h);
        const resized = canvas.toDataURL('image/jpeg', 0.85);
        try {
          await updateDoc(doc(db, 'users', s.user.uid), { photoBase64: resized });
          updateAvatarPreview(resized);
          // Atualiza avatares na sidebar/topbar
          ['t-u-av','t-tb-avatar'].forEach(id => {
            const el = $(id);
            if (el) { el.style.backgroundImage = `url(${resized})`; el.textContent = ''; }
          });
        } catch (err) { console.error('[Profile] Erro ao salvar foto:', err); }
      };
      img.src = base64;
    };
    reader.readAsDataURL(file);
  });

  removeBtn?.addEventListener('click', async () => {
    if (!confirm('Remover foto de perfil?')) return;
    try {
      await updateDoc(doc(db, 'users', s.user.uid), { photoBase64: null });
      updateAvatarPreview(null);
      const initial = (s.user?.displayName || s.user?.username || 'U').charAt(0).toUpperCase();
      ['t-u-av','t-tb-avatar'].forEach(id => {
        const el = $(id);
        if (el) { el.style.backgroundImage = ''; el.textContent = initial; }
      });
    } catch (err) { console.error('[Profile] Erro ao remover foto:', err); }
  });

  // ── Cards de tema (presets) ──
  const currentTheme = s.company?.themePreset || 'default';
  const customAccent = s.company?.themeColor;

  // Marca card ativo
  const refreshActiveCard = (key) => {
    document.querySelectorAll('.t-theme-card').forEach(c => {
      c.classList.toggle('active', c.dataset.theme === key);
    });
  };
  refreshActiveCard(currentTheme);

  // Aplica tema inicial
  applyTheme(currentTheme, customAccent);

  document.querySelectorAll('.t-theme-card').forEach(card => {
    card.addEventListener('click', async () => {
      const key = card.dataset.theme;
      refreshActiveCard(key);
      applyTheme(key);
      // Salva no Firestore (limpa cor custom)
      try {
        await updateDoc(doc(db, 'companies', s.companyId), {
          themePreset: key,
          themeColor: THEMES[key].accent
        });
      } catch (err) { console.error('[Theme] Erro ao salvar:', err); }
    });
  });

  // ── Cor de acento custom (avançado) ──
  const input  = $('t-theme-color-input');
  const hex    = $('t-theme-color-hex');
  const saveBtn= $('t-theme-color-save');
  const msg    = $('t-theme-color-msg');
  if (!input || !hex || !saveBtn) return;

  const initColor = customAccent || THEMES[currentTheme].accent;
  input.value = initColor;
  hex.value = initColor.toUpperCase();

  const applyPreview = (color) => {
    if (!/^#[0-9A-Fa-f]{6}$/.test(color)) return;
    document.documentElement.style.setProperty('--accent', color);
    document.documentElement.style.setProperty('--accent2', color + 'cc');
  };

  input.addEventListener('input', e => {
    hex.value = e.target.value.toUpperCase();
    applyPreview(e.target.value);
  });

  hex.addEventListener('input', e => {
    let v = e.target.value.trim();
    if (!v.startsWith('#')) v = '#' + v;
    if (/^#[0-9A-Fa-f]{6}$/.test(v)) {
      input.value = v;
      applyPreview(v);
    }
  });

  saveBtn.addEventListener('click', async () => {
    const color = input.value;
    if (!/^#[0-9A-Fa-f]{6}$/.test(color)) {
      if (msg) { msg.style.display = 'block'; msg.style.color = 'var(--alert)'; msg.textContent = 'Cor inválida.'; }
      return;
    }
    saveBtn.disabled = true; const orig = saveBtn.textContent; saveBtn.textContent = 'Salvando...';
    try {
      await updateDoc(doc(db, 'companies', s.companyId), { themeColor: color });
      if (msg) {
        msg.style.display = 'block'; msg.style.color = 'var(--success)';
        msg.textContent = 'Cor aplicada!';
        setTimeout(() => { msg.style.display = 'none'; }, 2500);
      }
    } catch (err) {
      if (msg) { msg.style.display = 'block'; msg.style.color = 'var(--alert)'; msg.textContent = 'Erro ao salvar.'; }
    } finally {
      saveBtn.disabled = false; saveBtn.textContent = orig;
    }
  });
}

// ─── BIND EVENTOS ─────────────────────────────────────────────
let _eventsBound=false;
function bindEvents(){
  if(_eventsBound) return; _eventsBound=true;
  // Use plain addEventListener throughout — addEvents (touchstart+click) causes double-fires
  const on=(id,fn)=>{const e=typeof id==='string'?$(id):id;if(!e)return;e.addEventListener('click',fn);};
  on('t-btn-menu',()=>$('t-sidebar').classList.contains('open')?closeSidebar():openSidebar());
  on('t-btn-sb-close',()=>closeSidebar());
  $('t-sb-overlay')?.addEventListener('click',closeSidebar);

  $$('.t-nav-item').forEach(btn=>{
    if(btn._navBound) return; btn._navBound=true;
    btn.addEventListener('click',()=>{const v=btn.dataset.view;if(v)switchV(v);});
  });

  on('t-cal-p',()=>{s.cM--;if(s.cM<1){s.cM=12;s.cY--;}renderCal();});
  on('t-cal-n',()=>{s.cM++;if(s.cM>12){s.cM=1;s.cY++;}renderCal();});

  $('t-cal-modal-close')?.addEventListener('click',()=>$('t-cal-day-modal')?.classList.remove('active'));
  $('t-cal-day-modal')?.addEventListener('click',e=>{if(e.target===$('t-cal-day-modal'))$('t-cal-day-modal').classList.remove('active');});

  on('t-fab',()=>{ if(s.view!=='v-papelao') toggleModal(true); });
  on('t-btn-close-modal',()=>toggleModal(false));
  on('t-btn-cancel',()=>toggleModal(false));
  $('t-m-add')?.addEventListener('click',e=>{if(e.target===$('t-m-add'))toggleModal(false);});
  $('t-modal-inner')?.addEventListener('click',e=>e.stopPropagation());

  $('t-a-val')?.addEventListener('input',function(){
    let raw=this.value.replace(/\D/g,'');
    if(!raw){this.value='';return;}
    this.value=(Number(raw)/100).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
  });
  $('t-a-cat')?.addEventListener('change',function(){
    $('t-rec-hint').style.display=CATS[this.value]?.isRec?'block':'none';
  });

  on('t-btn-save',()=>{const b=$('t-btn-save');if(b?._editId)editTxSave(b._editId);else saveTx();});

  // Delegação nas tabelas
  ['t-tx-list','t-rep-list'].forEach(id=>{
    const el=$(id); if(!el) return;
    const bind=()=>el.querySelectorAll('.btn-act').forEach(btn=>{
      if(btn._bound)return;btn._bound=true;
      btn.addEventListener('click',()=>{
        const txId=btn.dataset.id, action=btn.dataset.action, tx=s.txs.find(t=>t.id===txId);
        if(!tx)return;
        if(action==='delete'){deleteTx(txId);return;}
        if(action==='edit'){
          toggleModal(true);
          setTimeout(()=>{
            $('t-a-cat').value=tx.category||'entrada';
            $('t-a-desc').value=tx.description||'';
            $('t-a-val').value=Number(tx.amount||0).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2});
            $('t-a-date').value=tx.date||'';
            $('t-rec-hint').style.display=CATS[$('t-a-cat').value]?.isRec?'block':'none';
            const b=$('t-btn-save');b.textContent='✎ Atualizar Transação';b._editId=txId;
          },50);
        }
      });
    });
    new MutationObserver(bind).observe(el,{childList:true,subtree:true});
  });

  // Filtros de período do relatório
  $$('.t-rep-filter').forEach(btn=>{
    if(btn._rfBound)return; btn._rfBound=true;
    btn.addEventListener('click',()=>{
      s.repFilter=btn.dataset.rep;
      if(s.repFilter!=='personalizado'){s.repCustomIni='';s.repCustomFim='';}
      renderRep();
    });
  });

  // Filtros de categoria
  $$('.t-rep-cat-filter').forEach(btn=>{
    if(btn._rcfBound)return; btn._rcfBound=true;
    btn.addEventListener('click',()=>{s.repCat=btn.dataset.cat;renderRep();});
  });

  // Filtro por texto inline
  $('rep-search')?.addEventListener('input',()=>renderRep());

  // Datas personalizadas
  $('rep-apply-custom')?.addEventListener('click',()=>{
    s.repCustomIni=$('rep-date-ini')?.value||'';
    s.repCustomFim=$('rep-date-fim')?.value||'';
    if(!s.repCustomIni||!s.repCustomFim){toast('⚠ Selecione as duas datas',true);return;}
    renderRep();
  });

  // Limpar filtros de relatório
  window._repClearFilters=function(){
    s.repFilter='mes_atual';s.repCat='all';s.repCustomIni='';s.repCustomFim='';
    const repSrch=$('rep-search'); if(repSrch) repSrch.value='';
    renderRep();
  };
  on('rep-clear-filters',window._repClearFilters);

  // Exportar
  on('t-btn-rep-pdf',()=>generatePDF(s.repFilter));
  on('t-btn-rep-excel',()=>exportRepExcel());

  // Pesquisa inteligente (barra global no topo)
  bindSmartSearch();

  $('t-tb-avatar')?.addEventListener('click',()=>$('t-avatar-input').click());
  $('t-avatar-input')?.addEventListener('change',async function(){
    const file=this.files[0];if(!file||!s.user?.uid)return;
    toast('⏳ Processando imagem…');
    try{
      const base64=await compressImage(file,300,0.78);
      await setDoc(doc(db,'users',s.user.uid),{photoBase64:base64,updatedAt:Date.now()},{merge:true});
      const tbAv=$('t-tb-avatar'),uAv=$('t-u-av');
      if(tbAv){tbAv.style.backgroundImage=`url(${base64})`;tbAv.style.backgroundSize='cover';tbAv.style.backgroundPosition='center';tbAv.textContent='';}
      if(uAv){uAv.style.backgroundImage=`url(${base64})`;uAv.style.backgroundSize='cover';uAv.style.backgroundPosition='center';uAv.textContent='';}
      toast('✓ Foto de perfil atualizada');
    }catch(e){toast('Erro ao salvar foto',true);}
    this.value='';
  });

  on('t-btn-logout',()=>window.LuminAuth?.logout());

  // ─── PLUGGY ─────────────────────────────────────────────────
  initPluggy();
}

// ═══════════════════════════════════════════════════════════════
//  PLUGGY — Open Finance Brasil
// ═══════════════════════════════════════════════════════════════

// Backend hospedado no Fly.io (grátis). Fallback para localhost em dev.
const BACKEND_URL = window.LUMIN_BACKEND_URL || 'https://lumin-backend.fly.dev';

// Cores por categoria (espelha as constantes CATS)
const CAT_STYLES = {
  'entrada':     { color:'#00e5a0', bg:'rgba(0,229,160,.15)',   border:'rgba(0,229,160,.3)',   label:'Entrada'       },
  'saida-fixa':  { color:'#ff5b70', bg:'rgba(255,91,112,.15)',  border:'rgba(255,91,112,.3)',  label:'Saída Fixa'    },
  'funcionario': { color:'#ffb347', bg:'rgba(255,179,71,.15)',   border:'rgba(255,179,71,.3)',  label:'Funcionário'   },
  'comida':      { color:'#4ecdc4', bg:'rgba(78,205,196,.15)',   border:'rgba(78,205,196,.3)',  label:'Comida'        },
  'variavel':    { color:'#b085f5', bg:'rgba(176,133,245,.15)', border:'rgba(176,133,245,.3)', label:'Var. Geral'    }
};

// Estado do modal de revisão
let _pluggyPendingTxs = []; // transações retornadas pelo backend

function initPluggy() {
  // Verifica se a empresa já tem banco conectado e ajusta UI
  _pluggyRefreshUI();

  $('btn-pluggy-connect')?.addEventListener('click', pluggyOpenWidget);
  $('btn-pluggy-sync')?.addEventListener('click',    pluggySync);
  $('pluggy-review-close')?.addEventListener('click',   pluggyCloseReview);
  $('pluggy-review-cancel')?.addEventListener('click',  pluggyCloseReview);
  $('pluggy-review-confirm')?.addEventListener('click', pluggyConfirmImport);

  $('pluggy-select-all')?.addEventListener('change', function() {
    document.querySelectorAll('.pluggy-tx-check').forEach(cb => {
      cb.checked = this.checked;
    });
    _pluggyUpdateCount();
  });

  // Gmail
  $('btn-gmail-connect')?.addEventListener('click',    gmailConnect);
  $('btn-gmail-sync')?.addEventListener('click',       () => gmailSync(false));
  $('btn-gmail-disconnect')?.addEventListener('click', gmailDisconnect);
  gmailInit(); // verifica status e faz auto-sync se já conectado
}

function _pluggyRefreshUI() {
  const hasItem    = !!s.company?.pluggyItemId;
  const connectBtn = $('btn-pluggy-connect');
  const syncBtn    = $('btn-pluggy-sync');
  const statusText = $('pluggy-status-text');
  if (!connectBtn) return;

  if (hasItem) {
    connectBtn.textContent = 'Reconectar';
    connectBtn.style.background = 'transparent';
    connectBtn.style.border = '1px solid var(--border)';
    connectBtn.style.color = 'var(--muted)';
    if (syncBtn) syncBtn.style.display = 'inline-flex';

    // Mostra último sync de forma discreta
    const lastSync = s.company?.pluggyLastSync;
    if (statusText && lastSync) {
      const d = lastSync.toDate ? lastSync.toDate() : new Date(lastSync);
      statusText.style.display = 'inline-flex';
      statusText.innerHTML = `<span style="font-size:11px;color:var(--success);font-weight:500;">• Sync ${d.toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit'})}</span>`;
    } else if (statusText) {
      statusText.style.display = 'none';
    }

    // Auto-sync em background ao carregar (silencioso, apenas se passou mais de 1h do último)
    _pluggyAutoSyncBackground();
  } else {
    if (syncBtn) syncBtn.style.display = 'none';
    if (statusText) statusText.style.display = 'none';
  }
}

async function _pluggyAutoSyncBackground() {
  const itemId = s.company?.pluggyItemId;
  if (!itemId || !s.companyId) return;

  // Só sincroniza se faz mais de 1 hora do último sync
  const lastSync = s.company?.pluggyLastSync;
  if (lastSync) {
    const d = lastSync.toDate ? lastSync.toDate() : new Date(lastSync);
    if (Date.now() - d.getTime() < 60 * 60 * 1000) return;
  }

  // Verifica se o servidor está acessível antes de tentar
  try {
    const health = await fetch(`${BACKEND_URL}/health`, { signal: AbortSignal.timeout(4000) });
    if (!health.ok) return;
  } catch { return; } // servidor offline — sem erro para o usuário

  try {
    const res = await fetch(`${BACKEND_URL}/pluggy/auto-sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ companyId: s.companyId, itemId, dias: 2 })
    });
    if (!res.ok) return;
    const { novas } = await res.json();
    if (novas > 0) toast(`🏦 ${novas} nova${novas > 1 ? 's transações importadas' : ' transação importada'} do banco!`);
  } catch (e) {
    console.warn('[AutoSync background]', e.message);
  }
}

async function pluggyOpenWidget() {
  if (!s.companyId) return;
  const btn = $('btn-pluggy-connect');
  if (btn) { btn.textContent = '⏳ Conectando...'; btn.disabled = true; }

  // Verifica saúde do servidor (pluggy-proxy.js na porta 3001)
  try {
    const health = await fetch(`${BACKEND_URL}/health`, { signal: AbortSignal.timeout(5000) });
    if (!health.ok) throw new Error('servidor offline');
  } catch {
    toast('❌ Servidor offline! Rode "node pluggy-proxy.js" no terminal e tente de novo.', true);
    if (btn) { btn.textContent = 'Conectar Banco'; btn.disabled = false; }
    return;
  }

  try {
    // Inclui itemId na query se já tiver (facilita reconexão)
    const existingItemId = s.company?.pluggyItemId || '';
    const tokenUrl = `${BACKEND_URL}/pluggy/connect-token?companyId=${s.companyId}${existingItemId ? '&itemId='+existingItemId : ''}`;
    const res = await fetch(tokenUrl);
    if (!res.ok) throw new Error(await res.text());
    const { connectToken } = await res.json();

    const widget = new PluggyConnect({
      connectToken,
      onSuccess: async (data) => {
        const itemId = data?.item?.id;
        if (!itemId) return;

        // Salva itemId direto no Firestore via JS SDK (sem depender do backend)
        try {
          await updateDoc(doc(db, 'companies', s.companyId), { pluggyItemId: itemId });
          console.log('[Pluggy] itemId salvo no Firestore:', itemId);
        } catch (e) {
          console.warn('[Pluggy] Erro ao salvar itemId no Firestore:', e.message);
        }

        if (s.company) s.company.pluggyItemId = itemId;
        _pluggyRefreshUI();
        toast('✓ Banco conectado! Importando transações recentes...');

        // Dispara auto-sync imediato após conectar
        try {
          const syncRes = await fetch(`${BACKEND_URL}/pluggy/auto-sync`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ companyId: s.companyId, itemId, dias: 30 })
          });
          if (syncRes.ok) {
            const { novas } = await syncRes.json();
            if (novas > 0) toast(`🏦 ${novas} transações dos últimos 30 dias encontradas! Use "Sincronizar" para importá-las.`);
          }
        } catch (_) { /* auto-sync é best-effort */ }
      },
      onError: (err) => {
        console.error('[Pluggy Widget]', err);
        toast('Erro ao conectar o banco. Tente novamente.', true);
      },
      onClose: () => {
        if (btn) { btn.textContent = s.company?.pluggyItemId ? 'Reconectar' : 'Conectar Banco'; btn.disabled = false; }
      }
    });
    widget.init();

  } catch (err) {
    console.error('[Pluggy]', err);
    toast('Erro ao abrir o widget bancário. Tente novamente.', true);
    if (btn) { btn.textContent = 'Conectar Banco'; btn.disabled = false; }
  }
}

async function pluggySync() {
  const itemId = s.company?.pluggyItemId;
  if (!itemId) { toast('Nenhum banco conectado.', true); return; }

  const btn = $('btn-pluggy-sync');
  if (btn) { btn.textContent = '⏳ Buscando...'; btn.disabled = true; }

  try {
    // Verifica servidor primeiro
    const health = await fetch(`${BACKEND_URL}/health`, { signal: AbortSignal.timeout(5000) });
    if (!health.ok) throw new Error('offline');

    const res = await fetch(`${BACKEND_URL}/pluggy/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ companyId: s.companyId, itemId, dias: 30 })
    });
    if (!res.ok) throw new Error(await res.text());
    const { transactions, period } = await res.json();

    if (!transactions?.length) {
      toast('Nenhuma transação nova encontrada nos últimos 30 dias.', false);
      return;
    }

    _pluggyPendingTxs = transactions;
    pluggyOpenReview(period);

  } catch (err) {
    console.error('[Pluggy Sync]', err);
    const msg = err.message === 'offline'
      ? '❌ Servidor offline! Rode "node pluggy-proxy.js" no terminal.'
      : 'Erro ao sincronizar. Verifique o servidor.';
    toast(msg, true);
  } finally {
    if (btn) { btn.textContent = 'Sincronizar'; btn.disabled = false; }
  }
}

function pluggyOpenReview(period) {
  const modal = $('pluggy-review-modal');
  const list  = $('pluggy-review-list');
  if (!modal || !list) return;

  // Período no header
  const periodEl = $('pluggy-review-period');
  if (periodEl && period) {
    const fmtD = iso => iso.split('-').reverse().join('/');
    periodEl.textContent = `${fmtD(period.from)} → ${fmtD(period.to)} · ${_pluggyPendingTxs.length} transações encontradas`;
  }

  // Renderiza lista
  list.innerHTML = '';
  _pluggyPendingTxs.forEach((tx, i) => {
    const st = CAT_STYLES[tx.category] || CAT_STYLES['variavel'];
    const isEntrada = tx.category === 'entrada';
    const valorFmt = Number(tx.value).toLocaleString('pt-BR', { style:'currency', currency:'BRL' });

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:12px;background:rgba(255,255,255,.03);border:1px solid var(--border);';
    row.innerHTML = `
      <input type="checkbox" class="pluggy-tx-check" data-idx="${i}" checked
        style="accent-color:var(--accent);width:16px;height:16px;flex-shrink:0;cursor:pointer;">
      <div style="flex:1;min-width:0;">
        <div style="font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(tx.description)}</div>
        <div style="font-size:11px;color:var(--muted);margin-top:1px;">${tx.date?.split('-').reverse().join('/')}</div>
      </div>
      <select class="pluggy-tx-cat" data-idx="${i}"
        style="padding:4px 8px;border-radius:8px;border:1px solid ${st.border};background:${st.bg};color:${st.color};font-size:11px;font-weight:700;cursor:pointer;">
        ${Object.entries(CAT_STYLES).map(([k,v])=>`<option value="${k}" ${k===tx.category?'selected':''}>${v.label}</option>`).join('')}
      </select>
      <div style="font-size:13px;font-weight:700;color:${isEntrada?'#00e5a0':'#ff5b70'};white-space:nowrap;min-width:80px;text-align:right;">${isEntrada?'+':'-'} ${valorFmt}</div>
    `;
    list.appendChild(row);
  });

  // Eventos dos selects de categoria
  list.querySelectorAll('.pluggy-tx-cat').forEach(sel => {
    sel.addEventListener('change', function() {
      const idx = Number(this.dataset.idx);
      _pluggyPendingTxs[idx].category = this.value;
      const st = CAT_STYLES[this.value] || CAT_STYLES['variavel'];
      this.style.borderColor = st.border;
      this.style.background  = st.bg;
      this.style.color       = st.color;
      // Atualiza cor do valor
      const row = this.closest('div[style]');
      const valEl = row?.querySelector('div:last-child');
      if (valEl) valEl.style.color = this.value === 'entrada' ? '#00e5a0' : '#ff5b70';
    });
  });

  // Eventos dos checkboxes
  list.querySelectorAll('.pluggy-tx-check').forEach(cb => {
    cb.addEventListener('change', _pluggyUpdateCount);
  });

  _pluggyUpdateCount();
  modal.style.display = 'flex';
}

function _pluggyUpdateCount() {
  const total = document.querySelectorAll('.pluggy-tx-check:checked').length;
  const el = $('pluggy-review-count');
  if (el) el.textContent = total;
}

function pluggyCloseReview() {
  const modal = $('pluggy-review-modal');
  if (modal) modal.style.display = 'none';
  _pluggyPendingTxs = [];
  const sa = $('pluggy-select-all');
  if (sa) sa.checked = true;
}

async function pluggyConfirmImport() {
  const checked = [...document.querySelectorAll('.pluggy-tx-check:checked')];
  if (!checked.length) { toast('Selecione ao menos uma transação.', true); return; }

  const btn = $('pluggy-review-confirm');
  if (btn) { btn.textContent = '⏳ Salvando...'; btn.disabled = true; }

  try {
    const colRef = collection(db, `${s.companyId}_transacoes`);

    // Salva em paralelo (máx 20 por vez para não sobrecarregar)
    const toSave = checked.map(cb => _pluggyPendingTxs[Number(cb.dataset.idx)]);
    const CHUNK  = 20;
    for (let i = 0; i < toSave.length; i += CHUNK) {
      await Promise.all(
        toSave.slice(i, i + CHUNK).map(tx =>
          addDoc(colRef, {
            date:        tx.date,
            category:    tx.category,
            description: tx.description,
            value:       Number(tx.value),
            origem:      'pluggy',
            createdAt:   serverTimestamp()
          })
        )
      );
    }

    toast(`✓ ${toSave.length} transações importadas com sucesso!`);
    pluggyCloseReview();

  } catch (err) {
    console.error('[Pluggy Import]', err);
    toast('Erro ao salvar transações. Tente novamente.', true);
    if (btn) { btn.textContent = 'Importar Selecionadas'; btn.disabled = false; }
  }
}

// ══════════════════════════════════════════════════════════════
//  GMAIL SYNC — lê emails bancários e importa transações com IA
// ══════════════════════════════════════════════════════════════

let _gmailConnected = false;
let _gmailEmail     = null;

// ── Verifica status do Gmail ao carregar ───────────────────────
async function gmailInit() {
  if (!s.companyId) return;
  try {
    const health = await fetch(`${BACKEND_URL}/health`, { signal: AbortSignal.timeout(3000) });
    if (!health.ok) return;
    const r = await fetch(`${BACKEND_URL}/gmail/status?companyId=${s.companyId}`);
    if (!r.ok) return;
    const { connected, email } = await r.json();
    _gmailConnected = connected;
    _gmailEmail     = email;
    _gmailRefreshUI();
    if (connected) _gmailAutoSync();
  } catch { /* servidor offline — silencioso */ }
}

// ── Atualiza UI do bloco Gmail ─────────────────────────────────
function _gmailRefreshUI() {
  const statusEl  = $('gmail-status');
  const connectEl = $('btn-gmail-connect');
  const syncEl    = $('btn-gmail-sync');
  const discEl    = $('btn-gmail-disconnect');

  if (!statusEl) return;

  if (_gmailConnected && _gmailEmail) {
    statusEl.style.display = 'inline-flex';
    statusEl.innerHTML = `<span style="font-size:11px;color:var(--success);font-weight:500;">• ${_gmailEmail}</span>`;
    if (connectEl) connectEl.style.display = 'none';
    if (syncEl)    syncEl.style.display    = 'inline-flex';
    if (discEl)    discEl.style.display    = 'inline-flex';
  } else {
    statusEl.style.display = 'none';
    if (connectEl) connectEl.style.display = 'inline-flex';
    if (syncEl)    syncEl.style.display    = 'none';
    if (discEl)    discEl.style.display    = 'none';
  }
}

// ── Abre popup OAuth do Google ─────────────────────────────────
async function gmailConnect() {
  const btn = $('btn-gmail-connect');
  if (btn) { btn.textContent = '⏳ Abrindo...'; btn.disabled = true; }

  try {
    const health = await fetch(`${BACKEND_URL}/health`, { signal: AbortSignal.timeout(4000) });
    if (!health.ok) throw new Error('offline');
  } catch {
    toast('❌ Servidor offline! Rode "node pluggy-proxy.js" no terminal.', true);
    if (btn) { btn.textContent = '📧 Conectar Gmail'; btn.disabled = false; }
    return;
  }

  try {
    const r = await fetch(`${BACKEND_URL}/gmail/auth-url?companyId=${s.companyId}`);
    const { url, error } = await r.json();
    if (error) throw new Error(error);

    // Abre popup
    const popup = window.open(url, 'gmail-oauth',
      'width=520,height=640,top=100,left=200,menubar=no,toolbar=no,location=no');

    // Escuta mensagem do popup quando conectar
    const onMsg = (ev) => {
      if (ev.data?.type === 'gmail-connected') {
        window.removeEventListener('message', onMsg);
        _gmailConnected = true;
        _gmailEmail     = ev.data.email;
        _gmailRefreshUI();
        toast(`✅ Gmail (${ev.data.email}) conectado! Sincronizando emails...`);
        gmailSync(true); // sync imediato após conectar
      } else if (ev.data?.type === 'gmail-error') {
        window.removeEventListener('message', onMsg);
        toast('Erro ao conectar Gmail. Tente novamente.', true);
        if (btn) { btn.textContent = '📧 Conectar Gmail'; btn.disabled = false; }
      }
    };
    window.addEventListener('message', onMsg);

    // Se o popup foi bloqueado
    if (!popup || popup.closed) {
      window.removeEventListener('message', onMsg);
      toast('Popup bloqueado! Libere popups para este site e tente novamente.', true);
      if (btn) { btn.textContent = '📧 Conectar Gmail'; btn.disabled = false; }
    }

  } catch (err) {
    console.error('[Gmail Connect]', err);
    toast(err.message.includes('GOOGLE_CLIENT_ID')
      ? '⚙️ Configure GOOGLE_CLIENT_ID no .env do servidor.'
      : 'Erro ao conectar Gmail. Tente novamente.', true);
    if (btn) { btn.textContent = '📧 Conectar Gmail'; btn.disabled = false; }
  }
}

// ── Desconectar Gmail ──────────────────────────────────────────
async function gmailDisconnect() {
  if (!confirm('Desconectar Gmail? As transações já importadas são mantidas.')) return;
  try {
    await fetch(`${BACKEND_URL}/gmail/disconnect?companyId=${s.companyId}`);
    _gmailConnected = false;
    _gmailEmail     = null;
    _gmailRefreshUI();
    toast('Gmail desconectado.');
  } catch (e) {
    toast('Erro ao desconectar.', true);
  }
}

// ── Sincronização automática (silenciosa, ao carregar) ─────────
async function _gmailAutoSync() {
  try {
    const r = await fetch(`${BACKEND_URL}/gmail/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ companyId: s.companyId, dias: 7 })
    });
    if (!r.ok) return;
    const { transactions, novas } = await r.json();
    if (novas > 0) {
      toast(`📧 ${novas} nova${novas > 1 ? 's transações' : ' transação'} encontradas no seu email! Clique em "Sincronizar Email" para revisar.`);
      // guarda pendentes para quando o usuário clicar em Sincronizar
      window._gmailPendingTxs = transactions;
    }
  } catch { /* silencioso */ }
}

// ── Sincronização manual (com revisão) ────────────────────────
async function gmailSync(silentOnEmpty = false) {
  const btn = $('btn-gmail-sync');
  if (btn) { btn.textContent = '⏳ Lendo emails...'; btn.disabled = true; }

  try {
    // Usa cache do auto-sync se disponível
    let transactions = window._gmailPendingTxs;
    let novas = transactions?.length;

    if (!transactions) {
      const r = await fetch(`${BACKEND_URL}/gmail/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId: s.companyId, dias: 14 })
      });
      if (!r.ok) throw new Error(await r.text());
      ({ transactions, novas } = await r.json());
    }

    window._gmailPendingTxs = null; // limpa cache

    if (!novas) {
      if (!silentOnEmpty) toast('Nenhuma transação nova nos últimos 14 dias.');
      return;
    }

    // Reutiliza o mesmo modal de revisão do Pluggy
    _pluggyPendingTxs = transactions;
    pluggyOpenReview({ from: '', to: '' });
    // Atualiza título do modal para indicar origem Gmail
    const periodEl = $('pluggy-review-period');
    if (periodEl) periodEl.textContent = `📧 ${novas} transação${novas > 1 ? 'ões' : ''} encontrada${novas > 1 ? 's' : ''} nos seus emails bancários`;

  } catch (err) {
    console.error('[Gmail Sync]', err);
    toast('Erro ao ler emails. Verifique a conexão e tente novamente.', true);
  } finally {
    if (btn) { btn.textContent = '🔄 Sincronizar Email'; btn.disabled = false; }
  }
}

// ─── LISTENER ─────────────────────────────────────────────────
// Expõe switchV globalmente para o bottom nav e outros módulos
window.luminSwitchView = function(id){ if(typeof switchV==='function') switchV(id); };

window.addEventListener('lumin:tenant-ready',async e=>{
  const user=e.detail?.user;
  if(!user||!user.companyId){console.error('[Tenant] Sem companyId');return;}
  await initTenantDashboard(user);
});