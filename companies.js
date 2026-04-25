'use strict';

/**
 * admin/companies.js
 * Gerenciamento de empresas (tenants) no Firestore.
 * Coleção: /companies/{companyId}
 *
 * Schema do documento:
 * {
 *   companyId:   string  (= ID do doc)
 *   name:        string  (nome da empresa)
 *   login:       string  (usuário de acesso ao painel)
 *   password:    string  (senha — idealmente hash em produção)
 *   botPhone:    string  (número WhatsApp do bot, apenas dígitos)
 *   themeColor:  string  (cor de destaque, ex: "#00d4ff")
 *   active:      boolean
 *   createdAt:   number  (timestamp ms)
 *   updatedAt:   number
 * }
 */

const { db } = require('../config/firebase');
const COL = 'companies';

// ─── Criar empresa ────────────────────────────────────────────────────────────
async function createCompany({ name, login, password, botPhone, themeColor = '#00d4ff' }) {
  if (!name || !login || !password || !botPhone) {
    throw new Error('Campos obrigatórios: name, login, password, botPhone');
  }

  // Garante que botPhone seja apenas dígitos
  const phone = botPhone.replace(/\D/g, '');

  // Verifica duplicidade de botPhone
  const existing = await db.collection(COL).where('botPhone', '==', phone).get();
  if (!existing.empty) {
    throw new Error(`Número ${phone} já está cadastrado em outra empresa.`);
  }

  const now = Date.now();
  const docRef = await db.collection(COL).add({
    name,
    login:          login.toLowerCase(),
    password,       // ⚠️ em produção, use bcrypt
    botPhone:       phone,
    themeColor,
    active:         true,
    foto:           '',    // sempre vazio na criação — o próprio usuário define depois
    primeiroAcesso: true,  // força troca de senha no primeiro login
    createdAt:      now,
    updatedAt:      now,
  });

  // Grava o ID no próprio documento para facilitar queries
  await docRef.update({ companyId: docRef.id });

  console.log(`[Admin] Empresa criada: "${name}" (${docRef.id}) | bot: +${phone}`);
  return { companyId: docRef.id };
}

// ─── Listar todas as empresas ─────────────────────────────────────────────────
async function listCompanies() {
  const snap = await db.collection(COL).orderBy('createdAt', 'desc').get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

// ─── Buscar empresa por ID ────────────────────────────────────────────────────
async function getCompanyById(companyId) {
  const doc = await db.collection(COL).doc(companyId).get();
  if (!doc.exists) return null;
  return { id: doc.id, ...doc.data() };
}

// ─── Buscar empresa por número do bot ────────────────────────────────────────
async function getCompanyByPhone(botPhone) {
  const phone = botPhone.replace(/\D/g, '');
  const snap = await db.collection(COL)
    .where('botPhone', '==', phone)
    .where('active', '==', true)
    .limit(1)
    .get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { id: doc.id, ...doc.data() };
}

// ─── Buscar empresa por login/senha ──────────────────────────────────────────
async function getCompanyByCredentials(login, password) {
  const snap = await db.collection(COL)
    .where('login', '==', login.toLowerCase())
    .where('password', '==', password)
    .where('active', '==', true)
    .limit(1)
    .get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { id: doc.id, ...doc.data() };
}

// ─── Atualizar empresa ────────────────────────────────────────────────────────
async function updateCompany(companyId, fields) {
  const allowed = ['name', 'login', 'password', 'botPhone', 'themeColor', 'active'];
  const update  = { updatedAt: Date.now() };
  for (const [k, v] of Object.entries(fields)) {
    if (allowed.includes(k)) {
      update[k] = k === 'botPhone' ? v.replace(/\D/g, '') : v;
    }
  }
  await db.collection(COL).doc(companyId).update(update);
  return getCompanyById(companyId);
}

// ─── Deletar empresa (soft-delete) ───────────────────────────────────────────
async function deactivateCompany(companyId) {
  await db.collection(COL).doc(companyId).update({ active: false, updatedAt: Date.now() });
}

module.exports = {
  createCompany,
  listCompanies,
  getCompanyById,
  getCompanyByPhone,
  getCompanyByCredentials,
  updateCompany,
  deactivateCompany,
};
