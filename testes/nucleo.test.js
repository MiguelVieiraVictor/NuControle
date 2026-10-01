/* As regras do app: dinheiro, calendario, divisao, fixos, saldo e telas.
   Porte dos testes da versao desktop, com os mesmos numeros. */

import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as cal from "../frontend/js/nucleo/calendario.js";
import * as consultas from "../frontend/js/nucleo/consultas.js";
import * as regras from "../frontend/js/nucleo/regras.js";
import { Config, ErroValidacao, fixarHoje } from "../frontend/js/nucleo/base.js";
import { dividirIgual, formatarReais, parseCentavos, ratear, ratearMatriz } from "../frontend/js/nucleo/dinheiro.js";
import { Conta } from "./ajuda.js";

const soma = (xs) => xs.reduce((s, v) => s + v, 0);
const erro = (re) => (e) => e instanceof ErroValidacao && re.test(e.message);

describe("dinheiro", () => {
  test("parse", () => {
    assert.equal(parseCentavos("1.234,56"), 123456);
    assert.equal(parseCentavos("1234.56"), 123456);
    assert.equal(parseCentavos("1234"), 123400);
    assert.equal(parseCentavos("0,1"), 10);
    assert.equal(parseCentavos(999), 999);
    assert.throws(() => parseCentavos(1.5));
    assert.throws(() => parseCentavos("1,234")); // tres casas decimais
  });

  test("formatar", () => {
    assert.equal(formatarReais(123456789), "R$ 1.234.567,89");
    assert.equal(formatarReais(-5), "-R$ 0,05");
  });

  test("dividir igual", () => {
    assert.deepEqual(dividirIgual(10000, 3), [3334, 3333, 3333]);
    assert.deepEqual(dividirIgual(2, 3), [1, 1, 0]);
  });

  test("ratear", () => {
    assert.deepEqual(ratear(100, [1, 1, 1]), [34, 33, 33]);
    assert.deepEqual(ratear(1000, [3, 1]), [750, 250]);
    assert.equal(soma(ratear(99999, [7, 13, 1])), 99999);
    // valores grandes: total * peso passa de 2^53 e continua exato
    assert.deepEqual(ratear(9_000_000_000_00, [1, 2]), [3_000_000_000_00, 6_000_000_000_00]);
  });

  test("ratear matriz: exemplo", () => {
    const parcelas = dividirIgual(100000, 3);
    const m = ratearMatriz(parcelas, [60000, 40000]);
    assert.deepEqual(m.map(soma), parcelas);
    assert.deepEqual([0, 1].map((j) => soma(m.map((l) => l[j]))), [60000, 40000]);
  });

  test("ratear matriz: aleatorio", () => {
    let semente = 42;
    const rnd = (a, b) => {
      semente = (semente * 1103515245 + 12345) % 2147483648;
      return a + (semente % (b - a + 1));
    };
    for (let k = 0; k < 3000; k++) {
      const n = rnd(1, 24);
      const donos = rnd(1, 5);
      const total = rnd(n * donos, 5_000_00);
      const parcelas = dividirIgual(total, n);
      const partes = ratear(total, Array.from({ length: donos }, () => rnd(1, 100)));
      if (partes.includes(0)) continue;
      const m = ratearMatriz(parcelas, partes);
      assert.deepEqual(m.map(soma), parcelas);
      assert.deepEqual(partes.map((_, j) => soma(m.map((l) => l[j]))), partes);
      m.forEach((linha, i) => linha.forEach((v, j) => {
        assert.ok(v >= 0);
        assert.ok(Math.abs(v - (parcelas[i] * partes[j]) / total) < 2);
      }));
    }
  });
});

describe("calendario", () => {
  function cobertura(fech, venc) {
    for (let d = "2026-01-01"; d < "2029-01-01"; d = cal.somarDias(d, 1)) {
      const r = cal.faturaDe(d, fech, venc);
      const c = cal.ciclo(r, fech, venc);
      assert.ok(c.inicio <= d && d <= c.fechamento, `${d} ${r}`);
      assert.ok(c.fechamento < c.vencimento);
      const anterior = cal.ciclo(cal.somarRef(r, -1), fech, venc);
      assert.equal(cal.somarDias(anterior.fechamento, 1), c.inicio);
    }
  }

  test("toda data cai em exatamente uma fatura", () => {
    cobertura(29, 3);
    cobertura(31, 7);
    cobertura(5, 15);
  });

  test("exemplos", () => {
    assert.equal(cal.faturaDe("2026-09-08", 29, 3), "2026-10");
    assert.equal(cal.faturaDe("2026-09-30", 29, 3), "2026-11");
    const c = cal.ciclo("2026-10", 29, 3);
    assert.deepEqual([c.inicio, c.fechamento, c.vencimento], ["2026-08-30", "2026-09-29", "2026-10-03"]);
  });

  test("datas", () => {
    assert.equal(cal.somarDias("2026-03-01", -1), "2026-02-28");
    assert.equal(cal.somarRef("2026-01", -1), "2025-12");
    assert.equal(cal.dataIso("2028-02-29"), "2028-02-29");
    assert.throws(() => cal.dataIso("2026-02-30"));
    assert.equal(cal.hojeLocal(new Date(2026, 8, 30, 23, 59)), "2026-09-30");
  });
});

describe("com conta", () => {
  let c;
  let fulano;
  let genesys;

  beforeEach(() => {
    c = new Conta("2026-09-15");
    c.escrever((tx) => regras.salvarConfig(tx, {
      dia_fechamento: 29, dia_vencimento: 3, saldo_inicial: 1_000_00, data_inicio: "2026-09-01",
    }));
    fulano = c.escrever((tx) => regras.salvarDono(tx, { nome: "Fulano", tipo: "PESSOA", cor: "#22D3EE" }));
    genesys = c.escrever((tx) => regras.salvarDono(tx, { nome: "Genesys", tipo: "ORG", cor: "#FB923C" }));
  });

  describe("divisao", () => {
    test("sem divisao e tudo meu", () => {
      const id = c.compra();
      assert.deepEqual(c.partesDe(id).map((p) => [p.dono_id, p.valor]), [[c.eu, 100_00]]);
    });

    test("igual: o centavo extra vai para mim", () => {
      const id = c.compra({ divisao: { modo: "igual", donos: [fulano, genesys, c.eu] } });
      const partes = Object.fromEntries(c.partesDe(id).map((p) => [p.dono_id, p.valor]));
      assert.deepEqual(partes, { [c.eu]: 3334, [fulano]: 3333, [genesys]: 3333 });
    });

    test("por valor precisa fechar", () => {
      assert.throws(() => c.compra({ divisao: { modo: "valor", partes: [
        { dono_id: c.eu, valor: 50_00 }, { dono_id: fulano, valor: 49_99 }] } }), erro(/faltam R\$ 0,01/));
      assert.throws(() => c.compra({ divisao: { modo: "valor", partes: [
        { dono_id: c.eu, valor: 60_00 }, { dono_id: fulano, valor: 49_99 }] } }), erro(/sobram/));
    });

    test("terceiro sem mim", () => {
      const id = c.compra({ divisao: { modo: "igual", donos: [genesys] } });
      assert.deepEqual(c.partesDe(id).map((p) => [p.dono_id, p.valor]), [[genesys, 100_00]]);
    });

    test("parcelamento dividido proporcional", () => {
      const id = c.compra({ natureza: "PARCELAMENTO", valor: 1_000_00, num_parcelas: 3,
        divisao: { modo: "valor", partes: [{ dono_id: c.eu, valor: 600_00 }, { dono_id: fulano, valor: 400_00 }] } });
      const porDono = {};
      const porParcela = {};
      for (const p of c.partesDe(id)) {
        porDono[p.dono_id] = (porDono[p.dono_id] || 0) + p.valor;
        porParcela[p.parcela_num] = (porParcela[p.parcela_num] || 0) + p.valor;
      }
      assert.deepEqual(porDono, { [c.eu]: 600_00, [fulano]: 400_00 });
      assert.deepEqual(porParcela, { 1: 333_34, 2: 333_33, 3: 333_33 });
      assert.deepEqual([...new Set(c.partesDe(id).map((p) => p.fatura_ref))].sort(), ["2026-10", "2026-11", "2026-12"]);
    });

    test("parcela inicial", () => {
      const id = c.compra({ natureza: "PARCELAMENTO", valor: 1_200_00, num_parcelas: 12, parcela_inicial: 10 });
      assert.deepEqual(c.partesDe(id).map((p) => p.parcela_num), [10, 11, 12]);
    });

    test("parcelamento no fim do mes nao repete fatura", () => {
      const id = c.compra({ natureza: "PARCELAMENTO", valor: 300_00, num_parcelas: 3, data: "2027-01-30" });
      assert.deepEqual(c.partesDe(id).map((p) => p.fatura_ref), ["2027-03", "2027-04", "2027-05"]);
    });

    test("dono arquivado nao entra em compra nova", () => {
      c.escrever((tx) => regras.arquivarDono(tx, fulano, false));
      assert.throws(() => c.compra({ divisao: { modo: "igual", donos: [c.eu, fulano] } }), erro(/arquivado/));
    });

    test("editar compra de dono arquivado", () => {
      const id = c.compra({ divisao: { modo: "igual", donos: [c.eu, fulano] } });
      c.escrever((tx) => regras.arquivarDono(tx, fulano, false));
      c.compra({ descricao: "Editada", valor: 80_00, divisao: { modo: "igual", donos: [c.eu, fulano] } }, id);
      const partes = Object.fromEntries(c.partesDe(id).map((p) => [p.dono_id, p.valor]));
      assert.deepEqual(partes, { [c.eu]: 40_00, [fulano]: 40_00 });
    });

    test("entrada e sempre minha", () => {
      const id = c.compra({ fluxo: "ENTRADA", meio: "DEBITO", divisao: { modo: "igual", donos: [fulano] } });
      assert.deepEqual(c.partesDe(id).map((p) => p.dono_id), [c.eu]);
    });

    test("descricao obrigatoria", () => {
      assert.throws(() => c.compra({ descricao: "" }), erro(/^Informe a descrição\.$/));
    });
  });

  describe("fixos", () => {
    const refs = (id) => c.banco.onde("lancamento", (l) => l.compra_id === id).map((l) => l.ref).sort();

    test("gera ate dois meses a frente", () => {
      const id = c.compra({ natureza: "FIXO", valor: 55_90, data: "2026-08-05" });
      assert.deepEqual(refs(id), ["2026-08", "2026-09", "2026-10", "2026-11"]);
      fixarHoje("2027-01-02");
      c.escrever(() => {});
      assert.equal(refs(id).at(-1), "2027-03");
    });

    test("gera ate o mes visitado, com teto de 3 anos", () => {
      const id = c.compra({ natureza: "FIXO", valor: 55_90, data: "2026-09-05" });
      c.escrever((tx) => regras.garantirFixos(tx, "2027-02"));
      assert.equal(refs(id).at(-1), "2027-02");
      c.escrever((tx) => regras.garantirFixos(tx, "2099-01"));
      assert.equal(refs(id).at(-1), "2029-09");
      consultas.mes(c.banco, "2027-03");
    });

    test("pular mes nao volta", () => {
      const id = c.compra({ natureza: "FIXO", valor: 55_90, data: "2026-09-05" });
      const l = c.banco.onde("lancamento", (l) => l.compra_id === id && l.ref === "2026-10")[0];
      c.escrever((tx) => regras.pularMesFixo(tx, l.id));
      fixarHoje("2026-12-01");
      c.escrever(() => {});
      assert.ok(!refs(id).includes("2026-10"));
      assert.ok(refs(id).includes("2027-02"));
    });

    test("editar fixo mantem o passado", () => {
      const id = c.compra({ natureza: "FIXO", valor: 50_00, data: "2026-07-05", meio: "DEBITO" });
      c.compra({ descricao: "Aluguel", natureza: "FIXO", meio: "DEBITO", valor: 80_00, data: "2026-07-05",
        divisao: { modo: "igual", donos: [c.eu, fulano] } }, id);
      const valores = Object.fromEntries(c.banco.onde("lancamento", (l) => l.compra_id === id).map((l) => [l.ref, l.valor]));
      assert.equal(valores["2026-07"], 50_00);
      assert.equal(valores["2026-08"], 50_00);
      assert.equal(valores["2026-09"], 80_00);
      assert.equal(valores["2026-11"], 80_00);
    });

    test("encerrar", () => {
      const id = c.compra({ natureza: "FIXO", valor: 50_00, data: "2026-09-05" });
      c.escrever((tx) => regras.encerrarFixo(tx, id, "2026-10"));
      fixarHoje("2027-03-01");
      c.escrever(() => {});
      assert.deepEqual(refs(id), ["2026-09", "2026-10"]);
    });

    test("fixo dividido", () => {
      const id = c.compra({ natureza: "FIXO", valor: 100_01, data: "2026-09-05",
        divisao: { modo: "igual", donos: [c.eu, fulano] } });
      const pares = new Set(c.partesDe(id).map((p) => `${p.dono_id}:${p.valor}`));
      assert.deepEqual(pares, new Set([`${c.eu}:5001`, `${fulano}:5000`]));
    });
  });

  describe("saldo", () => {
    const saldo = () => consultas.conta(c.banco, Config.ler(c.banco)).saldo;

    test("credito nao move o saldo", () => {
      c.compra({ meio: "CREDITO", valor: 500_00 });
      assert.equal(saldo(), 1_000_00);
    });

    test("debito move so ate hoje", () => {
      c.compra({ meio: "DEBITO", valor: 100_00, data: "2026-09-10" });
      c.compra({ meio: "DEBITO", valor: 50_00, data: "2026-09-20" });
      assert.equal(saldo(), 900_00);
      assert.equal(consultas.conta(c.banco, Config.ler(c.banco)).a_sair_debito, 50_00);
    });

    test("antes do inicio nao conta", () => {
      c.compra({ meio: "DEBITO", valor: 100_00, data: "2026-08-31" });
      assert.equal(saldo(), 1_000_00);
    });

    test("divisao nao muda o saldo", () => {
      c.compra({ meio: "DEBITO", valor: 300_00, divisao: { modo: "igual", donos: [c.eu, fulano, genesys] } });
      assert.equal(saldo(), 700_00);
    });

    test("previsao por mes", () => {
      c.compra({ natureza: "FIXO", meio: "DEBITO", valor: 100_00, data: "2026-09-20" });
      c.compra({ meio: "CREDITO", valor: 200_00, data: "2026-09-10" }); // fatura 2026-10, vence 03/10
      const cfg = Config.ler(c.banco);
      const setembro = consultas.conta(c.banco, cfg, "2026-09");
      assert.equal(setembro.saldo, 1_000_00);
      assert.equal(setembro.previsao_fim_mes, 900_00);
      assert.equal(setembro.a_sair_mes, 100_00);
      const outubro = consultas.conta(c.banco, cfg, "2026-10");
      assert.equal(outubro.saldo, 1_000_00);
      assert.equal(outubro.a_sair_fatura, 200_00);
      assert.equal(outubro.a_sair_debito, 100_00);
      assert.equal(outubro.previsao_fim_mes, 1_000_00 - 100_00 - 100_00 - 200_00);
      c.escrever((tx) => regras.pagarFatura(tx, { fatura_ref: "2026-10", valor: 200_00, data: "2026-10-03" }));
      assert.equal(consultas.conta(c.banco, cfg, "2026-10").previsao_fim_mes, 600_00);
      const agosto = consultas.conta(c.banco, cfg, "2026-08");
      assert.ok(agosto.mes_passado);
      assert.equal(agosto.previsao_fim_mes, 1_000_00);
    });

    test("visao geral de outro mes", () => {
      c.compra({ valor: 100_00, data: "2026-10-05", divisao: { modo: "igual", donos: [c.eu, fulano] } });
      const v = consultas.visaoGeral(c.banco, "2026-10");
      assert.equal(v.mes_atual, false);
      assert.equal(v.fatura.ref, "2026-10");
      assert.deepEqual(Object.fromEntries(v.gastos_por_dono.map((g) => [g.dono.id, g.total])),
        { [c.eu]: 50_00, [fulano]: 50_00 });
    });

    test("pagamento e caixinhas", () => {
      c.escrever((tx) => regras.pagarFatura(tx, { fatura_ref: "2026-09", valor: 200_00, data: "2026-09-03" }));
      const rid = c.escrever((tx) => regras.salvarReserva(tx, { nome: "Reserva", tipo: "CAIXINHA", saldo_inicial: 50_00 }));
      const mov = (tipo, valor, data) => c.escrever((tx) => regras.criarMovReserva(tx, { reserva_id: rid, tipo, valor, data }));
      mov("DEPOSITO", 300_00, "2026-09-05");
      mov("SAQUE", 100_00, "2026-09-06");
      mov("RENDIMENTO", 1_23, "2026-09-07");
      assert.equal(saldo(), 1_000_00 - 200_00 - 300_00 + 100_00);
      assert.equal(consultas.reservas(c.banco).reservas[0].saldo, 50_00 + 300_00 - 100_00 + 1_23);
      assert.throws(() => mov("SAQUE", 999_00, "2026-09-08"), erro(/insuficiente/));
    });
  });

  describe("telas", () => {
    test("mes por dono", () => {
      c.compra({ valor: 300_00, divisao: { modo: "igual", donos: [c.eu, fulano, genesys] } });
      c.compra({ valor: 40_00, divisao: { modo: "igual", donos: [genesys] } });
      const m = consultas.mes(c.banco, "2026-09");
      assert.deepEqual(Object.fromEntries(m.abas.map((a) => [a.dono.id, a.total])),
        { [c.eu]: 100_00, [fulano]: 100_00, [genesys]: 140_00 });
      assert.equal(m.total_saidas, 340_00);
    });

    test("mes filtrado por credito ou debito", () => {
      c.compra({ meio: "CREDITO", valor: 300_00, divisao: { modo: "igual", donos: [c.eu, fulano] } });
      c.compra({ meio: "DEBITO", valor: 40_00, natureza: "FIXO", data: "2026-09-12" });
      c.compra({ meio: "DEBITO", valor: 10_00, divisao: { modo: "igual", donos: [fulano] } });
      c.compra({ fluxo: "ENTRADA", meio: "DEBITO", valor: 5_000_00 });
      const total = (m, dono) => m.abas.find((a) => a.dono.id === dono).total;

      const todos = consultas.mes(c.banco, "2026-09");
      const credito = consultas.mes(c.banco, "2026-09", "CREDITO");
      const debito = consultas.mes(c.banco, "2026-09", "DEBITO");
      assert.equal(total(todos, c.eu), 150_00 + 40_00);
      assert.equal(total(credito, c.eu), 150_00);
      assert.equal(total(debito, c.eu), 40_00);
      assert.equal(total(credito, fulano), 150_00);
      assert.equal(total(debito, fulano), 10_00);
      // grupos, categorias e contagem seguem o filtro
      const eu = debito.abas.find((a) => a.dono.id === c.eu);
      assert.equal(eu.grupos.FIXO.total, 40_00);
      assert.equal(eu.grupos.AVULSO.itens.length, 0);
      assert.equal(eu.quantidade, 1);
      assert.equal(eu.categorias.reduce((s, g) => s + g.valor, 0), 40_00);
      assert.ok(credito.abas.every((a) => Object.values(a.grupos).every((g) => g.itens.every((i) => i.meio === "CREDITO"))));
      // entradas nao sao filtradas
      assert.equal(credito.entradas.total, 5_000_00);
      assert.throws(() => consultas.mes(c.banco, "2026-09", "PIX"), ErroValidacao);
    });

    test("fatura por dono fecha com o total", () => {
      c.compra({ valor: 300_00, divisao: { modo: "igual", donos: [c.eu, fulano, genesys] } });
      c.compra({ valor: 99_99, natureza: "PARCELAMENTO", num_parcelas: 4, divisao: { modo: "igual", donos: [c.eu, fulano] } });
      const f = consultas.fatura(c.banco, "2026-10");
      assert.equal(soma(f.por_dono.map((g) => g.valor)), f.total);
      assert.equal(f.por_dono[0].dono_id, c.eu);
      assert.equal(f.status, "aberta");
      assert.equal(f.de_terceiros, f.total - f.por_dono[0].valor);
    });

    test("status da fatura", () => {
      c.compra({ valor: 100_00, data: "2026-08-10" }); // fatura 2026-09, vence 03/09
      assert.equal(consultas.fatura(c.banco, "2026-09").status, "vencida");
      c.escrever((tx) => regras.pagarFatura(tx, { fatura_ref: "2026-09", valor: 100_00, data: "2026-09-03" }));
      assert.equal(consultas.fatura(c.banco, "2026-09").status, "paga");
    });

    test("fatura antes do controle nao e pendencia", () => {
      c.compra({ valor: 100_00, data: "2026-07-10" });
      assert.equal(consultas.fatura(c.banco, "2026-08").status, "anterior");
      assert.equal(consultas.visaoGeral(c.banco).faturas_pendentes, 0);
    });

    test("visao geral roda", () => {
      c.compra({ valor: 100_00, divisao: { modo: "igual", donos: [c.eu, fulano] } });
      const v = consultas.visaoGeral(c.banco);
      assert.equal(v.fatura.ref, "2026-10");
      assert.equal(v.patrimonio, v.conta.saldo);
    });

    test("mudar o ciclo recalcula as faturas", () => {
      const id = c.compra({ valor: 100_00, data: "2026-09-10" });
      const config = (fech, venc) => c.escrever((tx) => regras.salvarConfig(tx, {
        dia_fechamento: fech, dia_vencimento: venc, saldo_inicial: 0, data_inicio: "2026-09-01" }));
      config(5, 15);
      assert.equal(c.partesDe(id)[0].fatura_ref, "2026-10");
      config(8, 15);
      assert.equal(c.partesDe(id)[0].fatura_ref, "2026-10");
    });
  });

  describe("donos e categorias", () => {
    test("nao exclui dono usado", () => {
      c.compra({ divisao: { modo: "igual", donos: [fulano] } });
      assert.throws(() => c.escrever((tx) => regras.excluirDono(tx, fulano)), erro(/Arquive/));
      c.escrever((tx) => regras.excluirDono(tx, genesys));
    });

    test("Eu e protegido", () => {
      assert.throws(() => c.escrever((tx) => regras.excluirDono(tx, c.eu)), ErroValidacao);
      assert.throws(() => c.escrever((tx) => regras.arquivarDono(tx, c.eu, false)), ErroValidacao);
    });

    test("nome unico sem diferenciar maiusculas", () => {
      assert.throws(() => c.escrever((tx) => regras.salvarDono(tx, { nome: "fulano", tipo: "PESSOA", cor: "#FFFFFF" })),
        erro(/Já existe/));
    });

    test("excluir categoria deixa a compra sem categoria", () => {
      const cat = c.escrever((tx) => regras.salvarCategoria(tx, { nome: "Pets", cor: "#66BB6A" }));
      const id = c.compra({ categoria_id: cat });
      c.escrever((tx) => regras.excluirCategoria(tx, cat));
      assert.equal(c.banco.obter("compra", id).categoria_id, null);
    });

    test("excluir compra leva parcelas e partes junto", () => {
      const id = c.compra({ natureza: "PARCELAMENTO", valor: 900_00, num_parcelas: 3, divisao: { modo: "igual", donos: [c.eu, fulano] } });
      c.escrever((tx) => regras.excluirCompra(tx, id));
      assert.equal(c.banco.quantas("lancamento"), 0);
      assert.equal(c.banco.quantas("lancamento_parte"), 0);
      assert.equal(c.banco.quantas("compra_parte"), 0);
    });
  });

  test("conta vazia so com o que a inicializacao cria", () => {
    const nova = new Conta("2026-09-15");
    assert.ok(regras.contaVazia(nova.banco));
    assert.ok(!regras.contaVazia(c.banco)); // tem terceiros
  });
});
