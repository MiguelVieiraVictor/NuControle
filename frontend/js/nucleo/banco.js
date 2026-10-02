/* Os dados da conta em memoria, e como uma alteracao vira UMA chamada ao servidor.

   O app carrega todas as linhas do usuario uma vez (sao poucas: financas de
   uma pessoa) e calcula as telas aqui. Para gravar:

       const tx = banco.transacao();     // copia de trabalho
       tx.inserir(...) / tx.atualizar(...) / tx.apagar(...)
       const ops = tx.diferenca();       // o que mudou, em ordem segura
       await servidor.aplicar(ops);      // tudo ou nada (funcao public.aplicar)
       banco = tx.confirmar();           // so depois que o servidor aceitou

   Ids sao UUID v7 gerados aqui: comecam pelo instante da criacao, entao
   ordenar por id e ordenar por ordem de criacao (o "rowid" da versao SQLite).

   `aplicarOps` e a mesma semantica do servidor (cascata, contagem estrita)
   em memoria. Os testes e o modo local usam ela no lugar do Supabase. */

// Ordem dos pais para os filhos: insercoes seguem esta ordem, exclusoes a inversa.
export const TABELAS = [
  "config", "categoria", "dono", "reserva", "mov_reserva", "compra",
  "compra_parte", "lancamento", "lancamento_parte", "fixo_gerado", "pagamento_fatura",
];

// Chaves estrangeiras e o que acontece com o filho quando o pai e apagado.
const FKS = [
  { tabela: "mov_reserva", coluna: "reserva_id", pai: "reserva", aoApagar: "cascata" },
  { tabela: "compra", coluna: "categoria_id", pai: "categoria", aoApagar: "nulo" },
  { tabela: "compra", coluna: "reserva_id", pai: "reserva", aoApagar: "nulo" },
  { tabela: "compra_parte", coluna: "compra_id", pai: "compra", aoApagar: "cascata" },
  { tabela: "compra_parte", coluna: "dono_id", pai: "dono", aoApagar: "impedir" },
  { tabela: "lancamento", coluna: "compra_id", pai: "compra", aoApagar: "cascata" },
  { tabela: "lancamento_parte", coluna: "lancamento_id", pai: "lancamento", aoApagar: "cascata" },
  { tabela: "lancamento_parte", coluna: "dono_id", pai: "dono", aoApagar: "impedir" },
  { tabela: "fixo_gerado", coluna: "compra_id", pai: "compra", aoApagar: "cascata" },
];

/* ------------------------------------------------------------------ UUID v7 */

let ultimoMs = 0;
let sequencia = 0;

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

/** UUID v7: 48 bits de milissegundos + 12 bits de sequencia + aleatorio.
    Dentro do mesmo milissegundo a sequencia garante ordem crescente. */
export function uuidv7() {
  let ms = Date.now();
  if (ms <= ultimoMs) {
    sequencia += 1;
    if (sequencia > 0xfff) {
      ultimoMs += 1;
      sequencia = 0;
    }
    ms = ultimoMs;
  } else {
    ultimoMs = ms;
    sequencia = 0;
  }
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  let t = ms;
  for (let i = 5; i >= 0; i--) {
    b[i] = t % 256;
    t = Math.floor(t / 256);
  }
  b[6] = 0x70 | (sequencia >> 8);
  b[7] = sequencia & 0xff;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => HEX[x]).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function porId(a, b) {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/* ------------------------------------------------------------------ leitura */

class Leitura {
  linhas(tabela) {
    return [...this._t(tabela).values()];
  }

  obter(tabela, id) {
    return this._t(tabela).get(id) || null;
  }

  onde(tabela, filtro) {
    return this.linhas(tabela).filter(filtro);
  }

  quantas(tabela, filtro = () => true) {
    let n = 0;
    for (const l of this._t(tabela).values()) if (filtro(l)) n++;
    return n;
  }

  _t(tabela) {
    const t = this.t[tabela];
    if (!t) throw new Error(`tabela desconhecida: ${tabela}`);
    return t;
  }
}

/** Retrato imutavel dos dados. Toda alteracao passa por `transacao()`. */
export class Banco extends Leitura {
  /** dados: { tabela: [linhas] } -- tabelas ausentes ficam vazias. */
  constructor(dados = {}) {
    super();
    this.t = {};
    for (const nome of TABELAS) {
      const linhas = [...(dados[nome] || [])].sort(porId);
      this.t[nome] = new Map(linhas.map((l) => [l.id, Object.freeze({ ...l })]));
    }
    Object.freeze(this);
  }

  transacao() {
    return new Transacao(this);
  }

  /** As linhas de todas as tabelas, para backup e comparacao. */
  despejo() {
    return Object.fromEntries(TABELAS.map((n) => [n, this.linhas(n)]));
  }
}

class ErroConflito extends Error {}

/** Copia de trabalho de um Banco. Le o proprio estado (inclusive o que acabou
    de inserir), entao as regras podem gravar e reler como numa transacao SQL. */
export class Transacao extends Leitura {
  constructor(base) {
    super();
    this.base = base;
    this.t = {};
    for (const nome of TABELAS) this.t[nome] = new Map(base.t[nome]);
  }

  inserir(tabela, linha) {
    const id = linha.id || uuidv7();
    const t = this._t(tabela);
    if (t.has(id)) throw new ErroConflito(`id repetido em ${tabela}`);
    t.set(id, Object.freeze({ ...linha, id }));
    return id;
  }

  atualizar(tabela, id, campos) {
    const t = this._t(tabela);
    const atual = t.get(id);
    if (!atual) throw new ErroConflito(`${tabela} ${id} nao existe`);
    t.set(id, Object.freeze({ ...atual, ...campos, id }));
  }

  /** Apaga com as mesmas regras do Postgres: cascata, set null ou impede. */
  apagar(tabela, id) {
    const t = this._t(tabela);
    if (!t.has(id)) throw new ErroConflito(`${tabela} ${id} nao existe`);
    for (const fk of FKS) {
      if (fk.pai !== tabela) continue;
      for (const filho of this.linhas(fk.tabela)) {
        if (filho[fk.coluna] !== id) continue;
        if (fk.aoApagar === "cascata") this.apagar(fk.tabela, filho.id);
        else if (fk.aoApagar === "nulo") this.atualizar(fk.tabela, filho.id, { [fk.coluna]: null });
        else throw new ErroConflito(`${tabela} ${id} ainda e usado em ${fk.tabela}`);
      }
    }
    t.delete(id);
  }

  /** Apaga tudo de todas as tabelas (importacao e restauracao). */
  limpar() {
    for (const nome of TABELAS) this.t[nome].clear();
  }

  /** O que mudou desde a base, como operacoes para public.aplicar:

        1. exclusoes, dos filhos para os pais -- cada linha apagada e citada
           antes que a cascata do pai a leve, entao a contagem confere;
        2. insercoes, dos pais para os filhos;
        3. atualizacoes, so com os campos que mudaram.

     Exclusoes antes de insercoes: recriar um mes de fixo apaga a linha
     antiga de fixo_gerado antes de inserir a nova, sem violar o UNIQUE.
     Linhas com o mesmo conjunto de campos viram uma operacao so. */
  diferenca() {
    const ops = [];
    for (const nome of [...TABELAS].reverse()) {
      const ids = [];
      for (const id of this.base.t[nome].keys()) if (!this.t[nome].has(id)) ids.push(id);
      if (ids.length) ops.push({ op: "apagar", tabela: nome, ids });
    }
    for (const nome of TABELAS) {
      const novas = [];
      for (const [id, linha] of this.t[nome]) if (!this.base.t[nome].has(id)) novas.push(linha);
      ops.push(...agrupar("inserir", nome, novas));
    }
    for (const nome of TABELAS) {
      const mudadas = [];
      for (const [id, linha] of this.t[nome]) {
        const antes = this.base.t[nome].get(id);
        if (!antes || antes === linha) continue;
        const campos = {};
        for (const k of Object.keys(linha)) if (linha[k] !== antes[k]) campos[k] = linha[k];
        if (Object.keys(campos).length) mudadas.push({ id, ...campos });
      }
      ops.push(...agrupar("atualizar", nome, mudadas));
    }
    return ops;
  }

  /** O novo retrato, para usar depois que o servidor aceitou a diferenca. */
  confirmar() {
    return new Banco(Object.fromEntries(TABELAS.map((n) => [n, [...this.t[n].values()]])));
  }
}

function agrupar(op, tabela, linhas) {
  const grupos = new Map();
  for (const l of linhas) {
    const chave = Object.keys(l).sort().join(",");
    if (!grupos.has(chave)) grupos.set(chave, []);
    grupos.get(chave).push(l);
  }
  return [...grupos.values()].map((ls) => ({ op, tabela, linhas: ls }));
}

/** Aplica operacoes num Banco como o servidor faria: tudo ou nada, apagar e
    atualizar exigem que cada linha exista. Devolve o Banco novo. */
export function aplicarOps(banco, ops) {
  const tx = banco.transacao();
  for (const op of ops) {
    if (!TABELAS.includes(op.tabela)) throw new Error(`tabela invalida: ${op.tabela}`);
    if (op.op === "apagar") {
      for (const id of op.ids) tx.apagar(op.tabela, id);
    } else if (op.op === "inserir") {
      for (const l of op.linhas) tx.inserir(op.tabela, l);
    } else if (op.op === "atualizar") {
      for (const { id, ...campos } of op.linhas) tx.atualizar(op.tabela, id, campos);
    } else {
      throw new Error(`operacao invalida: ${op.op}`);
    }
  }
  return tx.confirmar();
}

export { ErroConflito };
