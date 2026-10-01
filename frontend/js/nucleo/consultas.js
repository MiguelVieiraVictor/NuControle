/* Tudo que le os dados e monta o que as telas mostram.

   Regras de saldo (as mesmas da versao desktop, que custaram bug para acertar):

     - Saldo e o REALIZADO, nao o previsto. Fixos e parcelas futuras ja existem
       nos dados, mas so mexem no saldo quando a data chega.
     - Compra no credito nao move o saldo: vira fatura, e o saldo so muda no dia
       em que a fatura e paga.
     - Nada antes da DATA DE INICIO (Ajustes) mexe no saldo, porque o saldo
       inicial que voce digitou ja continha esse passado.
     - O saldo sai inteiro da SUA conta mesmo quando a compra e dividida: a
       divisao diz de quem e o gasto, nao de onde saiu o dinheiro.

   Recebe sempre um Banco (retrato imutavel), entao os indices montados aqui
   valem enquanto aquele retrato existir. */

import * as cal from "./calendario.js";
import { Config, ErroValidacao, hoje, idEu, ordemPartes } from "./base.js";
import { porId } from "./banco.js";

const NATUREZAS = ["FIXO", "PARCELAMENTO", "AVULSO"];

const soma = (xs, f = (x) => x) => xs.reduce((s, x) => s + f(x), 0);
const comparar = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const porNome = (a, b) => a.nome.localeCompare(b.nome, "pt-BR", { sensitivity: "base" });

/* ------------------------------------------------------------------ indices */

const cache = new WeakMap();

/** Agrupamentos usados por varias consultas, montados uma vez por retrato. */
function indice(db) {
  let ix = cache.get(db);
  if (ix) return ix;
  const eu = idEu(db);
  const categorias = new Map(db.linhas("categoria").map((c) => [c.id, c]));
  const compras = new Map(db.linhas("compra").map((c) => [c.id, c]));

  const partesPorLanc = new Map();
  for (const p of db.linhas("lancamento_parte")) {
    if (!partesPorLanc.has(p.lancamento_id)) partesPorLanc.set(p.lancamento_id, []);
    partesPorLanc.get(p.lancamento_id).push(p);
  }
  for (const ps of partesPorLanc.values()) ps.sort(ordemPartes(eu));

  // Cada lancamento ja com os dados da compra e da categoria (o _SQL_LANC do SQLite).
  const lancs = db.linhas("lancamento").map((l) => {
    const c = compras.get(l.compra_id);
    const cat = c.categoria_id ? categorias.get(c.categoria_id) : null;
    return {
      id: l.id, compra_id: l.compra_id, data: l.data, ref: l.ref, valor: l.valor,
      fatura_ref: l.fatura_ref, parcela_num: l.parcela_num, parcela_total: l.parcela_total,
      descricao: c.descricao, fluxo: c.fluxo, natureza: c.natureza, meio: c.meio, fim_ref: c.fim_ref,
      categoria_id: c.categoria_id, categoria: cat ? cat.nome : null, categoria_cor: cat ? cat.cor : null,
    };
  });
  lancs.sort((a, b) => comparar(a.data, b.data) || porId(a, b));

  const agrupar = (lista, chave) => {
    const m = new Map();
    for (const x of lista) {
      const k = x[chave];
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(x);
    }
    return m;
  };

  ix = {
    eu,
    lancs,
    partesPorLanc,
    lancPorRef: agrupar(lancs, "ref"),
    lancPorFatura: agrupar(lancs.filter((l) => l.fatura_ref !== null), "fatura_ref"),
    pagPorFatura: agrupar(db.linhas("pagamento_fatura").sort((a, b) => comparar(a.data, b.data) || porId(a, b)), "fatura_ref"),
  };
  cache.set(db, ix);
  return ix;
}

/** Copia os lancamentos e anexa a cada um as partes [{dono_id, valor}] (so as > 0). */
function comPartes(db, lancs) {
  const { partesPorLanc } = indice(db);
  return lancs.map((l) => ({
    ...l,
    partes: (partesPorLanc.get(l.id) || [])
      .filter((p) => p.valor > 0)
      .map((p) => ({ dono_id: p.dono_id, valor: p.valor })),
  }));
}

/* ------------------------------------------------------------------ cadastros */

export function donos(db) {
  const usos = new Map();
  for (const p of db.linhas("compra_parte")) usos.set(p.dono_id, (usos.get(p.dono_id) || 0) + 1);
  return db.linhas("dono")
    .map((d) => ({ ...d, usos: usos.get(d.id) || 0 }))
    .sort((a, b) => (a.tipo !== "EU") - (b.tipo !== "EU") || b.ativo - a.ativo || porNome(a, b));
}

export function categorias(db) {
  return db.linhas("categoria").map((c) => ({ ...c })).sort(porNome);
}

export function estado(db) {
  const cfg = Config.ler(db);
  const h = hoje();
  return {
    hoje: h,
    mes_atual: cal.refDe(h),
    fatura_atual: cfg.faturaDe(h),
    config: cfg.json(),
    id_eu: idEu(db),
    donos: donos(db),
    categorias: categorias(db),
  };
}

/** Uma compra do jeito que o formulario de edicao precisa. */
export function compra(db, compraId) {
  const c = db.obter("compra", compraId);
  if (!c) throw new ErroValidacao("Lançamento não encontrado.");
  return {
    ...c,
    partes: db.onde("compra_parte", (p) => p.compra_id === compraId)
      .sort(ordemPartes(idEu(db)))
      .map((p) => ({ dono_id: p.dono_id, valor: p.valor })),
  };
}

/* ------------------------------------------------------------------ conta */

/** Soma dos lancamentos no debito com data em (desde, ate]. */
function lancDebito(db, fluxo, desde, ate) {
  return soma(indice(db).lancs.filter((l) =>
    l.fluxo === fluxo && l.meio === "DEBITO" && l.data > desde && l.data <= ate), (l) => l.valor);
}

/** Saldo da conta somando tudo que tem data entre o inicio e `ate`.

    Com `ate` = hoje e o saldo realizado. Com `ate` no futuro inclui o que ja
    esta agendado (fixos, parcelas no debito, pagamentos com data futura) --
    mas NAO as faturas ainda nao pagas; quem precisa delas soma a parte. */
function saldoAte(db, cfg, ate) {
  const desde = cal.somarDias(cfg.data_inicio, -1);
  const noPeriodo = (x) => x.data > desde && x.data <= ate;
  const movs = db.onde("mov_reserva", noPeriodo);
  const p = {
    entradas: lancDebito(db, "ENTRADA", desde, ate),
    saidas_debito: lancDebito(db, "SAIDA", desde, ate),
    pagamentos_fatura: soma(db.onde("pagamento_fatura", noPeriodo), (x) => x.valor),
    depositos: soma(movs.filter((m) => m.tipo === "DEPOSITO"), (m) => m.valor),
    saques: soma(movs.filter((m) => m.tipo === "SAQUE"), (m) => m.valor),
  };
  p.saldo = cfg.saldo_inicial + p.entradas - p.saidas_debito
    - p.pagamentos_fatura - p.depositos + p.saques;
  return p;
}

/** Saldo de hoje e o que acontece com ele no mes `ref` (padrao: o atual).

    Para o mes atual ou um mes futuro, `previsao_fim_mes` e o saldo de hoje mais
    tudo o que esta agendado ate o ultimo dia de `ref`, menos as faturas em
    aberto que vencem ate la. Para um mes que ja passou, e o saldo realizado no
    ultimo dia dele. */
export function conta(db, cfg, ref = null) {
  const h = hoje();
  ref = ref || cal.refDe(h);
  const [ano, m] = cal.partes(ref);
  const inicioMes = cal.iso(ano, m, 1);
  const fimMes = cal.clampDia(ano, m, 31);

  const atual = saldoAte(db, cfg, h);
  const passado = fimMes <= h;

  // O que mexe no saldo DENTRO do mes escolhido, a partir de hoje.
  const vespera = cal.somarDias(inicioMes, -1);
  const apos = h > vespera ? h : vespera;
  const aEntrar = passado ? 0 : lancDebito(db, "ENTRADA", apos, fimMes);
  const aSairDebito = passado ? 0 : lancDebito(db, "SAIDA", apos, fimMes);
  // A fatura e identificada pelo mes em que vence: a que vence em `ref` tem ref === ref.
  const faturaMes = resumoFatura(db, cfg, ref);
  const aSairFatura = passado || faturaMes.status === "anterior" ? 0 : faturaMes.restante;

  let previsao;
  if (passado) {
    previsao = saldoAte(db, cfg, fimMes).saldo;
  } else {
    // Toda fatura ainda devida que vence ate o fim do mes (inclusive vencidas).
    const emAberto = soma(faturas(db).filter((f) =>
      f.ref <= ref && ["aberta", "fechada", "vencida", "futura"].includes(f.status)), (f) => f.restante);
    previsao = saldoAte(db, cfg, fimMes).saldo - emAberto;
  }

  return {
    ...atual,
    ref,
    mes_passado: passado,
    a_entrar_mes: aEntrar,
    a_sair_mes: aSairDebito + aSairFatura,
    a_sair_debito: aSairDebito,
    a_sair_fatura: aSairFatura,
    previsao_fim_mes: previsao,
  };
}

/* ------------------------------------------------------------------ caixinhas e fundos */

export function reservas(db) {
  const lista = db.linhas("reserva")
    .sort((a, b) => comparar(a.tipo, b.tipo) || comparar(a.nome, b.nome))
    .map((r) => {
      const movs = db.onde("mov_reserva", (m) => m.reserva_id === r.id);
      const total = (t) => soma(movs.filter((m) => m.tipo === t), (m) => m.valor);
      const [dep, saq, rend] = ["DEPOSITO", "SAQUE", "RENDIMENTO"].map(total);
      return { ...r, depositado: dep, sacado: saq, rendimentos: rend, saldo: r.saldo_inicial + dep - saq + rend };
    });
  const nomes = new Map(db.linhas("reserva").map((r) => [r.id, r]));
  const movimentacoes = db.linhas("mov_reserva")
    .sort((a, b) => comparar(b.data, a.data) || porId(b, a))
    .slice(0, 200)
    .map((m) => ({ ...m, reserva_nome: nomes.get(m.reserva_id).nome, reserva_tipo: nomes.get(m.reserva_id).tipo }));
  return {
    reservas: lista,
    movimentacoes,
    total: soma(lista, (r) => r.saldo),
    total_caixinhas: soma(lista.filter((r) => r.tipo === "CAIXINHA"), (r) => r.saldo),
    total_fundos: soma(lista.filter((r) => r.tipo === "FUNDO"), (r) => r.saldo),
  };
}

/* ------------------------------------------------------------------ mes: uma aba por dono */

function porCategoria(itens, campoValor) {
  const grupos = new Map();
  for (const i of itens) {
    const chave = i.categoria_id;
    if (!grupos.has(chave)) {
      grupos.set(chave, {
        categoria_id: chave,
        nome: i.categoria || "Sem categoria",
        cor: i.categoria_cor || "#78909C",
        valor: 0,
      });
    }
    grupos.get(chave).valor += i[campoValor];
  }
  return [...grupos.values()].sort((a, b) => b.valor - a.valor);
}

/** Gastos do mes do calendario, separados por dono.

    Cada dono ve SO a parte dele de cada compra, com a informacao de com quem
    ela foi dividida. Uma compra de R$ 300 dividida em 3 aparece como R$ 100
    nas tres abas. */
export function mes(db, ref) {
  cal.partes(ref);
  const lancs = comPartes(db, indice(db).lancPorRef.get(ref) || []);
  const saidas = lancs.filter((l) => l.fluxo === "SAIDA");
  const entradas = lancs.filter((l) => l.fluxo === "ENTRADA");
  const h = hoje();

  const comGasto = new Set(saidas.flatMap((l) => l.partes.map((p) => p.dono_id)));
  const abas = [];
  for (const d of donos(db)) {
    if (!d.ativo && !comGasto.has(d.id)) continue;
    const itens = [];
    for (const l of saidas) {
      const minha = l.partes.find((p) => p.dono_id === d.id);
      if (minha && minha.valor) itens.push({ ...l, valor_dono: minha.valor, futuro: l.data > h });
    }
    const grupos = Object.fromEntries(NATUREZAS.map((n) => {
      const doGrupo = itens.filter((i) => i.natureza === n);
      return [n, { itens: doGrupo, total: soma(doGrupo, (i) => i.valor_dono) }];
    }));
    abas.push({
      dono: d,
      total: soma(itens, (i) => i.valor_dono),
      total_credito: soma(itens.filter((i) => i.meio === "CREDITO"), (i) => i.valor_dono),
      total_debito: soma(itens.filter((i) => i.meio === "DEBITO"), (i) => i.valor_dono),
      grupos,
      categorias: porCategoria(itens, "valor_dono"),
      quantidade: itens.length,
    });
  }

  return {
    ref,
    rotulo: cal.rotulo(ref),
    abas,
    total_saidas: soma(saidas, (l) => l.valor),
    entradas: {
      itens: entradas.map((l) => ({ ...l, futuro: l.data > h })),
      total: soma(entradas, (l) => l.valor),
    },
  };
}

/* ------------------------------------------------------------------ fatura: resumo por dono */

function status(total, pago, ciclo, cfg) {
  const h = hoje();
  if (total === 0 && pago === 0) return "vazia";
  if (total > 0 && pago >= total) return "paga";
  // Venceu antes de o controle comecar: ja foi paga fora do app, nao e pendencia.
  if (ciclo.vencimento < cfg.data_inicio) return "anterior";
  if (h < ciclo.inicio) return "futura";
  if (h <= ciclo.fechamento) return "aberta";
  if (h > ciclo.vencimento) return "vencida";
  return "fechada";
}

function resumoFatura(db, cfg, ref) {
  const ix = indice(db);
  const total = soma(ix.lancPorFatura.get(ref) || [], (l) => l.valor);
  const pago = soma(ix.pagPorFatura.get(ref) || [], (p) => p.valor);
  const ciclo = cfg.ciclo(ref);
  return {
    ...ciclo,
    total,
    pago,
    restante: Math.max(total - pago, 0),
    status: status(total, pago, ciclo, cfg),
  };
}

export function fatura(db, ref) {
  cal.partes(ref);
  const cfg = Config.ler(db);
  const ix = indice(db);
  const resumo = resumoFatura(db, cfg, ref);
  const itens = comPartes(db, ix.lancPorFatura.get(ref) || []);

  const porDono = new Map();
  for (const l of itens) {
    for (const p of l.partes) {
      if (!porDono.has(p.dono_id)) porDono.set(p.dono_id, { dono_id: p.dono_id, valor: 0, itens: 0 });
      const g = porDono.get(p.dono_id);
      g.valor += p.valor;
      g.itens += 1;
    }
  }
  const resumoDonos = [...porDono.values()].sort((a, b) =>
    (a.dono_id !== ix.eu) - (b.dono_id !== ix.eu) || b.valor - a.valor);

  return {
    ...resumo,
    itens,
    por_dono: resumoDonos,
    de_terceiros: soma(resumoDonos.filter((g) => g.dono_id !== ix.eu), (g) => g.valor),
    pagamentos: (ix.pagPorFatura.get(ref) || []).map((p) => ({ ...p })),
  };
}

/** Todas as faturas com algum lancamento ou pagamento, mais a atual e `incluir`. */
export function faturas(db, incluir = null) {
  const cfg = Config.ler(db);
  const ix = indice(db);
  const refs = new Set([cfg.faturaDe(hoje())]);
  if (incluir) {
    cal.partes(incluir);
    refs.add(incluir);
  }
  for (const r of ix.lancPorFatura.keys()) refs.add(r);
  for (const r of ix.pagPorFatura.keys()) refs.add(r);
  return [...refs].sort().map((r) => resumoFatura(db, cfg, r));
}

/* ------------------------------------------------------------------ visao geral */

/** Resumo do mes `ref` (padrao: o atual). O saldo e sempre o de hoje; a
    previsao, os gastos e a fatura em destaque sao os do mes escolhido. */
export function visaoGeral(db, ref = null) {
  const cfg = Config.ler(db);
  const h = hoje();
  const mesAtual = cal.refDe(h);
  ref = ref || mesAtual;
  const c = conta(db, cfg, ref);
  const res = reservas(db);
  const m = mes(db, ref);
  const eu = idEu(db);

  const pendentes = faturas(db).filter((f) => ["fechada", "vencida"].includes(f.status) && f.restante > 0);
  let destaque;
  if (ref === mesAtual) {
    // A fatura que pede atencao: a mais antiga fechada e nao paga; senao a aberta.
    destaque = pendentes.length ? pendentes[0].ref : cfg.faturaDe(h);
  } else {
    destaque = ref; // a fatura que vence no mes escolhido
  }
  const { itens, ...faturaDestaque } = fatura(db, destaque);

  const abaEu = m.abas.find((a) => a.dono.id === eu);
  return {
    ref,
    rotulo: cal.rotulo(ref),
    mes_atual: ref === mesAtual,
    conta: c,
    reservas: { total: res.total, total_caixinhas: res.total_caixinhas, total_fundos: res.total_fundos },
    patrimonio: c.saldo + res.total,
    fatura: faturaDestaque,
    faturas_pendentes: pendentes.length,
    gastos_por_dono: m.abas.filter((a) => a.total > 0).map((a) => ({ dono: a.dono, total: a.total })),
    total_gasto_mes: m.total_saidas,
    entradas_mes: m.entradas.total,
    categorias_eu: abaEu ? abaEu.categorias : [],
  };
}
