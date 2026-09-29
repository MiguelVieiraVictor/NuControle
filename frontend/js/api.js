/* Chamadas ao Python.
   `api.qualquerMetodo(...)` chama `window.pywebview.api.qualquer_metodo(...)`,
   desembrulha o envelope {ok, dados|erro} e lanca Error com a mensagem do
   back-end quando ok=false. */

const pywebviewPronto = new Promise((resolve) => {
  if (window.pywebview && window.pywebview.api) resolve();
  else window.addEventListener("pywebviewready", () => resolve(), { once: true });
});

const api = new Proxy({}, {
  get(_, nome) {
    const metodo = String(nome).replace(/[A-Z]/g, (l) => `_${l.toLowerCase()}`);
    return async (...args) => {
      await pywebviewPronto;
      const fn = window.pywebview.api[metodo];
      if (!fn) throw new Error(`Função ${metodo} não existe no back-end.`);
      const r = await fn(...args.map((a) => (a === undefined ? null : a)));
      if (!r || !r.ok) throw new Error((r && r.erro) || "Falha sem mensagem.");
      return r.dados;
    };
  },
});
