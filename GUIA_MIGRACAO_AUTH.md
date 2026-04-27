# Guia de Migração — Lumin Firebase Authentication

## O que mudou

| Antes (inseguro) | Depois (seguro) |
|---|---|
| Constante `CEO_USERS` com senhas no código-fonte | Credenciais geridas pelo Firebase Authentication |
| Campo `type="text"` aceitando username livre | Campo `type="email"` validado pelo browser |
| Email construído internamente (`username@lumin.internal`) | Utilizador insere o e-mail completo diretamente |
| Senhas expostas no bundle JS enviado ao cliente | Senhas nunca chegam ao código-fonte |

---

## Passo 1 — Activar o Firebase Authentication no Console

1. Acesse [https://console.firebase.google.com](https://console.firebase.google.com) e seleccione o seu projecto **Lumin**.
2. No menu lateral esquerdo, clique em **Build → Authentication**.
3. Clique em **Começar** (ou "Get started") se for a primeira vez.
4. Na aba **Sign-in method**, localize **E-mail/senha**.
5. Clique no lápis de edição → active o primeiro toggle (**Activar**) → clique em **Salvar**.

> ⚠️ Não é necessário activar o toggle "Link de e-mail (login sem senha)".

---

## Passo 2 — Criar o utilizador `luidoliver` manualmente

1. Ainda em **Authentication**, clique na aba **Utilizadores** (ou "Users").
2. Clique em **Adicionar utilizador**.
3. Preencha os campos:
   - **E-mail:** `luidoliver@lumin.com`
   - **Senha:** `luid@`
4. Clique em **Adicionar utilizador**.
5. O Firebase irá gerar um **UID** automático (ex.: `abc123xyz...`). **Copie esse UID** — vai precisar dele no passo seguinte.

---

## Passo 3 — Criar o documento do utilizador no Firestore

O sistema valida a role do utilizador buscando o seu perfil na colecção `/users` pelo `uid` do Firebase Auth.

1. Vá em **Build → Firestore Database**.
2. Clique em **+ Iniciar colecção** (se ainda não existir) ou abra a colecção **`users`**.
3. Clique em **+ Adicionar documento**.
4. No campo **ID do documento**, cole o **UID** copiado no Passo 2 (não use "ID automático").
5. Adicione os seguintes campos:

| Campo | Tipo | Valor |
|---|---|---|
| `username` | string | `luidoliver` |
| `email` | string | `luidoliver@lumin.com` |
| `role` | string | `master` |
| `active` | boolean | `true` |
| `displayName` | string | `Lui D. Oliver` (ou o nome real) |
| `photoURL` | string | _(URL da foto, ou deixe vazio)_ |

6. Clique em **Salvar**.

> O campo `uid` não precisa constar no documento — ele já é o próprio ID do documento.

---

## Passo 4 — Preencher `firebase-config.js` com as credenciais reais

1. No Console Firebase, clique na engrenagem ⚙️ → **Configurações do projecto**.
2. Em **Os seus apps**, seleccione o app web (ou crie um clicando em `</>`).
3. Copie o objecto `firebaseConfig` e cole em `firebase-config.js`:

```js
const firebaseConfig = {
  apiKey:            "AIza...",
  authDomain:        "meu-projeto.firebaseapp.com",
  projectId:         "meu-projeto",
  storageBucket:     "meu-projeto.appspot.com",
  messagingSenderId: "123456789",
  appId:             "1:123456789:web:abc..."
};
```

---

## Passo 5 — Testar o login

1. Abra `index.html` num servidor local (ex.: extensão **Live Server** no VS Code).
2. No formulário de login, insira:
   - **E-mail:** `luidoliver@lumin.com`
   - **Senha:** `luid@`
3. Clique em **Acessar Sistema**.
4. O sistema deve autenticar via Firebase, buscar o documento `/users/{uid}` no Firestore, verificar `role === "master"` e exibir o painel de administração.

---

## Segurança adicional recomendada

- **Altere a senha** `luid@` para uma senha forte após o primeiro acesso. Pode fazê-lo em **Authentication → Utilizadores → ⋮ → Redefinir senha** ou directamente pela interface do sistema se implementar essa funcionalidade.
- Configure as **Regras do Firestore** para garantir que apenas utilizadores autenticados acedam à colecção `/users`:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid} {
      allow read: if request.auth != null && request.auth.uid == uid;
      allow write: if false; // apenas via Admin SDK
    }
  }
}
```

- Habilite **App Check** no Firebase Console para proteger as suas APIs contra chamadas não autorizadas.
