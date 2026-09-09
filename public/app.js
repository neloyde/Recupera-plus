// Recupera+ Frontend SPA — talks to the REST API
const API = '';
let S = { id:null, data:null, token:sessionStorage.getItem('recupera_token'), user:null, role:'patient' };

const $ = s => document.querySelector(s);

// auth header helper
function authHeaders(){
  return S.token ? { 'Authorization':'Bearer '+S.token } : {};
}
async function apiAuth(path, opts={}){
  const r = await fetch(API+path, { headers:{ 'Content-Type':'application/json', ...authHeaders(), ...(opts.headers||{}) }, ...opts });
  if(r.status===401){ sessionStorage.removeItem('recupera_token'); showAuth(); throw new Error('Sessão expirada'); }
  if(!r.ok){ const e=await r.json().catch(()=>({})); throw new Error(e.error||'Erro'); }
  return r.status===204?null:r.json();
}
const today = () => new Date().toISOString().slice(0,10);
const fmtDate = d => new Date(d+'T00:00:00').toLocaleDateString('pt-PT',{day:'2-digit',month:'long'});

function toast(msg){
  const t=$('#toast'); t.textContent=msg; t.classList.add('show');
  clearTimeout(t._t); t._t=setTimeout(()=>t.classList.remove('show'),2600);
}
// Símbolo da moeda (USD por padrão)
function curSymbol(cur){ return (cur||'USD')==='USD' ? '$' : (cur==='EUR' ? '€' : (cur==='MZN' ? 'MT' : '$')); }
async function api(path, opts={}){
  const r = await fetch(API+path, { headers:{'Content-Type':'application/json'}, ...opts });
  if(!r.ok){ const e=await r.json().catch(()=>({})); throw new Error(e.error||'Erro'); }
  return r.status===204?null:r.json();
}

/* ================= Onboarding ================= */
let cfg, obType=null, obStep=0;
const OB_STEPS=5;
async function initOb(){
  cfg = await api('/api/config');
  const g=$('#typeGrid');
  g.innerHTML = cfg.surgeryTypes.map(t=>`<button class="type-btn" data-id="${t.id}" onclick="selType('${t.id}')"><span class="em">${t.em}</span><span class="nm">${t.name}</span></button>`).join('');
  $('#obSurgeryDate').value = today();
  $('#obTodayShow').textContent = new Date().toLocaleDateString('pt-PT',{day:'2-digit',month:'long',year:'numeric'});
  paintDots();
}
function selType(id){ obType=id; document.querySelectorAll('.type-btn').forEach(b=>b.classList.toggle('sel', b.dataset.id===id)); }
function paintDots(){ $('#obDots').innerHTML = Array.from({length:OB_STEPS},(_,i)=>`<span class="dot ${i<=obStep?'on':''}"></span>`).join(''); }
function obNext(){
  if(obStep===1&&!obType){toast('Seleciona o tipo de cirurgia');return;}
  if(obStep===2&&!$('#obSurgeryDate').value){toast('Indica a data');return;}
  if(obStep===3){const a=+$('#obAge').value,p=+$('#obPain').value;if(!a||a<10||a>110){toast('Idade inválida');return;}if(!p||p<1||p>10){toast('Dor 1-10');return;}}
  obStep++; showObStep();
}
function obBack(){ if(obStep>0){obStep--;showObStep();} }
function showObStep(){
  document.querySelectorAll('.ob-step').forEach((el,i)=>el.classList.toggle('active', i===obStep));
  $('#obBack').style.display = obStep>0&&obStep<4?'block':'none';
  $('#obNextBtn').style.display = (obStep>=1&&obStep<=3)?'block':'none';
  paintDots();
}
async function finishOnboarding(){
  const body={ type:obType||'joelho', surgeryDate:$('#obSurgeryDate').value, age:+$('#obAge').value, initialPain:+$('#obPain').value };
  const res = await api('/api/patients', {method:'POST', body:JSON.stringify(body)});
  S.id = res.id;
  sessionStorage.setItem('recupera_id', res.id);
  // ligar à conta autenticada, se houver
  if(S.token){ try{ await apiAuth(`/api/patients/${S.id}/link`,{method:'POST'}); }catch(e){} }
  $('#onboarding').classList.remove('active');
  await refresh(); go('home');
  toast('Plano criado! Bem-vindo 💙');
}

/* ================= Navigation ================= */
function go(scr){
  if(scr!=='chat' && chatOpen) closeChat();
  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
  const el=$('#sc-'+scr); if(el) el.classList.add('active');
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.toggle('active', n.dataset.s===scr));
  if(scr==='chat') openChat();
  if(scr==='premium' && S.token) renderPremium();
  window.scrollTo(0,0);
}

/* ================= Today ================= */
let D=null; // today data
async function refresh(){ D = await api(`/api/patients/${S.id}/today`); }
async function renderHome(){
  $('#hDate').textContent = new Date().toLocaleDateString('pt-PT',{weekday:'long',day:'numeric',month:'long'});
  $('#hWeek').textContent = D.weeks;
  $('#hPhaseTitle').textContent = D.phaseTitle;
  $('#hPhaseDesc').textContent = D.phaseDesc;
  $('#hPhaseProg').style.width = D.phaseProgress+'%';
  $('#hPainToday').textContent = D.painToday ?? '—';
  $('#hPlanChip').textContent = D.patient.premium?'💎 Premium':'Gratuito';
  const done = D.exercises.filter(e=>e.done).length;
  $('#hExDone').textContent = `${done}/${D.exercises.length}`;
  $('#hExerciseList').innerHTML = D.exercises.length? D.exercises.map(exCard).join('') : empty('🛌','Descansa hoje.');
  const dm = D.meds.filter(m=>m.taken).length;
  $('#hMedDone').textContent = `${dm}/${D.meds.length}`;
  $('#hMedList').innerHTML = D.meds.length? D.meds.map(medCard).join('') : empty('💊','Sem medicação hoje.');
  paintPain('#hPainGrid', D.painToday);
}
function exCard(e){
  return `<div class="ex-item ${e.done?'done':''}" onclick="toggleEx(${e.index})">
    <div class="ex-thumb">${e.em}</div>
    <div class="ex-info"><div class="n">${e.name}</div><div class="d">${e.desc}</div><div class="set">${e.sets}</div></div>
    <div class="toggle ${e.done?'on':''}"></div></div>`;
}
function medCard(m){
  return `<div class="med ${m.taken?'taken':''}"><div class="ic">💊</div>
    <div><div class="nm">${m.name}</div><div class="tm">⏰ ${m.time}</div></div>
    <span class="st ${m.taken?'ok':'pend'}" onclick="toggleMed(${m.id})">${m.taken?'Tomada ✓':'Por tomar'}</span></div>`;
}
function paintPain(sel, cur){
  $(sel).innerHTML = Array.from({length:10},(_,i)=>{
    const v=i+1, cls=cur===v?'sel':'', tone=v<=3?'low':(v<=6?'med':'hi');
    return `<button class="pain-num ${cls} ${tone}" onclick="setPain(${v})">${v}</button>`;
  }).join('');
}
async function toggleEx(index){ await api(`/api/patients/${S.id}/exercise`,{method:'POST',body:JSON.stringify({index})}); await refresh(); renderHome(); }
async function toggleMed(medId){ await api(`/api/patients/${S.id}/med`,{method:'POST',body:JSON.stringify({medId})}); await refresh(); renderHome(); if($('#sc-med').classList.contains('active')) renderMed(); }
async function setPain(v){ await api(`/api/patients/${S.id}/pain`,{method:'POST',body:JSON.stringify({value:v})}); await refresh(); renderDor(); renderHome(); if(v>=8)toast('🚨 Dor elevada — considera contactar o médico'); else toast(`Dor: ${v}/10`); }

/* ================= Plano ================= */
let PLAN=null;
async function renderPlano(){
  PLAN = await api(`/api/patients/${S.id}/plan`);
  const t=PLAN.typeInfo;
  $('#pTypeName').textContent = `Recuperação de ${t.name}`;
  $('#pTypeDate').textContent = fmtDate(D.patient.surgery_date);
  const pct=Math.min(100,Math.round(PLAN.weeks/t.weeks*100));
  $('#pOverall').style.width=pct+'%'; $('#pOverallTxt').textContent=pct;
  $('#pPhaseList').innerHTML = PLAN.library.map((f,i)=>{
    const cur=phaseForIndex(PLAN.weeks)===i, past=phaseForIndex(PLAN.weeks)>i;
    const em=past?'✅':(cur?'▶️':'⏳');
    return `<div class="card" style="${cur?'border:2px solid var(--teal)':''}">
      <div style="font-weight:800">${em} Fase ${f.fase} ${cur?'<span class="chip">Atual</span>':''}</div>
      <div class="tiny muted" style="margin-top:6px">${f.d}</div>
      <div class="tiny muted" style="margin-top:6px">${f.exercises.map(e=>e.name).join(' · ')}</div></div>`;
  }).join('');
  const hist = await api(`/api/patients/${S.id}/history`);
  $('#pAdEx').style.width = hist.adherence.exercises+'%';
  $('#pAdMed').style.width = hist.adherence.medication+'%';
}
function phaseForIndex(w){ return w<=2?0:w<=5?1:2; }

/* ================= Dor ================= */
let HIST=null;
async function renderDor(){
  paintPain('#dPainGrid', D.painToday);
  HIST = await api(`/api/patients/${S.id}/history`);
  let rows='';
  HIST.series.slice().reverse().forEach(d=>{
    const label=new Date(d.date+'T00:00:00').toLocaleDateString('pt-PT',{weekday:'short',day:'numeric'});
    rows+=`<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #eef3f8">
      <span class="tiny">${label}</span>
      ${d.pain===null?'<span class="tiny muted">—</span>':`<span style="font-weight:800;color:${d.pain<=3?'var(--ok)':(d.pain<=6?'#d4a017':'var(--danger)')}">${d.pain}/10</span>`}</div>`;
  });
  $('#dHistoryList').innerHTML = `<div style="font-weight:800;margin-bottom:4px">Última semana</div>${rows}`;
  $('#dChartLock').style.display = D.patient.premium?'none':'inline-flex';
  $('#dChartCard').classList.toggle('b-locked', !D.patient.premium);
  $('#dUpgradeBtn').style.display = D.patient.premium?'none':'block';
  drawChart(HIST.series);
}
function drawChart(series){
  const W=360,H=150,padL=8,padR=8,padT=16,padB=26;
  const ys=v=>padT+(H-padT-padB)*(1-(v||0)/10);
  const xs=i=>padL+(W-padL-padR)*(series.length===1?0.5:i/(series.length-1));
  const pts=series.map((d,i)=>d.pain===null?null:{x:xs(i),y:ys(d.pain)});
  const valid=pts.filter(Boolean);
  let path=valid.length?valid.map((p,i)=>i===0?`M${p.x},${p.y}`:`L${p.x},${p.y}`).join(' '):'';
  let svg=`<svg class="chart" viewBox="0 0 ${W} ${H}">`;
  for(let g=0;g<=10;g+=2) svg+=`<line x1="${padL}" y1="${ys(g)}" x2="${W-padR}" y2="${ys(g)}" stroke="#eef3f8"/>`;
  if(path){ svg+=`<path d="${path}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round"/>`;
    valid.forEach(p=>svg+=`<circle cx="${p.x}" cy="${p.y}" r="4" fill="var(--accent)" stroke="#fff" stroke-width="2"/>`); }
  series.forEach((d,i)=>{ const lbl=new Date(d.date+'T00:00:00').toLocaleDateString('pt-PT',{day:'numeric'});
    svg+=`<text x="${xs(i)}" y="${H-8}" font-size="9" fill="#9db1c2" text-anchor="middle">${lbl}</text>`; });
  if(!valid.length) svg+=`<text x="${W/2}" y="${H/2}" font-size="11" fill="#9db1c2" text-anchor="middle">Regista a dor para ver o gráfico</text>`;
  svg+='</svg>';
  $('#dChart').outerHTML=svg;
}
async function exportPDF(){
  if(!D.patient.premium){ toast('📄 O PDF é Premium'); showPremium(); return; }
  HIST = await api(`/api/patients/${S.id}/history`);
  const w=window.open('','_blank'); if(!w){toast('Permite pop-ups');return;}
  let rows='';
  HIST.series.forEach(d=>{
    rows+=`<tr><td>${d.date}</td><td>${d.pain??'—'}</td><td>${d.exDone}/${d.exTotal}</td><td>${d.medDone}/${d.medTotal}</td></tr>`;
  });
  w.document.write(`<html><head><title>Relatório Recupera+</title><style>body{font-family:Arial;color:#14324a;padding:30px}h1{color:#0ea5a4}table{border-collapse:collapse;width:100%;margin-top:20px}th,td{border:1px solid #dde6ee;padding:10px;text-align:left;font-size:14px}th{background:#e0f5f4}.box{border:1px solid #dde6ee;border-radius:10px;padding:15px;margin-top:20px}</style></head><body>
    <h1>Recupera+ · Relatório de Acompanhamento</h1>
    <p><b>Paciente:</b> ${D.patient.age||''} anos · <b>Cirurgia:</b> ${D.typeInfo.name} · ${fmtDate(D.patient.surgery_date)}</p>
    <p><b>Gerado em:</b> ${new Date().toLocaleString('pt-PT')}</p>
    <table><tr><th>Data</th><th>Dor</th><th>Exercícios</th><th>Medicação</th></tr>${rows}</table>
    <div class="box"><b>Sinais de alarme:</b> procure o médico se tiver febre &gt;38°C, inchaço anormal ou dor fora do esperado.</div>
  </body></html>`);
  w.document.close(); w.focus(); setTimeout(()=>w.print(),500);
}

/* ================= Exercícios ================= */
let exMode='today';
function exFilter(m){
  exMode=m;
  document.querySelectorAll('#exSeg button').forEach(b=>b.classList.toggle('on',b.textContent.trim()===(m==='today'?'Hoje':m==='all'?'Todas':'Biblioteca')));
  renderEx();
}
async function renderEx(){
  if(exMode==='today'){ $('#exList').innerHTML = D.exercises.map(exCard).join(''); return; }
  PLAN = PLAN || await api(`/api/patients/${S.id}/plan`);
  const all = PLAN.library.flatMap(f=>f.exercises.map(e=>({...e,fase:f.fase})));
  if(exMode==='all'){
    $('#exList').innerHTML = all.map(e=>`<div class="ex-item"><div class="ex-thumb">${e.em}</div>
      <div class="ex-info"><div class="n">${e.name}</div><div class="d">${e.desc}</div><div class="set">${e.sets} · Fase ${e.fase}</div></div></div>`).join('');
  } else {
    $('#exList').innerHTML = all.map(e=>`<div class="ex-item"><div class="ex-thumb">${e.em}</div>
      <div class="ex-info"><div class="n">${e.name}</div><div class="d">${e.desc}</div><div class="set">${D.patient.premium?'🎬 Vídeo · ':''}${e.tip}</div></div>
      ${D.patient.premium?'':`<span class="lock-tag">🔒</span>`}</div>`).join('')
      + (D.patient.premium?'':`<button class="btn gold" style="margin:0 16px" onclick="showPremium()">🔓 Desbloquear vídeos</button>`);
  }
}

/* ================= Medicação ================= */
async function renderMed(){ $('#medList').innerHTML = D.meds.length? D.meds.map(medCard).join('') : empty('💊','Sem lembretes.'); }
async function addMed(){
  const n=$('#medName').value.trim(), t=$('#medTime').value;
  if(!n){toast('Indica o nome');return;}
  await api(`/api/patients/${S.id}/meds`,{method:'POST',body:JSON.stringify({name:n,time:t})});
  $('#medName').value=''; await refresh(); renderMed(); toast('Lembrete adicionado 💊');
}

/* ================= Perfil ================= */
function renderPerfil(){
  const t=D.typeInfo;
  $('#pfAvatar').textContent=t.em;
  $('#pfName').textContent=`Paciente · ${D.patient.age||'?'} anos`;
  $('#pfMeta').textContent=`${t.name} · Cirurgia a ${fmtDate(D.patient.surgery_date)}`;
  $('#pfPlanName').textContent=D.patient.premium?'Premium':'Gratuito (MVP)';
  $('#pfPlanFeatures').textContent=D.patient.premium
    ?'Gráficos · Vídeos · Relatório PDF · Plano ajustado · Alertas · Partilha'
    :'Exercícios diários · Diário de dor · Medicação · 1 tipo de cirurgia';
}

/* ================= Premium ================= */
/* ================= ASSINATURA PREMIUM ================= */
function showPremium(){ go('premium'); renderPremium(); }
async function renderPremium(){
  if(!S.token){ toast('Inicie sessão para gerir a assinatura'); return; }
  try{
    const d = await apiAuth(`/api/patients/${S.id}/subscription`);
    const sub = d.subscription;
    // estado
    const map = {
      none:{t:'Plano gratuito', d:'Faça upgrade para desbloquear todas as funcionalidades.', cls:'', badge:'Gratuito'},
      active:{t:'Premium ativo', d:'Obrigado! A sua subscrição está ativa.', cls:'on', badge:'💎 Ativo'},
      trialing:{t:'Período de teste', d:'Está a experimentar o Premium.', cls:'on', badge:'✨ Teste'},
      canceled:{t:'Subscrição cancelada', d:'Acesso termina no fim do período atual.', cls:'', badge:'⏸ Cancelado'},
      expired:{t:'Subscrição expirada', d:'Renove para continuar com o Premium.', cls:'', badge:'⏳ Expirado'},
      past_due:{t:'Pagamento em atraso', d:'Atualize o método de pagamento.', cls:'', badge:'⚠️ Atraso'},
    }[sub.status] || {t:'Plano gratuito', d:'Sem subscrição ativa.', cls:'', badge:'Gratuito'};
    $('#premStateTitle').textContent = map.t;
    $('#premStateDetail').textContent = sub.renews_at ? `Renova a ${fmtDate(sub.renews_at)} · ${sub.plan||''}` : map.d;
    $('#premStateBadge').innerHTML = `<span class="chip">${map.badge}</span>`;
    // ações
    let actions='';
    if(sub.status==='active'||sub.status==='trialing'){
      actions = `<div class="btn-row">
        <button class="btn danger sm" style="flex:1" onclick="cancelSub()">Cancelar</button>
        <button class="btn ghost sm" style="flex:1" onclick="upgradeSub()">Mudar plano</button>
      </div>
      <button class="btn ghost sm mt4" style="margin-top:8px;width:100%" onclick="openBillingPortal()">💳 Gerir pagamento / método</button>`;
    } else if(sub.status==='canceled'||sub.status==='expired'){
      actions = `<button class="btn gold" style="width:100%" onclick="reactivateSub()">Reativar subscrição</button>`;
    }
    $('#premStateActions').innerHTML = actions;
    // planos
    $('#premPlans').innerHTML = d.plans.map(p=>{
      const cur = sub.plan===p.id;
      const per = p.interval==='month'?'/mês':p.interval==='quarter'?'/trimestre':'/ano';
      return `<div class="ex-item" style="${cur?'border-color:var(--gold);background:var(--gold-soft)':''}">
        <div class="ex-thumb" style="background:var(--gold-soft)">💎</div>
        <div class="ex-info"><div class="n">${p.name}</div>
          <div class="set">${curSymbol()} ${p.amount.toFixed(2)} ${per}</div></div>
        <button class="btn sm ${cur?'ghost':'gold'}" ${cur?'disabled style="opacity:.6"':''} onclick="startSub('${p.id}')">${cur?'Ativo':'Assinar'}</button>
      </div>`;
    }).join('');
    // faturas
    const inv = await apiAuth(`/api/patients/${S.id}/invoices`);
    $('#premInvoices').innerHTML = inv.invoices.length
      ? inv.invoices.map(i=>`<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #eef3f8"><span class="tiny">${fmtDate(i.period_start)} · ${i.plan}</span><span style="font-weight:800">${curSymbol(i.currency)} ${i.amount}</span></div>`).join('')
      : '<div class="empty" style="padding:14px"><span class="em">🧾</span>Sem faturas ainda.</div>';
  }catch(e){ toast(e.message); }
}
let selPlan = null;
async function startSub(plan){
  selPlan = plan;
  // mostra o seletor de método de pagamento
  const g = await api('/api/payment/gateways');
  const method = prompt(
    'Método de pagamento:\n1 · M-Pesa (Vodacom)\n2 · e-Mola (Movitel)\n3 · Cartão de crédito/débito\n4 · PayPal\n\nEscolha 1-4:', '1'
  );
  const methods = { '1':'mpesa', '2':'emola', '3':'card', '4':'paypal' };
  const m = methods[String(method||'').trim()] || 'mpesa';
  let phone = null;
  if(m==='mpesa' || m==='emola'){
    phone = prompt('Número de telemóvel (ex.: 84 123 4567):','');
    if(!phone){ toast('Indique o número para o pagamento'); return; }
  }
  try{
    const r = await apiAuth('/api/payment/checkout-mz', { method:'POST', body:JSON.stringify({ patientId:S.id, plan, method:m, phone }) });
    if(r.url){
      // PayPal → redirecionar para aprovação
      toast('A abrir o PayPal...');
      window.location.href = r.url;
      return;
    }
    if(r.demo){
      // modo demo → confirmar a simulação
      const ok = confirm('Modo demonstração (sem gateway ligado).\nSimular o pagamento de '+r.amount+' '+r.currency+'?');
      if(ok){
        await apiAuth('/api/payment/simulate', { method:'POST', body:JSON.stringify({ patientId:S.id, plan, provider:m, paymentId:r.paymentId }) });
        toast('💎 Subscrição ativada (demonstração)!');
        await refresh(); renderPremium(); renderHome(); renderPerfil();
      }
      return;
    }
    // SMOO Pay: após pagamento, confirmar
    const done = confirm(r.provider==='smoopay'
      ? 'Confirmar pagamento M-Pesa/e-Mola/cartão? (O cliente autoriza no telemóvel)'
      : 'Pagamento concluído?');
    if(done){
      await apiAuth('/api/payment/confirm', { method:'POST', body:JSON.stringify({ patientId:S.id, plan, provider:r.provider, providerRef:r.paymentId }) });
      toast('💎 Subscrição ativada!');
      await refresh(); renderPremium(); renderHome(); renderPerfil();
    }
  }catch(e){ toast(e.message); }
}
async function openBillingPortal(){
  try{
    const r = await apiAuth(`/api/billing/portal`, { method:'POST', body:JSON.stringify({ patientId:S.id }) });
    window.open(r.url,'_blank');
  }catch(e){ toast(e.message); }
}
async function cancelSub(){
  if(!confirm('Cancelar a subscrição? O acesso Premium termina no fim do período.')) return;
  try{
    await apiAuth(`/api/patients/${S.id}/subscription/cancel`, {method:'POST'});
    toast('Subscrição cancelada'); await refresh(); renderPremium(); renderHome();
  }catch(e){ toast(e.message); }
}
async function reactivateSub(){
  try{
    await apiAuth(`/api/patients/${S.id}/subscription/reactivate`, {method:'POST'});
    toast('Subscrição reativada!'); await refresh(); renderPremium(); renderHome();
  }catch(e){ toast(e.message); }
}
async function upgradeSub(){
  const plan = prompt('Novo plano (monthly/quarterly/yearly):','yearly');
  if(!plan) return;
  await startSub(plan);
}

/* ================= Utils ================= */
function empty(em,txt){ return `<div class="empty"><span class="em">${em}</span>${txt}</div>`; }
async function resetApp(){ await api('/api/reset',{method:'POST'}); location.reload(); }

/* ================= AUTENTICAÇÃO ================= */
async function auLogin(){
  const email=$('#auEmail').value.trim(), pass=$('#auPass').value;
  if(!email||!pass){ toast('Preenche email e password'); return; }
  try{
    const res = await apiAuth('/api/auth/login', { method:'POST', body:JSON.stringify({email, password:pass}) });
    S.token=res.token; sessionStorage.setItem('recupera_token', res.token); S.user=res.user; S.role=res.user.role;
    await afterAuth();
  }catch(e){ toast(e.message); }
}
async function auRegister(){
  const email=$('#auEmail').value.trim(), pass=$('#auPass').value;
  if(!email||!pass){ toast('Preenche email e password'); return; }
  if(pass.length<6){ toast('Password: min 6 caracteres'); return; }
  const role = confirm('Criar conta de CLÍNICA (painel profissional)?\nOK = clínica · Cancelar = paciente');
  try{
    const res = await apiAuth('/api/auth/register', { method:'POST', body:JSON.stringify({email, password:pass, role:role?'clinic':'patient'}) });
    S.token=res.token; sessionStorage.setItem('recupera_token', res.token); S.user=res.user; S.role=res.user.role;
    await afterAuth();
  }catch(e){ toast(e.message); }
}
async function afterAuth(){
  $('#auEmail').value=''; $('#auPass').value='';
  if(S.role==='clinic'){
    $('#nav').style.display='none';
    showAuth(false);
    await renderClinic(); go('clinic');
  } else {
    $('#nav').style.display='flex';
    const stored = sessionStorage.getItem('recupera_id');
    if(stored){ S.id=stored; }
    else {
      // paciente novo sem paciente ligado → criar plano via onboarding
      $('#onboarding').classList.add('active'); showObStep();
      return;
    }
    await refresh(); $('#onboarding').classList.remove('active'); render(); go('home');
  }
}
async function auLogout(){
  try{ await apiAuth('/api/auth/logout',{method:'POST'}); }catch(e){}
  sessionStorage.removeItem('recupera_token'); sessionStorage.removeItem('recupera_id');
  S.token=null; S.user=null; location.reload();
}
function showAuth(show=true){ $('#sc-auth').classList.toggle('active', show); }

/* ================= PERFIL + NOVAS CAMADAS ================= */
async function renderPerfil(){
  const t=D.typeInfo;
  $('#pfAvatar').textContent=t.em;
  $('#pfName').textContent=`Paciente · ${D.patient.age||'?'} anos`;
  $('#pfMeta').textContent=`${t.name} · Cirurgia a ${fmtDate(D.patient.surgery_date)}`;
  const sub = D.patient.subscription||{status:'none'};
  const subLabel = {active:'💎 Premium ativo', canceled:'Subscrição cancelada', expired:'Subscrição expirada', none:'Plano gratuito (MVP)', trialing:'✨ Período de teste', past_due:'Pagamento em atraso'}[sub.status]||'Plano gratuito (MVP)';
  $('#pfPlanName').textContent=subLabel;
  $('#pfPlanFeatures').textContent=D.patient.premium
    ?(sub.renews_at?('Renova a '+fmtDate(sub.renews_at))+' · Gráficos · Vídeos · PDF · Alertas · Partilha':'Gráficos · Vídeos · PDF · Alertas · Partilha')
    :'Exercícios diários · Diário de dor · Medicação';
  // conta
  $('#pfAccountEmail').textContent = S.user ? S.user.email : 'Não ligado';
  $('#pfAccountRole').textContent = S.user ? (S.user.role==='clinic'?'Clínica':'Paciente') : '—';
  // alertas
  try{
    const a = await api(`/api/patients/${S.id}/alerts`);
    $('#pfAlerts').innerHTML = a.alerts.length ? a.alerts.map(al=>`<div class="alert-item"><div class="ic">🚨</div><div class="tiny">${al.message}<div class="muted">${al.created_at}</div></div></div>`).join('') : '<div class="empty" style="padding:14px"><span class="em">✅</span>Sem alertas. Tudo a correr bem.</div>';
  }catch(e){ $('#pfAlerts').innerHTML=''; }
  // consultas
  try{
    const ap = await api(`/api/patients/${S.id}/appointments`);
    $('#pfAppts').innerHTML = ap.appointments.length ? ap.appointments.map(x=>`<div class="alert-item"><div class="ic" style="background:var(--teal-soft)">📅</div><div class="tiny"><b>${x.title}</b><div class="muted">${fmtDate(x.date)}${x.note?' · '+x.note:''}</div></div></div>`).join('') : '<div class="empty" style="padding:14px"><span class="em">📅</span>Sem consultas marcadas.</div>';
  }catch(e){ $('#pfAppts').innerHTML=''; }
  // estado da conta
  $('#pfAuthBtn').style.display = S.user ? 'block' : 'none';
  $('#pfAuthBtn').textContent = 'Terminar sessão ('+(S.user?S.user.email:'')+')';
  // dashboard de receitas: visível para o dono (clinic/owner)
  const isOwner = S.user && (S.user.role==='clinic'||S.user.role==='owner');
  $('#pfRevenueBtn').style.display = isOwner ? 'block' : 'none';
  $('#pfPaySettingsBtn').style.display = isOwner ? 'block' : 'none';
  // estado das notificações
  syncPushUI();
}
async function pfAddAppt(){
  const title=prompt('Título da consulta:','Consulta de seguimento');
  if(!title) return;
  const date=prompt('Data (AAAA-MM-DD):', new Date(Date.now()+7*864e5).toISOString().slice(0,10));
  if(!date) return;
  try{ await apiAuth(`/api/patients/${S.id}/appointments`,{method:'POST',body:JSON.stringify({title,date})}); toast('Consulta agendada 📅'); renderPerfil(); }catch(e){ toast(e.message); }
}
async function pfShare(){
  try{
    const r = await apiAuth(`/api/patients/${S.id}/share`,{method:'POST'});
    toast('Código de convite: '+r.inviteCode);
  }catch(e){ toast(e.message); }
}

/* ================= WEB PUSH ================= */
let pushEnabled = false;
let swReg = null;
let vapidKey = null;

// Registar service worker + pedir permissão + subscrever
async function enablePush(){
  if(!('serviceWorker' in navigator) || !('PushManager' in window)){
    toast('Push não suportado neste browser'); return false;
  }
  try{
    // permissão
    const perm = await Notification.requestPermission();
    if(perm !== 'granted'){ toast('Permissão de notificações negada'); return false; }
    // registar SW
    swReg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    // obter VAPID
    const cfg = await api('/api/config');
    vapidKey = cfg.vapidPublicKey;
    // subscrever
    const sub = await swReg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidKey),
    });
    // enviar subscrição ao servidor
    await apiAuth('/api/push/subscribe', { method:'POST', body:JSON.stringify({ endpoint: sub.endpoint, keys:{ auth: arrayToBase64(sub.getKey('auth')), p256dh: arrayToBase64(sub.getKey('p256dh')) }, patientId: S.id }) });
    pushEnabled = true;
    localStorage.setItem('recupera_push','on');
    return true;
  }catch(e){ console.error(e); toast('Erro ao ativar push: '+e.message); return false; }
}

async function togglePush(){
  const sw=$('#pushSwitch');
  if(pushEnabled){
    // desativar
    pushEnabled=false;
    localStorage.setItem('recupera_push','off');
    sw.classList.remove('on');
    try{ await apiAuth('/api/push/subscribe',{method:'DELETE'}); }catch(e){}
    $('#pushStatus').textContent='Estado: desativado';
    toast('Notificações desativadas');
  } else {
    const ok = await enablePush();
    if(ok){ sw.classList.add('on'); $('#pushStatus').textContent='Estado: ativado 🔔'; toast('Notificações ativadas!'); }
  }
}

async function testPush(){
  if(!pushEnabled){ toast('Ativa primeiro as notificações'); return; }
  try{
    const r = await apiAuth('/api/push/test',{method:'POST'});
    toast('Notificação enviada ('+(r.sent||0)+' dispositivo) 📨');
  }catch(e){ toast(e.message); }
}

// helpers base64
function urlBase64ToUint8Array(base64String){
  const padding='='.repeat((4-base64String.length%4)%4);
  const base64=(base64String+padding).replace(/-/g,'+').replace(/_/g,'/');
  const raw=atob(base64);
  const arr=new Uint8Array(raw.length);
  for(let i=0;i<raw.length;i++) arr[i]=raw.charCodeAt(i);
  return arr;
}
function arrayToBase64(buffer){
  let binary='';
  const bytes=new Uint8Array(buffer);
  for(let i=0;i<bytes.length;i++) binary+=String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// restaurar estado do push ao entrar no perfil
async function syncPushUI(){
  const sw=$('#pushSwitch');
  if(!sw) return;
  const state = localStorage.getItem('recupera_push');
  if(state==='on' && 'serviceWorker' in navigator && 'PushManager' in window){
    try{
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if(sub){ pushEnabled=true; sw.classList.add('on'); $('#pushStatus').textContent='Estado: ativado 🔔'; return; }
    }catch(e){}
  }
  sw.classList.remove('on');
  $('#pushStatus').textContent='Estado: desativado';
}

/* ================= CHAT (tempo real) ================= */
let chatMessages = [];
let chatES = null; // EventSource
let chatOpen = false;

function goChat(){
  go('chat');
  openChat();
}

async function openChat(){
  if(!S.token || !S.id){ toast('Inicie sessão para usar o chat'); return; }
  chatOpen = true;
  $('#chatSubtitle').textContent = S.role==='clinic' ? 'Converse com o seu paciente' : 'Converse com o seu fisioterapeuta';
  try{
    const data = await apiAuth(`/api/patients/${S.id}/messages`);
    chatMessages = data.messages||[];
    renderChat();
  }catch(e){ toast(e.message); }
  // abrir stream SSE (tempo real)
  if(chatES) chatES.close();
  const es = new EventSource(`/api/patients/${S.id}/messages/stream`, { headers: { 'Authorization':'Bearer '+S.token } });
  chatES = es;
  es.onmessage = (ev)=>{
    try{
      const msg = JSON.parse(ev.data);
      chatMessages.push(msg);
      renderChat(true);
    }catch(e){}
  };
  es.onerror = ()=>{ /* EventSource reconecta automaticamente */ };
}

function closeChat(){
  chatOpen = false;
  if(chatES){ chatES.close(); chatES=null; }
}

function renderChat(scrollToBottom=true){
  const box = $('#chatMessages');
  if(!chatMessages.length){ box.innerHTML = '<div class="empty"><span class="em">💬</span>Sem mensagens ainda. Diga olá ao seu fisioterapeuta!</div>'; return; }
  box.innerHTML = chatMessages.map(m=>{
    const mine = m.sender_role !== 'clinic' && (m.sender_role==='patient');
    // para a clínica, as mensagens do paciente aparecem como 'theirs'
    const isMine = (S.role==='patient' && m.sender_role==='patient') || (S.role==='clinic' && m.sender_role==='clinic');
    const cls = isMine ? 'bubble mine' : 'bubble theirs';
    const time = (m.created_at||'').slice(11,16);
    return `<div class="${cls}">${m.body}<div class="meta">${m.sender_name||''} · ${time}</div></div>`;
  }).join('');
  if(scrollToBottom) box.scrollTop = box.scrollHeight;
}

async function sendChat(){
  const input = $('#chatInput');
  const body = input.value.trim();
  if(!body) return;
  input.value='';
  try{
    const r = await apiAuth(`/api/patients/${S.id}/messages`, { method:'POST', body:JSON.stringify({ body }) });
    // o SSE também vai entregar, mas adicionamos já para não esperar
    const dup = chatMessages.find(x=>x.id===r.message.id);
    if(!dup) chatMessages.push(r.message);
    renderChat();
  }catch(e){ toast(e.message); input.value=body; }
}

/* ================= CLÍNICA (B2B2C) ================= */
async function renderClinic(){
  const list = await apiAuth('/api/clinic/patients');
  const rep = await apiAuth('/api/clinic/report');
  $('#clTotal').textContent = rep.totalPatients;
  $('#clAdh').textContent = rep.avgAdherence+'%';
  $('#clPain').textContent = rep.avgPain==null?'—':rep.avgPain+'/10';
  $('#clPatientList').innerHTML = list.patients.length ? list.patients.map(p=>{
    const tone = p.lastPain==null?'—':`${p.lastPain}/10`;
    return `<div class="ex-item"><div class="ex-thumb">${p.type==='joelho'?'🦵':p.type==='anca'?'🦴':p.type==='coluna'?'🩻':p.type==='cardiaca'?'❤️':p.type==='posparto'?'👶':'🏥'}</div>
      <div class="ex-info"><div class="n">${p.name}</div><div class="d">Fase ${p.phase+1} · Semana ${p.weeks} · Dor ${tone}</div><div class="set">Adesão ${p.adherence.exercises}%</div></div></div>`;
  }).join('') : '<div class="empty"><span class="em">👥</span>Nenhum paciente ligado ainda.</div>';
}
/* ================= DASHBOARD DE RECEITAS (dono) ================= */
async function renderRevenue(){
  if(!S.token){ toast('Inicie sessão'); return; }
  try{
    const d = await apiAuth('/api/owner/revenue');
    const t = d.totais;
    S.currency = d.currency||'USD';
    $('#rvTotal').textContent = curSymbol(S.currency)+' '+t.totalFaturado.toFixed(2);
    $('#rvSubs').textContent = t.assinantesAtivos;
    $('#rvCancel').textContent = t.taxaCancelamento+'%';
    $('#rvMonth').textContent = curSymbol(S.currency)+' '+t.receitaMes.toFixed(2);
    drawRevenueChart('#rvChartMonth', d.monthly, 'valor');
    // por plano
    $('#rvByPlan').innerHTML = d.byPlan.map(p=>{
      const names={monthly:'Mensal',quarterly:'Trimestral',yearly:'Anual'};
      const pct = t.totalFaturado>0 ? Math.round(p.valor/t.totalFaturado*100) : 0;
      return `<div style="margin-bottom:10px"><div style="display:flex;justify-content:space-between"><span class="tiny">${names[p.plan]||p.plan}</span><span style="font-weight:800">${curSymbol(S.currency)} ${p.valor.toFixed(2)} <span class="tiny muted">(${p.fat} fat.)</span></span></div>
        <div class="bar"><i style="width:${pct}%"></i></div></div>`;
    }).join('');
    // por método de pagamento
    drawProviderChart(d.byProvider);
    // crescimento de assinantes
    drawGrowthChart(d.subGrowth);
  }catch(e){ toast(e.message); }
}
function drawRevenueChart(sel, series, key){
  const svg = $(sel);
  const W=360,H=150,padL=30,padR=8,padT=16,padB=24;
  const vals = series.map(s=>s[key]);
  const max = Math.max(...vals, 1);
  const bw = (W-padL-padR)/series.length;
  let out=`<svg class="chart" viewBox="0 0 ${W} ${H}">`;
  for(let g=0;g<=4;g++){ const y=padT+(H-padT-padB)*(1-g/4); out+=`<line x1="${padL}" y1="${y}" x2="${W-padR}" y2="${y}" stroke="#eef3f8"/><text x="${padL-4}" y="${y+3}" font-size="8" fill="#9db1c2" text-anchor="end">${Math.round(max*g/4)}</text>`; }
  series.forEach((s,i)=>{ const h=(s[key]/max)*(H-padT-padB); const x=padL+i*bw+bw*0.2, y=H-padB-h;
    out+=`<rect x="${x}" y="${y}" width="${bw*0.6}" height="${h}" rx="4" fill="var(--teal)"/>`;
    out+=`<text x="${x+bw*0.3}" y="${H-padB+12}" font-size="9" fill="#9db1c2" text-anchor="middle">${s.mes.slice(5)}</text>`; });
  out+='</svg>';
  svg.outerHTML = out;
}
function drawProviderChart(byProvider){
  const colors=['#0ea5a4','#ff8a4c','#2fb873','#b8860b'];
  const total = byProvider.reduce((a,b)=>a+b.valor,0)||1;
  const names={mpesa:'M-Pesa',emola:'e-Mola',paypal:'PayPal',card:'Cartão'};
  let legend='';
  let cx=180, cy=75, r=55;
  let start=-Math.PI/2;
  let out=`<svg class="chart" viewBox="0 0 360 150">`;
  byProvider.forEach((p,i)=>{
    const frac=p.valor/total;
    const end=start+frac*2*Math.PI;
    const x1=cx+r*Math.cos(start), y1=cy+r*Math.sin(start);
    const x2=cx+r*Math.cos(end), y2=cy+r*Math.sin(end);
    const large=frac>0.5?1:0;
    out+=`<path d="M${cx},${cy} L${x1},${y1} A${r},${r} 0 ${large} 1 ${x2},${y2} Z" fill="${colors[i%colors.length]}"/>`;
    legend+=`<span><i style="background:${colors[i%colors.length]}"></i>${names[p.provider]||p.provider} ${(frac*100).toFixed(0)}%</span>`;
    start=end;
  });
  if(byProvider.length===0) out+=`<text x="180" y="78" font-size="11" fill="#9db1c2" text-anchor="middle">Sem dados</text>`;
  out+='</svg>';
  $('#rvChartProvider').outerHTML=out;
  $('#rvProviderLegend').innerHTML=legend;
}
function drawGrowthChart(subGrowth){
  const svg=$('#rvChartGrowth');
  const W=360,H=150,padL=8,padR=8,padT=16,padB=24;
  const max=Math.max(...subGrowth.map(s=>s.c),1);
  const bw=(W-padL-padR)/subGrowth.length;
  let out=`<svg class="chart" viewBox="0 0 ${W} ${H}">`;
  subGrowth.forEach((s,i)=>{ const h=(s.c/max)*(H-padT-padB); const x=padL+i*bw+bw*0.2, y=H-padB-h;
    out+=`<rect x="${x}" y="${y}" width="${bw*0.6}" height="${h}" rx="4" fill="var(--accent)"/><text x="${x+bw*0.3}" y="${H-padB+12}" font-size="9" fill="#9db1c2" text-anchor="middle">${s.mes.slice(5)}</text>`; });
  if(subGrowth.length===0) out+=`<text x="180" y="78" font-size="11" fill="#9db1c2" text-anchor="middle">Sem dados</text>`;
  out+='</svg>';
  svg.outerHTML=out;
}

/* ================= CONFIGURAÇÕES DE PAGAMENTO (dono) ================= */
async function loadPaySettings(){
  if(!S.token){ toast('Inicie sessão'); return; }
  try{
    const d = await apiAuth('/api/owner/payment-settings');
    $('#psSmoopayEndpoint').value = d.smoopy.endpoint;
    $('#psPaypalEnv').value = d.paypal.env;
    $('#psCurrency').value = d.currency;
    $('#psSmoopayStatus').innerHTML = d.smoopy.apiKeySet
      ? '<span style="color:var(--ok)">✓ Chave SMOO Pay configurada</span>' : '<span class="muted">— Chave SMOO Pay não definida (modo demo)</span>';
    $('#psPaypalStatus').innerHTML = (d.paypal.clientIdSet&&d.paypal.secretSet)
      ? '<span style="color:var(--ok)">✓ PayPal configurado</span>' : '<span class="muted">— PayPal não definido (opcional)</span>';
    if(d.demo) toast('⚠️ Sem gateways — os pagamentos estão em modo demo');
  }catch(e){ toast(e.message); }
}
async function savePaySettings(){
  if(!S.token){ toast('Inicie sessão'); return; }
  const key = $('#psSmoopayKey').value.trim();
  const pid = $('#psPaypalId').value.trim();
  const sec = $('#psPaypalSecret').value.trim();
  if(!key && !pid){ toast('Cole pelo menos a chave SMOO Pay ou o Client ID PayPal'); return; }
  try{
    const body = {
      smoopy_endpoint: $('#psSmoopayEndpoint').value.trim(),
      paypal_env: $('#psPaypalEnv').value,
      currency: $('#psCurrency').value,
    };
    if(key) body.smoopay_api_key = key;
    if(pid) body.paypal_client_id = pid;
    if(sec) body.paypal_client_secret = sec;
    const d = await apiAuth('/api/owner/payment-settings', { method:'POST', body:JSON.stringify(body) });
    toast('✅ '+d.message);
    $('#psSmoopayKey').value=''; $('#psPaypalId').value=''; $('#psPaypalSecret').value='';
    loadPaySettings();
  }catch(e){ toast(e.message); }
}

async function clNewInvite(){
  try{
    const r = await apiAuth(`/api/patients/${S.id||1}/share`,{method:'POST'});
    $('#clInviteCode').textContent = r.inviteCode;
  }catch(e){ toast(e.message); }
}

/* ================= Boot ================= */
(async function boot(){
  await initOb();
  if(S.token){
    try{
      const me = await apiAuth('/api/auth/me');
      S.user=me.user; S.role=me.user.role;
      if(S.role==='clinic'){ $('#nav').style.display='none'; await renderClinic(); go('clinic'); return; }
      const stored = sessionStorage.getItem('recupera_id');
      if(stored){ S.id=stored; try{ await refresh(); $('#onboarding').classList.remove('active'); render(); go('home'); return; }catch(e){} }
      $('#nav').style.display='flex'; $('#onboarding').classList.add('active'); showObStep();
      return;
    }catch(e){ /* sessão inválida */ }
  }
  $('#nav').style.display='none';
  showAuth(true); go('auth');
})();
function render(){ renderHome(); }
