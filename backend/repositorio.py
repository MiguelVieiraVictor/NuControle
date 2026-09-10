"""
Escrita no banco. Toda operacao que cria/edita/apaga dado passa por aqui.

O padrao e sempre o mesmo: valida a entrada, calcula o que precisa ser
derivado (ex: em qual fatura a compra cai) e grava dentro de uma transacao.
"""

from __future__ import annotations

import sqlite3
from datetime import date, datetime

from .db import gravar_config
from .modelos import (
    Fluxo,
    Meio,
    MovReserva,
    Natureza,
    OrigemLancamento,
    Responsavel,
    TipoReserva,
    clamp_dia,
    dividir_parcelas,
    fatura_de_compra,
    partes_para_ref,
    ref_para_partes,
    somar_meses,
)
from .regras import Config, carregar_config, hoje


class ErroValidacao(ValueError):
    """Entrada invalida vinda do usuario -- vira HTTP 400 na API."""


# ---------------------------------------------------------------------------
# Helpers de validacao
# ---------------------------------------------------------------------------


def _agora() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _data(valor: str | None, campo: str = "data") -> date:
    if not valor:
        return hoje()
    try:
        return date.fromisoformat(str(valor)[:10])
    except ValueError as exc:
        raise ErroValidacao(f"{campo} invalida: {valor!r} (use AAAA-MM-DD)") from exc


def _valor(centavos, campo: str = "valor") -> int:
    try:
        v = int(centavos)
    except (TypeError, ValueError) as exc:
        raise ErroValidacao(f"{campo} invalido: {centavos!r}") from exc
    if v <= 0:
        raise ErroValidacao(f"{campo} deve ser maior que zero")
    return v


def _enum(valor, tipo, campo: str):
    try:
        return tipo(valor).value
    except ValueError as exc:
        opcoes = ", ".join(e.value for e in tipo)
        raise ErroValidacao(f"{campo} invalido: {valor!r} (use um de: {opcoes})") from exc


def _texto(valor, campo: str, obrigatorio: bool = True, maximo: int = 200) -> str:
    t = (valor or "").strip()
    if obrigatorio and not t:
        raise ErroValidacao(f"{campo} e obrigatorio")
    return t[:maximo]


def _categoria_valida(conn: sqlite3.Connection, categoria_id) -> int | None:
    if categoria_id in (None, "", 0):
        return None
    linha = conn.execute("SELECT id FROM categoria WHERE id = ?", (int(categoria_id),)).fetchone()
    if not linha:
        raise ErroValidacao(f"categoria {categoria_id} nao existe")
    return int(categoria_id)


def _checar_mes_inicial(cfg: Config, d: date) -> None:
    """Bloqueia lancamento antes do ponto de partida (requisito do projeto)."""
    limite = f"{cfg.mes_inicial}-01"
    if d.isoformat() < limite:
        raise ErroValidacao(
            f"o app nao controla meses anteriores a {cfg.mes_inicial} "
            f"(data recebida: {d.isoformat()})"
        )


# ---------------------------------------------------------------------------
# Lancamentos avulsos e fixos pontuais
# ---------------------------------------------------------------------------


def criar_lancamento(conn: sqlite3.Connection, dados: dict) -> int:
    """Cria um lancamento simples (nao parcelado)."""
    cfg = carregar_config(conn)
    d = _data(dados.get("data"))
    _checar_mes_inicial(cfg, d)

    meio = _enum(dados.get("meio", Meio.CREDITO.value), Meio, "meio")
    natureza = _enum(dados.get("natureza", Natureza.AVULSO.value), Natureza, "natureza")

    if natureza == Natureza.PARCELAMENTO.value:
        raise ErroValidacao(
            "para parcelamento use /api/parcelamentos, que gera todas as parcelas"
        )

    fatura_ref = fatura_de_compra(d, cfg.dia_fechamento) if meio == Meio.CREDITO.value else None

    with conn:
        cur = conn.execute(
            """
            INSERT INTO lancamento
                (data, descricao, valor, fluxo, responsavel, natureza, meio,
                 categoria_id, fatura_ref, origem, observacao, criado_em)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                d.isoformat(),
                _texto(dados.get("descricao"), "descricao"),
                _valor(dados.get("valor")),
                _enum(dados.get("fluxo", Fluxo.SAIDA.value), Fluxo, "fluxo"),
                _enum(dados.get("responsavel"), Responsavel, "responsavel"),
                natureza,
                meio,
                _categoria_valida(conn, dados.get("categoria_id")),
                fatura_ref,
                OrigemLancamento.MANUAL.value,
                _texto(dados.get("observacao"), "observacao", obrigatorio=False, maximo=500),
                _agora(),
            ),
        )
    return int(cur.lastrowid)


def editar_lancamento(conn: sqlite3.Connection, lanc_id: int, dados: dict) -> None:
    """Edita um lancamento existente, recalculando a fatura se a data mudar."""
    cfg = carregar_config(conn)
    atual = conn.execute("SELECT * FROM lancamento WHERE id = ?", (lanc_id,)).fetchone()
    if not atual:
        raise ErroValidacao(f"lancamento {lanc_id} nao encontrado")

    d = _data(dados.get("data", atual["data"]))
    _checar_mes_inicial(cfg, d)
    meio = _enum(dados.get("meio", atual["meio"]), Meio, "meio")
    fatura_ref = fatura_de_compra(d, cfg.dia_fechamento) if meio == Meio.CREDITO.value else None

    with conn:
        conn.execute(
            """
            UPDATE lancamento SET
                data = ?, descricao = ?, valor = ?, fluxo = ?, responsavel = ?,
                natureza = ?, meio = ?, categoria_id = ?, fatura_ref = ?, observacao = ?
            WHERE id = ?
            """,
            (
                d.isoformat(),
                _texto(dados.get("descricao", atual["descricao"]), "descricao"),
                _valor(dados.get("valor", atual["valor"])),
                _enum(dados.get("fluxo", atual["fluxo"]), Fluxo, "fluxo"),
                _enum(dados.get("responsavel", atual["responsavel"]), Responsavel, "responsavel"),
                _enum(dados.get("natureza", atual["natureza"]), Natureza, "natureza"),
                meio,
                _categoria_valida(conn, dados.get("categoria_id", atual["categoria_id"])),
                fatura_ref,
                _texto(
                    dados.get("observacao", atual["observacao"]),
                    "observacao",
                    obrigatorio=False,
                    maximo=500,
                ),
                lanc_id,
            ),
        )


def excluir_lancamento(conn: sqlite3.Connection, lanc_id: int) -> None:
    linha = conn.execute("SELECT id FROM lancamento WHERE id = ?", (lanc_id,)).fetchone()
    if not linha:
        raise ErroValidacao(f"lancamento {lanc_id} nao encontrado")
    with conn:
        conn.execute("DELETE FROM lancamento WHERE id = ?", (lanc_id,))


def listar_lancamentos(conn: sqlite3.Connection, filtros: dict) -> list[dict]:
    """Listagem filtravel para a aba de extrato."""
    sql = [
        "SELECT l.*, c.nome AS categoria_nome, c.cor AS categoria_cor",
        "FROM lancamento l LEFT JOIN categoria c ON c.id = l.categoria_id",
        "WHERE 1 = 1",
    ]
    params: list = []

    if filtros.get("ref"):
        sql.append("AND substr(l.data, 1, 7) = ?")
        params.append(filtros["ref"])
    if filtros.get("fatura_ref"):
        sql.append("AND l.fatura_ref = ?")
        params.append(filtros["fatura_ref"])
    if filtros.get("responsavel"):
        sql.append("AND l.responsavel = ?")
        params.append(_enum(filtros["responsavel"], Responsavel, "responsavel"))
    if filtros.get("natureza"):
        sql.append("AND l.natureza = ?")
        params.append(_enum(filtros["natureza"], Natureza, "natureza"))
    if filtros.get("meio"):
        sql.append("AND l.meio = ?")
        params.append(_enum(filtros["meio"], Meio, "meio"))
    if filtros.get("categoria_id"):
        sql.append("AND l.categoria_id = ?")
        params.append(int(filtros["categoria_id"]))
    if filtros.get("busca"):
        sql.append("AND l.descricao LIKE ?")
        params.append(f"%{filtros['busca']}%")

    sql.append("ORDER BY l.data DESC, l.id DESC LIMIT ?")
    params.append(int(filtros.get("limite", 500)))

    return [dict(l) for l in conn.execute(" ".join(sql), params)]


# ---------------------------------------------------------------------------
# Parcelamentos
# ---------------------------------------------------------------------------


def criar_parcelamento(conn: sqlite3.Connection, dados: dict) -> dict:
    """Cria uma compra parcelada e JA gera todas as parcelas futuras.

    Dois modos:

    * compra nova -- informe `valor` (total) e `num_parcelas`. O total e
      dividido sem perder centavo e cada parcela cai em uma fatura seguinte.

    * parcelamento JA em andamento (usado no setup) -- informe tambem
      `parcela_inicial` (ex: 4) e `valor_parcela`. Sao geradas apenas as
      parcelas de 4 ate o fim, comecando na fatura em aberto.
    """
    cfg = carregar_config(conn)
    descricao = _texto(dados.get("descricao"), "descricao")
    responsavel = _enum(dados.get("responsavel"), Responsavel, "responsavel")
    meio = _enum(dados.get("meio", Meio.CREDITO.value), Meio, "meio")
    categoria_id = _categoria_valida(conn, dados.get("categoria_id"))

    try:
        num_parcelas = int(dados.get("num_parcelas", 0))
    except (TypeError, ValueError) as exc:
        raise ErroValidacao("num_parcelas invalido") from exc
    if not 1 <= num_parcelas <= 120:
        raise ErroValidacao("num_parcelas deve estar entre 1 e 120")

    parcela_inicial = int(dados.get("parcela_inicial") or 1)
    if not 1 <= parcela_inicial <= num_parcelas:
        raise ErroValidacao(
            f"parcela_inicial ({parcela_inicial}) deve estar entre 1 e {num_parcelas}"
        )

    data_compra = _data(dados.get("data"), "data")

    # Valor: ou o total da compra, ou o valor de cada parcela.
    if dados.get("valor_parcela"):
        valor_parcela = _valor(dados["valor_parcela"], "valor_parcela")
        restantes = num_parcelas - parcela_inicial + 1
        valores = [valor_parcela] * restantes
        valor_total = valor_parcela * num_parcelas
    else:
        valor_total = _valor(dados.get("valor"), "valor")
        todas = dividir_parcelas(valor_total, num_parcelas)
        valores = todas[parcela_inicial - 1 :]

    # A primeira parcela a gerar cai na fatura da data da compra; para um
    # parcelamento em andamento, na fatura que esta aberta agora.
    if parcela_inicial == 1:
        ref_primeira = fatura_de_compra(data_compra, cfg.dia_fechamento)
    else:
        ref_primeira = fatura_de_compra(hoje(), cfg.dia_fechamento)
        _checar_mes_inicial(cfg, hoje())

    if parcela_inicial == 1:
        _checar_mes_inicial(cfg, data_compra)

    agora = _agora()
    with conn:
        cur = conn.execute(
            """
            INSERT INTO parcelamento
                (descricao, valor_total, num_parcelas, parcela_inicial,
                 responsavel, meio, categoria_id, data_compra, criado_em)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                descricao,
                valor_total,
                num_parcelas,
                parcela_inicial,
                responsavel,
                meio,
                categoria_id,
                data_compra.isoformat(),
                agora,
            ),
        )
        parc_id = int(cur.lastrowid)

        # Duas contas INDEPENDENTES, de proposito:
        #
        #   fatura_ref -- aritmetica de mes puro sobre a primeira fatura, para
        #                 as parcelas cairem em faturas estritamente consecutivas.
        #   data       -- o dia da compra avancado mes a mes, para as parcelas
        #                 cairem em meses de calendario estritamente consecutivos.
        #
        # Derivar uma da outra parece mais elegante, mas quebra: uma compra dia
        # 31/01 cujo fechamento e dia 29 faria a parcela 1 (31/01) e a parcela 2
        # (28/02, por clamp de fevereiro) cairem na MESMA fatura de marco.
        ano_ref, mes_ref = ref_para_partes(ref_primeira)
        base_data = data_compra if parcela_inicial == 1 else hoje()

        for indice, valor in enumerate(valores):
            numero = parcela_inicial + indice

            ano_d, mes_d = somar_meses(base_data.year, base_data.month, indice)
            data_parcela = clamp_dia(ano_d, mes_d, base_data.day)

            if meio == Meio.CREDITO.value:
                ref = partes_para_ref(*somar_meses(ano_ref, mes_ref, indice))
            else:
                ref = None  # no debito nao existe fatura

            conn.execute(
                """
                INSERT INTO lancamento
                    (data, descricao, valor, fluxo, responsavel, natureza, meio,
                     categoria_id, fatura_ref, origem, parcelamento_id,
                     parcela_num, parcela_total, observacao, criado_em)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    data_parcela.isoformat(),
                    f"{descricao} ({numero}/{num_parcelas})",
                    valor,
                    Fluxo.SAIDA.value,
                    responsavel,
                    Natureza.PARCELAMENTO.value,
                    meio,
                    categoria_id,
                    ref,
                    OrigemLancamento.PARCELAMENTO.value,
                    parc_id,
                    numero,
                    num_parcelas,
                    _texto(dados.get("observacao"), "obs", obrigatorio=False, maximo=500),
                    agora,
                ),
            )

    return {"id": parc_id, "parcelas_geradas": len(valores), "valor_total": valor_total}


def listar_parcelamentos(conn: sqlite3.Connection) -> list[dict]:
    """Parcelamentos com quanto ja passou e quanto ainda falta pagar."""
    h = hoje().isoformat()
    linhas = conn.execute(
        """
        SELECT p.*, c.nome AS categoria_nome, c.cor AS categoria_cor,
               COUNT(l.id)                                          AS parcelas_ativas,
               COALESCE(SUM(l.valor), 0)                            AS total_gerado,
               COALESCE(SUM(CASE WHEN l.data <= ? THEN l.valor END), 0) AS ja_lancado,
               COALESCE(SUM(CASE WHEN l.data >  ? THEN l.valor END), 0) AS a_vencer,
               MAX(l.data)                                          AS ultima_parcela
        FROM parcelamento p
        LEFT JOIN categoria c   ON c.id = p.categoria_id
        LEFT JOIN lancamento l  ON l.parcelamento_id = p.id
        GROUP BY p.id
        ORDER BY p.criado_em DESC
        """,
        (h, h),
    )
    return [dict(l) for l in linhas]


def excluir_parcelamento(conn: sqlite3.Connection, parc_id: int) -> None:
    """Apaga o parcelamento e, por CASCADE, todas as suas parcelas."""
    linha = conn.execute("SELECT id FROM parcelamento WHERE id = ?", (parc_id,)).fetchone()
    if not linha:
        raise ErroValidacao(f"parcelamento {parc_id} nao encontrado")
    with conn:
        conn.execute("DELETE FROM parcelamento WHERE id = ?", (parc_id,))


# ---------------------------------------------------------------------------
# Recorrencias (gastos fixos)
# ---------------------------------------------------------------------------


def criar_recorrencia(conn: sqlite3.Connection, dados: dict) -> int:
    cfg = carregar_config(conn)
    try:
        dia = int(dados.get("dia", 1))
    except (TypeError, ValueError) as exc:
        raise ErroValidacao("dia invalido") from exc
    if not 1 <= dia <= 31:
        raise ErroValidacao("dia deve estar entre 1 e 31")

    inicio_ref = dados.get("inicio_ref") or cfg.mes_inicial
    ref_para_partes(inicio_ref)  # valida o formato
    if inicio_ref < cfg.mes_inicial:
        inicio_ref = cfg.mes_inicial

    fim_ref = dados.get("fim_ref") or None
    if fim_ref:
        ref_para_partes(fim_ref)
        if fim_ref < inicio_ref:
            raise ErroValidacao("fim_ref nao pode ser antes de inicio_ref")

    with conn:
        cur = conn.execute(
            """
            INSERT INTO recorrencia
                (descricao, valor, dia, fluxo, responsavel, meio,
                 categoria_id, inicio_ref, fim_ref, ativa, criada_em)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
            """,
            (
                _texto(dados.get("descricao"), "descricao"),
                _valor(dados.get("valor")),
                dia,
                _enum(dados.get("fluxo", Fluxo.SAIDA.value), Fluxo, "fluxo"),
                _enum(dados.get("responsavel"), Responsavel, "responsavel"),
                _enum(dados.get("meio", Meio.CREDITO.value), Meio, "meio"),
                _categoria_valida(conn, dados.get("categoria_id")),
                inicio_ref,
                fim_ref,
                _agora(),
            ),
        )
    return int(cur.lastrowid)


def editar_recorrencia(conn: sqlite3.Connection, rec_id: int, dados: dict) -> None:
    """Edita o fixo. Por padrao so afeta os meses ainda nao gerados.

    Com `atualizar_futuros = true`, tambem corrige os lancamentos ja gerados
    cuja data ainda nao passou -- e o que voce quer quando a Netflix aumenta.
    """
    atual = conn.execute("SELECT * FROM recorrencia WHERE id = ?", (rec_id,)).fetchone()
    if not atual:
        raise ErroValidacao(f"recorrencia {rec_id} nao encontrada")

    dia = int(dados.get("dia", atual["dia"]))
    if not 1 <= dia <= 31:
        raise ErroValidacao("dia deve estar entre 1 e 31")

    valor = _valor(dados.get("valor", atual["valor"]))
    descricao = _texto(dados.get("descricao", atual["descricao"]), "descricao")
    responsavel = _enum(dados.get("responsavel", atual["responsavel"]), Responsavel, "responsavel")
    meio = _enum(dados.get("meio", atual["meio"]), Meio, "meio")
    categoria_id = _categoria_valida(conn, dados.get("categoria_id", atual["categoria_id"]))
    ativa = 1 if dados.get("ativa", atual["ativa"]) in (1, True, "1", "true") else 0

    fim_ref = dados.get("fim_ref", atual["fim_ref"]) or None
    if fim_ref:
        ref_para_partes(fim_ref)

    with conn:
        conn.execute(
            """
            UPDATE recorrencia SET descricao = ?, valor = ?, dia = ?, responsavel = ?,
                   meio = ?, categoria_id = ?, fim_ref = ?, ativa = ?
            WHERE id = ?
            """,
            (descricao, valor, dia, responsavel, meio, categoria_id, fim_ref, ativa, rec_id),
        )

        if dados.get("atualizar_futuros"):
            cfg = carregar_config(conn)
            h = hoje().isoformat()
            futuros = conn.execute(
                "SELECT id, data FROM lancamento WHERE recorrencia_id = ? AND data >= ?",
                (rec_id, h),
            ).fetchall()
            for lanc in futuros:
                d = date.fromisoformat(lanc["data"])
                nova_data = clamp_dia(d.year, d.month, dia)
                nova_fatura = (
                    fatura_de_compra(nova_data, cfg.dia_fechamento)
                    if meio == Meio.CREDITO.value
                    else None
                )
                conn.execute(
                    """
                    UPDATE lancamento SET descricao = ?, valor = ?, data = ?, responsavel = ?,
                           meio = ?, categoria_id = ?, fatura_ref = ?
                    WHERE id = ?
                    """,
                    (
                        descricao,
                        valor,
                        nova_data.isoformat(),
                        responsavel,
                        meio,
                        categoria_id,
                        nova_fatura,
                        lanc["id"],
                    ),
                )


def excluir_recorrencia(conn: sqlite3.Connection, rec_id: int, apagar_futuros: bool = True) -> None:
    """Encerra um fixo. Os lancamentos passados ficam (voce realmente pagou)."""
    linha = conn.execute("SELECT id FROM recorrencia WHERE id = ?", (rec_id,)).fetchone()
    if not linha:
        raise ErroValidacao(f"recorrencia {rec_id} nao encontrada")
    with conn:
        if apagar_futuros:
            conn.execute(
                "DELETE FROM lancamento WHERE recorrencia_id = ? AND data > ?",
                (rec_id, hoje().isoformat()),
            )
        conn.execute("DELETE FROM recorrencia WHERE id = ?", (rec_id,))


def listar_recorrencias(conn: sqlite3.Connection) -> list[dict]:
    linhas = conn.execute(
        """
        SELECT r.*, c.nome AS categoria_nome, c.cor AS categoria_cor
        FROM recorrencia r LEFT JOIN categoria c ON c.id = r.categoria_id
        ORDER BY r.ativa DESC, r.dia, r.descricao
        """
    )
    return [dict(l) for l in linhas]


# ---------------------------------------------------------------------------
# Caixinhas e fundos
# ---------------------------------------------------------------------------


def criar_reserva(conn: sqlite3.Connection, dados: dict) -> int:
    with conn:
        cur = conn.execute(
            "INSERT INTO reserva (nome, tipo, saldo_inicial, meta, ativa, criada_em) "
            "VALUES (?, ?, ?, ?, 1, ?)",
            (
                _texto(dados.get("nome"), "nome"),
                _enum(dados.get("tipo", TipoReserva.CAIXINHA.value), TipoReserva, "tipo"),
                max(int(dados.get("saldo_inicial") or 0), 0),
                int(dados["meta"]) if dados.get("meta") else None,
                _agora(),
            ),
        )
    return int(cur.lastrowid)


def editar_reserva(conn: sqlite3.Connection, reserva_id: int, dados: dict) -> None:
    atual = conn.execute("SELECT * FROM reserva WHERE id = ?", (reserva_id,)).fetchone()
    if not atual:
        raise ErroValidacao(f"reserva {reserva_id} nao encontrada")
    with conn:
        conn.execute(
            "UPDATE reserva SET nome = ?, tipo = ?, meta = ?, ativa = ? WHERE id = ?",
            (
                _texto(dados.get("nome", atual["nome"]), "nome"),
                _enum(dados.get("tipo", atual["tipo"]), TipoReserva, "tipo"),
                int(dados["meta"]) if dados.get("meta") else None,
                1 if dados.get("ativa", atual["ativa"]) in (1, True, "1", "true") else 0,
                reserva_id,
            ),
        )


def excluir_reserva(conn: sqlite3.Connection, reserva_id: int) -> None:
    """Apaga a caixinha e suas movimentacoes (CASCADE).

    Recusa se houver pagamento de fatura amarrado a ela, porque isso mudaria
    o historico do que voce ja pagou.
    """
    linha = conn.execute("SELECT id FROM reserva WHERE id = ?", (reserva_id,)).fetchone()
    if not linha:
        raise ErroValidacao(f"reserva {reserva_id} nao encontrada")

    usada = conn.execute(
        "SELECT COUNT(*) FROM pagamento_fatura WHERE reserva_id = ?", (reserva_id,)
    ).fetchone()[0]
    if usada:
        raise ErroValidacao(
            f"esta caixinha ja pagou {usada} fatura(s). Desative-a em vez de apagar, "
            "para nao perder o historico."
        )

    with conn:
        conn.execute("DELETE FROM reserva WHERE id = ?", (reserva_id,))


def criar_mov_reserva(conn: sqlite3.Connection, dados: dict) -> int:
    """Deposito, saque ou rendimento numa caixinha.

    DEPOSITO tira da conta; SAQUE devolve para a conta; RENDIMENTO nao
    toca na conta (foi o banco que pagou).
    """
    cfg = carregar_config(conn)
    reserva_id = int(dados.get("reserva_id") or 0)
    if not conn.execute("SELECT 1 FROM reserva WHERE id = ?", (reserva_id,)).fetchone():
        raise ErroValidacao(f"reserva {reserva_id} nao encontrada")

    d = _data(dados.get("data"))
    _checar_mes_inicial(cfg, d)
    tipo = _enum(dados.get("tipo"), MovReserva, "tipo")
    valor = _valor(dados.get("valor"))

    if tipo == MovReserva.SAQUE.value:
        saldo = _saldo_de_reserva(conn, cfg, reserva_id)
        if valor > saldo:
            from .modelos import formatar_reais

            raise ErroValidacao(
                f"saque de {formatar_reais(valor)} maior que o saldo da caixinha "
                f"({formatar_reais(saldo)})"
            )

    with conn:
        cur = conn.execute(
            "INSERT INTO mov_reserva (reserva_id, data, tipo, valor, descricao, criado_em) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (
                reserva_id,
                d.isoformat(),
                tipo,
                valor,
                _texto(dados.get("descricao"), "descricao", obrigatorio=False),
                _agora(),
            ),
        )
    return int(cur.lastrowid)


def excluir_mov_reserva(conn: sqlite3.Connection, mov_id: int) -> None:
    linha = conn.execute("SELECT * FROM mov_reserva WHERE id = ?", (mov_id,)).fetchone()
    if not linha:
        raise ErroValidacao(f"movimentacao {mov_id} nao encontrada")
    if linha["pagamento_id"]:
        raise ErroValidacao(
            "este saque foi criado por um pagamento de fatura. "
            "Apague o pagamento da fatura para desfazer os dois juntos."
        )
    with conn:
        conn.execute("DELETE FROM mov_reserva WHERE id = ?", (mov_id,))


def listar_movs_reserva(conn: sqlite3.Connection, reserva_id: int | None = None) -> list[dict]:
    sql = (
        "SELECT m.*, r.nome AS reserva_nome, r.tipo AS reserva_tipo "
        "FROM mov_reserva m JOIN reserva r ON r.id = m.reserva_id"
    )
    params: tuple = ()
    if reserva_id:
        sql += " WHERE m.reserva_id = ?"
        params = (reserva_id,)
    sql += " ORDER BY m.data DESC, m.id DESC LIMIT 300"
    return [dict(l) for l in conn.execute(sql, params)]


def _saldo_de_reserva(conn: sqlite3.Connection, cfg: Config, reserva_id: int) -> int:
    """Saldo da caixinha hoje. Espelha `regras.saldos_reservas` -- mesma
    janela de datas, senao a validacao de saque discordaria da tela."""
    linha = conn.execute("SELECT saldo_inicial FROM reserva WHERE id = ?", (reserva_id,)).fetchone()
    base = int(linha["saldo_inicial"]) if linha else 0
    movs = conn.execute(
        "SELECT tipo, COALESCE(SUM(valor), 0) AS t FROM mov_reserva "
        "WHERE reserva_id = ? AND data >= ? AND data <= ? GROUP BY tipo",
        (reserva_id, cfg.data_corte, hoje().isoformat()),
    ).fetchall()
    por_tipo = {m["tipo"]: m["t"] for m in movs}
    return (
        base
        + por_tipo.get(MovReserva.DEPOSITO.value, 0)
        - por_tipo.get(MovReserva.SAQUE.value, 0)
        + por_tipo.get(MovReserva.RENDIMENTO.value, 0)
    )


# ---------------------------------------------------------------------------
# Pagamento da fatura
# ---------------------------------------------------------------------------


def pagar_fatura(conn: sqlite3.Connection, dados: dict) -> dict:
    """Registra o pagamento da fatura -- o fluxo que voce descreveu.

    Se `reserva_id` vier preenchido, o app faz os DOIS lados do que voce
    faz na mao: saca o dinheiro da caixinha (creditando a conta) e paga a
    fatura (debitando a conta). Efeito liquido no saldo da conta: zero.
    O dinheiro saiu da caixinha, nao do saldo.

    Sem `reserva_id`, o pagamento sai direto do saldo da conta.
    """
    cfg = carregar_config(conn)
    fatura_ref = dados.get("fatura_ref") or ""
    ref_para_partes(fatura_ref)

    d = _data(dados.get("data"))
    _checar_mes_inicial(cfg, d)
    valor = _valor(dados.get("valor"))

    reserva_id = dados.get("reserva_id")
    reserva_id = int(reserva_id) if reserva_id else None

    if reserva_id is not None:
        reserva = conn.execute("SELECT nome FROM reserva WHERE id = ?", (reserva_id,)).fetchone()
        if not reserva:
            raise ErroValidacao(f"reserva {reserva_id} nao encontrada")
        saldo = _saldo_de_reserva(conn, cfg, reserva_id)
        if valor > saldo:
            from .modelos import formatar_reais

            raise ErroValidacao(
                f"a caixinha '{reserva['nome']}' tem {formatar_reais(saldo)}, "
                f"nao da para pagar {formatar_reais(valor)}"
            )

    agora = _agora()
    with conn:
        cur = conn.execute(
            "INSERT INTO pagamento_fatura (fatura_ref, data, valor, reserva_id, observacao, criado_em) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (
                fatura_ref,
                d.isoformat(),
                valor,
                reserva_id,
                _texto(dados.get("observacao"), "obs", obrigatorio=False, maximo=500),
                agora,
            ),
        )
        pag_id = int(cur.lastrowid)

        if reserva_id is not None:
            conn.execute(
                "INSERT INTO mov_reserva (reserva_id, data, tipo, valor, descricao, "
                "pagamento_id, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    reserva_id,
                    d.isoformat(),
                    MovReserva.SAQUE.value,
                    valor,
                    f"Pagamento da fatura {fatura_ref}",
                    pag_id,
                    agora,
                ),
            )

    return {"id": pag_id, "fatura_ref": fatura_ref, "valor": valor}


def excluir_pagamento(conn: sqlite3.Connection, pag_id: int) -> None:
    """Desfaz o pagamento e, por CASCADE, o saque automatico da caixinha."""
    linha = conn.execute("SELECT id FROM pagamento_fatura WHERE id = ?", (pag_id,)).fetchone()
    if not linha:
        raise ErroValidacao(f"pagamento {pag_id} nao encontrado")
    with conn:
        conn.execute("DELETE FROM pagamento_fatura WHERE id = ?", (pag_id,))


# ---------------------------------------------------------------------------
# Categorias
# ---------------------------------------------------------------------------


def listar_categorias(conn: sqlite3.Connection) -> list[dict]:
    return [
        dict(l)
        for l in conn.execute(
            "SELECT c.*, "
            "(SELECT COUNT(*) FROM lancamento l WHERE l.categoria_id = c.id) AS usos "
            "FROM categoria c WHERE c.ativa = 1 ORDER BY c.ordem, c.nome"
        )
    ]


def criar_categoria(conn: sqlite3.Connection, dados: dict) -> int:
    nome = _texto(dados.get("nome"), "nome", maximo=40)
    if conn.execute("SELECT 1 FROM categoria WHERE nome = ?", (nome,)).fetchone():
        raise ErroValidacao(f"ja existe a categoria '{nome}'")
    ordem = conn.execute("SELECT COALESCE(MAX(ordem), 0) + 1 FROM categoria").fetchone()[0]
    with conn:
        cur = conn.execute(
            "INSERT INTO categoria (nome, cor, icone, ordem) VALUES (?, ?, ?, ?)",
            (nome, _texto(dados.get("cor"), "cor", obrigatorio=False) or "#94A3B8",
             _texto(dados.get("icone"), "icone", obrigatorio=False) or "dots", ordem),
        )
    return int(cur.lastrowid)


def excluir_categoria(conn: sqlite3.Connection, cat_id: int) -> None:
    """Desativa a categoria se ela estiver em uso; apaga se nunca foi usada."""
    linha = conn.execute("SELECT id FROM categoria WHERE id = ?", (cat_id,)).fetchone()
    if not linha:
        raise ErroValidacao(f"categoria {cat_id} nao encontrada")
    usos = conn.execute(
        "SELECT COUNT(*) FROM lancamento WHERE categoria_id = ?", (cat_id,)
    ).fetchone()[0]
    with conn:
        if usos:
            conn.execute("UPDATE categoria SET ativa = 0 WHERE id = ?", (cat_id,))
        else:
            conn.execute("DELETE FROM categoria WHERE id = ?", (cat_id,))


# ---------------------------------------------------------------------------
# Setup inicial
# ---------------------------------------------------------------------------


def aplicar_setup(conn: sqlite3.Connection, dados: dict) -> dict:
    """Grava o ponto de partida: saldo, caixinhas, parcelamentos e fatura aberta.

    Roda uma vez. Depois disso o app calcula tudo a partir dos lancamentos.
    """
    cfg = carregar_config(conn)

    saldo = int(dados.get("saldo_conta") or 0)
    data_corte = _data(dados.get("data_corte"), "data_corte")
    _checar_mes_inicial(cfg, data_corte)

    criadas, parcelamentos = [], []
    agora = _agora()

    with conn:
        gravar_config(conn, "saldo_inicial_conta", str(saldo))
        gravar_config(conn, "data_corte", data_corte.isoformat())
        if dados.get("nome_conta"):
            gravar_config(conn, "nome_conta", _texto(dados["nome_conta"], "nome_conta"))

        for item in dados.get("reservas") or []:
            cur = conn.execute(
                "INSERT INTO reserva (nome, tipo, saldo_inicial, meta, ativa, criada_em) "
                "VALUES (?, ?, ?, ?, 1, ?)",
                (
                    _texto(item.get("nome"), "nome da caixinha"),
                    _enum(item.get("tipo", TipoReserva.CAIXINHA.value), TipoReserva, "tipo"),
                    max(int(item.get("saldo") or 0), 0),
                    int(item["meta"]) if item.get("meta") else None,
                    agora,
                ),
            )
            criadas.append(int(cur.lastrowid))

        # Fatura que ja esta aberta agora: entra como um lancamento unico de
        # ajuste, para que o total a pagar dia 3 esteja correto.
        aberta = dados.get("fatura_aberta") or {}
        valor_aberto = int(aberta.get("valor") or 0)
        if valor_aberto > 0:
            ref = fatura_de_compra(data_corte, cfg.dia_fechamento)
            c = ciclo_do_setup(cfg, ref)
            conn.execute(
                """
                INSERT INTO lancamento
                    (data, descricao, valor, fluxo, responsavel, natureza, meio,
                     categoria_id, fatura_ref, origem, observacao, criado_em)
                VALUES (?, ?, ?, 'SAIDA', ?, 'AVULSO', 'CREDITO', NULL, ?, 'SETUP', ?, ?)
                """,
                (
                    c.inicio.isoformat(),
                    "Fatura em aberto no inicio do controle",
                    valor_aberto,
                    _enum(
                        aberta.get("responsavel", Responsavel.PESSOAL.value),
                        Responsavel,
                        "responsavel",
                    ),
                    ref,
                    "Lancado pelo setup inicial",
                    agora,
                ),
            )

        gravar_config(conn, "setup_concluido", "1")

    for p in dados.get("parcelamentos") or []:
        parcelamentos.append(
            criar_parcelamento(
                conn,
                {
                    "descricao": p.get("descricao"),
                    "valor_parcela": p.get("valor_parcela"),
                    "num_parcelas": p.get("num_parcelas"),
                    "parcela_inicial": p.get("parcela_inicial"),
                    "responsavel": p.get("responsavel", Responsavel.PESSOAL.value),
                    "meio": Meio.CREDITO.value,
                    "categoria_id": p.get("categoria_id"),
                    "data": data_corte.isoformat(),
                },
            )
        )

    return {
        "ok": True,
        "reservas_criadas": len(criadas),
        "parcelamentos_criados": len(parcelamentos),
    }


def ciclo_do_setup(cfg: Config, ref: str):
    from .regras import ciclo

    return ciclo(cfg, ref)


def resetar_tudo(conn: sqlite3.Connection) -> None:
    """Zera os dados financeiros e volta o app para o estado de primeiro uso.

    Nao apaga as categorias. Usado pelo botao 'recomecar' nos ajustes --
    a API faz um backup antes de chamar.
    """
    with conn:
        for tabela in (
            "recorrencia_gerada",
            "mov_reserva",
            "pagamento_fatura",
            "lancamento",
            "parcelamento",
            "recorrencia",
            "reserva",
        ):
            conn.execute(f"DELETE FROM {tabela}")
        gravar_config(conn, "saldo_inicial_conta", "0")
        gravar_config(conn, "setup_concluido", "0")
        conn.execute("DELETE FROM config WHERE chave = 'data_corte'")
