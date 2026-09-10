/* ===========================================================================
   Orquestrador do front-end.

   Fluxo unico e previsivel: qualquer alteracao chama `recarregar()`, que
   busca o estado inteiro e redesenha. Para um app local de um usuario, isso
   e mais barato (em bugs) do que atualizar pedacos da tela na mao -- nunca
   existe tela mostrando um numero velho.
   =========================================================================== */

const App = (() => {

  const estado = {
    dados: null,          // resposta de /api/estado
    ref: null,            // mes selecionado
    aba: 'PESSOAL',
    filtroCategoria: null,
    refFatura: null,      // fatura escolhida na aba do cartao
    faturas: [],
    view: 'inicio',
  };

  const ABAS = [
    { id: 'PESSOAL',   nome: 'Pessoal' },
    { id: 'TERCEIROS', nome: 'Terceiros' },
    { id: 'GENESYS',   nome: 'Genesys' },
    { id: 'CARTAO',    nome: 'Cartao de credito' },
    { id: 'CAIXINHAS', nome: 'Caixinhas e fundos' },
  ];

  /* =======================================================================
     Carga
     ======================================================================= */

  async function recarregar() {
    estado.dados = await API.estado(estado.ref);
    estado.ref = estado.dados.mes.ref;

    // A aba do cartao tem seu proprio seletor de fatura; por padrao, a aberta.
    estado.faturas = await API.faturas(6);
    if (!estado.refFatura || !estado.faturas.some((f) => f.ciclo.ref === estado.refFatura)) {
      estado.refFatura = estado.dados.fatura_aberta.ciclo.ref;
    }

    atualizarSelectCategorias();
    desenhar();
  }

  /** Mantem o select do formulario em dia sem perder o que estava escolhido. */
  function atualizarSelectCategorias() {
    const select = U.$('#select-categoria');
    const escolhido = select.value;
    select.innerHTML = '<option value="">Sem categoria</option>'
      + estado.dados.categorias.map((c) =>
          `<option value="${c.id}">${U.esc(c.nome)}</option>`).join('');
    if (escolhido && select.querySelector(`option[value="${escolhido}"]`)) {
      select.value = escolhido;
    }
  }

  async function comErro(acao, mensagemOk) {
    try {
      await acao();
      if (mensagemOk) U.ok(mensagemOk);
      await recarregar();
      return true;
    } catch (e) {
      U.erro(e.message);
      return false;
    }
  }

  /* =======================================================================
     Desenho
     ======================================================================= */

  function desenhar() {
    U.$$('.view').forEach((v) => { v.hidden = true; });
    U.$(`#view-${estado.view}`).hidden = false;
    U.$$('.nav-item').forEach((b) => b.classList.toggle('ativo', b.dataset.view === estado.view));

    if (estado.view === 'inicio') desenharInicio();
    if (estado.view === 'fixos') desenharFixos();
    if (estado.view === 'ajustes') desenharAjustes();
  }

  function desenharInicio() {
    const d = estado.dados;
    const mes = d.mes;
    const fatura = d.fatura_aberta;

    U.$('#topo-titulo').textContent = mes.rotulo;
    U.$('#topo-valor').textContent = U.reais(d.patrimonio);
    U.$('#topo-sub').textContent =
      `${U.reais(d.conta.saldo)} na conta + ${U.reais(d.total_reservado)} guardado`;

    /* -- KPIs -- */
    const naoMeu = d.fatura_parte_terceiros;
    U.$('#kpis').innerHTML = `
      <div class="kpi">
        <div class="kpi-rotulo">Saldo na conta</div>
        <div class="kpi-valor ${d.conta.saldo < 0 ? 'negativo' : ''}">${U.reais(d.conta.saldo)}</div>
        <div class="kpi-nota">
          ${d.conta.a_sair_no_mes > 0
            ? `Ainda saem ${U.reais(d.conta.a_sair_no_mes)} este mes
               &rarr; ${U.reais(d.conta.saldo_previsto_fim_do_mes)}`
            : U.esc(d.conta.nome)}
        </div>
      </div>
      <div class="kpi">
        <div class="kpi-rotulo">Guardado</div>
        <div class="kpi-valor">${U.reais(d.total_reservado)}</div>
        <div class="kpi-nota">${U.plural(d.reservas.length, 'caixinha/fundo', 'caixinhas e fundos')}</div>
      </div>
      <div class="kpi kpi-destaque">
        <div class="kpi-rotulo">Fatura vence ${U.dataBR(fatura.ciclo.vencimento)}</div>
        <div class="kpi-valor">${U.reais(fatura.restante || fatura.total)}</div>
        <div class="kpi-nota">
          ${fatura.total === 0
            ? 'Nenhuma compra ainda'
            : naoMeu > 0
              ? `${U.reais(d.fatura_parte_minha)} seu &middot; ${U.reais(naoMeu)} de terceiros`
              : 'Tudo gasto pessoal'}
          <span class="selo selo-${fatura.status.toLowerCase()}">${U.rotulo(fatura.status)}</span>
        </div>
      </div>
      <div class="kpi">
        <div class="kpi-rotulo">Gastos em ${U.esc(mes.rotulo.split(' ')[0])}</div>
        <div class="kpi-valor">${U.reais(mes.total_saidas)}</div>
        <div class="kpi-nota">
          ${mes.total_entradas > 0
            ? `<span class="entrada">+${U.reais(mes.total_entradas)}</span> de entradas`
            : U.plural(mes.quantidade, 'lancamento', 'lancamentos')}
        </div>
      </div>`;

    /* -- Graficos -- */
    U.$('#cartao-categorias').innerHTML = Graficos.categorias(mes, {
      aoClicar: true,
      filtroAtivo: estado.filtroCategoria,
    });
    U.$('#cartao-responsavel').innerHTML = Graficos.responsavel(mes);

    /* -- Abas -- */
    U.$('#abas').innerHTML = ABAS.map((a) => {
      let total = '';
      if (a.id === 'CARTAO') total = U.numero(d.fatura_aberta.total);
      else if (a.id === 'CAIXINHAS') total = U.numero(d.total_reservado);
      else total = U.numero(mes.tabelas[a.id].total_saidas);

      return `
        <button class="aba ${estado.aba === a.id ? 'ativa' : ''}" data-aba="${a.id}"
                role="tab" aria-selected="${estado.aba === a.id}">
          ${a.id in U.COR_RESP ? `<span class="ponto" style="background:${U.COR_RESP[a.id]}"></span>` : ''}
          ${U.esc(a.nome)}
          <span class="aba-total">${total}</span>
        </button>`;
    }).join('');

    desenharAba();
  }

  function desenharAba() {
    const d = estado.dados;
    const corpo = U.$('#painel-corpo');

    if (estado.aba === 'CARTAO') {
      const fatura = estado.faturas.find((f) => f.ciclo.ref === estado.refFatura)
                  || d.fatura_aberta;
      corpo.innerHTML = Tabelas.cartao(fatura, d.reservas, {
        refAtual: estado.refFatura,
        refsFatura: estado.faturas.map((f) => ({
          ref: f.ciclo.ref,
          rotulo: `Vence ${U.dataBR(f.ciclo.vencimento)}`,
          aberta: f.ciclo.ref === d.fatura_aberta.ciclo.ref,
        })),
      });
      return;
    }

    if (estado.aba === 'CAIXINHAS') {
      corpo.innerHTML = Tabelas.caixinhas(d.reservas, d.movimentacoes || []);
      return;
    }

    corpo.innerHTML = Tabelas.responsavel(d.mes.tabelas[estado.aba], {
      categorias: d.categorias,
      filtroCategoria: estado.filtroCategoria,
    });
  }

  /* =======================================================================
     Formulario de lancamento
     ======================================================================= */

  function valorSegmentado(campo) {
    return U.$(`.segmentado[data-campo="${campo}"] .seg.ativo`)?.dataset.valor;
  }

  function ligarSegmentados() {
    U.$$('.segmentado').forEach((grupo) => {
      grupo.addEventListener('click', (e) => {
        const seg = e.target.closest('.seg');
        if (!seg) return;
        U.$$('.seg', grupo).forEach((s) => s.classList.toggle('ativo', s === seg));
        atualizarForm();
      });
    });
  }

  /** Mostra/esconde os campos que so fazem sentido para cada tipo. */
  function atualizarForm() {
    const natureza = valorSegmentado('natureza');
    const fluxo = valorSegmentado('fluxo');

    U.$('#bloco-parcelas').hidden = natureza !== 'PARCELAMENTO';
    U.$('#bloco-fixo').hidden = natureza !== 'FIXO';

    // Entrada fixa faz sentido (salario todo dia 5), entrada parcelada nao.
    if (fluxo === 'ENTRADA' && natureza === 'PARCELAMENTO') {
      U.$$('.segmentado[data-campo="natureza"] .seg').forEach((s) =>
        s.classList.toggle('ativo', s.dataset.valor === 'AVULSO'));
      U.$('#bloco-parcelas').hidden = true;
      U.$('#bloco-fixo').hidden = true;
    }

    previsao();
  }

  /** Mostra, antes de salvar, o efeito do que a pessoa acabou de digitar. */
  function previsao() {
    const alvo = U.$('#form-previsao');
    const form = U.$('#form-lancamento');
    const valor = U.centavosDe(U.$('[name="valor"]', form));
    if (!valor) { alvo.innerHTML = ''; return; }

    const natureza = valorSegmentado('natureza');
    const meio = valorSegmentado('meio');
    const fluxo = valorSegmentado('fluxo');

    if (natureza === 'PARCELAMENTO') {
      const n = parseInt(U.$('[name="num_parcelas"]', form).value, 10) || 1;
      const inicial = parseInt(U.$('[name="parcela_inicial"]', form).value, 10) || 1;
      const base = Math.floor(valor / n);
      const resto = valor % n;
      const primeira = base + (resto > 0 ? 1 : 0);
      U.$('#ajuda-parcelas').textContent = inicial > 1
        ? `Serao geradas as parcelas ${inicial} a ${n}.`
        : `Serao geradas todas as ${n} parcelas.`;
      alvo.innerHTML = `${n}x de <strong>${U.reais(primeira)}</strong>`
        + (resto > 1 ? ` (as ultimas de ${U.reais(base)})` : '')
        + `, total ${U.reais(valor)}.`;
      return;
    }

    if (natureza === 'FIXO') {
      const dia = U.$('[name="dia"]', form).value || 1;
      alvo.innerHTML = `<strong>${U.reais(valor)}</strong> todo dia ${dia}, `
        + `comecando neste mes.`;
      return;
    }

    alvo.innerHTML = fluxo === 'ENTRADA'
      ? `Entra <strong>${U.reais(valor)}</strong> no saldo da conta.`
      : meio === 'CREDITO'
        ? `Vai para a fatura. <strong>${U.reais(valor)}</strong> nao sai do saldo agora.`
        : `Sai <strong>${U.reais(valor)}</strong> do saldo da conta na hora.`;
  }

  async function enviarLancamento(e) {
    e.preventDefault();
    const form = e.target;
    const botao = form.querySelector('button[type="submit"]');

    const valor = U.centavosDe(U.$('[name="valor"]', form));
    if (!valor) { U.erro('Informe o valor.'); return; }

    const natureza = valorSegmentado('natureza');
    const comum = {
      descricao: U.$('[name="descricao"]', form).value.trim(),
      valor,
      data: U.$('[name="data"]', form).value,
      responsavel: valorSegmentado('responsavel'),
      meio: valorSegmentado('meio'),
      categoria_id: U.$('[name="categoria_id"]', form).value || null,
    };

    botao.disabled = true;
    try {
      if (natureza === 'PARCELAMENTO') {
        const r = await API.criarParcelamento({
          ...comum,
          num_parcelas: parseInt(U.$('[name="num_parcelas"]', form).value, 10) || 1,
          parcela_inicial: parseInt(U.$('[name="parcela_inicial"]', form).value, 10) || 1,
        });
        U.ok(`${U.plural(r.parcelas_geradas, 'parcela criada', 'parcelas criadas')}.`);
      } else if (natureza === 'FIXO') {
        await API.criarRecorrencia({
          ...comum,
          fluxo: valorSegmentado('fluxo'),
          dia: parseInt(U.$('[name="dia"]', form).value, 10) || 1,
          inicio_ref: estado.ref,
        });
        U.ok('Cadastrado. Vai aparecer sozinho todo mes.');
      } else {
        await API.criarLancamento({
          ...comum,
          fluxo: valorSegmentado('fluxo'),
          natureza: 'AVULSO',
        });
        U.ok('Lancamento adicionado.');
      }

      U.$('[name="descricao"]', form).value = '';
      U.$('[name="valor"]', form).value = '';
      U.$('#form-previsao').innerHTML = '';
      U.$('[name="descricao"]', form).focus();
      await recarregar();
    } catch (erro) {
      U.erro(erro.message);
    } finally {
      botao.disabled = false;
    }
  }

  /* =======================================================================
     Modais de acao
     ======================================================================= */

  function modalPagarFatura(ref) {
    const fatura = estado.faturas.find((f) => f.ciclo.ref === ref) || estado.dados.fatura_aberta;
    const reservas = estado.dados.reservas;

    U.modal((corpo, fechar) => {
      corpo.innerHTML = `
        <h2>Pagar a fatura</h2>
        <p class="modal-sub">
          Vence ${U.dataBR(fatura.ciclo.vencimento)} &middot; falta ${U.reais(fatura.restante)}.
          Escolha de onde o dinheiro saiu: se for de uma caixinha, o app faz o
          saque automaticamente e o seu saldo na conta nao se move.
        </p>
        <div class="modal-campos">
          <label class="campo">
            <span>Valor pago</span>
            <input type="text" data-moeda inputmode="decimal" id="pf-valor">
          </label>
          <label class="campo">
            <span>Data do pagamento</span>
            <input type="date" id="pf-data" value="${U.hojeISO()}">
          </label>
          <label class="campo">
            <span>O dinheiro saiu de</span>
            <select id="pf-origem">
              <option value="">Saldo da conta (${U.reais(estado.dados.conta.saldo)})</option>
              ${reservas.map((r) =>
                `<option value="${r.id}">${U.esc(r.nome)} (${U.reais(r.saldo)})</option>`).join('')}
            </select>
          </label>
          <p class="ajuda" id="pf-aviso"></p>
        </div>
        <div class="modal-rodape">
          <button type="button" class="btn-contorno" id="pf-cancelar">Cancelar</button>
          <button type="button" class="btn-roxo" id="pf-ok">Registrar pagamento</button>
        </div>`;

      const campoValor = U.$('#pf-valor', corpo);
      U.preencherMoeda(campoValor, fatura.restante);

      const conferir = () => {
        const valor = U.centavosDe(campoValor);
        const id = U.$('#pf-origem', corpo).value;
        const fonte = id
          ? reservas.find((r) => r.id === Number(id))
          : { nome: 'a conta', saldo: estado.dados.conta.saldo };
        const aviso = U.$('#pf-aviso', corpo);
        aviso.textContent = valor > fonte.saldo
          ? `Atencao: ${U.reais(valor)} e mais do que ha em ${fonte.nome} (${U.reais(fonte.saldo)}).`
          : '';
        aviso.style.color = valor > fonte.saldo ? 'var(--ruim)' : '';
      };

      campoValor.addEventListener('input', conferir);
      U.$('#pf-origem', corpo).addEventListener('change', conferir);
      U.$('#pf-cancelar', corpo).onclick = fechar;
      U.$('#pf-ok', corpo).onclick = async () => {
        const origem = U.$('#pf-origem', corpo).value;
        const feito = await comErro(() => API.pagarFatura({
          fatura_ref: ref,
          valor: U.centavosDe(campoValor),
          data: U.$('#pf-data', corpo).value,
          reserva_id: origem ? Number(origem) : null,
        }), 'Pagamento registrado.');
        if (feito) fechar();
      };
      return campoValor;
    });
  }

  function modalMovimentacao(reservaId, tipo) {
    const reserva = estado.dados.reservas.find((r) => r.id === reservaId);
    const titulos = {
      DEPOSITO: 'Depositar na caixinha',
      SAQUE: 'Sacar da caixinha',
      RENDIMENTO: reserva.tipo === 'FUNDO' ? 'Lancar dividendo' : 'Lancar rendimento',
    };
    const explicacoes = {
      DEPOSITO: 'Sai do saldo da sua conta e entra na caixinha.',
      SAQUE: 'Sai da caixinha e volta para o saldo da sua conta.',
      RENDIMENTO: 'Cresce a caixinha sem tirar nada da conta -- foi o banco que pagou.',
    };

    U.modal((corpo, fechar) => {
      corpo.innerHTML = `
        <h2>${U.esc(titulos[tipo])}</h2>
        <p class="modal-sub">
          <strong>${U.esc(reserva.nome)}</strong> tem ${U.reais(reserva.saldo)}.
          ${U.esc(explicacoes[tipo])}
        </p>
        <div class="modal-campos">
          <label class="campo">
            <span>Valor</span>
            <input type="text" data-moeda inputmode="decimal" id="mv-valor" placeholder="R$ 0,00">
          </label>
          <label class="campo">
            <span>Data</span>
            <input type="date" id="mv-data" value="${U.hojeISO()}">
          </label>
          <label class="campo">
            <span>Descricao (opcional)</span>
            <input type="text" id="mv-desc" maxlength="80"
                   placeholder="${tipo === 'RENDIMENTO' ? 'Rendimento de setembro' : 'Motivo'}">
          </label>
        </div>
        <div class="modal-rodape">
          <button type="button" class="btn-contorno" id="mv-cancelar">Cancelar</button>
          <button type="button" class="btn-roxo" id="mv-ok">Confirmar</button>
        </div>`;

      U.$('#mv-cancelar', corpo).onclick = fechar;
      U.$('#mv-ok', corpo).onclick = async () => {
        const valor = U.centavosDe(U.$('#mv-valor', corpo));
        if (!valor) { U.erro('Informe o valor.'); return; }
        const feito = await comErro(() => API.movimentar({
          reserva_id: reservaId,
          tipo,
          valor,
          data: U.$('#mv-data', corpo).value,
          descricao: U.$('#mv-desc', corpo).value.trim(),
        }), 'Movimentacao registrada.');
        if (feito) fechar();
      };
      return U.$('#mv-valor', corpo);
    });
  }

  function modalNovaReserva() {
    U.modal((corpo, fechar) => {
      corpo.innerHTML = `
        <h2>Nova caixinha ou fundo</h2>
        <p class="modal-sub">
          Caixinha e onde voce separa dinheiro (inclusive o de terceiros que
          vai pagar a fatura). Fundo e para FII e investimentos.
        </p>
        <div class="modal-campos">
          <label class="campo">
            <span>Nome</span>
            <input type="text" id="nr-nome" maxlength="60" placeholder="Reserva de emergencia">
          </label>
          <label class="campo">
            <span>Tipo</span>
            <select id="nr-tipo">
              <option value="CAIXINHA">Caixinha</option>
              <option value="FUNDO">Fundo / FII</option>
            </select>
          </label>
          <label class="campo">
            <span>Saldo que ja existe hoje</span>
            <input type="text" data-moeda inputmode="decimal" id="nr-saldo" placeholder="R$ 0,00">
          </label>
          <label class="campo">
            <span>Meta (opcional)</span>
            <input type="text" data-moeda inputmode="decimal" id="nr-meta" placeholder="R$ 0,00">
          </label>
        </div>
        <div class="modal-rodape">
          <button type="button" class="btn-contorno" id="nr-cancelar">Cancelar</button>
          <button type="button" class="btn-roxo" id="nr-ok">Criar</button>
        </div>`;

      U.$('#nr-cancelar', corpo).onclick = fechar;
      U.$('#nr-ok', corpo).onclick = async () => {
        const nome = U.$('#nr-nome', corpo).value.trim();
        if (!nome) { U.erro('Informe o nome.'); return; }
        const meta = U.centavosDe(U.$('#nr-meta', corpo));
        const feito = await comErro(() => API.criarReserva({
          nome,
          tipo: U.$('#nr-tipo', corpo).value,
          saldo_inicial: U.centavosDe(U.$('#nr-saldo', corpo)),
          meta: meta || null,
        }), 'Caixinha criada.');
        if (feito) fechar();
      };
      return U.$('#nr-nome', corpo);
    });
  }

  /* =======================================================================
     View: gastos fixos e parcelamentos
     ======================================================================= */

  async function desenharFixos() {
    const alvo = U.$('#view-fixos');
    alvo.innerHTML = '<div class="topo"><h1>Fixos e parcelamentos</h1></div>'
                   + '<p class="ajuda">Carregando...</p>';

    const [fixos, parcelamentos] = await Promise.all([
      API.recorrencias(), API.parcelamentos(),
    ]);

    const totalFixos = fixos
      .filter((f) => f.ativa && f.fluxo === 'SAIDA')
      .reduce((s, f) => s + f.valor, 0);

    const linhasFixos = fixos.length ? fixos.map((f) => `
      <tr style="${f.ativa ? '' : 'opacity:.5'}">
        <td>
          <div class="desc">
            <span class="ponto" style="background:${U.esc(f.categoria_cor || '#94A3B8')}"></span>
            <span class="desc-texto">${U.esc(f.descricao)}</span>
            ${f.ativa ? '' : '<span class="etiqueta">inativo</span>'}
          </div>
        </td>
        <td class="col-data">dia ${f.dia}</td>
        <td style="color:var(--tinta-2)">${U.esc(f.categoria_nome || '--')}</td>
        <td>
          <span class="desc">
            <span class="ponto" style="background:${U.COR_RESP[f.responsavel]}"></span>
            ${U.rotulo(f.responsavel)}
          </span>
        </td>
        <td><span class="etiqueta etiqueta-${f.meio === 'CREDITO' ? 'credito' : 'debito'}">
          ${f.meio === 'CREDITO' ? 'Credito' : 'Pix/Deb'}</span></td>
        <td class="col-num">${U.numero(f.valor)}</td>
        <td class="col-acao">
          <button class="btn-icone" data-apagar-fixo="${f.id}"
                  title="Encerrar &quot;${U.esc(f.descricao)}&quot;" aria-label="Encerrar">&times;</button>
        </td>
      </tr>`).join('') : '';

    const linhasParc = parcelamentos.length ? parcelamentos.map((p) => `
      <tr>
        <td>
          <div class="desc">
            <span class="ponto" style="background:${U.esc(p.categoria_cor || '#94A3B8')}"></span>
            <span class="desc-texto">${U.esc(p.descricao)}</span>
          </div>
        </td>
        <td class="col-data">${U.dataBR(p.data_compra)}</td>
        <td>
          <span class="desc">
            <span class="ponto" style="background:${U.COR_RESP[p.responsavel]}"></span>
            ${U.rotulo(p.responsavel)}
          </span>
        </td>
        <td class="col-data">
          ${p.parcela_inicial > 1
            ? `${p.parcela_inicial} a ${p.num_parcelas} de ${p.num_parcelas}`
            : `1 a ${p.num_parcelas}`}
        </td>
        <td class="col-num">${U.numero(p.valor_total)}</td>
        <td class="col-num" style="color:var(--tinta-2)">${U.numero(p.ja_lancado)}</td>
        <td class="col-num">${U.numero(p.a_vencer)}</td>
        <td class="col-data">ate ${U.dataBR(p.ultima_parcela)}</td>
        <td class="col-acao">
          <button class="btn-icone" data-apagar-parcelamento="${p.id}"
                  title="Apagar o parcelamento inteiro" aria-label="Apagar">&times;</button>
        </td>
      </tr>`).join('') : '';

    alvo.innerHTML = `
      <header class="topo">
        <div>
          <h1>Fixos e parcelamentos</h1>
          <p class="topo-sub">Cadastrados uma vez, lancados sozinhos todo mes.</p>
        </div>
        <div class="topo-patrimonio">
          <span class="rotulo">Compromisso fixo mensal</span>
          <strong>${U.reais(totalFixos)}</strong>
        </div>
      </header>

      <div class="blocos">
        <section class="cartao">
          <div class="cartao-titulo">
            <h2>Gastos fixos</h2>
            <span class="nota">${U.plural(fixos.length, 'cadastro', 'cadastros')}</span>
          </div>
          ${linhasFixos ? `
            <div class="tabela-rolagem">
              <table class="tabela">
                <thead><tr>
                  <th>Descricao</th><th>Repete</th><th>Categoria</th>
                  <th>De quem</th><th>Meio</th>
                  <th style="text-align:right">Valor</th><th></th>
                </tr></thead>
                <tbody>${linhasFixos}</tbody>
              </table>
            </div>` : `
            <div class="vazio">
              <strong>Nenhum gasto fixo cadastrado</strong>
              No formulario a esquerda, escolha o tipo <strong>Fixo</strong>.
            </div>`}
        </section>

        <section class="cartao">
          <div class="cartao-titulo">
            <h2>Parcelamentos</h2>
            <span class="nota">${U.plural(parcelamentos.length, 'compra parcelada', 'compras parceladas')}</span>
          </div>
          ${linhasParc ? `
            <div class="tabela-rolagem">
              <table class="tabela">
                <thead><tr>
                  <th>Descricao</th><th>Compra</th><th>De quem</th>
                  <th title="Quais parcelas o app controla">Parcelas</th>
                  <th style="text-align:right" title="Valor total da compra original">Compra</th>
                  <th style="text-align:right">Ja lancado</th>
                  <th style="text-align:right">A vencer</th>
                  <th>Termina</th><th></th>
                </tr></thead>
                <tbody>${linhasParc}</tbody>
              </table>
            </div>
            <p class="ajuda" style="margin-top:14px">
              Em parcelamentos que ja estavam em andamento quando voce comecou
              a usar o app, "compra" e o valor cheio original &mdash; "ja lancado"
              + "a vencer" cobre so as parcelas daqui para frente.
            </p>` : `
            <div class="vazio">
              <strong>Nenhum parcelamento ativo</strong>
              No formulario a esquerda, escolha o tipo <strong>Parcelado</strong>.
            </div>`}
        </section>
      </div>`;
  }

  /* =======================================================================
     View: ajustes
     ======================================================================= */

  async function desenharAjustes() {
    const cfg = estado.dados.config;
    const categorias = estado.dados.categorias;

    U.$('#view-ajustes').innerHTML = `
      <header class="topo">
        <div>
          <h1>Ajustes</h1>
          <p class="topo-sub">Banco de dados em arquivo unico &mdash; leve para onde quiser.</p>
        </div>
      </header>

      <div class="blocos">
        <section class="cartao">
          <div class="cartao-titulo"><h2>Conta e cartao</h2></div>
          <div class="campos-claros">
            <label class="campo" style="flex:1 1 200px">
              <span>Nome da conta</span>
              <input type="text" id="cf-nome" value="${U.esc(cfg.nome_conta)}" maxlength="40">
            </label>
            <label class="campo" style="flex:0 0 150px">
              <span>Fatura fecha dia</span>
              <input type="number" id="cf-fecha" min="1" max="31" value="${cfg.dia_fechamento}">
            </label>
            <label class="campo" style="flex:0 0 150px">
              <span>Fatura vence dia</span>
              <input type="number" id="cf-vence" min="1" max="31" value="${cfg.dia_vencimento}">
            </label>
            <button class="btn-roxo" id="cf-salvar">Salvar</button>
          </div>
          <p class="ajuda" style="margin-top:12px">
            Mudar esses dias reclassifica as faturas dos lancamentos existentes
            somente quando voce editar cada um. Se precisar mudar, faca antes de
            lancar muita coisa.
          </p>
        </section>

        <section class="cartao">
          <div class="cartao-titulo"><h2>Saldo de partida</h2></div>
          <div class="campos-claros">
            <label class="campo" style="flex:0 0 200px">
              <span>Saldo informado no setup</span>
              <input type="text" data-moeda inputmode="decimal" id="cf-saldo">
            </label>
            <button class="btn-roxo" id="cf-saldo-salvar">Corrigir saldo</button>
          </div>
          <p class="ajuda" style="margin-top:12px">
            Este e o saldo que voce informou em <strong>${U.dataBR(cfg.data_corte)}</strong>.
            Use aqui se digitou errado no comeco. O saldo atual
            (${U.reais(estado.dados.conta.saldo)}) e sempre este valor mais tudo
            que voce lancou depois.
          </p>
        </section>

        <section class="cartao">
          <div class="cartao-titulo">
            <h2>Categorias</h2>
            <span class="nota">${U.plural(categorias.length, 'categoria', 'categorias')}</span>
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px">
            ${categorias.map((c) => `
              <span class="etiqueta" style="display:inline-flex;align-items:center;gap:7px;padding:6px 10px">
                <span class="ponto" style="background:${U.esc(c.cor)}"></span>
                ${U.esc(c.nome)}
                <span style="color:var(--tinta-3);font-weight:400">${c.usos}</span>
                <button class="btn-icone" style="width:18px;height:18px;font-size:13px"
                        data-apagar-categoria="${c.id}"
                        title="${c.usos ? 'Desativar (esta em uso)' : 'Apagar'}"
                        aria-label="Remover">&times;</button>
              </span>`).join('')}
          </div>
          <div class="campos-claros">
            <label class="campo" style="flex:1 1 180px">
              <span>Nova categoria</span>
              <input type="text" id="cat-nome" maxlength="40" placeholder="Pets, Viagem...">
            </label>
            <label class="campo" style="flex:0 0 84px">
              <span>Cor</span>
              <input type="color" id="cat-cor" value="#820AD1" style="padding:4px;height:41px">
            </label>
            <button class="btn-roxo" id="cat-add">Adicionar</button>
          </div>
        </section>

        <section class="cartao">
          <div class="cartao-titulo"><h2>Backup e outro computador</h2></div>
          <div class="ajuste-linha">
            <div class="texto">
              <b>Baixar o banco</b>
              <span>Um arquivo <code>.db</code> com tudo. Guarde-o ou copie para
              outro PC e use "restaurar" la para continuar exatamente daqui.</span>
            </div>
            <a class="btn-contorno" href="/api/backup" download
               style="text-decoration:none;display:inline-block">Baixar backup</a>
          </div>
          <div class="ajuste-linha">
            <div class="texto">
              <b>Restaurar de um arquivo</b>
              <span>Substitui os dados atuais pelos do arquivo. O banco de agora
              e salvo em <code>dados/backups/</code> antes, entao da para voltar.</span>
            </div>
            <div>
              <input type="file" id="rst-arquivo" accept=".db" hidden>
              <button class="btn-contorno" id="rst-botao">Escolher arquivo .db</button>
            </div>
          </div>
          <div class="ajuste-linha">
            <div class="texto">
              <b>Comecar de novo</b>
              <span>Apaga lancamentos, caixinhas, fixos e parcelamentos, e reabre
              o setup inicial. As categorias ficam. Um backup e feito antes.</span>
            </div>
            <button class="btn-perigo" id="rst-zerar">Apagar tudo e recomecar</button>
          </div>
        </section>
      </div>`;

    U.preencherMoeda(U.$('#cf-saldo'), cfg.saldo_inicial_conta);
    U.ligarMascaras(U.$('#view-ajustes'));
    ligarAjustes();
  }

  function ligarAjustes() {
    const raiz = U.$('#view-ajustes');

    U.$('#cf-salvar', raiz).onclick = () => comErro(() => API.salvarConfig({
      nome_conta: U.$('#cf-nome', raiz).value.trim() || 'Conta Nubank',
      dia_fechamento: U.$('#cf-fecha', raiz).value,
      dia_vencimento: U.$('#cf-vence', raiz).value,
    }), 'Ajustes salvos.');

    U.$('#cf-saldo-salvar', raiz).onclick = () => comErro(() => API.salvarConfig({
      saldo_inicial_conta: U.centavosDe(U.$('#cf-saldo', raiz)),
    }), 'Saldo de partida corrigido.');

    U.$('#cat-add', raiz).onclick = async () => {
      const nome = U.$('#cat-nome', raiz).value.trim();
      if (!nome) { U.erro('Informe o nome da categoria.'); return; }
      await comErro(() => API.criarCategoria({
        nome, cor: U.$('#cat-cor', raiz).value,
      }), 'Categoria criada.');
    };

    const arquivo = U.$('#rst-arquivo', raiz);
    U.$('#rst-botao', raiz).onclick = () => arquivo.click();
    arquivo.onchange = async () => {
      if (!arquivo.files.length) return;
      const certeza = await U.confirmar({
        titulo: 'Restaurar este backup?',
        texto: `"${arquivo.files[0].name}" vai substituir todos os dados atuais. `
             + 'O banco de agora sera salvo em dados/backups/ antes da troca.',
        confirmar: 'Restaurar',
      });
      if (!certeza) { arquivo.value = ''; return; }
      try {
        await API.restaurar(arquivo.files[0]);
        U.ok('Backup restaurado.');
        await iniciar();
      } catch (e) {
        U.erro(e.message);
      } finally {
        arquivo.value = '';
      }
    };

    U.$('#rst-zerar', raiz).onclick = async () => {
      const certeza = await U.confirmar({
        titulo: 'Apagar tudo e recomecar?',
        texto: 'Lancamentos, caixinhas, gastos fixos e parcelamentos serao apagados '
             + 'e o setup inicial reabre. Um backup e gravado automaticamente em '
             + 'dados/backups/ antes de apagar.',
        confirmar: 'Apagar tudo',
      });
      if (!certeza) return;
      try {
        const r = await API.resetar();
        U.ok('Dados apagados. Backup em ' + r.backup);
        await iniciar();
      } catch (e) {
        U.erro(e.message);
      }
    };
  }

  /* =======================================================================
     Eventos globais (delegacao)
     ======================================================================= */

  function ligarEventos() {
    U.ligarFundoModal();
    ligarSegmentados();
    U.ligarMascaras();

    U.$('#form-lancamento').addEventListener('submit', enviarLancamento);
    U.$('#form-lancamento').addEventListener('input', (e) => {
      if (e.target.matches('[name="valor"], [name="num_parcelas"], [name="parcela_inicial"], [name="dia"]')) {
        previsao();
      }
    });

    U.$('#seletor-mes').addEventListener('change', (e) => {
      estado.ref = e.target.value;
      estado.filtroCategoria = null;
      recarregar();
    });

    U.$('#nav').addEventListener('click', (e) => {
      const item = e.target.closest('.nav-item');
      if (!item) return;
      estado.view = item.dataset.view;
      desenhar();
    });

    // Abas
    U.$('#abas').addEventListener('click', (e) => {
      const aba = e.target.closest('.aba');
      if (!aba) return;
      estado.aba = aba.dataset.aba;
      desenharInicio();
    });

    // Clique numa barra de categoria filtra a tabela
    U.$('#cartao-categorias').addEventListener('click', (e) => {
      const barra = e.target.closest('[data-categoria]');
      if (!barra) return;
      const id = barra.dataset.categoria ? Number(barra.dataset.categoria) : null;
      estado.filtroCategoria = estado.filtroCategoria === id ? null : id;
      if (estado.aba === 'CARTAO' || estado.aba === 'CAIXINHAS') estado.aba = 'PESSOAL';
      desenharInicio();
    });
    U.$('#cartao-categorias').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        const barra = e.target.closest('[data-categoria]');
        if (barra) { e.preventDefault(); barra.click(); }
      }
    });

    // Acoes dentro do painel e das views secundarias
    document.addEventListener('click', async (e) => {
      const alvo = (attr) => e.target.closest(`[${attr}]`);

      const limpar = alvo('data-limpar-filtro');
      if (limpar) { estado.filtroCategoria = null; desenharInicio(); return; }

      const lanc = alvo('data-apagar-lanc');
      if (lanc) {
        const linha = lanc.closest('tr');
        const nome = linha?.querySelector('.desc-texto')?.textContent?.trim() || 'este lancamento';
        const certeza = await U.confirmar({
          titulo: 'Apagar lancamento?',
          texto: `"${nome}" sai das tabelas e dos totais. Se for uma parcela, `
               + 'somente ela e apagada; o resto do parcelamento continua.',
          confirmar: 'Apagar',
        });
        if (certeza) comErro(() => API.apagarLancamento(lanc.dataset.apagarLanc), 'Lancamento apagado.');
        return;
      }

      const pagar = alvo('data-pagar-fatura');
      if (pagar) { modalPagarFatura(pagar.dataset.pagarFatura); return; }

      const desfazer = alvo('data-apagar-pagamento');
      if (desfazer) {
        const certeza = await U.confirmar({
          titulo: 'Desfazer este pagamento?',
          texto: 'A fatura volta a ficar em aberto. Se o pagamento saiu de uma '
               + 'caixinha, o dinheiro volta para ela automaticamente.',
          confirmar: 'Desfazer',
        });
        if (certeza) comErro(() => API.apagarPagamento(desfazer.dataset.apagarPagamento), 'Pagamento desfeito.');
        return;
      }

      const mov = alvo('data-mov');
      if (mov) { modalMovimentacao(Number(mov.dataset.reserva), mov.dataset.mov); return; }

      const novaReserva = alvo('data-nova-reserva');
      if (novaReserva) { modalNovaReserva(); return; }

      const apagarMov = alvo('data-apagar-mov');
      if (apagarMov) {
        const certeza = await U.confirmar({
          titulo: 'Apagar movimentacao?',
          texto: 'O saldo da caixinha e da conta sao recalculados.',
          confirmar: 'Apagar',
        });
        if (certeza) comErro(() => API.apagarMovimentacao(apagarMov.dataset.apagarMov), 'Movimentacao apagada.');
        return;
      }

      const fixo = alvo('data-apagar-fixo');
      if (fixo) {
        const certeza = await U.confirmar({
          titulo: 'Encerrar este gasto fixo?',
          texto: 'Ele para de aparecer nos proximos meses. Os lancamentos de meses '
               + 'que ja passaram continuam no historico -- voce realmente pagou.',
          confirmar: 'Encerrar',
        });
        if (certeza && await comErro(() => API.apagarRecorrencia(fixo.dataset.apagarFixo), 'Gasto fixo encerrado.')) {
          desenharFixos();
        }
        return;
      }

      const parc = alvo('data-apagar-parcelamento');
      if (parc) {
        const certeza = await U.confirmar({
          titulo: 'Apagar o parcelamento inteiro?',
          texto: 'TODAS as parcelas saem das faturas, inclusive as que ja passaram. '
               + 'Para tirar so uma parcela, apague-a na tabela do mes.',
          confirmar: 'Apagar tudo',
        });
        if (certeza && await comErro(() => API.apagarParcelamento(parc.dataset.apagarParcelamento), 'Parcelamento apagado.')) {
          desenharFixos();
        }
        return;
      }

      const cat = alvo('data-apagar-categoria');
      if (cat) {
        const certeza = await U.confirmar({
          titulo: 'Remover categoria?',
          texto: 'Se ela ja foi usada em algum lancamento, e apenas desativada '
               + '(o historico continua correto). Se nunca foi usada, e apagada.',
          confirmar: 'Remover',
        });
        if (certeza && await comErro(() => API.apagarCategoria(cat.dataset.apagarCategoria), 'Categoria removida.')) {
          desenharAjustes();
        }
        return;
      }
    });

    // Troca de fatura na aba do cartao
    document.addEventListener('change', (e) => {
      if (e.target.matches('[data-trocar-fatura]')) {
        estado.refFatura = e.target.value;
        desenharAba();
      }
    });
  }

  /* =======================================================================
     Inicio
     ======================================================================= */

  async function iniciar() {
    const cfg = await API.config();

    if (!cfg.setup_concluido) {
      U.$('#app').hidden = true;
      await Setup.abrir(cfg);
      return;
    }

    U.$('#tela-setup').hidden = true;
    U.$('#app').hidden = false;

    estado.dados = await API.estado(estado.ref);
    estado.ref = estado.dados.mes.ref;

    // Seletor de mes: nunca antes do mes inicial (requisito do projeto).
    U.$('#seletor-mes').innerHTML = estado.dados.meses.map((m) =>
      `<option value="${m.ref}" ${m.ref === estado.ref ? 'selected' : ''}>
         ${U.esc(m.rotulo)}${m.atual ? ' (atual)' : ''}
       </option>`).join('');

    // A data comeca em hoje, limitada ao intervalo que o app aceita.
    const campoData = U.$('[name="data"]');
    campoData.min = `${estado.dados.config.mes_inicial}-01`;
    campoData.value = U.hojeISO() > campoData.min ? U.hojeISO() : campoData.min;

    await recarregar();
    U.$('[name="descricao"]').focus();
  }

  async function principal() {
    ligarEventos();
    try {
      await iniciar();
    } catch (e) {
      U.erro(e.message);
    }
  }

  document.addEventListener('DOMContentLoaded', principal);

  return { iniciar, recarregar };
})();
