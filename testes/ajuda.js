/* Apoio dos testes: uma conta em memoria que grava como o app grava.

   Toda escrita passa pelo mesmo caminho do site -- Transacao -> diferenca()
   -> aplicarOps (a semantica do servidor) -- e confere que o resultado e
   identico ao da transacao. Assim cada teste tambem testa a diferenca. */

import assert from "node:assert/strict";
import { Banco, aplicarOps } from "../frontend/js/nucleo/banco.js";
import { fixarHoje, idEu } from "../frontend/js/nucleo/base.js";
import * as regras from "../frontend/js/nucleo/regras.js";

export class Conta {
  constructor(hoje = "2026-09-15") {
    fixarHoje(hoje);
    this.banco = new Banco();
    this.escrever((tx) => regras.inicializarConta(tx));
  }

  get eu() {
    return idEu(this.banco);
  }

  /** Roda `fn(tx)` como o app: gera fixos, calcula a diferenca e "envia". */
  escrever(fn) {
    const tx = this.banco.transacao();
    const r = fn(tx);
    if (tx.quantas("config")) regras.garantirFixos(tx);
    const ops = tx.diferenca();
    const servidor = aplicarOps(this.banco, ops);
    const local = tx.confirmar();
    assert.deepEqual(servidor.despejo(), local.despejo(), "a diferenca nao reproduz a transacao");
    this.banco = local;
    return r;
  }

  compra(campos = {}, id = null) {
    return this.escrever((tx) => regras.salvarCompra(tx, {
      descricao: "Teste", fluxo: "SAIDA", natureza: "AVULSO", meio: "CREDITO",
      valor: 100_00, data: "2026-09-10", ...campos,
    }, id));
  }

  /** [{parcela_num, dono_id, valor, fatura_ref}] da compra, como a consulta SQL antiga. */
  partesDe(compraId) {
    const b = this.banco;
    return b.onde("lancamento", (l) => l.compra_id === compraId)
      .sort((x, y) => (x.data < y.data ? -1 : x.data > y.data ? 1 : 0))
      .flatMap((l) => b.onde("lancamento_parte", (p) => p.lancamento_id === l.id)
        .sort((x, y) => (x.dono_id < y.dono_id ? -1 : 1))
        .map((p) => ({ parcela_num: l.parcela_num, dono_id: p.dono_id, valor: p.valor, fatura_ref: l.fatura_ref, ref: l.ref })));
  }
}
