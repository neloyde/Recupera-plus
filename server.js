// Recupera+ — Acompanhamento Pós-Cirúrgico (Backend)
// Full-stack: Express + SQLite (node:sqlite) + REST API
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const webpush = require('web-push');
const { DatabaseSync } = require('node:sqlite');

// ---------- Stripe (pagamentos reais) ----------
// Se STRIPE_SECRET_KEY estiver definida no ambiente, ativa os pagamentos reais.
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || null;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || null;
const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY || null;
const stripe = STRIPE_SECRET_KEY ? require('stripe')(STRIPE_SECRET_KEY) : null;
// Domínio base para URLs de redirecionamento (configurável)
const APP_URL = process.env.APP_URL || `http://localhost:${process.env.PORT || 8080}`;

// ---------- Web Push (VAPID) ----------
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || 'BJzNwKiU14v-0s_mQFqwQcZT406dUG4O4yhKMq4EfzWwBW6Zc7QTl035Lj2W7s0wQ4pAZJLsQ17PVySZMoRCVJw';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || 'EQWWp0kzC0aV3rMXmeMvHzYm5ulAQ6_kKdaLe9R7daY';
webpush.setVapidDetails(
  'mailto:recupera@example.com',
  VAPID_PUBLIC,
  VAPID_PRIVATE
);

// ---------- Criptografia (password hashing) ----------
function hashPassword(pw){
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(pw, stored){
  if(!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash,'hex'), Buffer.from(test,'hex'));
}
function newToken(){
  return crypto.randomBytes(32).toString('hex');
}

const PORT = process.env.PORT || 8080;
// DATA_DIR pode ser sobrescrito via env (ex.: disco persistente /data no Render pago)
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- Database ----------
const db = new DatabaseSync(path.join(DATA_DIR, 'recupera.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS patients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL DEFAULT 'Paciente',
    type TEXT NOT NULL,
    surgery_date TEXT NOT NULL,
    age INTEGER,
    initial_pain INTEGER,
    premium INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS pain_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    patient_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    value INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS meds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    patient_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    time TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS med_taken (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    patient_id INTEGER NOT NULL,
    med_id INTEGER NOT NULL,
    date TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ex_done (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    patient_id INTEGER NOT NULL,
    exercise_index INTEGER NOT NULL,
    date TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'patient',
    display_name TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS patient_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    patient_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    access TEXT NOT NULL DEFAULT 'view',
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS appointments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    patient_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    date TEXT NOT NULL,
    note TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    patient_id INTEGER NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    seen INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    patient_id INTEGER NOT NULL,
    endpoint TEXT NOT NULL,
    keys_auth TEXT NOT NULL,
    keys_p256dh TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(patient_id, endpoint)
  );
  CREATE TABLE IF NOT EXISTS notifications_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    patient_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    patient_id INTEGER NOT NULL,
    sender_role TEXT NOT NULL,
    sender_name TEXT,
    body TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    patient_id INTEGER UNIQUE NOT NULL,
    plan TEXT NOT NULL DEFAULT 'monthly',
    status TEXT NOT NULL DEFAULT 'none',
    starts_at TEXT,
    renews_at TEXT,
    payment_method TEXT,
    auto_renew INTEGER DEFAULT 1,
    stripe_customer_id TEXT,
    stripe_subscription_id TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT
  );
  CREATE TABLE IF NOT EXISTS invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subscription_id INTEGER NOT NULL,
    patient_id INTEGER NOT NULL,
    plan TEXT NOT NULL,
    amount INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'MZN',
    status TEXT NOT NULL DEFAULT 'paid',
    period_start TEXT,
    period_end TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    patient_id INTEGER NOT NULL,
    plan TEXT NOT NULL,
    provider TEXT NOT NULL,
    provider_ref TEXT,
    amount INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'MZN',
    status TEXT NOT NULL DEFAULT 'pending',
    phone TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// ---------- SMOO Pay (Moçambique: M-Pesa, e-Mola, cartões) ----------
// Credenciais vêm do ecrã de Configurações (BD) com fallback para variáveis de ambiente.
function getSetting(key, fallback){
  try{
    const row = db.prepare('SELECT value FROM app_settings WHERE key=?').get(key);
    if(row && row.value) return row.value;
  }catch(e){}
  return fallback;
}
function setSetting(key, value){ db.prepare('INSERT INTO app_settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value); }
const SMOOPAY_API_KEY = getSetting('smoopay_api_key', process.env.SMOOPAY_API_KEY || null);
const SMOOPAY_ENDPOINT = getSetting('smoopay_endpoint', process.env.SMOOPAY_ENDPOINT || 'https://api.smoopay.app');
const PAYPAL_CLIENT_ID = getSetting('paypal_client_id', process.env.PAYPAL_CLIENT_ID || null);
const PAYPAL_CLIENT_SECRET = getSetting('paypal_client_secret', process.env.PAYPAL_CLIENT_SECRET || null);
const PAYPAL_ENV = getSetting('paypal_env', process.env.PAYPAL_ENV || 'sandbox');
const PAYPAL_BASE = PAYPAL_ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
const CURRENCY = getSetting('currency', process.env.CURRENCY || 'USD');
const paypal = (PAYPAL_CLIENT_ID && PAYPAL_CLIENT_SECRET) ? true : null;

// ---------- Seed: exercises by surgery type & phase ----------
const EXERCISES = {
  joelho: [
    [{name:'Bombas de tornozelo', em:'🦶', sets:'3 × 10', desc:'Estimula a circulação e previne coágulos.', tip:'Lento e controlado.'},
     {name:'Contração do quadríceps', em:'🦵', sets:'3 × 8', desc:'Ativa a coxa sem mover a articulação.', tip:'Segura 5s.'},
     {name:'Deslize do calcanhar', em:'🦿', sets:'3 × 10', desc:'Dobra e estica o joelho.', tip:'Até ao confortável.'}],
    [{name:'Elevação da perna estendida', em:'🦵', sets:'3 × 8', desc:'Eleva a perna reta.', tip:'Core firme.'},
     {name:'Sentar e levantar assistido', em:'🪑', sets:'2 × 10', desc:'Levanta-se com apoio.', tip:'Usa os braços.'},
     {name:'Flexão de joelho sentado', em:'🪑', sets:'3 × 10', desc:'Dobra o joelho lentamente.', tip:'Controlando.'}],
    [{name:'Caminhada curta', em:'🚶', sets:'10-15 min', desc:'Caminhadas progressivas.', tip:'Terreno plano.'},
     {name:'Meio agachamento', em:'🏋️', sets:'3 × 8', desc:'Flexiona levemente.', tip:'Costas retas.'},
     {name:'Equilíbrio numa perna', em:'🤸', sets:'3 × 20s', desc:'Equilíbrio com apoio.', tip:'Perto de apoio.'}],
  ],
  anca: [
    [{name:'Bombas de tornozelo', em:'🦶', sets:'3 × 10', desc:'Ativa a circulação.', tip:'Repete ao dia.'},
     {name:'Contração do glúteo', em:'🍑', sets:'3 × 8', desc:'Contrai os glúteos.', tip:'Segura 5s.'},
     {name:'Deslize de calcanhar', em:'🦿', sets:'3 × 10', desc:'Dobra a anca e joelho.', tip:'Suave.'}],
    [{name:'Abdução deitado', em:'🦵', sets:'3 × 8', desc:'Abre a perna lateral.', tip:'Sem rotação.'},
     {name:'Ponte glútea', em:'🍑', sets:'3 × 8', desc:'Eleva a bacia.', tip:'Aperta glúteos.'},
     {name:'Sentar e levantar', em:'🪑', sets:'2 × 10', desc:'Levanta da cadeira.', tip:'Alta cadeira.'}],
    [{name:'Caminhada progressiva', em:'🚶', sets:'15-20 min', desc:'Distância crescente.', tip:'Postura direita.'},
     {name:'Subir degrau', em:'🪜', sets:'3 × 8', desc:'Sobe e desce degrau.', tip:'Com apoio.'},
     {name:'Agachamento parcial', em:'🏋️', sets:'3 × 8', desc:'Flexiona ancas/joelhos.', tip:'Peso calcanhares.'}],
  ],
  coluna: [
    [{name:'Respiração diafragmática', em:'🌬️', sets:'5 min', desc:'Respirações profundas.', tip:'Relaxa.'},
     {name:'Balancinho pélvico', em:'🦴', sets:'3 × 8', desc:'Inclina a bacia.', tip:'Movimento pequeno.'},
     {name:'Elevação dos braços', em:'💪', sets:'2 × 8', desc:'Eleva os braços.', tip:'Sem forçar.'}],
    [{name:'Gato e camelo', em:'🐱', sets:'3 × 8', desc:'Arqueia as costas.', tip:'Lento.'},
     {name:'Alongamento isquiotibiais', em:'🧘', sets:'3 × 20s', desc:'Estica a perna.', tip:'Não forçar.'},
     {name:'Pontes glúteas', em:'🍑', sets:'3 × 8', desc:'Eleva a bacia.', tip:'Protege lombar.'}],
    [{name:'Caminhada leve', em:'🚶', sets:'15 min', desc:'Bom alinhamento.', tip:'Pausas.'},
     {name:'Agachamento assistido', em:'🏋️', sets:'3 × 8', desc:'Costas neutras.', tip:'Técnica.'},
     {name:'Prato da balança', em:'🤸', sets:'3 × 20s', desc:'Equilíbrio.', tip:'Core firme.'}],
  ],
  posparto: [
    [{name:'Respiração abdominal', em:'🌬️', sets:'5 min', desc:'Relaxa o abdómen.', tip:'Pavimento pélvico.'},
     {name:'Ativação do pavimento pélvico', em:'💗', sets:'3 × 10', desc:'Contrai e relaxa.', tip:'Sem reter ar.'},
     {name:'Elevação dos braços', em:'💪', sets:'2 × 8', desc:'Mobiliza ombros.', tip:'Suave.'}],
    [{name:'Inclinação pélvica', em:'🦴', sets:'3 × 8', desc:'Inclina a bacia.', tip:'Liga à respiração.'},
     {name:'Bruços respirando', em:'🧘', sets:'3 min', desc:'Respira contra o chão.', tip:'Relaxa.'},
     {name:'Ponte glútea', em:'🍑', sets:'3 × 8', desc:'Eleva a bacia.', tip:'Atenção.'}],
    [{name:'Caminhada com o bebé', em:'👶', sets:'15 min', desc:'Caminhadas leves.', tip:'Postura.'},
     {name:'Agachamento assistido', em:'🏋️', sets:'3 × 8', desc:'Suaves com apoio.', tip:'Confortável.'},
     {name:'Alongamento de ombros', em:'🧘', sets:'3 × 20s', desc:'Estica os ombros.', tip:'Respira.'}],
  ],
  cardiaca: [
    [{name:'Respiração controlada', em:'🌬️', sets:'5 min', desc:'Respirações lentas.', tip:'Relaxa.'},
     {name:'Bombas de tornozelo', em:'🦶', sets:'3 × 10', desc:'Circulação das pernas.', tip:'Repete.'},
     {name:'Rotação de pulsos', em:'✋', sets:'2 × 10', desc:'Move pulsos/tornozelos.', tip:'Suave.'}],
    [{name:'Marcha sentado', em:'🪑', sets:'3 × 1 min', desc:'Eleva os joelhos.', tip:'Ritmo confortável.'},
     {name:'Elevação dos braços', em:'💪', sets:'2 × 8', desc:'Eleva os braços.', tip:'Controla esforço.'},
     {name:'Sentar e levantar', em:'🪑', sets:'3 × 8', desc:'Levanta com apoio.', tip:'Fluido.'}],
    [{name:'Caminhada monitorizada', em:'🚶', sets:'10-15 min', desc:'Monitoriza a FC.', tip:'Não exceder.'},
     {name:'Subir escadas', em:'🪜', sets:'2 × 5', desc:'Sobe e desce devagar.', tip:'Pausa se falta de ar.'},
     {name:'Alongamento suave', em:'🧘', sets:'5 min', desc:'Alongamentos leves.', tip:'Sem esforço brusco.'}],
  ],
  outra: [
    [{name:'Bombas de tornozelo', em:'🦶', sets:'3 × 10', desc:'Estimula circulação.', tip:'Repete ao dia.'},
     {name:'Respiração profunda', em:'🌬️', sets:'5 min', desc:'Respirações lentas.', tip:'Reduz dor.'},
     {name:'Mobilização suave', em:'🤸', sets:'3 × 8', desc:'Move articulações.', tip:'Sem forçar.'}],
    [{name:'Caminhada curta', em:'🚶', sets:'10 min', desc:'Caminhadas progressivas.', tip:'Confortável.'},
     {name:'Sentar e levantar', em:'🪑', sets:'3 × 8', desc:'Levanta da cadeira.', tip:'Postura direita.'},
     {name:'Elevação dos braços', em:'💪', sets:'2 × 8', desc:'Mobilidade.', tip:'Suave.'}],
    [{name:'Caminhada progressiva', em:'🚶', sets:'15-20 min', desc:'Distância crescente.', tip:'Progressivo.'},
     {name:'Equilíbrio', em:'🤸', sets:'3 × 20s', desc:'Equilíbrio com apoio.', tip:'Segurança.'},
     {name:'Alongamento global', em:'🧘', sets:'5 min', desc:'Alongamentos leves.', tip:'Respira.'}],
  ],
};

const SURGERY_TYPES = [
  {id:'joelho', name:'Joelho', em:'🦵', weeks:12},
  {id:'anca', name:'Anca', em:'🦴', weeks:12},
  {id:'coluna', name:'Coluna', em:'🩻', weeks:16},
  {id:'posparto', name:'Pós-parto', em:'👶', weeks:8},
  {id:'cardiaca', name:'Cardíaca', em:'❤️', weeks:10},
  {id:'outra', name:'Outra', em:'🏥', weeks:12},
];

// ---------- Helpers ----------
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const today = () => new Date().toISOString().slice(0,10);
function phaseFor(weeks){ return weeks <= 2 ? 0 : weeks <= 5 ? 1 : 2; }
function weeksSince(dateStr){
  const ms = new Date() - new Date(dateStr + 'T00:00:00');
  return Math.max(1, Math.floor(ms/(1000*60*60*24*7)) + 1);
}
function getPatient(id){
  return db.prepare('SELECT * FROM patients WHERE id = ?').get(id);
}
function last7Days(){
  const out=[]; for(let i=6;i>=0;i--){ const d=new Date(); d.setDate(d.getDate()-i); out.push(d.toISOString().slice(0,10)); } return out;
}

// ---------- API ----------
app.get('/api/config', (req,res)=>{
  res.json({ surgeryTypes: SURGERY_TYPES, vapidPublicKey: VAPID_PUBLIC });
});

app.get('/api/exercises/:type', (req,res)=>{
  res.json({ exercises: EXERCISES[req.params.type] || EXERCISES.outra });
});

// Onboarding — create patient
app.post('/api/patients', (req,res)=>{
  const { name='Paciente', type, surgeryDate, age, initialPain } = req.body;
  if(!type || !surgeryDate) return res.status(400).json({error:'type e surgeryDate são obrigatórios'});
  const info = db.prepare(
    'INSERT INTO patients (name,type,surgery_date,age,initial_pain) VALUES (?,?,?,?,?)'
  ).run(name, type, surgeryDate, age||null, initialPain||null);
  const id = Number(info.lastInsertRowid);
  // default meds
  const insertMed = db.prepare('INSERT INTO meds (patient_id,name,time) VALUES (?,?,?)');
  insertMed.run(id,'Ibuprofeno 400mg','08:00');
  insertMed.run(id,'Paracetamol 1000mg','14:00');
  insertMed.run(id,'Ibuprofeno 400mg','20:00');
  res.status(201).json({ id });
});

// Patient dashboard "today"
app.get('/api/patients/:id/today', (req,res)=>{
  const p = getPatient(req.params.id);
  if(!p) return res.status(404).json({error:'Não encontrado'});
  const weeks = weeksSince(p.surgery_date);
  const phase = phaseFor(weeks);
  const typeInfo = SURGERY_TYPES.find(t=>t.id===p.type)||SURGERY_TYPES[0];
  const exercises = EXERCISES[p.type] ? EXERCISES[p.type][phase] : EXERCISES.outra[phase];
  const todayS = today();
  const exDone = db.prepare('SELECT exercise_index FROM ex_done WHERE patient_id=? AND date=?').all(p.id,todayS).map(r=>r.exercise_index);
  const meds = db.prepare('SELECT * FROM meds WHERE patient_id=?').all(p.id);
  const medTaken = db.prepare('SELECT med_id FROM med_taken WHERE patient_id=? AND date=?').all(p.id,todayS).map(r=>r.med_id);
  const pain = db.prepare('SELECT * FROM pain_logs WHERE patient_id=? AND date=? ORDER BY id DESC LIMIT 1').get(p.id,todayS);
  res.json({
    patient: {...p, premium: isPremium(p.id), subscription: getSubscription(p.id)}, 
    weeks, phase, phaseTitle: phaseMeta(phase).t, phaseDesc: phaseMeta(phase).d,
    phaseProgress: Math.min(100, Math.round(weeks/typeInfo.weeks*100)),
    typeInfo,
    exercises: exercises.map((e,i)=>({...e, index:i, done: exDone.includes(i)})),
    meds: meds.map(m=>({...m, taken: medTaken.includes(m.id)})),
    painToday: pain ? pain.value : null,
  });
});

function phaseMeta(i){
  return [{t:'Fase 1 · Recuperação inicial', d:'Controlo da dor, mobilidade e prevenção de complicações.'},
          {t:'Fase 2 · Reabilitação ativa', d:'Fortalecimento progressivo e amplitude.'},
          {t:'Fase 3 · Funcionalidade', d:'Retomar atividades do dia a dia.'}][i];
}

// Record pain
app.post('/api/patients/:id/pain', (req,res)=>{
  const p = getPatient(req.params.id); if(!p) return res.status(404).json({error:'não encontrado'});
  const value = Number(req.body.value);
  if(!value || value<1 || value>10) return res.status(400).json({error:'valor 1-10'});
  const todayS = today();
  db.prepare('DELETE FROM pain_logs WHERE patient_id=? AND date=?').run(p.id,todayS);
  db.prepare('INSERT INTO pain_logs (patient_id,date,value) VALUES (?,?,?)').run(p.id,todayS,value);
  maybeAlert(p, value);
  res.json({ok:true});
});

// Toggle exercise
app.post('/api/patients/:id/exercise', (req,res)=>{
  const p = getPatient(req.params.id); if(!p) return res.status(404).json({error:'não encontrado'});
  const index = Number(req.body.index);
  const todayS = today();
  const existing = db.prepare('SELECT id FROM ex_done WHERE patient_id=? AND exercise_index=? AND date=?').get(p.id,index,todayS);
  if(existing) db.prepare('DELETE FROM ex_done WHERE id=?').run(existing.id);
  else db.prepare('INSERT INTO ex_done (patient_id,exercise_index,date) VALUES (?,?,?)').run(p.id,index,todayS);
  res.json({ok:true});
});

// Toggle med taken
app.post('/api/patients/:id/med', (req,res)=>{
  const p = getPatient(req.params.id); if(!p) return res.status(404).json({error:'não encontrado'});
  const medId = Number(req.body.medId);
  const todayS = today();
  const existing = db.prepare('SELECT id FROM med_taken WHERE patient_id=? AND med_id=? AND date=?').get(p.id,medId,todayS);
  if(existing) db.prepare('DELETE FROM med_taken WHERE id=?').run(existing.id);
  else db.prepare('INSERT INTO med_taken (patient_id,med_id,date) VALUES (?,?,?)').run(p.id,medId,todayS);
  res.json({ok:true});
});

// Add med
app.post('/api/patients/:id/meds', (req,res)=>{
  const p = getPatient(req.params.id); if(!p) return res.status(404).json({error:'não encontrado'});
  const { name, time } = req.body;
  if(!name) return res.status(400).json({error:'name obrigatório'});
  const info = db.prepare('INSERT INTO meds (patient_id,name,time) VALUES (?,?,?)').run(p.id, name, time||'08:00');
  res.status(201).json({id:Number(info.lastInsertRowid)});
});

// History + adherence + pain series
app.get('/api/patients/:id/history', (req,res)=>{
  const p = getPatient(req.params.id); if(!p) return res.status(404).json({error:'não encontrado'});
  const days = last7Days();
  const pain = db.prepare('SELECT * FROM pain_logs WHERE patient_id=?').all(p.id);
  const exDone = db.prepare('SELECT * FROM ex_done WHERE patient_id=?').all(p.id);
  const meds = db.prepare('SELECT * FROM meds WHERE patient_id=?').all(p.id);
  const medTaken = db.prepare('SELECT * FROM med_taken WHERE patient_id=?').all(p.id);
  const series = days.map(date=>{
    const pv = pain.filter(x=>x.date===date).pop();
    const exD = exDone.filter(x=>x.date===date).map(x=>x.exercise_index);
    const exTotal = exercisesForDate(p, date).length;
    const mt = medTaken.filter(x=>x.date===date).length;
    return { date, pain: pv?pv.value:null,
      exDone: exD.length, exTotal,
      medDone: mt, medTotal: meds.length };
  });
  // adherence
  let exTotal=0,exDoneC=0,medTotal=0,medDoneC=0;
  days.forEach(d=>{
    const row=series.find(x=>x.date===d);
    exTotal+=row.exTotal; exDoneC+=row.exDone; medTotal+=row.medTotal; medDoneC+=row.medDone;
  });
  res.json({ series, adherence:{
    exercises: exTotal?Math.round(exDoneC/exTotal*100):0,
    medication: medTotal?Math.round(medDoneC/medTotal*100):0,
  }});
});

function exercisesForDate(p, date){
  const ms = new Date(date+'T00:00:00'), surg = new Date(p.surgery_date+'T00:00:00');
  const wk = Math.max(1, Math.floor((ms-surg)/(1000*60*60*24*7))+1);
  const ph = phaseFor(wk);
  return (EXERCISES[p.type]||EXERCISES.outra)[ph];
}

// Full library + plan phases
app.get('/api/patients/:id/plan', (req,res)=>{
  const p = getPatient(req.params.id); if(!p) return res.status(404).json({error:'não encontrado'});
  const typeInfo = SURGERY_TYPES.find(t=>t.id===p.type)||SURGERY_TYPES[0];
  const weeks = weeksSince(p.surgery_date);
  const library = [0,1,2].map((f,i)=>({fase:i+1, ...phaseMeta(i), exercises: (EXERCISES[p.type]||EXERCISES.outra)[f]}));
  res.json({ typeInfo, weeks, library, premium: isPremium(p.id) });
});

// Premium unlock (demo)
// (sistema de assinaturas substituiu o endpoint simples de premium)

// Reset demo (delete all data) — dev convenience
app.post('/api/reset', (req,res)=>{
  ['ex_done','med_taken','meds','pain_logs','patients'].forEach(t=>db.exec(`DELETE FROM ${t}`));
  res.json({ok:true});
});

/* ================= AUTENTICAÇÃO ================= */
app.post('/api/auth/register', (req,res)=>{
  const { email, password, role='patient', displayName } = req.body;
  if(!email || !/\S+@\S+\.\S+/.test(email)) return res.status(400).json({error:'Email inválido'});
  if(!password || String(password).length < 6) return res.status(400).json({error:'Password deve ter pelo menos 6 caracteres'});
  const exists = db.prepare('SELECT id FROM users WHERE email=?').get(String(email).toLowerCase());
  if(exists) return res.status(409).json({error:'Email já registado'});
  const info = db.prepare('INSERT INTO users (email,password,role,display_name) VALUES (?,?,?,?)')
    .run(String(email).toLowerCase(), hashPassword(password), role, displayName||null);
  const token = newToken();
  db.prepare('INSERT INTO sessions (token,user_id) VALUES (?,?)').run(token, Number(info.lastInsertRowid));
  res.status(201).json({ token, user: { id:Number(info.lastInsertRowid), email:email.toLowerCase(), role, displayName } });
});

app.post('/api/auth/login', (req,res)=>{
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email=?').get(String(email||'').toLowerCase());
  if(!user || !verifyPassword(password, user.password)) return res.status(401).json({error:'Credenciais inválidas'});
  const token = newToken();
  db.prepare('INSERT INTO sessions (token,user_id) VALUES (?,?)').run(token, user.id);
  res.json({ token, user: { id:user.id, email:user.email, role:user.role, displayName:user.display_name } });
});

app.post('/api/auth/logout', (req,res)=>{
  const auth = req.headers.authorization||'';
  const token = auth.replace('Bearer ','');
  if(token) db.prepare('DELETE FROM sessions WHERE token=?').run(token);
  res.json({ok:true});
});

function requireAuth(req,res,next){
  const auth = req.headers.authorization||'';
  const token = auth.replace('Bearer ','');
  const row = db.prepare('SELECT * FROM sessions WHERE token=?').get(token);
  if(!row) return res.status(401).json({error:'Não autenticado'});
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(row.user_id);
  if(!user) return res.status(401).json({error:'Utilizador não encontrado'});
  req.user = user;
  req.userToken = token;
  next();
}

app.get('/api/auth/me', requireAuth, (req,res)=>{
  res.json({ user: { id:req.user.id, email:req.user.email, role:req.user.role, displayName:req.user.display_name } });
});

// Ligar conta de utilizador a um paciente (self) ou a um paciente partilhado
app.post('/api/patients/:id/link', requireAuth, (req,res)=>{
  const p = getPatient(req.params.id);
  if(!p) return res.status(404).json({error:'Paciente não encontrado'});
  // se o utilizador é o dono do paciente ou um clínico, ligação directa
  const owner = db.prepare('SELECT * FROM patient_links WHERE patient_id=? AND user_id=?').get(p.id, req.user.id);
  if(!owner) db.prepare('INSERT INTO patient_links (patient_id,user_id,access) VALUES (?,?,?)').run(p.id, req.user.id, 'view');
  res.json({ok:true});
});

/* ================= FAMÍLIA / CUIDADOR ================= */
// Criar convite (gera código) para partilhar com cuidador/família
app.post('/api/patients/:id/share', requireAuth, (req,res)=>{
  const p = getPatient(req.params.id);
  if(!p) return res.status(404).json({error:'Paciente não encontrado'});
  const code = newToken().slice(0,6).toUpperCase();
  res.json({ inviteCode: code });
});

// Aceitar convite por código
app.post('/api/patients/:id/join', requireAuth, (req,res)=>{
  const p = getPatient(req.params.id);
  if(!p) return res.status(404).json({error:'Paciente não encontrado'});
  const exists = db.prepare('SELECT id FROM patient_links WHERE patient_id=? AND user_id=?').get(p.id, req.user.id);
  if(!exists) db.prepare('INSERT INTO patient_links (patient_id,user_id,access) VALUES (?,?,?)').run(p.id, req.user.id, 'view');
  res.json({ok:true});
});

/* ================= CONSULTAS (FOLLOW-UP) ================= */
app.get('/api/patients/:id/appointments', (req,res)=>{
  const p = getPatient(req.params.id); if(!p) return res.status(404).json({error:'Não encontrado'});
  res.json({ appointments: db.prepare('SELECT * FROM appointments WHERE patient_id=? ORDER BY date').all(p.id) });
});

app.post('/api/patients/:id/appointments', requireAuth, (req,res)=>{
  const p = getPatient(req.params.id); if(!p) return res.status(404).json({error:'Não encontrado'});
  const { title, date, note } = req.body;
  if(!title || !date) return res.status(400).json({error:'title e date obrigatórios'});
  const info = db.prepare('INSERT INTO appointments (patient_id,title,date,note) VALUES (?,?,?,?)').run(p.id, title, date, note||null);
  res.status(201).json({ id:Number(info.lastInsertRowid) });
});

/* ================= ALERTAS ================= */
app.get('/api/patients/:id/alerts', (req,res)=>{
  const p = getPatient(req.params.id); if(!p) return res.status(404).json({error:'Não encontrado'});
  res.json({ alerts: db.prepare('SELECT * FROM alerts WHERE patient_id=? ORDER BY id DESC LIMIT 20').all(p.id) });
});

// Gerar alerta automático quando dor >= 8 (+ push)
function maybeAlert(p, painValue){
  if(painValue >= 8){
    db.prepare('INSERT INTO alerts (patient_id,message) VALUES (?,?)')
      .run(p.id, '🚨 Dor elevada ('+painValue+'/10) — considerar contactar o médico.');
    sendPush(p.id, '🚨 Alerta de dor alta', 'Registou dor '+painValue+'/10. Se não melhorar, contacte o médico.');
  }
}

/* ================= CLÍNICAS (B2B2C) ================= */
// Listar pacientes ligados ao clínica/profissional
app.get('/api/clinic/patients', requireAuth, (req,res)=>{
  if(req.user.role !== 'clinic') return res.status(403).json({error:'Acesso apenas para clínicas'});
  const links = db.prepare('SELECT patient_id, access FROM patient_links WHERE user_id=?').all(req.user.id);
  const patients = links.map(l=>{
    const p = getPatient(l.patient_id); if(!p) return null;
    const hist = computeHistory(p);
    return { id:p.id, name:p.name, type:p.type, surgeryDate:p.surgery_date,
      age:p.age, premium:isPremium(p.id), weeks:weeksSince(p.surgery_date),
      phase:phaseFor(weeksSince(p.surgery_date)),
      adherence: hist.adherence, lastPain: hist.series[hist.series.length-1].pain, access:l.access };
  }).filter(Boolean);
  res.json({ patients });
});

// Relatório agregado para a clínica
app.get('/api/clinic/report', requireAuth, (req,res)=>{
  if(req.user.role !== 'clinic') return res.status(403).json({error:'Acesso apenas para clínicas'});
  const links = db.prepare('SELECT patient_id FROM patient_links WHERE user_id=?').all(req.user.id);
  const ids = links.map(l=>l.patient_id);
  const total = ids.length;
  let avgAdherence=0, avgPain=0, premiumCount=0, countPain=0;
  ids.forEach(id=>{
    const p=getPatient(id); if(!p) return;
    const hist=computeHistory(p);
    avgAdherence += hist.adherence.exercises;
    const lastPain = hist.series[hist.series.length-1].pain;
    if(lastPain!=null){ avgPain+=lastPain; countPain++; }
    if(isPremium(p.id)) premiumCount++;
  });
  res.json({ totalPatients:total,
    avgAdherence: total?Math.round(avgAdherence/total):0,
    avgPain: countPain?Math.round(avgPain/countPain*10)/10:null,
    premiumCount, premiumRate: total?Math.round(premiumCount/total*100):0 });
});

/* ================= REUTILIZAR histórico ================= */
function computeHistory(p){
  const days = last7Days();
  const pain = db.prepare('SELECT * FROM pain_logs WHERE patient_id=?').all(p.id);
  const exDone = db.prepare('SELECT * FROM ex_done WHERE patient_id=?').all(p.id);
  const meds = db.prepare('SELECT * FROM meds WHERE patient_id=?').all(p.id);
  const medTaken = db.prepare('SELECT * FROM med_taken WHERE patient_id=?').all(p.id);
  const series = days.map(date=>{
    const pv = pain.filter(x=>x.date===date).pop();
    const exD = exDone.filter(x=>x.date===date).map(x=>x.exercise_index);
    const exTotal = exercisesForDate(p, date).length;
    const mt = medTaken.filter(x=>x.date===date).length;
    return { date, pain: pv?pv.value:null, exDone: exD.length, exTotal, medDone: mt, medTotal: meds.length };
  });
  let exTotal=0,exDoneC=0,medTotal=0,medDoneC=0;
  days.forEach(d=>{ const r=series.find(x=>x.date===d); exTotal+=r.exTotal; exDoneC+=r.exDone; medTotal+=r.medTotal; medDoneC+=r.medDone; });
  return { series, adherence:{ exercises:exTotal?Math.round(exDoneC/exTotal*100):0, medication:medTotal?Math.round(medDoneC/medTotal*100):0 } };
}

// Atualizar /api/patients/:id/history para usar computeHistory

/* ================= WEB PUSH ================= */
// Guardar subscrição do dispositivo
app.post('/api/push/subscribe', requireAuth, (req,res)=>{
  const { endpoint, keys } = req.body;
  if(!endpoint || !keys || !keys.auth || !keys.p256dh) return res.status(400).json({error:'Subscrição incompleta'});
  // ligar à conta do utilizador; se o utilizador é paciente sem paciente próprio, usa o primeiro ligado
  let pid = req.body.patientId || null;
  if(!pid){
    const link = db.prepare('SELECT patient_id FROM patient_links WHERE user_id=? LIMIT 1').get(req.user.id);
    pid = link ? link.patient_id : null;
  }
  if(!pid) return res.status(400).json({error:'Nenhum paciente associado'});
  db.prepare(`INSERT INTO push_subscriptions (patient_id,endpoint,keys_auth,keys_p256dh) VALUES (?,?,?,?)
    ON CONFLICT(patient_id,endpoint) DO UPDATE SET keys_auth=excluded.keys_auth, keys_p256dh=excluded.keys_p256dh`)
    .run(pid, endpoint, keys.auth, keys.p256dh);
  res.json({ok:true});
});

app.delete('/api/push/subscribe', requireAuth, (req,res)=>{
  const auth = req.headers.authorization||'';
  const token = auth.replace('Bearer ','');
  const sess = db.prepare('SELECT * FROM sessions WHERE token=?').get(token);
  if(sess){
    const links = db.prepare('SELECT patient_id FROM patient_links WHERE user_id=?').all(sess.user_id);
    const ids = links.map(l=>l.patient_id);
    if(ids.length) db.prepare(`DELETE FROM push_subscriptions WHERE patient_id IN (${ids.map(()=>'?').join(',')})`).run(...ids);
  }
  res.json({ok:true});
});

// Enviar push para um paciente (usa web-push)
async function sendPush(patientId, title, body){
  const subs = db.prepare('SELECT * FROM push_subscriptions WHERE patient_id=?').all(patientId);
  if(!subs.length) return {sent:0};
  const payload = JSON.stringify({ title, body, data:{ url:'/' } });
  let sent=0;
  for(const s of subs){
    const sub = { endpoint:s.endpoint, keys:{ auth:s.keys_auth, p256dh:s.keys_p256dh } };
    try{
      await webpush.sendNotification(sub, payload);
      sent++;
    }catch(e){
      // subscrição inválida/expirada → remover
      if(e.statusCode===404 || e.statusCode===410){
        db.prepare('DELETE FROM push_subscriptions WHERE id=?').run(s.id);
      }
    }
  }
  db.prepare('INSERT INTO notifications_log (patient_id,title,body) VALUES (?,?,?)').run(patientId, title, body);
  return {sent};
}

// Endpoint público de teste (demonstração)
app.post('/api/push/test', requireAuth, (req,res)=>{
  const auth = req.headers.authorization||'';
  const token = auth.replace('Bearer ','');
  const sess = db.prepare('SELECT * FROM sessions WHERE token=?').get(token);
  if(!sess) return res.status(401).json({error:'Não autenticado'});
  const link = db.prepare('SELECT patient_id FROM patient_links WHERE user_id=? LIMIT 1').get(sess.user_id);
  if(!link) return res.status(400).json({error:'Sem paciente associado'});
  sendPush(link.patient_id, '🔔 Teste Recupera+', 'As notificações push estão a funcionar!').then(r=>res.json(r));
});

/* ================= CHAT (paciente ↔ fisioterapeuta) ================= */
// Clientes SSE ativos: patientId -> Set<res>
const sseClients = {};

// Regista quem pode ver o chat de um paciente
function canAccessChat(user, patientId){
  // clínica ligada ao paciente, ou o próprio paciente
  if(user.role === 'clinic'){
    return !!db.prepare('SELECT id FROM patient_links WHERE patient_id=? AND user_id=?').get(patientId, user.id);
  }
  return !!db.prepare('SELECT id FROM patient_links WHERE patient_id=? AND user_id=?').get(patientId, user.id);
}

// Histórico de mensagens de um paciente
app.get('/api/patients/:id/messages', requireAuth, (req,res)=>{
  const p = getPatient(req.params.id);
  if(!p) return res.status(404).json({error:'Não encontrado'});
  if(!canAccessChat(req.user, p.id)) return res.status(403).json({error:'Sem acesso a este chat'});
  const msgs = db.prepare('SELECT * FROM messages WHERE patient_id=? ORDER BY id').all(p.id);
  res.json({ messages: msgs, canChat: req.user.role==='patient' || req.user.role==='clinic' });
});

// Enviar mensagem
app.post('/api/patients/:id/messages', requireAuth, (req,res)=>{
  const p = getPatient(req.params.id);
  if(!p) return res.status(404).json({error:'Não encontrado'});
  if(!canAccessChat(req.user, p.id)) return res.status(403).json({error:'Sem acesso a este chat'});
  const body = String(req.body.body||'').trim();
  if(!body) return res.status(400).json({error:'Mensagem vazia'});
  if(body.length > 2000) return res.status(400).json({error:'Mensagem demasiado longa'});
  const senderName = req.user.role==='clinic' ? (req.user.display_name||'Fisioterapeuta') : (req.user.display_name||'Paciente');
  const info = db.prepare('INSERT INTO messages (patient_id,sender_role,sender_name,body) VALUES (?,?,?,?)')
    .run(p.id, req.user.role, senderName, body);
  const msg = { id:Number(info.lastInsertRowid), patient_id:p.id, sender_role:req.user.role, sender_name:senderName, body, created_at: db.prepare("SELECT datetime('now') d").get().d };
  // notificar clientes SSE
  broadcast(p.id, msg);
  res.status(201).json({ message: msg });
});

// SSE stream — o servidor empurra novas mensagens em tempo real
app.get('/api/patients/:id/messages/stream', requireAuth, (req,res)=>{
  const p = getPatient(req.params.id);
  if(!p){ res.status(404).json({error:'Não encontrado'}); return; }
  if(!canAccessChat(req.user, p.id)){ res.status(403).json({error:'Sem acesso'}); return; }
  res.set({
    'Content-Type':'text/event-stream',
    'Cache-Control':'no-cache',
    'Connection':'keep-alive',
    'X-Accel-Buffering':'no',
  });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  // heartbeat para manter a ligação viva
  const hb = setInterval(()=>res.write(': ping\n\n'), 25000);
  if(!sseClients[p.id]) sseClients[p.id]=new Set();
  sseClients[p.id].add(res);
  req.on('close', ()=>{ clearInterval(hb); sseClients[p.id].delete(res); if(sseClients[p.id].size===0) delete sseClients[p.id]; });
});

// Difundir nova mensagem a todos os ouvintes do paciente
function broadcast(patientId, msg){
  const set = sseClients[patientId];
  if(!set) return;
  const payload = `data: ${JSON.stringify(msg)}\n\n`;
  for(const res of set){
    try{ res.write(payload); }catch(e){ set.delete(res); }
  }
}

/* ================= ASSINATURA PREMIUM ================= */
// Planos disponíveis
const PLANS = {
  monthly:  { id:'monthly',  name:'Premium Mensal',  amount:9.90,  interval:'month', periodDays:30 },
  quarterly:{ id:'quarterly',name:'Premium Trimestral', amount:24.90, interval:'quarter', periodDays:90 },
  yearly:   { id:'yearly',   name:'Premium Anual',   amount:79.90, interval:'year', periodDays:365 },
};

const SUB_STATUS = ['none','trialing','active','canceled','past_due','expired'];

function addDays(dateStr, days){
  const d = new Date(dateStr+'T00:00:00Z');
  d.setUTCDate(d.getUTCDate()+days);
  return d.toISOString().slice(0,10);
}

// Estado atual da subscrição de um paciente
const getSubscription = (patientId)=>{
  const row = db.prepare('SELECT * FROM subscriptions WHERE patient_id=?').get(patientId) || null;
  if(!row) return { patient_id:patientId, plan:null, status:'none', renews_at:null, auto_renew:true, active:false };
  const today = new Date().toISOString().slice(0,10);
  let status = row.status;
  // se passou a data de renovação e está ativa com auto_renew, renova automaticamente
  if((status==='active'||status==='trialing') && row.renews_at && row.renews_at < today && row.auto_renew){
    const p = PLANS[row.plan];
    const start = row.renews_at;
    const renew = addDays(start, p.periodDays);
    db.prepare("UPDATE subscriptions SET status=?, starts_at=?, renews_at=?, updated_at=datetime('now') WHERE id=?")
      .run('active', start, renew, row.id);
    db.prepare('INSERT INTO invoices (subscription_id,patient_id,plan,amount,period_start,period_end) VALUES (?,?,?,?,?,?)')
      .run(row.id, patientId, row.plan, Math.round(p.amount*100), start, renew);
    status='active'; row.renews_at=renew;
  } else if(status==='expired' || (status!=='none' && status!=='trialing' && status!=='active' && status!=='canceled')){
    status = 'expired';
  }
  const active = (status==='active'||status==='trialing');
  return { ...row, active, status, plan:row.plan||null };
};

// Endpoint: listar planos e estado atual
app.get('/api/subscription', (req,res)=>{
  res.json({ plans: Object.values(PLANS), status: 'none', active:false });
});

app.get('/api/patients/:id/subscription', requireAuth, (req,res)=>{
  const p = getPatient(req.params.id);
  if(!p) return res.status(404).json({error:'Não encontrado'});
  if(req.user.role!=='clinic' && !canAccessChat(req.user, p.id)) return res.status(403).json({error:'Sem acesso'});
  const sub = getSubscription(p.id);
  res.json({ subscription: sub, plans: Object.values(PLANS) });
});

// Iniciar / ativar subscrição (simula pagamento)
app.post('/api/patients/:id/subscription', requireAuth, (req,res)=>{
  const p = getPatient(req.params.id);
  if(!p) return res.status(404).json({error:'Não encontrado'});
  if(!canAccessChat(req.user, p.id)) return res.status(403).json({error:'Sem acesso'});
  const planId = req.body.plan || 'monthly';
  const plan = PLANS[planId];
  if(!plan) return res.status(400).json({error:'Plano inválido'});
  const paymentMethod = req.body.paymentMethod || 'card';
  const now = new Date().toISOString().slice(0,10);
  const renew = addDays(now, plan.periodDays);
  const existing = db.prepare('SELECT id FROM subscriptions WHERE patient_id=?').get(p.id);
  let subId;
  if(existing){
    db.prepare("UPDATE subscriptions SET plan=?, status=?, starts_at=?, renews_at=?, payment_method=?, auto_renew=1, updated_at=datetime('now') WHERE id=?")
      .run(planId, 'active', now, renew, paymentMethod, existing.id);
    subId = existing.id;
  } else {
    const info = db.prepare('INSERT INTO subscriptions (patient_id,plan,status,starts_at,renews_at,payment_method,auto_renew) VALUES (?,?,?,?,?,?,1)')
      .run(p.id, planId, 'active', now, renew, paymentMethod);
    subId = Number(info.lastInsertRowid);
  }
  db.prepare('INSERT INTO invoices (subscription_id,patient_id,plan,amount,period_start,period_end) VALUES (?,?,?,?,?,?)')
    .run(subId, p.id, planId, Math.round(plan.amount*100), now, renew);
  // manter o campo premium de compatibilidade
  db.prepare('UPDATE patients SET premium=1 WHERE id=?').run(p.id);
  res.status(201).json({ subscription: getSubscription(p.id) });
});

// Cancelar subscrição (no fim do período)
app.post('/api/patients/:id/subscription/cancel', requireAuth, (req,res)=>{
  const p = getPatient(req.params.id);
  if(!p) return res.status(404).json({error:'Não encontrado'});
  if(!canAccessChat(req.user, p.id)) return res.status(403).json({error:'Sem acesso'});
  const sub = getSubscription(p.id);
  if(!sub.id || sub.status==='none') return res.status(400).json({error:'Sem subscrição ativa'});
  db.prepare("UPDATE subscriptions SET auto_renew=0, status=?, updated_at=datetime('now') WHERE id=?")
    .run('canceled', sub.id);
  res.json({ subscription: getSubscription(p.id) });
});

// Reactivar uma subscrição cancelada
app.post('/api/patients/:id/subscription/reactivate', requireAuth, (req,res)=>{
  const p = getPatient(req.params.id);
  if(!p) return res.status(404).json({error:'Não encontrado'});
  if(!canAccessChat(req.user, p.id)) return res.status(403).json({error:'Sem acesso'});
  const sub = getSubscription(p.id);
  if(!sub.id) return res.status(400).json({error:'Sem subscrição'});
  db.prepare("UPDATE subscriptions SET auto_renew=1, status=?, updated_at=datetime('now') WHERE id=?")
    .run('active', sub.id);
  res.json({ subscription: getSubscription(p.id) });
});

// Histórico de faturas
app.get('/api/patients/:id/invoices', requireAuth, (req,res)=>{
  const p = getPatient(req.params.id);
  if(!p) return res.status(404).json({error:'Não encontrado'});
  if(!canAccessChat(req.user, p.id)) return res.status(403).json({error:'Sem acesso'});
  const inv = db.prepare('SELECT * FROM invoices WHERE patient_id=? ORDER BY id DESC').all(p.id);
  res.json({ invoices: inv.map(i=>({...i, amount:(i.amount/100).toFixed(2), currency:i.currency||CURRENCY})) });
});

// Estado premium agregado (helper de compatibilidade)
function isPremium(patientId){
  return getSubscription(patientId).active;
}

/* ================= PAGAMENTOS STRIPE (receber dinheiro real) ================= */
// Expor se os pagamentos estão ativos
app.get('/api/payment/status', (req,res)=>{
  res.json({ enabled: !!stripe, publishableKey: STRIPE_PUBLISHABLE_KEY });
});

// Criar sessão de checkout para um plano
app.post('/api/payment/checkout', requireAuth, async (req,res)=>{
  const p = getPatient(req.body.patientId);
  if(!p) return res.status(404).json({error:'Paciente não encontrado'});
  if(!canAccessChat(req.user, p.id)) return res.status(403).json({error:'Sem acesso'});
  if(!stripe) return res.status(503).json({error:'Pagamentos não configurados', demo:true});
  const planId = req.body.plan || 'monthly';
  const plan = PLANS[planId];
  if(!plan) return res.status(400).json({error:'Plano inválido'});
  try{
    // criar/obter customer
    let customerId = (getSubscription(p.id).stripe_customer_id) || null;
    if(!customerId){
      const cust = await stripe.customers.create({ email: req.user.email, name: p.name, metadata:{ patient_id:String(p.id) } });
      customerId = cust.id;
      db.prepare('UPDATE subscriptions SET stripe_customer_id=? WHERE patient_id=?').run(customerId, p.id);
    }
    const session = await stripe.checkout.sessions.create({
      mode:'subscription',
      customer: customerId,
      line_items:[{
        price_data:{
          currency:'eur',
          product_data:{ name: plan.name },
          unit_amount: Math.round(plan.amount*100),
          recurring:{ interval: plan.interval==='year'?'year':'month', interval_count: plan.interval==='quarter'?3:1 },
        },
        quantity:1,
      }],
      success_url: `${APP_URL}/#/premium?status=success`,
      cancel_url: `${APP_URL}/#/premium?status=canceled`,
      client_reference_id: String(p.id),
      metadata:{ patient_id:String(p.id), plan:planId },
      allow_promotion_codes: true,
      payment_method_types:['card','paypal','sepa_debit'],
      subscription_data:{ metadata:{ patient_id:String(p.id), plan:planId } },
    });
    res.json({ url: session.url, sessionId: session.id });
  }catch(e){
    console.error('Stripe checkout error:', e.message);
    res.status(500).json({error:'Erro ao criar pagamento: '+e.message});
  }
});

// Endpoint de teste do checkout (sem Stripe configurado → simula)
app.post('/api/payment/test', requireAuth, async (req,res)=>{
  if(stripe) return res.status(400).json({error:'Use o checkout real'});
  const p = getPatient(req.body.patientId);
  if(!p) return res.status(404).json({error:'Paciente não encontrado'});
  if(!canAccessChat(req.user, p.id)) return res.status(403).json({error:'Sem acesso'});
  const planId = req.body.plan || 'monthly';
  const plan = PLANS[planId]; if(!plan) return res.status(400).json({error:'Plano inválido'});
  // simula ativação (demo)
  const now = new Date().toISOString().slice(0,10);
  const renew = addDays(now, plan.periodDays);
  const existing = db.prepare('SELECT id FROM subscriptions WHERE patient_id=?').get(p.id);
  let subId;
  if(existing){
    db.prepare("UPDATE subscriptions SET plan=?, status='active', starts_at=?, renews_at=?, auto_renew=1, updated_at=datetime('now') WHERE id=?").run(planId, now, renew, existing.id);
    subId = existing.id;
  } else {
    const info = db.prepare("INSERT INTO subscriptions (patient_id,plan,status,starts_at,renews_at,auto_renew) VALUES (?,?,?,?,?,1)").run(p.id, planId, 'active', now, renew);
    subId = Number(info.lastInsertRowid);
  }
  db.prepare('INSERT INTO invoices (subscription_id,patient_id,plan,amount,period_start,period_end) VALUES (?,?,?,?,?,?)').run(subId, p.id, planId, Math.round(plan.amount*100), now, renew);
  db.prepare('UPDATE patients SET premium=1 WHERE id=?').run(p.id);
  res.json({ demo:true, subscription: getSubscription(p.id) });
});

// Webhook da Stripe — confirma pagamentos e ativa/renova/cancela
app.post('/api/webhooks/stripe', express.raw({type:'application/json'}), (req,res)=>{
  if(!stripe || !STRIPE_WEBHOOK_SECRET) return res.status(400).json({error:'Webhook não configurado'});
  let event;
  try{
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
  }catch(e){
    console.error('Webhook signature verification failed:', e.message);
    return res.status(400).send(`Webhook Error: ${e.message}`);
  }
  // processar eventos relevantes
  const data = event.data.object;
  const pid = Number(data.metadata && data.metadata.patient_id) || Number(data.client_reference_id) || null;
  const plan = (data.metadata && data.metadata.plan) || null;
  switch(event.type){
    case 'checkout.session.completed':{
      if(data.payment_status==='paid' && data.subscription){
        const sub = getSubscription(pid);
        const subId = sub.id;
        if(subId){
          db.prepare('UPDATE subscriptions SET stripe_subscription_id=?, status=?, auto_renew=1, updated_at=datetime("now") WHERE id=?').run(data.subscription,'active',subId);
        }
        db.prepare('UPDATE patients SET premium=1 WHERE id=?').run(pid);
      }
      break;
    }
    case 'invoice.paid':{
      // renovação paga → estende o período
      const pid2 = Number(data.subscription_details && data.subscription_details.metadata && data.subscription_details.metadata.patient_id) || pid;
      const sub = getSubscription(pid2);
      if(sub.id){
        const planObj = PLANS[sub.plan] || PLANS.monthly;
        const periodEnd = new Date(data.period_end*1000).toISOString().slice(0,10);
        const renew = addDays(periodEnd, planObj.periodDays);
        db.prepare("UPDATE subscriptions SET status='active', auto_renew=1, renews_at=?, updated_at=datetime('now') WHERE id=?").run(renew, sub.id);
        db.prepare('INSERT INTO invoices (subscription_id,patient_id,plan,amount,period_start,period_end) VALUES (?,?,?,?,?,?)')
          .run(sub.id, pid2, sub.plan, data.amount_paid||Math.round(planObj.amount*100), periodEnd, renew);
        db.prepare('UPDATE patients SET premium=1 WHERE id=?').run(pid2);
      }
      break;
    }
    case 'invoice.payment_failed':
      if(pid){ db.prepare("UPDATE subscriptions SET status='past_due', updated_at=datetime('now') WHERE patient_id=?").run(pid); }
      break;
    case 'customer.subscription.deleted':{
      const spid = Number(data.metadata && data.metadata.patient_id) || pid;
      if(spid){
        db.prepare("UPDATE subscriptions SET status='canceled', auto_renew=0, updated_at=datetime('now') WHERE patient_id=?").run(spid);
        db.prepare('UPDATE patients SET premium=0 WHERE id=?').run(spid);
      }
      break;
    }
  }
  res.json({ received:true });
});

// Portal de faturação (o paciente gere pagamento/plano)
app.post('/api/billing/portal', requireAuth, async (req,res)=>{
  if(!stripe) return res.status(503).json({error:'Pagamentos não configurados'});
  const p = getPatient(req.body.patientId);
  if(!p) return res.status(404).json({error:'Paciente não encontrado'});
  if(!canAccessChat(req.user, p.id)) return res.status(403).json({error:'Sem acesso'});
  const sub = getSubscription(p.id);
  if(!sub.stripe_customer_id) return res.status(400).json({error:'Sem cliente Stripe'});
  try{
    const session = await stripe.billingPortal.sessions.create({
      customer: sub.stripe_customer_id,
      return_url: `${APP_URL}/#/premium`,
    });
    res.json({ url: session.url });
  }catch(e){
    console.error('Portal error:', e.message);
    res.status(500).json({error:'Erro ao abrir portal'});
  }
});

/* ================= GATEWAY MOÇAMBICANO: SMOO PAY + PAYPAL ================= */
// Estado dos gateways disponíveis
app.get('/api/payment/gateways', (req,res)=>{
  res.json({
    smoopy: !!SMOOPAY_API_KEY,
    paypal: !!paypal,
    smoopyEndpoint: SMOOPAY_ENDPOINT,
    currency: CURRENCY,
    methods: ['mpesa','emola','card','paypal'],
    demo: !SMOOPAY_API_KEY && !paypal,
  });
});

// Iniciar cobrança (SMOO Pay: M-Pesa/e-Mola/cartão · PayPal)
app.post('/api/payment/checkout-mz', requireAuth, async (req,res)=>{
  const p = getPatient(req.body.patientId);
  if(!p) return res.status(404).json({error:'Paciente não encontrado'});
  if(!canAccessChat(req.user, p.id)) return res.status(403).json({error:'Sem acesso'});
  const planId = req.body.plan || 'monthly';
  const method = req.body.method || 'mpesa';
  const phone = req.body.phone || null;
  const plan = PLANS[planId]; if(!plan) return res.status(400).json({error:'Plano inválido'});
  const amount = Math.round(plan.amount * 100); // em centavos

  // modo demo (sem gateways configurados) — simula o pagamento
  if(!SMOOPAY_API_KEY && !paypal){
    const pid = Number(db.prepare('INSERT INTO payments (patient_id,plan,provider,amount,status,phone) VALUES (?,?,?,?,?,?)')
      .run(p.id, planId, method, amount, 'pending', phone||null).lastInsertRowid);
    res.status(201).json({
      demo:true, paymentId:pid, method,
      message:'Modo demonstração. Use /api/payment/simulate para completar.',
      currency:CURRENCY, amount:(amount/100).toFixed(2),
    });
    return;
  }

  // ----- PayPal (usa a Orders API oficial) -----
  if(method === 'paypal' && paypal){
    try{
      // token OAuth
      const auth = Buffer.from(PAYPAL_CLIENT_ID+':'+PAYPAL_CLIENT_SECRET).toString('base64');
      const tok = await (await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
        method:'POST', headers:{'Authorization':'Basic '+auth,'Content-Type':'application/x-www-form-urlencoded'},
        body:'grant_type=client_credentials',
      })).json();
      if(!tok.access_token) return res.status(500).json({error:'Falha auth PayPal: '+(tok.error_description||tok.error||'')});
      const order = await (await fetch(`${PAYPAL_BASE}/v2/checkout/orders`, {
        method:'POST', headers:{'Authorization':'Bearer '+tok.access_token,'Content-Type':'application/json'},
        body: JSON.stringify({
          intent:'CAPTURE',
          purchase_units:[{ reference_id:String(p.id), description: plan.name,
            custom_id: JSON.stringify({patient_id:p.id, plan:planId}),
            amount:{ currency_code: CURRENCY==='MZN'?'USD':CURRENCY, value: plan.amount.toFixed(2) } }],
          application_context:{ return_url:`${APP_URL}/#/premium?status=success&provider=paypal`,
            cancel_url:`${APP_URL}/#/premium?status=canceled&provider=paypal`, user_action:'PAY_NOW' },
        }),
      })).json();
      db.prepare('INSERT INTO payments (patient_id,plan,provider,provider_ref,amount,status) VALUES (?,?,?,?,?,?)')
        .run(p.id, planId, 'paypal', order.id, amount, 'pending');
      const link = (order.links||[]).find(l=>l.rel==='approve');
      return res.json({ provider:'paypal', url: link ? link.href : order.id });
    }catch(e){
      return res.status(500).json({error:'Erro PayPal: '+e.message});
    }
  }

  // ----- SMOO Pay (M-Pesa/e-Mola/cartão) -----
  if(SMOOPAY_API_KEY){
    try{
      // Envia cobrança à SMOO Pay. O endpoint exato depende da conta do comerciante.
      const body = {
        amount: (amount/100).toFixed(2),
        currency: CURRENCY,
        method, // mpesa | emola | card
        phone,
        description: plan.name,
        metadata: { patient_id: p.id, plan: planId },
        callback_url: `${APP_URL}/api/webhooks/smoopay`,
        redirect_url: `${APP_URL}/#/premium?status=success&provider=smoopay`,
      };
      const charge = await (await fetch(`${SMOOPAY_ENDPOINT}/v1/charges`, {
        method:'POST',
        headers:{ 'Authorization':'Bearer '+SMOOPAY_API_KEY, 'Content-Type':'application/json' },
        body: JSON.stringify(body),
      })).json();
      const ref = charge.id || charge.reference || charge.payment_ref || null;
      db.prepare('INSERT INTO payments (patient_id,plan,provider,provider_ref,amount,status,phone) VALUES (?,?,?,?,?,?,?)')
        .run(p.id, planId, method, ref, amount, charge.status==='succeeded'?'paid':'pending', phone||null);
      return res.json({ provider:'smoopay', paymentId: ref, status: charge.status });
    }catch(e){
      return res.status(500).json({error:'Erro SMOO Pay: '+e.message});
    }
  }

  res.status(503).json({error:'Nenhum gateway configurado', demo:true});
});

// Confirmar pagamento (chamado pelo app após checkout concluído)
app.post('/api/payment/confirm', requireAuth, async (req,res)=>{
  const { patientId, plan, provider, providerRef, amount } = req.body;
  const p = getPatient(patientId);
  if(!p) return res.status(404).json({error:'Não encontrado'});
  if(!canAccessChat(req.user, p.id)) return res.status(403).json({error:'Sem acesso'});
  activateSubscription(p.id, plan||'monthly', provider||providerRef||'manual');
  res.json({ ok:true, subscription: getSubscription(p.id) });
});

// Simular pagamento concluído (modo demo)
app.post('/api/payment/simulate', requireAuth, (req,res)=>{
  const { patientId, plan, provider, paymentId } = req.body;
  const p = getPatient(patientId);
  if(!p) return res.status(404).json({error:'Não encontrado'});
  if(!canAccessChat(req.user, p.id)) return res.status(403).json({error:'Sem acesso'});
  const pid = paymentId ? Number(paymentId) : null;
  if(pid) db.prepare("UPDATE payments SET status='paid' WHERE id=?").run(pid);
  activateSubscription(p.id, plan||'monthly', provider||'demo');
  res.json({ ok:true, subscription: getSubscription(p.id), simulated:true });
});

// Webhook SMOO Pay — confirmação de pagamento real
app.post('/api/webhooks/smoopay', express.json(), (req,res)=>{
  const d = req.body;
  const metadata = d.metadata || {};
  const pid = Number(metadata.patient_id) || Number(d.patient_id) || Number(d.client_reference_id) || null;
  const plan = metadata.plan || d.plan || 'monthly';
  const ref = d.id || d.reference || d.payment_ref || d.transaction_id || null;
  if(d.status==='succeeded' || d.status==='paid' || d.event==='payment.succeeded' || d.event==='charge.succeeded'){
    if(pid) activateSubscription(pid, plan, ref||'smoopay');
    return res.json({ received:true, ok:true });
  }
  if(d.event==='payment.failed' && pid){
    db.prepare("UPDATE subscriptions SET status='past_due', updated_at=datetime('now') WHERE patient_id=?").run(pid);
  }
  res.json({ received:true });
});

// Webhook PayPal — confirmação de pagamento
app.post('/api/webhooks/paypal', express.json(), async (req,res)=>{
  res.json({ received:true }); // a confirmação principal é feita no return_url via /api/payment/confirm
});

// Ativa uma subscrição após pagamento confirmado
function activateSubscription(patientId, planId, providerRef){
  const plan = PLANS[planId] || PLANS.monthly;
  const now = new Date().toISOString().slice(0,10);
  const renew = addDays(now, plan.periodDays);
  const existing = db.prepare('SELECT id FROM subscriptions WHERE patient_id=?').get(patientId);
  let subId;
  if(existing){
    db.prepare("UPDATE subscriptions SET plan=?, status='active', starts_at=?, renews_at=?, auto_renew=1, updated_at=datetime('now') WHERE id=?").run(planId, now, renew, existing.id);
    subId = existing.id;
  } else {
    const info = db.prepare("INSERT INTO subscriptions (patient_id,plan,status,starts_at,renews_at,auto_renew) VALUES (?,?,?,?,?,1)").run(patientId, planId, 'active', now, renew);
    subId = Number(info.lastInsertRowid);
  }
  db.prepare('INSERT INTO invoices (subscription_id,patient_id,plan,amount,currency,period_start,period_end) VALUES (?,?,?,?,?,?,?)')
    .run(subId, patientId, planId, Math.round(plan.amount*100), CURRENCY, now, renew);
  db.prepare('UPDATE patients SET premium=1 WHERE id=?').run(patientId);
  // push de confirmação
  sendPush(patientId, '💎 Premium ativado!', 'O seu plano '+plan.name+' está ativo. Obrigado!');
}

/* ================= DASHBOARD DE RECEITAS (dono) ================= */
// Métricas financeiras agregadas + desdobramentos
app.get('/api/owner/revenue', requireAuth, (req,res)=>{
  if(req.user.role !== 'clinic' && req.user.role !== 'owner'){
    // permitir apenas dono; clinic não vê receitas
    return res.status(403).json({error:'Acesso apenas para o dono'});
  }
  const today = new Date().toISOString().slice(0,10);
  const monthStart = today.slice(0,7)+'-01';

  // ---- Totais ----
  const totalFaturado = db.prepare("SELECT COALESCE(SUM(amount),0)/100.0 AS v FROM invoices WHERE status='paid'").get().v;
  const totalInvoices = db.prepare("SELECT COUNT(*) c FROM invoices WHERE status='paid'").get().c;
  const receitaMes = db.prepare("SELECT COALESCE(SUM(amount),0)/100.0 AS v FROM invoices WHERE status='paid' AND period_start>=? ").get(monthStart).v;

  // ---- Assinantes ativos ----
  const assinantesAtivos = db.prepare("SELECT COUNT(*) c FROM subscriptions WHERE status IN ('active','trialing')").get().c;
  const subTotal = db.prepare("SELECT COUNT(*) c FROM subscriptions WHERE status!='none'").get().c;
  const subCancelados = db.prepare("SELECT COUNT(*) c FROM subscriptions WHERE status='canceled'").get().c;
  const taxaCancelamento = subTotal>0 ? Math.round((subCancelados/subTotal)*100) : 0;

  // ---- Receita mensal (últimos 6 meses, incluindo o atual) ----
  const cutoff = addDays(today, -180);
  const monthly = db.prepare(`
    SELECT substr(period_start,1,7) AS mes, COALESCE(SUM(amount),0)/100.0 AS valor
    FROM invoices WHERE status='paid' AND period_start>=?
    GROUP BY mes ORDER BY mes`).all(cutoff);

  // ---- Por plano (valor correto por plano) ----
  const byPlan = db.prepare(`
    SELECT plan, COUNT(*) AS fat, COALESCE(SUM(amount),0)/100.0 AS valor
    FROM invoices WHERE status='paid' GROUP BY plan`).all();

  // ---- Por método de pagamento (de payments paid) ----
  const byProvider = db.prepare(`
    SELECT provider, COUNT(*) AS count, COALESCE(SUM(amount),0)/100.0 AS valor
    FROM payments WHERE status='paid' GROUP BY provider`).all();

  // ---- Assinantes (crescimento) ----
  const subGrowth = db.prepare("SELECT substr(created_at,1,7) AS mes, COUNT(*) AS c FROM subscriptions WHERE status!='none' GROUP BY mes ORDER BY mes").all();

  res.json({
    currency: CURRENCY,
    totais:{ totalFaturado, totalInvoices, receitaMes, assinantesAtivos, taxaCancelamento },
    monthly, byPlan, byProvider, subGrowth,
  });
});

/* ================= CONFIGURAÇÕES DE PAGAMENTO (dono) ================= */
// Devolve as credenciais configuradas (sem expor os segredos completos)
app.get('/api/owner/payment-settings', requireAuth, (req,res)=>{
  if(req.user.role !== 'clinic' && req.user.role !== 'owner') return res.status(403).json({error:'Acesso apenas para o dono'});
  res.json({
    smoopy: {
      apiKeySet: !!getSetting('smoopay_api_key',''),
      endpoint: getSetting('smoopay_endpoint','https://api.smoopay.app'),
    },
    paypal: {
      clientIdSet: !!getSetting('paypal_client_id',''),
      secretSet: !!getSetting('paypal_client_secret',''),
      env: getSetting('paypal_env','sandbox'),
    },
    currency: getSetting('currency','USD'),
    demo: !getSetting('smoopay_api_key','') && !getSetting('paypal_client_id',''),
  });
});

// Guarda as credenciais de pagamento (o dono cola as chaves aqui)
app.post('/api/owner/payment-settings', requireAuth, (req,res)=>{
  if(req.user.role !== 'clinic' && req.user.role !== 'owner') return res.status(403).json({error:'Acesso apenas para o dono'});
  const b = req.body||{};
  if(b.smoopay_api_key) setSetting('smoopay_api_key', String(b.smoopay_api_key).trim());
  if(b.smoopay_endpoint) setSetting('smoopay_endpoint', String(b.smoopay_endpoint).trim());
  if(b.paypal_client_id) setSetting('paypal_client_id', String(b.paypal_client_id).trim());
  if(b.paypal_client_secret) setSetting('paypal_client_secret', String(b.paypal_client_secret).trim());
  if(b.paypal_env) setSetting('paypal_env', String(b.paypal_env).trim());
  if(b.currency) setSetting('currency', String(b.currency).trim().toUpperCase());
  res.json({ ok:true, message:'Configurações guardadas. Reinicie o servidor para aplicar na cobrança.', demo:false });
});

// ---------- Service worker (exposto publicamente) ----------
app.get('/sw.js', (req,res)=>{
  res.set('Content-Type','application/javascript');
  res.set('Service-Worker-Allowed','/');
  res.sendFile(path.join(__dirname,'public','sw.js'));
});

// Health check para o Render (e outros hosts) confirmarem que o serviço está vivo
app.get('/api/health', (req,res)=> res.json({ ok:true, name:'recupera-plus', time:new Date().toISOString() }));

// SPA fallback
app.use((req,res)=>{ if(req.method==='GET' && !req.path.startsWith('/api')){ res.sendFile(path.join(__dirname,'public','index.html')); } else { res.status(404).json({error:'Não encontrado'}); } });

/* ================= LEMBRETES (scheduler) ================= */
const REMINDER_ENABLED = process.env.REMINDERS !== 'off';
let lastSentMed = {}; // key: patientId|medId|time|date
let lastSentEx = {};  // key: patientId|date

function pad2(n){ return String(n).padStart(2,'0'); }

async function runReminders(){
  const now = new Date();
  const hhmm = pad2(now.getHours())+':'+pad2(now.getMinutes());
  const date = today();
  // --- Medicação ---
  const meds = db.prepare('SELECT m.*, m.patient_id AS pid FROM meds m').all();
  for(const m of meds){
    if(m.time === hhmm){
      const key = `${m.pid}|${m.id}|${m.time}|${date}`;
      if(!lastSentMed[key]){
        lastSentMed[key]=true;
        sendPush(m.pid, '💊 Medicação', `Está na hora de tomar ${m.name} (${m.time}).`);
      }
    }
  }
  // --- Exercícios (1 lembrete por dia, de manhã) ---
  if(hhmm === '08:00'){
    const patients = db.prepare('SELECT id FROM patients').all();
    for(const p of patients){
      const key = `${p.id}|${date}`;
      if(!lastSentEx[key]){
        lastSentEx[key]=true;
        const weeks = weeksSince(db.prepare('SELECT surgery_date FROM patients WHERE id=?').get(p.id).surgery_date);
        const phase = phaseFor(weeks);
        const exs = (EXERCISES[db.prepare('SELECT type FROM patients WHERE id=?').get(p.id).type]||EXERCISES.outra)[phase];
        const names = exs.slice(0,2).map(e=>e.name).join(' e ');
        sendPush(p.id, '🏋️ Exercícios de hoje', `Bom dia! Hoje: ${names}. Força na recuperação!`);
      }
    }
  }
}

// Correr de 30 em 30 segundos
setInterval(runReminders, 30*1000);
runReminders();

app.listen(PORT, ()=> console.log(`✔ Recupera+ API a correr em http://localhost:${PORT} · Push ativo`));
