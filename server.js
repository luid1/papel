'use strict';

/**
 * server.js — Entry point do Lumin SaaS
 *
 * Responsabilidades:
 *  1. Iniciar servidor Express com rotas Admin
 *  2. Iniciar BotManager (um bot por empresa ativa)
 *  3. Expor endpoint /api/login para autenticação do frontend
 *  4. Servir o painel (index.html) em produção
 */

require('dotenv').config();

const express    = require('express');
const cors       = require('cors');
const path       = require('path');

const adminRouter = require('./admin/router');
const BotManager  = require('./bot/manager');
const { getCompanyByCredentials, getCompanyById } = require('./admin/companies');

const PORT = parseInt(process.env.PORT || '3000');
const app  = express();

// ─── Middlewares ──────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Rotas Admin (painel master) ──────────────────────────────────────────────
app.use('/admin', adminRouter);

// ─── Login de empresa (tenant) ────────────────────────────────────────────────
// POST /api/login
// Body: { login, password }
// Retorna: { ok, companyId, name, themeColor }
app.post('/api/login', async (req, res) => {
  try {
    const { login, password } = req.body;
    if (!login || !password) {
      return res.status(400).json({ ok: false, error: 'login e password são obrigatórios' });
    }

    // Verifica se é o admin master
    const ADMIN_USER = process.env.ADMIN_USER || 'luidoliver';
    const ADMIN_PASS = process.env.ADMIN_PASS || 'luid@';
    if (login === ADMIN_USER && password === ADMIN_PASS) {
      return res.json({
        ok:         true,
        role:       'admin',
        companyId:  null,
        name:       'Administrador Master',
        themeColor: '#00d4ff',
      });
    }

    // Verifica empresa no Firestore
    const company = await getCompanyByCredentials(login, password);
    if (!company) {
      return res.status(401).json({ ok: false, error: 'Credenciais inválidas' });
    }

    res.json({
      ok:             true,
      role:           'company',
      companyId:      company.companyId || company.id,
      name:           company.name,
      themeColor:     company.themeColor || '#00d4ff',
      primeiroAcesso: company.primeiroAcesso ?? false,  // sinaliza se deve forçar troca de senha
    });
  } catch (err) {
    console.error('[Login]', err.message);
    res.status(500).json({ ok: false, error: 'Erro interno' });
  }
});

// ─── Dados da empresa (para injetar themeColor no frontend) ──────────────────
// GET /api/company/:id
app.get('/api/company/:id', async (req, res) => {
  try {
    const company = await getCompanyById(req.params.id);
    if (!company) return res.status(404).json({ ok: false, error: 'Empresa não encontrada' });
    // Expõe apenas campos públicos — sem senha
    const { password: _p, ...safe } = company;
    res.json({ ok: true, company: safe });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Reiniciar bot via API (após criar/editar empresa) ───────────────────────
// POST /api/bot/:companyId/restart
app.post('/api/bot/:companyId/restart', async (req, res) => {
  try {
    const manager = app.get('botManager');
    if (!manager) return res.status(503).json({ ok: false, error: 'BotManager não iniciado' });
    await manager.restartBot(req.params.companyId);
    res.json({ ok: true, message: 'Bot reiniciado' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Iniciar bot para nova empresa ───────────────────────────────────────────
// POST /api/bot/:companyId/start
app.post('/api/bot/:companyId/start', async (req, res) => {
  try {
    const manager = app.get('botManager');
    const company = await getCompanyById(req.params.companyId);
    if (!company) return res.status(404).json({ ok: false, error: 'Empresa não encontrada' });
    await manager.startBot(company);
    res.json({ ok: true, message: 'Bot iniciado' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Servir frontend estático ─────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Boot ──────────────────────────────────────────────────────────────────────
async function main() {
  // 1. Inicia servidor HTTP
  app.listen(PORT, () => {
    console.log(`\n🚀 Servidor rodando em http://localhost:${PORT}`);
    console.log(`   Admin API: http://localhost:${PORT}/admin/companies`);
    console.log(`   Login API: http://localhost:${PORT}/api/login\n`);
  });

  // 2. Inicia todos os bots
  const manager = new BotManager();
  app.set('botManager', manager);
  await manager.startAll();
}

main().catch((err) => {
  console.error('❌ Erro fatal:', err);
  process.exit(1);
});
