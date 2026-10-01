// Servidor para desenvolver no proprio computador: http://localhost:8080
//   npm run dev
//
// Se frontend/js/config.js nao existir, o site abre no MODO LOCAL: sem
// Supabase e sem login, com os dados no localStorage do navegador. Para
// testar contra o Supabase de verdade, crie o config.js com
//   SUPABASE_URL=... SUPABASE_CHAVE=... node ferramentas/gerar-config.mjs

import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const raiz = fileURLToPath(new URL("../frontend/", import.meta.url));
const porta = Number(process.env.PORTA || 8080);
const tipos = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".png": "image/png", ".wasm": "application/wasm",
  ".json": "application/json", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml",
};

createServer((req, res) => {
  const caminho = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const arquivo = normalize(join(raiz, caminho.endsWith("/") ? `${caminho}index.html` : caminho));
  if (!arquivo.startsWith(normalize(raiz))) {
    res.writeHead(403).end();
    return;
  }
  if (caminho === "/js/config.js" && !existsSync(arquivo)) {
    res.writeHead(200, { "content-type": tipos[".js"] });
    res.end("window.NUCONTROLE = { modoLocal: true }; // modo local: sem Supabase\n");
    return;
  }
  if (!existsSync(arquivo)) {
    res.writeHead(404).end("nao encontrado");
    return;
  }
  res.writeHead(200, { "content-type": tipos[extname(arquivo)] || "application/octet-stream", "cache-control": "no-store" });
  res.end(readFileSync(arquivo));
}).listen(porta, "127.0.0.1", () => console.log(`NuControle em http://localhost:${porta}`));
