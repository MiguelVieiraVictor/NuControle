/* O supabase/schema.sql num Postgres de verdade (PGlite, Postgres 17 em
   WebAssembly), com um "auth" falso imitando o do Supabase.

   Confere que:
     - as operacoes que o site gera sao aceitas e deixam o banco igual ao
       retrato local do site;
     - um usuario nao le, nao altera e nao referencia nada de outro;
     - quem nao fez login nao acessa nada;
     - conflitos (linha apagada em outro aparelho) dao erro 40001 e nada e gravado. */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import initSqlJs from "sql.js";
import { TABELAS } from "../frontend/js/nucleo/banco.js";
import * as regras from "../frontend/js/nucleo/regras.js";
import { lerBancoDesktop } from "../frontend/js/nucleo/transferencia.js";
import { Conta } from "./ajuda.js";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
let pg;

before(async () => {
  pg = new PGlite();
  // O minimo do Supabase que o schema usa: auth.users, auth.uid() e os papeis.
  await pg.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth, public to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
    -- o Supabase da acesso padrao aos papeis em tabelas novas; o schema precisa tirar
    alter default privileges in schema public grant all on tables to anon, authenticated;
    alter default privileges in schema public grant execute on functions to anon, authenticated;
    insert into auth.users values ('${A}'), ('${B}');
  `);
  await pg.exec(readFileSync(new URL("../supabase/schema.sql", import.meta.url), "utf-8"));
});

/** Roda `fn` como o usuario `uid` (ou anon), numa transacao. */
async function como(uid, fn) {
  return pg.transaction(async (tx) => {
    await tx.query(uid ? "set local role authenticated" : "set local role anon");
    await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [uid || ""]);
    return fn(tx);
  });
}

const aplicar = (uid, ops) => como(uid, (tx) => tx.query("select public.aplicar($1::jsonb)", [JSON.stringify(ops)]));

/** Todas as linhas que `uid` enxerga, no formato que a API do Supabase devolve. */
async function despejo(uid) {
  return como(uid, async (tx) => {
    const r = {};
    for (const t of TABELAS) {
      const { rows } = await tx.query(`select to_jsonb(x) - 'user_id' as l from public.${t} x order by id`);
      r[t] = rows.map((x) => x.l);
    }
    return r;
  });
}

/** Uma Conta (testes/ajuda.js) que tambem envia cada alteracao ao Postgres. */
class ContaPg extends Conta {
  constructor(uid) {
    super("2026-09-15");
    this.uid = uid; // a inicializacao (feita no super) fica em this.ops ate o primeiro enviar()
  }

  escrever(fn) {
    const antes = this.banco;
    const r = super.escrever(fn);
    (this.ops ||= []).push(...diferencaEntre(antes, this.banco));
    return r;
  }

  async enviar() {
    const ops = this.ops || [];
    this.ops = [];
    if (ops.length) await aplicar(this.uid, ops);
    assert.deepEqual(await despejo(this.uid), this.banco.despejo(), "o Postgres ficou diferente do site");
  }
}

function diferencaEntre(antes, depois) {
  const tx = antes.transacao();
  tx.t = Object.fromEntries(TABELAS.map((t) => [t, new Map(depois.t[t])]));
  return tx.diferenca();
}

const codigo = async (promessa) => {
  try {
    await promessa;
  } catch (e) {
    return e.code;
  }
  return "ok";
};

test("o que o site gera e aceito, e o banco fica igual ao site", async () => {
  const c = new ContaPg(A);
  await c.enviar(); // inicializacao
  const fulano = c.escrever((tx) => regras.salvarDono(tx, { nome: "Fulano", tipo: "PESSOA", cor: "#22D3EE" }));
  const cat = c.escrever((tx) => regras.salvarCategoria(tx, { nome: "Pets", cor: "#66BB6A" }));
  await c.enviar();

  const parc = c.compra({ natureza: "PARCELAMENTO", valor: 1_000_00, num_parcelas: 3, categoria_id: cat,
    divisao: { modo: "valor", partes: [{ dono_id: c.eu, valor: 600_00 }, { dono_id: fulano, valor: 400_00 }] } });
  const fixo = c.compra({ natureza: "FIXO", meio: "DEBITO", valor: 900_00, data: "2026-08-05",
    divisao: { modo: "igual", donos: [c.eu, fulano] } });
  await c.enviar();

  // editar fixo (apaga e recria meses, inclusive fixo_gerado com o mesmo mes)
  c.compra({ descricao: "Aluguel novo", natureza: "FIXO", meio: "DEBITO", valor: 950_00, data: "2026-08-05" }, fixo);
  await c.enviar();
  // excluir categoria: o Postgres faz o set null, o site manda a atualizacao
  c.escrever((tx) => regras.excluirCategoria(tx, cat));
  // mudar o ciclo do cartao: atualiza fatura_ref de varios lancamentos
  c.escrever((tx) => regras.salvarConfig(tx, { dia_fechamento: 5, dia_vencimento: 15, saldo_inicial: 10_00, data_inicio: "2026-08-01" }));
  await c.enviar();
  c.escrever((tx) => regras.excluirCompra(tx, parc));
  c.escrever((tx) => regras.arquivarDono(tx, fulano, false));
  const r = c.escrever((tx) => regras.salvarReserva(tx, { nome: "Reserva", tipo: "CAIXINHA", meta: 10_00 }));
  c.escrever((tx) => regras.criarMovReserva(tx, { reserva_id: r, tipo: "RENDIMENTO", valor: 5, data: "2026-09-02" }));
  c.escrever((tx) => regras.pagarFatura(tx, { fatura_ref: "2026-09", valor: 10_00, data: "2026-09-03" }));
  await c.enviar();
});

test("importacao inteira numa chamada so", async () => {
  const SQL = await initSqlJs();
  const { dados } = lerBancoDesktop(SQL, new Uint8Array(readFileSync(new URL("./fixtures/exemplo-v2.db", import.meta.url))));
  const c = new ContaPg(B);
  await c.enviar();
  c.escrever((tx) => {
    tx.limpar();
    for (const [t, ls] of Object.entries(dados)) for (const l of ls) tx.inserir(t, l);
  });
  await c.enviar();
  assert.equal((await despejo(B)).lancamento_parte.length, c.banco.quantas("lancamento_parte"));
});

test("um usuario nao enxerga nem mexe nos dados do outro", async () => {
  const deA = await despejo(A);
  const deB = await despejo(B);
  assert.ok(deA.compra.length > 0 && deB.compra.length > 0);
  const idsB = new Set(deB.compra.map((c) => c.id));
  assert.ok(deA.compra.every((c) => !idsB.has(c.id)));

  const compraA = deA.compra[0];
  const donoA = deA.dono[0];
  // B tenta alterar e apagar uma compra de A: para B ela nao existe
  assert.equal(await codigo(aplicar(B, [{ op: "atualizar", tabela: "compra", linhas: [{ id: compraA.id, descricao: "hack" }] }])), "40001");
  assert.equal(await codigo(aplicar(B, [{ op: "apagar", tabela: "compra", ids: [compraA.id] }])), "40001");
  // B tenta pendurar uma parte dele numa compra de A: a chave estrangeira com user_id barra
  assert.equal(await codigo(aplicar(B, [{ op: "inserir", tabela: "compra_parte",
    linhas: [{ id: "00000000-0000-7000-8000-000000000001", compra_id: compraA.id, dono_id: deB.dono[0].id, valor: 1 }] }])), "23503");
  assert.equal(await codigo(aplicar(B, [{ op: "inserir", tabela: "compra_parte",
    linhas: [{ id: "00000000-0000-7000-8000-000000000002", compra_id: deB.compra[0].id, dono_id: donoA.id, valor: 1 }] }])), "23503");
  // B tenta gravar com o user_id de A
  assert.equal(await codigo(aplicar(B, [{ op: "inserir", tabela: "categoria",
    linhas: [{ id: "00000000-0000-7000-8000-000000000003", user_id: A, nome: "x", cor: "#FFFFFF", ativa: true }] }])), "22023");
  // ...nem pela API comum (insert direto), o RLS recusa
  assert.equal(await codigo(como(B, (tx) => tx.query(
    `insert into public.categoria (id, user_id, nome, cor) values ('00000000-0000-7000-8000-000000000004', '${A}', 'x', '#FFFFFF')`))), "42501");
  // ...e um select direto de B so volta o que e de B
  const { rows } = await como(B, (tx) => tx.query(`select count(*)::int as n from public.compra where user_id = '${A}'`));
  assert.equal(rows[0].n, 0);
  assert.deepEqual(await despejo(A), deA, "os dados de A mudaram");
});

test("quem nao fez login nao acessa nada", async () => {
  assert.equal(await codigo(como(null, (tx) => tx.query("select * from public.compra"))), "42501");
  assert.equal(await codigo(aplicar(null, [])), "42501");
  assert.equal(await codigo(como(null, (tx) => tx.query("truncate public.compra"))), "42501");
  assert.equal(await codigo(como(A, (tx) => tx.query("truncate public.compra"))), "42501");
});

test("conflito: nada e gravado e o erro e 40001", async () => {
  const antes = await despejo(A);
  const pag = antes.pagamento_fatura[0];
  const ops = [
    { op: "inserir", tabela: "categoria", linhas: [{ id: "00000000-0000-7000-8000-000000000005", nome: "Nova", cor: "#FFFFFF", ativa: true }] },
    { op: "apagar", tabela: "pagamento_fatura", ids: [pag.id, "00000000-0000-7000-8000-0000000000ff"] },
  ];
  assert.equal(await codigo(aplicar(A, ops)), "40001");
  assert.deepEqual(await despejo(A), antes, "a categoria nao podia ter ficado");
  // e os CHECKs barram dado invalido
  assert.equal(await codigo(aplicar(A, [{ op: "atualizar", tabela: "pagamento_fatura", linhas: [{ id: pag.id, valor: -1 }] }])), "23514");
  assert.equal(await codigo(aplicar(A, [{ op: "atualizar", tabela: "compra; drop table x", linhas: [{ id: pag.id }] }])), "22023");
  assert.equal(await codigo(aplicar(A, [{ op: "atualizar", tabela: "pagamento_fatura", linhas: [{ id: pag.id, "valor = 0 --": 1 }] }])), "42703");
});

test("supabase/verificar.sql da tudo ok", async () => {
  const { rows } = await pg.query(readFileSync(new URL("../supabase/verificar.sql", import.meta.url), "utf-8"));
  assert.ok(rows.length >= 11 * 3 + 2);
  assert.deepEqual(rows.filter((r) => !r.ok), []);
});
