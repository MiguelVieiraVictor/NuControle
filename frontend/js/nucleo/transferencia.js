/* Entrada e saida de dados em bloco:

     - importar o banco do app desktop (nucontrole-v2.db), lido no proprio
       navegador com sql.js -- o arquivo nunca sai do aparelho;
     - backup: baixar tudo num .json e restaurar esse .json depois.

   Os dois caminhos terminam igual: linhas com ids NOVOS (UUID v7, gerados na
   ordem original para manter a ordem de criacao) e referencias traduzidas.
   Ids novos fazem a restauracao funcionar ate em outra conta. */

import { TABELAS, uuidv7 } from "./banco.js";
import { ErroValidacao } from "./base.js";

export const VERSAO_BACKUP = 1;

// Colunas aceitas em cada tabela (fora o id). Qualquer outra coisa e descartada.
const COLUNAS = {
  config: ["dia_fechamento", "dia_vencimento", "saldo_inicial", "data_inicio"],
  categoria: ["nome", "cor", "ativa"],
  dono: ["nome", "tipo", "cor", "ativo", "criado_em"],
  reserva: ["nome", "tipo", "saldo_inicial", "meta", "criada_em"],
  mov_reserva: ["reserva_id", "data", "tipo", "valor", "descricao", "criado_em"],
  compra: ["descricao", "fluxo", "natureza", "meio", "categoria_id", "valor", "data", "num_parcelas",
    "parcela_inicial", "dia", "inicio_ref", "fim_ref", "observacao", "criado_em"],
  compra_parte: ["compra_id", "dono_id", "valor"],
  lancamento: ["compra_id", "data", "ref", "valor", "fatura_ref", "parcela_num", "parcela_total"],
  lancamento_parte: ["lancamento_id", "dono_id", "valor"],
  fixo_gerado: ["compra_id", "ref"],
  pagamento_fatura: ["fatura_ref", "data", "valor", "criado_em"],
};

// Colunas que apontam para outra tabela.
const REFERENCIAS = {
  mov_reserva: { reserva_id: "reserva" },
  compra: { categoria_id: "categoria" },
  compra_parte: { compra_id: "compra", dono_id: "dono" },
  lancamento: { compra_id: "compra" },
  lancamento_parte: { lancamento_id: "lancamento", dono_id: "dono" },
  fixo_gerado: { compra_id: "compra" },
};

const comparaIdOriginal = (a, b) =>
  typeof a.id === "number" && typeof b.id === "number" ? a.id - b.id
    : String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;

/** {tabela: [linhas com ids antigos]} -> {tabela: [linhas com UUIDs novos]}.
    `mapas` (opcional) recebe, por tabela, id antigo -> id novo. */
export function comIdsNovos(dados, mapas = {}) {
  for (const t of TABELAS) mapas[t] = new Map();
  const saida = {};
  for (const tabela of TABELAS) {
    const linhas = [...(dados[tabela] || [])].sort(comparaIdOriginal);
    saida[tabela] = linhas.map((l) => {
      if (l.id === null || l.id === undefined) throw new ErroValidacao("Arquivo inconsistente (linha sem id).");
      if (mapas[tabela].has(l.id)) throw new ErroValidacao("Arquivo inconsistente (id repetido).");
      const novo = { id: uuidv7() };
      mapas[tabela].set(l.id, novo.id);
      for (const c of COLUNAS[tabela]) {
        let v = l[c] === undefined ? null : l[c];
        const alvo = REFERENCIAS[tabela]?.[c];
        if (alvo && v !== null) {
          v = mapas[alvo].get(v);
          if (!v) throw new ErroValidacao(`Arquivo inconsistente (${tabela} aponta para ${alvo} inexistente).`);
        }
        novo[c] = v;
      }
      return novo;
    });
  }
  if (saida.config.length !== 1) throw new ErroValidacao("Arquivo inconsistente (configuração ausente).");
  if (saida.dono.filter((d) => d.tipo === "EU").length !== 1) {
    throw new ErroValidacao("Arquivo inconsistente (dono “Eu” ausente).");
  }
  return saida;
}

function resumo(dados) {
  const ultimo = dados.compra.reduce((m, c) => (c.criado_em > m ? c.criado_em : m), "");
  return {
    compras: dados.compra.length,
    terceiros: dados.dono.filter((d) => d.tipo !== "EU").length,
    caixinhas: dados.reserva.length,
    ultimo_lancamento: ultimo || null,
  };
}

/* ------------------------------------------------------------------ app desktop (.db) */

const TABELAS_OBRIGATORIAS = ["config", "dono", "categoria", "reserva", "compra", "lancamento"];

/** Le o nucontrole-v2.db com sql.js. `SQL` e o modulo ja inicializado
    (initSqlJs). Devolve {resumo, dados} com ids novos, pronto para gravar. */
export function lerBancoDesktop(SQL, bytes) {
  let db;
  try {
    db = new SQL.Database(bytes);
  } catch {
    throw new ErroValidacao("Não consegui abrir esse arquivo.");
  }
  try {
    const consulta = (sql) => {
      const r = db.exec(sql);
      if (!r.length) return [];
      const { columns, values } = r[0];
      return values.map((v) => Object.fromEntries(columns.map((c, i) => [c, v[i]])));
    };

    let versao;
    let tabelas;
    try {
      versao = consulta("PRAGMA user_version")[0].user_version;
      tabelas = new Set(consulta("SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => r.name));
    } catch {
      throw new ErroValidacao("Esse arquivo não é um banco de dados do NuControle.");
    }
    if (!TABELAS_OBRIGATORIAS.every((t) => tabelas.has(t))) {
      if (tabelas.has("lancamento") && tabelas.has("reserva") && !tabelas.has("compra")) {
        throw new ErroValidacao("Esse é um banco da versão 1 do NuControle. Só o da versão 2 (nucontrole-v2.db) pode ser importado.");
      }
      throw new ErroValidacao("Esse arquivo não é um banco de dados do NuControle.");
    }
    if (versao > 1) throw new ErroValidacao("Esse banco foi feito por uma versão mais nova do NuControle.");
    if (consulta("PRAGMA integrity_check")[0].integrity_check !== "ok") {
      throw new ErroValidacao("O arquivo está corrompido.");
    }

    const cfg = Object.fromEntries(consulta("SELECT chave, valor FROM config").map((r) => [r.chave, r.valor]));
    const bool = (v) => !!v;
    const dados = {
      config: [{
        id: 1,
        dia_fechamento: Number(cfg.dia_fechamento),
        dia_vencimento: Number(cfg.dia_vencimento),
        saldo_inicial: Number(cfg.saldo_inicial),
        data_inicio: cfg.data_inicio,
      }],
      dono: consulta("SELECT * FROM dono").map((d) => ({ ...d, cor: d.cor.toUpperCase(), ativo: bool(d.ativo) })),
      categoria: consulta("SELECT * FROM categoria").map((c) => ({ ...c, cor: c.cor.toUpperCase(), ativa: bool(c.ativa) })),
      reserva: consulta("SELECT * FROM reserva"),
      mov_reserva: consulta("SELECT * FROM mov_reserva"),
      compra: consulta("SELECT * FROM compra"),
      // tabelas sem id proprio: o rowid guarda a ordem de criacao
      compra_parte: consulta("SELECT rowid AS id, * FROM compra_parte"),
      lancamento: consulta("SELECT * FROM lancamento"),
      lancamento_parte: consulta("SELECT rowid AS id, * FROM lancamento_parte"),
      fixo_gerado: consulta("SELECT rowid AS id, * FROM fixo_gerado"),
      pagamento_fatura: tabelas.has("pagamento_fatura") ? consulta("SELECT * FROM pagamento_fatura") : [],
    };
    const mapas = {};
    const novos = comIdsNovos(dados, mapas);
    return { resumo: resumo(novos), dados: novos, mapas };
  } finally {
    db.close();
  }
}

/* ------------------------------------------------------------------ backup (.json) */

export function gerarBackup(banco, agora = new Date()) {
  const dados = {};
  for (const t of TABELAS) {
    dados[t] = banco.linhas(t).map((l) => Object.fromEntries(["id", ...COLUNAS[t]].map((c) => [c, l[c] ?? null])));
  }
  return {
    app: "NuControle",
    tipo: "backup",
    versao: VERSAO_BACKUP,
    gerado_em: agora.toISOString(),
    dados,
  };
}

/** Le o texto de um backup .json. Devolve {resumo, gerado_em, dados} com ids novos. */
export function lerBackup(texto) {
  let b;
  try {
    b = JSON.parse(texto);
  } catch {
    throw new ErroValidacao("Esse arquivo não é um backup do NuControle.");
  }
  if (!b || b.app !== "NuControle" || b.tipo !== "backup" || typeof b.dados !== "object" || !b.dados) {
    throw new ErroValidacao("Esse arquivo não é um backup do NuControle.");
  }
  if (b.versao > VERSAO_BACKUP) throw new ErroValidacao("Esse backup foi feito por uma versão mais nova do NuControle.");
  for (const t of TABELAS) {
    if (b.dados[t] !== undefined && !Array.isArray(b.dados[t])) {
      throw new ErroValidacao("Esse arquivo não é um backup do NuControle.");
    }
  }
  const dados = comIdsNovos(b.dados);
  return { resumo: resumo(dados), gerado_em: b.gerado_em || null, dados };
}
