/* Importacao do app desktop, paridade com o Python e backup .json.

   fixtures/exemplo-v2.db foi gerado pelo proprio codigo Python da versao
   desktop (dados ficticios), e fixtures/esperado-v2.json e o que as consultas
   Python devolviam para ele. Importar e consultar aqui tem que dar o mesmo,
   centavo por centavo. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import initSqlJs from "sql.js";
import { Banco, aplicarOps } from "../frontend/js/nucleo/banco.js";
import { Config, ErroValidacao, fixarHoje } from "../frontend/js/nucleo/base.js";
import * as consultas from "../frontend/js/nucleo/consultas.js";
import * as regras from "../frontend/js/nucleo/regras.js";
import { gerarBackup, lerBackup, lerBancoDesktop } from "../frontend/js/nucleo/transferencia.js";
import { Conta } from "./ajuda.js";

const SQL = await initSqlJs();
const fixture = (nome) => new URL(`./fixtures/${nome}`, import.meta.url);
const bytesExemplo = () => new Uint8Array(readFileSync(fixture("exemplo-v2.db")));

/** Grava `dados` numa conta nova (zerando o que a inicializacao criou), como o app faz. */
function importar(conta, dados) {
  return conta.escrever((tx) => {
    tx.limpar();
    for (const [tabela, linhas] of Object.entries(dados)) for (const l of linhas) tx.inserir(tabela, l);
  });
}

test("le o banco desktop e resume", () => {
  const { resumo, dados } = lerBancoDesktop(SQL, bytesExemplo());
  assert.deepEqual(resumo, { compras: 7, terceiros: 3, caixinhas: 2, ultimo_lancamento: "2026-09-15" });
  assert.equal(dados.lancamento_parte.length, 32);
  assert.equal(dados.config[0].saldo_inicial, 1_500_00);
});

test("paridade com as consultas do Python", () => {
  const esperado = JSON.parse(readFileSync(fixture("esperado-v2.json"), "utf-8"));
  const { dados, mapas } = lerBancoDesktop(SQL, bytesExemplo());
  const conta = new Conta("2026-09-15");
  importar(conta, dados);

  // uuid -> id antigo, para comparar com a saida do Python
  const antigo = new Map();
  for (const m of Object.values(mapas)) for (const [velho, novo] of m) antigo.set(novo, velho);
  const normalizar = (v, chave) => {
    if (Array.isArray(v)) return v.map((x) => normalizar(x));
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v).filter(([k]) => k !== "id_eu").map(([k, x]) => [k, normalizar(x, k)]));
    }
    if (typeof v === "string" && antigo.has(v)) return antigo.get(v);
    if (typeof v === "string" && /^[0-9a-f]{8}-/.test(v)) return "NOVO"; // gerado depois da importacao
    if (typeof v === "boolean" && (chave === "ativo" || chave === "ativa")) return v ? 1 : 0;
    return v;
  };

  // do lado do Python, lancamentos gerados depois do arquivo tem id maior que o ultimo dele
  const ultimoLanc = Math.max(...mapas.lancamento.keys());
  const marcarNovos = (v) => {
    if (Array.isArray(v)) return v.forEach(marcarNovos);
    if (v && typeof v === "object") {
      if ("compra_id" in v && "fatura_ref" in v && v.id > ultimoLanc) v.id = "NOVO";
      Object.values(v).forEach(marcarNovos);
    }
  };
  marcarNovos(esperado);

  for (const ref of ["2026-08", "2026-09", "2026-10", "2026-12", "2027-03"]) {
    conta.escrever((tx) => regras.garantirFixos(tx, ref));
    const b = conta.banco;
    const obtido = {
      visao: consultas.visaoGeral(b, ref),
      mes: consultas.mes(b, ref),
      fatura: consultas.fatura(b, ref),
      faturas: consultas.faturas(b, ref),
      conta: consultas.conta(b, Config.ler(b), ref),
    };
    for (const k of Object.keys(obtido)) {
      assert.deepEqual(normalizar(obtido[k]), esperado[ref][k], `${ref} ${k}`);
    }
  }
  assert.deepEqual(normalizar(consultas.reservas(conta.banco)), esperado.reservas);
  assert.deepEqual(normalizar(consultas.estado(conta.banco)), esperado.estado);
});

test("recusa arquivos errados", () => {
  assert.throws(() => lerBancoDesktop(SQL, new TextEncoder().encode("isto nao e um banco".repeat(100))),
    (e) => e instanceof ErroValidacao && /não é um banco|Não consegui/.test(e.message));
  const v1 = new SQL.Database();
  v1.run("CREATE TABLE config(a); CREATE TABLE lancamento(a); CREATE TABLE reserva(a);");
  assert.throws(() => lerBancoDesktop(SQL, v1.export()), (e) => /versão 1/.test(e.message));
  assert.throws(() => lerBackup("{}"), ErroValidacao);
  assert.throws(() => lerBackup("não é json"), ErroValidacao);
});

test("backup .json ida e volta, com ids novos", () => {
  fixarHoje("2026-09-15");
  const { dados } = lerBancoDesktop(SQL, bytesExemplo());
  const origem = new Conta("2026-09-15");
  importar(origem, dados);
  const json = JSON.stringify(gerarBackup(origem.banco));

  const { resumo, dados: restaurados } = lerBackup(json);
  assert.equal(resumo.compras, 7);
  const destino = new Conta("2026-09-15");
  destino.compra({ descricao: "some na restauracao" });
  importar(destino, restaurados);

  const idsOrigem = new Set(origem.banco.linhas("lancamento").map((l) => l.id));
  assert.ok(destino.banco.linhas("lancamento").every((l) => !idsOrigem.has(l.id)), "ids precisam ser novos");
  assert.ok(!destino.banco.linhas("compra").some((c) => c.descricao === "some na restauracao"));
  const sem = (b) => JSON.stringify(consultas.visaoGeral(b, "2026-10"), (k, v) => (k === "id" || k === "dono_id" ? undefined : v));
  assert.equal(sem(destino.banco), sem(origem.banco));
});

test("a diferenca de uma importacao se aplica no servidor simulado", () => {
  const { dados } = lerBancoDesktop(SQL, bytesExemplo());
  const base = new Conta("2026-09-15").banco;
  const tx = base.transacao();
  tx.limpar();
  for (const [t, ls] of Object.entries(dados)) for (const l of ls) tx.inserir(t, l);
  const ops = tx.diferenca();
  // exclusoes vem antes das insercoes (config e unica por conta)
  const primeiraInsercao = ops.findIndex((o) => o.op === "inserir");
  assert.ok(ops.slice(0, primeiraInsercao).every((o) => o.op === "apagar"));
  assert.deepEqual(aplicarOps(base, ops).despejo(), new Banco(tx.confirmar().despejo()).despejo());
});
