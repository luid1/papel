/**
 * ═══════════════════════════════════════════════════════════════
 *  LUMIN SaaS — Login Controller
 *  Arquivo: login-controller.js
 *
 *  Responsabilidades:
 *  • Capturar evento de login (botão + Enter)
 *  • Chamar LuminAuth.login() de forma segura
 *  • Exibir feedback de erro com animação
 * ═══════════════════════════════════════════════════════════════
 */

document.addEventListener("DOMContentLoaded", () => {
  const btnLogin = document.getElementById("btn-do-login");
  const lUser    = document.getElementById("l-user");
  const lPass    = document.getElementById("l-pass");
  const errEl    = document.getElementById("l-err");
  const card     = document.querySelector("#login-screen .glass");

  // Mensagens de erro amigáveis por código Firebase
  const ERROR_MAP = {
    "auth/invalid-credential":    "Usuário ou senha incorretos.",
    "auth/user-disabled":         "Esta conta foi desativada.",
    "auth/too-many-requests":     "Muitas tentativas. Aguarde um momento.",
    "auth/network-request-failed":"Sem conexão com a internet.",
  };

  function showError(msg) {
    if (!errEl) return;
    errEl.textContent = `⚠ ${msg}`;
    errEl.style.display = "block";

    // Animação de shake no card
    if (card) {
      card.animate([
        { transform: "translateX(0)" },
        { transform: "translateX(-8px)" },
        { transform: "translateX(8px)" },
        { transform: "translateX(-5px)" },
        { transform: "translateX(5px)" },
        { transform: "translateX(0)" }
      ], { duration: 360, easing: "ease-in-out" });
    }

    setTimeout(() => { if (errEl) errEl.style.display = "none"; }, 4000);
  }

  async function doLogin() {
    const email    = lUser?.value.trim().toLowerCase() || "";
    const password = lPass?.value || "";

    if (!email || !password) {
      showError("Preencha e-mail e senha.");
      return;
    }

    // Chama o Auth Manager
    const result = await window.LuminAuth?.login(email, password);

    if (result && !result.success) {
      // Mapeia o erro para mensagem amigável
      const friendlyMsg = Object.entries(ERROR_MAP).find(([code]) =>
        result.message?.includes(code)
      )?.[1] || "Credenciais inválidas.";

      showError(friendlyMsg);
      lPass.value = ""; // limpa senha por segurança
      lPass.focus();
    }
  }

  // Bind eventos
  btnLogin?.addEventListener("click", doLogin);
  lPass?.addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });
  lUser?.addEventListener("keydown", (e) => { if (e.key === "Enter") lPass?.focus(); });
});
