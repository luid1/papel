'use strict';

/**
 * bot/manager.js
 * Gerenciador de instâncias de bot — um por empresa ativa.
 *
 * Ao iniciar, busca todas as empresas ativas no Firestore e
 * cria uma instância de BotInstance para cada uma.
 * Quando uma empresa é adicionada via API, o manager pode
 * iniciar um novo bot sem reiniciar o servidor.
 */

require('dotenv').config();
const BotInstance = require('./instance');
const { listCompanies } = require('../admin/companies');

const SESSION_BASE = process.env.SESSION_BASE_PATH || './sessions';

class BotManager {
  constructor() {
    /** @type {Map<string, BotInstance>} companyId → BotInstance */
    this.instances = new Map();
  }

  // ─── Inicializa bots para todas as empresas ativas ─────────────────────────
  async startAll() {
    const companies = await listCompanies();
    const active    = companies.filter((c) => c.active);

    console.log(`\n╔══════════════════════════════════════════╗`);
    console.log(`║   🤖  Lumin SaaS — Multi-tenant Bot      ║`);
    console.log(`╚══════════════════════════════════════════╝`);
    console.log(`\n📦 Empresas ativas: ${active.length}`);

    for (const company of active) {
      await this.startBot(company);
    }

    if (active.length === 0) {
      console.log('\n⚠ Nenhuma empresa cadastrada. Use a API /admin/companies para criar.\n');
    }
  }

  // ─── Iniciar bot de uma empresa específica ─────────────────────────────────
  async startBot(company) {
    const id = company.companyId || company.id;
    if (this.instances.has(id)) {
      console.log(`[Manager] Bot ${id} já está rodando.`);
      return this.instances.get(id);
    }

    const instance = new BotInstance({
      companyId:   id,
      companyName: company.name,
      botPhone:    company.botPhone,
      sessionBase: SESSION_BASE,
    });

    this.instances.set(id, instance);
    await instance.start();
    return instance;
  }

  // ─── Parar bot de uma empresa ───────────────────────────────────────────────
  async stopBot(companyId) {
    const instance = this.instances.get(companyId);
    if (!instance) return;
    await instance.stop();
    this.instances.delete(companyId);
  }

  // ─── Reiniciar bot de uma empresa ──────────────────────────────────────────
  async restartBot(companyId) {
    await this.stopBot(companyId);
    const { getCompanyById } = require('../admin/companies');
    const company = await getCompanyById(companyId);
    if (company && company.active) {
      await this.startBot(company);
    }
  }

  // ─── Status de todos os bots ────────────────────────────────────────────────
  getStatus() {
    return Array.from(this.instances.values()).map((i) => i.toStatus());
  }
}

module.exports = BotManager;
