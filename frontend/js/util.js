/* ===========================================================================
   Utilitarios: dinheiro, datas, DOM, avisos e modal.

   Dinheiro no front tambem e SEMPRE int em centavos, igual ao Python.
   Nenhum float atravessa a fronteira, nos dois sentidos.
   =========================================================================== */

const U = (() => {

  /* -- Dinheiro ---------------------------------------------------------- */

  const fmtBR = new Intl.NumberFormat('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  /** 123456 -> "R$ 1.234,56" */
  function reais(centavos) {
    const n = Number(centavos) || 0;
    const sinal = n < 0 ? '-' : '';
    return `${sinal}R$ ${fmtBR.format(Math.abs(n) / 100)}`;
  }

  /** 123456 -> "1.234,56" (sem o R$, para tabelas apertadas) */
  function numero(centavos) {
    return fmtBR.format((Number(centavos) || 0) / 100);
  }

  /** Le os digitos de um campo com mascara e devolve centavos. */
  function centavosDe(input) {
    const digitos = String(input?.value ?? '').replace(/\D/g, '');
    return digitos ? parseInt(digitos, 10) : 0;
  }

  /**
   * Mascara de moeda que digita da direita para a esquerda.
   * Digitando "4490" a pessoa ve "R$ 44,90" -- e o jeito que nao deixa
   * duvida sobre onde esta a virgula.
   */
  function aplicarMascara(input) {
    const digitos = input.value.replace(/\D/g, '').replace(/^0+/, '');
    input.value = digitos ? `R$ ${fmtBR.format(parseInt(digitos, 10) / 100)}` : '';
  }

  function ligarMascaras(raiz = document) {
    raiz.querySelectorAll('input[data-moeda]').forEach((input) => {
      if (input.dataset.mascaraLigada) return;
      input.dataset.mascaraLigada = '1';
      input.addEventListener('input', () => aplicarMascara(input));
    });
  }

  function preencherMoeda(input, centavos) {
    input.value = centavos ? `R$ ${fmtBR.format(centavos / 100)}` : '';
  }

  /* -- Datas ------------------------------------------------------------- */

  /** "2026-09-08" -> "08/09" */
  function diaMes(iso) {
    if (!iso) return '';
    const [, m, d] = iso.slice(0, 10).split('-');
    return `${d}/${m}`;
  }

  /** "2026-09-08" -> "08/09/2026" */
  function dataBR(iso) {
    if (!iso) return '';
    const [a, m, d] = iso.slice(0, 10).split('-');
    return `${d}/${m}/${a}`;
  }

  /** Hoje em "AAAA-MM-DD", no fuso local (nunca em UTC). */
  function hojeISO() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  /* -- DOM --------------------------------------------------------------- */

  /**
   * Escapa texto para interpolar em HTML.
   * Descricao de lancamento e texto livre do usuario: sem isso, digitar
   * "<b>" na descricao quebraria a pagina.
   */
  function esc(texto) {
    return String(texto ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  const $ = (sel, raiz = document) => raiz.querySelector(sel);
  const $$ = (sel, raiz = document) => Array.from(raiz.querySelectorAll(sel));

  /* -- Avisos ------------------------------------------------------------ */

  function aviso(mensagem, tipo = 'info') {
    const caixa = $('#avisos');
    const el = document.createElement('div');
    el.className = `aviso aviso-${tipo}`;
    el.textContent = mensagem;
    caixa.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transform = 'translateY(8px)';
      setTimeout(() => el.remove(), 250);
    }, tipo === 'erro' ? 6500 : 3200);
  }

  const ok = (m) => aviso(m, 'ok');
  const erro = (m) => aviso(m, 'erro');

  /* -- Modal ------------------------------------------------------------- */

  let fecharAtual = null;

  /**
   * Abre um modal. `montar(corpo, fechar)` recebe o elemento e a funcao
   * de fechar, e devolve opcionalmente o elemento que deve receber foco.
   */
  function modal(montar) {
    const fundo = $('#modal-fundo');
    const corpo = $('#modal');
    corpo.innerHTML = '';

    const fechar = () => {
      fundo.hidden = true;
      corpo.innerHTML = '';
      document.removeEventListener('keydown', porEsc);
      fecharAtual = null;
    };
    const porEsc = (e) => { if (e.key === 'Escape') fechar(); };

    fecharAtual = fechar;
    const foco = montar(corpo, fechar);
    fundo.hidden = false;
    document.addEventListener('keydown', porEsc);
    ligarMascaras(corpo);
    (foco || corpo.querySelector('input, select, button'))?.focus();
    return fechar;
  }

  function ligarFundoModal() {
    $('#modal-fundo').addEventListener('click', (e) => {
      if (e.target.id === 'modal-fundo' && fecharAtual) fecharAtual();
    });
  }

  /** Confirmacao com texto proprio -- usada antes de apagar qualquer coisa. */
  function confirmar({ titulo, texto, confirmar: rotulo = 'Confirmar', perigo = true }) {
    return new Promise((resolve) => {
      modal((corpo, fechar) => {
        corpo.innerHTML = `
          <h2>${esc(titulo)}</h2>
          <p class="modal-sub">${esc(texto)}</p>
          <div class="modal-rodape">
            <button type="button" class="btn-contorno" data-acao="nao">Cancelar</button>
            <button type="button" class="${perigo ? 'btn-perigo' : 'btn-roxo'}" data-acao="sim">
              ${esc(rotulo)}
            </button>
          </div>`;
        corpo.querySelector('[data-acao="nao"]').onclick = () => { fechar(); resolve(false); };
        corpo.querySelector('[data-acao="sim"]').onclick = () => { fechar(); resolve(true); };
        return corpo.querySelector('[data-acao="nao"]');
      });
    });
  }

  /* -- Rotulos ----------------------------------------------------------- */

  const ROTULO = {
    PESSOAL: 'Pessoal',
    TERCEIROS: 'Terceiros',
    GENESYS: 'Genesys',
    FIXO: 'Fixos',
    PARCELAMENTO: 'Parcelamentos',
    AVULSO: 'Avulsos',
    CREDITO: 'Credito',
    DEBITO: 'Pix / Debito',
    CAIXINHA: 'Caixinha',
    FUNDO: 'Fundo',
    DEPOSITO: 'Deposito',
    SAQUE: 'Saque',
    RENDIMENTO: 'Rendimento',
    ABERTA: 'Aberta',
    FECHADA: 'Fechada',
    PAGA: 'Paga',
    PARCIAL: 'Parcial',
    FUTURA: 'Futura',
  };

  const COR_RESP = {
    PESSOAL: 'var(--dado-pessoal)',
    TERCEIROS: 'var(--dado-terceiros)',
    GENESYS: 'var(--dado-genesys)',
  };

  const rotulo = (chave) => ROTULO[chave] || chave;

  /** "3 lancamentos" / "1 lancamento" */
  function plural(n, singular, plural_) {
    return `${n} ${n === 1 ? singular : plural_}`;
  }

  return {
    reais, numero, centavosDe, aplicarMascara, ligarMascaras, preencherMoeda,
    diaMes, dataBR, hojeISO,
    esc, $, $$,
    aviso, ok, erro,
    modal, ligarFundoModal, confirmar,
    rotulo, ROTULO, COR_RESP, plural,
  };
})();
