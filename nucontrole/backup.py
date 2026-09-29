"""
Backup e restauracao do banco.

As duas operacoes usam a API de backup do proprio SQLite (`Connection.backup`),
que copia pagina a pagina de forma consistente com o banco ABERTO. Assim nao
e preciso fechar conexao nem substituir arquivo em uso -- no Windows, trocar
um arquivo aberto falha.

Restaurar e sempre reversivel: antes de sobrescrever, os dados atuais vao
para `dados/backups/antes-de-restaurar_<data>.db`.
"""

from __future__ import annotations

import sqlite3
from datetime import datetime
from pathlib import Path

from .base import ErroValidacao
from .db import VERSAO_SCHEMA, caminho_banco

TABELAS_OBRIGATORIAS = {"config", "dono", "categoria", "reserva", "compra", "lancamento"}


def pasta_backups() -> Path:
    return caminho_banco().parent / "backups"


def nome_sugerido() -> str:
    return f"nucontrole_{datetime.now():%Y-%m-%d_%H%M}.db"


def _mesmo_arquivo(a: Path, b: Path) -> bool:
    try:
        return a.resolve() == b.resolve()
    except OSError:
        return False


def exportar(conn: sqlite3.Connection, destino: str | Path) -> Path:
    """Copia o banco aberto em `conn` para `destino` (sobrescreve se existir)."""
    destino = Path(destino)
    if destino.suffix.lower() != ".db":
        destino = destino.with_suffix(destino.suffix + ".db")
    if _mesmo_arquivo(destino, caminho_banco()):
        raise ErroValidacao("Escolha outro lugar: esse é o próprio banco em uso.")
    destino.parent.mkdir(parents=True, exist_ok=True)
    if destino.exists():
        destino.unlink()  # backup() escreveria por cima de um banco diferente
    alvo = sqlite3.connect(destino)
    try:
        conn.backup(alvo)
    finally:
        alvo.close()
    return destino


def validar(origem: str | Path) -> dict:
    """Confere que `origem` e um banco do NuControle v2 e resume o conteudo."""
    origem = Path(origem)
    if not origem.is_file():
        raise ErroValidacao("Arquivo não encontrado.")
    if _mesmo_arquivo(origem, caminho_banco()):
        raise ErroValidacao("Esse é o próprio banco em uso.")
    try:
        # modo somente leitura: validar nunca altera o arquivo escolhido
        src = sqlite3.connect(f"{origem.resolve().as_uri()}?mode=ro", uri=True)
    except sqlite3.Error:
        raise ErroValidacao("Não consegui abrir esse arquivo.") from None
    try:
        try:
            versao = src.execute("PRAGMA user_version").fetchone()[0]
            tabelas = {r[0] for r in src.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        except sqlite3.DatabaseError:
            raise ErroValidacao("Esse arquivo não é um banco de dados do NuControle.") from None
        if not TABELAS_OBRIGATORIAS <= tabelas:
            if {"lancamento", "reserva"} <= tabelas and "compra" not in tabelas:
                raise ErroValidacao("Esse é um banco da versão 1 do NuControle, que não é compatível com a versão 2.")
            raise ErroValidacao("Esse arquivo não é um banco de dados do NuControle.")
        if versao > VERSAO_SCHEMA:
            raise ErroValidacao("Esse backup foi feito por uma versão mais nova do NuControle.")
        if src.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise ErroValidacao("O arquivo está corrompido.")

        def contar(sql: str) -> int:
            return src.execute(sql).fetchone()[0]

        return {
            "caminho": str(origem),
            "nome": origem.name,
            "tamanho": origem.stat().st_size,
            "modificado": datetime.fromtimestamp(origem.stat().st_mtime).isoformat(timespec="minutes"),
            "compras": contar("SELECT COUNT(*) FROM compra"),
            "terceiros": contar("SELECT COUNT(*) FROM dono WHERE tipo != 'EU'"),
            "caixinhas": contar("SELECT COUNT(*) FROM reserva"),
            # quando foi FEITO o ultimo lancamento (a data dele pode estar no
            # futuro: fixos e parcelas sao gerados adiantados)
            "ultimo_lancamento": src.execute("SELECT MAX(criado_em) FROM compra").fetchone()[0],
        }
    finally:
        src.close()


def restaurar(conn: sqlite3.Connection, origem: str | Path) -> Path:
    """Substitui o conteudo de `conn` pelo de `origem`. Devolve onde ficou a
    copia de seguranca dos dados que estavam antes."""
    validar(origem)
    copia = exportar(
        conn, pasta_backups() / f"antes-de-restaurar_{datetime.now():%Y-%m-%d_%H%M%S}.db"
    )
    src = sqlite3.connect(Path(origem))
    try:
        src.backup(conn)
    finally:
        src.close()
    return copia
