/* Confere a URL e a chave do Supabase antes de usar.

   A chave que vai para o site e a PUBLICA (publishable / anon): ela so deixa
   fazer o que o RLS permite. A chave SECRETA (secret / service_role) ignora o
   RLS e daria acesso a TODOS os dados de TODOS os usuarios para qualquer um
   que abrisse o site. Por isso ela e recusada aqui -- no deploy
   (ferramentas/gerar-config.mjs) e de novo no navegador. */

export function validarConfig({ supabaseUrl, supabaseChave } = {}) {
  const url = String(supabaseUrl || "").trim().replace(/\/+$/, "");
  const chave = String(supabaseChave || "").trim();

  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(url)) {
    throw new Error("SUPABASE_URL inválida. Use a Project URL do painel, ex.: https://abcdefgh.supabase.co");
  }
  if (!chave) throw new Error("SUPABASE_CHAVE vazia.");
  if (chave.startsWith("sb_secret_")) {
    throw new Error("Essa é a chave SECRETA do Supabase. Use a chave publishable (sb_publishable_...). Nunca coloque a secreta no site.");
  }
  if (chave.startsWith("sb_publishable_")) return { supabaseUrl: url, supabaseChave: chave };

  // chave antiga em formato JWT: so a de papel "anon" serve
  const partes = chave.split(".");
  if (partes.length === 3) {
    let papel;
    try {
      const b64 = partes[1].replace(/-/g, "+").replace(/_/g, "/");
      papel = JSON.parse(atob(b64 + "===".slice((b64.length + 3) % 4))).role;
    } catch {
      papel = null;
    }
    if (papel === "anon") return { supabaseUrl: url, supabaseChave: chave };
    if (papel === "service_role") {
      throw new Error("Essa é a chave service_role (SECRETA) do Supabase. Use a chave anon/publishable. Nunca coloque a secreta no site.");
    }
  }
  throw new Error("Chave do Supabase em formato desconhecido. Use a publishable (sb_publishable_...) ou a anon.");
}
