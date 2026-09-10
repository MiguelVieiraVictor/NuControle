/* ===========================================================================
   Graficos da tela inicial.

   Duas formas, escolhidas pela pergunta que cada uma responde:

   1. "Onde eu mais gasto?" e uma pergunta de RANKING com ~12 categorias.
      Barras horizontais ordenadas respondem na hora; uma rosca de 12
      fatias seria ilegivel. Serie unica, entao um roxo so -- o tamanho da
      barra ja carrega a magnitude, e colorir por posicao seria pintar o
      RANK em vez da entidade. A cor da categoria vira um ponto de
      identidade ao lado do nome.

   2. "De quem e esse gasto?" e parte-do-todo com exatamente 3 partes.
      Uma barra empilhada unica, com as 3 cores validadas para daltonismo
      e legenda sempre presente.
   =========================================================================== */

const Graficos = (() => {

  /* -----------------------------------------------------------------------
     Barras ordenadas: gastos por categoria
     ----------------------------------------------------------------------- */

  function categorias(dados, { aoClicar, filtroAtivo } = {}) {
    const itens = dados.por_categoria || [];

    if (!itens.length) {
      return `
        <div class="cartao-titulo"><h2>Onde voce gastou</h2></div>
        <div class="vazio">
          <strong>Nenhum gasto neste mes</strong>
          Lance o primeiro gasto no formulario a esquerda.
        </div>`;
    }

    // Barra cheia = maior categoria. Comparar entre si fica direto.
    const maior = Math.max(...itens.map((c) => c.total));

    const linhas = itens.map((c) => {
      const largura = maior ? Math.max((c.total / maior) * 100, 1) : 0;
      const selecionado = filtroAtivo && filtroAtivo === c.categoria_id;
      // "Sem categoria" nao filtra: nao ha id para filtrar por, e uma barra
      // que parece clicavel e nao faz nada e pior do que uma barra estatica.
      const filtravel = aoClicar && c.categoria_id != null;
      return `
        <div class="barra-linha ${filtravel ? 'clicavel' : ''} ${selecionado ? 'selecionada' : ''}"
             ${filtravel ? `data-categoria="${c.categoria_id}" role="button" tabindex="0"` : ''}
             title="${U.esc(c.nome)}: ${U.reais(c.total)} em ${U.plural(c.quantidade, 'lancamento', 'lancamentos')}${filtravel ? ' -- clique para filtrar a tabela' : ''}">
          <div class="barra-nome">
            <span class="ponto" style="background:${U.esc(c.cor)}"></span>
            <b>${U.esc(c.nome)}</b>
          </div>
          <div class="barra-trilha">
            <div class="barra-preenche"
                 style="width:${largura.toFixed(1)}%${selecionado ? ';background:var(--roxo-profundo)' : ''}"></div>
          </div>
          <div>
            <div class="barra-valor">${U.numero(c.total)}</div>
            <div class="barra-pct">${c.percentual.toFixed(0)}%</div>
          </div>
        </div>`;
    }).join('');

    return `
      <div class="cartao-titulo">
        <h2>Onde voce gastou</h2>
        <span class="nota">${U.plural(itens.length, 'categoria', 'categorias')} &middot; ${U.reais(dados.total_saidas)}</span>
      </div>
      <div class="barras">${linhas}</div>
      ${aoClicar ? '<p class="ajuda" style="margin-top:14px">Clique em uma categoria para filtrar a tabela abaixo.</p>' : ''}`;
  }

  /* -----------------------------------------------------------------------
     Barra empilhada: de quem e o gasto
     ----------------------------------------------------------------------- */

  function responsavel(dados) {
    const ordem = ['PESSOAL', 'TERCEIROS', 'GENESYS'];
    const partes = ordem.map((chave) => ({
      chave,
      nome: U.rotulo(chave),
      cor: U.COR_RESP[chave],
      total: dados.tabelas[chave]?.total_saidas || 0,
    }));

    const total = partes.reduce((s, p) => s + p.total, 0);

    if (!total) {
      return `
        <div class="cartao-titulo"><h2>De quem e o gasto</h2></div>
        <div class="vazio">
          <strong>Sem gastos para separar</strong>
          Cada lancamento entra como Pessoal, Terceiros ou Genesys.
        </div>`;
    }

    // Segmentos sem rotulo interno de proposito: um segmento do meio nao tem
    // ponta livre, e texto cortado e pior que texto ausente. A legenda logo
    // abaixo carrega nome, valor e percentual de todos.
    const pilha = partes
      .filter((p) => p.total > 0)
      .map((p) => `
        <div class="pilha-parte"
             style="width:${((p.total / total) * 100).toFixed(2)}%;background:${p.cor}"
             title="${U.esc(p.nome)}: ${U.reais(p.total)} (${((p.total / total) * 100).toFixed(0)}%)"></div>`)
      .join('');

    const legenda = partes.map((p) => `
      <div class="legenda-item">
        <span class="ponto" style="background:${p.cor}"></span>
        <span class="nome">${U.esc(p.nome)}</span>
        <span>
          <span class="valor">${U.reais(p.total)}</span>
          <span class="pct">${total ? ((p.total / total) * 100).toFixed(0) : 0}%</span>
        </span>
      </div>`).join('');

    const naoMeu = partes[1].total + partes[2].total;

    // Segunda pergunta que este espaco responde: quanto do gasto do mes ja
    // saiu da conta e quanto ainda vai virar fatura. Sao numeros, nao um
    // grafico -- duas linhas de tabela dizem isso melhor que uma barra, e
    // evitam uma segunda pilha colorida competindo com a de cima.
    const credito = dados.por_meio?.CREDITO || 0;
    const debito = dados.por_meio?.DEBITO || 0;

    return `
      <div class="cartao-titulo">
        <h2>De quem e o gasto</h2>
        <span class="nota">${U.reais(total)} no mes</span>
      </div>
      <div class="pilha">${pilha}</div>
      <div class="legenda">${legenda}</div>
      ${naoMeu > 0 ? `
        <p class="ajuda" style="margin-top:16px">
          <strong style="color:var(--tinta-2)">${U.reais(naoMeu)}</strong>
          desse total nao e seu &mdash; e dinheiro de terceiros e da Genesys
          que passou pelo seu cartao.
        </p>` : ''}

      <h3 class="sub-titulo">Por onde saiu</h3>
      <div class="legenda">
        <div class="legenda-item">
          <span class="ponto" style="background:var(--linha-forte)"></span>
          <span class="nome">No credito <span class="pct">(vira fatura)</span></span>
          <span class="valor">${U.reais(credito)}</span>
        </div>
        <div class="legenda-item">
          <span class="ponto" style="background:var(--linha-forte)"></span>
          <span class="nome">Pix / debito <span class="pct">(ja saiu da conta)</span></span>
          <span class="valor">${U.reais(debito)}</span>
        </div>
      </div>`;
  }

  /* -----------------------------------------------------------------------
     Medidor: quanto da fatura e realmente seu
     ----------------------------------------------------------------------- */

  function faixaFatura(fatura) {
    const total = fatura.total || 0;
    if (total <= 0) return '';

    const ordem = ['PESSOAL', 'TERCEIROS', 'GENESYS'];
    const segmentos = ordem
      .map((chave) => ({ chave, valor: fatura.por_responsavel[chave] || 0 }))
      .filter((s) => s.valor > 0)
      .map((s) => `
        <div class="pilha-parte"
             style="width:${((s.valor / total) * 100).toFixed(2)}%;background:${U.COR_RESP[s.chave]}"
             title="${U.rotulo(s.chave)}: ${U.reais(s.valor)}"></div>`)
      .join('');

    return `<div class="pilha" style="height:10px;margin:0">${segmentos}</div>`;
  }

  return { categorias, responsavel, faixaFatura };
})();
