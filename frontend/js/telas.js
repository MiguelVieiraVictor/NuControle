/* As seis telas. Cada uma recebe o elemento de conteudo, busca seus dados na
   api (js/api.js) e desenha. Nenhuma guarda estado proprio alem do que esta em App.ui. */

const NATUREZA_ROTULO = { FIXO: "Fixos", PARCELAMENTO: "Parcelamentos", AVULSO: "Avulsos" };
const STATUS_ROTULO = { aberta: "Aberta", fechada: "Fechada", vencida: "Vencida", paga: "Paga", vazia: "Sem gastos", anterior: "Antes do controle", futura: "Futura" };

function statusFatura(s) {
  return `<span class="status status-${s}">${STATUS_ROTULO[s] || s}</span>`;
}

/** "2026-10" -> "Outubro" */
function nomeMes(ref) {
  return MESES[Number(ref.slice(5)) - 1];
}

function chipsDivisao(partes, destacar = null) {
  if (!partes || partes.length < 2) return "";
  return `<div class="chips-divisao">${partes.map((p) => {
    const d = App.dono(p.dono_id);
    return `<span class="tag" ${destacar === p.dono_id ? 'style="color:var(--texto)"' : ""}
      data-dica="${esc(`${esc(d.nome)}: ${reais(p.valor)}`)}"><span class="ponto" style="background:${esc(d.cor)}"></span>${esc(d.nome)}</span>`;
  }).join("")}</div>`;
}

function tagMeio(meio) {
  return meio === "CREDITO" ? `<span class="tag tag-credito">Crédito</span>` : `<span class="tag tag-debito">Débito/Pix</span>`;
}

function descricaoLanc(l) {
  const sub = [l.categoria || "Sem categoria"];
  if (l.parcela_num) sub.push(`parcela ${l.parcela_num}/${l.parcela_total}`);
  if (l.futuro) sub.push("previsto");
  return `<span class="desc">${esc(l.descricao)}<small>${esc(sub.join(" · "))}</small></span>`;
}

function acoesLanc(l) {
  let h = `<button class="btn-icone" data-editar="${l.compra_id}" data-dica="Editar">${icone("editar")}</button>`;
  if (l.natureza === "FIXO") {
    h += `<button class="btn-icone" data-pular="${l.id}" data-dica="Pular este mês">${icone("pular")}</button>`;
    h += `<button class="btn-icone" data-encerrar="${l.compra_id}" data-ref="${l.ref}" data-dica="Encerrar neste mês">${icone("fim")}</button>`;
  }
  h += `<button class="btn-icone perigo" data-excluir="${l.compra_id}" data-nome="${esc(l.descricao)}" data-nat="${l.natureza}" data-dica="Excluir">${icone("lixo")}</button>`;
  return h;
}

/** Liga os botoes de acao de lancamentos dentro de `el`. */
function ligarAcoesLanc(el) {
  el.addEventListener("click", async (ev) => {
    const b = ev.target.closest("[data-editar],[data-pular],[data-encerrar],[data-excluir]");
    if (!b) return;
    try {
      if (b.dataset.editar) return FormLancamento.abrir({ compraId: b.dataset.editar });
      if (b.dataset.pular) {
        if (!(await confirmar("Pular este mês", "Remover só este mês do gasto fixo? Os outros meses continuam.", { botao: "Pular mês" }))) return;
        await api.pularMesFixo(b.dataset.pular);
        avisar("Mês removido do fixo.");
      } else if (b.dataset.encerrar) {
        if (!(await confirmar("Encerrar fixo", `O fixo termina em ${rotuloMes(b.dataset.ref)}. Os meses seguintes serão removidos.`, { botao: "Encerrar" }))) return;
        await api.encerrarFixo(b.dataset.encerrar, b.dataset.ref);
        avisar("Fixo encerrado.");
      } else if (b.dataset.excluir) {
        const extra = b.dataset.nat === "PARCELAMENTO" ? " Todas as parcelas serão removidas."
          : b.dataset.nat === "FIXO" ? " Todos os meses do fixo, inclusive os passados, serão removidos." : "";
        if (!(await confirmar("Excluir lançamento", `Excluir “${esc(b.dataset.nome)}”?${extra}`, { botao: "Excluir" }))) return;
        await api.excluirCompra(b.dataset.excluir);
        avisar("Lançamento excluído.");
      }
      App.recarregar();
    } catch (e) { avisar(e.message, "erro"); }
  });
}

const Telas = {
  /* ============================================================ Visao geral */
  async visao(el) {
    const v = await api.visaoGeral(App.ui.mes);
    const vazia = await api.contaVazia();
    App.cabecalho("Visão geral", v.mes_atual ? v.rotulo : `${v.rotulo} · saldo e caixinhas são os de hoje`);
    const c = v.conta;
    const f = v.fatura;
    const nome = nomeMes(v.ref);

    const previsao = v.mes_atual ? "Previsão no fim do mês"
      : c.mes_passado ? `Saldo no fim de ${nome}` : `Previsão no fim de ${nome}`;
    const tileMovimento = c.mes_passado
      ? `<div class="tile-rotulo">Movimento de ${esc(nome)}</div>
         <div class="tile-valor">${reais(v.total_gasto_mes)}</div>
         <div class="tile-extra">gastos de todos os donos · entrou ${reais(v.entradas_mes)}</div>`
      : `<div class="tile-rotulo">${v.mes_atual ? "Ainda sai este mês" : `Sai da conta em ${esc(nome)}`}</div>
         <div class="tile-valor">${reais(c.a_sair_mes)}</div>
         <div class="tile-extra">Fatura ${reais(c.a_sair_fatura)} · débitos ${reais(c.a_sair_debito)}${c.a_entrar_mes ? ` · entra ${reais(c.a_entrar_mes)}` : ""}</div>`;

    const donosFatura = f.por_dono.map((p) => ({ id: p.dono_id, nome: App.dono(p.dono_id).nome, cor: App.dono(p.dono_id).cor, valor: p.valor }));
    const gastosDonos = v.gastos_por_dono.map((g) => ({ nome: g.dono.nome, cor: g.dono.cor, valor: g.total }));
    const cats = v.categorias_eu.map((g) => ({ nome: g.nome, cor: g.cor, valor: g.valor }));

    el.innerHTML = `
      ${vazia ? `<div class="card aviso-importar">
        <div><b>Já usava o NuControle no computador?</b>
          <p class="nota">Traga seus lançamentos, terceiros e caixinhas do app antigo. Dá para fazer isso enquanto esta conta estiver vazia.</p></div>
        <button class="btn btn-primario" data-ir-ajustes>Importar dados</button>
      </div>` : ""}
      <div class="grade grade-tiles">
        <div class="tile destaque">
          <div class="tile-rotulo">Saldo na conta</div>
          <div class="tile-valor ${c.saldo < 0 ? "negativo" : ""}">${reais(c.saldo)}</div>
          <div class="tile-extra">${esc(previsao)}: <b>${reais(c.previsao_fim_mes)}</b></div>
        </div>
        <div class="tile">
          <div class="tile-rotulo">Caixinhas e fundos</div>
          <div class="tile-valor">${reais(v.reservas.total)}</div>
          <div class="tile-extra">Patrimônio: ${reais(v.patrimonio)}</div>
        </div>
        <div class="tile">
          <div class="tile-rotulo">Fatura de ${esc(f.rotulo)} ${statusFatura(f.status)}</div>
          <div class="tile-valor">${reais(f.total)}</div>
          <div class="tile-extra">Vence ${dataBR(f.vencimento)}${f.pago ? ` · falta ${reais(f.restante)}` : ""}${v.faturas_pendentes > 1 ? ` · ${v.faturas_pendentes} faturas pendentes` : ""}</div>
        </div>
        <div class="tile">${tileMovimento}</div>
      </div>

      <div class="grade grade-2">
        <div class="card">
          <div class="card-topo"><h2>De quem é a fatura de ${esc(f.rotulo)}</h2>
            <button class="btn btn-p" data-ir="cartao" data-fatura="${f.ref}">Ver fatura</button></div>
          ${Graficos.barraEmpilhada(donosFatura, { total: f.total })}
        </div>
        <div class="card">
          <div class="card-topo"><h2>Gastos de ${esc(nome)} por dono</h2><span class="dica">${reais(v.total_gasto_mes)} no total</span></div>
          ${Graficos.barrasOrdenadas(gastosDonos, { corBarra: "identidade", vazio: "Nenhum gasto neste mês ainda." })}
        </div>
      </div>

      <div class="card">
        <div class="card-topo"><h2>Onde eu mais gastei em ${esc(v.rotulo)}</h2><span class="dica">só a sua parte de cada compra</span></div>
        ${Graficos.barrasOrdenadas(cats, { vazio: "Nenhum gasto seu neste mês ainda." })}
      </div>`;

    el.querySelector("[data-ir-ajustes]")?.addEventListener("click", () => App.ir("ajustes"));
    el.querySelector("[data-ir]")?.addEventListener("click", (ev) => {
      App.ui.fatura = ev.currentTarget.dataset.fatura;
      App.ir("cartao");
    });
  },

  /* ============================================================ Gastos do mes */
  async gastos(el) {
    const ui = App.ui;
    const m = await api.mes(ui.mes);
    App.cabecalho(`Gastos de ${m.rotulo}`, "Cada aba mostra só a parte daquele dono em cada compra · troque o mês na barra lateral");

    if (!m.abas.some((a) => a.dono.id === ui.aba) && ui.aba !== "entradas") ui.aba = App.estado.id_eu;
    const abas = m.abas.map((a) => `
      <button class="aba ${a.dono.id === ui.aba ? "ativa" : ""} ${a.dono.ativo ? "" : "arquivado"}" data-aba="${a.dono.id}">
        <span class="ponto" style="background:${esc(a.dono.cor)}"></span>${esc(a.dono.nome)}
        <span class="aba-valor">${reais(a.total)}</span>
      </button>`).join("") + `
      <button class="aba ${ui.aba === "entradas" ? "ativa" : ""}" data-aba="entradas">Entradas
        <span class="aba-valor">${reais(m.entradas.total)}</span></button>`;

    let corpo;
    if (ui.aba === "entradas") {
      corpo = this._entradas(m);
    } else {
      corpo = this._abaDono(m.abas.find((a) => a.dono.id === ui.aba), m);
    }
    el.innerHTML = `<div class="abas" id="abas">${abas}</div>${corpo}`;

    $("#abas", el).addEventListener("click", (ev) => {
      const b = ev.target.closest("[data-aba]");
      if (!b) return;
      ui.aba = b.dataset.aba;
      App.recarregar();
    });
    ligarAcoesLanc(el);
    el.querySelector("[data-novo-dono]")?.addEventListener("click", (ev) =>
      FormLancamento.abrir({ dono: ev.currentTarget.dataset.novoDono }));
    el.querySelector("[data-nova-entrada]")?.addEventListener("click", () => FormLancamento.abrir({ fluxo: "ENTRADA" }));
  },

  _abaDono(a, m) {
    const d = a.dono;
    const secoes = ["FIXO", "PARCELAMENTO", "AVULSO"].map((n) => {
      const g = a.grupos[n];
      const linhas = g.itens.map((l) => `
        <tr class="${l.futuro ? "futuro" : ""}">
          <td class="data">${dataBR(l.data)}</td>
          <td>${descricaoLanc(l)}</td>
          <td>${tagMeio(l.meio)}</td>
          <td>${chipsDivisao(l.partes, d.id)}</td>
          <td class="num"><b>${reais(l.valor_dono)}</b>${l.partes.length > 1 ? `<div class="nota">de ${reais(l.valor)}</div>` : ""}</td>
          <td class="acoes">${acoesLanc(l)}</td>
        </tr>`).join("");
      return `<div class="secao-nat">
        <div class="secao-nat-topo"><h3>${NATUREZA_ROTULO[n]}</h3><span class="num">${reais(g.total)}</span></div>
        ${g.itens.length ? `<table class="tabela tabela-lanc tabela-m"><thead><tr>
            <th class="c-data">Data</th><th>Descrição</th><th class="c-meio">Meio</th><th class="c-div">Dividido com</th>
            <th class="num c-valor">Parte</th><th class="c-acoes"></th>
          </tr></thead><tbody>${linhas}</tbody></table>`
          : `<div class="nota" style="padding:4px 10px 8px">Nada em ${esc(NATUREZA_ROTULO[n].toLowerCase())}.</div>`}
      </div>`;
    }).join("");

    const cats = a.categorias.map((c) => ({ nome: c.nome, cor: c.cor, valor: c.valor }));
    return `
      <div class="grade grade-3">
        <div class="card">
          <div class="card-topo">
            <h2><span class="ponto" style="background:${esc(d.cor)}"></span> ${esc(d.nome)} — ${esc(m.rotulo)}</h2>
            <button class="btn btn-p" data-novo-dono="${d.id}">${icone("mais")}Lançar para ${esc(d.nome)}</button>
          </div>
          ${secoes}
        </div>
        <div style="display:flex;flex-direction:column;gap:20px">
          <div class="grade grade-tiles" style="grid-template-columns:1fr">
            <div class="tile destaque"><div class="tile-rotulo">Total de ${esc(d.nome)} no mês</div>
              <div class="tile-valor">${reais(a.total)}</div>
              <div class="tile-extra">${a.quantidade} lançamento(s)</div></div>
            <div class="tile"><div class="tile-rotulo">No crédito · no débito/pix</div>
              <div class="tile-valor" style="font-size:18px">${reais(a.total_credito)} · ${reais(a.total_debito)}</div></div>
          </div>
          <div class="card"><div class="card-topo"><h3>Por categoria</h3></div>
            ${Graficos.barrasOrdenadas(cats, { vazio: "Sem gastos neste mês." })}</div>
        </div>
      </div>`;
  },

  _entradas(m) {
    const linhas = m.entradas.itens.map((l) => `
      <tr class="${l.futuro ? "futuro" : ""}">
        <td class="data">${dataBR(l.data)}</td>
        <td>${descricaoLanc(l)}</td>
        <td><span class="tag">${l.natureza === "FIXO" ? "Fixa" : "Avulsa"}</span></td>
        <td class="num"><b>${reais(l.valor)}</b></td>
        <td class="acoes">${acoesLanc(l)}</td>
      </tr>`).join("");
    return `<div class="card">
      <div class="card-topo"><h2>Entradas de ${esc(m.rotulo)}</h2>
        <button class="btn btn-p" data-nova-entrada>${icone("mais")}Nova entrada</button></div>
      ${linhas ? `<table class="tabela tabela-m"><thead><tr><th>Data</th><th>Descrição</th><th>Tipo</th><th class="num">Valor</th><th></th></tr></thead>
        <tbody>${linhas}</tbody><tfoot><tr><td colspan="3">Total</td><td class="num">${reais(m.entradas.total)}</td><td></td></tr></tfoot></table>`
        : `<div class="vazio">Nenhuma entrada neste mês.</div>`}
    </div>`;
  },

  /* ============================================================ Cartao */
  async cartao(el) {
    const ui = App.ui;
    // Sem fatura escolhida = a atual. Com outro mes na barra lateral, e a que vence nele
    // (entra na faixa mesmo que ainda esteja vazia).
    if (!ui.fatura) ui.fatura = App.estado.fatura_atual;
    const lista = await api.faturas(ui.fatura);
    const f = await api.fatura(ui.fatura);
    App.cabecalho("Cartão", `Fecha dia ${App.estado.config.dia_fechamento}, vence dia ${App.estado.config.dia_vencimento}`);

    if (ui.donoFatura && !f.por_dono.some((p) => p.dono_id === ui.donoFatura)) ui.donoFatura = null;
    const sel = ui.donoFatura;

    const pilulas = lista.map((x) => `
      <button class="pilula-fatura ${x.ref === f.ref ? "ativa" : ""}" data-fatura="${x.ref}">
        <span class="mes">${rotuloMesCurto(x.ref)}</span>
        <span class="val">${reais(x.total)}</span>
        <span class="st">${STATUS_ROTULO[x.status]}</span>
      </button>`).join("");

    const partes = f.por_dono.map((p) => {
      const d = App.dono(p.dono_id);
      return { id: p.dono_id, nome: d.nome, cor: d.cor, valor: p.valor, extra: `${p.itens} item(ns)` };
    });

    const itens = sel ? f.itens.filter((l) => l.partes.some((p) => p.dono_id === sel)) : f.itens;
    const nomeSel = sel ? App.dono(sel).nome : null;
    const linhas = itens.map((l) => {
      const parte = sel ? l.partes.find((p) => p.dono_id === sel).valor : null;
      return `<tr>
        <td class="data">${dataBR(l.data)}</td>
        <td>${descricaoLanc(l)}</td>
        <td>${l.partes.length > 1 ? chipsDivisao(l.partes, sel) : `<span class="tag"><span class="ponto" style="background:${esc(App.dono(l.partes[0].dono_id).cor)}"></span>${esc(App.dono(l.partes[0].dono_id).nome)}</span>`}</td>
        <td class="num">${reais(l.valor)}</td>
        ${sel ? `<td class="num"><b>${reais(parte)}</b></td>` : ""}
        <td class="acoes">${acoesLanc(l)}</td>
      </tr>`;
    }).join("");
    const totalSel = sel ? f.por_dono.find((p) => p.dono_id === sel).valor : f.total;

    const pagamentos = f.pagamentos.map((p) => `
      <tr><td class="data">${dataBR(p.data, { ano: true })}</td><td class="num">${reais(p.valor)}</td>
      <td class="acoes"><button class="btn-icone perigo" data-excluir-pag="${p.id}" data-dica="Excluir pagamento">${icone("lixo")}</button></td></tr>`).join("");

    el.innerHTML = `
      <div class="faixa-faturas" id="faixa">${pilulas}</div>

      <div class="card">
        <div class="cab-fatura">
          <div>
            <div style="display:flex;gap:10px;align-items:center"><h2 style="font-size:18px">Fatura de ${esc(f.rotulo)}</h2>${statusFatura(f.status)}</div>
            <div class="datas-fatura">
              <span>Compras de <b>${dataBR(f.inicio)}</b> a <b>${dataBR(f.fechamento)}</b></span>
              <span>Fecha <b>${dataBR(f.fechamento, { ano: true })}</b></span>
              <span>Vence <b>${dataBR(f.vencimento, { ano: true })}</b></span>
            </div>
          </div>
          <div style="text-align:right">
            <div class="total">${reais(f.total)}</div>
            <div class="nota">${f.pago ? `Pago ${reais(f.pago)} · falta ${reais(f.restante)}` : "Nada pago ainda"}</div>
            <button class="btn btn-primario btn-p" id="btn-pagar" style="margin-top:8px" ${f.total ? "" : "disabled"}>Registrar pagamento</button>
          </div>
        </div>
      </div>

      <div class="grade grade-3">
        <div class="card">
          <div class="card-topo"><h2>De quem é esta fatura</h2>
            <span class="dica">${sel ? `Filtrando: ${esc(nomeSel)} · <a href="#" id="limpar-filtro" style="color:var(--roxo)">ver todos</a>` : "Clique num dono para ver só os itens dele"}</span></div>
          <div id="empilhada">${Graficos.barraEmpilhada(partes, { selecionado: sel, clicavel: true, total: f.total })}</div>
          ${f.de_terceiros ? `<p class="nota" style="margin:10px 10px 0">Seu: <b>${reais(f.total - f.de_terceiros)}</b> · de terceiros: <b>${reais(f.de_terceiros)}</b></p>` : ""}
        </div>
        <div class="card">
          <div class="card-topo"><h3>Pagamentos</h3></div>
          ${pagamentos ? `<table class="tabela"><tbody>${pagamentos}</tbody></table>` : `<div class="nota">Nenhum pagamento registrado.</div>`}
        </div>
      </div>

      <div class="card">
        <div class="card-topo"><h2>${sel ? `Itens de ${esc(nomeSel)}` : "Todos os itens"}</h2><span class="dica">${itens.length} item(ns)</span></div>
        ${itens.length ? `<table class="tabela tabela-m"><thead><tr>
          <th>Data</th><th>Descrição</th><th>Dono(s)</th><th class="num">Valor</th>${sel ? `<th class="num">Parte de ${esc(nomeSel)}</th>` : ""}<th></th>
        </tr></thead><tbody>${linhas}</tbody>
        <tfoot><tr><td colspan="${sel ? 4 : 3}">Total${sel ? ` de ${esc(nomeSel)}` : ""}</td><td class="num">${reais(totalSel)}</td><td></td></tr></tfoot></table>`
        : `<div class="vazio">Nenhuma compra nesta fatura.</div>`}
      </div>`;

    $("#faixa", el).addEventListener("click", (ev) => {
      const b = ev.target.closest("[data-fatura]");
      if (!b) return;
      ui.fatura = b.dataset.fatura;
      ui.donoFatura = null;
      App.recarregar();
    });
    $("#empilhada", el).addEventListener("click", (ev) => {
      const b = ev.target.closest("[data-dono]");
      if (!b) return;
      const id = b.dataset.dono;
      ui.donoFatura = ui.donoFatura === id ? null : id;
      App.recarregar();
    });
    $("#limpar-filtro", el)?.addEventListener("click", (ev) => { ev.preventDefault(); ui.donoFatura = null; App.recarregar(); });
    $("#btn-pagar", el).addEventListener("click", () => this._pagar(f));
    el.addEventListener("click", async (ev) => {
      const b = ev.target.closest("[data-excluir-pag]");
      if (!b) return;
      if (!(await confirmar("Excluir pagamento", "Remover este pagamento da fatura?", { botao: "Excluir" }))) return;
      try { await api.excluirPagamento(b.dataset.excluirPag); avisar("Pagamento removido."); App.recarregar(); }
      catch (e) { avisar(e.message, "erro"); }
    });
    ligarAcoesLanc(el);
    requestAnimationFrame(() => $("#faixa .ativa")?.scrollIntoView({ inline: "center", block: "nearest" }));
  },

  _pagar(f) {
    Modal.abrir({
      titulo: `Pagar fatura de ${f.rotulo}`,
      largura: "440px",
      corpo: `<div class="form">
        <label class="campo"><span>Valor pago</span>
          <input class="input input-grande dinheiro" id="p-valor" inputmode="numeric" value="${textoDinheiro(f.restante || f.total)}"></label>
        <label class="campo"><span>Data do pagamento</span>
          <input class="input" type="date" id="p-data" value="${App.estado.hoje}"></label>
        <p class="nota">O valor sai do saldo da conta na data do pagamento.</p>
      </div>`,
      aoAbrir: (c) => mascararDinheiro($("#p-valor", c)),
      aoSalvar: async () => {
        await api.pagarFatura({ fatura_ref: f.ref, valor: centavosDe($("#p-valor").value), data: $("#p-data").value });
        avisar("Pagamento registrado.");
        App.recarregar();
      },
    });
  },

  /* ============================================================ Caixinhas */
  async caixinhas(el) {
    const r = await api.reservas();
    App.cabecalho("Caixinhas e fundos", "Guardar tira da conta; resgatar devolve; rendimento cresce sem tocar na conta",
      `<button class="btn" id="nova-reserva">${icone("mais")}Nova caixinha ou fundo</button>`);
    $("#nova-reserva").addEventListener("click", () => this._formReserva());

    const cards = r.reservas.map((x) => {
      const pct = x.meta ? Math.min(Math.round((x.saldo / x.meta) * 100), 100) : null;
      return `<div class="card">
        <div class="reserva-topo">
          <div><span class="tag">${x.tipo === "FUNDO" ? "Fundo imobiliário" : "Caixinha"}</span>
            <h3 style="margin-top:8px">${esc(x.nome)}</h3></div>
          <div>
            <button class="btn-icone" data-editar-res="${x.id}" data-dica="Editar">${icone("editar")}</button>
            <button class="btn-icone perigo" data-excluir-res="${x.id}" data-nome="${esc(x.nome)}" data-dica="Excluir">${icone("lixo")}</button>
          </div>
        </div>
        <div class="reserva-saldo">${reais(x.saldo)}</div>
        <div class="reserva-info">
          <span>Aportado: ${reais(x.saldo_inicial + x.depositado - x.sacado)}</span>
          <span>${x.tipo === "FUNDO" ? "Dividendos" : "Rendeu"}: ${reais(x.rendimentos)}</span>
        </div>
        ${pct !== null ? `<div class="progresso" data-dica="${esc(`${pct}% da meta de ${reais(x.meta)}`)}"><div style="width:${pct}%"></div></div>
          <div class="nota" style="margin-top:6px">${pct}% de ${reais(x.meta)}</div>` : ""}
        <div class="reserva-acoes">
          <button class="btn btn-p" data-mov="DEPOSITO" data-res="${x.id}">${x.tipo === "FUNDO" ? "Aportar" : "Guardar"}</button>
          <button class="btn btn-p" data-mov="SAQUE" data-res="${x.id}">Resgatar</button>
          <button class="btn btn-p" data-mov="RENDIMENTO" data-res="${x.id}">${x.tipo === "FUNDO" ? "Dividendo" : "Rendimento"}</button>
        </div>
      </div>`;
    }).join("");

    const rotMov = { DEPOSITO: "Guardado", SAQUE: "Resgatado", RENDIMENTO: "Rendimento" };
    const movs = r.movimentacoes.map((m) => `
      <tr><td class="data">${dataBR(m.data, { ano: true })}</td>
        <td class="desc">${esc(m.reserva_nome)}<small>${esc(m.descricao || "")}</small></td>
        <td><span class="tag">${rotMov[m.tipo]}</span></td>
        <td class="num">${m.tipo === "SAQUE" ? "-" : "+"}${reais(m.valor)}</td>
        <td class="acoes"><button class="btn-icone perigo" data-excluir-mov="${m.id}" data-dica="Excluir">${icone("lixo")}</button></td></tr>`).join("");

    el.innerHTML = `
      <div class="grade grade-tiles">
        <div class="tile destaque"><div class="tile-rotulo">Total guardado</div><div class="tile-valor">${reais(r.total)}</div></div>
        <div class="tile"><div class="tile-rotulo">Caixinhas</div><div class="tile-valor">${reais(r.total_caixinhas)}</div></div>
        <div class="tile"><div class="tile-rotulo">Fundos imobiliários</div><div class="tile-valor">${reais(r.total_fundos)}</div></div>
      </div>
      ${cards ? `<div class="cards-reserva">${cards}</div>` : `<div class="card vazio">Nenhuma caixinha ainda. Crie a primeira no botão acima.</div>`}
      <div class="card"><div class="card-topo"><h2>Movimentações</h2></div>
        ${movs ? `<table class="tabela tabela-m"><thead><tr><th>Data</th><th>Caixinha</th><th>Tipo</th><th class="num">Valor</th><th></th></tr></thead><tbody>${movs}</tbody></table>`
          : `<div class="nota">Nenhuma movimentação.</div>`}
      </div>`;

    el.addEventListener("click", async (ev) => {
      const b = ev.target.closest("[data-mov],[data-editar-res],[data-excluir-res],[data-excluir-mov]");
      if (!b) return;
      const res = (id) => r.reservas.find((x) => x.id === id);
      try {
        if (b.dataset.mov) return this._formMov(res(b.dataset.res), b.dataset.mov);
        if (b.dataset.editarRes) return this._formReserva(res(b.dataset.editarRes));
        if (b.dataset.excluirRes) {
          if (!(await confirmar("Excluir caixinha", `Excluir “${esc(b.dataset.nome)}” e todo o histórico dela?`, { botao: "Excluir" }))) return;
          await api.excluirReserva(b.dataset.excluirRes);
        } else if (b.dataset.excluirMov) {
          if (!(await confirmar("Excluir movimentação", "Remover esta movimentação?", { botao: "Excluir" }))) return;
          await api.excluirMovReserva(b.dataset.excluirMov);
        }
        avisar("Removido.");
        App.recarregar();
      } catch (e) { avisar(e.message, "erro"); }
    });
  },

  _formReserva(x = null) {
    let tipo = x ? x.tipo : "CAIXINHA";
    Modal.abrir({
      titulo: x ? "Editar" : "Nova caixinha ou fundo",
      largura: "480px",
      corpo: `<div class="form">
        <div class="segmento largo" id="r-tipo">
          <button type="button" data-t="CAIXINHA">Caixinha</button><button type="button" data-t="FUNDO">Fundo imobiliário</button></div>
        <label class="campo"><span>Nome</span><input class="input" id="r-nome" maxlength="200" value="${esc(x ? x.nome : "")}" placeholder="Ex.: Reserva de emergência"></label>
        <div class="linha-campos">
          <label class="campo"><span>Saldo inicial</span><input class="input dinheiro" id="r-ini" inputmode="numeric" value="${x ? textoDinheiro(x.saldo_inicial) : ""}" placeholder="0,00">
            <small>Quanto já tinha antes de controlar aqui.</small></label>
          <label class="campo"><span>Meta (opcional)</span><input class="input dinheiro" id="r-meta" inputmode="numeric" value="${x && x.meta ? textoDinheiro(x.meta) : ""}" placeholder="0,00"></label>
        </div></div>`,
      aoAbrir: (c) => {
        const marcar = () => $$("#r-tipo button", c).forEach((b) => b.classList.toggle("ativo", b.dataset.t === tipo));
        $("#r-tipo", c).addEventListener("click", (ev) => { const b = ev.target.closest("[data-t]"); if (b) { tipo = b.dataset.t; marcar(); } });
        marcar();
        mascararDinheiro($("#r-ini", c));
        mascararDinheiro($("#r-meta", c));
      },
      aoSalvar: async () => {
        await api.salvarReserva({
          nome: $("#r-nome").value, tipo,
          saldo_inicial: centavosDe($("#r-ini").value), meta: centavosDe($("#r-meta").value) || null,
        }, x ? x.id : null);
        avisar("Salvo.");
        App.recarregar();
      },
    });
  },

  _formMov(x, tipo) {
    const titulos = { DEPOSITO: x.tipo === "FUNDO" ? "Aportar em" : "Guardar em", SAQUE: "Resgatar de", RENDIMENTO: x.tipo === "FUNDO" ? "Dividendo de" : "Rendimento de" };
    const notas = {
      DEPOSITO: "Sai do saldo da conta e entra aqui.",
      SAQUE: `Volta para o saldo da conta. Disponível: ${reais(x.saldo)}.`,
      RENDIMENTO: "Cresce aqui sem mexer no saldo da conta.",
    };
    Modal.abrir({
      titulo: `${titulos[tipo]} ${x.nome}`,
      largura: "440px",
      corpo: `<div class="form">
        <label class="campo"><span>Valor</span><input class="input input-grande dinheiro" id="m-valor" inputmode="numeric" placeholder="0,00"></label>
        <label class="campo"><span>Data</span><input class="input" type="date" id="m-data" value="${App.estado.hoje}"></label>
        <label class="campo"><span>Descrição (opcional)</span><input class="input" id="m-desc" maxlength="200"></label>
        <p class="nota">${notas[tipo]}</p></div>`,
      aoAbrir: (c) => mascararDinheiro($("#m-valor", c)),
      aoSalvar: async () => {
        await api.criarMovReserva({ reserva_id: x.id, tipo, valor: centavosDe($("#m-valor").value), data: $("#m-data").value, descricao: $("#m-desc").value });
        avisar("Movimentação registrada.");
        App.recarregar();
      },
    });
  },

  /* ============================================================ Terceiros */
  async terceiros(el) {
    const m = await api.mes(App.ui.mes);
    const totais = Object.fromEntries(m.abas.map((a) => [a.dono.id, a.total]));
    App.cabecalho("Terceiros", "Pessoas e organizações que passam gastos pelo seu cartão ou conta",
      `<button class="btn" id="novo-terceiro">${icone("mais")}Novo terceiro</button>`);
    $("#novo-terceiro").addEventListener("click", () => this._formDono());

    const tipoRot = { EU: "Você", PESSOA: "Pessoa", ORG: "Organização" };
    const card = (d) => `
      <div class="card dono-card" style="${d.ativo ? "" : "opacity:.6"}">
        <span class="avatar" style="background:${esc(d.cor)}">${esc(iniciais(d.nome))}</span>
        <div class="info">
          <div class="nome">${esc(d.nome)} ${d.ativo ? "" : '<span class="tag">arquivado</span>'}</div>
          <div class="sub">${tipoRot[d.tipo]} · ${esc(nomeMes(App.ui.mes))}:${reais(totais[d.id] || 0)}</div>
        </div>
        <div>
          <button class="btn-icone" data-editar-dono="${d.id}" data-dica="Editar">${icone("editar")}</button>
          ${d.tipo === "EU" ? "" : `
            <button class="btn-icone" data-arquivar="${d.id}" data-ativo="${d.ativo ? 0 : 1}" data-dica="${d.ativo ? "Arquivar" : "Reativar"}">${icone("arquivo")}</button>
            <button class="btn-icone perigo" data-excluir-dono="${d.id}" data-nome="${esc(d.nome)}" data-dica="Excluir">${icone("lixo")}</button>`}
        </div>
      </div>`;

    const donos = App.estado.donos;
    const terceiros = donos.filter((d) => d.tipo !== "EU");
    el.innerHTML = `
      <div class="lista-donos">${donos.filter((d) => d.tipo === "EU").map(card).join("")}</div>
      <div class="card-topo" style="margin:8px 0 -6px"><h2 style="font-size:15px;margin:0">Terceiros cadastrados</h2><span class="dica">${terceiros.length} no total</span></div>
      ${terceiros.length ? `<div class="lista-donos">${terceiros.map(card).join("")}</div>`
        : `<div class="card vazio">Nenhum terceiro ainda. Cadastre uma pessoa ou organização (ex.: a empresa, um familiar) para poder dividir gastos com ela.</div>`}
      <p class="nota">Arquivar esconde o terceiro dos formulários sem apagar o histórico. Só dá para excluir quem nunca foi usado em um lançamento.</p>`;

    el.addEventListener("click", async (ev) => {
      const b = ev.target.closest("[data-editar-dono],[data-arquivar],[data-excluir-dono]");
      if (!b) return;
      try {
        if (b.dataset.editarDono) return this._formDono(App.dono(b.dataset.editarDono));
        if (b.dataset.arquivar) {
          await api.arquivarDono(b.dataset.arquivar, b.dataset.ativo === "1");
          avisar(b.dataset.ativo === "1" ? "Terceiro reativado." : "Terceiro arquivado.");
        } else {
          if (!(await confirmar("Excluir terceiro", `Excluir “${esc(b.dataset.nome)}”?`, { botao: "Excluir" }))) return;
          await api.excluirDono(b.dataset.excluirDono);
          avisar("Terceiro excluído.");
        }
        await App.recarregarEstado();
        App.recarregar();
      } catch (e) { avisar(e.message, "erro"); }
    });
  },

  _formDono(d = null) {
    const usadas = new Set(App.estado.donos.map((x) => x.cor.toUpperCase()));
    let cor = d ? d.cor : PALETA_DONOS.find((c) => !usadas.has(c)) || PALETA_DONOS[1];
    let tipo = d ? d.tipo : "PESSOA";
    Modal.abrir({
      titulo: d ? `Editar ${d.nome}` : "Novo terceiro",
      largura: "480px",
      corpo: `<div class="form">
        ${d && d.tipo === "EU" ? "" : `<div class="segmento largo" id="d-tipo">
          <button type="button" data-t="PESSOA">Pessoa</button><button type="button" data-t="ORG">Organização</button></div>`}
        <label class="campo"><span>Nome</span><input class="input" id="d-nome" maxlength="200" value="${esc(d ? d.nome : "")}" placeholder="Ex.: Genesys, Mãe, João"></label>
        <div class="campo"><span>Cor</span>
          <div class="cores" id="d-cores">
            ${PALETA_DONOS.map((c) => `<button type="button" class="cor-opcao" data-cor="${c}" style="background:${c}" aria-label="Cor ${c}"></button>`).join("")}
            <input type="color" class="cor-livre" id="d-cor-livre" value="${esc(cor)}" data-dica="Outra cor">
          </div>
          <small>A cor identifica o dono nos gráficos e nas divisões.</small>
        </div></div>`,
      aoAbrir: (c) => {
        const marcar = () => {
          $$("#d-cores .cor-opcao", c).forEach((b) => b.classList.toggle("ativa", b.dataset.cor.toUpperCase() === cor.toUpperCase()));
          $$("#d-tipo button", c).forEach((b) => b.classList.toggle("ativo", b.dataset.t === tipo));
        };
        $("#d-cores", c).addEventListener("click", (ev) => { const b = ev.target.closest("[data-cor]"); if (b) { cor = b.dataset.cor; $("#d-cor-livre", c).value = cor; marcar(); } });
        $("#d-cor-livre", c).addEventListener("input", (ev) => { cor = ev.target.value; marcar(); });
        $("#d-tipo", c)?.addEventListener("click", (ev) => { const b = ev.target.closest("[data-t]"); if (b) { tipo = b.dataset.t; marcar(); } });
        marcar();
      },
      aoSalvar: async () => {
        await api.salvarDono({ nome: $("#d-nome").value, tipo, cor }, d ? d.id : null);
        avisar(d ? "Salvo." : "Terceiro cadastrado.");
        await App.recarregarEstado();
        App.recarregar();
      },
    });
  },

  /* ============================================================ Ajustes */
  async ajustes(el) {
    const E = App.estado;
    const cfg = E.config;
    App.cabecalho("Ajustes", "Cartão, conta e categorias");

    const cats = E.categorias.map((c) => `
      <tr><td style="width:28px"><span class="ponto" style="background:${esc(c.cor)}"></span></td><td>${esc(c.nome)}</td>
      <td class="acoes"><button class="btn-icone" data-editar-cat="${c.id}" data-dica="Editar">${icone("editar")}</button>
        <button class="btn-icone perigo" data-excluir-cat="${c.id}" data-nome="${esc(c.nome)}" data-dica="Excluir">${icone("lixo")}</button></td></tr>`).join("");

    el.innerHTML = `
      <div class="grade grade-2">
        <form class="card form" id="form-config">
          <h2>Cartão e conta</h2>
          <div class="linha-campos">
            <label class="campo"><span>Fatura fecha no dia</span><input class="input" type="number" min="1" max="31" id="c-fech" value="${cfg.dia_fechamento}"></label>
            <label class="campo"><span>Fatura vence no dia</span><input class="input" type="number" min="1" max="31" id="c-venc" value="${cfg.dia_vencimento}"></label>
          </div>
          <div class="linha-campos">
            <label class="campo"><span>Saldo da conta em</span><input class="input" type="date" id="c-data" value="${cfg.data_inicio}">
              <small>Data de início do controle.</small></label>
            <label class="campo"><span>Saldo nessa data</span><input class="input dinheiro" id="c-saldo" inputmode="numeric" value="${textoDinheiro(cfg.saldo_inicial)}"></label>
          </div>
          <p class="nota">O saldo da conta é calculado a partir desse valor. O que aconteceu antes da data de início aparece nos relatórios mas não mexe no saldo. Mudar os dias do cartão reposiciona todas as compras nas faturas certas.</p>
          <div><button class="btn btn-primario" type="submit">Salvar</button></div>
        </form>
        <div class="card">
          <div class="card-topo"><h2>Categorias</h2><button class="btn btn-p" id="nova-cat">${icone("mais")}Nova</button></div>
          <table class="tabela"><tbody>${cats}</tbody></table>
        </div>
      </div>
      <div class="grade grade-2">
        <div class="card">
          <div class="card-topo"><h2>Sua conta</h2></div>
          <div class="backup-linha">
            <div><b>${esc(Sessao.email)}</b><p class="nota">Seus dados ficam guardados só para esta conta.</p></div>
          </div>
          <div class="backup-linha">
            <div><b>Senha</b><p class="nota">Troque quando quiser.</p></div>
            <button class="btn" id="btn-trocar-senha">Trocar senha</button>
          </div>
          <div class="backup-linha">
            <div><b>Sair</b><p class="nota">Encerra o acesso neste aparelho.</p></div>
            <button class="btn btn-perigo" id="btn-sair-ajustes">Sair</button>
          </div>
        </div>
        <div class="card">
          <div class="card-topo"><h2>Seus dados</h2><span class="dica">backup e importação</span></div>
          <div id="bloco-importar"></div>
          <div class="backup-linha">
            <div><b>Baixar backup</b>
              <p class="nota">Um arquivo <code>.json</code> com tudo da sua conta. Guarde em lugar seguro: o plano grátis do servidor não faz backup sozinho.</p></div>
            <button class="btn btn-primario" id="btn-baixar-backup">Baixar</button>
          </div>
          <div class="backup-linha">
            <div><b>Restaurar backup</b>
              <p class="nota">Troca <b>todos</b> os dados desta conta pelos do arquivo. Antes, baixe um backup do que está aqui.</p></div>
            <label class="btn">Restaurar…<input type="file" accept=".json,application/json" id="arq-backup" hidden></label>
          </div>
        </div>
      </div>`;

    $("#btn-trocar-senha", el).addEventListener("click", () => this._trocarSenha());
    $("#btn-sair-ajustes", el).addEventListener("click", () => Sessao.sair());
    $("#btn-baixar-backup", el).addEventListener("click", () => this._baixarBackup());
    $("#arq-backup", el).addEventListener("change", (ev) => this._restaurar(ev.target, "backup"));
    api.contaVazia().then((vazia) => {
      if (!vazia) return;
      $("#bloco-importar", el).innerHTML = `
        <div class="backup-linha destaque-importar">
          <div><b>Importar do app antigo</b>
            <p class="nota">Traga tudo do NuControle de computador: escolha o arquivo <code>nucontrole-v2.db</code>
            (fica em <code>%APPDATA%\\NuControle\\dados</code>). Só aparece enquanto a conta está vazia.</p></div>
          <label class="btn btn-primario">Escolher arquivo…<input type="file" accept=".db" id="arq-desktop" hidden></label>
        </div>`;
      $("#arq-desktop", el).addEventListener("change", (ev) => this._restaurar(ev.target, "desktop"));
    }).catch(() => {});
    mascararDinheiro($("#c-saldo", el));
    $("#form-config", el).addEventListener("submit", async (ev) => {
      ev.preventDefault();
      try {
        await api.salvarConfig({
          dia_fechamento: Number($("#c-fech", el).value), dia_vencimento: Number($("#c-venc", el).value),
          data_inicio: $("#c-data", el).value, saldo_inicial: centavosDe($("#c-saldo", el).value),
        });
        avisar("Ajustes salvos.");
        await App.recarregarEstado();
        App.recarregar();
      } catch (e) { avisar(e.message, "erro"); }
    });
    $("#nova-cat", el).addEventListener("click", () => this._formCategoria());
    el.addEventListener("click", async (ev) => {
      const b = ev.target.closest("[data-editar-cat],[data-excluir-cat]");
      if (!b) return;
      if (b.dataset.editarCat) return this._formCategoria(E.categorias.find((c) => c.id === b.dataset.editarCat));
      if (!(await confirmar("Excluir categoria", `Excluir “${esc(b.dataset.nome)}”? Os lançamentos dela ficam sem categoria.`, { botao: "Excluir" }))) return;
      try {
        await api.excluirCategoria(b.dataset.excluirCat);
        avisar("Categoria excluída.");
        await App.recarregarEstado();
        App.recarregar();
      } catch (e) { avisar(e.message, "erro"); }
    });
  },

  async _baixarBackup() {
    try {
      const texto = await api.backup();
      const url = URL.createObjectURL(new Blob([texto], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `nucontrole_${App.estado.hoje}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      avisar("Backup baixado.");
    } catch (e) { avisar(e.message, "erro"); }
  },

  /** origem "desktop" (nucontrole-v2.db) ou "backup" (.json): le, mostra o
      resumo e so troca os dados depois da confirmacao. */
  async _restaurar(input, origem) {
    const arquivo = input.files[0];
    input.value = ""; // permite escolher o mesmo arquivo de novo
    if (!arquivo) return;
    let b;
    try {
      b = origem === "desktop" ? await api.lerArquivoDesktop(arquivo) : await api.lerArquivoBackup(arquivo);
    } catch (e) { return avisar(e.message, "erro"); }

    const ultimo = b.ultimo_lancamento ? dataBR(b.ultimo_lancamento, { ano: true }) : "nenhum";
    const quando = b.gerado_em ? `<br><span class="nota">backup de ${esc(new Date(b.gerado_em).toLocaleString("pt-BR"))}</span>` : "";
    const ok = await confirmar(origem === "desktop" ? "Importar do app antigo" : "Restaurar backup", `
      <b>${esc(b.nome)}</b>${quando}
      <ul style="margin:12px 0;padding-left:18px;line-height:1.7">
        <li>${b.compras} lançamento(s) · o último foi feito em ${esc(ultimo)}</li>
        <li>${b.terceiros} terceiro(s) · ${b.caixinhas} caixinha(s)/fundo(s)</li>
      </ul>
      ${origem === "desktop"
        ? "Os dados do arquivo passam a ser os desta conta."
        : "Os dados atuais desta conta serão <b>substituídos</b> por esses. Isso não tem volta: se quiser guardar o que está aqui, baixe um backup antes."}`,
      { botao: origem === "desktop" ? "Importar" : "Restaurar", perigo: origem !== "desktop" });
    if (!ok) return;

    try {
      await api.substituirPeloArquivo();
      await App.recarregarEstado();
      App.ui = { mes: App.estado.mes_atual, aba: App.estado.id_eu, fatura: null, donoFatura: null };
      App._desenharMes();
      avisar(origem === "desktop" ? "Dados importados." : "Backup restaurado.");
      App.ir("visao");
    } catch (e) { avisar(e.message, "erro"); }
  },

  _trocarSenha() {
    Modal.abrir({
      titulo: "Trocar senha",
      largura: "440px",
      corpo: `<div class="form">
        <label class="campo"><span>Nova senha</span><input class="input" type="password" id="t-senha" autocomplete="new-password" minlength="8">
          <small>Pelo menos 8 caracteres.</small></label>
        <label class="campo"><span>Repita a senha</span><input class="input" type="password" id="t-confirma" autocomplete="new-password" minlength="8"></label>
      </div>`,
      aoSalvar: async () => {
        const senha = $("#t-senha").value;
        const problema = validarSenha(senha, $("#t-confirma").value);
        if (problema) throw new Error(problema);
        await Sessao.trocarSenha(senha);
        avisar("Senha trocada.");
      },
    });
  },

  _formCategoria(c = null) {
    let cor = c ? c.cor : PALETA_CATEGORIAS[0];
    Modal.abrir({
      titulo: c ? "Editar categoria" : "Nova categoria",
      largura: "440px",
      corpo: `<div class="form">
        <label class="campo"><span>Nome</span><input class="input" id="k-nome" maxlength="200" value="${esc(c ? c.nome : "")}"></label>
        <div class="campo"><span>Cor</span><div class="cores" id="k-cores">
          ${PALETA_CATEGORIAS.map((x) => `<button type="button" class="cor-opcao" data-cor="${x}" style="background:${x}"></button>`).join("")}
          <input type="color" class="cor-livre" id="k-livre" value="${esc(cor)}"></div></div></div>`,
      aoAbrir: (el) => {
        const marcar = () => $$("#k-cores .cor-opcao", el).forEach((b) => b.classList.toggle("ativa", b.dataset.cor.toUpperCase() === cor.toUpperCase()));
        $("#k-cores", el).addEventListener("click", (ev) => { const b = ev.target.closest("[data-cor]"); if (b) { cor = b.dataset.cor; $("#k-livre", el).value = cor; marcar(); } });
        $("#k-livre", el).addEventListener("input", (ev) => { cor = ev.target.value; marcar(); });
        marcar();
      },
      aoSalvar: async () => {
        await api.salvarCategoria({ nome: $("#k-nome").value, cor }, c ? c.id : null);
        avisar("Categoria salva.");
        await App.recarregarEstado();
        App.recarregar();
      },
    });
  },
};
