# Lumin SaaS — Multi-tenant Finance Bot

Arquitetura **Multi-tenant SaaS** com Node.js, WhatsApp-web.js (Baileys) e Firebase Firestore.

---

## Estrutura de Diretórios

```
lumin-saas/
├── .env                    ← Credenciais (não commitar)
├── .env.example            ← Template
├── server.js               ← Entry point (Express + BotManager)
├── package.json
│
├── config/
│   ├── firebase.js         ← Inicialização Firebase Admin
│   └── groq.js             ← Cliente Groq/Llama IA
│
├── admin/
│   ├── companies.js        ← CRUD de empresas (Firestore /companies)
│   └── router.js           ← API REST do painel Master
│
├── bot/
│   ├── instance.js         ← Instância individual de bot (por empresa)
│   ├── manager.js          ← Orquestrador: um bot por empresa ativa
│   ├── ai.js               ← Análise financeira via Groq (Llama)
│   └── financeiro.js       ← Persistência multi-tenant no Firestore
│
├── public/
│   └── index.html          ← Frontend (design original preservado)
│
└── scripts/
    └── seed-company.js     ← Cria empresa de exemplo
```

---

## Configuração

### 1. Instalar dependências
```bash
npm install
```

### 2. Configurar `.env`
```
FIREBASE_PROJECT_ID=lumin-a5b29
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n"
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-...@lumin-a5b29.iam.gserviceaccount.com

GROQ_API_KEY=gsk_...

ADMIN_USER=luidoliver
ADMIN_PASS=luid@

PORT=3000
SESSION_BASE_PATH=./sessions
```

### 3. Iniciar
```bash
npm start
```

---

## Acesso Admin Master

- **URL:** `http://localhost:3000`
- **Usuário:** `luidoliver`
- **Senha:** `luid@`

O painel Admin permite:
- Cadastrar novas empresas (nome, login, senha, número bot, cor)
- Listar e ativar/desativar empresas
- Ver extrato financeiro de cada tenant via API

---

## API Admin REST

Todas as rotas exigem Basic Auth (`ADMIN_USER:ADMIN_PASS`).

| Método | Rota | Descrição |
|--------|------|-----------|
| `POST`   | `/admin/companies`         | Criar empresa |
| `GET`    | `/admin/companies`         | Listar empresas |
| `GET`    | `/admin/companies/:id`     | Buscar empresa |
| `PUT`    | `/admin/companies/:id`     | Atualizar empresa |
| `DELETE` | `/admin/companies/:id`     | Desativar empresa |
| `GET`    | `/admin/companies/:id/financeiro` | Extrato do tenant |
| `GET`    | `/admin/status`            | Status dos bots |

### Exemplo: criar empresa via cURL
```bash
curl -X POST http://localhost:3000/admin/companies \
  -u "luidoliver:luid@" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Eco Mix",
    "login": "ecomix",
    "password": "eco@123",
    "botPhone": "5511999990001",
    "themeColor": "#00d4ff"
  }'
```

---

## Estrutura Firestore (Multi-tenant)

```
/companies/{companyId}
  name:        "Eco Mix Ltda"
  login:       "ecomix"
  password:    "eco@123"
  botPhone:    "5511999990001"
  themeColor:  "#00d4ff"
  active:      true
  createdAt:   1234567890000

  /financeiro/{docId}        ← dados ISOLADOS por empresa
    amount:      1500.00
    category:    "saida-fixa"
    description: "aluguel"
    date:        "2025-01-15"
    companyId:   "abc123"
    createdBy:   "5511988887777"
    ...
```

**Isolamento garantido:** A Empresa A lê apenas `/companies/companyA/financeiro`. A Empresa B nunca acessa dados da Empresa A.

---

## Bot Multi-tenant

- Ao iniciar, o `BotManager` lê todas as empresas ativas no Firestore
- Cria uma instância `BotInstance` por empresa
- Cada instância tem sua própria pasta de sessão: `./sessions/{companyId}/`
- O `companyId` é identificado pelo número do bot (`client.info.wid.user`)
- Lançamentos são gravados em `/companies/{companyId}/financeiro`

### Iniciar bot para nova empresa (sem reiniciar servidor)
```bash
curl -X POST http://localhost:3000/api/bot/{companyId}/start
```

---

## themeColor

O campo `themeColor` da empresa é lido no login e aplicado via CSS:
```css
--accent:  #RRGGBB   /* cor principal */
--accent2: versão mais escura (calculada automaticamente)
```

Apenas botões, bordas e destaques assumem a cor do tenant. O layout base permanece intacto.
