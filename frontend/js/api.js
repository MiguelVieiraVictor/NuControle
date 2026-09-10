/* ===========================================================================
   Cliente da API.

   Uma funcao por endpoint, para que o resto do front nunca monte URL na mao.
   Quando o Tauri entrar, basta trocar `pedir()` por `invoke()` do Tauri --
   nenhuma tela precisa saber que o transporte mudou.
   =========================================================================== */

const API = (() => {

  async function pedir(caminho, opcoes = {}) {
    let resposta;
    try {
      resposta = await fetch(`/api${caminho}`, {
        headers: opcoes.corpo ? { 'Content-Type': 'application/json' } : {},
        method: opcoes.metodo || 'GET',
        body: opcoes.corpo ? JSON.stringify(opcoes.corpo) : opcoes.arquivo,
      });
    } catch {
      throw new Error('Sem conexao com o servidor. O `python run.py` ainda esta rodando?');
    }

    if (resposta.status === 204) return null;

    const texto = await resposta.text();
    let dados = null;
    try { dados = texto ? JSON.parse(texto) : null; } catch { /* nao era JSON */ }

    if (!resposta.ok) {
      // O back manda {"erro": "..."} em 400; o FastAPI manda {"detail": ...} em 422.
      throw new Error(
        dados?.erro
        || (typeof dados?.detail === 'string' ? dados.detail : null)
        || dados?.detail?.[0]?.msg
        || `Erro ${resposta.status} do servidor.`
      );
    }
    return dados;
  }

  const get = (c) => pedir(c);
  const post = (c, corpo) => pedir(c, { metodo: 'POST', corpo });
  const put = (c, corpo) => pedir(c, { metodo: 'PUT', corpo });
  const del = (c) => pedir(c, { metodo: 'DELETE' });

  return {
    /* Visao geral */
    estado: (ref) => get(`/estado${ref ? `?ref=${ref}` : ''}`),
    config: () => get('/config'),
    salvarConfig: (dados) => put('/config', dados),
    setup: (dados) => post('/setup', dados),
    resetar: () => post('/resetar', {}),

    /* Faturas */
    fatura: (ref) => get(`/fatura/${ref}`),
    faturas: (quantidade = 6) => get(`/faturas?quantidade=${quantidade}`),

    /* Lancamentos */
    lancamentos: (filtros = {}) => {
      const q = new URLSearchParams(
        Object.entries(filtros).filter(([, v]) => v !== null && v !== undefined && v !== '')
      );
      return get(`/lancamentos${q.toString() ? `?${q}` : ''}`);
    },
    criarLancamento: (dados) => post('/lancamentos', dados),
    editarLancamento: (id, dados) => put(`/lancamentos/${id}`, dados),
    apagarLancamento: (id) => del(`/lancamentos/${id}`),

    /* Parcelamentos */
    parcelamentos: () => get('/parcelamentos'),
    criarParcelamento: (dados) => post('/parcelamentos', dados),
    apagarParcelamento: (id) => del(`/parcelamentos/${id}`),

    /* Gastos fixos */
    recorrencias: () => get('/recorrencias'),
    criarRecorrencia: (dados) => post('/recorrencias', dados),
    editarRecorrencia: (id, dados) => put(`/recorrencias/${id}`, dados),
    apagarRecorrencia: (id) => del(`/recorrencias/${id}`),

    /* Caixinhas e fundos */
    reservas: () => get('/reservas'),
    criarReserva: (dados) => post('/reservas', dados),
    editarReserva: (id, dados) => put(`/reservas/${id}`, dados),
    apagarReserva: (id) => del(`/reservas/${id}`),
    movimentar: (dados) => post('/movimentacoes', dados),
    apagarMovimentacao: (id) => del(`/movimentacoes/${id}`),

    /* Fatura paga */
    pagarFatura: (dados) => post('/pagamentos', dados),
    apagarPagamento: (id) => del(`/pagamentos/${id}`),

    /* Categorias */
    categorias: () => get('/categorias'),
    criarCategoria: (dados) => post('/categorias', dados),
    apagarCategoria: (id) => del(`/categorias/${id}`),

    /* Backup: sai como download; entra como upload de arquivo .db */
    urlBackup: () => '/api/backup',
    restaurar: async (arquivo) => {
      const corpo = new FormData();
      corpo.append('arquivo', arquivo);
      const resposta = await fetch('/api/restaurar', { method: 'POST', body: corpo });
      const dados = await resposta.json().catch(() => null);
      if (!resposta.ok) throw new Error(dados?.erro || 'Nao foi possivel restaurar o backup.');
      return dados;
    },
  };
})();
