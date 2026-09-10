/* ===========================================================================
   Setup de primeiro uso.

   Ele existe porque o app comeca em setembro/2026 sem historico: sem
   informar os saldos de partida e os parcelamentos que ja estavam rolando,
   nada fecharia com a realidade no primeiro mes.
   =========================================================================== */

const Setup = (() => {

  let categorias = [];
  let config = null;

  const MESES = [
    'janeiro', 'fevereiro', 'marco', 'abril', 'maio', 'junho',
    'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro',
  ];

  function mesPorExtenso(ref) {
    const [ano, mes] = ref.split('-');
    return `${MESES[parseInt(mes, 10) - 1]} de ${ano}`;
  }

  /* -- Linhas dinamicas -------------------------------------------------- */

  function linhaReserva() {
    const div = document.createElement('div');
    div.className = 'item-editavel';
    div.dataset.tipo = 'reserva';
    div.innerHTML = `
      <label class="campo">
        <span>Nome</span>
        <input type="text" data-campo="nome" placeholder="Reserva de emergencia" maxlength="60">
      </label>
      <label class="campo" style="flex:0 0 128px">
        <span>Tipo</span>
        <select data-campo="tipo">
          <option value="CAIXINHA">Caixinha</option>
          <option value="FUNDO">Fundo / FII</option>
        </select>
      </label>
      <label class="campo" style="flex:0 0 132px">
        <span>Saldo hoje</span>
        <input type="text" data-campo="saldo" data-moeda inputmode="decimal" placeholder="R$ 0,00">
      </label>
      <label class="campo" style="flex:0 0 132px">
        <span>Meta (opcional)</span>
        <input type="text" data-campo="meta" data-moeda inputmode="decimal" placeholder="R$ 0,00">
      </label>
      <button type="button" class="btn-icone" data-remover aria-label="Remover">&times;</button>`;
    return div;
  }

  function linhaParcelamento() {
    const div = document.createElement('div');
    div.className = 'item-editavel';
    div.dataset.tipo = 'parcelamento';
    div.innerHTML = `
      <label class="campo">
        <span>Descricao</span>
        <input type="text" data-campo="descricao" placeholder="Notebook" maxlength="60">
      </label>
      <label class="campo" style="flex:0 0 128px">
        <span>Valor da parcela</span>
        <input type="text" data-campo="valor_parcela" data-moeda inputmode="decimal" placeholder="R$ 0,00">
      </label>
      <label class="campo" style="flex:0 0 86px">
        <span>Total de x</span>
        <input type="number" data-campo="num_parcelas" min="1" max="120" value="10">
      </label>
      <label class="campo" style="flex:0 0 92px">
        <span>Proxima e a</span>
        <input type="number" data-campo="parcela_inicial" min="1" max="120" value="1">
      </label>
      <label class="campo" style="flex:0 0 120px">
        <span>De quem</span>
        <select data-campo="responsavel">
          <option value="PESSOAL">Pessoal</option>
          <option value="TERCEIROS">Terceiros</option>
          <option value="GENESYS">Genesys</option>
        </select>
      </label>
      <label class="campo" style="flex:0 0 130px">
        <span>Categoria</span>
        <select data-campo="categoria_id">
          ${categorias.map((c) => `<option value="${c.id}">${U.esc(c.nome)}</option>`).join('')}
        </select>
      </label>
      <button type="button" class="btn-icone" data-remover aria-label="Remover">&times;</button>`;
    return div;
  }

  function adicionar(qual) {
    const alvo = qual === 'reserva' ? U.$('#setup-reservas') : U.$('#setup-parcelamentos');
    const linha = qual === 'reserva' ? linhaReserva() : linhaParcelamento();
    alvo.appendChild(linha);
    U.ligarMascaras(linha);
    linha.querySelector('input')?.focus();
  }

  /* -- Coleta ------------------------------------------------------------ */

  function coletar(seletor) {
    return U.$$(`${seletor} .item-editavel`).map((linha) => {
      const dados = {};
      U.$$('[data-campo]', linha).forEach((campo) => {
        const nome = campo.dataset.campo;
        dados[nome] = campo.hasAttribute('data-moeda')
          ? U.centavosDe(campo)
          : campo.value.trim();
      });
      return dados;
    });
  }

  /* -- Envio ------------------------------------------------------------- */

  async function enviar(zerado = false) {
    const form = U.$('#form-setup');
    const botao = form.querySelector('button[type="submit"]');

    let corpo = { data_corte: U.$('[name="data_corte"]', form).value || U.hojeISO() };

    if (!zerado) {
      const reservas = coletar('#setup-reservas')
        .filter((r) => r.nome)
        .map((r) => ({ nome: r.nome, tipo: r.tipo, saldo: r.saldo, meta: r.meta || null }));

      const parcelamentos = coletar('#setup-parcelamentos')
        .filter((p) => p.descricao && p.valor_parcela > 0)
        .map((p) => ({
          descricao: p.descricao,
          valor_parcela: p.valor_parcela,
          num_parcelas: parseInt(p.num_parcelas, 10) || 1,
          parcela_inicial: parseInt(p.parcela_inicial, 10) || 1,
          responsavel: p.responsavel,
          categoria_id: p.categoria_id ? parseInt(p.categoria_id, 10) : null,
        }));

      const invalido = parcelamentos.find((p) => p.parcela_inicial > p.num_parcelas);
      if (invalido) {
        U.erro(
          `Em "${invalido.descricao}", a proxima parcela (${invalido.parcela_inicial}) `
          + `nao pode ser maior que o total (${invalido.num_parcelas}).`
        );
        return;
      }

      corpo = {
        ...corpo,
        saldo_conta: U.centavosDe(U.$('[name="saldo_conta"]', form)),
        reservas,
        parcelamentos,
        fatura_aberta: {
          valor: U.centavosDe(U.$('[name="fatura_aberta"]', form)),
          responsavel: U.$('[name="fatura_responsavel"]', form).value,
        },
      };
    }

    botao.disabled = true;
    try {
      await API.setup(corpo);
      U.$('#tela-setup').hidden = true;
      U.ok('Tudo pronto. Bom controle!');
      await App.iniciar();
    } catch (e) {
      U.erro(e.message);
    } finally {
      botao.disabled = false;
    }
  }

  /* -- Abertura ---------------------------------------------------------- */

  async function abrir(cfg) {
    config = cfg;
    categorias = await API.categorias();

    U.$('#setup-mes-inicial').textContent = mesPorExtenso(config.mes_inicial);

    // A data de corte comeca em hoje, mas nunca antes do mes inicial.
    const campoData = U.$('[name="data_corte"]');
    const primeiroDia = `${config.mes_inicial}-01`;
    const hoje = U.hojeISO();
    campoData.min = primeiroDia;
    campoData.value = hoje > primeiroDia ? hoje : primeiroDia;

    U.$('#setup-janela-fatura').innerHTML =
      `Sua fatura fecha dia <strong>${config.dia_fechamento}</strong> e vence dia `
      + `<strong>${config.dia_vencimento}</strong>. Informe aqui o que ja esta `
      + 'na fatura aberta agora, para o total a pagar sair certo. Deixe vazio '
      + 'se voce acabou de pagar a fatura anterior e ainda nao gastou nada.';

    // Uma linha de cada, para o formulario nao parecer vazio.
    adicionar('reserva');

    U.$$('[data-add]').forEach((botao) => {
      botao.onclick = () => adicionar(botao.dataset.add);
    });

    U.$('#form-setup').addEventListener('click', (e) => {
      const remover = e.target.closest('[data-remover]');
      if (remover) remover.closest('.item-editavel').remove();
    });

    U.$('#form-setup').addEventListener('submit', (e) => {
      e.preventDefault();
      enviar(false);
    });

    U.$('#setup-pular').onclick = async () => {
      const certeza = await U.confirmar({
        titulo: 'Comecar tudo zerado?',
        texto: 'Saldo da conta em R$ 0,00, sem caixinhas e sem parcelamentos. '
             + 'Voce pode cadastrar tudo depois, mas os saldos so ficam certos '
             + 'quando voce informar os valores de partida.',
        confirmar: 'Comecar zerado',
        perigo: false,
      });
      if (certeza) enviar(true);
    };

    U.ligarMascaras();
    U.$('#tela-setup').hidden = false;
    U.$('[name="saldo_conta"]').focus();
  }

  return { abrir };
})();
