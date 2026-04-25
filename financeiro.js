'use strict';

/**
 * bot/financeiro.js
 * Persistência de lançamentos financeiros — arquitetura Multi-tenant.
 *
 * Estrutura no Firestore:
 *   /companies/{companyId}/financeiro/{docId}
 *
 * A Empresa A nunca acessa dados da Empresa B — cada lançamento
 * é gravado na sub-coleção da própria empresa identificada pelo
 * número do bot (client.info.wid.user).
 */

const { db } = require('../config/firebase');

const CATEGORY_MAP = {
  'entrada':    'entrada',
  'saida-fixa': 'saida-fixa',
  'variavel':   'variavel',
  'funcionario':'funcionario',
  'fixo':       'saida-fixa',
};

// ─── Salvar lançamento na sub-coleção da empresa ──────────────────────────────
async function salvarLancamento(companyId, dados, userId) {
  if (!companyId) throw new Error('companyId é obrigatório para gravar lançamento');

  const agora = Date.now();
  const hoje  = new Date().toISOString().split('T')[0];

  const documento = {
    amount:       dados.amount,
    category:     CATEGORY_MAP[dados.category] ?? dados.category,
    tipo:         dados.tipo,
    createdAt:    agora,
    createdBy:    userId,
    date:         hoje,
    dateEnd:      dados.dateEnd ?? null,
    description:  dados.description,
    isRecorrente: dados.isRecorrente ?? false,
    updatedAt:    agora,
    updatedBy:    userId,
    userId:       userId,
    companyId:    companyId,  // redundância útil para auditoria
  };

  // Grava em /companies/{companyId}/financeiro
  const colRef  = db.collection('companies').doc(companyId).collection('financeiro');
  const docRef  = await colRef.add(documento);

  console.log(`[Financeiro] ${companyId} | ${dados.tipo} | ${dados.category} | R$${dados.amount} | ID:${docRef.id}`);
  return { id: docRef.id };
}

// ─── Calcular total do mês (isolado por empresa) ──────────────────────────────
async function calcularTotalMes(companyId) {
  const agora    = new Date();
  const inicioMs = new Date(agora.getFullYear(), agora.getMonth(), 1).getTime();
  const fimMs    = new Date(agora.getFullYear(), agora.getMonth() + 1, 0, 23, 59, 59, 999).getTime();

  const snap = await db
    .collection('companies')
    .doc(companyId)
    .collection('financeiro')
    .where('createdAt', '>=', inicioMs)
    .where('createdAt', '<=', fimMs)
    .get();

  let totalEntrada = 0;
  let totalSaida   = 0;

  snap.forEach((doc) => {
    const d = doc.data();
    if (d.category === 'entrada') {
      totalEntrada += d.amount ?? 0;
    } else {
      totalSaida += d.amount ?? 0;
    }
  });

  return { totalEntrada, totalSaida };
}

// ─── Helpers de formatação ────────────────────────────────────────────────────
function formatarMoeda(valor) {
  return Number(valor).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatarData(data) {
  return data.toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

module.exports = { salvarLancamento, calcularTotalMes, formatarMoeda, formatarData };
