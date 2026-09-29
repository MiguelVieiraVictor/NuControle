/* Utilitarios: dinheiro, datas, HTML seguro, modal e avisos.
   Dinheiro e SEMPRE centavos inteiros aqui tambem -- nunca reais em float. */

const PALETA_DONOS = [
  // ordem validada para daltonismo (pares vizinhos) sobre a superficie escura;
  // o 1o e o do "Eu". Terceiros novos recebem a proxima cor livre.
  "#9085E9", "#199E70", "#D95926", "#3987E5", "#C98500", "#D55181", "#008300", "#E66767",
];

const PALETA_CATEGORIAS = [
  "#FF8A65", "#FFD54F", "#4DD0E1", "#B388FF", "#7986CB", "#EF5350",
  "#F06292", "#4FC3F7", "#9575CD", "#90A4AE", "#A1887F", "#66BB6A", "#78909C",
];

/** 123456 -> "R$ 1.234,56" (aritmetica inteira, sem float). */
function reais(centavos, { sinal = false } = {}) {
  const n = Math.trunc(Number(centavos) || 0);
  const neg = n < 0;
  const abs = Math.abs(n);
  const inteiro = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const cent = String(abs % 100).padStart(2, "0");
  const prefixo = neg ? "-" : sinal && n > 0 ? "+" : "";
  return `${prefixo}R$ ${inteiro},${cent}`;
}

/** Texto de um input de dinheiro -> centavos. "1.234,56" -> 123456. */
function centavosDe(texto) {
  const digitos = String(texto || "").replace(/\D/g, "");
  return digitos ? parseInt(digitos, 10) : 0;
}

/** Centavos -> texto do input. 123456 -> "1.234,56". */
function textoDinheiro(centavos) {
  return reais(centavos).replace("R$ ", "");
}

/** Mascara de digitacao estilo app de banco: os digitos entram pela direita. */
function mascararDinheiro(input) {
  const aplicar = () => {
    const c = centavosDe(input.value);
    input.value = c ? textoDinheiro(c) : "";
  };
  input.addEventListener("input", aplicar);
  aplicar();
}

const MESES = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
  "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
const MESES_CURTOS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];

function rotuloMes(ref) {
  const [a, m] = ref.split("-").map(Number);
  return `${MESES[m - 1]} ${a}`;
}
function rotuloMesCurto(ref) {
  const [a, m] = ref.split("-").map(Number);
  return `${MESES_CURTOS[m - 1]}/${String(a).slice(2)}`;
}
function somarMes(ref, delta) {
  const [a, m] = ref.split("-").map(Number);
  const t = a * 12 + (m - 1) + delta;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
}
/** "2026-09-08" -> "08/09" (ou "08/09/2026" com ano). */
function dataBR(iso, { ano = false } = {}) {
  if (!iso) return "";
  const [a, m, d] = iso.split("-");
  return ano ? `${d}/${m}/${a}` : `${d}/${m}`;
}

/** Escapa texto para HTML. Todo dado do usuario passa por aqui. */
function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

function icone(nome) {
  return `<svg aria-hidden="true"><use href="#i-${nome}"/></svg>`;
}

function iniciais(nome) {
  const p = String(nome).trim().split(/\s+/);
  return ((p[0] || "")[0] + (p.length > 1 ? p[p.length - 1][0] : (p[0] || "")[1] || "")).toUpperCase();
}

function $(sel, raiz = document) { return raiz.querySelector(sel); }
function $$(sel, raiz = document) { return [...raiz.querySelectorAll(sel)]; }

/* ------------------------------------------------------------------ avisos */

function avisar(texto, tipo = "ok") {
  const el = document.createElement("div");
  el.className = `aviso ${tipo === "erro" ? "erro" : ""}`;
  el.textContent = texto;
  $("#avisos").appendChild(el);
  setTimeout(() => el.remove(), tipo === "erro" ? 6000 : 3000);
}

/* ------------------------------------------------------------------ modal */

const Modal = {
  el: null,
  _aoSalvar: null,

  /**
   * Abre o modal.
   *   titulo, corpo (HTML), botoes: [{texto, classe, acao: "salvar"|"fechar"|fn, esquerda}]
   *   aoAbrir(corpoEl), aoSalvar(corpoEl) -> Promise (erro vira mensagem no modal)
   */
  abrir({ titulo, corpo, botoes, aoAbrir, aoSalvar, largura }) {
    this.el = $("#modal");
    this.el.style.maxWidth = largura || "";
    $("#modal-titulo").textContent = titulo;
    $("#modal-corpo").innerHTML = corpo;
    this.erro(null);
    this._aoSalvar = aoSalvar;

    const rodape = $("#modal-rodape");
    rodape.innerHTML = "";
    for (const b of botoes || [
      { texto: "Cancelar", acao: "fechar" },
      { texto: "Salvar", classe: "btn-primario", acao: "salvar" },
    ]) {
      const btn = document.createElement("button");
      btn.type = b.acao === "salvar" ? "submit" : "button";
      btn.className = `btn ${b.classe || ""} ${b.esquerda ? "esquerda" : ""}`;
      btn.textContent = b.texto;
      if (b.acao === "fechar") btn.addEventListener("click", () => this.fechar());
      else if (typeof b.acao === "function") btn.addEventListener("click", () => b.acao());
      rodape.appendChild(btn);
    }

    if (!this.el.open) this.el.showModal();
    if (aoAbrir) aoAbrir($("#modal-corpo"));
    const primeiro = $("#modal-corpo input:not([type=hidden]):not([type=color]), #modal-corpo select");
    if (primeiro) primeiro.focus();
  },

  fechar() { if (this.el && this.el.open) this.el.close(); },

  erro(msg) {
    const el = $("#modal-erro");
    el.hidden = !msg;
    el.textContent = msg || "";
  },

  async _enviar(ev) {
    ev.preventDefault();
    if (!this._aoSalvar) return;
    const botao = $("#modal-rodape button[type=submit]");
    if (botao) botao.disabled = true;
    try {
      await this._aoSalvar($("#modal-corpo"));
      this.fechar();
    } catch (e) {
      this.erro(e.message);
    } finally {
      if (botao) botao.disabled = false;
    }
  },
};

document.addEventListener("DOMContentLoaded", () => {
  $("#modal-form").addEventListener("submit", (ev) => Modal._enviar(ev));
  $("#modal [data-fechar]").addEventListener("click", () => Modal.fechar());
});

/** Confirmacao no mesmo estilo do app. Resolve true/false. */
function confirmar(titulo, texto, { botao = "Confirmar", perigo = true } = {}) {
  return new Promise((resolve) => {
    let resposta = false;
    Modal.abrir({
      titulo,
      corpo: `<div style="color:var(--texto-2)">${texto}</div>`,
      largura: "440px",
      botoes: [
        { texto: "Cancelar", acao: "fechar" },
        { texto: botao, classe: perigo ? "btn-perigo" : "btn-primario", acao: () => { resposta = true; Modal.fechar(); } },
      ],
    });
    Modal.el.addEventListener("close", () => resolve(resposta), { once: true });
  });
}

/* ------------------------------------------------------------------ dica flutuante */

const Dica = {
  el: null,
  mostrar(html, x, y) {
    if (!this.el) {
      this.el = document.createElement("div");
      this.el.className = "dica-flutuante";
      document.body.appendChild(this.el);
    }
    this.el.innerHTML = html;
    this.el.hidden = false;
    const r = this.el.getBoundingClientRect();
    this.el.style.left = `${Math.min(x + 14, innerWidth - r.width - 8)}px`;
    this.el.style.top = `${Math.min(y + 14, innerHeight - r.height - 8)}px`;
  },
  esconder() { if (this.el) this.el.hidden = true; },
};

document.addEventListener("mousemove", (ev) => {
  const alvo = ev.target.closest("[data-dica]");
  if (alvo) Dica.mostrar(alvo.dataset.dica, ev.clientX, ev.clientY);
  else Dica.esconder();
});
