'use strict';

/**
 * admin/router.js
 * Rotas do painel Master Admin.
 * Acesso protegido por Basic Auth via ADMIN_USER / ADMIN_PASS do .env
 *
 * Endpoints:
 *   POST   /admin/companies           → criar empresa
 *   GET    /admin/companies           → listar empresas
 *   GET    /admin/companies/:id       → buscar empresa
 *   PUT    /admin/companies/:id       → atualizar empresa
 *   DELETE /admin/companies/:id       → desativar empresa
 *   GET    /admin/companies/:id/financeiro → extrato multi-tenant
 *   GET    /admin/status              → status dos bots
 */

require('dotenv').config();
const express  = require('express');
const router   = express.Router();
const {
  createCompany,
  listCompanies,
  getCompanyById,
  updateCompany,
  deactivateCompany,
} = require('./companies');
const { db } = require('../config/firebase');

// ─── Middleware de autenticação Master ────────────────────────────────────────
function masterAuth(req, res, next) {
  const ADMIN_USER = process.env.ADMIN_USER || 'luidoliver';
  const ADMIN_PASS = process.env.ADMIN_PASS || 'luid@';

  const auth = req.headers['authorization'] || '';
  const [type, encoded] = auth.split(' ');

  if (type === 'Basic' && encoded) {
    const [user, pass] = Buffer.from(encoded, 'base64').toString().split(':');
    if (user === ADMIN_USER && pass === ADMIN_PASS) return next();
  }

  // Também aceita via query string (para uso no painel HTML)
  if (req.query._user === ADMIN_USER && req.query._pass === ADMIN_PASS) return next();
  // Aceita via body JSON
  if (req.body?._user === ADMIN_USER && req.body?._pass === ADMIN_PASS) return next();

  res.status(401).json({ error: 'Não autorizado' });
}

// ─── Aplicar auth em todas as rotas /admin ────────────────────────────────────
router.use(masterAuth);

// POST /admin/companies
router.post('/companies', async (req, res) => {
  try {
    const { name, login, password, botPhone, themeColor } = req.body;
    const result = await createCompany({ name, login, password, botPhone, themeColor });
    res.status(201).json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// GET /admin/companies
router.get('/companies', async (req, res) => {
  try {
    const list = await listCompanies();
    // Nunca expõe a senha no GET
    const safe = list.map(({ password: _p, ...rest }) => rest);
    res.json({ ok: true, companies: safe });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /admin/companies/:id
router.get('/companies/:id', async (req, res) => {
  try {
    const company = await getCompanyById(req.params.id);
    if (!company) return res.status(404).json({ ok: false, error: 'Empresa não encontrada' });
    const { password: _p, ...safe } = company;
    res.json({ ok: true, company: safe });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// PUT /admin/companies/:id
router.put('/companies/:id', async (req, res) => {
  try {
    const updated = await updateCompany(req.params.id, req.body);
    const { password: _p, ...safe } = updated;
    res.json({ ok: true, company: safe });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// DELETE /admin/companies/:id (soft-delete)
router.delete('/companies/:id', async (req, res) => {
  try {
    await deactivateCompany(req.params.id);
    res.json({ ok: true, message: 'Empresa desativada' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /admin/companies/:id/financeiro — extrato do tenant
router.get('/companies/:id/financeiro', async (req, res) => {
  try {
    const company = await getCompanyById(req.params.id);
    if (!company) return res.status(404).json({ ok: false, error: 'Empresa não encontrada' });

    const { mes, ano } = req.query;
    const now  = new Date();
    const year  = parseInt(ano  || now.getFullYear());
    const month = parseInt(mes  || now.getMonth() + 1) - 1; // 0-based

    const inicio = new Date(year, month, 1).getTime();
    const fim    = new Date(year, month + 1, 0, 23, 59, 59, 999).getTime();

    const snap = await db
      .collection('companies')
      .doc(req.params.id)
      .collection('financeiro')
      .where('createdAt', '>=', inicio)
      .where('createdAt', '<=', fim)
      .orderBy('createdAt', 'desc')
      .get();

    const lancamentos = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    res.json({ ok: true, company: company.name, lancamentos });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /admin/status — status de todos os bots
router.get('/status', (req, res) => {
  // botManager é injetado pelo server.js
  const manager = req.app.get('botManager');
  if (!manager) return res.json({ ok: true, bots: [] });
  res.json({ ok: true, bots: manager.getStatus() });
});

module.exports = router;
