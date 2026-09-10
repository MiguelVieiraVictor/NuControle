"""
API HTTP do NuControle.

Esta camada e fina de proposito: ela traduz HTTP para chamadas em
`regras.py` / `repositorio.py` e nao decide nada de financeiro.

Sobre conexoes: o FastAPI roda endpoints `def` (sincronos) num pool de
threads, e uma conexao SQLite nao pode ser compartilhada entre threads.
Por isso cada request abre e fecha a sua propria conexao.
"""

from __future__ import annotations

import shutil
import sqlite3
import tempfile
from pathlib import Path
from typing import Annotated, Any

from fastapi import Body, Depends, FastAPI, Query, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import db, regras, repositorio
from .modelos import Meio, Natureza, Responsavel, TipoReserva, ref_de_data
from .repositorio import ErroValidacao

FRONTEND = Path(__file__).resolve().parent.parent / "frontend"

app = FastAPI(title="NuControle", version="1.0.0", docs_url="/api/docs")


# ---------------------------------------------------------------------------
# Conexao por request
# ---------------------------------------------------------------------------

_schema_pronto = False


def obter_conn():
    global _schema_pronto
    conn = db.conectar()
    try:
        if not _schema_pronto:
            db.inicializar(conn)
            _schema_pronto = True
        yield conn
    finally:
        conn.close()


Conn = Annotated[sqlite3.Connection, Depends(obter_conn)]
Corpo = Annotated[dict[str, Any], Body(...)]


@app.exception_handler(ErroValidacao)
def _erro_validacao(request: Request, exc: ErroValidacao):
    return JSONResponse(status_code=400, content={"erro": str(exc)})


@app.exception_handler(sqlite3.IntegrityError)
def _erro_integridade(request: Request, exc: sqlite3.IntegrityError):
    return JSONResponse(
        status_code=400, content={"erro": f"o banco recusou a operacao: {exc}"}
    )


def _ref_ou_hoje(ref: str | None) -> str:
    return ref or ref_de_data(regras.hoje())


# ---------------------------------------------------------------------------
# Visao geral / dashboard
# ---------------------------------------------------------------------------


@app.get("/api/estado")
def estado(conn: Conn, ref: str | None = Query(None)):
    """Payload unico que a tela inicial consome.

    Inclui as opcoes dos seletores para o front nao precisar ter as listas
    de enums duplicadas em JavaScript.
    """
    cfg = regras.carregar_config(conn)
    dados = regras.visao_geral(conn, cfg, _ref_ou_hoje(ref))
    dados["categorias"] = repositorio.listar_categorias(conn)
    dados["opcoes"] = {
        "responsavel": [r.value for r in Responsavel],
        "natureza": [n.value for n in Natureza],
        "meio": [m.value for m in Meio],
        "tipo_reserva": [t.value for t in TipoReserva],
    }
    return dados


@app.get("/api/mes/{ref}")
def mes(conn: Conn, ref: str):
    cfg = regras.carregar_config(conn)
    regras.materializar_recorrencias(conn, cfg, ref)
    return regras.resumo_mes(conn, cfg, ref)


@app.get("/api/fatura/{ref}")
def fatura(conn: Conn, ref: str):
    cfg = regras.carregar_config(conn)
    regras.materializar_recorrencias(conn, cfg, ref)
    return regras.montar_fatura(conn, cfg, ref)


@app.get("/api/faturas")
def faturas(conn: Conn, quantidade: int = Query(6, ge=1, le=24)):
    """Fatura aberta + as proximas, para a aba do cartao."""
    from .modelos import partes_para_ref, ref_para_partes, somar_meses

    cfg = regras.carregar_config(conn)
    ref_aberta = regras.fatura_aberta(cfg)
    ano, mes_i = ref_para_partes(ref_aberta)
    regras.materializar_recorrencias(conn, cfg, ref_aberta)

    return [
        regras.montar_fatura(conn, cfg, partes_para_ref(*somar_meses(ano, mes_i, i)))
        for i in range(quantidade)
    ]


# ---------------------------------------------------------------------------
# Lancamentos
# ---------------------------------------------------------------------------


@app.get("/api/lancamentos")
def get_lancamentos(
    conn: Conn,
    ref: str | None = None,
    fatura_ref: str | None = None,
    responsavel: str | None = None,
    natureza: str | None = None,
    meio: str | None = None,
    categoria_id: int | None = None,
    busca: str | None = None,
    limite: int = Query(500, ge=1, le=5000),
):
    return repositorio.listar_lancamentos(
        conn,
        {
            "ref": ref,
            "fatura_ref": fatura_ref,
            "responsavel": responsavel,
            "natureza": natureza,
            "meio": meio,
            "categoria_id": categoria_id,
            "busca": busca,
            "limite": limite,
        },
    )


@app.post("/api/lancamentos", status_code=201)
def post_lancamento(conn: Conn, corpo: Corpo):
    return {"id": repositorio.criar_lancamento(conn, corpo)}


@app.put("/api/lancamentos/{lanc_id}")
def put_lancamento(conn: Conn, lanc_id: int, corpo: Corpo):
    repositorio.editar_lancamento(conn, lanc_id, corpo)
    return {"ok": True}


@app.delete("/api/lancamentos/{lanc_id}")
def delete_lancamento(conn: Conn, lanc_id: int):
    repositorio.excluir_lancamento(conn, lanc_id)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Parcelamentos
# ---------------------------------------------------------------------------


@app.get("/api/parcelamentos")
def get_parcelamentos(conn: Conn):
    return repositorio.listar_parcelamentos(conn)


@app.post("/api/parcelamentos", status_code=201)
def post_parcelamento(conn: Conn, corpo: Corpo):
    return repositorio.criar_parcelamento(conn, corpo)


@app.delete("/api/parcelamentos/{parc_id}")
def delete_parcelamento(conn: Conn, parc_id: int):
    repositorio.excluir_parcelamento(conn, parc_id)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Recorrencias (gastos fixos)
# ---------------------------------------------------------------------------


@app.get("/api/recorrencias")
def get_recorrencias(conn: Conn):
    return repositorio.listar_recorrencias(conn)


@app.post("/api/recorrencias", status_code=201)
def post_recorrencia(conn: Conn, corpo: Corpo):
    rec_id = repositorio.criar_recorrencia(conn, corpo)
    cfg = regras.carregar_config(conn)
    criados = regras.materializar_recorrencias(conn, cfg, ref_de_data(regras.hoje()))
    return {"id": rec_id, "lancamentos_criados": criados}


@app.put("/api/recorrencias/{rec_id}")
def put_recorrencia(conn: Conn, rec_id: int, corpo: Corpo):
    repositorio.editar_recorrencia(conn, rec_id, corpo)
    return {"ok": True}


@app.delete("/api/recorrencias/{rec_id}")
def delete_recorrencia(conn: Conn, rec_id: int, apagar_futuros: bool = True):
    repositorio.excluir_recorrencia(conn, rec_id, apagar_futuros)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Caixinhas e fundos
# ---------------------------------------------------------------------------


@app.get("/api/reservas")
def get_reservas(conn: Conn):
    cfg = regras.carregar_config(conn)
    return {
        "reservas": regras.saldos_reservas(conn, cfg),
        "movimentacoes": repositorio.listar_movs_reserva(conn),
    }


@app.post("/api/reservas", status_code=201)
def post_reserva(conn: Conn, corpo: Corpo):
    return {"id": repositorio.criar_reserva(conn, corpo)}


@app.put("/api/reservas/{reserva_id}")
def put_reserva(conn: Conn, reserva_id: int, corpo: Corpo):
    repositorio.editar_reserva(conn, reserva_id, corpo)
    return {"ok": True}


@app.delete("/api/reservas/{reserva_id}")
def delete_reserva(conn: Conn, reserva_id: int):
    repositorio.excluir_reserva(conn, reserva_id)
    return {"ok": True}


@app.get("/api/reservas/{reserva_id}/movimentacoes")
def get_movs(conn: Conn, reserva_id: int):
    return repositorio.listar_movs_reserva(conn, reserva_id)


@app.post("/api/movimentacoes", status_code=201)
def post_mov(conn: Conn, corpo: Corpo):
    return {"id": repositorio.criar_mov_reserva(conn, corpo)}


@app.delete("/api/movimentacoes/{mov_id}")
def delete_mov(conn: Conn, mov_id: int):
    repositorio.excluir_mov_reserva(conn, mov_id)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Pagamento de fatura
# ---------------------------------------------------------------------------


@app.post("/api/pagamentos", status_code=201)
def post_pagamento(conn: Conn, corpo: Corpo):
    return repositorio.pagar_fatura(conn, corpo)


@app.delete("/api/pagamentos/{pag_id}")
def delete_pagamento(conn: Conn, pag_id: int):
    repositorio.excluir_pagamento(conn, pag_id)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Categorias
# ---------------------------------------------------------------------------


@app.get("/api/categorias")
def get_categorias(conn: Conn):
    return repositorio.listar_categorias(conn)


@app.post("/api/categorias", status_code=201)
def post_categoria(conn: Conn, corpo: Corpo):
    return {"id": repositorio.criar_categoria(conn, corpo)}


@app.delete("/api/categorias/{cat_id}")
def delete_categoria(conn: Conn, cat_id: int):
    repositorio.excluir_categoria(conn, cat_id)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Setup e configuracao
# ---------------------------------------------------------------------------


@app.get("/api/config")
def get_config(conn: Conn):
    return regras.carregar_config(conn).para_json()


@app.put("/api/config")
def put_config(conn: Conn, corpo: Corpo):
    permitidas = {
        "nome_conta",
        "dia_fechamento",
        "dia_vencimento",
        "saldo_inicial_conta",
        "mes_inicial",
    }
    with conn:
        for chave, valor in corpo.items():
            if chave not in permitidas:
                raise ErroValidacao(f"configuracao '{chave}' nao pode ser alterada por aqui")
            if chave in ("dia_fechamento", "dia_vencimento"):
                dia = int(valor)
                if not 1 <= dia <= 31:
                    raise ErroValidacao(f"{chave} deve estar entre 1 e 31")
            db.gravar_config(conn, chave, str(valor))
    return regras.carregar_config(conn).para_json()


@app.post("/api/setup")
def post_setup(conn: Conn, corpo: Corpo):
    return repositorio.aplicar_setup(conn, corpo)


@app.post("/api/resetar")
def post_resetar(conn: Conn):
    """Volta ao estado de primeiro uso. Faz backup antes, sempre."""
    caminho = db.exportar_backup(conn)
    repositorio.resetar_tudo(conn)
    return {"ok": True, "backup": str(caminho)}


# ---------------------------------------------------------------------------
# Backup -- e assim que o banco vai para outro computador
# ---------------------------------------------------------------------------


@app.get("/api/backup")
def get_backup(conn: Conn):
    """Baixa o banco inteiro como um arquivo .db unico."""
    caminho = db.exportar_backup(conn)
    return FileResponse(
        caminho,
        media_type="application/vnd.sqlite3",
        filename=caminho.name,
    )


@app.post("/api/restaurar")
def post_restaurar(arquivo: UploadFile):
    """Substitui o banco atual pelo .db enviado.

    O banco vigente e copiado para `dados/backups/` antes de ser
    sobrescrito, para que uma importacao errada nao seja definitiva.
    """
    if not arquivo.filename or not arquivo.filename.lower().endswith(".db"):
        raise ErroValidacao("envie um arquivo .db exportado pelo NuControle")

    with tempfile.NamedTemporaryFile(delete=False, suffix=".db") as tmp:
        shutil.copyfileobj(arquivo.file, tmp)
        temporario = Path(tmp.name)

    try:
        db.importar_backup(temporario)
    except (ValueError, FileNotFoundError, sqlite3.DatabaseError) as exc:
        raise ErroValidacao(str(exc)) from exc
    finally:
        temporario.unlink(missing_ok=True)

    return {"ok": True}


@app.get("/api/saude")
def saude():
    return {"ok": True, "banco": str(db.CAMINHO_DB), "versao_schema": db.SCHEMA_VERSAO}


# ---------------------------------------------------------------------------
# Front-end estatico
# ---------------------------------------------------------------------------

if not FRONTEND.is_dir():  # pragma: no cover
    raise RuntimeError(f"pasta do front-end nao encontrada: {FRONTEND}")

app.mount("/", StaticFiles(directory=FRONTEND, html=True), name="frontend")
