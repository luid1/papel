/**
 * ═══════════════════════════════════════════════════════════════
 *  LUMIN SaaS — Tenant Controller v2
 *  Arquivo: tenant-controller.js
 * ═══════════════════════════════════════════════════════════════
 */

import { db } from "./firebase-config.js";
import {
  collection, doc, getDoc, addDoc, updateDoc, deleteDoc, setDoc,
  query, orderBy, onSnapshot, where, getDocs
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ─── CATEGORIAS ───────────────────────────────────────────────
const CATS = {
  'entrada':     { label:'Entrada',              color:'#00e5a0', isRec:false },
  'saida-fixa':  { label:'Saída Fixa',           color:'#ff5b70', isRec:true  },
  'funcionario': { label:'Pagto. Funcionário',   color:'#ffb347', isRec:true  },
  'variavel':    { label:'Despesa Variável',      color:'#b085f5', isRec:false }
};
const MONTHS = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho',
                'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

// ─── ESTADO ───────────────────────────────────────────────────
const s = {
  user:null, companyId:null, company:null,
  view:'v-home', txs:[], obs:[], pagamentos:[],
  fM:new Date().getMonth()+1, fY:new Date().getFullYear(),
  cM:new Date().getMonth()+1, cY:new Date().getFullYear(),
  repFilter:'mes_atual', repCat:'all', repCustomIni:'', repCustomFim:'', features:{}
};
let charts={}, _unsubTxs=null, _unsubObs=null, _unsubPag=null, _unsubCompany=null;

// ─── HELPERS ──────────────────────────────────────────────────
const $   = id  => document.getElementById(id);
const $$  = sel => document.querySelectorAll(sel);
const fmt = v   => Number(v).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
const fmtN= v   => Number(v).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2});
const fD  = iso => iso ? iso.split('-').reverse().join('/') : '—';
const esc = str => String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

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
    btn.className='fpill';
    btn.textContent=`${MONTHS[m-1].slice(0,3)} ${y}`;
    btn.style.cssText=`border:1px solid ${active?'var(--accent)':'var(--border)'};background:${active?'rgba(0,212,255,.12)':'transparent'};color:${active?'var(--accent)':'var(--muted)'};flex-shrink:0;`;
    btn.addEventListener('click',()=>{s.fM=m;s.fY=y;render();});
    pills.appendChild(btn);
  });
  // Rola para o pill activo
  const activePill=pills.querySelector('.fpill[style*="var(--accent)"]');
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

  inp.addEventListener('input',()=>renderSearch(inp.value));
  inp.addEventListener('focus',()=>renderSearch(inp.value));
  inp.addEventListener('keydown',function(e){
    if(e.key==='Enter'){ var q=inp.value.trim(); if(q){ saveFilter(q); var rs=document.getElementById('rep-search'); if(rs)rs.value=q; s.repFilter='anual'; switchV('v-rep'); renderRep(); dd.style.display='none'; toast('Buscando "'+q+'" em Relatórios…'); } }
    if(e.key==='Escape'){ dd.style.display='none'; inp.blur(); }
  });
  if(clrBtn) clrBtn.addEventListener('click',function(){ inp.value=''; renderSearch(''); inp.focus(); });
  document.addEventListener('click',function(e){ if(!inp.contains(e.target)&&!dd.contains(e.target)&&e.target!==clrBtn) dd.style.display='none'; });
}


// ─── CATEGORIAS ACTIVAS (respeita feature flags) ──────────────
function activeCats() {
  const hasFuncionario = s.features?.funcionario === true;
  return Object.fromEntries(
    Object.entries(CATS).filter(([k]) => k !== 'funcionario' || hasFuncionario)
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
  }
}

// ─── DASHBOARD ────────────────────────────────────────────────
function renderHome(){
  const cats = activeCats();
  const f=s.txs.filter(t=>{
    if(!t.date)return false;
    const[y,m]=t.date.split('-').map(Number);
    return y===s.fY&&m===s.fM && (t.category!=='funcionario'||cats['funcionario']);
  });
  const sum=cat=>f.filter(t=>t.category===cat).reduce((a,t)=>a+Number(t.amount||0),0);
  const tIn=f.filter(t=>t.category==='entrada').reduce((a,t)=>a+Number(t.amount||0),0);
  const tOut=f.filter(t=>t.category!=='entrada').reduce((a,t)=>a+Number(t.amount||0),0);
  animateVal('t-s-in',sum('entrada')); animateVal('t-s-out-f',sum('saida-fixa'));
  // Folha pagamento: mostra 0 se desativado
  animateVal('t-s-staff', cats['funcionario'] ? sum('funcionario') : 0);
  animateVal('t-s-var',sum('variavel'));
  animateVal('t-t-in',tIn); animateVal('t-t-out',tOut); animateVal('t-t-net',tIn-tOut);
  const netEl=$('t-t-net'); if(netEl) netEl.style.color=(tIn-tOut)>=0?'var(--success)':'var(--alert)';
  // Oculta o card "Folha Pagamento" se feature desativada
  const staffCard=$('t-s-staff')?.closest('.stat-card');
  if(staffCard) staffCard.style.display=cats['funcionario']?'':'none';
  const cEl=$('t-tx-count'); if(cEl) cEl.textContent=`${f.length} registro${f.length!==1?'s':''}`;

  const txList=$('t-tx-list'); if(!txList) return;
  const fSorted = [...f].sort((a,b)=>(b.date||'').localeCompare(a.date||''));
  txList.innerHTML=fSorted.slice(0,15).map(t=>{
    const cat=cats[t.category]||CATS.variavel, isIn=t.category==='entrada', vc=isIn?'var(--success)':'var(--alert)';
    return `<tr style="--card-accent:${cat.color};">
      <td data-label="Data" style="color:var(--muted);font-family:'DM Mono',monospace;font-size:13px;white-space:nowrap;">${fD(t.date)}</td>
      <td data-label="Categoria"><span class="cat-badge" style="background:${cat.color}22;color:${cat.color};">${cat.label}</span></td>
      <td data-label="Descrição" style="font-weight:600;">${esc(t.description||'—')}</td>
      <td data-label="Valor" style="text-align:right;font-family:'DM Mono',monospace;font-weight:700;color:${vc};white-space:nowrap;">${isIn?'+':'-'} ${fmt(t.amount)}</td>
      <td data-label="Ações" class="td-actions-cell" style="text-align:right;"><div class="td-actions">
        <button class="btn-act edit" data-id="${t.id}" data-action="edit">✎</button>
        <button class="btn-act del"  data-id="${t.id}" data-action="delete">🗑</button>
      </div></td></tr>`;
  }).join('')||`<tr><td colspan="5" style="text-align:center;padding:56px;color:var(--muted);">Sem registros para este período.</td></tr>`;

  if(!window.Chart) return;
  if(charts.pie){charts.pie.destroy();charts.pie=null;}
  if(charts.bar){charts.bar.destroy();charts.bar=null;}

  const pieC=$('t-c-pie'), barC=$('t-c-bar');
  // Gráfico usa apenas as categorias activas
  const catEntries = Object.entries(cats);
  if(pieC) charts.pie=new window.Chart(pieC,{type:'doughnut',data:{labels:catEntries.map(([,c])=>c.label),datasets:[{data:catEntries.map(([k])=>sum(k)),backgroundColor:catEntries.map(([,c])=>c.color),borderWidth:0,hoverOffset:10}]},options:{cutout:'72%',responsive:true,maintainAspectRatio:false,animation:{duration:700},plugins:{legend:{display:true,position:'bottom',labels:{color:'rgba(228,240,246,.5)',font:{size:11},padding:14,boxWidth:10}},tooltip:{backgroundColor:'rgba(5,13,18,.92)',borderColor:'rgba(0,212,255,.2)',borderWidth:1,callbacks:{label:ctx=>` ${ctx.label}: ${fmt(ctx.parsed)}`}}}}});

  const last6=[];
  for(let i=5;i>=0;i--){const d=new Date();d.setDate(1);d.setMonth(d.getMonth()-i);const m=d.getMonth()+1,y=d.getFullYear();const mT=s.txs.filter(t=>{if(!t.date)return false;const[ty,tm]=t.date.split('-').map(Number);return ty===y&&tm===m;});last6.push({label:MONTHS[m-1].slice(0,3),in:mT.filter(t=>t.category==='entrada').reduce((a,t)=>a+Number(t.amount||0),0),out:mT.filter(t=>t.category!=='entrada').reduce((a,t)=>a+Number(t.amount||0),0)});}
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
  const rec=s.txs.filter(t=>t.isRecorrente&&(t.category!=='funcionario'||cats['funcionario']));

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
      return `<div class="cal-event-pill" style="background:${clr}22;color:${clr};${t.isRecorrente?'border:1px dashed '+clr+'55;':''}">${isPending?'⏰ ':''} ${esc(t.description||'')}</div>`;
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
  if(!txs.length){body.innerHTML=`<div style="text-align:center;padding:40px;color:var(--muted);">Nenhuma movimentação neste dia.</div>`;} else {
    const inc=txs.filter(t=>t.category==='entrada').reduce((a,t)=>a+Number(t.amount||0),0);
    const out=txs.filter(t=>t.category!=='entrada').reduce((a,t)=>a+Number(t.amount||0),0);
    body.innerHTML=`<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px;"><div style="padding:14px;border-radius:14px;background:rgba(0,229,160,.08);border:1px solid rgba(0,229,160,.2);text-align:center;"><p style="font-size:10px;font-weight:800;text-transform:uppercase;color:var(--muted);margin-bottom:6px;">Entradas</p><p style="font-family:'DM Mono',monospace;font-size:18px;color:var(--success);font-weight:700;">${fmt(inc)}</p></div><div style="padding:14px;border-radius:14px;background:rgba(255,91,112,.08);border:1px solid rgba(255,91,112,.2);text-align:center;"><p style="font-size:10px;font-weight:800;text-transform:uppercase;color:var(--muted);margin-bottom:6px;">Saídas</p><p style="font-family:'DM Mono',monospace;font-size:18px;color:var(--alert);font-weight:700;">${fmt(out)}</p></div></div>${txs.map(t=>{const cat=CATS[t.category]||CATS.variavel,isIn=t.category==='entrada';return `<div style="display:flex;align-items:center;gap:14px;padding:14px 16px;border-radius:14px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.05);border-left:3px solid ${cat.color};margin-bottom:8px;"><div style="flex:1;min-width:0;"><div style="font-size:14px;font-weight:700;">${esc(t.description||'—')}</div><div style="margin-top:4px;"><span class="cat-badge" style="font-size:9px;background:${cat.color}22;color:${cat.color};">${cat.label}</span></div></div><div style="font-family:'DM Mono',monospace;font-weight:800;color:${isIn?'var(--success)':'var(--alert)'};font-size:16px;">${isIn?'+':'-'} ${fmt(t.amount)}</div></div>`;}).join('')}`;
  }
  modal.classList.add('active');
}

// ─── OBRIGAÇÕES ───────────────────────────────────────────────
function renderOb(){
  const cats=activeCats();
  const rec=s.txs.filter(t=>t.isRecorrente&&(t.category!=='funcionario'||cats['funcionario']));
  const list=$('t-ob-list'); if(!list) return;
  if(!rec.length){list.innerHTML=`<div style="text-align:center;padding:60px;color:var(--muted);">Nenhuma obrigação recorrente cadastrada.</div>`;return;}
  list.innerHTML=rec.map(t=>{
    const key=`${t.id}_${s.fY}-${String(s.fM).padStart(2,'0')}`;
    const ob=s.obs.find(o=>o.monthKey===key), done=ob?.done||false, cat=CATS[t.category]||CATS.variavel;
    return `<div class="glass ob-item" style="opacity:${done?.65:1};">
      <button class="ob-check${done?' done':''}" data-id="${t.id}" aria-label="${done?'Marcar pendente':'Marcar pago'}">${done?'✓':''}</button>
      <div style="flex:1;min-width:0;">
        <div style="font-size:15px;font-weight:700;${done?'text-decoration:line-through;color:var(--muted);':''}">${esc(t.description||'—')}</div>
        <div style="font-size:11px;color:var(--muted);font-weight:600;text-transform:uppercase;margin-top:4px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <span style="padding:3px 8px;border-radius:5px;background:${cat.color}22;color:${cat.color};">${cat.label}</span>
          Vence dia ${(t.date||'').split('-')[2]||'—'}
          ${done?'<span style="color:var(--success);">✓ Pago</span>':''}
        </div>
      </div>
      <div style="font-family:'DM Mono',monospace;font-weight:800;color:var(--warning);font-size:17px;flex-shrink:0;">${fmt(t.amount)}</div>
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
  let data=s.txs.filter(t=>{
    if(!t.date) return false;
    if(t.date<ini||t.date>fim) return false;
    if(t.category==='funcionario'&&!cats['funcionario']) return false;
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
    // Highlight search term
    let desc=esc(t.description||'—');
    if(searchTxt){const re=new RegExp('('+searchTxt.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+')','gi');desc=desc.replace(re,'<mark style="background:rgba(0,212,255,.25);color:var(--accent);border-radius:3px;padding:0 2px;">$1</mark>');}
    return `<tr style="--card-accent:${cat.color};">
      <td data-label="Data" style="color:var(--muted);font-family:'DM Mono',monospace;font-size:13px;white-space:nowrap;">${fD(t.date)}</td>
      <td data-label="Categoria"><span class="cat-badge" style="background:${cat.color}22;color:${cat.color};">${cat.label}</span></td>
      <td data-label="Descrição" style="font-weight:600;">${desc}</td>
      <td data-label="Valor" style="text-align:right;font-family:'DM Mono',monospace;font-weight:700;color:${vc};white-space:nowrap;">${isIn?'+':'-'} ${fmt(t.amount)}</td>
      <td data-label="Ações" class="td-actions-cell" style="text-align:right;"><div class="td-actions">
        <button class="btn-act edit" data-id="${t.id}" data-action="edit">✎</button>
        <button class="btn-act del"  data-id="${t.id}" data-action="delete">🗑</button>
      </div></td>
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
  const cats=activeCats();
  const rec=s.txs.filter(t=>t.isRecorrente&&(t.category!=='funcionario'||cats['funcionario']));
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

// ─── SEGURANÇA ────────────────────────────────────────────────
function renderUsers(){
  const grid=$('t-u-grid'); if(!grid) return;
  const u=s.user; if(!u){grid.innerHTML='<p style="color:var(--muted);text-align:center;padding:40px;">Carregando...</p>';return;}
  const displayName=u.displayName||u.username||'Usuário';
  const initial=displayName.charAt(0).toUpperCase();
  const tbAv=$('t-tb-avatar');
  const photoSrc=tbAv?.style.backgroundImage?.replace(/url\(["']?|["']?\)/g,'')||'';
  const avatarInner=photoSrc
    ?`<img src="${photoSrc}" style="width:100%;height:100%;object-fit:cover;border-radius:20px;">`
    :`<span>${initial}</span>`;
  const roleLabel=u.role==='master'?'Administrador':'Usuário';
  const themeClr=s.company?.themeColor||'var(--accent)';
  grid.innerHTML=`<div class="glass" style="padding:32px;border-radius:24px;text-align:center;position:relative;overflow:hidden;max-width:320px;margin:0 auto;">
    <div style="position:absolute;top:0;left:0;right:0;height:3px;background:${themeClr};opacity:.5;"></div>
    <div style="width:96px;height:96px;border-radius:22px;border:2.5px solid var(--accent);
      margin:0 auto 20px;display:grid;place-items:center;font-size:36px;font-weight:900;
      color:var(--accent);background:var(--bg3);overflow:hidden;">${avatarInner}</div>
    <h4 style="font-family:'Montserrat',sans-serif;font-size:20px;font-weight:800;letter-spacing:-.5px;margin-bottom:10px;">${esc(displayName)}</h4>
    <p style="font-size:11px;font-weight:800;text-transform:uppercase;color:var(--accent);
      background:rgba(0,212,255,.1);padding:5px 18px;border-radius:30px;display:inline-block;letter-spacing:1px;">${roleLabel}</p>
    <div style="font-family:'DM Mono',monospace;font-size:13px;color:var(--muted);margin-top:16px;">@${esc(u.username||displayName.toLowerCase())}</div>
    <div style="font-size:12px;color:var(--muted);margin-top:6px;">${esc(s.company?.name||'')}</div>
    <button id="t-users-logout" style="margin-top:24px;width:100%;padding:12px;border-radius:12px;
      background:rgba(255,91,112,.08);border:1px solid rgba(255,91,112,.2);color:var(--alert);
      font-size:13px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
        <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>
      </svg>
      Encerrar Sessão
    </button>
  </div>`;
  document.getElementById('t-users-logout')?.addEventListener('click',()=>window.LuminAuth?.logout());
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

  // Ouve empresa em tempo real — features/cor actualizadas pelo admin
  // reflectem imediatamente no tenant sem precisar recarregar.
  if(_unsubCompany) _unsubCompany();
  await new Promise(resolve => {
    let firstCall = true;
    _unsubCompany = onSnapshot(doc(db,'companies',user.companyId), snap => {
      s.company  = snap.exists() ? snap.data() : null;
      s.features = s.company?.features || {};

      // Aplica cor da empresa
      if(s.company?.themeColor){
        document.documentElement.style.setProperty('--accent', s.company.themeColor);
        document.documentElement.style.setProperty('--accent2', s.company.themeColor+'cc');
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
  if(tbDate&&window.innerWidth>768) tbDate.textContent=`${getGreeting()}, ${displayName.split(' ')[0]} · ${new Date().toLocaleDateString('pt-BR',{weekday:'long',day:'numeric',month:'long'})}`;
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
}

// ─── LISTENER ─────────────────────────────────────────────────
// Expõe switchV globalmente para o bottom nav e outros módulos
window.luminSwitchView = function(id){ if(typeof switchV==='function') switchV(id); };

window.addEventListener('lumin:tenant-ready',async e=>{
  const user=e.detail?.user;
  if(!user||!user.companyId){console.error('[Tenant] Sem companyId');return;}
  await initTenantDashboard(user);
});