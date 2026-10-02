/* A API que as telas chamam (`api.visaoGeral(ref)`, `api.salvarCompra(...)`...).
   Os nomes sao os mesmos da versao desktop; por baixo, em vez de chamar o
   Python, roda as regras aqui e manda a diferenca para o servidor.

   Leituras e gravacoes passam por uma fila: uma de cada vez, sempre sobre o
   retrato mais recente. Assim, gerar os fixos do mes ao abrir uma tela nunca
   briga com um lancamento sendo salvo. */

import { Banco } from "./nucleo/banco.js";
import { ErroValidacao } from "./nucleo/base.js";
import * as consultas from "./nucleo/consultas.js";
import * as regras from "./nucleo/regras.js";
import { gerarBackup, lerBackup, lerBancoDesktop } from "./nucleo/transferencia.js";

export function criarApi(servidor) {
  let banco = null;
  let fila = Promise.resolve();

  function exclusivo(fn) {
    const p = fila.then(fn);
    fila = p.catch(() => {});
    return p;
  }

  async function recarregar() {
    banco = new Banco(await servidor.carregar());
  }

  /** Roda `fn(tx)`, gera os fixos ate `ateRef` e envia a diferenca.
      Se o servidor recusar por conflito, busca os dados de novo e, quando
      `repetir` (leituras), refaz uma vez sobre os dados novos. */
  async function gravar(fn, { ateRef = null, repetir = false } = {}) {
    for (let tentativa = 0; ; tentativa++) {
      const tx = banco.transacao();
      const r = fn(tx);
      regras.garantirFixos(tx, ateRef);
      const ops = tx.diferenca();
      if (ops.length) {
        try {
          await servidor.aplicar(ops);
        } catch (e) {
          if (e.recarregar) await recarregar().catch(() => {});
          if (e.recarregar && repetir && tentativa === 0) continue;
          throw e;
        }
      }
      banco = tx.confirmar();
      return r;
    }
  }

  const ler = (fn, ateRef = null) => exclusivo(async () => {
    await gravar(() => null, { ateRef, repetir: true });
    return fn(banco);
  });
  const escrever = (fn) => exclusivo(() => gravar(fn));

  // Arquivo escolhido para importar/restaurar, guardado entre a previa e a confirmacao.
  let pendente = null;

  return {
    /** Carrega a conta; no primeiro acesso cria configuracao, "Eu" e categorias. */
    iniciar: () => exclusivo(async () => {
      await recarregar();
      if (banco.quantas("config") === 0) {
        try {
          await gravar((tx) => regras.inicializarConta(tx));
        } catch (e) {
          // outro aparelho inicializou ao mesmo tempo: os dados ja foram recarregados
          if (!(e.recarregar && banco.quantas("config") > 0)) throw e;
        }
      }
    }),

    recarregarTudo: () => exclusivo(recarregar),

    /* -------------------------------------------------------- leitura */
    estado: () => ler((b) => consultas.estado(b)),
    visaoGeral: (ref = null) => ler((b) => consultas.visaoGeral(b, ref), ref),
    mes: (ref, meio = null) => ler((b) => consultas.mes(b, ref, meio), ref),
    faturas: (incluir = null) => ler((b) => consultas.faturas(b, incluir), incluir),
    fatura: (ref) => ler((b) => consultas.fatura(b, ref), ref),
    reservas: () => ler((b) => consultas.reservas(b)),
    compra: (id) => ler((b) => consultas.compra(b, id)),
    contaVazia: () => ler((b) => regras.contaVazia(b)),

    /* -------------------------------------------------------- compras */
    salvarCompra: (dados, id = null) => escrever((tx) => regras.salvarCompra(tx, dados, id || null)),
    excluirCompra: (id) => escrever((tx) => regras.excluirCompra(tx, id)),
    pularMesFixo: (lancamentoId) => escrever((tx) => regras.pularMesFixo(tx, lancamentoId)),
    encerrarFixo: (id, fimRef) => escrever((tx) => regras.encerrarFixo(tx, id, fimRef)),

    /* -------------------------------------------------------- donos e categorias */
    salvarDono: (dados, id = null) => escrever((tx) => regras.salvarDono(tx, dados, id || null)),
    arquivarDono: (id, ativo) => escrever((tx) => regras.arquivarDono(tx, id, ativo)),
    excluirDono: (id) => escrever((tx) => regras.excluirDono(tx, id)),
    salvarCategoria: (dados, id = null) => escrever((tx) => regras.salvarCategoria(tx, dados, id || null)),
    excluirCategoria: (id) => escrever((tx) => regras.excluirCategoria(tx, id)),

    /* -------------------------------------------------------- caixinhas */
    salvarReserva: (dados, id = null) => escrever((tx) => regras.salvarReserva(tx, dados, id || null)),
    excluirReserva: (id) => escrever((tx) => regras.excluirReserva(tx, id)),
    criarMovReserva: (dados) => escrever((tx) => regras.criarMovReserva(tx, dados)),
    excluirMovReserva: (id) => escrever((tx) => regras.excluirMovReserva(tx, id)),
    ajustarFundo: (dados) => escrever((tx) => regras.ajustarFundo(tx, dados)),
    registrarDividendo: (dados) => escrever((tx) => regras.registrarDividendo(tx, dados)),

    /* -------------------------------------------------------- fatura e ajustes */
    pagarFatura: (dados) => escrever((tx) => regras.pagarFatura(tx, dados)),
    excluirPagamento: (id) => escrever((tx) => regras.excluirPagamento(tx, id)),
    salvarConfig: (dados) => escrever((tx) => regras.salvarConfig(tx, dados)),

    /* -------------------------------------------------------- importar / backup */

    /** Le o nucontrole-v2.db do app desktop. So valida e resume; nada muda ainda. */
    async lerArquivoDesktop(arquivo) {
      const SQL = await carregarSqlJs();
      const lido = lerBancoDesktop(SQL, new Uint8Array(await arquivo.arrayBuffer()));
      pendente = { origem: "desktop", dados: lido.dados };
      return { nome: arquivo.name, ...lido.resumo };
    },

    /** Le um backup .json. So valida e resume; nada muda ainda. */
    async lerArquivoBackup(arquivo) {
      const lido = lerBackup(await arquivo.text());
      pendente = { origem: "backup", dados: lido.dados };
      return { nome: arquivo.name, gerado_em: lido.gerado_em, ...lido.resumo };
    },

    /** Troca TODOS os dados da conta pelos do arquivo lido. */
    substituirPeloArquivo: () => exclusivo(async () => {
      if (!pendente) throw new ErroValidacao("Escolha o arquivo de novo.");
      const { origem, dados } = pendente;
      if (origem === "desktop" && !regras.contaVazia(banco)) {
        throw new ErroValidacao("A importação do app antigo só pode ser feita com a conta vazia.");
      }
      await gravar((tx) => {
        tx.limpar();
        for (const [tabela, linhas] of Object.entries(dados)) for (const l of linhas) tx.inserir(tabela, l);
      });
      pendente = null;
    }),

    /** Todos os dados da conta, como texto JSON para baixar. */
    backup: () => exclusivo(async () => JSON.stringify(gerarBackup(banco))),
  };
}

let sqlJs = null;

/** sql.js (SQLite em WebAssembly) so e baixado quando alguem vai importar. */
function carregarSqlJs() {
  sqlJs ||= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "vendor/sql-wasm.js";
    s.onload = () => window.initSqlJs({ locateFile: (f) => `vendor/${f}` }).then(resolve, reject);
    s.onerror = () => reject(new Error("Não consegui carregar o leitor de arquivos. Verifique a internet."));
    document.head.appendChild(s);
  }).catch((e) => {
    sqlJs = null;
    throw e;
  });
  return sqlJs;
}
