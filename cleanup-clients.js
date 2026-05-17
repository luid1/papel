/**
 * cleanup-clients.js
 * Limpa clientes duplicados/inválidos no Firestore
 * Uso: node cleanup-clients.js
 */

const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

// Tenta usar firebase-admin; se não tiver, usa REST via fetch
let db;

async function main() {
  // ── Tenta firebase-admin ──────────────────────────────────
  try {
    const admin = require('firebase-admin');
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.applicationDefault(),
        projectId: 'lumin-a5b29'
      });
    }
    db = admin.firestore();
    await runCleanup();
    return;
  } catch(e) {
    // firebase-admin não disponível, usa script alternativo
  }

  // ── Fallback: gera script HTML para rodar no browser ──────
  console.log('\n⚠️  firebase-admin não encontrado.\n');
  console.log('Abra o console do browser (F12) na página do admin (localhost:8080)');
  console.log('e cole o script abaixo:\n');
  console.log('─'.repeat(60));
  printBrowserScript();
  console.log('─'.repeat(60));
}

function printBrowserScript() {
  const script = `
(async () => {
  const db = firebase.firestore();
  const FV = firebase.firestore.FieldValue;

  // ── 1. CLIENTES A REMOVER (inválidos / duplicatas menores) ──
  const toDelete = [
    '9999',
    'BEEF',          // duplicata de BEEF BAR
    // adicione aqui outros se quiser
  ];

  // ── 2. MESCLAR SALDOS antes de deletar ──
  // Lê BEEF e soma saldo em BEEF BAR
  const merges = [
    { from: 'BEEF', to: 'BEEF BAR' },
    // { from: 'OUTRO NOME ANTIGO', to: 'NOME CORRETO' },
  ];

  console.log('🔄 Iniciando limpeza...');

  for (const { from, to } of merges) {
    const fromSnap = await db.collection('ll_clients').doc(from).get();
    if (!fromSnap.exists) { console.log(\`⏩ \${from} não encontrado, pulando merge\`); continue; }
    const fromData = fromSnap.data();

    const toSnap = await db.collection('ll_clients').doc(to).get();
    const toData = toSnap.exists ? toSnap.data() : { balanceBlack: 0, balanceWhite: 0 };

    const newBlack = (toData.balanceBlack || 0) + (fromData.balanceBlack || 0);
    const newWhite = (toData.balanceWhite || 0) + (fromData.balanceWhite || 0);

    await db.collection('ll_clients').doc(to).set({
      name: to,
      balanceBlack: newBlack,
      balanceWhite: newWhite,
      lastUpdated: FV.serverTimestamp()
    }, { merge: true });

    console.log(\`✅ Mesclado: \${from} → \${to} (pretas: \${newBlack}, brancas: \${newWhite})\`);
  }

  // ── 3. DELETAR clientes inválidos/duplicatas ──
  for (const nome of toDelete) {
    try {
      await db.collection('ll_clients').doc(nome).delete();
      console.log(\`🗑 Deletado de ll_clients: \${nome}\`);
    } catch(e) { console.warn(\`⚠️ Erro ao deletar \${nome}:\`, e.message); }
  }

  // ── 4. LIMPAR luminlog_frequentes ──
  const freqSnap = await db.collection('luminlog_frequentes').doc('index').get();
  if (freqSnap.exists) {
    let nomes = freqSnap.data().nomes || [];
    const antes = nomes.length;
    nomes = nomes.filter(n => !toDelete.includes(n));
    await db.collection('luminlog_frequentes').doc('index').set({ nomes }, { merge: true });
    console.log(\`🧹 luminlog_frequentes: \${antes} → \${nomes.length} nomes\`);
  }

  console.log('\\n✅ Limpeza concluída! Recarregue o app do motorista.');
})();
`;
  console.log(script);
}

async function runCleanup() {
  const toDelete = ['9999', 'BEEF'];
  const merges   = [{ from: 'BEEF', to: 'BEEF BAR' }];

  console.log('🔄 Iniciando limpeza via firebase-admin...\n');

  for (const { from, to } of merges) {
    const fromSnap = await db.collection('ll_clients').doc(from).get();
    if (!fromSnap.exists) { console.log(`⏩ ${from} não encontrado, pulando merge`); continue; }
    const fromData = fromSnap.data();
    const toSnap   = await db.collection('ll_clients').doc(to).get();
    const toData   = toSnap.exists ? toSnap.data() : { balanceBlack: 0, balanceWhite: 0 };
    await db.collection('ll_clients').doc(to).set({
      name: to,
      balanceBlack: (toData.balanceBlack||0) + (fromData.balanceBlack||0),
      balanceWhite: (toData.balanceWhite||0) + (fromData.balanceWhite||0),
      lastUpdated:  FieldValue.serverTimestamp()
    }, { merge: true });
    console.log(`✅ Mesclado: ${from} → ${to}`);
  }

  for (const nome of toDelete) {
    await db.collection('ll_clients').doc(nome).delete().catch(()=>{});
    console.log(`🗑 Deletado: ${nome}`);
  }

  const freqSnap = await db.collection('luminlog_frequentes').doc('index').get();
  if (freqSnap.exists) {
    let nomes = (freqSnap.data().nomes || []).filter(n => !toDelete.includes(n));
    await db.collection('luminlog_frequentes').doc('index').set({ nomes }, { merge: true });
    console.log(`🧹 luminlog_frequentes limpo`);
  }

  console.log('\n✅ Limpeza concluída!');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
