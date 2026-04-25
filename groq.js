'use strict';

require('dotenv').config();
const OpenAI = require('openai');

if (!process.env.GROQ_API_KEY) {
  console.error('❌ GROQ_API_KEY ausente no .env');
  process.exit(1);
}

const groq = new OpenAI({
  apiKey:  process.env.GROQ_API_KEY,
  baseURL: 'https://api.groq.com/openai/v1',
});

module.exports = { groq };
