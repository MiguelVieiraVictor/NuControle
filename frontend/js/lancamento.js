/* Formulario de lancamento: saida/entrada, avulso/parcelado/fixo e a
   DIVISAO entre donos (igual ou por valor).

   O front mostra a previa da divisao, mas quem decide e o back-end: ele
   recalcula tudo e recusa se a soma nao fechar no centavo. As funcoes
   dividirIgual/faturaDe abaixo sao espelhos das do Python, so para a previa. */

function dividirIgual(total, n) {
  const base = Math.floor(total / n);
  const resto = total - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < resto ? 1 : 0));
}

function faturaDe(iso, fech, venc) {
  const [a, m, d] = iso.split("-").map(Number);
  const ultimo = new Date(a, m, 0).getDate();
  let ref = `${a}-${String(m).padStart(2, "0")}`;
  if (d > Math.min(fech, ultimo)) ref = somarMes(ref, 1);
  return venc > fech ? ref : somarMes(ref, 1);
}

const FormLancamento = {
  f: null,

  async abrir({ compraId = null, fluxo = "SAIDA", dono = null } = {}) {
    let f = {
      id: null, fluxo, natureza: "AVULSO", meio: fluxo === "ENTRADA" ? "DEBITO" : "CREDITO",
      descricao: "", valor: 0, data: App.dataPadrao(), categoria_id: "",
      num_parcelas: 2, parcela_inicial: 1, fim_ref: "", observacao: "",
      donos: [dono || 1], modo: "igual", partes: {},
    };

    if (compraId) {
      const c = await api.compra(compraId);
      f = {
        ...f, ...c,
        categoria_id: c.categoria_id || "",
        fim_ref: c.fim_ref || "",
        // um fixo e editado a partir deste mes: a data sugerida continua sendo a do inicio
        donos: c.partes.map((p) => p.dono_id),
        partes: Object.fromEntries(c.partes.map((p) => [p.dono_id, p.valor])),
      };
      const iguais = JSON.stringify(dividirIgual(c.valor, c.partes.length)) ===
        JSON.stringify(c.partes.map((p) => p.valor));
      f.modo = iguais ? "igual" : "valor";
    }
    this.f = f;

    const editando = !!f.id;
    Modal.abrir({
      titulo: editando ? "Editar lançamento" : "Novo lançamento",
      corpo: this._html(),
      largura: "640px",
      botoes: [
        ...(editando ? [{ texto: "Excluir", classe: "btn-perigo", esquerda: true, acao: () => this._excluir() }] : []),
        { texto: "Cancelar", acao: "fechar" },
        { texto: editando ? "Salvar alterações" : "Lançar", classe: "btn-primario", acao: "salvar" },
      ],
      aoAbrir: (corpo) => this._ligar(corpo),
      aoSalvar: () => this._salvar(),
    });
  },

  _html() {
    const f = this.f;
    const E = App.estado;
    const cats = E.categorias.map((c) =>
      `<option value="${c.id}" ${String(c.id) === String(f.categoria_id) ? "selected" : ""}>${esc(c.nome)}</option>`).join("");
    const bloqueiaNat = !!f.id;
    const nat = (v, t) => `<button type="button" data-nat="${v}" ${bloqueiaNat && f.natureza !== v ? "disabled" : ""}>${t}</button>`;

    return `
      <div class="form">
        <div class="linha-campos">
          <div class="segmento largo" id="seg-fluxo">
            <button type="button" data-fluxo="SAIDA" ${bloqueiaNat && f.fluxo !== "SAIDA" ? "disabled" : ""}>Saída</button>
            <button type="button" data-fluxo="ENTRADA" ${bloqueiaNat && f.fluxo !== "ENTRADA" ? "disabled" : ""}>Entrada</button>
          </div>
          <div class="segmento largo" id="seg-nat">
            ${nat("AVULSO", "Avulso")}${nat("PARCELAMENTO", "Parcelado")}${nat("FIXO", "Fixo")}
          </div>
        </div>

        <label class="campo"><span>Descrição</span>
          <input class="input" id="f-desc" maxlength="200" value="${esc(f.descricao)}" placeholder="Ex.: Mercado, Netflix, Salário">
        </label>

        <div class="linha-campos">
          <label class="campo"><span id="rot-valor">Valor</span>
            <input class="input input-grande dinheiro" id="f-valor" inputmode="numeric" value="${f.valor ? textoDinheiro(f.valor) : ""}" placeholder="0,00">
          </label>
          <label class="campo"><span id="rot-data">Data</span>
            <input class="input" type="date" id="f-data" value="${esc(f.data)}">
          </label>
        </div>

        <div class="linha-campos">
          <div class="campo" id="bloco-meio"><span>Pagamento</span>
            <div class="segmento largo" id="seg-meio">
              <button type="button" data-meio="CREDITO">Crédito</button>
              <button type="button" data-meio="DEBITO">Débito / Pix</button>
            </div>
          </div>
          <label class="campo"><span>Categoria</span>
            <select class="input" id="f-cat"><option value="">Sem categoria</option>${cats}</select>
          </label>
        </div>

        <div class="linha-campos" id="bloco-parcelas">
          <label class="campo"><span>Nº de parcelas</span>
            <input class="input" type="number" min="2" max="120" id="f-np" value="${f.num_parcelas}">
          </label>
          <label class="campo"><span>Começa na parcela</span>
            <input class="input" type="number" min="1" id="f-pi" value="${f.parcela_inicial}">
            <small>Para compra já em andamento (ex.: 4 de 12).</small>
          </label>
        </div>

        <div class="linha-campos" id="bloco-fixo">
          <label class="campo"><span>Repete até (opcional)</span>
            <input class="input" type="month" id="f-fim" value="${esc(f.fim_ref)}">
            <small>Vazio = todo mês, até você encerrar.</small>
          </label>
        </div>

        <div class="previa" id="previa" hidden></div>

        <div class="divisao" id="bloco-divisao">
          <div class="divisao-topo">
            <span>${icone("dividir")} De quem é este gasto?</span>
            <div class="segmento" id="seg-modo">
              <button type="button" data-modo="igual">Igual</button>
              <button type="button" data-modo="valor">Por valor</button>
            </div>
          </div>
          <div class="chips-dono" id="chips-dono"></div>
          <div class="partes" id="partes"></div>
          <div class="soma-divisao" id="soma-divisao"></div>
        </div>

        <label class="campo"><span>Observação</span>
          <input class="input" id="f-obs" maxlength="200" value="${esc(f.observacao)}">
        </label>

        ${f.id && f.natureza === "FIXO" ? `<p class="nota alerta">Alterações num fixo valem a partir deste mês. Os meses que já passaram ficam como estavam.</p>` : ""}
      </div>`;
  },

  _ligar(corpo) {
    const f = this.f;
    mascararDinheiro($("#f-valor", corpo));

    const seg = (id, attr, chave) => {
      $(id, corpo).addEventListener("click", (ev) => {
        const b = ev.target.closest(`[data-${attr}]`);
        if (!b || b.disabled) return;
        f[chave] = b.dataset[attr];
        this._atualizar();
      });
    };
    seg("#seg-fluxo", "fluxo", "fluxo");
    seg("#seg-nat", "nat", "natureza");
    seg("#seg-meio", "meio", "meio");
    seg("#seg-modo", "modo", "modo");

    $("#f-valor", corpo).addEventListener("input", (e) => { f.valor = centavosDe(e.target.value); this._atualizarSoma(); this._previa(); if (f.modo === "igual") this._partes(); });
    $("#f-data", corpo).addEventListener("input", (e) => { f.data = e.target.value; this._previa(); });
    $("#f-np", corpo).addEventListener("input", (e) => { f.num_parcelas = parseInt(e.target.value, 10) || 0; this._previa(); });
    $("#f-pi", corpo).addEventListener("input", (e) => { f.parcela_inicial = parseInt(e.target.value, 10) || 0; this._previa(); });

    $("#chips-dono", corpo).addEventListener("click", (ev) => {
      const b = ev.target.closest("[data-dono]");
      if (!b) return;
      const id = Number(b.dataset.dono);
      if (f.donos.includes(id)) {
        if (f.donos.length === 1) return; // sempre fica pelo menos um
        f.donos = f.donos.filter((d) => d !== id);
      } else {
        f.donos.push(id);
      }
      this._atualizar();
    });

    $("#partes", corpo).addEventListener("input", (ev) => {
      const inp = ev.target.closest("[data-parte]");
      if (!inp) return;
      f.partes[inp.dataset.parte] = centavosDe(inp.value);
      this._atualizarSoma();
    });
    $("#partes", corpo).addEventListener("click", (ev) => {
      const b = ev.target.closest("[data-resto]");
      if (!b) return;
      const id = Number(b.dataset.resto);
      const outros = f.donos.filter((d) => d !== id).reduce((s, d) => s + (f.partes[d] || 0), 0);
      f.partes[id] = Math.max(f.valor - outros, 0);
      this._partes();
    });

    this._atualizar();
  },

  /** Donos que podem aparecer: ativos + os que ja estao nesta compra. */
  _donosDisponiveis() {
    return App.estado.donos.filter((d) => d.ativo || this.f.donos.includes(d.id));
  },

  _ordemDonos() {
    // mesma ordem do back-end: "Eu" primeiro, depois na ordem da lista
    const disp = this._donosDisponiveis().map((d) => d.id);
    return [...this.f.donos].sort((a, b) => (a !== 1) - (b !== 1) || disp.indexOf(a) - disp.indexOf(b));
  },

  _atualizar() {
    const f = this.f;
    const corpo = $("#modal-corpo");
    if (f.fluxo === "ENTRADA") {
      if (f.natureza === "PARCELAMENTO") f.natureza = "AVULSO";
      f.meio = "DEBITO";
      f.donos = [1];
    }
    const marca = (sel, attr, v) => $$(`${sel} [data-${attr}]`, corpo).forEach((b) => b.classList.toggle("ativo", b.dataset[attr] === v));
    marca("#seg-fluxo", "fluxo", f.fluxo);
    marca("#seg-nat", "nat", f.natureza);
    marca("#seg-meio", "meio", f.meio);
    marca("#seg-modo", "modo", f.modo);

    $('[data-nat="PARCELAMENTO"]', corpo).hidden = f.fluxo === "ENTRADA";
    $("#bloco-meio", corpo).hidden = f.fluxo === "ENTRADA";
    $("#bloco-divisao", corpo).hidden = f.fluxo === "ENTRADA";
    $("#bloco-parcelas", corpo).hidden = f.natureza !== "PARCELAMENTO";
    $("#bloco-fixo", corpo).hidden = f.natureza !== "FIXO";
    $("#seg-modo", corpo).hidden = f.donos.length < 2;

    $("#rot-valor", corpo).textContent =
      f.natureza === "PARCELAMENTO" ? "Valor total da compra" : f.natureza === "FIXO" ? "Valor por mês" : "Valor";
    $("#rot-data", corpo).textContent =
      f.natureza === "PARCELAMENTO" ? (f.parcela_inicial > 1 ? "Data desta parcela" : "Data da compra")
        : f.natureza === "FIXO" ? "Primeiro mês (e dia de cobrança)" : "Data";

    $("#chips-dono", corpo).innerHTML = this._donosDisponiveis().map((d) => `
      <button type="button" class="chip-dono ${f.donos.includes(d.id) ? "ativo" : ""}" data-dono="${d.id}">
        <span class="ponto" style="background:${esc(d.cor)}"></span>${esc(d.nome)}
      </button>`).join("");

    this._partes();
    this._previa();
  },

  _partes() {
    const f = this.f;
    const el = $("#partes");
    if (f.donos.length < 2) {
      el.innerHTML = "";
      $("#soma-divisao").innerHTML = "";
      return;
    }
    const nomes = Object.fromEntries(App.estado.donos.map((d) => [d.id, d]));
    const ordem = this._ordemDonos();
    const iguais = f.valor ? dividirIgual(f.valor, ordem.length) : ordem.map(() => 0);

    el.innerHTML = ordem.map((id, i) => {
      const d = nomes[id];
      const nome = `<span class="nome"><span class="ponto" style="background:${esc(d.cor)}"></span>${esc(d.nome)}</span>`;
      if (f.modo === "igual") return `<div class="parte">${nome}<span class="valor-fixo">${reais(iguais[i])}</span></div>`;
      const v = f.partes[id] || 0;
      return `<div class="parte">${nome}
        <div style="display:flex;gap:4px">
          <input class="input dinheiro" data-parte="${id}" inputmode="numeric" value="${v ? textoDinheiro(v) : ""}" placeholder="0,00">
          <button type="button" class="btn-icone" data-resto="${id}" data-dica="Completar com o que falta">${icone("pular")}</button>
        </div></div>`;
    }).join("");
    $$("[data-parte]", el).forEach(mascararDinheiro);
    this._atualizarSoma();
  },

  _atualizarSoma() {
    const f = this.f;
    const el = $("#soma-divisao");
    if (!el || f.donos.length < 2) return;
    const porParcela = f.natureza === "PARCELAMENTO"
      ? "Cada parcela é dividida na mesma proporção." : f.natureza === "FIXO" ? "Vale para cada mês." : "";
    if (f.modo === "igual") {
      el.className = "soma-divisao";
      el.innerHTML = `<span>Dividido igualmente entre ${f.donos.length}. ${porParcela}</span>`;
      return;
    }
    const soma = f.donos.reduce((s, d) => s + (f.partes[d] || 0), 0);
    const dif = f.valor - soma;
    el.className = `soma-divisao ${dif === 0 && f.valor ? "ok" : "erro"}`;
    el.innerHTML = `<span>${porParcela}</span><span>Soma ${reais(soma)} de ${reais(f.valor)}${
      dif > 0 ? ` · faltam ${reais(dif)}` : dif < 0 ? ` · sobram ${reais(-dif)}` : " ✓"}</span>`;
  },

  _previa() {
    const f = this.f;
    const el = $("#previa");
    const cfg = App.estado.config;
    let txt = "";
    if (f.natureza === "PARCELAMENTO" && f.valor && f.num_parcelas >= 2 && f.data) {
      const p = dividirIgual(f.valor, f.num_parcelas);
      const n = f.num_parcelas - f.parcela_inicial + 1;
      const valorTxt = p[0] === p[p.length - 1] ? `${f.num_parcelas}x de ${reais(p[0])}`
        : `${f.num_parcelas}x de ${reais(p[p.length - 1])} (a 1ª de ${reais(p[0])})`;
      if (n >= 1) {
        const ini = f.meio === "CREDITO" ? faturaDe(f.data, cfg.dia_fechamento, cfg.dia_vencimento) : f.data.slice(0, 7);
        const fim = somarMes(ini, n - 1);
        const onde = f.meio === "CREDITO" ? "faturas" : "meses";
        txt = `${valorTxt}. Serão lançadas ${n} parcela(s): ${onde} de ${rotuloMesCurto(ini)} a ${rotuloMesCurto(fim)}.`;
      }
    } else if (f.natureza === "AVULSO" && f.meio === "CREDITO" && f.fluxo === "SAIDA" && f.data) {
      const r = faturaDe(f.data, cfg.dia_fechamento, cfg.dia_vencimento);
      txt = `Cai na fatura de ${rotuloMes(r)}.`;
    } else if (f.natureza === "FIXO" && f.data) {
      txt = `Todo dia ${Number(f.data.slice(8))}, a partir de ${rotuloMes(f.data.slice(0, 7))}.`;
    }
    el.hidden = !txt;
    el.textContent = txt;
  },

  async _salvar() {
    const f = this.f;
    f.descricao = $("#f-desc").value;
    f.categoria_id = $("#f-cat").value;
    f.fim_ref = $("#f-fim").value;
    f.observacao = $("#f-obs").value;

    const ordem = this._ordemDonos();
    const divisao = f.donos.length < 2 || f.modo === "igual"
      ? { modo: "igual", donos: ordem }
      : { modo: "valor", partes: ordem.map((d) => ({ dono_id: d, valor: f.partes[d] || 0 })) };

    await api.salvarCompra({
      descricao: f.descricao, fluxo: f.fluxo, natureza: f.natureza, meio: f.meio,
      valor: f.valor, data: f.data, categoria_id: f.categoria_id ? Number(f.categoria_id) : null,
      num_parcelas: f.num_parcelas, parcela_inicial: f.parcela_inicial,
      fim_ref: f.fim_ref || null, observacao: f.observacao, divisao,
    }, f.id);
    avisar(f.id ? "Lançamento atualizado." : "Lançamento registrado.");
    App.recarregar();
  },

  async _excluir() {
    const f = this.f;
    const extra = f.natureza === "PARCELAMENTO" ? " Todas as parcelas serão removidas."
      : f.natureza === "FIXO" ? " Todos os meses deste fixo, inclusive os passados, serão removidos." : "";
    const id = f.id;
    if (!(await confirmar("Excluir lançamento", `Excluir “${esc(f.descricao)}”?${extra}`, { botao: "Excluir" }))) return;
    try {
      await api.excluirCompra(id);
      avisar("Lançamento excluído.");
      App.recarregar();
    } catch (e) { avisar(e.message, "erro"); }
  },
};
