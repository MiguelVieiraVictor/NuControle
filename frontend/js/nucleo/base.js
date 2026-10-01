/* Pecas comuns a regras e consultas: "hoje", configuracao, o dono "Eu" e o
   erro de validacao. */

import * as cal from "./calendario.js";

let hojeFixo = null;

/** A data de hoje para todo o app. Os testes congelam com `fixarHoje`. */
export function hoje() {
  return hojeFixo || cal.hojeLocal();
}

export function fixarHoje(data) {
  hojeFixo = data;
}

/** Erro que o usuario precisa ver, com mensagem em portugues. */
export class ErroValidacao extends Error {
  constructor(mensagem) {
    super(mensagem);
    this.name = "ErroValidacao";
  }
}

export class Config {
  constructor(linha) {
    this.id = linha.id;
    this.dia_fechamento = linha.dia_fechamento;
    this.dia_vencimento = linha.dia_vencimento;
    this.saldo_inicial = linha.saldo_inicial;
    this.data_inicio = linha.data_inicio;
  }

  static ler(db) {
    const [linha] = db.linhas("config");
    if (!linha) throw new ErroValidacao("Conta sem configuração. Recarregue a página.");
    return new Config(linha);
  }

  faturaDe(data) {
    return cal.faturaDe(data, this.dia_fechamento, this.dia_vencimento);
  }

  ciclo(ref) {
    return cal.ciclo(ref, this.dia_fechamento, this.dia_vencimento);
  }

  json() {
    return {
      dia_fechamento: this.dia_fechamento,
      dia_vencimento: this.dia_vencimento,
      saldo_inicial: this.saldo_inicial,
      data_inicio: this.data_inicio,
    };
  }
}

/** O id do dono "Eu" desta conta (o unico com tipo EU). */
export function idEu(db) {
  const eu = db.linhas("dono").find((d) => d.tipo === "EU");
  if (!eu) throw new ErroValidacao("Conta sem o dono “Eu”. Recarregue a página.");
  return eu.id;
}

/** Ordena partes como a versao SQLite: "Eu" primeiro, depois por criacao. */
export function ordemPartes(eu) {
  return (a, b) => (a.dono_id !== eu) - (b.dono_id !== eu) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
