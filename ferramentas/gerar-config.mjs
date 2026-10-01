// Gera frontend/js/config.js a partir das variaveis de ambiente SUPABASE_URL e
// SUPABASE_CHAVE (no GitHub: Settings -> Secrets and variables -> Actions ->
// Variables). Roda no deploy; o arquivo gerado nunca vai para o git.
//
// Falha -- e o site NAO e publicado -- se a chave for a secreta.

import { writeFileSync } from "node:fs";
import { validarConfig } from "../frontend/js/nucleo/configuracao.js";

let conf;
try {
  conf = validarConfig({ supabaseUrl: process.env.SUPABASE_URL, supabaseChave: process.env.SUPABASE_CHAVE });
} catch (e) {
  console.error(`::error::${e.message}`);
  process.exit(1);
}

writeFileSync(
  new URL("../frontend/js/config.js", import.meta.url),
  `// Gerado no deploy por ferramentas/gerar-config.mjs. Chave PUBLICA: so faz o que o RLS permite.\n` +
  `window.NUCONTROLE = ${JSON.stringify(conf, null, 2)};\n`,
);
console.log(`config.js gerado para ${conf.supabaseUrl}`);
