/**
 * ═══════════════════════════════════════════════════════════════
 *  LUMIN — Backend: WhatsApp Bot + Pluggy Open Finance
 *  Arquivo: webhook-handler.js
 *
 *  Funcionalidades:
 *  1. Bot WhatsApp via QR Code (whatsapp-web.js)
 *     - Reconhece o número de quem mandou
 *     - Associa ao companyId cadastrado no Firestore (campo "phone")
 *     - Groq interpreta a mensagem (texto ou áudio)
 *     - Salva a transação direto em {companyId}_transacoes
 *     - Responde com confirmação no WhatsApp
 *
 *  2. Pluggy Open Finance (endpoints REST)
 *     - GET  /pluggy/connect-token  → token para o widget no frontend
 *     - POST /pluggy/save-item      → salva itemId da conta bancária
 *     - POST /pluggy/sync           → busca e categoriza transações
 *
 *  Deploy: node webhook-handler.js
 *  QR Code aparece no terminal — escaneie com o WhatsApp do celular.
 *  A sessão é salva em .wwebjs_auth/ e não precisa escanear de novo.
 *
 *  npm install express whatsapp-web.js qrcode-terminal groq-sdk firebase-admin cors axios
 * ═══════════════════════════════════════════════════════════════
 */

// ─── DEPENDÊNCIAS ──────────────────────────────────────────────
require('dotenv').config();
const express          = require('express');
const cors             = require('cors');
const axios            = require('axios');
const Groq             = require('groq-sdk');
const admin            = require('firebase-admin');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode           = require('qrcode-terminal');
const QRCode           = require('qrcode');
const cron             = require('node-cron');
const PDFDocument      = require('pdfkit');
const fs               = require('fs');
const path             = require('path');
const gTTS             = require('node-gtts')('pt');
const ffmpegPath       = require('ffmpeg-static');
const { execFile }     = require('child_process');

// ─── CONFIG ────────────────────────────────────────────────────
const ALERTA_VALOR_UNICO = Number(process.env.ALERTA_VALOR || 500); // avisa se gasto > R$500

// ─── FIREBASE ADMIN ────────────────────────────────────────────
// Em produção usa variável de ambiente (base64); em dev usa o arquivo local
if (!admin.apps.length) {
  let credential;
  if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
    const sa = JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf-8'));
    credential = admin.credential.cert(sa);
  } else {
    credential = admin.credential.cert(require('./serviceAccountKey.json'));
  }
  admin.initializeApp({ credential, databaseURL: 'https://lumin-a5b29.firebaseio.com' });
}
const db = admin.firestore();

// ─── GROQ ──────────────────────────────────────────────────────
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY || 'gsk-SUBSTITUA_SUA_CHAVE_GROQ_AQUI'
});

// ─── PLUGGY ────────────────────────────────────────────────────
const PLUGGY_CLIENT_ID     = process.env.PLUGGY_CLIENT_ID     || 'SEU_CLIENT_ID_PLUGGY_AQUI';
const PLUGGY_CLIENT_SECRET = process.env.PLUGGY_CLIENT_SECRET || 'SEU_CLIENT_SECRET_PLUGGY_AQUI';
const PLUGGY_BASE_URL      = 'https://api.pluggy.ai';

// ─── GOOGLE / GMAIL ────────────────────────────────────────────
const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
// Em produção (Fly.io), o callback é via HTTPS. Em dev local, fallback pra localhost.
const GMAIL_REDIRECT_URI   = process.env.FLY_APP_NAME
  ? `https://${process.env.FLY_APP_NAME}.fly.dev/gmail/callback`
  : `http://localhost:${process.env.PORT || 3001}/gmail/callback`;
// Tokens persistidos no volume Fly.io (sobrevive a deploys)
const GMAIL_TOKENS_FILE = fs.existsSync('/data')
  ? '/data/gmail-tokens.json'
  : path.join(__dirname, 'gmail-tokens.json');
// (groq já declarado mais acima)

// ─── CATEGORIAS (espelho do frontend) ──────────────────────────
const CATS = {
  'entrada':     'Entrada',
  'saida-fixa':  'Saída Fixa',
  'funcionario': 'Pagto. Funcionário',
  'comida':      'Comida',
  'variavel':    'Despesa Variável'
};

// ═══════════════════════════════════════════════════════════════
//  WHATSAPP BOT — resiliente com auto-reconexão
// ═══════════════════════════════════════════════════════════════

// ── Estado de reconexão
let _waReady        = false;
let _reconectando   = false;
let _tentativas     = 0;
let _qrAtual        = null;
const MAX_TENTATIVAS = 15;

// ── Estado de features por usuário
const _pendingConfirm  = new Map(); // chatId → {txs, empresaId, phone, expira}
const _voiceUsers      = new Set(); // chatIds que querem resposta em áudio
const _recentSaves     = new Map(); // chatId → [{desc, amount, ts}] para detecção de duplicados
const _conversaHistory = new Map(); // chatId → [{role, content}] histórico de conversa
const MONTHS_BR = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

// Usa /data se o volume estiver montado (Fly.io), senão usa pasta local
const DATA_DIR     = fs.existsSync('/data') ? '/data' : __dirname;
const SESSION_PATH = path.join(DATA_DIR, '.wwebjs_auth');
const SESSION_BAK  = path.join(DATA_DIR, '.wwebjs_auth_backup');
console.log(`[Init] Sessão será salva em: ${SESSION_PATH}`);

function criarWaClient() {
  return new Client({
    authStrategy: new LocalAuth({ clientId: 'lumin-bot', dataPath: SESSION_PATH }),
    puppeteer: {
      headless: true,
      // No Fly.io usa o Chromium instalado no container
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-default-apps',
        '--mute-audio',
        '--disable-translate',
        '--safebrowsing-disable-auto-update',
        '--disable-sync',
        // Corrige "Execution context was destroyed" em Docker
        '--disable-features=IsolateOrigins,site-per-process,BlockInsecurePrivateNetworkRequests',
        '--disable-site-isolation-trials',
        '--ignore-certificate-errors',
        '--ignore-ssl-errors'
      ],
      timeout: 180000
    },
    restartOnAuthFail: true,
    qrMaxRetries: 10,
    takeoverOnConflict: true,
    takeoverTimeoutMs: 10000
  });
}

let waClient = criarWaClient();

function registrarEventosWa(client) {
  client.on('qr', qr => {
    _waReady = false;
    _qrAtual = qr;
    const qrUrl = process.env.FLY_APP_NAME ? `https://${process.env.FLY_APP_NAME}.fly.dev/qr` : `http://localhost:${process.env.PORT||3001}/qr`;
    console.log(`\n[WhatsApp] ⚡ Novo QR Code gerado! Acesse: ${qrUrl}\n`);
    qrcode.generate(qr, { small: true });

    // Salva/atualiza o arquivo PNG a cada novo QR (no volume persistente em produção)
    const qrPath = path.join(DATA_DIR, 'qrcode.png');
    QRCode.toFile(qrPath, qr, { width: 400, margin: 2 }, err => {
      if (!err) console.log(`[WhatsApp] 📷 QR atualizado: ${qrPath}`);
    });
  });

  client.on('authenticated', () => {
    console.log(`[WhatsApp] ✅ Autenticado! Sessão salva em ${SESSION_PATH}`);
    _tentativas = 0;
  });

  client.on('auth_failure', async msg => {
    console.error('[WhatsApp] ❌ Falha de autenticação:', msg);
    _waReady = false;
    try {
      if (fs.existsSync(SESSION_BAK)) {
        console.log('[WhatsApp] 🔄 Tentando restaurar sessão do backup...');
        if (fs.existsSync(SESSION_PATH)) fs.rmSync(SESSION_PATH, { recursive: true, force: true });
        fs.cpSync(SESSION_BAK, SESSION_PATH, { recursive: true });
        console.log('[WhatsApp] ✅ Backup restaurado! Tentando reconectar...');
      } else if (fs.existsSync(SESSION_PATH)) {
        fs.rmSync(SESSION_PATH, { recursive: true, force: true });
        console.log('[WhatsApp] 🗑  Sessão corrompida removida. Precisará escanear o QR novamente.');
      }
    } catch (_) {}
    agendarReconexao(5000);
  });

  client.on('ready', () => {
    _waReady = true;
    _tentativas = 0;
    _reconectando = false;
    console.log('[WhatsApp] 🟢 Bot conectado e pronto!');
  });

  client.on('disconnected', reason => {
    _waReady = false;
    console.warn('[WhatsApp] 🔴 Desconectado:', reason);
    // LOGOUT real = sessão inválida no WhatsApp, apaga e pede QR novo
    if (reason === 'LOGOUT') {
      try {
        if (fs.existsSync(SESSION_PATH)) fs.rmSync(SESSION_PATH, { recursive: true, force: true });
      } catch (_) {}
    }
    agendarReconexao();
  });
}

function agendarReconexao(forceDelay = null) {
  if (_reconectando) return;
  _reconectando = true;
  _tentativas++;

  if (_tentativas > MAX_TENTATIVAS) {
    console.error('[WhatsApp] ☠  Máximo de tentativas atingido. Reiniciando o processo...');
    process.exit(1); // PM2 reinicia automaticamente
  }

  // Backoff exponencial: 5s, 10s, 20s, 40s... máx 5 min
  const delay = forceDelay ?? Math.min(5000 * Math.pow(2, _tentativas - 1), 300000);
  console.log(`[WhatsApp] 🔄 Reconectando em ${Math.round(delay / 1000)}s... (tentativa ${_tentativas}/${MAX_TENTATIVAS})`);

  setTimeout(async () => {
    try {
      waClient.removeAllListeners();
      try { await waClient.destroy(); } catch (_) {}

      waClient = criarWaClient();
      registrarEventosWa(waClient);
      registrarHandlerMensagens(waClient);
      await waClient.initialize();
      _reconectando = false;
    } catch (err) {
      console.error('[WhatsApp] Erro na reconexão:', err.message);
      _reconectando = false;
      agendarReconexao();
    }
  }, delay);
}

// ── Watchdog: verifica a cada 5 minutos se o bot está vivo
setInterval(async () => {
  if (_reconectando) return;
  try {
    const state = await waClient.getState().catch(() => null);
    if (state !== 'CONNECTED' && _waReady) {
      console.warn('[Watchdog] ⚠  Estado inesperado:', state, '— forçando reconexão');
      _waReady = false;
      agendarReconexao(3000);
    }
  } catch (_) {}
}, 5 * 60 * 1000);

// ── Keepalive: a cada 30 minutos faz uma operação leve pra manter a sessão ativa
setInterval(async () => {
  if (!_waReady || _reconectando) return;
  try {
    // Busca o próprio número — operação leve que mantém a conexão viva
    await waClient.getState();
    const info = await waClient.info;
    if (info) console.log(`[Keepalive] ✅ Sessão ativa — ${info.pushname || 'bot'}`);
  } catch (e) {
    console.warn('[Keepalive] ⚠ Falha no keepalive:', e.message);
    // Se falhou, aciona o watchdog
    if (_waReady) { _waReady = false; agendarReconexao(5000); }
  }
}, 30 * 60 * 1000);

// ── Backup da sessão: a cada 6 horas copia sessão para backup
setInterval(() => {
  try {
    if (!fs.existsSync(SESSION_PATH)) return;
    if (fs.existsSync(SESSION_BAK)) fs.rmSync(SESSION_BAK, { recursive: true, force: true });
    fs.cpSync(SESSION_PATH, SESSION_BAK, { recursive: true });
    console.log(`[Sessão] 💾 Backup criado em ${SESSION_BAK}`);
  } catch (e) {
    console.warn('[Sessão] Erro no backup:', e.message);
  }
}, 6 * 60 * 60 * 1000);

registrarEventosWa(waClient);

// Deduplicação: evita processar a mesma mensagem duas vezes (message + message_create)
const _msgProcessados = new Set();

// ── Handler de mensagens (função separada para poder re-registrar após reconexão)
function registrarHandlerMensagens(client) {

  async function handleMsg(msg) {
    // Ignora mensagens do próprio bot e grupos
    if (msg.fromMe) return;
    const from = msg.from || '';
    if (from.endsWith('@g.us')) return; // grupo

    // Deduplicação por ID de mensagem
    const msgId = msg.id?.id || msg.id?._serialized || null;
    if (msgId) {
      if (_msgProcessados.has(msgId)) return;
      _msgProcessados.add(msgId);
      // Limpa IDs antigos após 5 minutos
      setTimeout(() => _msgProcessados.delete(msgId), 5 * 60 * 1000);
    }

    // Patch msg.reply para usar sendMessage diretamente — necessário em mensagens @lid
    // onde msg.reply trava silenciosamente porque não consegue construir a referência de quote
    const originalReply = msg.reply.bind(msg);
    msg.reply = async function(content, chatId, options) {
      try {
        return await waClient.sendMessage(msg.from, content, options);
      } catch (err) {
        console.error(`[WA] sendMessage falhou para ${msg.from}:`, err.message);
        try { return await originalReply(content, chatId, options); }
        catch (e2) { console.error(`[WA] reply fallback também falhou:`, e2.message); }
      }
    };

    // Delega para o processamento principal
    return processarMensagem(msg);
  }

  client.on('message', handleMsg);
  client.on('message_create', handleMsg);
}

// ── Processamento principal de mensagem
async function processarMensagem(msg) {
  // Ignora grupos e mensagens do próprio bot
  if (msg.isGroupMsg || msg.fromMe) return;

  const rawId  = msg.from;
  const isLid  = rawId.endsWith('@lid');

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`[WA] 📨 Mensagem recebida`);
  console.log(`[WA] Raw:   ${rawId}`);
  console.log(`[WA] Tipo:  ${msg.type}`);
  console.log(`[WA] Texto: ${msg.body || '(áudio)'}`);

  try {
    // ── 1. Resolve o telefone real (com fluxo de verificação para @lid)
    let phone;
    if (isLid) {
      const mappingRef = db.collection('whatsapp_lid_mappings').doc(rawId);
      const mapDoc = await mappingRef.get();

      if (mapDoc.exists) {
        phone = mapDoc.data().phone;
        console.log(`[WA] 🔗 LID já vinculado ao número ${phone}`);
      } else {
        // Tenta interpretar como número de cadastro ou pede verificação
        const verified = await tentarVerificacaoLid(msg, rawId);
        if (!verified) return; // bot já respondeu com instruções
        phone = verified;
      }
    } else {
      phone = rawId.replace('@c.us', '').replace('@g.us', '');
      console.log(`[WA] 📞 Telefone direto: ${phone}`);
    }

    // ── 2. Identifica a empresa pelo número cadastrado
    const empresa = await buscarEmpresaPorTelefone(phone);
    if (!empresa) {
      console.log(`[WA] ❌ Número ${phone} não cadastrado em nenhuma empresa`);
      await msg.reply(
        `Seu número *${phone}* ainda não está cadastrado.\n\n` +
        `Peça pro admin do Lumin te adicionar.`
      );
      return;
    }
    console.log(`[WA] ✅ Empresa identificada: ${empresa.nomeUsuario} (${empresa.id})`);
    empresa.nomeUsuario = getNomeUsuario(empresa); // nome da pessoa, não da empresa

    // ── 2. Roteamento por tipo de mensagem

    // 📸 FOTO DE NOTA FISCAL
    if (msg.type === 'image') {
      await msg.reply('📸 Recebi a foto! Deixa eu ler aqui...');
      const txFoto = await processarFotoNota(msg);
      if (!txFoto || txFoto.length === 0) {
        await msg.reply(`🤔 Não consegui identificar nenhuma transação na foto, ${empresa.nomeUsuario}. Tenta uma foto mais nítida ou manda o valor no texto mesmo!`);
        return;
      }
      const refs = await salvarTransacoes(txFoto, empresa.id, phone);
      if (refs.length === 1) {
        await msg.reply(formatConfirmacao(refs[0].tx, empresa.nomeUsuario, refs[0].ref.id) + `\n\n_📸 Extraído da foto_`);
      } else {
        await msg.reply(formatConfirmacaoMultipla(refs, empresa.nomeUsuario) + `\n\n_📸 Extraído da foto_`);
      }
      await verificarAlertas(refs, empresa, msg.from);
      return;
    }

    // 🎙 ÁUDIO
    let textoOriginal = '';
    if (msg.type === 'ptt' || msg.type === 'audio') {
      textoOriginal = await transcreverAudio(msg);
      if (!textoOriginal) {
        await msg.reply('Não consegui entender o áudio. Tenta de novo falando mais devagar.');
        return;
      }
      console.log(`[WA] Transcrição: "${textoOriginal}"`);
    } else if (msg.type === 'chat') {
      textoOriginal = msg.body?.trim();
    } else {
      return;
    }

    if (!textoOriginal) return;

    // ── Comandos especiais
    if (/^(ajuda|help|oi|ola|olá|menu|oii|oiii)$/i.test(textoOriginal)) {
      await enviarResposta(msg, formatAjuda(empresa.nomeUsuario));
      return;
    }

    // Comando de diagnóstico — útil pra debug
    if (/^(diagnost|quem.sou.eu|debug|check)/i.test(textoOriginal)) {
      const seteDiasAtras = new Date();
      seteDiasAtras.setDate(seteDiasAtras.getDate() - 7);
      const dataLimite = seteDiasAtras.toISOString().split('T')[0];
      const txSnap = await db.collection('transactions')
        .where('companyId', '==', empresa.id)
        .get();
      const total = txSnap.size;
      const recentes = txSnap.docs
        .map(d => d.data())
        .filter(t => (t.date || '') >= dataLimite);
      const ultimasViaBot = recentes.filter(t => t.origem === 'whatsapp').length;

      // CHECA CONFLITOS: outras empresas com mesmo telefone (qualquer variação)
      const variations = phoneVariations(phone);
      const todasEmpresas = await db.collection('companies').get();
      const conflitos = [];
      todasEmpresas.forEach(d => {
        if (d.id === empresa.id) return;  // pula a própria
        const data = d.data();
        const candidatos = [data.phone, ...(data.phones || [])].filter(Boolean);
        const match = candidatos.some(c => {
          const norm = normalizePhone(c);
          return variations.some(v => v === c || normalizePhone(v) === norm);
        });
        if (match) conflitos.push(data.name || d.id);
      });

      let info = `Diagnóstico\n\n`;
      info += `Número: ${phone}\n`;
      info += `Empresa: ${empresa.nomeUsuario}\n`;
      info += `ID: ${empresa.id}\n\n`;
      info += `Transações nessa empresa:\n`;
      info += `• Total: ${total}\n`;
      info += `• Últimos 7 dias: ${recentes.length}\n`;
      info += `• Via WhatsApp (7d): ${ultimasViaBot}`;

      if (conflitos.length) {
        info += `\n\n⚠ CONFLITO DETECTADO\n`;
        info += `Seu número também está cadastrado em:\n`;
        conflitos.forEach(c => info += `• ${c}\n`);
        info += `\nO bot está salvando em "${empresa.nomeUsuario}". Se não é a empresa certa, peça pro admin remover seu número das outras.`;
      }

      await msg.reply(info);
      return;
    }
    if (/^(resumo|relat[oó]rio|resumão|como\s*t[aá]|saldo|extrato)$/i.test(textoOriginal)) {
      await enviarResposta(msg, await gerarResumoSemanal(empresa.id, empresa.nomeUsuario));
      return;
    }
    if (/^(resumo\s*mensal|m[eê]s|esse\s*m[eê]s)$/i.test(textoOriginal)) {
      await enviarResposta(msg, await gerarResumoMensal(empresa.id, empresa.nomeUsuario));
      return;
    }
    if (/^(últimos|ultimos|últimas|ultimas|\d+\s*últimos|\d+\s*lançamentos)$/i.test(textoOriginal)) {
      await enviarResposta(msg, await listarUltimas(empresa.id, 5));
      return;
    }
    if (/^(cancela|desfaz|apaga|deleta?\s*[uú]ltim)/i.test(textoOriginal)) {
      const ok = await deletarUltima(empresa.id);
      await enviarResposta(msg, ok ? `Última transação removida.` : `Não tem nada pra remover.`);
      return;
    }
    if (
      /^(exportar?|pdf|relat[oó]rio(\s*pdf)?|exportar?\s*pdf)$/i.test(textoOriginal) ||
      /\b(export[ae]r?|gerar?|mand[ae]r?|quero|preciso|me\s*mand[ae])\b.{0,40}\b(pdf|relat[oó]rio|gastos?|lançamentos?|financeiro)\b/i.test(textoOriginal) ||
      /\b(pdf|relat[oó]rio)\b.{0,30}\b(m[eê]s|mensal|gastos?|export)/i.test(textoOriginal)
    ) {
      await msg.reply('⏳ Gerando o PDF do mês... já já tô mandando!');
      await enviarPDFMes(empresa.id, empresa.nomeUsuario, msg.from);
      return;
    }

    // ── Confirmação de transação pendente (sim/não)
    if (/^(sim|s|confirma|pode|bora|vai|ok)$/i.test(textoOriginal)) {
      const pend = _pendingConfirm.get(msg.from);
      if (pend && Date.now() < pend.expira) {
        _pendingConfirm.delete(msg.from);
        const refs = await salvarTransacoes(pend.txs, empresa.id, phone);
        if (refs.length === 1) { const {tx,ref}=refs[0]; await msg.reply(formatConfirmacao(tx, empresa.nomeUsuario, ref.id)); }
        else await msg.reply(formatConfirmacaoMultipla(refs, empresa.nomeUsuario));
        await verificarAlertas(refs, empresa, msg.from);
        return;
      }
    }
    if (/^(nao|não|n|cancela|cancelar)$/i.test(textoOriginal)) {
      if (_pendingConfirm.has(msg.from)) {
        _pendingConfirm.delete(msg.from);
        await msg.reply('❌ Ok, cancelei! Se quiser registrar, manda de novo.');
        return;
      }
    }

    // ── Projeção do mês
    if (/projecao|projeção|como.*vai.*terminar|terminar.*m[eê]s|fechar.*m[eê]s|previs[aã]o.*m[eê]s/i.test(textoOriginal)) {
      await enviarResposta(msg, await gerarProjecaoMes(empresa.id, empresa.nomeUsuario));
      return;
    }

    // ── Metas financeiras
    if (/^meta\s+([\d.,]+)/i.test(textoOriginal)) {
      const val = parseFloat(textoOriginal.replace(/[^\d,.]/g,'').replace(',','.'));
      if (val > 0) { await definirMeta(empresa.id, val, empresa.nomeUsuario, msg.from); return; }
    }
    if (/^(minha\s+meta|ver\s+meta|qual.*meta|meta\?|como.*meta|bati.*meta)$/i.test(textoOriginal)) {
      await enviarResposta(msg, await verMeta(empresa.id, empresa.nomeUsuario));
      return;
    }

    // ── Lembretes customizados
    if (/me\s+lembra|criar?\s+lembrete|adiciona\s+lembrete/i.test(textoOriginal)) {
      await criarLembrete(empresa.id, msg.from, textoOriginal, empresa.nomeUsuario);
      return;
    }
    if (/^(meus\s+lembretes|ver\s+lembretes|lembretes)$/i.test(textoOriginal)) {
      await enviarResposta(msg, await listarLembretes(empresa.id));
      return;
    }

    // ── Busca por descrição/categoria
    if (/quanto\s+(gastei|foi|custou|saiu)\s+(com|em|no|na|de)|total\s+(de|com|em|no)/i.test(textoOriginal)) {
      await enviarResposta(msg, await buscarPorTermo(textoOriginal, empresa.id));
      return;
    }

    // ── Correção de valor do último lançamento
    if (/era\s+[\d.,]+|muda.*valor|valor.*errado|corrigi|errei.*valor|era\s+[\d]+\s+(nao|não|e\s+nao)/i.test(textoOriginal)) {
      const nums = (textoOriginal.match(/[\d]+(?:[.,]\d+)?/g) || []).map(n => parseFloat(n.replace(',','.')));
      if (nums.length > 0) {
        const novoValor = nums[nums.length - 1]; // último número mencionado = valor correto
        const ok = await editarUltimaValor(empresa.id, novoValor);
        await enviarResposta(msg, ok ? `✅ Corrigi! Valor atualizado para *R$ ${fmt(novoValor)}*.` : `⚠ Não achei nada pra corrigir.`);
        return;
      }
    }

    // ── Ativar/desativar resposta por voz
    if (/^(voz|resposta\s+por\s+voz|responder\s+por\s+voz|modo\s+voz|áudio|audio)$/i.test(textoOriginal)) {
      if (_voiceUsers.has(msg.from)) {
        _voiceUsers.delete(msg.from);
        await msg.reply('🔇 Modo voz desativado. Voltei pra texto!');
      } else {
        _voiceUsers.add(msg.from);
        await msg.reply('🔊 Modo voz ativado! Vou responder em áudio quando possível.');
      }
      return;
    }

    // 🧠 CONSULTORIA / CONSELHO DE NEGÓCIO
    if (eConsulta(textoOriginal)) {
      await msg.reply('🤔 Deixa eu analisar aqui com base nos seus dados...');
      const partes = await responderConsultoria(textoOriginal, empresa.id, empresa.nomeUsuario);
      for (const parte of partes) {
        await new Promise(r => setTimeout(r, 3000));
        await msg.reply(parte);
      }
      return;
    }

    // 💬 PERGUNTA SOBRE DADOS (quanto gastei, saldo, etc.)
    if (await ePerguntaFinanceira(textoOriginal)) {
      const partes = await responderPergunta(textoOriginal, empresa.id, empresa.nomeUsuario);
      for (const parte of partes) {
        await new Promise(r => setTimeout(r, 3000));
        await msg.reply(parte);
      }
      return;
    }

    // ── 3. Interpreta as transações com Groq
    console.log(`[WA] 🤖 Enviando para Groq: "${textoOriginal}"`);
    const transacoes = await interpretarTransacoes(textoOriginal);
    if (!transacoes || transacoes.length === 0) {
      console.log(`[WA] 💬 Groq não identificou transação — respondendo como Luminito`);
      await responderComoLuminito(textoOriginal, empresa, msg);
      return;
    }

    // ── 3b. Detecção de duplicados (mesma desc + valor nos últimos 10 min)
    const agora = Date.now();
    const recentes = _recentSaves.get(empresa.id) || [];
    const duplicado = transacoes.find(tx =>
      recentes.some(r => r.desc === tx.description && Math.abs(r.amount - tx.value) < 0.01 && agora - r.ts < 10 * 60 * 1000)
    );
    if (duplicado) {
      const fmt2 = v => Number(v).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
      await msg.reply(`⚠️ *Ei, parece duplicado!*\n\nJá registrei "${duplicado.description}" (${fmt2(duplicado.value)}) há menos de 10 minutos.\n\nEra pra registrar de novo mesmo? Responde *sim* pra confirmar ou *não* pra cancelar.`);
      _pendingConfirm.set(msg.from, { txs: transacoes, empresaId: empresa.id, phone, expira: agora + 5 * 60 * 1000 });
      return;
    }

    // ── 3c. Confirmação para valores altos (acima de R$ 2.000)
    const txAlta = transacoes.find(tx => tx.value >= 2000 && tx.category !== 'entrada');
    if (txAlta) {
      const fmt2 = v => Number(v).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
      await msg.reply(`🚨 *Valor alto detectado!*\n\n"${txAlta.description}" — *${fmt2(txAlta.value)}*\n\nConfirma o registro? Responde *sim* ou *não*.`);
      _pendingConfirm.set(msg.from, { txs: transacoes, empresaId: empresa.id, phone, expira: agora + 5 * 60 * 1000 });
      return;
    }

    // ── 4. Salva todas no Firestore
    const refs = await salvarTransacoes(transacoes, empresa.id, phone);

    // ── 5. Confirma no WhatsApp
    if (refs.length === 1) {
      const { tx, ref } = refs[0];
      let msg_ = formatConfirmacao(tx, empresa.nomeUsuario, ref.id);
      if (!tx.value || tx.value === 0) msg_ += `\n\n⚠ Valor não informado — entrei com R$ 0,00. Edita lá no app!`;
      await msg.reply(msg_);
    } else {
      await msg.reply(formatConfirmacaoMultipla(refs, empresa.nomeUsuario));
    }

    // ── 5b. Registra salvamentos recentes para detecção de duplicados
    const novosRecentes = refs.map(({tx}) => ({ desc: tx.description, amount: tx.value, ts: Date.now() }));
    _recentSaves.set(empresa.id, [...(_recentSaves.get(empresa.id) || []), ...novosRecentes].filter(r => Date.now() - r.ts < 15 * 60 * 1000));

    // ── 6. Alertas automáticos
    await verificarAlertas(refs, empresa, msg.from);

  } catch (err) {
    console.error('[WA] Erro:', err.message);
    try { await msg.reply('Algo deu errado. Tenta de novo em alguns minutos.'); } catch (_) {}
  }
} // fim processarMensagem

registrarHandlerMensagens(waClient);
waClient.initialize();

// ── Handlers globais — evitam que qualquer erro derrube o processo
process.on('uncaughtException', err => {
  console.error('[PROCESSO] ❌ Erro não capturado:', err.message);
  // Não sai do processo — apenas loga
});
process.on('unhandledRejection', (reason) => {
  console.error('[PROCESSO] ⚠  Promise rejeitada:', reason?.message || reason);
});

// ═══════════════════════════════════════════════════════════════
//  RESUMO SEMANAL AUTOMÁTICO — toda segunda-feira às 8h
// ═══════════════════════════════════════════════════════════════

// ── Auto-sync Pluggy — todo dia às 3h da manhã
cron.schedule('0 3 * * *', async () => {
  console.log('[CRON] 🏦 Auto-sync Pluggy iniciado...');
  try {
    const snap = await db.collection('companies').where('pluggyItemId', '!=', null).get();
    for (const doc of snap.docs) {
      const { pluggyItemId, name } = doc.data();
      if (!pluggyItemId) continue;
      try {
        const { novas } = await autoSyncEmpresa(doc.id, pluggyItemId, 2); // últimas 48h

        // Notifica via WhatsApp se tiver transações novas
        if (novas > 0) {
          const mapsSnap = await db.collection('whatsapp_lid_mappings')
            .where('companyId', '==', doc.id).limit(1).get();
          if (!mapsSnap.empty) {
            const { lid, phone } = mapsSnap.docs[0].data();
            const chatId = lid || `${phone}@c.us`;
            await waClient.sendMessage(chatId,
              `🏦 *Sync automático concluído!*\n\n` +
              `Importei *${novas} nova${novas > 1 ? 's transações' : ' transação'}* do seu banco direto no sistema.\n` +
              `Tudo já tá no dashboard pra você conferir! 🔥\n\n` +
              `_Sincronizado às ${new Date().toLocaleTimeString('pt-BR')}_`
            );
          }
        }
      } catch (e) {
        console.error(`[CRON AutoSync] Erro para ${name}:`, e.message);
      }
    }
  } catch (err) {
    console.error('[CRON AutoSync] Erro geral:', err.message);
  }
}, { timezone: 'America/Sao_Paulo' });

// ── Resumo semanal — toda segunda às 8h
// (pdf_auto removido: PDF só é enviado quando o usuário pede manualmente)
cron.schedule('0 8 * * 1', () => {
  dispararParaTodos('semanal');
}, { timezone: 'America/Sao_Paulo' });

// ── Lembrete de contas fixas — todo dia 1 às 9h
cron.schedule('0 9 1 * *', () => dispararParaTodos('fixas'), { timezone: 'America/Sao_Paulo' });

// ── Resumo do dia — todo dia às 20h
cron.schedule('0 20 * * *', async () => {
  console.log('[CRON] 🌙 Resumo do dia...');
  try { await enviarResumoDia(); } catch(e) { console.error('[CRON ResumoDia]', e.message); }
}, { timezone: 'America/Sao_Paulo' });

// ── Verificar lembretes — a cada hora
cron.schedule('0 * * * *', async () => {
  try { await verificarLembretesHoje(); } catch(e) { console.error('[CRON Lembretes]', e.message); }
}, { timezone: 'America/Sao_Paulo' });

// ── Resumo mensal — todo último dia do mês às 20h
cron.schedule('0 20 28-31 * *', async () => {
  const amanha = new Date(); amanha.setDate(amanha.getDate() + 1);
  if (amanha.getDate() === 1) dispararParaTodos('mensal');
}, { timezone: 'America/Sao_Paulo' });

async function dispararParaTodos(tipo) {
  console.log(`[CRON] 📢 Disparando ${tipo} para todos...`);
  try {
    const mapsSnap = await db.collection('whatsapp_lid_mappings').get();
    if (mapsSnap.empty) return;

    // Deduplica por companyId — um resumo por empresa
    const visto = new Set();
    for (const mapDoc of mapsSnap.docs) {
      const { lid, phone, companyId } = mapDoc.data();
      const chatId = lid || `${phone}@c.us`;
      try {
        const empresaDoc = await db.collection('companies').doc(companyId).get();
        if (!empresaDoc.exists) continue;
        const nome = empresaDoc.data().name || 'você';

        let msg;
        if (tipo === 'semanal')   msg = await gerarResumoSemanal(companyId, nome);
        if (tipo === 'mensal')    msg = await gerarResumoMensal(companyId, nome);
        if (tipo === 'fixas')     msg = await gerarLembreteFixas(companyId, nome);
        if (tipo === 'pdf_auto')  { await enviarPDFMes(companyId, nome, chatId); continue; }

        if (!msg) continue;
        await waClient.sendMessage(chatId, msg);
        console.log(`[CRON] ✅ ${tipo} → ${nome} (${chatId})`);
      } catch (e) {
        console.error(`[CRON] Erro ${tipo} → ${companyId}:`, e.message);
      }
    }
  } catch (err) {
    console.error('[CRON] Erro geral:', err.message);
  }
}

// ─── GERAR RESUMO SEMANAL ──────────────────────────────────────
async function gerarResumoSemanal(companyId, nome) {
  const hoje = new Date();
  const seteDias = new Date(hoje - 7 * 24 * 60 * 60 * 1000);
  const dataInicio = seteDias.toISOString().split('T')[0];

  const snap = await db.collection('transactions')
    .where('companyId', '==', companyId)
    .get();
  const docs = snap.docs.filter(d => (d.data().date || '') >= dataInicio);

  return formatarResumo(docs, nome, 'semanal', dataInicio, hoje.toISOString().split('T')[0]);
}

// ─── GERAR RESUMO MENSAL ───────────────────────────────────────
async function gerarResumoMensal(companyId, nome) {
  const hoje = new Date();
  const inicioMes = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}-01`;

  const snap = await db.collection('transactions')
    .where('companyId', '==', companyId)
    .get();
  const docs = snap.docs.filter(d => (d.data().date || '') >= inicioMes);

  return formatarResumo(docs, nome, 'mensal', inicioMes, hoje.toISOString().split('T')[0]);
}

// ─── FORMATAR RESUMO (semanal ou mensal) ──────────────────────
function formatarResumo(docs, nome, tipo, dataInicio, dataFim) {
  const fmt = v => Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const fD  = d => d?.split('-').reverse().join('/');
  const periodLabel = tipo === 'semanal' ? 'Resumo da semana' : 'Resumo do mês';

  if (!docs.length) {
    return `${periodLabel}\n\nSem lançamentos no período (${fD(dataInicio)} – ${fD(dataFim)}).`;
  }

  const txs = docs.map(d => d.data());
  const totalEntrada = txs.filter(t => t.category === 'entrada').reduce((a, t) => a + Number(t.amount || 0), 0);
  const totalSaida   = txs.filter(t => t.category !== 'entrada').reduce((a, t) => a + Number(t.amount || 0), 0);
  const saldo        = totalEntrada - totalSaida;

  const porCategoria = {};
  for (const t of txs) {
    if (t.category === 'entrada') continue;
    const cat = CATS[t.category] || t.category;
    porCategoria[cat] = (porCategoria[cat] || 0) + Number(t.amount || 0);
  }
  const catLines = Object.entries(porCategoria)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([cat, val]) => `  ${cat}  ${fmt(val)}`);

  // Comentário variado de acordo com saldo
  let comentario;
  const pct = totalEntrada > 0 ? (saldo / totalEntrada) * 100 : -100;
  if (pct >= 30)      comentario = 'Resultado bem positivo.';
  else if (pct >= 0)  comentario = 'Saldo no positivo.';
  else if (pct >= -20) comentario = 'Saiu um pouco mais do que entrou.';
  else                 comentario = 'Saídas bem acima das entradas.';

  return [
    periodLabel,
    `${fD(dataInicio)} – ${fD(dataFim)}`,
    ``,
    `Entradas  ${fmt(totalEntrada)}`,
    `Saídas    ${fmt(totalSaida)}`,
    `Saldo     ${fmt(saldo)}`,
    ``,
    catLines.length ? `Principais gastos:` : '',
    ...catLines,
    catLines.length ? `` : '',
    `${txs.length} lançamento${txs.length !== 1 ? 's' : ''} · ${comentario}`,
  ].filter(l => l !== undefined).join('\n');
}

// ─── LISTAR ÚLTIMAS TRANSAÇÕES ─────────────────────────────────
async function listarUltimas(companyId, n = 5) {
  const fmt = v => Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const snap = await db.collection('transactions')
    .where('companyId', '==', companyId)
    .get();

  if (snap.empty) return `📭 Nenhuma transação registrada ainda.`;

  const docs = snap.docs
    .map(d => d.data())
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
    .slice(0, n);

  const linhas = [`🗒 *Últimos ${docs.length} lançamentos:*\n`];
  docs.forEach(t => {
    const isIn = t.category === 'entrada';
    const emoji = isIn ? '💸' : '📤';
    const cat = CATS[t.category] || t.category;
    linhas.push(`${emoji} ${t.date?.split('-').reverse().join('/')} — ${t.description} (${cat}) — ${fmt(t.amount)}`);
  });
  return linhas.join('\n');
}

// ─── DELETAR ÚLTIMA TRANSAÇÃO ──────────────────────────────────
async function deletarUltima(companyId) {
  const snap = await db.collection('transactions')
    .where('companyId', '==', companyId)
    .get();

  if (snap.empty) return false;
  const sorted = snap.docs.sort((a, b) => {
    const ta = a.data().createdAt?.toMillis?.() || 0;
    const tb = b.data().createdAt?.toMillis?.() || 0;
    return tb - ta;
  });
  await sorted[0].ref.delete();
  return true;
}

// ─── SALVAR TRANSAÇÕES (helper compartilhado) ──────────────────
async function salvarTransacoes(transacoes, companyId, phone) {
  const refs = [];
  for (const tx of transacoes) {
    const ref = await db.collection('transactions').add({
      date:         tx.date,
      category:     tx.category,
      description:  tx.description,
      amount:       tx.value,
      companyId,
      isRecorrente: false,
      createdBy:    'whatsapp-bot',
      origem:       'whatsapp',
      whatsappFrom: phone,
      createdAt:    admin.firestore.FieldValue.serverTimestamp()
    });
    refs.push({ tx, ref });
    console.log(`[WA] 💾 Salvo: ${tx.category} | R$${tx.value} | ${tx.description}`);
  }
  return refs;
}

// ─── ALERTAS AUTOMÁTICOS ───────────────────────────────────────
async function verificarAlertas(refs, empresa, chatId) {
  const fmt = v => Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

  // Alerta: gasto único alto
  for (const { tx } of refs) {
    if (tx.category !== 'entrada' && tx.value >= ALERTA_VALOR_UNICO) {
      await waClient.sendMessage(chatId,
        `🚨 *Alerta de gasto alto!*\n\n` +
        `Registrei ${fmt(tx.value)} em "${tx.description}" — isso é um gasto acima de ${fmt(ALERTA_VALOR_UNICO)}.\n` +
        `Tá dentro do planejado? 👀`
      );
    }
  }

  // Alerta: saídas do mês já passaram das entradas
  try {
    const hoje = new Date();
    const inicioMes = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}-01`;
    const snap = await db.collection('transactions')
      .where('companyId', '==', empresa.id)
      .get();

    const txs = snap.docs.map(d => d.data()).filter(t => (t.date || '') >= inicioMes);
    const entrada = txs.filter(t => t.category === 'entrada').reduce((a, t) => a + Number(t.amount || 0), 0);
    const saida   = txs.filter(t => t.category !== 'entrada').reduce((a, t) => a + Number(t.amount || 0), 0);

    if (saida > entrada && saida > 0) {
      await waClient.sendMessage(chatId,
        `🔴 *Atenção, ${empresa.nomeUsuario}!*\n\n` +
        `Suas saídas (${fmt(saida)}) já passaram das entradas (${fmt(entrada)}) esse mês.\n` +
        `Saldo: *${fmt(entrada - saida)}* 📉\n\nBora ficar de olho! 👀`
      );
    }
  } catch (e) {
    console.error('[Alerta] Erro ao checar saldo:', e.message);
  }

  // Alerta de categoria acima da média
  try { await verificarAlertaCategoria(refs, empresa); } catch(e) { console.error('[Alerta Cat]', e.message); }

  // Alerta de saldo negativo proativo
  try { await verificarSaldoNegativo(empresa.id, empresa, chatId); } catch(e) { console.error('[Alerta Saldo]', e.message); }

  // Verificar meta atingida
  try {
    const metaDoc = await db.collection('metas').doc(empresa.id).get();
    if (metaDoc.exists) {
      const meta = metaDoc.data().valor;
      const fmt = v => Number(v).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
      const inicioMes = `${new Date().getFullYear()}-${String(new Date().getMonth()+1).padStart(2,'0')}-01`;
      const snap = await db.collection('transactions').where('companyId','==',empresa.id).get();
      const entrada = snap.docs.map(d=>d.data()).filter(t=>(t.date||'')>=inicioMes && t.category==='entrada').reduce((a,t)=>a+Number(t.amount||0),0);
      const pct = entrada / meta * 100;
      if (pct >= 100 && pct < 110) { // avisa só na primeira vez que bate
        await waClient.sendMessage(chatId, `Meta batida 🎉\n\n${empresa.nomeUsuario}, você chegou em ${fmt(entrada)} (meta era ${fmt(meta)}).`);
      } else if (pct >= 80 && pct < 85) {
        await waClient.sendMessage(chatId, `${empresa.nomeUsuario}, você já está em ${Math.round(pct)}% da meta de ${fmt(meta)}.\nFaltam ${fmt(meta-entrada)}.`);
      }
    }
  } catch(e) { console.error('[Alerta Meta]', e.message); }
}

// ─── FOTO DE NOTA FISCAL (Groq Vision) ────────────────────────
async function processarFotoNota(msg) {
  try {
    const media = await msg.downloadMedia();
    if (!media?.data) return null;

    const hoje = hojeBR();
    const res  = await groq.chat.completions.create({
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      messages: [{
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Analise essa imagem (nota fiscal, cupom ou comprovante) e extraia TODAS as transações financeiras.
Retorne SOMENTE JSON: {"transactions":[{"category":"comida|variavel|entrada|saida-fixa|funcionario","description":"texto curto","value":numero,"date":"${hoje}"}]}
Se não for uma nota/comprovante financeiro, retorne {"transactions":[]}.`
          },
          { type: 'image_url', image_url: { url: `data:${media.mimetype};base64,${media.data}` } }
        ]
      }],
      temperature: 0,
      max_tokens:  400,
      response_format: { type: 'json_object' }
    });

    const data = JSON.parse(res.choices[0].message.content);
    const lista = Array.isArray(data.transactions) ? data.transactions : [];
    return lista.filter(t => t?.description).map(t => ({
      category:    normalizarCategoria(t.category),
      description: String(t.description).trim(),
      value:       Number(t.value) || 0,
      date:        t.date || hoje
    }));
  } catch (err) {
    console.error('[Vision] Erro:', err.message);
    return null;
  }
}

// ─── PERGUNTA FINANCEIRA ───────────────────────────────────────
async function ePerguntaFinanceira(texto) {
  return /quanto\s*(gastei|recebi|entrou|saiu)|t[oó]\s*(no\s*)?(azul|vermelho)|maior\s*gasto|saldo|lucro|preju[ií]zo|comparar?|compara/i.test(texto);
}

async function responderPergunta(pergunta, companyId, nome) {
  try {
    const hoje = new Date();
    const inicioMes = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}-01`;
    const snap = await db.collection('transactions')
      .where('companyId', '==', companyId)
      .get();

    const txs    = snap.docs.map(d => d.data()).filter(t => (t.date || '') >= inicioMes);
    const resumo = JSON.stringify(txs.map(t => ({ cat: t.category, desc: t.description, val: t.amount, date: t.date })));

    const res = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        {
          role: 'system',
          content: `Você é um assistente financeiro brasileiro, direto e descolado. Dados do mês de "${nome}": ${resumo}

FORMATO OBRIGATÓRIO: responda em 1 a 3 mensagens curtas separadas por |||. Cada mensagem tem no máximo 2 frases. Sem listas, sem negrito, só texto natural com 1 emoji no máximo por mensagem.`
        },
        { role: 'user', content: pergunta }
      ],
      temperature: 0.4,
      max_tokens:  250
    });

    const raw = res.choices[0].message.content.trim();
    const partes = raw.split('|||').map(p => p.trim()).filter(p => p.length > 0);
    return partes.length > 0 ? partes : [raw];
  } catch (err) {
    console.error('[Pergunta] Erro:', err.message);
    return [`Não consegui processar isso agora. Tenta de novo em instantes.`];
  }
}

// ─── DETECÇÃO DE CONSULTA / CONSELHO DE NEGÓCIO ───────────────
function eConsulta(texto) {
  // Detecta perguntas abertas de conselho, investimento, compra, parcelamento
  return /\?/.test(texto) && (
    /parcelo?|parcelamento|presta[çc][aã]o|vezes|em\s*\d+x/i.test(texto) ||
    /compro?|comprar?|adquir|investir|investimento|vale\s*a\s*pena|compensa/i.test(texto) ||
    /devo|deveria|seria\s*bom|é\s*bom|é\s*certo|faz\s*sentido/i.test(texto) ||
    /conselho|dica|me\s*ajuda|o\s*que\s*voc[eê]\s*(acha|indica|sugere?)/i.test(texto) ||
    /consigo\s*pagar|tenho\s*como\s*pagar|cabe\s*no\s*or[çc]amento/i.test(texto) ||
    /empr[eé]stimo|financiamento|capital\s*de\s*giro|cr[eé]dito/i.test(texto) ||
    /contratar|demitir|aumentar|reduzir|cortar\s*gasto/i.test(texto) ||
    /meta|objetivo|planejamento|previs[aã]o/i.test(texto)
  );
}

// ─── CONSULTORIA FINANCEIRA INTELIGENTE (Groq + dados reais) ──
async function responderConsultoria(pergunta, companyId, nome) {
  try {
    // Busca os últimos 3 meses de transações para contexto completo
    const hoje   = new Date();
    const h3Meses = new Date(hoje);
    h3Meses.setMonth(h3Meses.getMonth() - 3);
    const dataInicio = h3Meses.toISOString().split('T')[0];

    const snap = await db.collection('transactions')
      .where('companyId', '==', companyId)
      .get();

    // Filtra em memória para não precisar de índice composto no Firestore
    const txs = snap.docs.map(d => d.data()).filter(t => t.date >= dataInicio);

    // Calcula métricas financeiras reais da empresa
    const entradas  = txs.filter(t => t.category === 'entrada').reduce((a, t) => a + Number(t.amount || 0), 0);
    const saidas    = txs.filter(t => t.category !== 'entrada').reduce((a, t) => a + Number(t.amount || 0), 0);
    const saldo     = entradas - saidas;
    const mediaMens = entradas / 3;
    const fixasTotal = txs.filter(t => t.category === 'saida-fixa').reduce((a, t) => a + Number(t.amount || 0), 0);
    const folhaTotal = txs.filter(t => t.category === 'funcionario').reduce((a, t) => a + Number(t.amount || 0), 0);
    const fmt = v => Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

    const contextoFinanceiro = `
Empresa: ${nome}
Período analisado: últimos 3 meses (${dataInicio} até hoje)
Total de Entradas: ${fmt(entradas)}
Total de Saídas:   ${fmt(saidas)}
Saldo acumulado:   ${fmt(saldo)}
Média mensal de receita: ${fmt(mediaMens)}
Total em contas fixas (3 meses): ${fmt(fixasTotal)}
Total em folha de pagamento (3 meses): ${fmt(folhaTotal)}
Número de transações registradas: ${txs.length}
`.trim();

    const res = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        {
          role: 'system',
          content: `Você é o Lumin Advisor — um consultor financeiro de pequenas empresas brasileiras. Fala como um amigo que entende de dinheiro: direto, simples, sem enrolação.

DADOS FINANCEIROS DA EMPRESA:
${contextoFinanceiro}

REGRAS OBRIGATÓRIAS DE FORMATO:
- Divida a resposta em 2 a 4 mensagens curtas separadas EXATAMENTE por |||
- Cada mensagem: máximo 2 frases curtas
- Sem bullet points, sem listas, sem negrito — só texto natural
- Use 1 emoji por mensagem no máximo
- Baseie nos dados financeiros reais acima
- Princípios: parcela saudável = até 15% da receita mensal; capital de giro = 3-6x as fixas; payback antes de investir
- Se não tiver dados suficientes, diga o que precisa saber

EXEMPLO de formato correto:
"olha, com base no que você tem aí, dá pra pensar sim 🤔|||mas o ideal é esperar mais 2 meses antes de fechar o negócio|||vai depender muito de como vão entrar as receitas nos próximos dias"`
        },
        { role: 'user', content: pergunta }
      ],
      temperature: 0.6,
      max_tokens:  350
    });

    const raw = res.choices[0].message.content.trim();
    const partes = raw.split('|||').map(p => p.trim()).filter(p => p.length > 0);
    console.log(`[Consultoria] ✅ ${partes.length} mensagens para: "${pergunta.substring(0, 50)}"`);
    return partes.length > 0 ? partes : [raw];
  } catch (err) {
    console.error('[Consultoria] Erro:', err.message);
    return [`Não consegui analisar agora. Tenta de novo em instantes.`];
  }
}

// ─── LEMBRETE DE CONTAS FIXAS ──────────────────────────────────
async function gerarLembreteFixas(companyId, nome) {
  const mesPassado = new Date();
  mesPassado.setMonth(mesPassado.getMonth() - 1);
  const inicio = `${mesPassado.getFullYear()}-${String(mesPassado.getMonth() + 1).padStart(2, '0')}-01`;
  const fim    = `${mesPassado.getFullYear()}-${String(mesPassado.getMonth() + 1).padStart(2, '0')}-31`;

  const snap = await db.collection('transactions')
    .where('companyId', '==', companyId)
    .where('category', '==', 'saida-fixa')
    .where('date', '>=', inicio)
    .where('date', '<=', fim)
    .get();

  if (snap.empty) return null;

  const fmt  = v => Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const txs  = snap.docs.map(d => d.data());
  const linhas = txs.map(t => `  • ${t.description}: ${fmt(t.amount)}`).join('\n');
  const total  = txs.reduce((a, t) => a + Number(t.amount || 0), 0);

  return [
    `📅 *Ei, ${nome}! Começo de mês chegou!*\n`,
    `Mês passado você teve essas contas fixas. Lembra de registrar quando pagar:`,
    ``,
    linhas,
    ``,
    `💰 Total fixo previsto: *${fmt(total)}*`,
    ``,
    `Bora manter o controle! 💪`
  ].join('\n');
}

// ─── EXPORTAR PDF DO MÊS ───────────────────────────────────────
async function enviarPDFMes(companyId, nomeEmpresa, chatId) {
  try {
    const hoje    = new Date();
    const ano     = hoje.getFullYear();
    const mes     = hoje.getMonth() + 1;
    const nomeMes = ['Janeiro','Fevereiro','Marco','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'][mes - 1];
    const inicio  = `${ano}-${String(mes).padStart(2, '0')}-01`;

    const snap = await db.collection('transactions')
      .where('companyId', '==', companyId)
      .get();

    const txs = snap.docs.map(d => d.data())
      .filter(t => (t.date || '') >= inicio)
      .sort((a, b) => (b.date || '').localeCompare(a.date || '')); // mais recentes primeiro

    // Remove acentos — fontes embutidas do pdfkit não precisam, mas garante consistência
    const N  = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x00-\xFF]/g, '?');
    const fmt = v => `R$ ${Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;
    const fmtN = v => Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
    const fD  = d => d?.split('-').reverse().join('/') || '';

    if (txs.length === 0) {
      await waClient.sendMessage(chatId, `Nenhum lancamento encontrado em ${nomeMes} ${ano}, ${N(nomeEmpresa)}. Registra suas entradas e saidas primeiro!`);
      return;
    }

    const totalEntrada = txs.filter(t => t.category === 'entrada').reduce((a, t) => a + Number(t.amount || 0), 0);
    const totalSaida   = txs.filter(t => t.category !== 'entrada').reduce((a, t) => a + Number(t.amount || 0), 0);
    const saldo        = totalEntrada - totalSaida;

    // ── Dimensões (pontos — 1mm = 2.8346pt)
    const mm  = v => v * 2.8346;
    const W   = 595.28;
    const H   = 841.89;
    const today = hoje.toLocaleDateString('pt-BR');

    // ── Colunas da tabela
    const TX    = mm(14);                        // x inicial da tabela
    const TW    = W - 2 * mm(14);               // largura total
    const C0    = mm(24);                        // Data
    const C2    = mm(36);                        // Categoria
    const C3    = mm(32);                        // Valor
    const C1    = TW - C0 - C2 - C3;            // Descricao (auto)
    const RH    = mm(9);                         // altura de cada linha
    const THEAD = mm(119);                       // y onde começa a tabela (primeira página)

    const tmpPath = path.join(__dirname, `relatorio_${companyId}_${ano}${mes}.pdf`);
    const doc     = new PDFDocument({ margin: 0, size: 'A4' });
    const stream  = fs.createWriteStream(tmpPath);
    doc.pipe(stream);

    // ── Helpers de desenho
    function drawPageBackground() {
      doc.rect(0, 0, W, H).fill('#050d12');
    }

    function drawHeader() {
      // Barra azul do topo
      doc.rect(0, 0, W, mm(42)).fill('#00648c');
      // Logo LUMIN
      doc.font('Helvetica-Bold').fontSize(26).fillColor('#ffffff')
         .text('LUMIN', mm(14), mm(10), { lineBreak: false });
      // Subtitulo
      doc.font('Helvetica').fontSize(9.5).fillColor('#b4e6ff')
         .text(`Relatorio Financeiro - Mes Atual - ${N(nomeEmpresa)}`, mm(14), mm(24), { lineBreak: false });
      doc.font('Helvetica').fontSize(9.5).fillColor('#b4e6ff')
         .text(`Gerado em ${today}`, W - mm(14), mm(24), { align: 'right', lineBreak: false, width: mm(80) });

      // Cards de resumo
      const cards = [
        { x: mm(14),  label: 'Total Entradas', val: 'R$ ' + fmtN(totalEntrada), bg: '#ebfcf5', tc: '#007846' },
        { x: mm(80),  label: 'Total Saidas',   val: 'R$ ' + fmtN(totalSaida),   bg: '#ffebee', tc: '#a01e28' },
        { x: mm(146), label: 'Saldo Liquido',  val: 'R$ ' + fmtN(saldo),        bg: saldo >= 0 ? '#ebfcf5' : '#ffebee', tc: saldo >= 0 ? '#007846' : '#a01e28' },
      ];
      for (const c of cards) {
        doc.roundedRect(c.x, mm(48), mm(56), mm(22), 4).fill(c.bg);
        doc.font('Helvetica').fontSize(7.5).fillColor('#505050')
           .text(c.label, c.x + 4, mm(51), { lineBreak: false });
        doc.font('Helvetica-Bold').fontSize(11).fillColor(c.tc)
           .text(c.val, c.x + 4, mm(57), { lineBreak: false });
      }
    }

    function drawTableHeader(y) {
      doc.rect(TX, y, TW, RH).fill('#00648c');
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#ffffff');
      const ty = y + (RH - 8.5) / 2;
      doc.text('Data',      TX,              ty, { width: C0,      lineBreak: false });
      doc.text('Descricao', TX + C0,         ty, { width: C1 - 4,  lineBreak: false });
      doc.text('Categoria', TX + C0 + C1,    ty, { width: C2,      lineBreak: false });
      doc.text('Valor',     TX + C0+C1+C2,   ty, { width: C3 - 4,  align: 'right', lineBreak: false });
    }

    function drawRow(t, i, y) {
      const isIn   = t.category === 'entrada';
      const bg     = i % 2 === 0 ? '#ffffff' : '#f6fafd';
      const valClr = isIn ? '#007846' : '#a01e28';
      const cat    = N(CATS[t.category] || t.category);
      const desc   = N(t.description || '-');
      const val    = (isIn ? '+ ' : '- ') + 'R$ ' + fmtN(t.amount);

      doc.rect(TX, y, TW, RH).fill(bg);
      const ty = y + (RH - 9) / 2;
      doc.font('Helvetica').fontSize(8.5).fillColor('#1a1a1a');
      doc.text(fD(t.date),  TX,            ty, { width: C0,      lineBreak: false });
      doc.text(desc,        TX + C0,       ty, { width: C1 - 4,  lineBreak: false });
      doc.text(cat,         TX + C0 + C1,  ty, { width: C2,      lineBreak: false });
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(valClr)
         .text(val,         TX+C0+C1+C2,   ty, { width: C3 - 4,  align: 'right', lineBreak: false });
    }

    function drawFooterRow(label, val, y) {
      doc.rect(TX, y, TW, RH).fill('#f0f8ff');
      const ty = y + (RH - 9) / 2;
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#005078');
      doc.text('', TX, ty, { width: C0, lineBreak: false });
      doc.text('', TX + C0, ty, { width: C1 - 4, lineBreak: false });
      doc.text(label, TX + C0 + C1,  ty, { width: C2,     lineBreak: false });
      doc.text(val,   TX+C0+C1+C2,   ty, { width: C3 - 4, align: 'right', lineBreak: false });
    }

    function drawPageFooter() {
      doc.moveTo(mm(14), H - mm(12)).lineTo(W - mm(14), H - mm(12))
         .strokeColor('#00648c').lineWidth(0.7).stroke();
      doc.font('Helvetica').fontSize(8).fillColor('#505050')
         .text(`Lumin - ${N(nomeEmpresa)}`, mm(14), H - mm(9), { lineBreak: false });
      doc.text(today, W - mm(14), H - mm(9), { align: 'right', lineBreak: false, width: mm(80) });
    }

    // ── Renderiza primeira página
    drawPageBackground();
    drawHeader();

    let y = THEAD;
    drawTableHeader(y);
    y += RH;

    // ── Linhas de dados
    for (let i = 0; i < txs.length; i++) {
      // Nova página se não couber + footer (30pt) + 3 linhas de totais
      if (y + RH > H - mm(30) - RH * 3) {
        drawPageFooter();
        doc.addPage();
        drawPageBackground();
        y = mm(20);
        drawTableHeader(y);
        y += RH;
      }
      drawRow(txs[i], i, y);
      y += RH;
    }

    // ── Linhas de totais
    const footerRows = [
      { label: 'Entradas', val: 'R$ ' + fmtN(totalEntrada) },
      { label: 'Saidas',   val: 'R$ ' + fmtN(totalSaida)   },
      { label: 'Saldo',    val: 'R$ ' + fmtN(saldo)         },
    ];
    for (const fr of footerRows) {
      if (y + RH > H - mm(30)) {
        drawPageFooter();
        doc.addPage();
        drawPageBackground();
        y = mm(20);
      }
      drawFooterRow(fr.label, fr.val, y);
      y += RH;
    }

    drawPageFooter();
    doc.end();

    await new Promise(resolve => stream.on('finish', resolve));

    // ── Envia via WhatsApp
    const media = MessageMedia.fromFilePath(tmpPath);
    await waClient.sendMessage(chatId, media, {
      caption: `📊 *Relatorio de ${nomeMes} ${ano}* — ${N(nomeEmpresa)}\n${txs.length} lancamentos · Saldo: ${fmt(saldo)}`
    });

    try { fs.unlinkSync(tmpPath); } catch (_) {}
    console.log(`[PDF] ✅ Enviado para ${chatId}`);
  } catch (err) {
    console.error('[PDF] Erro:', err.message);
    await waClient.sendMessage(chatId, `Nao consegui gerar o PDF agora. Tenta de novo em alguns minutos.`);
  }
}

// ─── VERIFICAÇÃO DE LID — vincula LID a um número de telefone ─
async function tentarVerificacaoLid(msg, lidId) {
  const texto  = (msg.body || '').trim();
  const digits = texto.replace(/\D/g, '');

  // Se a mensagem é um número de telefone válido (12 ou 13 dígitos: DDI+DDD+8/9)
  if (digits.length >= 12 && digits.length <= 13) {
    const empresa = await buscarEmpresaPorTelefone(digits);
    if (empresa) {
      await db.collection('whatsapp_lid_mappings').doc(lidId).set({
        lid:          lidId,
        phone:        digits,
        companyId:    empresa.id,
        verifiedAt:   admin.firestore.FieldValue.serverTimestamp()
      });
      console.log(`[WA] ✓ LID ${lidId} vinculado a ${digits} (${empresa.nomeUsuario})`);

      await msg.reply(
        `Olá, ${empresa.nomeUsuario}. Conta verificada.\n\n` +
        `Pode mandar seus lançamentos por texto ou áudio. Exemplos:\n` +
        `• Entrada 500 cliente João\n` +
        `• Aluguel 1200\n` +
        `• Almoço 45\n\n` +
        `Digite *ajuda* pra ver tudo que dá pra fazer.`
      );
      // Retorna null para que o handler principal NÃO tente processar
      // o número de telefone como uma transação financeira
      return null;
    } else {
      await msg.reply(
        `O número *${digits}* não está cadastrado.\n\n` +
        `Peça pro admin do Lumin te adicionar primeiro.`
      );
      return null;
    }
  }

  // Mensagem não é um telefone — pede o cadastro
  console.log(`[WA] 🆕 LID ${lidId} ainda não vinculado — solicitando número`);
  await msg.reply(
    `👋 *E aí! Bem-vindo ao Lumin Bot!*\n\n` +
    `Pra eu te reconhecer aqui, manda seu *número de telefone* pra mim:\n\n` +
    `\`5511999990001\`\n` +
    `_(DDI 55 + DDD + número, sem espaço ou traço)_\n\n` +
    `Esse número precisa estar cadastrado no sistema pelo admin. Rapidinho! ⚡`
  );
  return null;
}

// ─── BUSCAR EMPRESA POR TELEFONE (suporta phone único ou array phones[]) ─
// Retorna a data de HOJE no fuso de Brasília (UTC-3) no formato YYYY-MM-DD
// (evita bug onde Fly.io em UTC salva lançamentos da noite com data de amanhã)
function hojeBR() {
  const d = new Date();
  // Converte pra UTC-3 manualmente
  const utcTime = d.getTime() + (d.getTimezoneOffset() * 60000);
  const brTime  = new Date(utcTime - 3 * 60 * 60 * 1000);
  const y  = brTime.getFullYear();
  const m  = String(brTime.getMonth() + 1).padStart(2, '0');
  const dd = String(brTime.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

// Normaliza telefone para comparação: só dígitos, sem 55 inicial, sem 9 mobile
function normalizePhone(p) {
  if (!p) return '';
  let digits = String(p).replace(/\D/g, '');
  // Remove código do país 55 se estiver
  if (digits.length >= 12 && digits.startsWith('55')) digits = digits.slice(2);
  // Remove 9 mobile inicial dos celulares brasileiros (DDD + 9 + 8 dígitos = 11 chars)
  if (digits.length === 11 && digits[2] === '9') digits = digits.slice(0,2) + digits.slice(3);
  return digits; // ex: 11984661175 → "11984661175" → após normalizar → "1184661175"
}

// Retorna o nome do usuário (pessoa), não da empresa
// Prioridade: campo ownerName no Firebase > extração automática do nome da empresa
function getNomeUsuario(empresa) {
  if (empresa.ownerName?.trim()) return empresa.ownerName.trim();

  // Tenta extrair o nome da pessoa do nome da empresa
  // Ex: "Eco Mix Wallace" → "Wallace", "Pessoal Andre" → "Andre", "Pessoal Financeiro Luid" → "Luid"
  const palavrasIgnoradas = new Set([
    'pessoal','financeiro','financeira','controle','negocio','negócios',
    'empresa','comercial','eco','mix','ltda','me','epp','eireli','sa','s/a'
  ]);
  const partes = (empresa.nome || '').split(/\s+/).filter(p => {
    const lower = p.toLowerCase().replace(/[^a-záéíóúãõâêîôûàç]/gi,'');
    return lower.length >= 3 && !palavrasIgnoradas.has(lower) && /^[A-ZÁÉÍÓÚÃÕÂÊÎÔÛ]/u.test(p);
  });
  if (partes.length > 0) return partes[partes.length - 1]; // última palavra que parece nome
  return empresa.nome; // fallback: nome da empresa completo
}

// Gera todas variações possíveis do número pra match
function phoneVariations(phone) {
  const raw = String(phone || '').replace(/\D/g, '');
  if (!raw) return [];
  const norm = normalizePhone(raw);
  const set = new Set();
  set.add(raw);                      // como veio
  if (norm) set.add(norm);           // sem 55 e sem 9
  if (norm) set.add('55' + norm);    // 55 + sem 9
  if (norm && norm.length === 10) {  // adiciona 9 mobile
    const com9 = norm.slice(0,2) + '9' + norm.slice(2);
    set.add(com9);
    set.add('55' + com9);
  }
  // Variação com 55 mas sem 9 mobile
  if (raw.length >= 12 && raw.startsWith('55')) {
    set.add(raw.slice(2));
  }
  return Array.from(set);
}

async function buscarEmpresaPorTelefone(phone) {
  const variations = phoneVariations(phone);
  console.log(`[WA] 🔍 Buscando empresa por telefone — variações:`, variations);

  // 1) Tenta match exato em qualquer variação no campo 'phone'
  for (const v of variations) {
    const snap = await db.collection('companies').where('phone', '==', v).limit(1).get();
    if (!snap.empty) {
      const doc = snap.docs[0];
      console.log(`[WA] ✓ Match em companies.phone="${v}" → ${doc.data().name}`);
      return { id: doc.id, nome: doc.data().name, ...doc.data() };
    }
  }

  // 2) Match em phones[] (multi-usuário)
  for (const v of variations) {
    const snap = await db.collection('companies').where('phones', 'array-contains', v).limit(1).get();
    if (!snap.empty) {
      const doc = snap.docs[0];
      console.log(`[WA] ✓ Match em companies.phones[]="${v}" → ${doc.data().name}`);
      return { id: doc.id, nome: doc.data().name, ...doc.data() };
    }
  }

  // 3) Mapping LID reverso (qualquer variação do phone)
  for (const v of variations) {
    const lidSnap = await db.collection('whatsapp_lid_mappings').where('phone', '==', v).limit(1).get();
    if (!lidSnap.empty) {
      const { companyId } = lidSnap.docs[0].data();
      const compDoc = await db.collection('companies').doc(companyId).get();
      if (compDoc.exists) {
        console.log(`[WA] ✓ Match via LID mapping(${v}) → ${compDoc.data().name}`);
        return { id: compDoc.id, nome: compDoc.data().name, ...compDoc.data() };
      }
    }
  }

  // 4) Última tentativa: varre TODAS as empresas e compara normalizado
  // (proteção contra phone salvo com formato estranho — espaços, parênteses, etc.)
  const all = await db.collection('companies').get();
  const target = normalizePhone(phone);
  for (const doc of all.docs) {
    const data = doc.data();
    const candidatos = [data.phone, ...(data.phones || [])].filter(Boolean);
    for (const c of candidatos) {
      if (normalizePhone(c) === target && target) {
        console.log(`[WA] ✓ Match por normalização "${c}"→"${target}" → ${data.name}`);
        return { id: doc.id, nome: data.name, ...data };
      }
    }
  }

  console.log(`[WA] ❌ Nenhuma empresa encontrada para telefone ${phone}`);
  return null;
}

// ─── LUMINITO — CONVERSA NATURAL ──────────────────────────────
async function responderComoLuminito(texto, empresa, msg) {
  try {
    const chatId = msg.from;

    // Detecta pedido de PDF mesmo em linguagem natural — garante envio do arquivo
    if (
      /\b(export[ae]r?|gerar?|mand[ae]r?|quero|preciso|me\s*mand[ae])\b.{0,40}\b(pdf|relat[oó]rio|gastos?|lançamentos?|financeiro)\b/i.test(texto) ||
      /\b(pdf|relat[oó]rio)\b.{0,30}\b(m[eê]s|mensal|gastos?|export)/i.test(texto) ||
      /\b(pdf)\b/i.test(texto)
    ) {
      await msg.reply('⏳ Gerando o PDF do mês... já já tô mandando!');
      await enviarPDFMes(empresa.id, empresa.nomeUsuario, msg.from);
      return;
    }

    // Busca resumo financeiro rápido do mês pra dar contexto ao Luminito
    let contextoFinanceiro = '';
    try {
      const hoje = new Date();
      const inicioMes = `${hoje.getFullYear()}-${String(hoje.getMonth()+1).padStart(2,'0')}-01`;
      const snap = await db.collection('transactions').where('companyId','==',empresa.id).get();
      const txs = snap.docs.map(d => d.data()).filter(t => (t.date||'') >= inicioMes);
      const entrada = txs.filter(t => t.category==='entrada').reduce((a,t)=>a+Number(t.amount||0),0);
      const saida   = txs.filter(t => t.category!=='entrada').reduce((a,t)=>a+Number(t.amount||0),0);
      const fmt = v => Number(v).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
      contextoFinanceiro = `Dados financeiros de ${empresa.nomeUsuario} este mês: entradas ${fmt(entrada)}, saídas ${fmt(saida)}, saldo ${fmt(entrada-saida)}.`;
    } catch(_) {}

    // Histórico de conversa (últimas 10 mensagens)
    const historico = _conversaHistory.get(chatId) || [];

    const messages = [
      {
        role: 'system',
        content: `Você é o Luminito, assistente financeiro pessoal descolado e inteligente do WhatsApp.
Você está conversando com ${empresa.nomeUsuario}.
${contextoFinanceiro}

Sua personalidade:
- Descolado, direto, natural — fala como um amigo que entende de finanças
- Respostas curtas e objetivas (máximo 3-4 linhas)
- Usa emoji com moderação, só quando faz sentido
- Pode falar sobre qualquer assunto, não só finanças
- Quando o assunto for financeiro, usa os dados reais do usuário
- Nunca fala que é uma IA ou que tem limitações — só responde naturalmente
- Para registrar uma transação, o usuário deve mandar algo como "paguei 50 de almoço" ou "recebi 1000"
- Se alguém perguntar o que você faz, explica de forma descolada que ajuda a controlar as finanças pelo WhatsApp`
      },
      ...historico,
      { role: 'user', content: texto }
    ];

    const res = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages,
      temperature: 0.8,
      max_tokens: 300
    });

    const resposta = res.choices[0].message.content.trim();

    // Atualiza histórico (mantém últimas 10 mensagens = 5 trocas)
    historico.push({ role: 'user', content: texto });
    historico.push({ role: 'assistant', content: resposta });
    if (historico.length > 10) historico.splice(0, historico.length - 10);
    _conversaHistory.set(chatId, historico);

    await enviarResposta(msg, resposta);
    console.log(`[Luminito] 💬 Respondeu: "${resposta.slice(0,60)}..."`);
  } catch(err) {
    console.error('[Luminito] Erro:', err.message);
    await msg.reply('Eita, travei aqui por um segundo. Manda de novo!');
  }
}

// ─── TRANSCRIÇÃO DE ÁUDIO (Groq Whisper) ──────────────────────
async function transcreverAudio(msg) {
  const tmpPath = path.join(__dirname, `tmp_audio_${Date.now()}.ogg`);
  try {
    const media = await msg.downloadMedia();
    if (!media?.data) {
      console.error('[Whisper] downloadMedia retornou vazio — sem dados de mídia');
      return null;
    }

    const ext = media.mimetype?.includes('ogg') ? 'ogg' : 'mp4';
    const finalPath = tmpPath.replace('.ogg', `.${ext}`);
    fs.writeFileSync(finalPath, Buffer.from(media.data, 'base64'));

    const response = await groq.audio.transcriptions.create({
      file:            fs.createReadStream(finalPath),
      model:           'whisper-large-v3',
      language:        'pt',
      response_format: 'text'
    });

    try { fs.unlinkSync(finalPath); } catch (_) {}
    const texto = String(response).trim();
    if (!texto) { console.error('[Whisper] Transcrição retornou vazia'); return null; }
    return texto;
  } catch (err) {
    console.error('[Whisper] Erro:', err.message);
    try { fs.unlinkSync(tmpPath); } catch (_) {}
    return null;
  }
}

// ─── CATEGORIAS VÁLIDAS ────────────────────────────────────────
const CATS_VALIDAS = new Set(['entrada', 'saida-fixa', 'funcionario', 'comida', 'variavel']);

function normalizarCategoria(cat) {
  if (!cat) return 'variavel';
  const c = String(cat).toLowerCase().trim();
  if (CATS_VALIDAS.has(c)) return c;
  // Mapeamento de variações comuns que o Groq pode retornar
  if (/entrada|receita|receb|pix.*rec|depósit/i.test(c))       return 'entrada';
  if (/aluguel|fixa|água|luz|internet|telefon|assinatur/i.test(c)) return 'saida-fixa';
  if (/funcio|salário|salario|folha|empregad/i.test(c))         return 'funcionario';
  if (/comida|aliment|restaur|mercado|delivery|padaria/i.test(c)) return 'comida';
  return 'variavel'; // fallback: tudo que não encaixar vai em despesa variável
}

// ─── INTERPRETAR TRANSAÇÕES COM GROQ (suporta múltiplas) ──────
async function interpretarTransacoes(texto) {
  const hoje = hojeBR();

  const prompt = `
Você é um assistente financeiro brasileiro. Analise o texto e extraia TODAS as transações financeiras mencionadas.
Retorne APENAS um JSON válido, sem explicações.

CATEGORIAS (use exatamente estas strings):
- "entrada"     → Receita, depósito, pagamento recebido, Pix recebido, entrada de dinheiro
- "saida-fixa"  → Aluguel, conta fixa (água, luz, internet, telefone), assinatura mensal
- "funcionario" → Salário, pagamento de funcionário, folha de pagamento
- "comida"      → Supermercado, restaurante, delivery, padaria, alimentação
- "variavel"    → Outros: combustível, farmácia, compras, transferência enviada, saques, poupança, caixinha

FORMATO DE RETORNO (sempre um objeto com array "transactions"):
{
  "transactions": [
    {
      "category":    string (uma das categorias acima — obrigatório),
      "description": string (descrição curta e clara em português),
      "value":       number (valor positivo — use 0 se não mencionado),
      "date":        string (YYYY-MM-DD — use ${hoje} se não mencionado)
    }
  ]
}

REGRAS:
1. Se o texto tiver VÁRIAS transações, retorne TODAS no array.
2. Se não houver NENHUMA transação financeira (só conversa), retorne {"transactions":[]}.
3. Se tiver valor mas categoria ambígua, escolha a mais próxima ou use "variavel".
4. "caixinha", "poupança", "guardar dinheiro" → category: "variavel", description: "Caixinha/Poupança".
5. Nunca omita uma transação que foi claramente mencionada.

EXEMPLOS:
"gastei 300 no almoço, recebi 1000 do cliente, paguei funcionário 500 e juntei 200 na caixinha"
→ {"transactions":[
  {"category":"comida","description":"Almoço","value":300,"date":"${hoje}"},
  {"category":"entrada","description":"Recebimento cliente","value":1000,"date":"${hoje}"},
  {"category":"funcionario","description":"Pagamento funcionário","value":500,"date":"${hoje}"},
  {"category":"variavel","description":"Caixinha","value":200,"date":"${hoje}"}
]}

"paguei aluguel 1200" → {"transactions":[{"category":"saida-fixa","description":"Aluguel","value":1200,"date":"${hoje}"}]}
"oi tudo bem" → {"transactions":[]}
`.trim();

  try {
    const res = await groq.chat.completions.create({
      model:       'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: prompt },
        { role: 'user',   content: `Texto: "${texto}"` }
      ],
      temperature:     0,
      max_tokens:      800,
      response_format: { type: 'json_object' }
    });

    const data = JSON.parse(res.choices[0].message.content);
    const lista = Array.isArray(data.transactions) ? data.transactions : [];

    return lista
      .filter(t => t && t.description)
      .map(t => ({
        category:    normalizarCategoria(t.category),
        description: String(t.description).trim(),
        value:       Number(t.value) || 0,
        date:        t.date || hoje
      }));
  } catch (err) {
    console.error('[Groq] Erro ao interpretar:', err.message);
    return null;
  }
}

// ─── FORMATAR CONFIRMAÇÃO ──────────────────────────────────────
function formatConfirmacao(tx, nomeEmpresa, docId) {
  const catLabel  = CATS[tx.category] || tx.category;
  const isEntrada = tx.category === 'entrada';
  const valorFmt  = Number(tx.value).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const dataFmt   = tx.date?.split('-').reverse().join('/');
  const emoji     = isEntrada ? '💸' : '📤';
  const intro     = isEntrada
    ? `${emoji} *Chegou dinheiro, ${nomeEmpresa}!* Anotei aqui:`
    : `${emoji} *Saída registrada, ${nomeEmpresa}!* Tá no sistema:`;

  return [
    intro,
    ``,
    `📋 Categoria: *${catLabel}*`,
    `📝 Descrição: *${tx.description}*`,
    `💰 Valor: *${valorFmt}*`,
    `📅 Data: *${dataFmt}*`,
    ``,
    `_ID: ${docId}_`
  ].join('\n');
}

function formatConfirmacaoMultipla(refs, nomeEmpresa) {
  const fmt = v => Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const total = refs.length;
  let linhas = [`🔥 *${total} transações registradas, ${nomeEmpresa}!*\n`];

  refs.forEach(({ tx }, i) => {
    const catLabel  = CATS[tx.category] || tx.category;
    const isEntrada = tx.category === 'entrada';
    const emoji     = isEntrada ? '💸' : '📤';
    const valorStr  = tx.value ? fmt(tx.value) : '_(sem valor)_';
    const semValor  = !tx.value ? ' ⚠' : '';
    linhas.push(`${emoji} *${catLabel}* — ${tx.description} — ${valorStr}${semValor}`);
  });

  const semValor = refs.some(({ tx }) => !tx.value);
  if (semValor) linhas.push(`\n⚠ Itens marcados com ⚠ estão com R$ 0,00 — edita lá no app!`);

  return linhas.join('\n');
}

function formatAjuda(nome) {
  const saudacao = nome ? `E aí, ${nome}! ` : `E aí! `;
  return [
    `🤖 *${saudacao}Sou o Lumin Bot!*`,
    ``,
    `📝 *Registrar transação* — manda texto ou áudio:`,
    `_"Recebi 500 do cliente João"_`,
    `_"Paguei aluguel 1200"_`,
    `_"Salário da Maria 2000"_`,
    `_"Almoço 45, gasolina 150, recebi Pix 800"_`,
    ``,
    `📊 *Comandos rápidos:*`,
    `• *resumo* → últimos 7 dias`,
    `• *mês* → resumo do mês atual`,
    `• *ultimos* → últimos 5 lançamentos`,
    `• *cancela* → desfaz o último lançamento`,
    `• *exportar* → PDF do mês`,
    `• *projeção* → como vai fechar o mês`,
    ``,
    `🎯 *Metas:*`,
    `• *meta 10000* → define meta de faturamento`,
    `• *minha meta* → ver progresso da meta`,
    ``,
    `⏰ *Lembretes:*`,
    `• "me lembra de pagar o aluguel dia 5"`,
    `• *lembretes* → ver seus lembretes ativos`,
    ``,
    `🔍 *Busca:*`,
    `• "quanto gastei com gasolina"`,
    `• "total de comida esse mês"`,
    ``,
    `🔊 *Extras:*`,
    `• *voz* → ativar/desativar resposta em áudio`,
    `• "era 350 não 500" → corrigir último valor`,
    ``,
    `🧠 *Consultoria* — manda qualquer dúvida com "?":`,
    `_"Devo comprar um equipamento de R$ 10 mil?"_`,
    `_"Consigo parcelar em 12x?"_`,
    ``,
    `💡 Texto, áudio ou foto de nota fiscal — pode mandar tudo!`,
    ``,
    `Manda bala! 🚀`
  ].join('\n');
}

// ─── ENVIAR RESPOSTA (texto ou áudio, dependendo da preferência) ─
// Wrapper resiliente: tenta múltiplos métodos com timeout e logging detalhado
async function responder(msg, conteudo, options) {
  const trySend = async (descricao, fn) => {
    try {
      console.log(`[WA] 📤 Enviando via ${descricao}...`);
      const result = await Promise.race([
        fn(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout 15s')), 15000))
      ]);
      console.log(`[WA] ✅ Enviado com sucesso via ${descricao}`);
      return result;
    } catch (err) {
      console.error(`[WA] ❌ ${descricao} falhou: ${err.message}`);
      return null;
    }
  };

  // 1. Tenta via chat.sendMessage (mais confiável para @lid)
  const chat = await msg.getChat().catch(e => { console.error(`[WA] ❌ getChat falhou: ${e.message}`); return null; });
  if (chat) {
    const r = await trySend('chat.sendMessage', () => chat.sendMessage(conteudo, options));
    if (r) return r;
  }

  // 2. Tenta via client.sendMessage com msg.from
  const r2 = await trySend(`client.sendMessage(${msg.from})`, () => waClient.sendMessage(msg.from, conteudo, options));
  if (r2) return r2;

  console.error(`[WA] ❌ TODOS os métodos de envio falharam para ${msg.from}`);
}

async function enviarResposta(msg, texto) {
  if (_voiceUsers.has(msg.from)) {
    try {
      const tmpMp3 = path.join(__dirname, `tts_${Date.now()}.mp3`);
      const tmpOgg = path.join(__dirname, `tts_${Date.now()}.ogg`);
      await new Promise((res, rej) => gTTS.save(tmpMp3, texto.replace(/[*_~`]/g, ''), err => err ? rej(err) : res()));
      await new Promise((res, rej) => execFile(ffmpegPath, ['-y','-i',tmpMp3,'-c:a','libopus','-b:a','32k',tmpOgg], err => err ? rej(err) : res()));
      const media = MessageMedia.fromFilePath(tmpOgg);
      media.mimetype = 'audio/ogg; codecs=opus';
      await responder(msg, media, { sendAudioAsVoice: true });
      try { fs.unlinkSync(tmpMp3); fs.unlinkSync(tmpOgg); } catch(_) {}
      return;
    } catch(e) {
      console.error('[TTS] Erro:', e.message);
      // fallback para texto se der erro
    }
  }
  await responder(msg, texto);
}

// ─── PROJEÇÃO DO MÊS ──────────────────────────────────────────
async function gerarProjecaoMes(companyId, nome) {
  const hoje = new Date();
  const diaAtual = hoje.getDate();
  const diasNoMes = new Date(hoje.getFullYear(), hoje.getMonth() + 1, 0).getDate();
  const inicioMes = `${hoje.getFullYear()}-${String(hoje.getMonth()+1).padStart(2,'0')}-01`;
  const fmt = v => Number(v).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});

  const snap = await db.collection('transactions').where('companyId','==',companyId).get();
  const txs  = snap.docs.map(d=>d.data()).filter(t=>(t.date||'')>=inicioMes);

  const entrada = txs.filter(t=>t.category==='entrada').reduce((a,t)=>a+Number(t.amount||0),0);
  const saida   = txs.filter(t=>t.category!=='entrada').reduce((a,t)=>a+Number(t.amount||0),0);

  if (!entrada && !saida) return `📈 Ainda sem lançamentos esse mês pra eu projetar, ${nome}. Registra uns gastos pra eu calcular!`;

  const fator = diasNoMes / diaAtual;
  const entradaP = entrada * fator;
  const saidaP   = saida   * fator;
  const saldoP   = entradaP - saidaP;

  return [
    `📈 *Projeção de ${MONTHS_BR[hoje.getMonth()]} — ${nome}*`,
    `_Dia ${diaAtual} de ${diasNoMes}_\n`,
    `Até agora: 💸 ${fmt(entrada)} entradas / 📤 ${fmt(saida)} saídas`,
    `\nSe continuar nesse ritmo:`,
    `💸 Entradas projetadas: *${fmt(entradaP)}*`,
    `📤 Saídas projetadas: *${fmt(saidaP)}*`,
    `${saldoP>=0?'✅':'🔴'} Saldo projetado: *${fmt(saldoP)}*`,
    `\n${saldoP>=0 ? `Caminhando pro positivo! 💪` : `Atenção — no ritmo atual o mês fecha no vermelho. Bora segurar os gastos! 👀`}`
  ].join('\n');
}

// ─── METAS FINANCEIRAS ─────────────────────────────────────────
async function definirMeta(companyId, valor, nome, chatId) {
  const fmt = v => Number(v).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
  await db.collection('metas').doc(companyId).set({ valor, companyId, chatId, atualizadaEm: admin.firestore.FieldValue.serverTimestamp() });
  await waClient.sendMessage(chatId, `Meta de ${fmt(valor)} definida para ${MONTHS_BR[new Date().getMonth()]}.\n\nVou te avisar quando estiver chegando.`);
}

async function verMeta(companyId, nome) {
  const fmt = v => Number(v).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
  const metaDoc = await db.collection('metas').doc(companyId).get();
  if (!metaDoc.exists) return `Nenhuma meta definida ainda.\n\nPra definir: digite "meta 10000" (substituindo pelo valor).`;

  const meta = metaDoc.data().valor;
  const inicioMes = `${new Date().getFullYear()}-${String(new Date().getMonth()+1).padStart(2,'0')}-01`;
  const snap = await db.collection('transactions').where('companyId','==',companyId).get();
  const entrada = snap.docs.map(d=>d.data()).filter(t=>(t.date||'')>=inicioMes && t.category==='entrada').reduce((a,t)=>a+Number(t.amount||0),0);

  const pct = Math.min(100, Math.round(entrada / meta * 100));
  const bar = '█'.repeat(Math.round(pct/10)) + '░'.repeat(10 - Math.round(pct/10));

  return [
    `🎯 *Meta de ${MONTHS_BR[new Date().getMonth()]} — ${nome}*\n`,
    `Meta: *${fmt(meta)}*`,
    `Realizado: *${fmt(entrada)}* (${pct}%)\n`,
    `[${bar}] ${pct}%\n`,
    pct >= 100 ? `Meta batida.` :
    pct >= 80  ? `Faltam ${fmt(meta-entrada)} pra bater.` :
    `Faltam ${fmt(meta-entrada)} para a meta.`
  ].join('\n');
}

// ─── LEMBRETES CUSTOMIZADOS ────────────────────────────────────
async function criarLembrete(companyId, chatId, texto, nome) {
  const diaMatch = texto.match(/dia\s*(\d{1,2})/i);
  if (!diaMatch) {
    await waClient.sendMessage(chatId, `⏰ Fala o dia do lembrete!\nEx: *"me lembra de pagar o aluguel dia 5"*`);
    return;
  }
  const dia = parseInt(diaMatch[1]);
  // Remove comando da mensagem pra deixar só o conteúdo
  const conteudo = texto.replace(/me\s+lembra(r)?\s*(de|que)?/i,'').replace(/dia\s*\d+/i,'').trim() || texto;
  await db.collection('lembretes').add({ companyId, chatId, conteudo, dia, ativo: true, criadoEm: admin.firestore.FieldValue.serverTimestamp() });
  await waClient.sendMessage(chatId, `⏰ *Lembrete criado!*\n\nVou te avisar todo dia *${dia}* de cada mês:\n_"${conteudo}"_`);
}

async function listarLembretes(companyId) {
  const snap = await db.collection('lembretes').where('companyId','==',companyId).where('ativo','==',true).get();
  if (snap.empty) return `⏰ Você não tem lembretes ativos.\n\nCrie com: *"me lembra de pagar o aluguel dia 5"*`;
  return `⏰ *Seus lembretes:*\n\n` + snap.docs.map(d=>{
    const {conteudo,dia}=d.data(); return `• Dia ${dia}: ${conteudo}`;
  }).join('\n');
}

// ─── BUSCA POR TERMO/CATEGORIA ─────────────────────────────────
async function buscarPorTermo(texto, companyId) {
  const fmt = v => Number(v).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
  const termoMatch = texto.match(/(?:gastei|foi|custou|saiu)\s+(?:com|em|no|na|de)\s+(.+)|total\s+(?:de|com|em|no|na)\s+(.+)/i);
  const termo = (termoMatch?.[1] || termoMatch?.[2] || '').replace(/[?!.]/g,'').trim().toLowerCase();
  if (!termo) return `🤔 O que você quer buscar? Ex: *"quanto gastei com gasolina"*`;

  const inicioMes = `${new Date().getFullYear()}-${String(new Date().getMonth()+1).padStart(2,'0')}-01`;
  const snap = await db.collection('transactions').where('companyId','==',companyId).get();
  const txs  = snap.docs.map(d=>d.data()).filter(t => (t.date||'')>=inicioMes && (t.description||'').toLowerCase().includes(termo));

  if (!txs.length) return `🔍 Nada encontrado com *"${termo}"* esse mês.`;
  const total = txs.reduce((a,t)=>a+Number(t.amount||0),0);
  const fD2 = d => d?.split('-').reverse().join('/');
  return [`🔍 *"${termo}" — esse mês:*\n`, ...txs.map(t=>`• ${fD2(t.date)} — ${t.description}: ${fmt(t.amount)}`), `\n💰 Total: *${fmt(total)}*`].join('\n');
}

// ─── EDITAR VALOR DA ÚLTIMA TRANSAÇÃO ─────────────────────────
async function editarUltimaValor(companyId, novoValor) {
  const snap = await db.collection('transactions').where('companyId','==',companyId).get();
  if (snap.empty) return false;
  const sorted = snap.docs.sort((a, b) => {
    const ta = a.data().createdAt?.toMillis?.() || 0;
    const tb = b.data().createdAt?.toMillis?.() || 0;
    return tb - ta;
  });
  await sorted[0].ref.update({ amount: novoValor, editadoEm: admin.firestore.FieldValue.serverTimestamp() });
  return true;
}

// ─── ALERTA DE CATEGORIA ACIMA DA MÉDIA ───────────────────────
async function verificarAlertaCategoria(refs, empresa) {
  const fmt = v => Number(v).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
  const hoje = new Date();
  const inicioMes = `${hoje.getFullYear()}-${String(hoje.getMonth()+1).padStart(2,'0')}-01`;
  const inicioMesPassado = new Date(hoje.getFullYear(), hoje.getMonth()-1, 1).toISOString().split('T')[0];
  const fimMesPassado    = new Date(hoje.getFullYear(), hoje.getMonth(),   0).toISOString().split('T')[0];

  const snap = await db.collection('transactions').where('companyId','==',empresa.id).get();
  const todos = snap.docs.map(d=>d.data());

  for (const {tx} of refs) {
    if (tx.category === 'entrada') continue;
    const totalMesAtual  = todos.filter(t=>(t.date||'')>=inicioMes && t.category===tx.category).reduce((a,t)=>a+Number(t.amount||0),0);
    const totalMesPassado = todos.filter(t=>(t.date||'')>=inicioMesPassado && (t.date||'')<=fimMesPassado && t.category===tx.category).reduce((a,t)=>a+Number(t.amount||0),0);
    if (totalMesPassado > 0 && totalMesAtual > totalMesPassado * 1.3) {
      const cat = CATS[tx.category] || tx.category;
      const mapsSnap = await db.collection('whatsapp_lid_mappings').where('companyId','==',empresa.id).limit(1).get();
      if (!mapsSnap.empty) {
        const {lid, phone} = mapsSnap.docs[0].data();
        const chatId = lid || `${phone}@c.us`;
        await waClient.sendMessage(chatId,
          `📊 *Alerta de categoria!*\n\n` +
          `Seus gastos em *${cat}* esse mês chegaram a *${fmt(totalMesAtual)}* — ` +
          `30% a mais do que no mês passado (${fmt(totalMesPassado)}).\n\nFica de olho! 👀`
        );
      }
    }
  }
}

// ─── RESUMO DO DIA ─────────────────────────────────────────────
async function enviarResumoDia() {
  const fmt = v => Number(v).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
  const hoje = hojeBR();
  const mapsSnap = await db.collection('whatsapp_lid_mappings').get();
  if (mapsSnap.empty) return;
  const vistos = new Set();
  for (const mapDoc of mapsSnap.docs) {
    const { lid, phone, companyId } = mapDoc.data();
    if (vistos.has(companyId)) continue; vistos.add(companyId);
    const chatId = lid || `${phone}@c.us`;
    try {
      const snap = await db.collection('transactions').where('companyId','==',companyId).get();
      // TODAS as transações de hoje (WhatsApp, manual, Pluggy, Gmail)
      const txsHoje = snap.docs.map(d=>d.data()).filter(t=>t.date===hoje);
      if (!txsHoje.length) continue;

      const entrada = txsHoje.filter(t=>t.category==='entrada').reduce((a,t)=>a+Number(t.amount||0),0);
      const saida   = txsHoje.filter(t=>t.category!=='entrada').reduce((a,t)=>a+Number(t.amount||0),0);
      const saldo   = entrada - saida;

      // Comentário variado (não robotizado)
      let comentario;
      if (saldo > 1000)       comentario = 'Dia bom de receita.';
      else if (saldo > 0)     comentario = 'Saldo positivo.';
      else if (saldo === 0)   comentario = 'Empate técnico.';
      else if (saldo > -500)  comentario = 'Saiu mais do que entrou.';
      else                    comentario = 'Dia pesado em saídas.';

      await waClient.sendMessage(chatId,
        `Resumo de hoje\n\n` +
        `Entradas  ${fmt(entrada)}\n` +
        `Saídas    ${fmt(saida)}\n` +
        `Saldo     ${fmt(saldo)}\n\n` +
        `${txsHoje.length} lançamento${txsHoje.length!==1?'s':''} · ${comentario}`
      );
    } catch(e) { console.error('[ResumoDia]', e.message); }
  }
}

// ─── VERIFICAR LEMBRETES (roda a cada hora) ────────────────────
async function verificarLembretesHoje() {
  const dia = new Date().getDate();
  const hora = new Date().getHours();
  if (hora !== 8) return; // só dispara às 8h
  try {
    const snap = await db.collection('lembretes').where('dia','==',dia).where('ativo','==',true).get();
    for (const doc of snap.docs) {
      const { chatId, conteudo } = doc.data();
      await waClient.sendMessage(chatId, `⏰ *Lembrete de hoje!*\n\n${conteudo}`);
    }
  } catch(e) { console.error('[Lembretes]', e.message); }
}

// ─── ALERTA DE SALDO NEGATIVO PROATIVO ────────────────────────
async function verificarSaldoNegativo(companyId, empresa, chatId) {
  const fmt = v => Number(v).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
  const snap = await db.collection('transactions').where('companyId','==',companyId).get();
  const todos = snap.docs.map(d=>d.data());
  const entrada = todos.filter(t=>t.category==='entrada').reduce((a,t)=>a+Number(t.amount||0),0);
  const saida   = todos.filter(t=>t.category!=='entrada').reduce((a,t)=>a+Number(t.amount||0),0);
  if (saida > entrada) {
    await waClient.sendMessage(chatId,
      `🔴 *${empresa.nomeUsuario}, seu saldo acumulado ficou negativo!*\n\n` +
      `Total de entradas: ${fmt(entrada)}\nTotal de saídas: ${fmt(saida)}\n` +
      `Saldo: ${fmt(entrada-saida)}\n\nVale revisar os lançamentos do mês.`
    );
  }
}

// ═══════════════════════════════════════════════════════════════
//  SERVIDOR EXPRESS (Pluggy endpoints)
// ═══════════════════════════════════════════════════════════════

const app = express();
app.use(cors());
app.use(express.json());

// ── GET /pluggy/connect-token?companyId=xxx
app.get('/pluggy/connect-token', async (req, res) => {
  try {
    const apiKey = await getPluggyApiKey();
    const { companyId } = req.query;
    let body = {};
    if (companyId) {
      const snap = await db.collection('companies').doc(companyId).get();
      const itemId = snap.data()?.pluggyItemId;
      if (itemId) body.itemId = itemId;
    }
    const tokenRes = await axios.post(
      `${PLUGGY_BASE_URL}/connect_token`,
      body,
      { headers: { 'X-API-KEY': apiKey } }
    );
    res.json({ connectToken: tokenRes.data.accessToken });
  } catch (err) {
    console.error('[Pluggy] connect-token:', err.response?.data || err.message);
    res.status(500).json({ error: 'Não foi possível conectar ao Pluggy. Verifique as credenciais.' });
  }
});

// ── POST /pluggy/save-item
app.post('/pluggy/save-item', async (req, res) => {
  try {
    const { companyId, itemId } = req.body;
    if (!companyId || !itemId) return res.status(400).json({ error: 'companyId e itemId obrigatórios.' });
    await db.collection('companies').doc(companyId).update({ pluggyItemId: itemId });
    console.log(`[Pluggy] Item ${itemId} salvo para ${companyId}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /pluggy/sync  (retorna transações para o frontend revisar)
app.post('/pluggy/sync', async (req, res) => {
  try {
    const { companyId, itemId, dias = 30 } = req.body;
    if (!itemId) return res.status(400).json({ error: 'itemId obrigatório.' });

    const { rawTxs, from, to } = await fetchPluggyRaw(itemId, dias);
    if (!rawTxs.length) return res.json({ transactions: [], period: { from, to } });

    const categorized = await categorizarComGroq(rawTxs);
    console.log(`[Pluggy] ${categorized.length} transações para ${companyId}`);
    res.json({ transactions: categorized, period: { from, to } });

  } catch (err) {
    console.error('[Pluggy] sync:', err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /pluggy/auto-sync  (salva direto no Firestore, sem revisão manual)
app.post('/pluggy/auto-sync', async (req, res) => {
  try {
    const { companyId, itemId, dias = 7 } = req.body;
    if (!companyId || !itemId) return res.status(400).json({ error: 'companyId e itemId obrigatórios.' });

    const resultado = await autoSyncEmpresa(companyId, itemId, dias);
    res.json(resultado);
  } catch (err) {
    console.error('[Pluggy] auto-sync:', err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Obtém API Key do Pluggy
async function getPluggyApiKey() {
  const res = await axios.post(`${PLUGGY_BASE_URL}/auth`, {
    clientId:     PLUGGY_CLIENT_ID,
    clientSecret: PLUGGY_CLIENT_SECRET
  });
  return res.data.apiKey;
}

// ── Busca transações brutas do Pluggy (compartilhado entre sync e auto-sync)
async function fetchPluggyRaw(itemId, dias = 7) {
  const apiKey = await getPluggyApiKey();
  const accountsRes = await axios.get(`${PLUGGY_BASE_URL}/accounts?itemId=${itemId}`, {
    headers: { 'X-API-KEY': apiKey }
  });
  const accounts = accountsRes.data.results || [];

  const to   = hojeBR();
  const from = new Date(Date.now() - dias * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  let rawTxs = [];
  for (const account of accounts) {
    let page = 1;
    while (true) {
      const txRes = await axios.get(
        `${PLUGGY_BASE_URL}/transactions?accountId=${account.id}&from=${from}&to=${to}&pageSize=100&page=${page}`,
        { headers: { 'X-API-KEY': apiKey } }
      );
      const results = txRes.data.results || [];
      rawTxs.push(...results.map(t => ({
        pluggyTxId:  t.id,                              // ID único do Pluggy — usado para deduplicar
        date:        t.date?.split('T')[0] || to,
        description: t.description || t.name || 'Transação',
        amount:      Math.abs(t.amount),
        type:        t.type
      })));
      if (results.length < 100) break;
      page++;
    }
  }
  return { rawTxs, from, to, apiKey };
}

// ── Auto-sync: busca, categoriza e salva direto no Firestore (sem revisão)
async function autoSyncEmpresa(companyId, itemId, dias = 7) {
  console.log(`[AutoSync] Iniciando para ${companyId}...`);
  const { rawTxs, from, to } = await fetchPluggyRaw(itemId, dias);
  if (!rawTxs.length) return { novas: 0, from, to };

  // IDs do Pluggy já salvos (evita duplicatas)
  const existSnap = await db.collection('transactions')
    .where('companyId', '==', companyId)
    .where('origem', '==', 'pluggy')
    .where('date', '>=', from)
    .get();
  const jaExistem = new Set(existSnap.docs.map(d => d.data().pluggyTxId).filter(Boolean));

  const novas = rawTxs.filter(t => !jaExistem.has(t.pluggyTxId));
  if (!novas.length) {
    console.log(`[AutoSync] Nenhuma transação nova para ${companyId}`);
    return { novas: 0, from, to };
  }

  const categorizadas = await categorizarComGroq(novas);
  const batch = db.batch();
  for (const tx of categorizadas) {
    const ref = db.collection('transactions').doc();
    batch.set(ref, {
      date:         tx.date,
      category:     normalizarCategoria(tx.category),
      description:  tx.description,
      amount:       Number(tx.value),
      companyId,
      isRecorrente: false,
      createdBy:    'pluggy-auto',
      origem:       'pluggy',
      pluggyTxId:   tx.pluggyTxId || null,
      syncedAt:     admin.firestore.FieldValue.serverTimestamp(),
      createdAt:    admin.firestore.FieldValue.serverTimestamp()
    });
  }
  await batch.commit();

  // Atualiza timestamp do último sync na empresa
  await db.collection('companies').doc(companyId).update({
    pluggyLastSync: admin.firestore.FieldValue.serverTimestamp()
  });

  console.log(`[AutoSync] ✅ ${categorizadas.length} transações novas salvas para ${companyId}`);
  return { novas: categorizadas.length, from, to };
}

// ── Categoriza extrato bancário com Groq
async function categorizarComGroq(txs) {
  if (!txs.length) return [];

  const CATS_PROMPT = `
Categorias (use EXATAMENTE esta string):
- "entrada"     → Receitas, depósitos, Pix recebido, transferências recebidas
- "saida-fixa"  → Aluguel, contas fixas (água, luz, internet, telefone), assinaturas
- "funcionario" → Salário, pagamento de funcionários, FGTS, INSS
- "comida"      → Supermercado, restaurante, delivery, alimentação
- "variavel"    → Outros: combustível, farmácia, compras, saques, transferências enviadas
`.trim();

  const BATCH = 40;
  let result = [];

  for (let i = 0; i < txs.length; i += BATCH) {
    const lote = txs.slice(i, i + BATCH);
    try {
      const response = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages: [
          {
            role: 'system',
            content: `Você é um categorizador de extratos bancários brasileiros.\n${CATS_PROMPT}\nRetorne SOMENTE JSON com chave "items": [{"pluggyTxId":"id_original","date":"YYYY-MM-DD","description":"texto limpo","category":"categoria","value":número_positivo}]. Preserve o pluggyTxId exatamente como recebido.`
          },
          { role: 'user', content: JSON.stringify(lote) }
        ],
        temperature:     0,
        response_format: { type: 'json_object' }
      });
      const parsed = JSON.parse(response.choices[0].message.content);
      result.push(...(parsed.items || []));
    } catch (e) {
      console.error('[Groq-Pluggy] Falha no lote:', e.message);
    }
  }

  return result;
}

// ── Log de atividades em memória (últimas 100 entradas)
const _logs = [];
function addLog(tipo, msg, extra = '') {
  const entry = { tipo, msg, extra, ts: new Date().toLocaleTimeString('pt-BR') };
  _logs.unshift(entry);
  if (_logs.length > 100) _logs.pop();
}

// Sobrescreve console.log para capturar logs do bot
const _origLog = console.log.bind(console);
const _origWarn = console.warn.bind(console);
const _origErr = console.error.bind(console);
console.log = (...a) => { _origLog(...a); const t = a.join(' '); if (t.includes('[WA]') || t.includes('[CRON]') || t.includes('[Pluggy]') || t.includes('[WhatsApp]')) addLog('info', t); };
console.warn = (...a) => { _origWarn(...a); addLog('warn', a.join(' ')); };
console.error = (...a) => { _origErr(...a); addLog('error', a.join(' ')); };

// ══════════════════════════════════════════════════════════════
//  GMAIL SYNC — lê emails de bancos e extrai transações com IA
// ══════════════════════════════════════════════════════════════

function loadGmailTokens() {
  try { return JSON.parse(fs.readFileSync(GMAIL_TOKENS_FILE, 'utf8')); }
  catch { return {}; }
}
function saveGmailTokens(data) {
  fs.writeFileSync(GMAIL_TOKENS_FILE, JSON.stringify(data, null, 2));
}

async function getGmailAccessToken(companyId) {
  const all = loadGmailTokens();
  const t   = all[companyId];
  if (!t?.refresh_token) throw new Error('Gmail não conectado para esta empresa.');
  if (Date.now() < (t.expiry || 0) - 60000) return { all, t, token: t.access_token };

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

app.get('/gmail/status', (req, res) => {
  const { companyId } = req.query;
  const all = loadGmailTokens();
  const t   = all[companyId];
  res.json({ connected: !!t?.refresh_token, email: t?.email || null });
});

app.get('/gmail/auth-url', (req, res) => {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return res.status(500).json({ error: 'GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET não configurados no servidor.' });
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

app.get('/gmail/callback', async (req, res) => {
  const { code, state: companyId, error } = req.query;
  if (error) {
    return res.send(`<script>window.opener?.postMessage({type:'gmail-error',error:'${error}'},'*');window.close();</script>`);
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

    res.send(`<!DOCTYPE html><html><head><title>Gmail conectado</title></head>
      <body style="background:#0d0d1a;color:#fff;font-family:sans-serif;text-align:center;padding:40px;">
        <h2>✅ Gmail conectado!</h2><p>Pode fechar esta janela.</p>
        <script>
          window.opener?.postMessage({type:'gmail-connected',email:'${email}'},'*');
          setTimeout(()=>window.close(), 1500);
        </script>
      </body></html>`);
  } catch (err) {
    console.error('[Gmail] callback ERROR:', err.response?.data || err.message);
    res.send(`<script>window.opener?.postMessage({type:'gmail-error',error:'${err.message}'},'*');window.close();</script>`);
  }
});

app.get('/gmail/disconnect', (req, res) => {
  const all = loadGmailTokens();
  delete all[req.query.companyId];
  saveGmailTokens(all);
  console.log('[Gmail] Desconectado:', req.query.companyId);
  res.json({ ok: true });
});

const BANK_SENDERS = [
  'noreply@nubank.com.br', 'falecom@nubank.com.br', 'comunicados@nubank.com.br',
  'naoresponda@itau.com.br', 'noreply@itau.com.br', 'itau@',
  'notificacoes@bradesco.com.br', 'noreply@bradesco.com.br', 'bradesco@',
  'santander@santander.com.br', 'noreply@santander.com.br',
  'mensagens@bancodobrasil.com.br', 'noreply@bb.com.br',
  'atendimento@caixa.gov.br',
  'nao-responda@inter.co', 'noreply@inter.co',
  'noreply@c6bank.com.br',
  'noreply@neon.com.br',
  'noreply@picpay.com',
  'noreply@mercadopago.com',
];

function buildGmailQuery(dias) {
  const fromList = BANK_SENDERS.slice(0, 15).map(s => `from:${s}`).join(' OR ');
  return `(${fromList}) newer_than:${dias}d`;
}

function extractEmailBody(payload) {
  let text = '';
  function walk(part) {
    if (part.mimeType === 'text/plain' && part.body?.data) {
      text += Buffer.from(part.body.data, 'base64url').toString('utf-8') + '\n';
    } else if (part.mimeType === 'text/html' && part.body?.data && !text) {
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
    const { t, token } = await getGmailAccessToken(companyId);
    const parsedIds = new Set(t.parsedIds || []);

    const q = buildGmailQuery(Number(dias));
    const listRes = await axios.get(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages`,
      { params: { q, maxResults: 50 }, headers: { Authorization: `Bearer ${token}` } }
    );
    const messages = listRes.data.messages || [];
    const novos    = messages.filter(m => !parsedIds.has(m.id));
    console.log(`[Gmail] ${messages.length} emails, ${novos.length} novos`);

    if (!novos.length) return res.json({ transactions: [], novas: 0 });

    const transactions = [];
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

        const prompt = `De: ${from}\nAssunto: ${subject}\nData: ${dateHdr}\n\n${body.slice(0, 2500)}`;
        const completion = await groq.chat.completions.create({
          model: 'llama-3.3-70b-versatile',
          messages: [
            { role: 'system', content: `Você é um parser de emails bancários brasileiros. Responda SOMENTE com JSON: {"valor":99.90,"tipo":"saida","descricao":"...","data":"2026-05-15","banco":"..."}. tipo: "entrada" ou "saida". Se NÃO for transação: {"ignorar":true}` },
            { role: 'user', content: prompt }
          ],
          temperature: 0,
          max_tokens: 200
        });
        const raw = completion.choices[0].message.content.trim();
        const jsonStr = raw.replace(/^```json?\s*/i, '').replace(/\s*```$/, '').trim();
        const parsed  = JSON.parse(jsonStr);

        if (!parsed.ignorar && parsed.valor > 0) {
          transactions.push({
            id:          `gmail_${msg.id}`,
            date:        parsed.data || hojeBR(),
            description: parsed.descricao || subject,
            value:       Number(parsed.valor),
            category:    parsed.tipo === 'entrada' ? 'entrada' : 'saida-fixa',
            origem:      'email',
            banco:       parsed.banco || from.split('<')[0].trim(),
          });
        }
        parsedIds.add(msg.id);
        await new Promise(r => setTimeout(r, 150));
      } catch (e) {
        console.warn(`[Gmail] Erro msg ${msg.id}:`, e.message);
        parsedIds.add(msg.id);
      }
    }

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

// ── Rota de saúde
// Auditoria: lista todas as empresas com telefone + dados de localização do bot
app.get('/audit/companies', async (_, res) => {
  try {
    const snap = await db.collection('companies').get();
    const list = snap.docs.map(d => {
      const data = d.data();
      const phones = [data.phone, ...(data.phones || [])].filter(Boolean);
      return {
        id: d.id,
        name: data.name,
        type: data.type || 'company',
        active: data.active !== false,
        phones,
        phonesNorm: phones.map(normalizePhone)
      };
    });
    res.json({ total: list.length, companies: list });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Busca empresa pelo telefone (mesmo lookup do bot)
app.get('/audit/lookup', async (req, res) => {
  try {
    const phone = String(req.query.phone || '').replace(/\D/g, '');
    if (!phone) return res.status(400).json({ error: 'phone required' });
    const variations = phoneVariations(phone);
    const empresa = await buscarEmpresaPorTelefone(phone);
    res.json({
      input: phone,
      variations,
      found: empresa ? { id: empresa.id, name: empresa.nome, type: empresa.type, phones: [empresa.phone, ...(empresa.phones||[])].filter(Boolean) } : null
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Auditoria: lista empresas com telefones conflitantes (mesmo número em 2+)
app.get('/audit/phone-conflicts', async (_, res) => {
  try {
    const snap = await db.collection('companies').get();
    const byPhone = {};   // norm -> [{id, name, raw}]
    snap.forEach(d => {
      const data = d.data();
      const candidatos = [data.phone, ...(data.phones || [])].filter(Boolean);
      candidatos.forEach(raw => {
        const norm = normalizePhone(raw);
        if (!norm) return;
        if (!byPhone[norm]) byPhone[norm] = [];
        byPhone[norm].push({ id: d.id, name: data.name || d.id, raw });
      });
    });
    const conflicts = Object.entries(byPhone)
      .filter(([, arr]) => arr.length > 1)
      .map(([phone, empresas]) => ({ phone, count: empresas.length, empresas }));
    res.json({ total: conflicts.length, conflicts });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/health', (_, res) => res.json({
  status:    'ok',
  service:   'lumin-backend',
  whatsapp:  _waReady ? 'conectado' : 'aguardando QR',
  logs:      _logs.slice(0, 5),
  ts:        new Date().toISOString()
}));

// ── Monitor em tempo real
app.get('/monitor', (req, res) => {
  const cor = { info: '#4ade80', warn: '#fbbf24', error: '#f87171' };
  const linhas = _logs.map(l =>
    `<div style="padding:6px 10px;border-bottom:1px solid #1e1e2e;display:flex;gap:12px;align-items:flex-start">
      <span style="color:#555;font-size:11px;white-space:nowrap;margin-top:2px">${l.ts}</span>
      <span style="color:${cor[l.tipo]||'#aaa'};font-size:13px;word-break:break-all">${l.msg.replace(/</g,'&lt;')}</span>
    </div>`
  ).join('');

  res.send(`<!DOCTYPE html><html><head><title>Lumin Monitor</title>
  <meta charset="utf-8"/>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#0d0d1a;color:#fff;font-family:'Courier New',monospace;height:100vh;display:flex;flex-direction:column}
    header{background:#1a1a2e;padding:16px 24px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #2a2a4a;flex-shrink:0}
    h1{font-size:18px;font-weight:700;color:#fff}
    .badge{padding:4px 12px;border-radius:20px;font-size:12px;font-weight:600}
    .online{background:#14532d;color:#4ade80}
    .offline{background:#450a0a;color:#f87171}
    .stats{display:flex;gap:16px;padding:12px 24px;background:#111827;border-bottom:1px solid #1e293b;flex-shrink:0}
    .stat{font-size:12px;color:#6b7280}
    .stat b{color:#e5e7eb;font-size:14px}
    #logs{flex:1;overflow-y:auto;padding:0}
    .empty{text-align:center;padding:40px;color:#374151}
    footer{padding:10px 24px;background:#1a1a2e;font-size:11px;color:#4b5563;border-top:1px solid #2a2a4a;display:flex;justify-content:space-between;flex-shrink:0}
  </style>
  </head><body>
  <header>
    <h1>🤖 Lumin Bot — Monitor</h1>
    <span class="badge ${_waReady ? 'online' : 'offline'}">${_waReady ? '● WhatsApp Online' : '○ WhatsApp Offline'}</span>
  </header>
  <div class="stats">
    <div class="stat">Atividades <b>${_logs.length}</b></div>
    <div class="stat">Uptime <b id="up">calculando...</b></div>
    <div class="stat">Atualiza <b>a cada 3s</b></div>
  </div>
  <div id="logs">${linhas || '<div class="empty">Nenhuma atividade ainda. Manda uma mensagem pro bot!</div>'}</div>
  <footer>
    <span>http://localhost:3001/monitor</span>
    <span id="clock"></span>
  </footer>
  <script>
    const start = Date.now();
    function tick(){
      const s=Math.floor((Date.now()-start)/1000);
      document.getElementById('up').textContent = s<60?s+'s':Math.floor(s/60)+'m '+s%60+'s';
      document.getElementById('clock').textContent = new Date().toLocaleTimeString('pt-BR');
    }
    tick(); setInterval(tick,1000);
    setInterval(()=>location.reload(), 3000);
  </script>
  </body></html>`);
});

// ── QR Code + Pairing Code no navegador
app.get('/qr', async (req, res) => {
  if (_waReady) {
    return res.send(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#111;color:#fff">
      <h2>✅ WhatsApp conectado!</h2><p>O bot está online e funcionando normalmente.</p></body></html>`);
  }

  const base = `<!DOCTYPE html><html><head><title>Lumin Bot - Conectar</title>
  <style>body{font-family:sans-serif;text-align:center;padding:40px;background:#111;color:#fff;margin:0}
  h2{margin-bottom:8px} p{color:#aaa;margin:4px 0} .card{background:#1a1a2e;border-radius:16px;padding:24px;margin:16px auto;max-width:420px;border:1px solid #333}
  input{background:#0d0d1a;border:1px solid #444;color:#fff;padding:12px 16px;border-radius:8px;font-size:16px;width:200px;text-align:center}
  button{background:#25d366;color:#fff;border:none;padding:12px 24px;border-radius:8px;font-size:15px;cursor:pointer;margin-top:8px;font-weight:600}
  button:hover{background:#1da851} .divider{color:#555;margin:16px 0;font-size:13px} #msg{margin-top:12px;font-size:14px;min-height:20px}</style></head><body>`;

  const qrPngPath = path.join(DATA_DIR, 'qrcode.png');
  const hasQr = _qrAtual || fs.existsSync(qrPngPath);

  if (!hasQr) {
    return res.send(base + `<div class="card"><h2>⏳ Inicializando...</h2>
      <p>Aguarde, o bot está carregando o WhatsApp Web.</p>
      <p style="margin-top:16px;color:#666;font-size:13px">A página atualiza sozinha</p></div>
      <script>setTimeout(()=>location.reload(),5000)</script></body></html>`);
  }

  // Serve a imagem diretamente do arquivo PNG em disco (cache-bust com timestamp)
  const ts = Date.now();
  res.send(base + `
    <h2 style="margin-bottom:4px">📱 Conectar Lumin Bot</h2>
    <p>Escolha uma das opções abaixo</p>

    <div class="card">
      <h3 style="margin:0 0 8px">Opção 1 — Escanear QR Code</h3>
      <p>WhatsApp → Dispositivos vinculados → Vincular dispositivo</p>
      <img src="/qr-image.png?t=${ts}" style="border-radius:12px;margin:12px auto;display:block;width:320px"/>
      <p style="font-size:12px;color:#666">Expira em ~60s — a página atualiza automaticamente</p>
    </div>

    <div class="card">
      <h3 style="margin:0 0 8px">Opção 2 — Vincular pelo número 📞</h3>
      <p>Se o QR der erro, use seu número com DDI (ex: 5511999990001)</p>
      <input type="text" id="phone" placeholder="5511999990001" maxlength="15"/>
      <br/>
      <button onclick="pedir()">Gerar código de 8 dígitos</button>
      <div id="msg"></div>
    </div>

    <script>
      setTimeout(()=>location.reload(), 28000);
      async function pedir(){
        const phone = document.getElementById('phone').value.replace(/\\D/g,'');
        if(phone.length < 12){ document.getElementById('msg').textContent='⚠ Digite o número completo com DDI'; return; }
        document.getElementById('msg').textContent='⏳ Gerando código...';
        try{
          const r = await fetch('/qr/pair?phone='+phone);
          const d = await r.json();
          if(d.code) document.getElementById('msg').innerHTML='<b style="font-size:28px;letter-spacing:4px;color:#25d366">'+d.code+'</b><br><small>Digite esse código no WhatsApp → Dispositivos vinculados → Vincular com número</small>';
          else document.getElementById('msg').textContent = d.error || 'Erro ao gerar código';
        }catch(e){ document.getElementById('msg').textContent='Erro: '+e.message; }
      }
    </script></body></html>`);
});

// ── Serve o PNG do QR Code diretamente do disco
app.get('/qr-image.png', (req, res) => {
  const qrPngPath = path.join(DATA_DIR, 'qrcode.png');
  if (!fs.existsSync(qrPngPath)) {
    return res.status(404).send('QR ainda não gerado');
  }
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(qrPngPath);
});

// ── Gera pairing code pelo número de telefone
app.get('/qr/pair', async (req, res) => {
  try {
    const phone = String(req.query.phone || '').replace(/\D/g, '');
    if (phone.length < 12) return res.json({ error: 'Número inválido' });
    if (_waReady) return res.json({ error: 'WhatsApp já está conectado!' });
    const code = await waClient.requestPairingCode(phone);
    console.log(`[WA] 🔑 Pairing code para ${phone}: ${code}`);
    res.json({ code });
  } catch (err) {
    console.error('[PairingCode]', err.message);
    res.json({ error: 'Não foi possível gerar o código. Tente o QR Code.' });
  }
});

// ─── INICIAR SERVIDOR ──────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n[Lumin] Servidor rodando na porta ${PORT}`);
  console.log(`[Lumin] Aguardando QR Code do WhatsApp...\n`);
});

module.exports = app;

/*
 ═══════════════════════════════════════════════════════════════
 COMO USAR
 ═══════════════════════════════════════════════════════════════

 1. Instale as dependências:
    npm install express whatsapp-web.js qrcode-terminal groq-sdk firebase-admin cors axios dotenv

 2. Coloque o arquivo serviceAccountKey.json na mesma pasta
    (baixe do Firebase Console → Configurações do Projeto → Contas de Serviço)

 3. Configure o .env com suas chaves (já está criado)

 4. Rode o servidor:
    node webhook-handler.js

 5. Um QR Code aparecerá no terminal — escaneie com o WhatsApp do celular
    (igual ao WhatsApp Web). A sessão fica salva em .wwebjs_auth/

 6. No painel admin do Lumin, cadastre o número de cada empresa
    no campo "Número do Bot (WhatsApp)" no formato: 5511999990001
    (com DDI 55, DDD, número — sem espaços ou traços)

 7. A partir daí, quando alguém cujo número está cadastrado mandar
    mensagem para o bot, a transação é salva automaticamente!

 ═══════════════════════════════════════════════════════════════
 EXEMPLOS DE MENSAGENS QUE O BOT ENTENDE:
 ═══════════════════════════════════════════════════════════════

 "Entrada de 500 reais do cliente João"
 "Paguei aluguel 1200"
 "Salário da Maria 2000 reais"
 "Almocei 45 reais"
 "Gasolina 150"
 "Recebi Pix de 800 reais"
 "Conta de luz 230 reais"

 Também funciona com ÁUDIO — fale a transação!

 ═══════════════════════════════════════════════════════════════
*/
