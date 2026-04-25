'use strict';

/**
 * bot/ai.js
 * Análise de mensagens financeiras via Groq (Llama).
 */

const { groq } = require('../config/groq');

const SYSTEM_PROMPT = `Você é um assistente financeiro pessoal. Analise a mensagem e classifique o lançamento financeiro.

Responda APENAS com JSON válido, sem markdown, sem texto extra:
{
  "valido": true ou false,
  "tipo": "transacao" ou "obrigacao",
  "category": "entrada" ou "saida-fixa" ou "variavel" ou "funcionario",
  "amount": número decimal (ex: 50.00),
  "description": "texto curto descrevendo o lançamento",
  "isRecorrente": true ou false,
  "dateEnd": "YYYY-MM-DD" ou null
}

Regras de classificação:
- "obrigacao": pagamentos fixos e recorrentes como aluguel, salário, mensalidade, financiamento, assinatura fixa.
- "transacao" category "entrada": receitas, vendas, recebimentos, ganhos.
- "transacao" category "saida-fixa": despesas fixas pontuais (conta de luz, água, internet).
- "transacao" category "variavel": despesas variáveis do dia a dia (almoço, gasolina, compra avulsa).
- "transacao" category "funcionario": pagamento de funcionário ou colaborador.
- isRecorrente: true apenas se a obrigação ou despesa se repete todo mês.
- dateEnd: data final da obrigação se mencionada, senão null.
- Se não houver valor monetário claro, retorne: {"valido": false}

Exemplos:
- "gastei 50 reais no almoço" → {"valido":true,"tipo":"transacao","category":"variavel","amount":50.00,"description":"almoço","isRecorrente":false,"dateEnd":null}
- "paguei 1500 de aluguel" → {"valido":true,"tipo":"obrigacao","category":"saida-fixa","amount":1500.00,"description":"aluguel","isRecorrente":true,"dateEnd":null}
- "salário do João 2000 reais" → {"valido":true,"tipo":"transacao","category":"funcionario","amount":2000.00,"description":"salário João","isRecorrente":true,"dateEnd":null}
- "recebi 3000 de venda" → {"valido":true,"tipo":"transacao","category":"entrada","amount":3000.00,"description":"venda","isRecorrente":false,"dateEnd":null}`;

const PALAVRAS_FINANCEIRAS = [
  'gastei','gasto','paguei','pago','comprei','compra',
  'r$','reais','valor','custo','custou','despesa','conta',
  'recebi','entrada','ganho','salário','salario','venda',
  'aluguel','funcionário','funcionario','obrigação','obrigacao',
  'mensalidade','adicionei','lancei','registrei','transferi',
  'cobrei','cobrado','fatura','boleto','pix','débito','credito',
  'financiamento','prestação','prestacao','parcela','seguro',
  'imposto','taxa','tarifa','energia','água','agua','internet',
  'telefone','combustível','combustivel','gasolina','uber',
  'ifood','mercado','supermercado','farmácia','farmacia',
  'lucro','faturamento','receita','custeio','investimento',
];

function pareceTransacao(texto) {
  const lower = texto.toLowerCase();
  return PALAVRAS_FINANCEIRAS.some((kw) => lower.includes(kw));
}

async function analisarMensagem(textoMensagem) {
  const response = await groq.chat.completions.create({
    model: 'llama-3.1-8b-instant',
    max_tokens: 300,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user',   content: textoMensagem },
    ],
  });
  const raw = response.choices[0]?.message?.content ?? '{}';
  return JSON.parse(raw);
}

module.exports = { analisarMensagem, pareceTransacao };
