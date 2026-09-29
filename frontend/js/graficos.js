/* Graficos em HTML puro.
   - barrasOrdenadas: ranking (categorias, donos). Serie unica = um tom so;
     a identidade de cada item vem do ponto colorido ao lado do nome, e o
     texto fica na tinta de texto, nunca na cor da serie.
   - barraEmpilhada: composicao de um total (de quem e a fatura), sempre com
     legenda com valores, entao a cor nunca carrega a informacao sozinha. */

const Graficos = {
  /**
   * itens: [{nome, cor, valor, dica?}]  (cor = ponto de identidade)
   * opts.corBarra: cor unica das barras; se "identidade", usa a cor do item.
   */
  barrasOrdenadas(itens, { corBarra = "var(--roxo)", vazio = "Nada no período." } = {}) {
    const validos = itens.filter((i) => i.valor > 0).sort((a, b) => b.valor - a.valor);
    if (!validos.length) return `<div class="vazio">${esc(vazio)}</div>`;
    const max = validos[0].valor;
    const total = validos.reduce((s, i) => s + i.valor, 0);
    return `<div class="barras">${validos.map((i) => {
      const pct = Math.max((i.valor / max) * 100, 0.8);
      const cor = corBarra === "identidade" ? i.cor : corBarra;
      const participacao = Math.round((i.valor / total) * 1000) / 10;
      const dica = `<b>${esc(i.nome)}</b><br>${reais(i.valor)} · ${String(participacao).replace(".", ",")}% do total`;
      return `
        <div class="barra-linha" data-dica="${esc(i.dica || dica)}">
          <div class="barra-nome"><span class="ponto" style="background:${esc(i.cor)}"></span><span>${esc(i.nome)}</span></div>
          <div class="barra-trilho"><div class="barra-fill" style="width:${pct}%;background:${esc(cor)}"></div></div>
          <div class="barra-valor">${reais(i.valor)}</div>
        </div>`;
    }).join("")}</div>`;
  },

  /**
   * partes: [{id, nome, cor, valor, extra?}]
   * opts.selecionado: id destacado; opts.clicavel: legenda vira botoes (data-dono)
   */
  barraEmpilhada(partes, { selecionado = null, clicavel = false, total = null } = {}) {
    const validas = partes.filter((p) => p.valor > 0);
    const soma = total ?? validas.reduce((s, p) => s + p.valor, 0);
    if (!soma) return `<div class="vazio">Nenhum gasto nesta fatura.</div>`;
    const pct = (v) => (v / soma) * 100;
    const fmtPct = (v) => `${String(Math.round(pct(v) * 10) / 10).replace(".", ",")}%`;

    const barra = validas.map((p) => `
      <div style="width:${pct(p.valor)}%;background:${esc(p.cor)};opacity:${selecionado && selecionado !== p.id ? 0.35 : 1}"
           data-dica="${esc(`<b>${esc(p.nome)}</b><br>${reais(p.valor)} · ${fmtPct(p.valor)}`)}"></div>`).join("");

    const tag = clicavel ? "button" : "div";
    const legenda = validas.map((p) => `
      <${tag} ${clicavel ? `type="button" data-dono="${p.id}"` : ""}
         class="legenda-item ${clicavel ? "" : "estatica"} ${selecionado === p.id ? "ativo" : ""}">
        <span class="ponto ponto-g" style="background:${esc(p.cor)}"></span>
        <span>${esc(p.nome)}${p.extra ? ` <span class="nota">${esc(p.extra)}</span>` : ""}</span>
        <span class="pct">${fmtPct(p.valor)}</span>
        <span class="num">${reais(p.valor)}</span>
      </${tag}>`).join("");

    return `<div class="empilhada" role="img" aria-label="Divisão do total por dono">${barra}</div>
            <div class="legenda">${legenda}</div>`;
  },
};
