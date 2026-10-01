// Copia as bibliotecas de node_modules para frontend/vendor/ (o site nao usa CDN:
// tudo vem do proprio dominio, e a versao fica travada no package-lock.json).
//   npm ci && npm run vendor

import { copyFileSync, mkdirSync } from "node:fs";

const destino = new URL("../frontend/vendor/", import.meta.url);
mkdirSync(destino, { recursive: true });

const arquivos = {
  "supabase.js": "@supabase/supabase-js/dist/umd/supabase.js",
  "sql-wasm.js": "sql.js/dist/sql-wasm.js",
  "sql-wasm.wasm": "sql.js/dist/sql-wasm.wasm",
};
for (const [nome, origem] of Object.entries(arquivos)) {
  copyFileSync(new URL(`../node_modules/${origem}`, import.meta.url), new URL(nome, destino));
  console.log(`vendor/${nome}`);
}
