# Lumin SaaS v2 — Guia de Configuração (Admin-First)

## Estrutura de Arquivos

```
lumin-v2/
├── index.html              # Shell principal (Preloader + Login + Admin)
├── firebase-config.js      # Inicialização Firebase V10 Modular
├── auth-manager.js         # Gerenciador de Sessão e Route Guard
├── admin-controller.js     # CRUD Admin (Companies + Users)
├── login-controller.js     # Captura eventos do formulário de login
└── README.md               # Este arquivo
```

---

## Passo 1 — Configurar Firebase

1. Acesse [console.firebase.google.com](https://console.firebase.google.com)
2. Crie um projeto (ex: `lumin-saas`)
3. Ative **Authentication → Email/Password**
4. Ative **Firestore Database**
5. Em **Configurações do Projeto → Seus apps → Web**, copie o `firebaseConfig`
6. Cole as credenciais em `firebase-config.js`

---

## Passo 2 — Criar o Usuário Admin Master no Firebase Auth

Como o Auth Manager usa `signInWithEmailAndPassword`, o usuário Master precisa existir no Firebase Auth. Execute este script **uma única vez** no console do seu projeto (Cloud Functions, ou temporariamente no frontend em desenvolvimento):

```javascript
// Executar apenas UMA VEZ para criar o Admin Master
import { getAuth, createUserWithEmailAndPassword } from "firebase/auth";
import { getFirestore, doc, setDoc, serverTimestamp } from "firebase/firestore";

const auth = getAuth();
const db   = getFirestore();

const email    = "luidoliver@lumin.internal";
const password = "SUA_SENHA_SEGURA_AQUI"; // mínimo 6 caracteres

const cred = await createUserWithEmailAndPassword(auth, email, password);
const uid  = cred.user.uid;

await setDoc(doc(db, "users", uid), {
  username:    "luidoliver",
  displayName: "Admin Master",
  email,
  role:        "master",
  companyId:   null,
  active:      true,
  createdAt:   serverTimestamp()
});

console.log("Admin Master criado! UID:", uid);
```

---

## Passo 3 — Regras de Segurança do Firestore

Cole estas regras em **Firestore → Regras**:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    // Função auxiliar: verifica se o usuário logado é Master
    function isMaster() {
      return request.auth != null &&
        get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role == 'master';
    }

    // Função auxiliar: verifica se o usuário é tenant ativo
    function isTenant() {
      return request.auth != null &&
        get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role == 'tenant' &&
        get(/databases/$(database)/documents/users/$(request.auth.uid)).data.active == true;
    }

    // Coleção users
    match /users/{userId} {
      // Leitura: o próprio usuário ou o Master
      allow read:   if request.auth.uid == userId || isMaster();
      // Criação: apenas o Master
      allow create: if isMaster();
      // Atualização: o próprio (campos limitados) ou o Master (full)
      allow update: if isMaster() ||
        (request.auth.uid == userId &&
         request.resource.data.role == resource.data.role &&
         request.resource.data.active == resource.data.active);
      // Deleção: apenas o Master
      allow delete: if isMaster();
    }

    // Coleção companies
    match /companies/{companyId} {
      // Leitura: qualquer tenant ativo ou o Master
      allow read:   if isTenant() || isMaster();
      // Escrita: apenas o Master
      allow write:  if isMaster();
    }

    // Bloquear tudo que não foi declarado
    match /{document=**} {
      allow read, write: if false;
    }
  }
}
```

---

## Fluxo de Segurança (Route Guard)

```
Carrega index.html
      │
      ▼
  PRELOADER (3s animação)
      │
      ▼
  auth-manager.js → onAuthStateChanged()
      │
      ├─ Sem sessão ──────────────────► LOGIN SCREEN
      │                                     │
      │                              Usuário digita credenciais
      │                                     │
      │                              LuminAuth.login()
      │                              signInWithEmailAndPassword()
      │                              getDoc(users/{uid})
      │                                     │
      └─ Sessão ativa                        │
            │                               │
            ▼                               ▼
      getDoc(users/{uid})          ← Valida role + active
            │
            ├─ role: "master" ──► ADMIN PANEL + evento lumin:admin-ready
            │                          │
            │                    admin-controller.js carrega CRUD
            │
            ├─ role: "tenant"   ──► APP SHELL WRAPPER (Fase 2)
            │   active: true
            │
            └─ role inválida    ──► _securityBreach()
               active: false         signOut() + LOGIN SCREEN + aviso
```

---

## Estrutura do Firestore

### Coleção `/users/{uid}`
```json
{
  "username":    "ecomix",
  "displayName": "Eco Mix Ltda",
  "email":       "ecomix@lumin.internal",
  "role":        "tenant",
  "companyId":   "eco-mix-ltda-abc123",
  "active":      true,
  "createdAt":   Timestamp
}
```

### Coleção `/companies/{companyId}`
```json
{
  "name":       "Eco Mix Ltda",
  "phone":      "5511999990001",
  "themeColor": "#00d4ff",
  "active":     true,
  "createdAt":  Timestamp
}
```

---

## Segurança: O que foi implementado

| Proteção | Implementação |
|----------|--------------|
| Nenhuma view renderizada sem sessão | `showLayer()` controla visibilidade por CSS class, nunca injeta HTML antes da validação |
| Acesso admin verificado no backend | `getDoc(users/{uid})` valida `role === "master"` no Firestore, não só no frontend |
| Tentativa de acesso não autorizado | `_securityBreach()` → `signOut()` → limpa estado → LOGIN com aviso |
| Tenant com conta suspensa | `active === false` → breach de segurança + logout forçado |
| Dupla verificação no Admin | `requireRole("master")` em toda operação CRUD sensível |
| Regras Firestore | Master-only write em `/companies` e `/users` |
| Sem localStorage de sessão | Sessão gerenciada exclusivamente pelo Firebase Auth SDK |
