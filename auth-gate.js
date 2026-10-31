// ============================================================
// Front Security - Tela de senha (igual nos 3 apps: QTI, Coberturas, Pagamentos)
// O banco só aceita a conta da equipe; o app só inicia depois que ela entra no aparelho.
// O login fica salvo no navegador, então a senha é pedida uma vez por aparelho.
// A senha NÃO fica no código: ela é conferida pelo Firebase Authentication.
// ============================================================
(function () {
  const TEAM_EMAIL = 'schiavolindaniel@gmail.com';

  const ERRORS = {
    'auth/invalid-credential': 'Senha incorreta.',
    'auth/invalid-login-credentials': 'Senha incorreta.',
    'auth/wrong-password': 'Senha incorreta.',
    'auth/user-not-found': 'Conta da equipe não existe neste Firebase.',
    'auth/too-many-requests': 'Muitas tentativas. Aguarde alguns minutos e tente de novo.',
    'auth/network-request-failed': 'Sem internet. Verifique a conexão.',
    'auth/operation-not-allowed': 'Login por senha não está ativado neste Firebase.',
    'auth/user-disabled': 'Conta da equipe desativada.'
  };

  const STYLE = `
    #auth-gate { position: fixed; inset: 0; z-index: 99999; display: none; align-items: center; justify-content: center;
      background: #0d1526; padding: 16px; font-family: 'Inter', system-ui, sans-serif; }
    #auth-gate.active { display: flex; }
    #auth-gate .ag-box { width: 100%; max-width: 340px; background: #1B2A4A; border: 1px solid rgba(245,166,35,.35);
      border-radius: 14px; padding: 24px 20px; color: #fff; box-shadow: 0 12px 40px rgba(0,0,0,.5); }
    #auth-gate h1 { font-size: 1.15rem; margin: 0 0 4px; color: #F5A623; letter-spacing: .5px; }
    #auth-gate p { font-size: .85rem; margin: 0 0 16px; color: rgba(255,255,255,.7); }
    #auth-gate input { width: 100%; box-sizing: border-box; padding: 12px; font-size: 1rem; border-radius: 8px;
      border: 1px solid rgba(255,255,255,.2); background: rgba(0,0,0,.3); color: #fff; margin-bottom: 10px; }
    #auth-gate label.ag-show { display: flex; gap: 6px; align-items: center; font-size: .8rem; color: rgba(255,255,255,.7); margin-bottom: 14px; }
    #auth-gate button { width: 100%; padding: 12px; font-size: 1rem; font-weight: 700; border: none; border-radius: 8px;
      background: #F5A623; color: #1B2A4A; cursor: pointer; }
    #auth-gate button:disabled { opacity: .6; cursor: wait; }
    #auth-gate .ag-error { min-height: 1.2em; margin-top: 10px; font-size: .85rem; color: #ff7b6b; }
  `;

  let overlay = null;

  function buildOverlay() {
    if (overlay) return overlay;
    const style = document.createElement('style');
    style.textContent = STYLE;
    document.head.appendChild(style);

    overlay = document.createElement('div');
    overlay.id = 'auth-gate';
    overlay.innerHTML = `
      <form class="ag-box" autocomplete="on">
        <h1>🔒 FRONT SECURITY</h1>
        <p>Digite a senha da equipe para entrar.</p>
        <input type="email" name="username" value="${TEAM_EMAIL}" autocomplete="username" hidden>
        <input type="password" name="password" placeholder="Senha" autocomplete="current-password" required>
        <label class="ag-show"><input type="checkbox" style="width:auto;margin:0"> Mostrar senha</label>
        <button type="submit">Entrar</button>
        <div class="ag-error" role="alert"></div>
      </form>`;
    document.body.appendChild(overlay);

    const form = overlay.querySelector('form');
    const pwd = overlay.querySelector('input[type=password]');
    const btn = overlay.querySelector('button');
    const err = overlay.querySelector('.ag-error');
    overlay.querySelector('.ag-show input').addEventListener('change', (e) => {
      pwd.type = e.target.checked ? 'text' : 'password';
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.textContent = '';
      btn.disabled = true;
      btn.textContent = 'Entrando...';
      try {
        await firebase.auth().signInWithEmailAndPassword(TEAM_EMAIL, pwd.value);
        pwd.value = '';
      } catch (ex) {
        err.textContent = ERRORS[ex && ex.code] || `Não foi possível entrar (${(ex && ex.code) || 'erro'}).`;
      } finally {
        btn.disabled = false;
        btn.textContent = 'Entrar';
      }
    });
    return overlay;
  }

  function show() {
    buildOverlay().classList.add('active');
    setTimeout(() => { const p = overlay.querySelector('input[type=password]'); if (p) p.focus(); }, 50);
  }

  function hide() {
    if (overlay) overlay.classList.remove('active');
  }

  window.AuthGate = {
    TEAM_EMAIL,

    // Resolves once the team account is signed in on this device; the app starts after that.
    start(config) {
      if (!firebase.apps.length) firebase.initializeApp(config);
      const auth = firebase.auth();
      return new Promise((resolve) => {
        let started = false;
        auth.onAuthStateChanged((user) => {
          if (user && user.email === TEAM_EMAIL) {
            hide();
            if (!started) { started = true; resolve(user); }
          } else if (started) {
            // Signed out while the app was open: restart cleanly at the password screen
            location.reload();
          } else {
            if (user) auth.signOut();
            show();
          }
        });
      });
    },

    signOut() {
      return firebase.auth().signOut();
    }
  };
})();
