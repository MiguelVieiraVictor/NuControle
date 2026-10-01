/* Onde os dados moram: o Supabase (ou, no modo local de desenvolvimento,
   o proprio navegador).

   Um "servidor" tem duas funcoes:
     carregar() -> {tabela: [linhas]}   todas as linhas do usuario logado
     aplicar(ops)                        grava a diferenca (tudo ou nada)

   Erros saem como ErroServidor, com mensagem para o usuario e `recarregar`
   dizendo se vale a pena buscar os dados de novo (outro aparelho mexeu). */

import { Banco, TABELAS, aplicarOps } from "./nucleo/banco.js";

const POR_PAGINA = 1000; // limite padrao de linhas por resposta do Supabase

export class ErroServidor extends Error {
  constructor(mensagem, { recarregar = false, sessao = false } = {}) {
    super(mensagem);
    this.name = "ErroServidor";
    this.recarregar = recarregar;
    this.sessao = sessao;
  }
}

function traduzir(erro) {
  const cod = erro && erro.code;
  const conflito = "Atualizei os dados com o que está no servidor; confira e tente de novo.";
  if (cod === "40001") return new ErroServidor(`Seus dados mudaram em outro aparelho. ${conflito}`, { recarregar: true });
  if (cod === "23505") return new ErroServidor(`Isso já existe (talvez criado em outro aparelho). ${conflito}`, { recarregar: true });
  if (cod === "23503") return new ErroServidor(`Um item usado aqui não existe mais. ${conflito}`, { recarregar: true });
  if (cod === "23514" || cod === "22023" || cod === "22P02") {
    return new ErroServidor("O servidor recusou um valor inválido.", { recarregar: true });
  }
  if (cod === "28000" || cod === "PGRST301" || cod === "PGRST303" || erro?.status === 401) {
    return new ErroServidor("Sua sessão expirou. Entre de novo.", { sessao: true });
  }
  if (cod === "42501") return new ErroServidor("Sem permissão para isso.", { recarregar: true });
  if (erro instanceof TypeError || /fetch|network/i.test(erro?.message || "")) {
    return new ErroServidor("Sem conexão com o servidor. Verifique a internet e tente de novo.");
  }
  console.error(erro);
  return new ErroServidor(`Erro no servidor: ${erro?.message || "desconhecido"}`, { recarregar: true });
}

export function servidorSupabase(cliente) {
  async function tabela(nome) {
    const linhas = [];
    for (let de = 0; ; de += POR_PAGINA) {
      const { data, error } = await cliente.from(nome).select("*").order("id").range(de, de + POR_PAGINA - 1);
      if (error) throw traduzir(error);
      for (const { user_id: _, ...l } of data) linhas.push(l);
      if (data.length < POR_PAGINA) return linhas;
    }
  }

  return {
    async carregar() {
      let resultado;
      try {
        resultado = await Promise.all(TABELAS.map(tabela));
      } catch (e) {
        throw e instanceof ErroServidor ? e : traduzir(e);
      }
      return Object.fromEntries(TABELAS.map((t, i) => [t, resultado[i]]));
    },

    async aplicar(ops) {
      let error;
      try {
        ({ error } = await cliente.rpc("aplicar", { ops }));
      } catch (e) {
        error = e;
      }
      if (error) throw traduzir(error);
    },
  };
}

/** So para desenvolvimento (config com modoLocal): os dados ficam no
    localStorage deste navegador e nada vai para a internet. */
export function servidorLocal(chave = "nucontrole-local") {
  const ler = () => {
    try {
      return new Banco(JSON.parse(localStorage.getItem(chave) || "{}"));
    } catch {
      return new Banco();
    }
  };
  return {
    async carregar() {
      return ler().despejo();
    },
    async aplicar(ops) {
      let novo;
      try {
        novo = aplicarOps(ler(), JSON.parse(JSON.stringify(ops)));
      } catch (e) {
        throw new ErroServidor(`Servidor local recusou: ${e.message}`, { recarregar: true });
      }
      localStorage.setItem(chave, JSON.stringify(novo.despejo()));
    },
  };
}
