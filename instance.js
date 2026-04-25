'use strict';

/**
 * bot/instance.js
 * Instância individual de bot WhatsApp para uma empresa (tenant).
 *
 * Identifica o companyId pelo número do bot: client.info.wid.user
 * Grava todos os lançamentos em /companies/{companyId}/financeiro
 */

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} = require('@whiskeysockets/baileys');
const { Boom }    = require('@hapi/boom');
const qrcode      = require('qrcode-terminal');
const pino        = require('pino');
const fs          = require('fs');
const path        = require('path');

const { analisarMensagem, pareceTransacao } = require('./ai');
const { salvarLancamento, calcularTotalMes, formatarMoeda, formatarData } = require('./financeiro');
const { getCompanyByPhone } = require('../admin/companies');

class BotInstance {
  /**
   * @param {object} options
   * @param {string} options.companyId   - ID do documento /companies/{id}
   * @param {string} options.companyName - Nome da empresa (para logs)
   * @param {string} options.botPhone    - Número do WhatsApp do bot (apenas dígitos)
   * @param {string} [options.sessionBase] - Pasta base das sessões
   */
  constructor({ companyId, companyName, botPhone, sessionBase }) {
    this.companyId   = companyId;
    this.companyName = companyName;
    this.botPhone    = botPhone.replace(/\D/g, '');
    this.sessionPath = path.join(sessionBase || './sessions', companyId);
    this.sock        = null;
    this.status      = 'idle'; // idle | connecting | qr | connected | disconnected
    this.tentativas  = 0;
    this._reconnectTimer = null;
  }

  // ─── Iniciar bot ────────────────────────────────────────────────────────────
  async start() {
    if (!fs.existsSync(this.sessionPath)) {
      fs.mkdirSync(this.sessionPath, { recursive: true });
    }

    this.status = 'connecting';
    const { state, saveCreds } = await useMultiFileAuthState(this.sessionPath);
    const { version }          = await fetchLatestBaileysVersion();

    const logger = pino({ level: 'silent' });

    this.sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys:  makeCacheableSignalKeyStore(state.keys, logger),
      },
      printQRInTerminal: false,
      logger,
      browser: [`Lumin · ${this.companyName}`, 'Chrome', '120.0.0'],
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
    });

    this.sock.ev.on('creds.update', saveCreds);
    this._bindConnectionUpdate();
    this._bindMessages();

    this._log(`Bot iniciado (tenant: ${this.companyId})`);
    return this;
  }

  // ─── Parar bot ──────────────────────────────────────────────────────────────
  async stop() {
    clearTimeout(this._reconnectTimer);
    if (this.sock) {
      try { await this.sock.logout(); } catch (_) {}
      this.sock = null;
    }
    this.status = 'idle';
    this._log('Bot parado');
  }

  // ─── Eventos de conexão ─────────────────────────────────────────────────────
  _bindConnectionUpdate() {
    this.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this.status = 'qr';
        this._log('QR Code gerado — aguardando leitura...');
        console.log(`\n[${this.companyName}] Escaneie o QR:\n`);
        qrcode.generate(qr, { small: true });
      }

      if (connection === 'close') {
        const err        = lastDisconnect?.error;
        const statusCode = new Boom(err)?.output?.statusCode;

        if (statusCode === DisconnectReason.loggedOut) {
          this._log('⛔ Sessão encerrada (logout). Apague a pasta de sessão e reinicie.');
          this.status = 'disconnected';
          return;
        }

        this.tentativas++;
        const delay = Math.min(5000 * this.tentativas, 30000);
        this.status = 'disconnected';
        this._log(`Desconectado. Reconectando em ${delay / 1000}s... (tentativa ${this.tentativas})`);
        this._reconnectTimer = setTimeout(() => this.start(), delay);
      }

      if (connection === 'open') {
        this.tentativas = 0;
        this.status     = 'connected';

        // Confirma que o número do bot bate com o tenant registrado
        const myPhone = this.sock.user?.id?.split(':')[0]?.split('@')[0] || '';
        this._log(`✅ Conectado! Número: +${myPhone}`);

        // Sincroniza companyId pelo número em tempo real
        if (myPhone && myPhone !== this.botPhone) {
          this._log(`⚠ Número detectado (+${myPhone}) difere do cadastrado (+${this.botPhone}). Verificando...`);
          const company = await getCompanyByPhone(myPhone);
          if (company) {
            this.companyId = company.companyId || company.id;
            this._log(`✅ companyId ajustado para: ${this.companyId}`);
          }
        }
      }
    });
  }

  // ─── Processamento de mensagens ─────────────────────────────────────────────
  _bindMessages() {
    this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        if (msg.key.fromMe) continue;

        const remetente = msg.key.remoteJid;
        const texto =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text || '';

        if (!texto.trim()) continue;

        if (!pareceTransacao(texto)) {
          this._log(`[IGNORADO] "${texto.slice(0, 60)}"`);
          await this._send(remetente,
            '💡 Não identifiquei um lançamento financeiro nessa mensagem.\n\n' +
            '*Exemplos que funcionam:*\n' +
            '• Gastei R$50 no almoço\n' +
            '• Paguei 1500 de aluguel\n' +
            '• Recebi 3000 de venda\n' +
            '• Salário do João 2000\n' +
            '• Comprei material 350 reais'
          );
          continue;
        }

        this._log(`[PROCESSANDO] "${texto.slice(0, 60)}"`);

        try {
          const resultado = await analisarMensagem(texto);

          if (!resultado.valido) {
            await this._send(remetente,
              '🤔 Não consegui identificar um valor monetário claro.\n\n' +
              '*Tente ser mais específico, ex:*\n' +
              '• "Gastei R$50 no almoço"\n' +
              '• "Paguei 1500 de aluguel"\n' +
              '• "Recebi 3000 de venda"'
            );
            continue;
          }

          // userId = remetente (número do usuário que enviou a mensagem)
          const userId = remetente.split('@')[0].replace(/\D/g, '');

          // Salva em /companies/{companyId}/financeiro
          const { id: docId } = await salvarLancamento(this.companyId, resultado, userId);

          const { totalEntrada, totalSaida } = await calcularTotalMes(this.companyId);
          const agora     = new Date();
          const tipoLabel = resultado.tipo === 'obrigacao' ? 'Obrigação' : 'Transação';
          const catEmoji  = {
            'entrada':    '💵 Entrada',
            'saida-fixa': '📌 Despesa Fixa',
            'variavel':   '🛒 Despesa Variável',
            'funcionario':'👷 Pagamento Funcionário',
          };
          const catLabel = catEmoji[resultado.category] ?? '💰 Lançamento';
          const saldo    = totalEntrada - totalSaida;

          const confirmacao =
            `✅ *${tipoLabel} Registrada!*\n\n` +
            `${catLabel}\n` +
            `💰 *Valor:* ${formatarMoeda(resultado.amount)}\n` +
            `📝 *Descrição:* ${resultado.description}\n` +
            `🔁 *Recorrente:* ${resultado.isRecorrente ? 'Sim' : 'Não'}\n` +
            `📅 *Data:* ${formatarData(agora)}\n` +
            `🏢 *Empresa:* ${this.companyName}\n\n` +
            `📊 *Resumo de ${agora.toLocaleString('pt-BR', { month: 'long' })}:*\n` +
            `   💵 Entradas: ${formatarMoeda(totalEntrada)}\n` +
            `   📉 Saídas:   ${formatarMoeda(totalSaida)}\n` +
            `   ${saldo >= 0 ? '💹' : '🔴'} Saldo:    ${formatarMoeda(saldo)}\n\n` +
            `🔗 *ID:* \`${docId}\``;

          await this._send(remetente, confirmacao);

        } catch (err) {
          this._log(`[ERRO] ${err?.message || err}`);
          await this._send(remetente, '❌ Erro ao registrar o lançamento. Tente novamente.');
        }
      }
    });
  }

  // ─── Enviar mensagem ────────────────────────────────────────────────────────
  async _send(jid, text) {
    try {
      await this.sock.sendMessage(jid, { text });
    } catch (err) {
      this._log(`[SEND ERROR] ${err?.message}`);
    }
  }

  // ─── Log prefixado com empresa ──────────────────────────────────────────────
  _log(msg) {
    console.log(`[${this.companyName}|${this.companyId}] ${msg}`);
  }

  // ─── Retorna estado público ─────────────────────────────────────────────────
  toStatus() {
    return {
      companyId:   this.companyId,
      companyName: this.companyName,
      botPhone:    this.botPhone,
      status:      this.status,
    };
  }
}

module.exports = BotInstance;
