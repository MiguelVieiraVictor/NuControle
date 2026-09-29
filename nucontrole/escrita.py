"""
Tudo que grava no banco: compras (com divisao), donos, categorias, caixinhas,
pagamentos de fatura e ajustes.

Nada aqui conhece a janela nem o JavaScript -- recebe dicts, devolve ids e
levanta ErroValidacao com mensagem pronta para o usuario ler.

Como uma compra vira linhas no banco:

    compra          o que voce digitou (descricao, total, parcelas, ...)
    compra_parte    quanto do total e de cada dono         (soma = total)
    lancamento      cada ocorrencia: a compra, cada parcela, cada mes do fixo
    lancamento_parte quanto de CADA ocorrencia e de cada dono (soma = ocorrencia)

A divisao por ocorrencia e gerada, nunca digitada: parcelas sao rateadas com
`ratear_matriz`, que garante que a fatura e a parte de cada dono fechem no
centavo ao mesmo tempo.
"""

from __future__ import annotations

import re
import sqlite3
from datetime import date

from . import calendario as cal
from .base import Config, ErroValidacao, hoje
from .dinheiro import dividir_igual, formatar_reais, parse_centavos, ratear_matriz

ID_EU = 1
MAX_PARCELAS = 120
MESES_A_FRENTE = 2  # fixos sao gerados ate 2 meses adiante (cobre a fatura aberta)
MAX_MESES_FIXOS = 36  # ...ou ate o mes que a tela pedir, no maximo 3 anos adiante

FLUXOS = ("SAIDA", "ENTRADA")
NATUREZAS = ("AVULSO", "PARCELAMENTO", "FIXO")
MEIOS = ("CREDITO", "DEBITO")


# ---------------------------------------------------------------------------
# Validacao
# ---------------------------------------------------------------------------


def _texto(dados: dict, campo: str, rotulo: str, obrigatorio: bool = True) -> str:
    valor = str(dados.get(campo) or "").strip()
    if obrigatorio and not valor:
        raise ErroValidacao(f"Informe {rotulo}.")
    if len(valor) > 200:
        raise ErroValidacao(f"{rotulo.capitalize()} muito longo (máx. 200 caracteres).")
    return valor


def _centavos(valor, rotulo: str, positivo: bool = True) -> int:
    try:
        c = parse_centavos(valor)
    except (ValueError, TypeError):
        raise ErroValidacao(f"{rotulo} inválido.") from None
    if positivo and c <= 0:
        raise ErroValidacao(f"{rotulo} precisa ser maior que zero.")
    if c < 0:
        raise ErroValidacao(f"{rotulo} não pode ser negativo.")
    return c


def _data(valor, rotulo: str = "Data") -> date:
    try:
        return cal.data_iso(valor)
    except ValueError:
        raise ErroValidacao(f"{rotulo} inválida.") from None


def _inteiro(valor, rotulo: str, minimo: int, maximo: int) -> int:
    try:
        n = int(valor)
    except (ValueError, TypeError):
        raise ErroValidacao(f"{rotulo} inválido.") from None
    if not minimo <= n <= maximo:
        raise ErroValidacao(f"{rotulo} deve estar entre {minimo} e {maximo}.")
    return n


def _opcao(valor, opcoes: tuple[str, ...], rotulo: str) -> str:
    if valor not in opcoes:
        raise ErroValidacao(f"{rotulo} inválido.")
    return valor


def _cor(valor) -> str:
    cor = str(valor or "")
    if not re.fullmatch(r"#[0-9A-Fa-f]{6}", cor):
        raise ErroValidacao("Cor inválida.")
    return cor.upper()


def _existe(conn: sqlite3.Connection, tabela: str, id_: int, rotulo: str) -> sqlite3.Row:
    linha = conn.execute(f"SELECT * FROM {tabela} WHERE id = ?", (id_,)).fetchone()
    if linha is None:
        raise ErroValidacao(f"{rotulo} não encontrado(a).")
    return linha


# ---------------------------------------------------------------------------
# Divisao entre donos
# ---------------------------------------------------------------------------


def resolver_divisao(
    conn: sqlite3.Connection,
    divisao: dict | None,
    total: int,
    permitidos_inativos: set[int] = frozenset(),
) -> list[tuple[int, int]]:
    """Transforma o que veio do formulario em [(dono_id, valor), ...].

    Dois modos:
      {"modo": "igual", "donos": [1, 4, 7]}
          divide `total` igualmente; o centavo que sobra vai para quem vem
          primeiro, e "Eu" sempre vem primeiro.
      {"modo": "valor", "partes": [{"dono_id": 1, "valor": 15000}, ...]}
          cada um com seu valor; a soma precisa bater EXATAMENTE com o total.

    Sem divisao (None ou um dono so) = 100% do dono informado, ou de "Eu".
    """
    divisao = divisao or {"modo": "igual", "donos": [ID_EU]}
    modo = divisao.get("modo")

    if modo == "igual":
        ids = [int(d) for d in divisao.get("donos") or []]
        if not ids:
            raise ErroValidacao("Escolha pelo menos um dono para o gasto.")
        if len(set(ids)) != len(ids):
            raise ErroValidacao("Dono repetido na divisão.")
        ids.sort(key=lambda i: i != ID_EU)  # estavel: "Eu" primeiro, resto na ordem
        if total < len(ids):
            raise ErroValidacao("Valor pequeno demais para dividir entre tantos donos.")
        pares = list(zip(ids, dividir_igual(total, len(ids))))

    elif modo == "valor":
        pares = []
        for p in divisao.get("partes") or []:
            pares.append((int(p.get("dono_id")), _centavos(p.get("valor"), "Valor da parte")))
        if not pares:
            raise ErroValidacao("Informe a parte de cada dono.")
        ids = [d for d, _ in pares]
        if len(set(ids)) != len(ids):
            raise ErroValidacao("Dono repetido na divisão.")
        soma = sum(v for _, v in pares)
        if soma != total:
            dif = total - soma
            quanto = "faltam" if dif > 0 else "sobram"
            raise ErroValidacao(
                f"A soma das partes não fecha com o total ({quanto} {formatar_reais(abs(dif))})."
            )
        pares.sort(key=lambda p: p[0] != ID_EU)
    else:
        raise ErroValidacao("Modo de divisão inválido.")

    for dono_id, _ in pares:
        dono = conn.execute("SELECT ativo FROM dono WHERE id = ?", (dono_id,)).fetchone()
        if dono is None:
            raise ErroValidacao("Dono da divisão não encontrado.")
        if not dono["ativo"] and dono_id not in permitidos_inativos:
            raise ErroValidacao("Um dos donos está arquivado.")
    return pares


# ---------------------------------------------------------------------------
# Compras
# ---------------------------------------------------------------------------


def _validar_compra(conn: sqlite3.Connection, dados: dict, anterior_ids: set[int]) -> dict:
    fluxo = _opcao(dados.get("fluxo", "SAIDA"), FLUXOS, "Tipo")
    natureza = _opcao(dados.get("natureza", "AVULSO"), NATUREZAS, "Natureza")
    meio = _opcao(dados.get("meio", "CREDITO"), MEIOS, "Meio de pagamento")

    c = {
        "descricao": _texto(dados, "descricao", "a descrição"),
        "fluxo": fluxo,
        "natureza": natureza,
        "meio": meio,
        "valor": _centavos(dados.get("valor"), "Valor"),
        "data": _data(dados.get("data")),
        "categoria_id": dados.get("categoria_id") or None,
        "observacao": _texto(dados, "observacao", "a observação", obrigatorio=False),
        "num_parcelas": 1,
        "parcela_inicial": 1,
        "dia": None,
        "inicio_ref": None,
        "fim_ref": None,
    }

    if c["categoria_id"] is not None:
        c["categoria_id"] = int(c["categoria_id"])
        _existe(conn, "categoria", c["categoria_id"], "Categoria")

    if fluxo == "ENTRADA":
        if natureza == "PARCELAMENTO":
            raise ErroValidacao("Entrada não pode ser parcelada.")
        if meio != "DEBITO":
            raise ErroValidacao("Entrada cai na conta, não no cartão.")

    if natureza == "PARCELAMENTO":
        n = _inteiro(dados.get("num_parcelas"), "Número de parcelas", 2, MAX_PARCELAS)
        inicial = _inteiro(dados.get("parcela_inicial", 1), "Parcela inicial", 1, n)
        if c["valor"] < n:
            raise ErroValidacao("Valor pequeno demais para tantas parcelas.")
        c["num_parcelas"], c["parcela_inicial"] = n, inicial

    if natureza == "FIXO":
        c["dia"] = c["data"].day
        c["inicio_ref"] = cal.ref_de(c["data"])
        fim = dados.get("fim_ref") or None
        if fim is not None:
            try:
                cal.partes(fim)
            except ValueError:
                raise ErroValidacao("Mês final inválido.") from None
            if fim < c["inicio_ref"]:
                raise ErroValidacao("O mês final é anterior ao início.")
        c["fim_ref"] = fim

    divisao = dados.get("divisao")
    if fluxo == "ENTRADA":
        divisao = {"modo": "igual", "donos": [ID_EU]}  # entrada e sempre sua
    c["partes"] = resolver_divisao(conn, divisao, c["valor"], anterior_ids)

    # Uma parcela precisa caber em cada dono: parcela de 1 centavo nao divide.
    if natureza == "PARCELAMENTO" and len(c["partes"]) > 1:
        menor = c["valor"] // c["num_parcelas"]
        if menor < len(c["partes"]):
            raise ErroValidacao("Parcela pequena demais para dividir entre tantos donos.")
    return c


def salvar_compra(conn: sqlite3.Connection, dados: dict, compra_id: int | None = None) -> int:
    """Cria (compra_id=None) ou edita uma compra e (re)gera suas ocorrencias.

    Editar um AVULSO ou PARCELAMENTO regenera tudo. Editar um FIXO vale a
    partir do mes atual: os meses que ja passaram ficam como estavam.
    """
    cfg = Config.ler(conn)
    anteriores: set[int] = set()
    antiga = None
    if compra_id is not None:
        antiga = _existe(conn, "compra", compra_id, "Lançamento")
        anteriores = {
            r[0]
            for r in conn.execute(
                "SELECT dono_id FROM compra_parte WHERE compra_id = ?", (compra_id,)
            )
        }

    c = _validar_compra(conn, dados, anteriores)
    if antiga is not None and antiga["natureza"] != c["natureza"]:
        raise ErroValidacao("Não dá para mudar a natureza de um lançamento. Exclua e crie outro.")

    campos = (
        "descricao", "fluxo", "natureza", "meio", "categoria_id", "valor", "data",
        "num_parcelas", "parcela_inicial", "dia", "inicio_ref", "fim_ref", "observacao",
    )
    valores = [c[k].isoformat() if k == "data" else c[k] for k in campos]

    with conn:
        if compra_id is None:
            cur = conn.execute(
                f"INSERT INTO compra ({', '.join(campos)}, criado_em) "
                f"VALUES ({', '.join('?' * len(campos))}, ?)",
                (*valores, hoje().isoformat()),
            )
            compra_id = cur.lastrowid
        else:
            conn.execute(
                f"UPDATE compra SET {', '.join(f'{k} = ?' for k in campos)} WHERE id = ?",
                (*valores, compra_id),
            )
            conn.execute("DELETE FROM compra_parte WHERE compra_id = ?", (compra_id,))
            _apagar_ocorrencias_para_regerar(conn, compra_id, c)

        conn.executemany(
            "INSERT INTO compra_parte (compra_id, dono_id, valor) VALUES (?, ?, ?)",
            [(compra_id, d, v) for d, v in c["partes"]],
        )
        _gerar(conn, cfg, compra_id)
    return compra_id


def _apagar_ocorrencias_para_regerar(conn: sqlite3.Connection, compra_id: int, c: dict) -> None:
    if c["natureza"] != "FIXO":
        conn.execute("DELETE FROM lancamento WHERE compra_id = ?", (compra_id,))
        return

    # FIXO: o passado fica. Do mes atual em diante (ou fora da nova janela) regera.
    corte = cal.ref_de(hoje())
    fim = c["fim_ref"] or "9999-12"
    conn.execute(
        "DELETE FROM lancamento WHERE compra_id = ? AND (ref >= ? OR ref < ? OR ref > ?)",
        (compra_id, corte, c["inicio_ref"], fim),
    )
    conn.execute(
        "DELETE FROM fixo_gerado WHERE compra_id = ? AND (ref >= ? OR ref < ? OR ref > ?)",
        (compra_id, corte, c["inicio_ref"], fim),
    )


def _inserir_ocorrencia(
    conn: sqlite3.Connection,
    compra_id: int,
    d: date,
    fatura_ref: str | None,
    partes: list[tuple[int, int]],
    parcela: tuple[int, int] | None = None,
) -> None:
    valor = sum(v for _, v in partes)
    cur = conn.execute(
        "INSERT INTO lancamento (compra_id, data, ref, valor, fatura_ref, parcela_num, parcela_total) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (compra_id, d.isoformat(), cal.ref_de(d), valor, fatura_ref, *(parcela or (None, None))),
    )
    conn.executemany(
        "INSERT INTO lancamento_parte (lancamento_id, dono_id, valor) VALUES (?, ?, ?)",
        [(cur.lastrowid, dono, v) for dono, v in partes],
    )


def _gerar(conn: sqlite3.Connection, cfg: Config, compra_id: int, limite: str | None = None) -> None:
    """Gera as ocorrencias que ainda nao existem para uma compra.
    `limite` so vale para FIXO: ultimo mes a gerar (padrao: _limite_fixos())."""
    c = conn.execute("SELECT * FROM compra WHERE id = ?", (compra_id,)).fetchone()
    partes = [
        (r["dono_id"], r["valor"])
        for r in conn.execute(
            "SELECT dono_id, valor FROM compra_parte WHERE compra_id = ? "
            "ORDER BY dono_id != 1, rowid",
            (compra_id,),
        )
    ]
    credito = c["meio"] == "CREDITO"
    data = date.fromisoformat(c["data"])

    if c["natureza"] == "AVULSO":
        _inserir_ocorrencia(conn, compra_id, data, cfg.fatura_de(data) if credito else None, partes)

    elif c["natureza"] == "PARCELAMENTO":
        n, inicial = c["num_parcelas"], c["parcela_inicial"]
        parcelas = dividir_igual(c["valor"], n)
        matriz = ratear_matriz(parcelas, [v for _, v in partes])
        donos = [d for d, _ in partes]
        fatura_base = cfg.fatura_de(data) if credito else None
        # `data` e a data da parcela `inicial`; as seguintes vem mes a mes.
        # A fatura e deslocada a partir da fatura base, e nao recalculada pela
        # data de cada parcela: 30/01 + 1 mes vira 28/02, que cairia de novo
        # na mesma fatura.
        for k in range(inicial, n + 1):
            passo = k - inicial
            d = cal.clamp_dia(*cal.somar_meses(data.year, data.month, passo), data.day)
            fatura = cal.somar_ref(fatura_base, passo) if credito else None
            _inserir_ocorrencia(
                conn, compra_id, d, fatura, list(zip(donos, matriz[k - 1])), (k, n)
            )

    else:  # FIXO
        limite = limite or _limite_fixos()
        fim = min(c["fim_ref"] or limite, limite)
        ref = c["inicio_ref"]
        while ref <= fim:
            ja = conn.execute(
                "SELECT 1 FROM fixo_gerado WHERE compra_id = ? AND ref = ?", (compra_id, ref)
            ).fetchone()
            if not ja:
                conn.execute(
                    "INSERT INTO fixo_gerado (compra_id, ref) VALUES (?, ?)", (compra_id, ref)
                )
                d = cal.data_no_mes(ref, c["dia"])
                _inserir_ocorrencia(
                    conn, compra_id, d, cfg.fatura_de(d) if credito else None, partes
                )
            ref = cal.somar_ref(ref, 1)


def _limite_fixos(ate_ref: str | None = None) -> str:
    """Ate que mes os fixos sao gerados: 2 meses adiante, ou o mes pedido (se
    for mais longe), com teto de MAX_MESES_FIXOS para nao gerar decadas."""
    atual = cal.ref_de(hoje())
    limite = cal.somar_ref(atual, MESES_A_FRENTE)
    if ate_ref:
        cal.partes(ate_ref)
        limite = max(limite, min(ate_ref, cal.somar_ref(atual, MAX_MESES_FIXOS)))
    return limite


def garantir_fixos(conn: sqlite3.Connection, ate_ref: str | None = None) -> None:
    """Gera os meses de fixos que ainda nao existem ate o limite.

    Chamado a cada acao do app (para os meses que chegaram desde a ultima vez)
    e com `ate_ref` quando a tela mostra um mes mais adiante: navegar ate
    dezembro faz o aluguel de dezembro aparecer.
    """
    cfg = Config.ler(conn)
    limite = _limite_fixos(ate_ref)
    pendentes = conn.execute(
        "SELECT c.id FROM compra c WHERE c.natureza = 'FIXO' "
        "AND (c.fim_ref IS NULL OR c.fim_ref >= c.inicio_ref) "
        "AND NOT EXISTS (SELECT 1 FROM fixo_gerado g WHERE g.compra_id = c.id "
        "                AND g.ref = MIN(COALESCE(c.fim_ref, ?), ?)) "
        "AND c.inicio_ref <= ?",
        (limite, limite, limite),
    ).fetchall()
    if pendentes:
        with conn:
            for r in pendentes:
                _gerar(conn, cfg, r["id"], limite)


def excluir_compra(conn: sqlite3.Connection, compra_id: int) -> None:
    _existe(conn, "compra", compra_id, "Lançamento")
    with conn:
        conn.execute("DELETE FROM compra WHERE id = ?", (compra_id,))


def pular_mes_fixo(conn: sqlite3.Connection, lancamento_id: int) -> None:
    """Remove UM mes de um fixo. O mes nao volta a ser gerado sozinho."""
    l = conn.execute(
        "SELECT l.id, c.natureza FROM lancamento l JOIN compra c ON c.id = l.compra_id "
        "WHERE l.id = ?",
        (lancamento_id,),
    ).fetchone()
    if l is None:
        raise ErroValidacao("Lançamento não encontrado.")
    if l["natureza"] != "FIXO":
        raise ErroValidacao("Só dá para pular um mês de gasto fixo.")
    with conn:
        conn.execute("DELETE FROM lancamento WHERE id = ?", (lancamento_id,))


def encerrar_fixo(conn: sqlite3.Connection, compra_id: int, fim_ref: str) -> None:
    """Encerra o fixo no mes `fim_ref` (inclusive). Meses depois dele somem."""
    c = _existe(conn, "compra", compra_id, "Lançamento")
    if c["natureza"] != "FIXO":
        raise ErroValidacao("Só gasto fixo pode ser encerrado.")
    try:
        cal.partes(fim_ref)
    except ValueError:
        raise ErroValidacao("Mês final inválido.") from None
    if fim_ref < c["inicio_ref"]:
        raise ErroValidacao("O mês final é anterior ao início. Para apagar tudo, exclua o fixo.")
    with conn:
        conn.execute("UPDATE compra SET fim_ref = ? WHERE id = ?", (fim_ref, compra_id))
        conn.execute("DELETE FROM lancamento WHERE compra_id = ? AND ref > ?", (compra_id, fim_ref))
        conn.execute("DELETE FROM fixo_gerado WHERE compra_id = ? AND ref > ?", (compra_id, fim_ref))


# ---------------------------------------------------------------------------
# Donos (Eu + terceiros)
# ---------------------------------------------------------------------------


def salvar_dono(conn: sqlite3.Connection, dados: dict, dono_id: int | None = None) -> int:
    nome = _texto(dados, "nome", "o nome")
    cor = _cor(dados.get("cor"))
    tipo = dados.get("tipo", "PESSOA")

    if dono_id is not None:
        atual = _existe(conn, "dono", dono_id, "Terceiro")
        if atual["tipo"] == "EU":
            tipo = "EU"
    if tipo != "EU":
        tipo = _opcao(tipo, ("PESSOA", "ORG"), "Tipo")

    repetido = conn.execute(
        "SELECT id FROM dono WHERE nome = ? AND id != ?", (nome, dono_id or 0)
    ).fetchone()
    if repetido:
        raise ErroValidacao(f"Já existe alguém chamado “{nome}”.")

    with conn:
        if dono_id is None:
            cur = conn.execute(
                "INSERT INTO dono (nome, tipo, cor, criado_em) VALUES (?, ?, ?, ?)",
                (nome, tipo, cor, hoje().isoformat()),
            )
            return cur.lastrowid
        conn.execute(
            "UPDATE dono SET nome = ?, tipo = ?, cor = ? WHERE id = ?", (nome, tipo, cor, dono_id)
        )
    return dono_id


def arquivar_dono(conn: sqlite3.Connection, dono_id: int, ativo: bool) -> None:
    """Arquivado some dos formularios, mas o historico dele continua."""
    if dono_id == ID_EU:
        raise ErroValidacao("“Eu” não pode ser arquivado.")
    _existe(conn, "dono", dono_id, "Terceiro")
    with conn:
        conn.execute("UPDATE dono SET ativo = ? WHERE id = ?", (1 if ativo else 0, dono_id))


def excluir_dono(conn: sqlite3.Connection, dono_id: int) -> None:
    if dono_id == ID_EU:
        raise ErroValidacao("“Eu” não pode ser excluído.")
    _existe(conn, "dono", dono_id, "Terceiro")
    usado = conn.execute(
        "SELECT COUNT(*) FROM compra_parte WHERE dono_id = ?", (dono_id,)
    ).fetchone()[0]
    if usado:
        raise ErroValidacao(
            f"Este terceiro está em {usado} lançamento(s). Arquive em vez de excluir "
            "para manter o histórico."
        )
    with conn:
        conn.execute("DELETE FROM dono WHERE id = ?", (dono_id,))


# ---------------------------------------------------------------------------
# Categorias
# ---------------------------------------------------------------------------


def salvar_categoria(conn: sqlite3.Connection, dados: dict, categoria_id: int | None = None) -> int:
    nome = _texto(dados, "nome", "o nome")
    cor = _cor(dados.get("cor"))
    repetida = conn.execute(
        "SELECT id FROM categoria WHERE nome = ? AND id != ?", (nome, categoria_id or 0)
    ).fetchone()
    if repetida:
        raise ErroValidacao(f"Já existe a categoria “{nome}”.")
    with conn:
        if categoria_id is None:
            return conn.execute(
                "INSERT INTO categoria (nome, cor) VALUES (?, ?)", (nome, cor)
            ).lastrowid
        _existe(conn, "categoria", categoria_id, "Categoria")
        conn.execute(
            "UPDATE categoria SET nome = ?, cor = ? WHERE id = ?", (nome, cor, categoria_id)
        )
    return categoria_id


def excluir_categoria(conn: sqlite3.Connection, categoria_id: int) -> None:
    """Os lancamentos da categoria ficam "sem categoria", nao sao apagados."""
    _existe(conn, "categoria", categoria_id, "Categoria")
    with conn:
        conn.execute("DELETE FROM categoria WHERE id = ?", (categoria_id,))


# ---------------------------------------------------------------------------
# Caixinhas e fundos
# ---------------------------------------------------------------------------


def salvar_reserva(conn: sqlite3.Connection, dados: dict, reserva_id: int | None = None) -> int:
    nome = _texto(dados, "nome", "o nome")
    tipo = _opcao(dados.get("tipo", "CAIXINHA"), ("CAIXINHA", "FUNDO"), "Tipo")
    saldo_inicial = _centavos(dados.get("saldo_inicial") or 0, "Saldo inicial", positivo=False)
    meta = dados.get("meta")
    meta = _centavos(meta, "Meta") if meta not in (None, "", 0) else None
    with conn:
        if reserva_id is None:
            return conn.execute(
                "INSERT INTO reserva (nome, tipo, saldo_inicial, meta, criada_em) "
                "VALUES (?, ?, ?, ?, ?)",
                (nome, tipo, saldo_inicial, meta, hoje().isoformat()),
            ).lastrowid
        _existe(conn, "reserva", reserva_id, "Caixinha")
        conn.execute(
            "UPDATE reserva SET nome = ?, tipo = ?, saldo_inicial = ?, meta = ? WHERE id = ?",
            (nome, tipo, saldo_inicial, meta, reserva_id),
        )
    return reserva_id


def excluir_reserva(conn: sqlite3.Connection, reserva_id: int) -> None:
    _existe(conn, "reserva", reserva_id, "Caixinha")
    with conn:
        conn.execute("DELETE FROM reserva WHERE id = ?", (reserva_id,))


def saldo_reserva(conn: sqlite3.Connection, reserva_id: int, ate: date | None = None) -> int:
    r = _existe(conn, "reserva", reserva_id, "Caixinha")
    ate = ate or date.max
    mov = conn.execute(
        "SELECT COALESCE(SUM(CASE tipo WHEN 'SAQUE' THEN -valor ELSE valor END), 0) "
        "FROM mov_reserva WHERE reserva_id = ? AND data <= ?",
        (reserva_id, ate.isoformat()),
    ).fetchone()[0]
    return r["saldo_inicial"] + mov


def criar_mov_reserva(conn: sqlite3.Connection, dados: dict) -> int:
    reserva_id = int(dados.get("reserva_id") or 0)
    _existe(conn, "reserva", reserva_id, "Caixinha")
    tipo = _opcao(dados.get("tipo"), ("DEPOSITO", "SAQUE", "RENDIMENTO"), "Movimentação")
    valor = _centavos(dados.get("valor"), "Valor")
    d = _data(dados.get("data"))
    if tipo == "SAQUE":
        # Confere contra o saldo com TODAS as movimentacoes, inclusive as de
        # datas futuras, para o saque nunca deixar a caixinha negativa.
        disponivel = saldo_reserva(conn, reserva_id)
        if valor > disponivel:
            raise ErroValidacao(
                f"Saldo insuficiente na caixinha (disponível: {formatar_reais(disponivel)})."
            )
    with conn:
        return conn.execute(
            "INSERT INTO mov_reserva (reserva_id, data, tipo, valor, descricao, criado_em) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (
                reserva_id, d.isoformat(), tipo, valor,
                _texto(dados, "descricao", "a descrição", obrigatorio=False),
                hoje().isoformat(),
            ),
        ).lastrowid


def excluir_mov_reserva(conn: sqlite3.Connection, mov_id: int) -> None:
    _existe(conn, "mov_reserva", mov_id, "Movimentação")
    with conn:
        conn.execute("DELETE FROM mov_reserva WHERE id = ?", (mov_id,))


# ---------------------------------------------------------------------------
# Fatura
# ---------------------------------------------------------------------------


def pagar_fatura(conn: sqlite3.Connection, dados: dict) -> int:
    fatura_ref = str(dados.get("fatura_ref") or "")
    try:
        cal.partes(fatura_ref)
    except ValueError:
        raise ErroValidacao("Fatura inválida.") from None
    valor = _centavos(dados.get("valor"), "Valor")
    d = _data(dados.get("data"))
    with conn:
        return conn.execute(
            "INSERT INTO pagamento_fatura (fatura_ref, data, valor, criado_em) VALUES (?, ?, ?, ?)",
            (fatura_ref, d.isoformat(), valor, hoje().isoformat()),
        ).lastrowid


def excluir_pagamento(conn: sqlite3.Connection, pagamento_id: int) -> None:
    _existe(conn, "pagamento_fatura", pagamento_id, "Pagamento")
    with conn:
        conn.execute("DELETE FROM pagamento_fatura WHERE id = ?", (pagamento_id,))


# ---------------------------------------------------------------------------
# Ajustes
# ---------------------------------------------------------------------------


def salvar_config(conn: sqlite3.Connection, dados: dict) -> None:
    antes = Config.ler(conn)
    novo = {
        "dia_fechamento": _inteiro(dados.get("dia_fechamento"), "Dia de fechamento", 1, 31),
        "dia_vencimento": _inteiro(dados.get("dia_vencimento"), "Dia de vencimento", 1, 31),
        "saldo_inicial": _centavos(dados.get("saldo_inicial") or 0, "Saldo inicial", positivo=False),
        "data_inicio": _data(dados.get("data_inicio"), "Data de início").isoformat(),
    }
    if novo["dia_fechamento"] == novo["dia_vencimento"]:
        raise ErroValidacao("Fechamento e vencimento não podem ser no mesmo dia.")
    with conn:
        conn.executemany(
            "UPDATE config SET valor = ? WHERE chave = ?",
            [(str(v), k) for k, v in novo.items()],
        )
        if (antes.dia_fechamento, antes.dia_vencimento) != (
            novo["dia_fechamento"], novo["dia_vencimento"],
        ):
            _recalcular_faturas(conn, Config.ler(conn))


def _recalcular_faturas(conn: sqlite3.Connection, cfg: Config) -> None:
    """Mudou o ciclo do cartao: cada compra no credito vai para a fatura certa."""
    for l in conn.execute(
        "SELECT l.id, l.data, l.parcela_num, c.data AS data_compra, c.parcela_inicial, c.natureza "
        "FROM lancamento l JOIN compra c ON c.id = l.compra_id WHERE c.meio = 'CREDITO'"
    ).fetchall():
        if l["natureza"] == "PARCELAMENTO":
            base = cfg.fatura_de(date.fromisoformat(l["data_compra"]))
            fatura = cal.somar_ref(base, l["parcela_num"] - l["parcela_inicial"])
        else:
            fatura = cfg.fatura_de(date.fromisoformat(l["data"]))
        conn.execute("UPDATE lancamento SET fatura_ref = ? WHERE id = ?", (fatura, l["id"]))
