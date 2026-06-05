// Vercel Serverless Function — analisa lista de nomes de clientes com IA
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { nomes } = req.body || {};
  if (!Array.isArray(nomes) || !nomes.length) return res.status(400).json({ error: 'Lista de nomes obrigatória' });

  // Remove qualquer caractere não-ASCII do início/fim (BOM, espaços invisíveis, etc.)
  // eslint-disable-next-line no-control-regex
  const apiKey = (process.env.GROQ_API_KEY || '').replace(/[^\x20-\x7E]/g, '').trim();
  if (!apiKey) return res.status(500).json({ error: 'GROQ_API_KEY não configurada' });

  const prompt = `Você receberá uma lista de nomes de clientes de uma empresa de logística/distribuição de caixas.
Sua tarefa: identificar grupos de nomes que provavelmente são o MESMO estabelecimento mas escritos de formas diferentes (erros de digitação, abreviações, variações).

REGRAS:
- Agrupe apenas quando tiver alta confiança de que é o mesmo local
- Inclua apenas grupos com 2 ou mais nomes
- Para cada grupo, sugira o nome canônico (o mais correto/completo)
- Ignore grupos onde os nomes são claramente diferentes

Lista de nomes:
${nomes.map((n, i) => `${i + 1}. ${n}`).join('\n')}

Responda APENAS com JSON válido no formato:
{
  "grupos": [
    {
      "canonico": "NOME CORRETO",
      "variantes": ["VARIANTE 1", "VARIANTE 2"],
      "motivo": "explicação curta em português"
    }
  ]
}`;

  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: 2048,
        response_format: { type: 'json_object' }
      })
    });

    if (!groqRes.ok) {
      const err = await groqRes.text();
      console.error('[Groq]', err);
      return res.status(502).json({ error: 'Erro na API de IA', detail: err });
    }

    const data = await groqRes.json();
    const content = data.choices?.[0]?.message?.content || '{}';
    const parsed = JSON.parse(content);
    return res.status(200).json(parsed);

  } catch (err) {
    console.error('[analisar-nomes]', err);
    return res.status(500).json({ error: err.message });
  }
}
