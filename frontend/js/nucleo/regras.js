/* Tudo que grava: compras (com divisao), donos, categorias, caixinhas,
   pagamentos de fatura e ajustes.

   Cada funcao recebe uma Transacao (ver banco.js), le e grava nela, e levanta
   ErroValidacao com mensagem pronta para o usuario ler. Nada aqui conhece a
   tela nem o Supabase.

   Como uma compra vira linhas:

       compra            o que voce digitou (descricao, total, parcelas, ...)
       compra_parte      quanto do total e de cada dono         (soma = total)
       lancamento        cada ocorrencia: a compra, cada parcela, cada mes do fixo
       lancamento_parte  quanto de CADA ocorrencia e de cada dono (soma = ocorrencia)

   A divisao por ocorrencia e gerada, nunca digitada: parcelas sao rateadas com
   `ratearMatriz`, que garante que a fatura e a parte de cada dono fechem no
   centavo ao mesmo tempo. */

import * as cal from "./calendario.js";
import { Config, ErroValidacao, hoje, idEu, ordemPartes } from "./base.js";
import { dividirIgual, formatarReais, parseCentavos, ratearMatriz } from "./dinheiro.js";

export const MAX_PARCELAS = 120;
export const MESES_A_FRENTE = 2; // fixos sao gerados ate 2 meses adiante (cobre a fatura aberta)
export const MAX_MESES_FIXOS = 36; // ...ou ate o mes que a tela pedir, no maximo 3 anos adiante

const FLUXOS = ["SAIDA", "ENTRADA"];
const NATUREZAS = ["AVULSO", "PARCELAMENTO", "FIXO"];
const MEIOS = ["CREDITO", "DEBITO"];

export const CATEGORIAS_PADRAO = [
  ["Alimentação", "#FF8A65"], ["Mercado", "#FFD54F"], ["Transporte", "#4DD0E1"],
  ["Assinaturas", "#B388FF"], ["Moradia", "#7986CB"], ["Saúde", "#EF5350"],
  ["Lazer", "#F06292"], ["Educação", "#4FC3F7"], ["Compras", "#9575CD"],
  ["Serviços", "#90A4AE"], ["Impostos", "#A1887F"], ["Salário", "#66BB6A"],
  ["Outros", "#78909C"],
];

/* ------------------------------------------------------------------ validacao */

function texto(dados, campo, rotulo, obrigatorio = true) {
  const valor = String(dados[campo] || "").trim();
  if (obrigatorio && !valor) throw new ErroValidacao(`Informe ${rotulo}.`);
  if (valor.length > 200) {
    throw new ErroValidacao(`${rotulo[0].toUpperCase()}${rotulo.slice(1)} muito longo (máx. 200 caracteres).`);
  }
  return valor;
}

function centavos(valor, rotulo, positivo = true) {
  let c;
  try {
    c = parseCentavos(valor);
  } catch {
    throw new ErroValidacao(`${rotulo} inválido.`);
  }
  if (positivo && c <= 0) throw new ErroValidacao(`${rotulo} precisa ser maior que zero.`);
  if (c < 0) throw new ErroValidacao(`${rotulo} não pode ser negativo.`);
  return c;
}

function data(valor, rotulo = "Data") {
  try {
    return cal.dataIso(valor);
  } catch {
    throw new ErroValidacao(`${rotulo} inválida.`);
  }
}

function inteiro(valor, rotulo, minimo, maximo) {
  const n = typeof valor === "string" && valor.trim() !== "" ? Number(valor) : valor;
  if (typeof n !== "number" || !Number.isInteger(n)) throw new ErroValidacao(`${rotulo} inválido.`);
  if (n < minimo || n > maximo) throw new ErroValidacao(`${rotulo} deve estar entre ${minimo} e ${maximo}.`);
  return n;
}

function opcao(valor, opcoes, rotulo) {
  if (!opcoes.includes(valor)) throw new ErroValidacao(`${rotulo} inválido.`);
  return valor;
}

function cor(valor) {
  const c = String(valor || "");
  if (!/^#[0-9A-Fa-f]{6}$/.test(c)) throw new ErroValidacao("Cor inválida.");
  return c.toUpperCase();
}

function mesRef(valor, mensagem) {
  try {
    cal.partes(valor);
  } catch {
    throw new ErroValidacao(mensagem);
  }
  return valor;
}

function existe(tx, tabela, id, rotulo) {
  const linha = typeof id === "string" ? tx.obter(tabela, id) : null;
  if (!linha) throw new ErroValidacao(`${rotulo} não encontrado(a).`);
  return linha;
}

/* ------------------------------------------------------------------ conta nova */

/** Primeiro acesso: configuracao padrao, o dono "Eu" e as categorias padrao. */
export function inicializarConta(tx) {
  const h = hoje();
  tx.inserir("config", {
    dia_fechamento: 29, dia_vencimento: 3, saldo_inicial: 0,
    data_inicio: `${cal.refDe(h)}-01`,
  });
  tx.inserir("dono", { nome: "Eu", tipo: "EU", cor: "#9085E9", ativo: true, criado_em: h });
  for (const [nome, c] of CATEGORIAS_PADRAO) tx.inserir("categoria", { nome, cor: c, ativa: true });
}

/** Conta sem nada alem do que `inicializarConta` cria: pode importar. */
export function contaVazia(db) {
  return db.quantas("compra") === 0
    && db.quantas("reserva") === 0
    && db.quantas("pagamento_fatura") === 0
    && db.quantas("dono", (d) => d.tipo !== "EU") === 0;
}

/* ------------------------------------------------------------------ divisao entre donos */

/** Transforma o que veio do formulario em [[dono_id, valor], ...].

    Dois modos:
      {modo: "igual", donos: [eu, a, b]}
          divide `total` igualmente; o centavo que sobra vai para quem vem
          primeiro, e "Eu" sempre vem primeiro.
      {modo: "valor", partes: [{dono_id, valor}, ...]}
          cada um com seu valor; a soma precisa bater EXATAMENTE com o total.

    Sem divisao = 100% de "Eu". */
export function resolverDivisao(tx, divisao, total, permitidosInativos = new Set()) {
  const eu = idEu(tx);
  divisao = divisao || { modo: "igual", donos: [eu] };
  const euPrimeiro = (a, b) => (a !== eu) - (b !== eu); // sort e estavel
  let pares;

  if (divisao.modo === "igual") {
    const ids = [...(divisao.donos || [])].map(String);
    if (!ids.length) throw new ErroValidacao("Escolha pelo menos um dono para o gasto.");
    if (new Set(ids).size !== ids.length) throw new ErroValidacao("Dono repetido na divisão.");
    ids.sort(euPrimeiro);
    if (total < ids.length) throw new ErroValidacao("Valor pequeno demais para dividir entre tantos donos.");
    const valores = dividirIgual(total, ids.length);
    pares = ids.map((id, i) => [id, valores[i]]);
  } else if (divisao.modo === "valor") {
    pares = (divisao.partes || []).map((p) => [String(p.dono_id), centavos(p.valor, "Valor da parte")]);
    if (!pares.length) throw new ErroValidacao("Informe a parte de cada dono.");
    if (new Set(pares.map(([d]) => d)).size !== pares.length) throw new ErroValidacao("Dono repetido na divisão.");
    const soma = pares.reduce((s, [, v]) => s + v, 0);
    if (soma !== total) {
      const dif = total - soma;
      throw new ErroValidacao(
        `A soma das partes não fecha com o total (${dif > 0 ? "faltam" : "sobram"} ${formatarReais(Math.abs(dif))}).`);
    }
    pares.sort((a, b) => euPrimeiro(a[0], b[0]));
  } else {
    throw new ErroValidacao("Modo de divisão inválido.");
  }

  for (const [donoId] of pares) {
    const dono = tx.obter("dono", donoId);
    if (!dono) throw new ErroValidacao("Dono da divisão não encontrado.");
    if (!dono.ativo && !permitidosInativos.has(donoId)) throw new ErroValidacao("Um dos donos está arquivado.");
  }
  return pares;
}

/* ------------------------------------------------------------------ compras */

function validarCompra(tx, dados, anteriores) {
  const fluxo = opcao(dados.fluxo ?? "SAIDA", FLUXOS, "Tipo");
  const natureza = opcao(dados.natureza ?? "AVULSO", NATUREZAS, "Natureza");
  const meio = opcao(dados.meio ?? "CREDITO", MEIOS, "Meio de pagamento");

  const c = {
    descricao: texto(dados, "descricao", "a descrição"),
    fluxo, natureza, meio,
    valor: centavos(dados.valor, "Valor"),
    data: data(dados.data),
    categoria_id: dados.categoria_id || null,
    observacao: texto(dados, "observacao", "a observação", false),
    num_parcelas: 1,
    parcela_inicial: 1,
    dia: null,
    inicio_ref: null,
    fim_ref: null,
  };

  if (c.categoria_id !== null) existe(tx, "categoria", c.categoria_id, "Categoria");

  if (fluxo === "ENTRADA") {
    if (natureza === "PARCELAMENTO") throw new ErroValidacao("Entrada não pode ser parcelada.");
    if (meio !== "DEBITO") throw new ErroValidacao("Entrada cai na conta, não no cartão.");
  }

  if (natureza === "PARCELAMENTO") {
    const n = inteiro(dados.num_parcelas, "Número de parcelas", 2, MAX_PARCELAS);
    const inicial = inteiro(dados.parcela_inicial ?? 1, "Parcela inicial", 1, n);
    if (c.valor < n) throw new ErroValidacao("Valor pequeno demais para tantas parcelas.");
    c.num_parcelas = n;
    c.parcela_inicial = inicial;
  }

  if (natureza === "FIXO") {
    c.dia = cal.partesData(c.data)[2];
    c.inicio_ref = cal.refDe(c.data);
    const fim = dados.fim_ref || null;
    if (fim !== null) {
      mesRef(fim, "Mês final inválido.");
      if (fim < c.inicio_ref) throw new ErroValidacao("O mês final é anterior ao início.");
    }
    c.fim_ref = fim;
  }

  // entrada e sempre sua
  const divisao = fluxo === "ENTRADA" ? { modo: "igual", donos: [idEu(tx)] } : dados.divisao;
  c.partes = resolverDivisao(tx, divisao, c.valor, anteriores);

  // Uma parcela precisa caber em cada dono: parcela de 1 centavo nao divide.
  if (natureza === "PARCELAMENTO" && c.partes.length > 1) {
    if (Math.floor(c.valor / c.num_parcelas) < c.partes.length) {
      throw new ErroValidacao("Parcela pequena demais para dividir entre tantos donos.");
    }
  }
  return c;
}

const CAMPOS_COMPRA = [
  "descricao", "fluxo", "natureza", "meio", "categoria_id", "valor", "data",
  "num_parcelas", "parcela_inicial", "dia", "inicio_ref", "fim_ref", "observacao",
];

/** Cria (compraId = null) ou edita uma compra e (re)gera suas ocorrencias.

    Editar um AVULSO ou PARCELAMENTO regenera tudo. Editar um FIXO vale a
    partir do mes atual: os meses que ja passaram ficam como estavam. */
export function salvarCompra(tx, dados, compraId = null) {
  const cfg = Config.ler(tx);
  let anteriores = new Set();
  let antiga = null;
  if (compraId) {
    antiga = existe(tx, "compra", compraId, "Lançamento");
    anteriores = new Set(tx.onde("compra_parte", (p) => p.compra_id === compraId).map((p) => p.dono_id));
  }

  const c = validarCompra(tx, dados, anteriores);
  if (antiga && antiga.natureza !== c.natureza) {
    throw new ErroValidacao("Não dá para mudar a natureza de um lançamento. Exclua e crie outro.");
  }

  const campos = Object.fromEntries(CAMPOS_COMPRA.map((k) => [k, c[k]]));
  if (!compraId) {
    compraId = tx.inserir("compra", { ...campos, criado_em: hoje() });
  } else {
    tx.atualizar("compra", compraId, campos);
    for (const p of tx.onde("compra_parte", (p) => p.compra_id === compraId)) tx.apagar("compra_parte", p.id);
    apagarOcorrenciasParaRegerar(tx, compraId, c);
  }

  for (const [donoId, valor] of c.partes) {
    tx.inserir("compra_parte", { compra_id: compraId, dono_id: donoId, valor });
  }
  gerar(tx, cfg, compraId);
  return compraId;
}

function apagarOcorrenciasParaRegerar(tx, compraId, c) {
  if (c.natureza !== "FIXO") {
    for (const l of tx.onde("lancamento", (l) => l.compra_id === compraId)) tx.apagar("lancamento", l.id);
    return;
  }
  // FIXO: o passado fica. Do mes atual em diante (ou fora da nova janela) regera.
  const corte = cal.refDe(hoje());
  const fim = c.fim_ref || "9999-12";
  const sai = (ref) => ref >= corte || ref < c.inicio_ref || ref > fim;
  for (const l of tx.onde("lancamento", (l) => l.compra_id === compraId && sai(l.ref))) tx.apagar("lancamento", l.id);
  for (const g of tx.onde("fixo_gerado", (g) => g.compra_id === compraId && sai(g.ref))) tx.apagar("fixo_gerado", g.id);
}

function inserirOcorrencia(tx, compraId, d, faturaRef, partes, parcela = null) {
  const lancamentoId = tx.inserir("lancamento", {
    compra_id: compraId,
    data: d,
    ref: cal.refDe(d),
    valor: partes.reduce((s, [, v]) => s + v, 0),
    fatura_ref: faturaRef,
    parcela_num: parcela ? parcela[0] : null,
    parcela_total: parcela ? parcela[1] : null,
  });
  for (const [donoId, valor] of partes) {
    tx.inserir("lancamento_parte", { lancamento_id: lancamentoId, dono_id: donoId, valor });
  }
}

/** Gera as ocorrencias que ainda nao existem para uma compra.
    `limite` so vale para FIXO: ultimo mes a gerar (padrao: limiteFixos()). */
function gerar(tx, cfg, compraId, limite = null) {
  const c = tx.obter("compra", compraId);
  const partes = tx.onde("compra_parte", (p) => p.compra_id === compraId)
    .sort(ordemPartes(idEu(tx)))
    .map((p) => [p.dono_id, p.valor]);
  const credito = c.meio === "CREDITO";

  if (c.natureza === "AVULSO") {
    inserirOcorrencia(tx, compraId, c.data, credito ? cfg.faturaDe(c.data) : null, partes);
  } else if (c.natureza === "PARCELAMENTO") {
    const n = c.num_parcelas;
    const inicial = c.parcela_inicial;
    const matriz = ratearMatriz(dividirIgual(c.valor, n), partes.map(([, v]) => v));
    const donos = partes.map(([d]) => d);
    const faturaBase = credito ? cfg.faturaDe(c.data) : null;
    const [a, m, dia] = cal.partesData(c.data);
    // `data` e a data da parcela `inicial`; as seguintes vem mes a mes.
    // A fatura e deslocada a partir da fatura base, e nao recalculada pela
    // data de cada parcela: 30/01 + 1 mes vira 28/02, que cairia de novo
    // na mesma fatura.
    for (let k = inicial; k <= n; k++) {
      const passo = k - inicial;
      const d = cal.clampDia(...cal.somarMeses(a, m, passo), dia);
      const fatura = credito ? cal.somarRef(faturaBase, passo) : null;
      inserirOcorrencia(tx, compraId, d, fatura, donos.map((dono, j) => [dono, matriz[k - 1][j]]), [k, n]);
    }
  } else {
    limite = limite || limiteFixos();
    const fim = c.fim_ref && c.fim_ref < limite ? c.fim_ref : limite;
    const gerados = new Set(tx.onde("fixo_gerado", (g) => g.compra_id === compraId).map((g) => g.ref));
    for (let ref = c.inicio_ref; ref <= fim; ref = cal.somarRef(ref, 1)) {
      if (gerados.has(ref)) continue;
      tx.inserir("fixo_gerado", { compra_id: compraId, ref });
      const d = cal.dataNoMes(ref, c.dia);
      inserirOcorrencia(tx, compraId, d, credito ? cfg.faturaDe(d) : null, partes);
    }
  }
}

/** Ate que mes os fixos sao gerados: 2 meses adiante, ou o mes pedido (se
    for mais longe), com teto de MAX_MESES_FIXOS para nao gerar decadas. */
export function limiteFixos(ateRef = null) {
  const atual = cal.refDe(hoje());
  let limite = cal.somarRef(atual, MESES_A_FRENTE);
  if (ateRef) {
    cal.partes(ateRef);
    const teto = cal.somarRef(atual, MAX_MESES_FIXOS);
    const pedido = ateRef < teto ? ateRef : teto;
    if (pedido > limite) limite = pedido;
  }
  return limite;
}

/** Gera os meses de fixos que ainda nao existem ate o limite.

    Roda a cada acao do app (para os meses que chegaram desde a ultima vez)
    e com `ateRef` quando a tela mostra um mes mais adiante: navegar ate
    dezembro faz o aluguel de dezembro aparecer. */
export function garantirFixos(tx, ateRef = null) {
  const limite = limiteFixos(ateRef);
  const gerados = new Set(tx.linhas("fixo_gerado").map((g) => `${g.compra_id}|${g.ref}`));
  const pendentes = tx.onde("compra", (c) => {
    if (c.natureza !== "FIXO" || c.inicio_ref > limite) return false;
    if (c.fim_ref !== null && c.fim_ref < c.inicio_ref) return false;
    const ultimo = c.fim_ref !== null && c.fim_ref < limite ? c.fim_ref : limite;
    return !gerados.has(`${c.id}|${ultimo}`);
  });
  if (!pendentes.length) return;
  const cfg = Config.ler(tx);
  for (const c of pendentes) gerar(tx, cfg, c.id, limite);
}

export function excluirCompra(tx, compraId) {
  existe(tx, "compra", compraId, "Lançamento");
  tx.apagar("compra", compraId);
}

/** Remove UM mes de um fixo. O mes nao volta a ser gerado sozinho. */
export function pularMesFixo(tx, lancamentoId) {
  const l = typeof lancamentoId === "string" ? tx.obter("lancamento", lancamentoId) : null;
  if (!l) throw new ErroValidacao("Lançamento não encontrado.");
  if (tx.obter("compra", l.compra_id).natureza !== "FIXO") {
    throw new ErroValidacao("Só dá para pular um mês de gasto fixo.");
  }
  tx.apagar("lancamento", lancamentoId);
}

/** Encerra o fixo no mes `fimRef` (inclusive). Meses depois dele somem. */
export function encerrarFixo(tx, compraId, fimRef) {
  const c = existe(tx, "compra", compraId, "Lançamento");
  if (c.natureza !== "FIXO") throw new ErroValidacao("Só gasto fixo pode ser encerrado.");
  mesRef(fimRef, "Mês final inválido.");
  if (fimRef < c.inicio_ref) {
    throw new ErroValidacao("O mês final é anterior ao início. Para apagar tudo, exclua o fixo.");
  }
  tx.atualizar("compra", compraId, { fim_ref: fimRef });
  for (const l of tx.onde("lancamento", (l) => l.compra_id === compraId && l.ref > fimRef)) tx.apagar("lancamento", l.id);
  for (const g of tx.onde("fixo_gerado", (g) => g.compra_id === compraId && g.ref > fimRef)) tx.apagar("fixo_gerado", g.id);
}

/* ------------------------------------------------------------------ donos (Eu + terceiros) */

export function salvarDono(tx, dados, donoId = null) {
  const nome = texto(dados, "nome", "o nome");
  const c = cor(dados.cor);
  let tipo = dados.tipo ?? "PESSOA";

  if (donoId) {
    const atual = existe(tx, "dono", donoId, "Terceiro");
    if (atual.tipo === "EU") tipo = "EU";
  }
  if (tipo !== "EU") tipo = opcao(tipo, ["PESSOA", "ORG"], "Tipo");
  else if (!donoId) throw new ErroValidacao("Tipo inválido.");

  const repetido = tx.linhas("dono").some((d) => d.nome.toLowerCase() === nome.toLowerCase() && d.id !== donoId);
  if (repetido) throw new ErroValidacao(`Já existe alguém chamado “${nome}”.`);

  if (!donoId) return tx.inserir("dono", { nome, tipo, cor: c, ativo: true, criado_em: hoje() });
  tx.atualizar("dono", donoId, { nome, tipo, cor: c });
  return donoId;
}

/** Arquivado some dos formularios, mas o historico dele continua. */
export function arquivarDono(tx, donoId, ativo) {
  const d = existe(tx, "dono", donoId, "Terceiro");
  if (d.tipo === "EU") throw new ErroValidacao("“Eu” não pode ser arquivado.");
  tx.atualizar("dono", donoId, { ativo: !!ativo });
}

export function excluirDono(tx, donoId) {
  const d = existe(tx, "dono", donoId, "Terceiro");
  if (d.tipo === "EU") throw new ErroValidacao("“Eu” não pode ser excluído.");
  const usado = tx.quantas("compra_parte", (p) => p.dono_id === donoId);
  if (usado) {
    throw new ErroValidacao(
      `Este terceiro está em ${usado} lançamento(s). Arquive em vez de excluir para manter o histórico.`);
  }
  tx.apagar("dono", donoId);
}

/* ------------------------------------------------------------------ categorias */

export function salvarCategoria(tx, dados, categoriaId = null) {
  const nome = texto(dados, "nome", "o nome");
  const c = cor(dados.cor);
  const repetida = tx.linhas("categoria").some((k) => k.nome.toLowerCase() === nome.toLowerCase() && k.id !== categoriaId);
  if (repetida) throw new ErroValidacao(`Já existe a categoria “${nome}”.`);
  if (!categoriaId) return tx.inserir("categoria", { nome, cor: c, ativa: true });
  existe(tx, "categoria", categoriaId, "Categoria");
  tx.atualizar("categoria", categoriaId, { nome, cor: c });
  return categoriaId;
}

/** Os lancamentos da categoria ficam "sem categoria", nao sao apagados. */
export function excluirCategoria(tx, categoriaId) {
  existe(tx, "categoria", categoriaId, "Categoria");
  tx.apagar("categoria", categoriaId);
}

/* ------------------------------------------------------------------ caixinhas e fundos */

export function salvarReserva(tx, dados, reservaId = null) {
  const nome = texto(dados, "nome", "o nome");
  const tipo = opcao(dados.tipo ?? "CAIXINHA", ["CAIXINHA", "FUNDO"], "Tipo");
  const saldoInicial = centavos(dados.saldo_inicial || 0, "Saldo inicial", false);
  const meta = [null, undefined, "", 0].includes(dados.meta) ? null : centavos(dados.meta, "Meta");
  if (!reservaId) {
    return tx.inserir("reserva", { nome, tipo, saldo_inicial: saldoInicial, meta, criada_em: hoje() });
  }
  existe(tx, "reserva", reservaId, "Caixinha");
  tx.atualizar("reserva", reservaId, { nome, tipo, saldo_inicial: saldoInicial, meta });
  return reservaId;
}

export function excluirReserva(tx, reservaId) {
  existe(tx, "reserva", reservaId, "Caixinha");
  tx.apagar("reserva", reservaId);
}

export function saldoReserva(tx, reservaId, ate = "9999-12-31") {
  const r = existe(tx, "reserva", reservaId, "Caixinha");
  return tx.onde("mov_reserva", (m) => m.reserva_id === reservaId && m.data <= ate)
    .reduce((s, m) => s + (m.tipo === "SAQUE" ? -m.valor : m.valor), r.saldo_inicial);
}

export function criarMovReserva(tx, dados) {
  const reservaId = dados.reserva_id;
  existe(tx, "reserva", reservaId, "Caixinha");
  const tipo = opcao(dados.tipo, ["DEPOSITO", "SAQUE", "RENDIMENTO"], "Movimentação");
  const valor = centavos(dados.valor, "Valor");
  const d = data(dados.data);
  if (tipo === "SAQUE") {
    // Confere contra o saldo com TODAS as movimentacoes, inclusive as de
    // datas futuras, para o saque nunca deixar a caixinha negativa.
    const disponivel = saldoReserva(tx, reservaId);
    if (valor > disponivel) {
      throw new ErroValidacao(`Saldo insuficiente na caixinha (disponível: ${formatarReais(disponivel)}).`);
    }
  }
  return tx.inserir("mov_reserva", {
    reserva_id: reservaId, data: d, tipo, valor,
    descricao: texto(dados, "descricao", "a descrição", false),
    criado_em: hoje(),
  });
}

export function excluirMovReserva(tx, movId) {
  existe(tx, "mov_reserva", movId, "Movimentação");
  tx.apagar("mov_reserva", movId);
}

/* ------------------------------------------------------------------ fatura */

export function pagarFatura(tx, dados) {
  const faturaRef = mesRef(String(dados.fatura_ref || ""), "Fatura inválida.");
  return tx.inserir("pagamento_fatura", {
    fatura_ref: faturaRef,
    data: data(dados.data),
    valor: centavos(dados.valor, "Valor"),
    criado_em: hoje(),
  });
}

export function excluirPagamento(tx, pagamentoId) {
  existe(tx, "pagamento_fatura", pagamentoId, "Pagamento");
  tx.apagar("pagamento_fatura", pagamentoId);
}

/* ------------------------------------------------------------------ ajustes */

export function salvarConfig(tx, dados) {
  const antes = Config.ler(tx);
  const novo = {
    dia_fechamento: inteiro(dados.dia_fechamento, "Dia de fechamento", 1, 31),
    dia_vencimento: inteiro(dados.dia_vencimento, "Dia de vencimento", 1, 31),
    saldo_inicial: centavos(dados.saldo_inicial || 0, "Saldo inicial", false),
    data_inicio: data(dados.data_inicio, "Data de início"),
  };
  if (novo.dia_fechamento === novo.dia_vencimento) {
    throw new ErroValidacao("Fechamento e vencimento não podem ser no mesmo dia.");
  }
  tx.atualizar("config", antes.id, novo);
  if (antes.dia_fechamento !== novo.dia_fechamento || antes.dia_vencimento !== novo.dia_vencimento) {
    recalcularFaturas(tx, Config.ler(tx));
  }
}

/** Mudou o ciclo do cartao: cada compra no credito vai para a fatura certa. */
function recalcularFaturas(tx, cfg) {
  for (const l of tx.linhas("lancamento")) {
    const c = tx.obter("compra", l.compra_id);
    if (c.meio !== "CREDITO") continue;
    const fatura = c.natureza === "PARCELAMENTO"
      ? cal.somarRef(cfg.faturaDe(c.data), l.parcela_num - c.parcela_inicial)
      : cfg.faturaDe(l.data);
    if (fatura !== l.fatura_ref) tx.atualizar("lancamento", l.id, { fatura_ref: fatura });
  }
}
