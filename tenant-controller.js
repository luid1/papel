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
  repFilter:'semanal', features:{}
};
let charts={}, _unsubTxs=null, _unsubObs=null, _unsubPag=null;

// ─── HELPERS ──────────────────────────────────────────────────
const $   = id  => document.getElementById(id);
const $$  = sel => document.querySelectorAll(sel);
const fmt = v   => Number(v).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
const fmtN= v   => Number(v).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2});
const fD  = iso => iso ? iso.split('-').reverse().join('/') : '—';
const esc = str => String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

function addEvents(elOrId, fn){
  const el = typeof elOrId==='string' ? $(elOrId) : elOrId;
  if(!el) return;
  el.addEventListener('touchstart', e=>{e.preventDefault();fn(e);},{passive:false});
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
    // Mostra/oculta a opção "Funcionário" conforme feature
    const optFun=o.querySelector('option[value="funcionario"]');
    if(optFun) optFun.style.display = s.features?.funcionario!==false ? '' : 'none';
    // Se a opção estava seleccionada e foi desactivada, volta ao padrão
    const sel=$('t-a-cat');
    if(sel&&sel.value==='funcionario'&&s.features?.funcionario===false) sel.value='entrada';
    setTimeout(()=>$('t-a-desc').focus(),320);
  } else {
    o.classList.remove('active');
    const b=$('t-btn-save');
    if(b){b._editId=null;b.textContent='✓ Registrar no Sistema';}
  }
}

// ─── RENDER PRINCIPAL ─────────────────────────────────────────
function render(){
  buildPills();
  if(s.view==='v-home')  renderHome();
  if(s.view==='v-cal')   renderCal();
  if(s.view==='v-obrig') renderOb();
  if(s.view==='v-rep')   renderRep();
  if(s.view==='v-users') renderUsers();
}

function buildPills(){
  const months=new Set();
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
    btn.style.cssText=`border:1px solid ${active?'var(--accent)':'var(--border)'};background:${active?'rgba(0,212,255,.12)':'transparent'};color:${active?'var(--accent)':'var(--muted)'};`;
    addEvents(btn,()=>{s.fM=m;s.fY=y;render();});
    pills.appendChild(btn);
  });
}

// ─── CATEGORIAS ACTIVAS (respeita feature flags) ──────────────
function activeCats() {
  const hasFuncionario = s.features?.funcionario !== false;
  return Object.fromEntries(
    Object.entries(CATS).filter(([k]) => k !== 'funcionario' || hasFuncionario)
  );
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
  for(let i=0;i<first;i++) grid.innerHTML+=`<div class="cal-day" style="opacity:.2;"></div>`;
  for(let d=1;d<=days;d++){
    const ds=`${s.cY}-${String(s.cM).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const dT=s.txs.filter(t=>t.date===ds), isT=ds===todayStr;
    const div=document.createElement('div'); div.className='cal-day'+(isT?' today':'');
    div.innerHTML=`<div class="cal-day-num">${d}</div><div style="display:flex;flex-direction:column;gap:3px;margin-top:6px;overflow:hidden;">${dT.slice(0,2).map(t=>`<div class="cal-event-pill" style="background:${CATS[t.category]?.color||'#888'}22;color:${CATS[t.category]?.color||'#888'};">${esc(t.description||'')}</div>`).join('')}${dT.length>2?`<div class="cal-more-label">+${dT.length-2}</div>`:''}</div>`;
    div.addEventListener('click',()=>openCalDayModal(ds,dT));
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
  const rec=s.txs.filter(t=>t.isRecorrente);
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
    addEvents(btn,async()=>{
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
function renderRep(){
  const cats=activeCats();
  const now=new Date(); let filtered=[];
  if(s.repFilter==='semanal'){const c=new Date();c.setDate(c.getDate()-7);filtered=s.txs.filter(t=>t.date&&t.date>=c.toISOString().slice(0,10));}
  else if(s.repFilter==='mensal'){const y=now.getFullYear(),m=now.getMonth()+1;filtered=s.txs.filter(t=>{if(!t.date)return false;const[ty,tm]=t.date.split('-').map(Number);return ty===y&&tm===m;});}
  else{const y=now.getFullYear();filtered=s.txs.filter(t=>t.date&&t.date.startsWith(String(y)));}
  // Remove funcionário se feature desativada
  filtered=filtered.filter(t=>t.category!=='funcionario'||cats['funcionario']);
  filtered.sort((a,b)=>(b.date||'').localeCompare(a.date||''));
  const tIn=filtered.filter(t=>t.category==='entrada').reduce((a,t)=>a+Number(t.amount||0),0);
  const tOut=filtered.filter(t=>t.category!=='entrada').reduce((a,t)=>a+Number(t.amount||0),0);
  const net=tIn-tOut;
  const setEl=(id,val,color)=>{const el=$(id);if(!el)return;el.textContent=fmt(val);el.style.color=color;};
  setEl('t-rep-in',tIn,'var(--success)'); setEl('t-rep-out',tOut,'var(--alert)'); setEl('t-rep-net',net,net>=0?'var(--success)':'var(--alert)');
  const cEl=$('t-rep-count'); if(cEl) cEl.textContent=`${filtered.length} registro${filtered.length!==1?'s':''}`;
  const repList=$('t-rep-list'); if(!repList) return;
  repList.innerHTML=filtered.map(t=>{
    const cat=cats[t.category]||CATS.variavel,isIn=t.category==='entrada',vc=isIn?'var(--success)':'var(--alert)';
    return `<tr style="--card-accent:${cat.color};"><td data-label="Data" style="color:var(--muted);font-family:'DM Mono',monospace;font-size:13px;white-space:nowrap;">${fD(t.date)}</td><td data-label="Categoria"><span class="cat-badge" style="background:${cat.color}22;color:${cat.color};">${cat.label}</span></td><td data-label="Descrição" style="font-weight:600;">${esc(t.description||'—')}</td><td data-label="Valor" style="text-align:right;font-family:'DM Mono',monospace;font-weight:700;color:${vc};white-space:nowrap;">${isIn?'+':'-'} ${fmt(t.amount)}</td><td data-label="Ações" class="td-actions-cell" style="text-align:right;"><div class="td-actions"><button class="btn-act edit" data-id="${t.id}" data-action="edit">✎</button><button class="btn-act del" data-id="${t.id}" data-action="delete">🗑</button></div></td></tr>`;
  }).join('')||`<tr><td colspan="5" style="text-align:center;padding:56px;color:var(--muted);">Nenhuma transação neste período.</td></tr>`;
  $$('.t-rep-filter').forEach(btn=>{const a=btn.dataset.rep===s.repFilter;btn.style.borderColor=a?'var(--accent)':'var(--border)';btn.style.background=a?'rgba(0,212,255,.12)':'transparent';btn.style.color=a?'var(--accent)':'var(--muted)';});
}

// ─── ABA A PAGAR ──────────────────────────────────────────────
function renderPagar(){
  // Calcula obrigações pendentes do mês actual
  const rec=s.txs.filter(t=>t.isRecorrente);
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
  const grid=$('t-u-grid'); if(!grid||!s.company) return;
  getDocs(query(collection(db,'users'),where('companyId','==',s.companyId))).then(snap=>{
    const users=snap.docs.map(d=>({uid:d.id,...d.data()}));
    grid.innerHTML=users.map(u=>{
      const avatarInner=u.photoBase64?`<img src="${u.photoBase64}" style="width:100%;height:100%;object-fit:cover;border-radius:20px;" alt="${esc(u.displayName)}">`:`<span>${(u.displayName||u.username||'?').charAt(0).toUpperCase()}</span>`;
      const roleLabel=u.role==='master'?'Administrador':'Usuário';
      return `<div class="glass" style="padding:28px;border-radius:24px;text-align:center;position:relative;overflow:hidden;">
        <div style="position:absolute;top:0;left:0;right:0;height:3px;background:${s.company?.themeColor||'var(--accent)'};opacity:.4;"></div>
        <div style="width:88px;height:88px;border-radius:22px;border:2.5px solid var(--accent);margin:0 auto 18px;display:grid;place-items:center;font-size:34px;font-weight:900;color:var(--accent);background:var(--bg3);overflow:hidden;">${avatarInner}</div>
        <h4 style="font-family:'Montserrat',sans-serif;font-size:19px;font-weight:800;letter-spacing:-.5px;">${esc(u.displayName||u.username)}</h4>
        <p style="font-size:11px;font-weight:800;text-transform:uppercase;color:var(--accent);background:rgba(0,212,255,.1);padding:5px 16px;border-radius:30px;display:inline-block;margin-top:12px;letter-spacing:1px;">${roleLabel}</p>
        <div style="font-family:'DM Mono',monospace;font-size:13px;color:var(--muted);margin-top:16px;">@${esc(u.username)}</div>
      </div>`;
    }).join('');
  }).catch(()=>{});
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

// ─── PDF ──────────────────────────────────────────────────────
function generatePDF(period){
  if(!window.jspdf){toast('PDF não disponível',true);return;}
  const now=new Date();
  const filtered=s.txs.filter(t=>{
    if(!t.date)return false;
    const[y,m,d]=t.date.split('-').map(Number);
    if(period==='semanal')return (now-new Date(y,m-1,d))<7*86400000;
    if(period==='mensal')return m===now.getMonth()+1&&y===now.getFullYear();
    return y===now.getFullYear();
  });
  const inc=filtered.filter(t=>t.category==='entrada').reduce((a,t)=>a+Number(t.amount||0),0);
  const out=filtered.filter(t=>t.category!=='entrada').reduce((a,t)=>a+Number(t.amount||0),0);
  const bal=inc-out;
  const{jsPDF}=window.jspdf;
  const pd=new jsPDF({orientation:'portrait',unit:'mm',format:'a4'});
  const today=now.toLocaleDateString('pt-BR');
  const pNames={semanal:'Últimos 7 Dias',mensal:'Mês Atual',anual:'Ano Fiscal'};
  const cn=s.company?.name||'Lumin';
  pd.setFillColor(5,13,18);pd.rect(0,0,210,297,'F');
  pd.setFillColor(0,100,140);pd.rect(0,0,210,42,'F');
  pd.setFont('helvetica','bold');pd.setFontSize(26);pd.setTextColor(255,255,255);pd.text('LUMIN',14,20);
  pd.setFont('helvetica','normal');pd.setFontSize(10);pd.setTextColor(180,230,255);
  pd.text(`Relatório Financeiro — ${pNames[period]||period} — ${cn}`,14,30);pd.text(`Gerado em ${today}`,196,30,{align:'right'});
  [{x:14,label:'Total Entradas',val:'R$ '+fmtN(inc),fc:[235,252,245],tc:[0,120,70]},{x:80,label:'Total Saídas',val:'R$ '+fmtN(out),fc:[255,235,238],tc:[160,30,40]},{x:146,label:'Saldo Líquido',val:'R$ '+fmtN(bal),fc:bal>=0?[235,252,245]:[255,235,238],tc:bal>=0?[0,120,70]:[160,30,40]}].forEach(({x,label,val,fc,tc})=>{pd.setFillColor(...fc);pd.roundedRect(x,48,56,24,2,2,'F');pd.setFontSize(7.5);pd.setFont('helvetica','normal');pd.setTextColor(80,80,80);pd.text(label,x+4,55);pd.setFontSize(11);pd.setFont('helvetica','bold');pd.setTextColor(...tc);pd.text(val,x+4,65);});
  if(filtered.length){pd.autoTable({startY:80,head:[['Data','Descrição','Categoria','Valor']],body:filtered.sort((a,b)=>b.date.localeCompare(a.date)).map(t=>[fD(t.date),t.description||'—',CATS[t.category]?.label||t.category,(t.category==='entrada'?'+ ':'- ')+'R$ '+fmtN(t.amount)]),styles:{fontSize:9,cellPadding:4},headStyles:{fillColor:[0,100,140],textColor:[255,255,255],fontStyle:'bold'},alternateRowStyles:{fillColor:[246,250,253]},columnStyles:{3:{halign:'right'}},foot:[['','','↑ Entradas','R$ '+fmtN(inc)],['','','↓ Saídas','R$ '+fmtN(out)],['','','= Saldo','R$ '+fmtN(bal)]],footStyles:{fillColor:[240,248,255],textColor:[0,80,120],fontStyle:'bold'}});}
  const ph=pd.internal.pageSize.height;pd.setDrawColor(0,100,140);pd.line(14,ph-14,196,ph-14);pd.setFontSize(8);pd.setFont('helvetica','normal');pd.setTextColor(80,80,80);pd.text(`Lumin — ${cn}`,14,ph-8);pd.text(today,196,ph-8,{align:'right'});
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

  // Carrega empresa
  try{
    const snap=await getDoc(doc(db,'companies',user.companyId));
    s.company=snap.exists()?snap.data():null;
    s.features=s.company?.features||{};
  }catch(e){console.error('[Tenant] empresa:',e);}

  // Aplica cor da empresa
  if(s.company?.themeColor){
    document.documentElement.style.setProperty('--accent',s.company.themeColor);
    document.documentElement.style.setProperty('--accent2',s.company.themeColor+'cc');
  }

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
      render();
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
      if(s.view === 'v-obrig') render();
    },
    err => console.error('[Tenant] obrig:', err)
  );

  bindEvents();
  switchV('v-home');
}

// ─── BIND EVENTOS ─────────────────────────────────────────────
function bindEvents(){
  addEvents('t-btn-menu',()=>$('t-sidebar').classList.contains('open')?closeSidebar():openSidebar());
  addEvents('t-btn-sb-close',()=>closeSidebar());
  $('t-sb-overlay')?.addEventListener('click',closeSidebar);

  $$('.t-nav-item').forEach(btn=>addEvents(btn,()=>{const v=btn.dataset.view;if(v)switchV(v);}));

  addEvents('t-cal-p',()=>{s.cM--;if(s.cM<1){s.cM=12;s.cY--;}renderCal();});
  addEvents('t-cal-n',()=>{s.cM++;if(s.cM>12){s.cM=1;s.cY++;}renderCal();});

  $('t-cal-modal-close')?.addEventListener('click',()=>$('t-cal-day-modal')?.classList.remove('active'));
  $('t-cal-day-modal')?.addEventListener('click',e=>{if(e.target===$('t-cal-day-modal'))$('t-cal-day-modal').classList.remove('active');});

  addEvents('t-fab',()=>{ if(s.view!=='v-papelao') toggleModal(true); });
  addEvents('t-btn-close-modal',()=>toggleModal(false));
  addEvents('t-btn-cancel',()=>toggleModal(false));
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

  addEvents('t-btn-save',()=>{const b=$('t-btn-save');if(b?._editId)editTxSave(b._editId);else saveTx();});

  // Delegação nas tabelas
  ['t-tx-list','t-rep-list'].forEach(id=>{
    const el=$(id); if(!el) return;
    const bind=()=>el.querySelectorAll('.btn-act').forEach(btn=>{
      if(btn._bound)return;btn._bound=true;
      addEvents(btn,()=>{
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

  $$('.t-rep-filter').forEach(btn=>addEvents(btn,()=>{s.repFilter=btn.dataset.rep;renderRep();}));
  addEvents('t-btn-rep-pdf',()=>generatePDF(s.repFilter));

  ['click','touchstart'].forEach(ev=>{
    $('t-tb-avatar')?.addEventListener(ev,e=>{e.preventDefault();$('t-avatar-input').click();},{passive:false});
  });
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

  addEvents('t-btn-logout',()=>window.LuminAuth?.logout());
}

// ─── LISTENER ─────────────────────────────────────────────────
window.addEventListener('lumin:tenant-ready',async e=>{
  const user=e.detail?.user;
  if(!user||!user.companyId){console.error('[Tenant] Sem companyId');return;}
  await initTenantDashboard(user);



});