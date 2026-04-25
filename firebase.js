'use strict';

require('dotenv').config();
const admin = require('firebase-admin');

// Inicializa apenas uma vez
if (!admin.apps.length) {
  const requiredVars = [
    'FIREBASE_PROJECT_ID',
    'FIREBASE_PRIVATE_KEY',
    'FIREBASE_CLIENT_EMAIL',
  ];
  const missing = requiredVars.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`❌ Firebase: variáveis ausentes: ${missing.join(', ')}`);
    process.exit(1);
  }

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      privateKey:  process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    }),
  });
}

const db = admin.firestore();

module.exports = { admin, db };
