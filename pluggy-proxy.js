/**
 * ═══════════════════════════════════════════════════════════════
 *  pluggy-proxy.js — Backend Lumin
 *
 *  Funcionalidades:
 *  1. Pluggy Open Finance (widget bancário)
 *  2. Gmail Sync — lê emails de bancos e extrai transações com IA
 *
 *  Início rápido:
 *    node pluggy-proxy.js
 *
 *  Dependências (já instaladas):
 *    express, cors, axios, dotenv, groq-sdk
 * ═══════════════════════════════════════════════════════════════
 */

require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const axios   = require('axios');
const fs      = require('fs');
const path    = require('path');
const Groq    = require('groq-sdk');

const app  = express();
const PORT = process.env.PLUGGY_PROXY_PORT || 3001;

const PLUGGY_CLIENT_ID     = process.env.PLUGGY_CLIENT_ID;
const PLUGGY_CLIENT_SECRET = process.env.PLUGGY_CLIENT_SECRET;
const PLUGGY_BASE_URL      = 'https://api.pluggy.ai';

// ── Google / Gmail ──────────────────────────────────────────────
const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GMAIL_REDIRECT_URI   = `http://localhost:${process.env.PLUGGY_PROXY_PORT || 3001}/gmail/callback`;
// Em produção (Fly.io) usa volume persistente /data, em dev usa pasta local
const TOKENS_FILE = process.env.FLY_APP_NAME
  ? '/data/gmail-tokens.json'
  : path.join(__dirname, 'gmail-tokens.json');

// ── Groq (IA para parsear emails) ──────────────────────────────
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ── Valida credenciais no boot ──────────────────────────────────
if (!PLUGGY_CLIENT_ID || !PLUGGY_CLIENT_SECRET) {
  console.error('\n❌ PLUGGY_CLIENT_ID e PLUGGY_CLIENT_SECRET precisam estar no .env\n');
  process.exit(1);
}

app.use(cors({ origin: '*' }));
app.use(express.json());

// ── Cache do API key (válido ~100 min) ─────────────────────────
let _apiKey        = null;
let _apiKeyExpires = 0;

async function getPluggyApiKey() {
  if (_apiKey && Date.now() < _apiKeyExpires) return _apiKey;
  const res = await axios.post(`${PLUGGY_BASE_URL}/auth`, {
    clientId:     PLUGGY_CLIENT_ID,
    clientSecret: PLUGGY_CLIENT_SECRET
  });
  _apiKey        = res.data.apiKey;
  _apiKeyExpires = Date.now() + 100 * 60 * 1000; // 100 min
  console.log('[Pluggy] Novo API key obtido ✓');
  return _apiKey;
}

// ══════════════════════════════════════════════════════════════
//  ROTAS
// ══════════════════════════════════════════════════════════════

// ── Health check ───────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true, service: 'pluggy-proxy' }));

// ── GET /pluggy/connect-token?companyId=xxx&itemId=yyy ─────────
//   O frontend chama este endpoint para abrir o widget Pluggy.
//   Retorna: { connectToken: "..." }
app.get('/pluggy/connect-token', async (req, res) => {
  try {
    const apiKey = await getPluggyApiKey();
    const body   = {};

    // Se já tem itemId (reconexão / atualização de credenciais bancárias)
    if (req.query.itemId) body.itemId = req.query.itemId;

    const tokenRes = await axios.post(
      `${PLUGGY_BASE_URL}/connect_token`,
      body,
      { headers: { 'X-API-KEY': apiKey } }
    );

    console.log(`[Pluggy] connect-token gerado para companyId=${req.query.companyId || '?'}`);
    res.json({ connectToken: tokenRes.data.accessToken });

  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error('[Pluggy] connect-token ERROR:', detail);
    res.status(500).json({ error: 'Não foi possível gerar o token. Verifique as credenciais Pluggy no .env' });
  }
});

// ── POST /pluggy/save-item ─────────────────────────────────────
//   Recebe { companyId, itemId } — o frontend salva no Firestore
//   diretamente via JS SDK; aqui apenas confirmamos o recebimento.
app.post('/pluggy/save-item', (req, res) => {
  const { companyId, itemId } = req.body || {};
  console.log(`[Pluggy] save-item: company=${companyId}  item=${itemId}`);
  res.json({ ok: true });
});

// ── POST /pluggy/sync ──────────────────────────────────────────
//   Body: { itemId, dias? }
//   Retorna: { transactions: [...], period: { from, to } }
app.post('/pluggy/sync', async (req, res) => {
  try {
    const { itemId, dias = 30 } = req.body || {};
    if (!itemId) return res.status(400).json({ error: 'itemId obrigatório.' });

    const apiKey  = await getPluggyApiKey();
    const to      = new Date();
    const from    = new Date(); from.setDate(from.getDate() - Number(dias));
    const toStr   = to.toISOString().split('T')[0];
    const fromStr = from.toISOString().split('T')[0];

    // Lista contas do item
    const accountsRes = await axios.get(
      `${PLUGGY_BASE_URL}/accounts?itemId=${itemId}`,
      { headers: { 'X-API-KEY': apiKey } }
    );
    const accounts = accountsRes.data.results || [];

    let allTxs = [];
    for (const acc of accounts) {
      let page = 1, hasMore = true;
      while (hasMore) {
        const txRes = await axios.get(
          `${PLUGGY_BASE_URL}/transactions?accountId=${acc.id}&from=${fromStr}&to=${toStr}&pageSize=500&page=${page}`,
          { headers: { 'X-API-KEY': apiKey } }
        );
        const results = txRes.data.results || [];
        allTxs = allTxs.concat(results);
        hasMore = results.length === 500;
        page++;
      }
    }

    // Mapeia para o formato usado pelo frontend Lumin
    const transactions = allTxs.map(tx => ({
      id:          tx.id,
      date:        (tx.date || toStr).split('T')[0],
      description: tx.description || tx.descriptionRaw || '(sem descrição)',
      amount:      Math.abs(tx.amount),
      // Débito = saída; crédito = entrada
      type:        tx.type === 'DEBIT' || tx.amount < 0 ? 'saida-fixa' : 'entrada',
      origem:      'pluggy',
      accountId:   acc?.id,
      currencyCode: tx.currencyCode
    }));

    console.log(`[Pluggy] sync: ${transactions.length} transações (${fromStr} → ${toStr})`);
    res.json({ transactions, period: { from: fromStr, to: toStr } });

  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error('[Pluggy] sync ERROR:', detail);
    res.status(500).json({ error: String(detail) });
  }
});

// ── POST /pluggy/auto-sync ─────────────────────────────────────
//   Igual ao sync mas retorna apenas { novas, period }
app.post('/pluggy/auto-sync', async (req, res) => {
  try {
    const { itemId, dias = 30 } = req.body || {};
    if (!itemId) return res.status(400).json({ error: 'itemId obrigatório.' });

    const apiKey  = await getPluggyApiKey();
    const to      = new Date();
    const from    = new Date(); from.setDate(from.getDate() - Number(dias));
    const toStr   = to.toISOString().split('T')[0];
    const fromStr = from.toISOString().split('T')[0];

    const accountsRes = await axios.get(
      `${PLUGGY_BASE_URL}/accounts?itemId=${itemId}`,
      { headers: { 'X-API-KEY': apiKey } }
    );
    const accounts = accountsRes.data.results || [];

    let total = 0;
    for (const acc of accounts) {
      const txRes = await axios.get(
        `${PLUGGY_BASE_URL}/transactions?accountId=${acc.id}&from=${fromStr}&to=${toStr}&pageSize=500`,
        { headers: { 'X-API-KEY': apiKey } }
      );
      total += (txRes.data.results || []).length;
    }

    console.log(`[Pluggy] auto-sync: ${total} transações encontradas`);
    res.json({ novas: total, period: { from: fromStr, to: toStr } });

  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error('[Pluggy] auto-sync ERROR:', detail);
    res.status(500).json({ error: String(detail) });
  }
});

// ══════════════════════════════════════════════════════════════
//  GMAIL SYNC — lê emails de bancos e extrai transações com IA
// ══════════════════════════════════════════════════════════════

// ── Helpers de token (salvo em arquivo local) ──────────────────
function loadGmailTokens() {
  try { return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8')); }
  catch { return {}; }
}
function saveGmailTokens(data) {
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(data, null, 2));
}

// ── Garante access_token válido (refresh automático) ───────────
async function getGmailAccessToken(companyId) {
  const all = loadGmailTokens();
  const t   = all[companyId];
  if (!t?.refresh_token) throw new Error('Gmail não conectado para esta empresa.');

  if (Date.now() < (t.expiry || 0) - 60_000) return { all, t, token: t.access_token };

  // Refresh
  const r = await axios.post('https://oauth2.googleapis.com/token', {
    client_id:     GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    refresh_token: t.refresh_token,
    grant_type:    'refresh_token'
  });
  t.access_token = r.data.access_token;
  t.expiry       = Date.now() + r.data.expires_in * 1000;
  all[companyId] = t;
  saveGmailTokens(all);
  console.log('[Gmail] Token renovado para', companyId);
  return { all, t, token: t.access_token };
}

// ── GET /gmail/status?companyId=xxx ───────────────────────────
app.get('/gmail/status', (req, res) => {
  const { companyId } = req.query;
  const all = loadGmailTokens();
  const t   = all[companyId];
  res.json({ connected: !!t?.refresh_token, email: t?.email || null });
});

// ── GET /gmail/auth-url?companyId=xxx ─────────────────────────
//   Retorna a URL do Google OAuth para o frontend abrir em popup
app.get('/gmail/auth-url', (req, res) => {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return res.status(500).json({ error: 'GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET não estão no .env' });
  }
  const url =
    `https://accounts.google.com/o/oauth2/v2/auth` +
    `?client_id=${encodeURIComponent(GOOGLE_CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(GMAIL_REDIRECT_URI)}` +
    `&response_type=code` +
    `&scope=${encodeURIComponent('https://www.googleapis.com/auth/gmail.readonly')}` +
    `&access_type=offline` +
    `&prompt=consent` +
    `&state=${encodeURIComponent(req.query.companyId || '')}`;
  res.json({ url });
});

// ── GET /gmail/callback  (Google redireciona aqui) ────────────
app.get('/gmail/callback', async (req, res) => {
  const { code, state: companyId, error } = req.query;

  if (error) {
    return res.send(`<script>
      window.opener?.postMessage({type:'gmail-error',error:'${error}'},'*');
      window.close();
    </script>`);
  }

  try {
    const tokenRes = await axios.post('https://oauth2.googleapis.com/token', {
      code,
      client_id:     GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri:  GMAIL_REDIRECT_URI,
      grant_type:    'authorization_code'
    });
    const { access_token, refresh_token, expires_in } = tokenRes.data;

    // Busca email do usuário
    const profileRes = await axios.get(
      'https://gmail.googleapis.com/gmail/v1/users/me/profile',
      { headers: { Authorization: `Bearer ${access_token}` } }
    );
    const email = profileRes.data.emailAddress;

    const all = loadGmailTokens();
    all[companyId] = {
      access_token,
      refresh_token: refresh_token || all[companyId]?.refresh_token,
      expiry:        Date.now() + expires_in * 1000,
      email,
      parsedIds:     all[companyId]?.parsedIds || []
    };
    saveGmailTokens(all);
    console.log(`[Gmail] Conectado: ${email} → empresa ${companyId}`);

    res.send(`<!DOCTYPE html><html><head><title>Gmail conectado</title></head><body>
      <p style="font-family:monospace;text-align:center;margin-top:40px;">✅ Gmail conectado! Pode fechar esta janela.</p>
      <script>
        window.opener?.postMessage({type:'gmail-connected',email:'${email}'},'*');
        setTimeout(()=>window.close(), 1500);
      </script>
    </body></html>`);

  } catch (err) {
    console.error('[Gmail] callback ERROR:', err.response?.data || err.message);
    res.send(`<script>
      window.opener?.postMessage({type:'gmail-error',error:'${err.message}'},'*');
      window.close();
    </script>`);
  }
});

// ── GET /gmail/disconnect?companyId=xxx ───────────────────────
app.get('/gmail/disconnect', (req, res) => {
  const all = loadGmailTokens();
  delete all[req.query.companyId];
  saveGmailTokens(all);
  console.log('[Gmail] Desconectado:', req.query.companyId);
  res.json({ ok: true });
});

// ── POST /gmail/sync ──────────────────────────────────────────
//   Body: { companyId, dias? }
//   Retorna: { transactions: [...], novas: N }
//   As transações usam o mesmo formato do Pluggy → mesmo modal de revisão
const BANK_SENDERS = [
  // Nubank
  'noreply@nubank.com.br', 'falecom@nubank.com.br', 'comunicados@nubank.com.br',
  // Itaú
  'naoresponda@itau.com.br', 'noreply@itau.com.br', 'itau@',
  // Bradesco
  'notificacoes@bradesco.com.br', 'noreply@bradesco.com.br', 'bradesco@',
  // Santander
  'santander@santander.com.br', 'noreply@santander.com.br',
  // Banco do Brasil
  'mensagens@bancodobrasil.com.br', 'noreply@bb.com.br', 'contato@bb.com.br',
  // Caixa
  'atendimento@caixa.gov.br', 'noreply@caixa.gov.br',
  // Inter
  'nao-responda@inter.co', 'noreply@inter.co', 'contato@inter.co',
  // C6 Bank
  'noreply@c6bank.com.br', 'c6bank@',
  // Neon
  'noreply@neon.com.br', 'contato@neon.com.br',
  // PicPay
  'noreply@picpay.com', 'picpay@',
  // Mercado Pago
  'noreply@mercadopago.com', 'mercadopago@',
  // Sicoob / Sicredi
  'sicoob', 'sicredi',
  // PagBank / PagSeguro
  'pagseguro@', 'pagbank@',
];

function buildGmailQuery(dias) {
  // Gmail query: from:(banco1 OR banco2 ...) newer_than:Nd
  const fromList = BANK_SENDERS.slice(0, 15)  // Gmail suporta até ~500 chars de query
    .map(s => `from:${s}`)
    .join(' OR ');
  return `(${fromList}) newer_than:${dias}d`;
}

function extractEmailBody(payload) {
  let text = '';
  function walk(part) {
    if (part.mimeType === 'text/plain' && part.body?.data) {
      text += Buffer.from(part.body.data, 'base64url').toString('utf-8') + '\n';
    } else if (part.mimeType === 'text/html' && part.body?.data && !text) {
      // Fallback: HTML sem text/plain
      const html = Buffer.from(part.body.data, 'base64url').toString('utf-8');
      text += html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() + '\n';
    }
    if (part.parts) part.parts.forEach(walk);
  }
  walk(payload);
  if (!text && payload.body?.data) {
    text = Buffer.from(payload.body.data, 'base64url').toString('utf-8');
  }
  return text.trim();
}

app.post('/gmail/sync', async (req, res) => {
  const { companyId, dias = 7 } = req.body || {};
  if (!companyId) return res.status(400).json({ error: 'companyId obrigatório.' });

  try {
    const { all, t, token } = await getGmailAccessToken(companyId);
    const parsedIds = new Set(t.parsedIds || []);

    // 1. Lista mensagens dos últimos N dias
    const q = buildGmailQuery(Number(dias));
    const listRes = await axios.get(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages`,
      { params: { q, maxResults: 50 }, headers: { Authorization: `Bearer ${token}` } }
    );
    const messages = listRes.data.messages || [];
    const novos    = messages.filter(m => !parsedIds.has(m.id));

    console.log(`[Gmail] ${messages.length} emails no período, ${novos.length} não processados`);

    if (!novos.length) return res.json({ transactions: [], novas: 0 });

    const transactions = [];

    // 2. Processa cada email
    for (const msg of novos.slice(0, 25)) {
      try {
        const msgRes = await axios.get(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}`,
          { params: { format: 'full' }, headers: { Authorization: `Bearer ${token}` } }
        );

        const payload  = msgRes.data.payload;
        const headers  = payload.headers || [];
        const subject  = headers.find(h => h.name === 'Subject')?.value || '';
        const from     = headers.find(h => h.name === 'From')?.value    || '';
        const dateHdr  = headers.find(h => h.name === 'Date')?.value    || '';
        const body     = extractEmailBody(payload);

        if (!body && !subject) { parsedIds.add(msg.id); continue; }

        // 3. Groq parseia o email
        const prompt = `De: ${from}\nAssunto: ${subject}\nData: ${dateHdr}\n\n${body.slice(0, 2500)}`;

        const completion = await groq.chat.completions.create({
          model: 'llama-3.3-70b-versatile',
          messages: [
            {
              role: 'system',
              content: `Você é um parser especializado em emails bancários brasileiros. Analise o email e extraia a transação financeira.

Responda SOMENTE com um objeto JSON válido, sem markdown, sem explicação.

Formato obrigatório:
{"valor": 99.90, "tipo": "saida", "descricao": "Compra no iFood", "data": "2026-05-15", "banco": "Nubank"}

Regras:
- tipo: "entrada" (Pix recebido, depósito, crédito, cashback) ou "saida" (compra, débito, Pix enviado, pagamento, fatura)
- valor: número positivo sem símbolo de moeda
- data: formato YYYY-MM-DD (use a data do email se não houver outra)
- Se NÃO for um email de transação financeira, responda: {"ignorar": true}`
            },
            { role: 'user', content: prompt }
          ],
          temperature: 0,
          max_tokens: 200
        });

        const raw = completion.choices[0].message.content.trim();
        // Remove possível markdown ```json ... ```
        const jsonStr = raw.replace(/^```json?\s*/i, '').replace(/\s*```$/, '').trim();
        const parsed  = JSON.parse(jsonStr);

        if (!parsed.ignorar && parsed.valor > 0) {
          transactions.push({
            id:          `gmail_${msg.id}`,
            date:        parsed.data || new Date().toISOString().split('T')[0],
            description: parsed.descricao || subject,
            value:       Number(parsed.valor),
            category:    parsed.tipo === 'entrada' ? 'entrada' : 'saida-fixa',
            origem:      'email',
            banco:       parsed.banco || from.split('<')[0].trim(),
          });
          console.log(`[Gmail] ✓ ${parsed.tipo === 'entrada' ? '+' : '-'}R$${parsed.valor} — ${parsed.descricao}`);
        } else {
          console.log(`[Gmail] ⏭ ignorado: "${subject}"`);
        }

        parsedIds.add(msg.id);
        await new Promise(r => setTimeout(r, 150)); // evita rate limit Groq

      } catch (e) {
        console.warn(`[Gmail] Erro msg ${msg.id}:`, e.message);
        parsedIds.add(msg.id); // marca como processado para não tentar de novo
      }
    }

    // 4. Salva IDs processados (mantém últimos 1000)
    const allTokens = loadGmailTokens();
    if (allTokens[companyId]) {
      allTokens[companyId].parsedIds = [...parsedIds].slice(-1000);
      saveGmailTokens(allTokens);
    }

    res.json({ transactions, novas: transactions.length });

  } catch (err) {
    console.error('[Gmail] sync ERROR:', err.message);
    res.status(err.message.includes('não conectado') ? 401 : 500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
app.listen(PORT, () => {
  const gmailOk = !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║       Lumin — Backend v2.0                   ║');
  console.log('╠══════════════════════════════════════════════╣');
  console.log(`║  URL:       http://localhost:${PORT}             ║`);
  console.log(`║  Pluggy:    ✅ ${PLUGGY_CLIENT_ID.slice(0,8)}...           ║`);
  console.log(`║  Gmail:     ${gmailOk ? '✅ configurado' : '⚠️  sem credenciais Google'}     ║`);
  console.log(`║  Groq:      ${process.env.GROQ_API_KEY ? '✅ configurado' : '❌ sem GROQ_API_KEY'}           ║`);
  console.log('╚══════════════════════════════════════════════╝\n');
  if (!gmailOk) {
    console.log('  ℹ️  Para ativar o Gmail Sync:');
    console.log('     Adicione GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET no .env');
    console.log('     Veja instruções em: https://console.cloud.google.com\n');
  }
});
