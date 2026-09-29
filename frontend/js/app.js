/* Estado global, navegacao e ciclo de renderizacao. */

const App = {
  estado: null,       // config, donos, categorias, hoje... (vem de api.estado)
  tela: "visao",
  ui: { mes: null, aba: 1, fatura: null, donoFatura: null },
  _geracao: 0,

  async iniciar() {
    try {
      await this.recarregarEstado();
    } catch (e) {
      $("#conteudo").innerHTML = `<div class="card vazio">Não foi possível abrir o banco de dados.<br><span class="nota">${esc(e.message)}</span></div>`;
      return;
    }
    this.ui.mes = this.estado.mes_atual;

    $("#nav").addEventListener("click", (ev) => {
      const b = ev.target.closest("[data-tela]");
      if (b) this.ir(b.dataset.tela);
    });
    $("#btn-novo").addEventListener("click", () => {
      const dono = this.tela === "gastos" && typeof this.ui.aba === "number" ? this.ui.aba : null;
      const fluxo = this.tela === "gastos" && this.ui.aba === "entradas" ? "ENTRADA" : "SAIDA";
      FormLancamento.abrir({ dono, fluxo }).catch((e) => avisar(e.message, "erro"));
    });
    $("#sel-mes-global").addEventListener("click", (ev) => {
      const b = ev.target.closest("[data-delta]");
      if (b) this.mudarMes(somarMes(this.ui.mes, Number(b.dataset.delta)));
    });
    $("#mes-hoje").addEventListener("click", () => this.mudarMes(this.estado.mes_atual));
    document.addEventListener("keydown", (ev) => {
      if ($("#modal").open) return;
      if (ev.key.toLowerCase() === "n" && ev.ctrlKey) {
        ev.preventDefault();
        $("#btn-novo").click();
      }
      // Ctrl+setas trocam o mes, exceto quando o foco esta num campo de texto
      const digitando = ev.target.closest && ev.target.closest("input, textarea, select");
      if (ev.ctrlKey && !digitando && (ev.key === "ArrowLeft" || ev.key === "ArrowRight")) {
        ev.preventDefault();
        this.mudarMes(somarMes(this.ui.mes, ev.key === "ArrowLeft" ? -1 : 1));
      }
    });
    this._desenharMes();
    this.ir("visao");
  },

  /** Troca o mes de TODAS as telas. No Cartao, vai para a fatura que vence
      nesse mes; voltando para o mes atual, volta para a fatura atual. */
  mudarMes(ref) {
    this.ui.mes = ref;
    this.ui.fatura = ref === this.estado.mes_atual ? null : ref;
    this.ui.donoFatura = null;
    this._desenharMes();
    this.recarregar();
  },

  _desenharMes() {
    const outro = this.ui.mes !== this.estado.mes_atual;
    $("#mes-global-nome").textContent = rotuloMes(this.ui.mes);
    $(".mes-global").classList.toggle("outro-mes", outro);
    $("#mes-hoje").hidden = !outro;
  },

  /** Data sugerida para um lancamento novo: hoje no mes atual, dia 1 nos outros. */
  dataPadrao() {
    return this.ui.mes === this.estado.mes_atual ? this.estado.hoje : `${this.ui.mes}-01`;
  },

  async recarregarEstado() {
    this.estado = await api.estado();
  },

  dono(id) {
    return this.estado.donos.find((d) => d.id === id) || { id, nome: "?", cor: "#78909C" };
  },

  ir(tela) {
    this.tela = tela;
    $$("#nav [data-tela]").forEach((b) => b.classList.toggle("ativo", b.dataset.tela === tela));
    this.recarregar();
  },

  /** Redesenha a tela atual. Cada desenho recebe um elemento NOVO, para que
      os listeners da renderizacao anterior morram junto com o elemento. */
  async recarregar() {
    const geracao = ++this._geracao;
    const antigo = $("#conteudo");
    const novo = antigo.cloneNode(false);
    try {
      await Telas[this.tela](novo);
      if (geracao !== this._geracao) return; // outra renderizacao comecou depois
      const rolagem = $(".principal").scrollTop;
      antigo.replaceWith(novo);
      $(".principal").scrollTop = rolagem;
    } catch (e) {
      if (geracao !== this._geracao) return;
      console.error(e);
      novo.innerHTML = `<div class="card vazio">Algo deu errado ao carregar esta tela.<br><span class="nota">${esc(e.message)}</span></div>`;
      antigo.replaceWith(novo);
    }
  },

  cabecalho(titulo, subtitulo = "", acoes = "") {
    $("#titulo").textContent = titulo;
    $("#subtitulo").textContent = subtitulo;
    $("#topo-acoes").innerHTML = acoes;
  },
};

document.addEventListener("DOMContentLoaded", () => App.iniciar());
