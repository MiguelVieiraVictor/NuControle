/* Partida do site: confere a configuracao, cuida do login (entrar, esqueci
   a senha, criar senha pelo convite) e so entao abre o app.

   O cadastro e so por convite: nao existe "criar conta" aqui, e o Supabase
   esta com o cadastro publico desligado. Quem foi convidado recebe um e-mail,
   clica no link, cai aqui com type=invite e define a senha. */

import { criarApi } from "./api.js";
import { validarConfig } from "./nucleo/configuracao.js";
import { servidorLocal, servidorSupabase } from "./servidor.js";

const SENHA_MINIMA = 8;

const $ = (sel) => document.querySelector(sel);
/* global App */ // definido em app.js (script classico, carregado antes deste modulo)

function mostrar(formulario, mensagem = "", tipo = "erro") {
  $("#app").hidden = true;
  $("#entrada").hidden = false;
  for (const f of ["#form-login", "#form-esqueci", "#form-senha"]) $(f).hidden = f !== formulario;
  const msg = $("#entrada-msg");
  msg.textContent = mensagem;
  msg.className = `entrada-msg ${tipo}`;
  msg.hidden = !mensagem;
  const primeiro = $(`${formulario} input`);
  if (primeiro) primeiro.focus();
}

function falhaFatal(texto) {
  $("#app").hidden = true;
  $("#entrada").hidden = false;
  for (const f of ["#form-login", "#form-esqueci", "#form-senha"]) $(f).hidden = true;
  const msg = $("#entrada-msg");
  msg.textContent = texto;
  msg.className = "entrada-msg erro";
  msg.hidden = false;
}

/** Desabilita o botao do formulario enquanto `fn` roda. */
async function ocupado(form, fn) {
  const botao = form.querySelector("button[type=submit]");
  botao.disabled = true;
  try {
    await fn();
  } finally {
    botao.disabled = false;
  }
}

function mensagemDeLogin(erro) {
  const m = erro?.message || "";
  if (erro?.status === 429 || /rate limit|too many/i.test(m)) return "Muitas tentativas. Espere alguns minutos e tente de novo.";
  if (/invalid login credentials/i.test(m)) return "E-mail ou senha incorretos.";
  if (/email not confirmed/i.test(m)) return "Confirme o e-mail pelo link do convite antes de entrar.";
  if (/should be different/i.test(m)) return "A senha nova precisa ser diferente da atual.";
  if (/password/i.test(m) && /(weak|least|characters)/i.test(m)) return `Senha fraca. Use pelo menos ${SENHA_MINIMA} caracteres, misturando letras e números.`;
  if (erro instanceof TypeError || /fetch|network/i.test(m)) return "Sem conexão com o servidor. Verifique a internet.";
  return `Não deu certo: ${m || "erro desconhecido"}`;
}

function validarSenha(senha, confirmacao) {
  if (senha.length < SENHA_MINIMA) return `A senha precisa ter pelo menos ${SENHA_MINIMA} caracteres.`;
  if (senha !== confirmacao) return "As duas senhas não são iguais.";
  return null;
}

async function abrirApp(servidor, sessao) {
  $("#entrada").hidden = true;
  $("#app").hidden = false;
  window.Sessao = sessao;
  window.api = criarApi(servidor);
  try {
    await window.api.iniciar();
  } catch (e) {
    console.error(e);
    $("#conteudo").innerHTML = "";
    const aviso = document.createElement("div");
    aviso.className = "card vazio";
    aviso.textContent = `Não foi possível carregar seus dados. ${e.message}`;
    $("#conteudo").appendChild(aviso);
    return;
  }
  await App.iniciar();

  // Voltando para o site depois de um tempo (outro aparelho pode ter mexido): atualiza.
  let ultimaCarga = Date.now();
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState !== "visible" || Date.now() - ultimaCarga < 30_000) return;
    ultimaCarga = Date.now();
    if ($("#modal").open) return;
    try {
      await window.api.recarregarTudo();
      await App.recarregarEstado();
      App.recarregar();
    } catch (e) {
      console.error(e);
    }
  });
}

async function iniciar() {
  const cfg = window.NUCONTROLE || {};

  if (cfg.modoLocal) {
    // desenvolvimento: sem Supabase, dados no localStorage deste navegador
    return abrirApp(servidorLocal(), {
      email: "modo-local@teste",
      local: true,
      sair: async () => location.reload(),
      trocarSenha: async () => {},
    });
  }

  let conf;
  try {
    conf = validarConfig(cfg);
  } catch (e) {
    return falhaFatal(`O site está mal configurado: ${e.message}`);
  }
  if (!window.supabase?.createClient) return falhaFatal("Não consegui carregar a biblioteca do Supabase.");

  // O link do e-mail (convite ou recuperar senha) chega com dados no #hash,
  // que o Supabase consome ao iniciar; lemos o tipo antes.
  const hash = new URLSearchParams(location.hash.slice(1));
  const busca = new URLSearchParams(location.search);
  const tipoLink = hash.get("type");
  const erroLink = hash.get("error_description") || busca.get("error_description");

  const sb = window.supabase.createClient(conf.supabaseUrl, conf.supabaseChave, {
    auth: { flowType: "implicit", persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  const { data } = await sb.auth.getSession();
  if (location.hash || erroLink) history.replaceState(null, "", location.pathname);

  const sessao = (s) => ({
    email: s.user.email,
    sair: async () => {
      await sb.auth.signOut();
      location.reload();
    },
    trocarSenha: async (senha) => {
      const { error } = await sb.auth.updateUser({ password: senha });
      if (error) throw new Error(mensagemDeLogin(error));
    },
  });
  const entrar = (s) => abrirApp(servidorSupabase(sb), sessao(s));
  let definindoSenha = false;

  sb.auth.onAuthStateChange((evento) => {
    if (evento === "PASSWORD_RECOVERY") {
      definindoSenha = true;
      mostrar("#form-senha", "Escolha a sua nova senha.", "info");
    }
    if (evento === "SIGNED_OUT" && !$("#app").hidden) location.reload();
  });

  /* ---------------------------------------------- formularios */

  $("#form-login").addEventListener("submit", (ev) => {
    ev.preventDefault();
    ocupado(ev.currentTarget, async () => {
      const { data: d, error } = await sb.auth.signInWithPassword({
        email: $("#login-email").value.trim(),
        password: $("#login-senha").value,
      });
      if (error) return mostrar("#form-login", mensagemDeLogin(error));
      $("#login-senha").value = "";
      await entrar(d.session);
    });
  });

  $("#link-esqueci").addEventListener("click", (ev) => {
    ev.preventDefault();
    $("#esqueci-email").value = $("#login-email").value;
    mostrar("#form-esqueci");
  });
  $("#link-voltar").addEventListener("click", (ev) => {
    ev.preventDefault();
    mostrar("#form-login");
  });

  $("#form-esqueci").addEventListener("submit", (ev) => {
    ev.preventDefault();
    ocupado(ev.currentTarget, async () => {
      const email = $("#esqueci-email").value.trim();
      if (!email) return mostrar("#form-esqueci", "Informe o e-mail.");
      const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
      if (error && (error.status === 429 || /rate limit/i.test(error.message))) {
        return mostrar("#form-esqueci", mensagemDeLogin(error));
      }
      // mesma resposta exista ou nao a conta: o site nao revela quem esta cadastrado
      mostrar("#form-login", "Se esse e-mail tiver conta, chega em instantes um link para criar uma senha nova. Confira o spam.", "info");
    });
  });

  $("#form-senha").addEventListener("submit", (ev) => {
    ev.preventDefault();
    ocupado(ev.currentTarget, async () => {
      const senha = $("#senha-nova").value;
      const problema = validarSenha(senha, $("#senha-confirma").value);
      if (problema) return mostrar("#form-senha", problema);
      const { error } = await sb.auth.updateUser({ password: senha });
      if (error) return mostrar("#form-senha", mensagemDeLogin(error));
      $("#senha-nova").value = "";
      $("#senha-confirma").value = "";
      definindoSenha = false;
      const { data: d } = await sb.auth.getSession();
      await entrar(d.session);
    });
  });

  /* ---------------------------------------------- para onde ir */

  if (erroLink) {
    return mostrar("#form-login", "Esse link expirou ou já foi usado. Peça um novo (em “Esqueci minha senha”, ou um novo convite).");
  }
  if (data.session && (tipoLink === "invite" || tipoLink === "recovery")) {
    return mostrar("#form-senha",
      tipoLink === "invite" ? "Bem-vindo! Crie a sua senha para entrar." : "Escolha a sua nova senha.", "info");
  }
  if (data.session && !definindoSenha) return entrar(data.session);
  mostrar("#form-login");
}

// A tela de Ajustes (script classico) usa a mesma validacao para trocar a senha.
window.validarSenha = validarSenha;

iniciar().catch((e) => {
  console.error(e);
  falhaFatal(`Não foi possível iniciar: ${e.message}`);
});
