/**
 * ═══════════════════════════════════════════════════════════════
 *  LUMIN — Backend: Webhook WhatsApp → Whisper → GPT → Firestore
 *  Arquivo: webhook-handler.js (Firebase Functions ou Express)
 *
 *  Fluxo:
 *  1. WhatsApp envia webhook com áudio (ou texto)
 *  2. Baixamos o arquivo de áudio da API do WhatsApp
 *  3. Transcrevemos com OpenAI Whisper
 *  4. GPT extrai os campos estruturados em JSON
 *  5. Calculamos Valor Total e salvamos no Firestore
 *  6. (Opcional) Confirmamos por WhatsApp ao remetente
 *
 *  Deploy: Firebase Functions (recomendado) ou Express.js standalone
 *
 *  ⚠ CHAVES DE API:
 *  Substitua os placeholders abaixo pelas suas chaves reais.
 *  NUNCA commite chaves reais no repositório.
 *  Use variáveis de ambiente: process.env.NOME_DA_VARIAVEL
 * ═══════════════════════════════════════════════════════════════
 */

// ─── DEPENDÊNCIAS ──────────────────────────────────────────────
// npm install express axios form-data openai firebase-admin
const express    = require('express');
const axios      = require('axios');
const FormData   = require('form-data');
const OpenAI     = require('openai');
const admin      = require('firebase-admin');

// ─── INICIALIZAÇÃO FIREBASE ADMIN ──────────────────────────────
// Opção A: Em Firebase Functions, o admin já é inicializado automaticamente.
// Opção B: Em servidor standalone, aponte para o arquivo de service account.
if (!admin.apps.length) {
  admin.initializeApp({
    // ⚠ SUBSTITUA: caminho para seu arquivo de credenciais de serviço
    credential: admin.credential.cert(require('./serviceAccountKey.json')),
    // ⚠ SUBSTITUA: URL do seu projeto Firestore
    databaseURL: 'https://lumin-a5b29.firebaseio.com'
  });
}
const db = admin.firestore();

// ─── CLIENTE OPENAI ────────────────────────────────────────────
const openai = new OpenAI({
  // ⚠ SUBSTITUA: sua chave da OpenAI
  apiKey: process.env.OPENAI_API_KEY || 'sk-SUBSTITUA_SUA_CHAVE_OPENAI_AQUI'
});

// ─── CONFIGURAÇÕES WHATSAPP CLOUD API ─────────────────────────
const WA_CONFIG = {
  // ⚠ SUBSTITUA: seu token de acesso permanente do WhatsApp Business
  accessToken:  process.env.WA_ACCESS_TOKEN  || 'SEU_TOKEN_WHATSAPP_AQUI',
  // ⚠ SUBSTITUA: seu Phone Number ID (não o número de telefone)
  phoneNumberId: process.env.WA_PHONE_ID     || 'SEU_PHONE_NUMBER_ID_AQUI',
  // ⚠ SUBSTITUA: token de verificação que você definiu no Meta Dashboard
  verifyToken:   process.env.WA_VERIFY_TOKEN || 'lumin_verify_2026'
};

// ─── PREÇOS PADRÃO POR COR (espelho do frontend) ──────────────
const PRECOS = { preta: 20.00, branca: 28.00 };

// ─── APP EXPRESS ───────────────────────────────────────────────
const app = express();
app.use(express.json());

// ── VERIFICAÇÃO DO WEBHOOK (GET) — exigido pelo Meta para ativar
app.get('/webhook/whatsapp', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === WA_CONFIG.verifyToken) {
    console.log('[Webhook] Verificação aceita pelo Meta.');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ── RECEBER MENSAGENS (POST) ────────────────────────────────────
app.post('/webhook/whatsapp', async (req, res) => {
  // Confirma imediatamente ao WhatsApp (evita retentativas)
  res.sendStatus(200);

  try {
    const body    = req.body;
    const entry   = body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value   = changes?.value;
    const message = value?.messages?.[0];

    if (!message) return; // Não é mensagem (pode ser status de entrega)

    const from = message.from; // Número do remetente (ex: "5511999990001")
    const type = message.type; // 'audio' | 'text' | etc.

    console.log(`[Webhook] Mensagem de ${from} | Tipo: ${type}`);

    // ── 1. Processar ÁUDIO
    if (type === 'audio') {
      await processAudioMessage(message, from);
    }

    // ── 2. Processar TEXTO direto (fallback / correção manual)
    if (type === 'text') {
      const textoOriginal = message.text?.body || '';
      await processTextToRecord(textoOriginal, from, 'whatsapp-texto');
    }

  } catch (err) {
    console.error('[Webhook] Erro não tratado:', err);
  }
});

// ─── PROCESSAMENTO DE ÁUDIO ────────────────────────────────────
async function processAudioMessage(message, from) {
  const audioId = message.audio?.id;
  if (!audioId) return;

  try {
    // PASSO 1: Obter URL do áudio via API do WhatsApp
    console.log(`[Audio] Obtendo URL do áudio ${audioId}...`);
    const mediaRes = await axios.get(
      `https://graph.facebook.com/v19.0/${audioId}`,
      { headers: { Authorization: `Bearer ${WA_CONFIG.accessToken}` } }
    );
    const audioUrl = mediaRes.data.url;
    const mimeType = mediaRes.data.mime_type || 'audio/ogg';

    // PASSO 2: Baixar o arquivo de áudio
    console.log('[Audio] Baixando arquivo de áudio...');
    const audioRes = await axios.get(audioUrl, {
      responseType: 'arraybuffer',
      headers: { Authorization: `Bearer ${WA_CONFIG.accessToken}` }
    });
    const audioBuffer = Buffer.from(audioRes.data);

    // PASSO 3: Transcrever com Whisper
    const transcricao = await transcreverAudio(audioBuffer, mimeType);
    if (!transcricao) {
      await enviarMensagemWhatsapp(from, '⚠ Não consegui entender o áudio. Por favor, tente novamente com mais clareza.');
      return;
    }
    console.log(`[Audio] Transcrição: "${transcricao}"`);

    // PASSO 4: Extrair dados e salvar
    await processTextToRecord(transcricao, from, 'whatsapp-audio');

  } catch (err) {
    console.error('[Audio] Erro ao processar áudio:', err.message);
    await enviarMensagemWhatsapp(from, '❌ Erro ao processar o áudio. Tente novamente.');
  }
}

// ─── TRANSCRIÇÃO WHISPER ───────────────────────────────────────
async function transcreverAudio(buffer, mimeType) {
  try {
    // Determine extensão pelo MIME type
    const ext = mimeType.includes('ogg') ? 'ogg'
              : mimeType.includes('mp4') ? 'mp4'
              : mimeType.includes('mpeg') ? 'mp3'
              : 'ogg';

    // Cria FormData com o buffer
    const form = new FormData();
    form.append('file', buffer, { filename: `audio.${ext}`, contentType: mimeType });
    form.append('model', 'whisper-1');
    form.append('language', 'pt');  // Português do Brasil
    form.append('response_format', 'text');

    const response = await openai.audio.transcriptions.create({
      file: form.get('file'),
      model: 'whisper-1',
      language: 'pt',
      response_format: 'text'
    });

    return String(response).trim();
  } catch (err) {
    console.error('[Whisper] Erro na transcrição:', err.message);
    return null;
  }
}

// ─── NORMALIZAÇÃO DE COR ───────────────────────────────────────
/**
 * Converte qualquer variação de cor que o GPT possa retornar
 * para o valor canônico aceito pelo frontend: "Preta" | "Branca" | null
 *
 * O GPT às vezes retorna: "preta", "PRETA", "pretas", "caixa preta",
 * "branca", "BRANCA", "brancas", "caixa branca", etc.
 */
function normalizarCor(cor) {
  if (!cor) return null;
  const c = String(cor).toLowerCase();
  if (c.includes('pret')) return 'Preta';
  if (c.includes('branc')) return 'Branca';
  return null; // cor desconhecida → REVISAR
}

/**
 * Retorna o valorUnitario com base na cor normalizada.
 * Centraliza a lógica de preço para evitar inconsistências.
 */
function precoPorCorNorm(corNormalizada) {
  if (corNormalizada === 'Preta')  return PRECOS.preta;
  if (corNormalizada === 'Branca') return PRECOS.branca;
  return 0;
}

// ─── EXTRAÇÃO DE DADOS COM GPT ────────────────────────────────
async function extrairDadosComGPT(transcricao) {
  const hoje = new Date().toISOString().split('T')[0];

  const systemPrompt = `
Você é um extrator de dados logísticos para um sistema de controle de caixas.
Analise o texto e retorne APENAS um objeto JSON válido, sem explicações, sem markdown.

CAMPOS DO JSON (use null se não encontrar):
{
  "tipo":         "ENTRADA" ou "SAÍDA" (obrigatório),
  "data":         "YYYY-MM-DD" (use ${hoje} se não mencionado),
  "cliente":      string com nome do cliente/unidade, ou null,
  "quantidadeCx": número inteiro de caixas (obrigatório),
  "cor":          EXATAMENTE "Preta" ou "Branca" (com maiúscula inicial) ou null,
  "motorista":    string com nome do motorista, ou null,
  "status":       "OK" ou "REVISAR"
}

REGRAS IMPORTANTES:
- O campo "cor" deve ser EXATAMENTE a string "Preta" ou "Branca" — nunca plural, nunca minúsculo, nunca outra variação.
- "entrada" / "entrou" / "chegou" = tipo ENTRADA
- "saída" / "saiu" / "foi" / "saíram" = tipo SAÍDA
- Se a cor não for mencionada ou for ambígua → cor: null, status: "REVISAR"
- Se o cliente não for identificável → cliente: null
- Se qualquer campo obrigatório estiver ambíguo → status: "REVISAR"
- NÃO calcule valorUnitario nem valorTotal — o sistema calcula automaticamente.

Retorne SOMENTE o JSON, sem nenhum texto adicional.
  `.trim();

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: `Texto: "${transcricao}"` }
      ],
      temperature: 0,
      max_tokens: 300,
      response_format: { type: 'json_object' }
    });

    const raw  = response.choices[0]?.message?.content || '{}';
    const data = JSON.parse(raw);

    // ── PIPELINE DE NORMALIZAÇÃO PÓS-GPT ──────────────────────
    // Mesmo que o GPT ignore as instruções e retorne variações de cor,
    // normalizamos aqui antes de qualquer cálculo.

    // 1. Normalizar cor → "Preta" | "Branca" | null
    const corNorm = normalizarCor(data.cor);
    data.cor = corNorm;

    // 2. Se cor desconhecida, forçar REVISAR
    if (data.cor === null && (String(data.corOriginal || '')).length > 0) {
      data.status = 'REVISAR';
    }

    // 3. Calcular valorUnitario e valorTotal com base na cor normalizada
    //    (não confiamos no que o GPT calculou — recalculamos sempre)
    const qtd = Number(data.quantidadeCx) || 0;
    const preco = precoPorCorNorm(corNorm);
    data.valorUnitario = preco;
    data.valorTotal    = preco > 0 ? qtd * preco : 0;

    // 4. Se cor null (cor não identificada), status deve ser REVISAR
    if (!corNorm) {
      data.status = 'REVISAR';
    }

    // 5. Garantir tipo válido
    if (!['ENTRADA', 'SAÍDA'].includes(data.tipo)) {
      data.tipo   = 'ENTRADA';
      data.status = 'REVISAR';
    }

    console.log('[GPT] Dados extraídos e normalizados:', JSON.stringify(data));
    return data;

  } catch (err) {
    console.error('[GPT] Erro na extração:', err.message);
    return null;
  }
}

// ─── SALVAR NO FIRESTORE ───────────────────────────────────────
async function salvarNoFirestore(dados, from, origem) {
  // ⚠ Todos os campos chegam já normalizados por extrairDadosComGPT:
  //   - cor:          "Preta" | "Branca" | null → salvo como string vazia se null
  //   - cliente:      string ou null → salvo como 'Não identificado' se null
  //   - valorUnitario / valorTotal: sempre numéricos, calculados pelo pipeline
  //
  // Esquema canônico (espelho exato do addDoc em saveNewRecord do frontend):
  //   tipo, data, cliente, fornecedor, quantidadeCx, cor,
  //   valorUnitario, valorTotal, motorista, status, origem, createdAt
  const docData = {
    tipo:          dados.tipo                                        || 'ENTRADA',
    data:          dados.data                                        || new Date().toISOString().split('T')[0],
    cliente:       (dados.cliente || 'Não identificado').trim().toUpperCase(),
    fornecedor:    '',        // bot não tem fornecedor — campo obrigatório no schema
    quantidadeCx:  Number(dados.quantidadeCx)                       || 0,
    cor:           dados.cor || '',   // já em Title Case ("Preta"/"Branca") ou vazio
    valorUnitario: Number(dados.valorUnitario)                      || 0,
    valorTotal:    Number(dados.valorTotal)                         || 0,
    motorista:     (dados.motorista || '').trim().toUpperCase(),
    status:        dados.status                                      || 'OK',
    origem,
    whatsappFrom:  from,
    createdAt:     admin.firestore.FieldValue.serverTimestamp()
  };

  const ref = await db.collection('controle_caixas').add(docData);
  console.log(`[Firestore] Salvo com ID: ${ref.id}`);
  return ref.id;
}

// ─── PIPELINE PRINCIPAL (TEXTO → REGISTRO) ────────────────────
async function processTextToRecord(texto, from, origem) {
  // Extrai dados com GPT
  const dados = await extrairDadosComGPT(texto);

  if (!dados || !dados.cliente) {
    await enviarMensagemWhatsapp(from,
      '⚠ Não consegui identificar os dados completos.\nVerifique se informou: tipo (entrada/saída), cliente, quantidade e cor das caixas.'
    );
    return;
  }

  // Salva no Firestore
  const docId = await salvarNoFirestore(dados, from, origem);

  // Monta confirmação formatada
  const corEmoji = (dados.cor || '').toLowerCase().includes('pret') ? '⬛'
                 : (dados.cor || '').toLowerCase().includes('branc') ? '⬜' : '🔲';

  const confirmacao = [
    `✅ *Registro salvo com sucesso!*`,
    ``,
    `📋 *Resumo:*`,
    `• Tipo: *${dados.tipo || '—'}*`,
    `• Data: *${dados.data || '—'}*`,
    `• Cliente: *${dados.cliente || '—'}*`,
    `• Qtd Caixas: *${dados.quantidadeCx || 0}*`,
    `• Cor: ${corEmoji} *${dados.cor || 'Não informado'}*`,
    `• Valor Unitário: *R$ ${(dados.valorUnitario || 0).toFixed(2).replace('.', ',')}*`,
    `• Valor Total: *R$ ${(dados.valorTotal || 0).toFixed(2).replace('.', ',')}*`,
    `• Motorista: *${dados.motorista || 'Não informado'}*`,
    dados.status === 'REVISAR' ? `\n⚠ *Status: REVISAR* — Alguns dados precisam conferência manual.` : '',
    ``,
    `_ID: ${docId}_`
  ].filter(Boolean).join('\n');

  await enviarMensagemWhatsapp(from, confirmacao);
}

// ─── ENVIAR MENSAGEM WHATSAPP ──────────────────────────────────
async function enviarMensagemWhatsapp(para, texto) {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${WA_CONFIG.phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        to: para,
        type: 'text',
        text: { body: texto }
      },
      {
        headers: {
          Authorization: `Bearer ${WA_CONFIG.accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );
  } catch (err) {
    console.error('[WhatsApp] Erro ao enviar mensagem:', err.response?.data || err.message);
  }
}

// ─── ROTA DE SAÚDE ─────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok', service: 'lumin-webhook', ts: new Date().toISOString() }));

// ─── INICIAR SERVIDOR ──────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`[Lumin Webhook] Servidor rodando na porta ${PORT}`);
  console.log(`Endpoint: POST /webhook/whatsapp`);
});

module.exports = app; // Para Firebase Functions: exports.webhook = functions.https.onRequest(app);

/*
 ═══════════════════════════════════════════════════════════════
 INSTRUÇÕES DE DEPLOY
 ═══════════════════════════════════════════════════════════════

 ── OPÇÃO A: Firebase Functions ─────────────────────────────

 1. cd functions/
 2. npm install express axios form-data openai firebase-admin
 3. No index.js da Function, substitua o module.exports final por:
      const functions = require('firebase-functions');
      exports.webhook = functions.https.onRequest(app);
 4. firebase deploy --only functions

 Configurar variáveis de ambiente:
      firebase functions:config:set \
        openai.key="sk-SUA_CHAVE" \
        wa.token="SEU_TOKEN" \
        wa.phone_id="SEU_PHONE_ID" \
        wa.verify="lumin_verify_2026"

 ── OPÇÃO B: Servidor Node.js (ex: Railway, Render) ──────────

 1. npm install
 2. Crie .env com as variáveis:
      OPENAI_API_KEY=sk-SUA_CHAVE
      WA_ACCESS_TOKEN=SEU_TOKEN
      WA_PHONE_ID=SEU_PHONE_ID
      WA_VERIFY_TOKEN=lumin_verify_2026
      PORT=3001
 3. node webhook-handler.js

 ── CONFIGURAR WEBHOOK NO META DASHBOARD ─────────────────────

 1. Acesse: developers.facebook.com → seu App → WhatsApp → Webhooks
 2. URL do Webhook: https://SEU_DOMINIO/webhook/whatsapp
 3. Token de Verificação: lumin_verify_2026 (ou o que definiu)
 4. Assinar campos: messages

 ═══════════════════════════════════════════════════════════════
 EXEMPLO DE ÁUDIO QUE O SISTEMA ENTENDE:
 "Entrada de 8 caixas pretas do cliente Unidade Shallom
  pelo motorista William Fernando"

 GPT irá retornar:
 {
   "tipo": "ENTRADA",
   "data": "2026-04-29",
   "cliente": "Unidade Shallom",
   "quantidadeCx": 8,
   "cor": "Preta",
   "valorUnitario": 20.00,
   "valorTotal": 160.00,
   "motorista": "William Fernando",
   "status": "OK"
 }
 ═══════════════════════════════════════════════════════════════
*/
