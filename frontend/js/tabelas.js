/* ===========================================================================
   Conteudo das abas do painel da direita.

   Cada funcao devolve HTML puro. Quem liga os eventos e o app.js, por
   delegacao -- assim redesenhar uma aba nunca deixa listener orfao.
   =========================================================================== */

const Tabelas = (() => {

  /* -----------------------------------------------------------------------
     Uma das tres tabelas: Pessoal / Terceiros / Genesys
     ----------------------------------------------------------------------- */

  function etiquetaLinha(item) {
    if (item.natureza === 'PARCELAMENTO') {
      return `<span class="etiqueta etiqueta-parcela">${item.parcela_num}/${item.parcela_total}</span>`;
    }
    if (item.natureza === 'FIXO') {
      return '<span class="etiqueta etiqueta-fixo">fixo</span>';
    }
    return '';
  }

  function linha(item) {
    const entrada = item.fluxo === 'ENTRADA';
    return `
      <tr>
        <td class="col-data">${U.diaMes(item.data)}</td>
        <td>
          <div class="desc">
            <span class="ponto" style="background:${U.esc(item.categoria_cor || '#94A3B8')}"></span>
            <span class="desc-texto">${U.esc(item.descricao)}</span>
            ${etiquetaLinha(item)}
          </div>
        </td>
        <td style="color:var(--tinta-2)">${U.esc(item.categoria_nome || '--')}</td>
        <td>
          <span class="etiqueta etiqueta-${item.meio === 'CREDITO' ? 'credito' : 'debito'}">
            ${item.meio === 'CREDITO' ? 'Credito' : 'Pix/Deb'}
          </span>
        </td>
        <td class="col-num ${entrada ? 'entrada' : 'saida'}">
          ${entrada ? '+' : ''}${U.numero(item.valor)}
        </td>
        <td class="col-acao">
          <button class="btn-icone" data-apagar-lanc="${item.id}"
                  title="Apagar &quot;${U.esc(item.descricao)}&quot;" aria-label="Apagar">&times;</button>
        </td>
      </tr>`;
  }

  function responsavel(tabela, { categorias = [], filtroCategoria = null } = {}) {
    const nomeFiltro = filtroCategoria
      ? categorias.find((c) => c.id === filtroCategoria)?.nome
      : null;

    const grupos = tabela.grupos
      .map((g) => {
        let itens = g.itens;
        if (filtroCategoria) itens = itens.filter((i) => i.categoria_id === filtroCategoria);
        if (!itens.length) return '';

        const total = itens.reduce(
          (s, i) => s + (i.fluxo === 'ENTRADA' ? -i.valor : i.valor), 0
        );
        return `
          <tr class="grupo">
            <td colspan="6">
              <div class="grupo-cab">
                <span class="grupo-nome">${U.rotulo(g.natureza)}</span>
                <span class="grupo-total">${U.reais(total)}</span>
              </div>
            </td>
          </tr>
          ${itens.map(linha).join('')}`;
      })
      .join('');

    if (!grupos) {
      return `
        ${nomeFiltro ? barraFiltro(nomeFiltro) : ''}
        <div class="vazio">
          <strong>Nada aqui${nomeFiltro ? ` em ${U.esc(nomeFiltro)}` : ''}</strong>
          ${nomeFiltro
            ? 'Nenhum lancamento deste grupo nesta categoria.'
            : 'Use o formulario a esquerda para lancar o primeiro.'}
        </div>`;
    }

    const visiveis = tabela.grupos.flatMap((g) =>
      filtroCategoria ? g.itens.filter((i) => i.categoria_id === filtroCategoria) : g.itens
    );
    const totalVisivel = visiveis.reduce(
      (s, i) => s + (i.fluxo === 'ENTRADA' ? -i.valor : i.valor), 0
    );

    return `
      ${nomeFiltro ? barraFiltro(nomeFiltro) : ''}
      <div class="tabela-rolagem">
        <table class="tabela">
          <thead>
            <tr>
              <th>Data</th><th>Descricao</th><th>Categoria</th>
              <th>Meio</th><th style="text-align:right">Valor</th><th></th>
            </tr>
          </thead>
          <tbody>${grupos}</tbody>
        </table>
      </div>
      <div class="rodape-total">
        <span class="rotulo">Total ${U.rotulo(tabela.responsavel)}${nomeFiltro ? ` em ${U.esc(nomeFiltro)}` : ''}</span>
        <span class="valor">${U.reais(totalVisivel)}</span>
      </div>`;
  }

  function barraFiltro(nome) {
    return `
      <div class="faixa-info">
        <span class="texto">Filtrando por <strong>${U.esc(nome)}</strong></span>
        <button class="btn-contorno" data-limpar-filtro>Limpar filtro</button>
      </div>`;
  }

  /* -----------------------------------------------------------------------
     Aba do cartao de credito
     ----------------------------------------------------------------------- */

  function cartao(fatura, reservas, { refsFatura = [], refAtual } = {}) {
    const c = fatura.ciclo;
    const restante = fatura.restante;
    const dias = fatura.dias_para_vencer;

    const prazo = fatura.status === 'PAGA'
      ? 'Fatura quitada.'
      : dias > 1 ? `Vence em ${dias} dias.`
      : dias === 1 ? 'Vence amanha.'
      : dias === 0 ? 'Vence hoje.'
      : `Venceu ha ${Math.abs(dias)} dia${Math.abs(dias) === 1 ? '' : 's'}.`;

    const opcoes = refsFatura.map((r) => `
      <option value="${r.ref}" ${r.ref === refAtual ? 'selected' : ''}>
        ${U.esc(r.rotulo)}${r.aberta ? ' (aberta)' : ''}
      </option>`).join('');

    const ordem = ['PESSOAL', 'TERCEIROS', 'GENESYS'];
    const quebra = ordem.map((chave) => {
      const valor = fatura.por_responsavel[chave] || 0;
      return `
        <div class="legenda-item">
          <span class="ponto" style="background:${U.COR_RESP[chave]}"></span>
          <span class="nome">${U.rotulo(chave)}</span>
          <span class="valor">${U.reais(valor)}</span>
        </div>`;
    }).join('');

    const naoMeu = (fatura.por_responsavel.TERCEIROS || 0) + (fatura.por_responsavel.GENESYS || 0);

    const pagamentos = fatura.pagamentos.length ? `
      <h3 class="sub-titulo">Pagamentos registrados</h3>
      <div class="tabela-rolagem">
        <table class="tabela">
          <thead><tr>
            <th>Data</th><th>Saiu de</th><th style="text-align:right">Valor</th><th></th>
          </tr></thead>
          <tbody>
            ${fatura.pagamentos.map((p) => `
              <tr>
                <td class="col-data">${U.dataBR(p.data)}</td>
                <td>${p.reserva_nome
                  ? `Caixinha <strong>${U.esc(p.reserva_nome)}</strong>`
                  : 'Saldo da conta'}</td>
                <td class="col-num">${U.numero(p.valor)}</td>
                <td class="col-acao">
                  <button class="btn-icone" data-apagar-pagamento="${p.id}"
                          title="Desfazer este pagamento" aria-label="Desfazer">&times;</button>
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>` : '';

    const itens = fatura.itens.length ? `
      <h3 class="sub-titulo">Compras nesta fatura</h3>
      <div class="tabela-rolagem">
        <table class="tabela">
          <thead><tr>
            <th>Data</th><th>Descricao</th><th>Categoria</th>
            <th>De quem</th><th style="text-align:right">Valor</th><th></th>
          </tr></thead>
          <tbody>
            ${fatura.itens.map((i) => `
              <tr>
                <td class="col-data">${U.diaMes(i.data)}</td>
                <td>
                  <div class="desc">
                    <span class="desc-texto">${U.esc(i.descricao)}</span>
                    ${etiquetaLinha(i)}
                  </div>
                </td>
                <td style="color:var(--tinta-2)">${U.esc(i.categoria_nome || '--')}</td>
                <td>
                  <span class="desc">
                    <span class="ponto" style="background:${U.COR_RESP[i.responsavel]}"></span>
                    ${U.rotulo(i.responsavel)}
                  </span>
                </td>
                <td class="col-num ${i.fluxo === 'ENTRADA' ? 'entrada' : ''}">
                  ${i.fluxo === 'ENTRADA' ? '+' : ''}${U.numero(i.valor)}
                </td>
                <td class="col-acao">
                  <button class="btn-icone" data-apagar-lanc="${i.id}"
                          title="Apagar" aria-label="Apagar">&times;</button>
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>` : '<div class="vazio"><strong>Nenhuma compra nesta fatura</strong>Compras no credito aparecem aqui.</div>';

    return `
      <div class="faixa-info">
        <span class="texto">
          Compras de <strong>${U.dataBR(c.inicio)}</strong> a <strong>${U.dataBR(c.fechamento)}</strong>
          &middot; vence <strong>${U.dataBR(c.vencimento)}</strong><br>
          ${U.esc(prazo)}
        </span>
        <div class="acoes">
          <select data-trocar-fatura style="padding:9px 12px;border-radius:999px;
                  border:1px solid var(--linha-forte);background:#fff;font:inherit">
            ${opcoes}
          </select>
          <button class="btn-roxo" data-pagar-fatura="${fatura.ciclo.ref}"
                  ${restante <= 0 ? 'disabled' : ''}>
            ${restante <= 0 ? 'Fatura quitada' : `Pagar ${U.reais(restante)}`}
          </button>
        </div>
      </div>

      <div class="kpis" style="margin-bottom:20px">
        <div class="kpi kpi-destaque">
          <div class="kpi-rotulo">Total da fatura</div>
          <div class="kpi-valor">${U.reais(fatura.total)}</div>
          <div class="kpi-nota">
            <span class="selo selo-${fatura.status.toLowerCase()}">${U.rotulo(fatura.status)}</span>
          </div>
        </div>
        <div class="kpi">
          <div class="kpi-rotulo">A parte que e sua</div>
          <div class="kpi-valor">${U.reais(fatura.por_responsavel.PESSOAL || 0)}</div>
          <div class="kpi-nota">${naoMeu > 0
            ? `${U.reais(naoMeu)} e de terceiros / Genesys`
            : 'Toda a fatura e gasto pessoal'}</div>
        </div>
        <div class="kpi">
          <div class="kpi-rotulo">Ja pago</div>
          <div class="kpi-valor">${U.reais(fatura.pago)}</div>
          <div class="kpi-nota">${restante > 0
            ? `Falta ${U.reais(restante)}`
            : 'Nada em aberto'}</div>
        </div>
      </div>

      <div class="cartao" style="box-shadow:none;background:var(--superficie-2)">
        <div class="cartao-titulo">
          <h2>Como a fatura se divide</h2>
          <span class="nota">${U.reais(fatura.total)}</span>
        </div>
        ${Graficos.faixaFatura(fatura)}
        <div class="legenda" style="margin-top:16px">${quebra}</div>
      </div>

      ${pagamentos}
      ${itens}`;
  }

  /* -----------------------------------------------------------------------
     Aba das caixinhas e fundos
     ----------------------------------------------------------------------- */

  function caixinhas(reservas, movimentacoes) {
    const total = reservas.reduce((s, r) => s + r.saldo, 0);

    const cards = reservas.map((r) => {
      const medidor = r.meta ? `
        <div class="medidor">
          <div class="medidor-preenche" style="width:${r.progresso_meta}%"></div>
        </div>
        <div class="medidor-nota">${r.progresso_meta}% da meta de ${U.reais(r.meta)}</div>` : '';

      return `
        <div class="reserva">
          <div class="reserva-topo">
            <span class="reserva-nome">${U.esc(r.nome)}</span>
            <span class="etiqueta">${U.rotulo(r.tipo)}</span>
          </div>
          <div class="reserva-saldo">${U.reais(r.saldo)}</div>
          ${medidor}
          <div class="reserva-linhas">
            <div><span>Aportado</span> <span>${U.reais(r.depositos + r.saldo_inicial)}</span></div>
            <div><span>Retirado</span> <span>${U.reais(r.saques)}</span></div>
            <div><span>${r.tipo === 'FUNDO' ? 'Dividendos' : 'Rendimento'}</span>
                 <span class="entrada">${U.reais(r.rendimentos)}</span></div>
          </div>
          <div class="reserva-acoes">
            <button data-mov="DEPOSITO" data-reserva="${r.id}">Depositar</button>
            <button data-mov="SAQUE" data-reserva="${r.id}">Sacar</button>
            <button data-mov="RENDIMENTO" data-reserva="${r.id}"
                    title="${r.tipo === 'FUNDO' ? 'Lancar dividendo recebido' : 'Lancar o rendimento do mes'}">
              Render
            </button>
          </div>
        </div>`;
    }).join('');

    const historico = movimentacoes.length ? `
      <h3 class="sub-titulo">Movimentacoes</h3>
      <div class="tabela-rolagem">
        <table class="tabela">
          <thead><tr>
            <th>Data</th><th>Caixinha</th><th>Tipo</th>
            <th>Descricao</th><th style="text-align:right">Valor</th><th></th>
          </tr></thead>
          <tbody>
            ${movimentacoes.map((m) => {
              const entra = m.tipo !== 'SAQUE';
              return `
                <tr>
                  <td class="col-data">${U.diaMes(m.data)}</td>
                  <td>${U.esc(m.reserva_nome)}</td>
                  <td><span class="etiqueta">${U.rotulo(m.tipo)}</span></td>
                  <td style="color:var(--tinta-2)">${U.esc(m.descricao || '--')}</td>
                  <td class="col-num ${entra ? 'entrada' : ''}">
                    ${entra ? '+' : '-'}${U.numero(m.valor)}
                  </td>
                  <td class="col-acao">
                    ${m.pagamento_id
                      ? '<span class="etiqueta" title="Criado pelo pagamento de uma fatura">auto</span>'
                      : `<button class="btn-icone" data-apagar-mov="${m.id}"
                                 title="Apagar" aria-label="Apagar">&times;</button>`}
                  </td>
                </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>` : '';

    return `
      <div class="faixa-info">
        <span class="texto">
          Guardado no total: <strong>${U.reais(total)}</strong> em
          ${U.plural(reservas.length, 'caixinha/fundo', 'caixinhas e fundos')}
        </span>
        <div class="acoes">
          <button class="btn-roxo" data-nova-reserva>+ Nova caixinha ou fundo</button>
        </div>
      </div>

      ${reservas.length
        ? `<div class="grade-reservas">${cards}</div>`
        : `<div class="vazio">
             <strong>Nenhuma caixinha cadastrada</strong>
             Crie uma caixinha para separar o dinheiro que vai pagar a fatura.
           </div>`}
      ${historico}`;
  }

  return { responsavel, cartao, caixinhas, linha };
})();
