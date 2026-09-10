"""
Conexao e schema do banco SQLite.

Decisoes que importam:

* O banco vive na pasta de dados do USUARIO (`%APPDATA%\\NuControle\\dados`
  no Windows), nunca junto do programa. O programa pode estar em Program
  Files, que e somente leitura, ou numa pasta de build que o `cargo clean`
  apaga -- os dados financeiros nao podem estar em nenhum dos dois. Isso
  tambem garante UM banco so, seja abrindo pelo .exe ou por `python run.py`.

* O banco e UM UNICO ARQUIVO. Nao usamos WAL de proposito -- WAL cria
  arquivos `-wal` e `-shm` ao lado, e voce quer poder copiar o banco para
  outro computador arrastando um arquivo so.

* `PRAGMA foreign_keys = ON` em toda conexao. Sem isso o SQLite ignora
  as chaves estrangeiras silenciosamente e o ON DELETE CASCADE nao roda.

* Migracoes por versao inteira (`schema_versao` na tabela config), para
  que um banco antigo continue abrindo depois de uma mudanca de schema.
"""

from __future__ import annotations

import os
import shutil
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

from .modelos import CATEGORIAS_PADRAO

SCHEMA_VERSAO = 1

RAIZ = Path(__file__).resolve().parent.parent


def _pasta_dados_do_usuario() -> Path:
    """Pasta de dados do usuario, no lugar que cada sistema espera."""
    if sys.platform == "win32":
        base = os.environ.get("APPDATA") or Path.home() / "AppData" / "Roaming"
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        base = os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share"
    return Path(base) / "NuControle" / "dados"


# NUCONTROLE_DADOS existe para os testes e para rodar uma instancia separada
# sem encostar no banco de verdade.
PASTA_DADOS = Path(os.environ.get("NUCONTROLE_DADOS") or _pasta_dados_do_usuario())
CAMINHO_DB = PASTA_DADOS / "nucontrole.db"
PASTA_BACKUPS = PASTA_DADOS / "backups"

# Layout antigo: banco junto do codigo. Mantido apenas para migrar uma vez.
CAMINHO_DB_ANTIGO = RAIZ / "dados" / "nucontrole.db"


def _migrar_do_layout_antigo() -> None:
    """Traz o banco do layout antigo (junto do codigo) para a pasta do usuario.

    Roda uma vez, so quando ainda nao existe banco no lugar novo. O arquivo
    antigo NAO e apagado -- se algo der errado, ele continua la.

    Nao roda quando NUCONTROLE_DADOS aponta para outro lugar: quem pede uma
    pasta explicita (testes, uma instancia separada) quer um banco vazio, e
    nao uma copia do banco de verdade.
    """
    if PASTA_DADOS != _pasta_dados_do_usuario():
        return
    if CAMINHO_DB.exists() or not CAMINHO_DB_ANTIGO.is_file():
        return
    if CAMINHO_DB_ANTIGO.resolve() == CAMINHO_DB.resolve():
        return

    PASTA_DADOS.mkdir(parents=True, exist_ok=True)
    shutil.copy2(CAMINHO_DB_ANTIGO, CAMINHO_DB)
    print(f"  banco migrado de {CAMINHO_DB_ANTIGO}")
    print(f"                para {CAMINHO_DB}")
    print("  (o arquivo antigo foi mantido, por seguranca)")


SCHEMA = """
CREATE TABLE IF NOT EXISTS config (
    chave TEXT PRIMARY KEY,
    valor TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS categoria (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    nome     TEXT    NOT NULL UNIQUE,
    cor      TEXT    NOT NULL DEFAULT '#94A3B8',
    icone    TEXT    NOT NULL DEFAULT 'dots',
    ativa    INTEGER NOT NULL DEFAULT 1,
    ordem    INTEGER NOT NULL DEFAULT 0
);

-- Caixinhas e fundos imobiliarios
CREATE TABLE IF NOT EXISTS reserva (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    nome           TEXT    NOT NULL,
    tipo           TEXT    NOT NULL CHECK (tipo IN ('CAIXINHA', 'FUNDO')),
    saldo_inicial  INTEGER NOT NULL DEFAULT 0,
    meta           INTEGER,
    ativa          INTEGER NOT NULL DEFAULT 1,
    criada_em      TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS recorrencia (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    descricao    TEXT    NOT NULL,
    valor        INTEGER NOT NULL CHECK (valor > 0),
    dia          INTEGER NOT NULL CHECK (dia BETWEEN 1 AND 31),
    fluxo        TEXT    NOT NULL DEFAULT 'SAIDA' CHECK (fluxo IN ('SAIDA', 'ENTRADA')),
    responsavel  TEXT    NOT NULL CHECK (responsavel IN ('PESSOAL', 'TERCEIROS', 'GENESYS')),
    meio         TEXT    NOT NULL CHECK (meio IN ('CREDITO', 'DEBITO')),
    categoria_id INTEGER REFERENCES categoria(id) ON DELETE SET NULL,
    inicio_ref   TEXT    NOT NULL,
    fim_ref      TEXT,
    ativa        INTEGER NOT NULL DEFAULT 1,
    criada_em    TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS parcelamento (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    descricao       TEXT    NOT NULL,
    valor_total     INTEGER NOT NULL CHECK (valor_total > 0),
    num_parcelas    INTEGER NOT NULL CHECK (num_parcelas >= 1),
    parcela_inicial INTEGER NOT NULL DEFAULT 1,
    responsavel     TEXT    NOT NULL CHECK (responsavel IN ('PESSOAL', 'TERCEIROS', 'GENESYS')),
    meio            TEXT    NOT NULL CHECK (meio IN ('CREDITO', 'DEBITO')),
    categoria_id    INTEGER REFERENCES categoria(id) ON DELETE SET NULL,
    data_compra     TEXT    NOT NULL,
    criado_em       TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS lancamento (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    data            TEXT    NOT NULL,
    descricao       TEXT    NOT NULL,
    valor           INTEGER NOT NULL CHECK (valor > 0),
    fluxo           TEXT    NOT NULL CHECK (fluxo IN ('SAIDA', 'ENTRADA')),
    responsavel     TEXT    NOT NULL CHECK (responsavel IN ('PESSOAL', 'TERCEIROS', 'GENESYS')),
    natureza        TEXT    NOT NULL CHECK (natureza IN ('FIXO', 'PARCELAMENTO', 'AVULSO')),
    meio            TEXT    NOT NULL CHECK (meio IN ('CREDITO', 'DEBITO')),
    categoria_id    INTEGER REFERENCES categoria(id) ON DELETE SET NULL,
    fatura_ref      TEXT,
    origem          TEXT    NOT NULL DEFAULT 'MANUAL'
                            CHECK (origem IN ('MANUAL', 'RECORRENCIA', 'PARCELAMENTO', 'SETUP')),
    recorrencia_id  INTEGER REFERENCES recorrencia(id) ON DELETE SET NULL,
    parcelamento_id INTEGER REFERENCES parcelamento(id) ON DELETE CASCADE,
    parcela_num     INTEGER,
    parcela_total   INTEGER,
    observacao      TEXT    NOT NULL DEFAULT '',
    criado_em       TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_lancamento_data       ON lancamento(data);
CREATE INDEX IF NOT EXISTS ix_lancamento_fatura     ON lancamento(fatura_ref);
CREATE INDEX IF NOT EXISTS ix_lancamento_resp       ON lancamento(responsavel);
CREATE INDEX IF NOT EXISTS ix_lancamento_parcelamento ON lancamento(parcelamento_id);

CREATE TABLE IF NOT EXISTS pagamento_fatura (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    fatura_ref TEXT    NOT NULL,
    data       TEXT    NOT NULL,
    valor      INTEGER NOT NULL CHECK (valor > 0),
    reserva_id INTEGER REFERENCES reserva(id) ON DELETE SET NULL,
    observacao TEXT    NOT NULL DEFAULT '',
    criado_em  TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_pagamento_fatura_ref ON pagamento_fatura(fatura_ref);

CREATE TABLE IF NOT EXISTS mov_reserva (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    reserva_id   INTEGER NOT NULL REFERENCES reserva(id) ON DELETE CASCADE,
    data         TEXT    NOT NULL,
    tipo         TEXT    NOT NULL CHECK (tipo IN ('DEPOSITO', 'SAQUE', 'RENDIMENTO')),
    valor        INTEGER NOT NULL CHECK (valor > 0),
    descricao    TEXT    NOT NULL DEFAULT '',
    pagamento_id INTEGER REFERENCES pagamento_fatura(id) ON DELETE CASCADE,
    criado_em    TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_mov_reserva_reserva ON mov_reserva(reserva_id);

-- Marca quais meses de cada recorrencia ja foram lancados.
-- O registro SOBREVIVE a exclusao do lancamento (ON DELETE SET NULL) para
-- que um fixo apagado de proposito nao volte a aparecer sozinho.
CREATE TABLE IF NOT EXISTS recorrencia_gerada (
    recorrencia_id INTEGER NOT NULL REFERENCES recorrencia(id) ON DELETE CASCADE,
    ref            TEXT    NOT NULL,
    lancamento_id  INTEGER REFERENCES lancamento(id) ON DELETE SET NULL,
    gerado_em      TEXT    NOT NULL,
    PRIMARY KEY (recorrencia_id, ref)
);
"""


CONFIG_PADRAO = {
    "schema_versao": str(SCHEMA_VERSAO),
    "mes_inicial": "2026-09",
    "dia_fechamento": "29",
    "dia_vencimento": "3",
    "saldo_inicial_conta": "0",
    "nome_conta": "Conta Nubank",
    "setup_concluido": "0",
}


def conectar() -> sqlite3.Connection:
    """Abre o banco, criando pasta e schema na primeira vez.

    `check_same_thread=False` e necessario, nao uma gambiarra: o FastAPI
    executa a dependencia que abre a conexao e a funcao do endpoint em
    threads possivelmente DIFERENTES do seu pool. Sem isso, endpoints
    falham de forma intermitente -- so quando o pool troca de thread.

    E seguro aqui porque cada request tem a sua propria conexao e o uso e
    estritamente sequencial dentro do request (a dependencia entrega a
    conexao, o endpoint roda, a dependencia fecha -- nunca ao mesmo tempo).
    O modulo sqlite3 do CPython ainda serializa o acesso por conta propria
    (`sqlite3.threadsafety == 3`).
    """
    PASTA_DADOS.mkdir(parents=True, exist_ok=True)
    _migrar_do_layout_antigo()
    conn = sqlite3.connect(CAMINHO_DB, isolation_level=None, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = DELETE")
    return conn


def inicializar(conn: sqlite3.Connection) -> None:
    """Cria o schema, aplica migracoes e semeia os dados iniciais."""
    conn.executescript(SCHEMA)

    for chave, valor in CONFIG_PADRAO.items():
        conn.execute(
            "INSERT INTO config (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO NOTHING",
            (chave, valor),
        )

    ja_tem = conn.execute("SELECT COUNT(*) FROM categoria").fetchone()[0]
    if not ja_tem:
        conn.executemany(
            "INSERT INTO categoria (nome, cor, icone, ordem) VALUES (?, ?, ?, ?)",
            [(nome, cor, icone, i) for i, (nome, cor, icone) in enumerate(CATEGORIAS_PADRAO)],
        )

    _migrar(conn)


def _migrar(conn: sqlite3.Connection) -> None:
    """Aplica migracoes incrementais em bancos criados por versoes antigas."""
    linha = conn.execute("SELECT valor FROM config WHERE chave = 'schema_versao'").fetchone()
    versao = int(linha["valor"]) if linha else 0

    # Migracoes futuras entram aqui:
    #   if versao < 2:
    #       conn.execute("ALTER TABLE ...")
    #       versao = 2

    if versao != SCHEMA_VERSAO:
        conn.execute(
            "UPDATE config SET valor = ? WHERE chave = 'schema_versao'", (str(SCHEMA_VERSAO),)
        )


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------


def ler_config(conn: sqlite3.Connection) -> dict[str, str]:
    return {linha["chave"]: linha["valor"] for linha in conn.execute("SELECT chave, valor FROM config")}


def gravar_config(conn: sqlite3.Connection, chave: str, valor: str) -> None:
    conn.execute(
        "INSERT INTO config (chave, valor) VALUES (?, ?) "
        "ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor",
        (chave, str(valor)),
    )


# ---------------------------------------------------------------------------
# Backup / restauracao -- e assim que o banco viaja para outro computador
# ---------------------------------------------------------------------------


def exportar_backup(conn: sqlite3.Connection, destino: Path | None = None) -> Path:
    """Copia consistente do banco, usando a API de backup do proprio SQLite."""
    PASTA_BACKUPS.mkdir(parents=True, exist_ok=True)
    if destino is None:
        marca = datetime.now().strftime("%Y-%m-%d_%H%M%S")
        destino = PASTA_BACKUPS / f"nucontrole_{marca}.db"

    destino.parent.mkdir(parents=True, exist_ok=True)
    alvo = sqlite3.connect(destino)
    try:
        conn.backup(alvo)
    finally:
        alvo.close()
    return destino


def importar_backup(origem: Path) -> None:
    """Substitui o banco atual por um arquivo .db trazido de fora.

    Guarda o banco vigente em `dados/backups/` antes de sobrescrever, para
    que uma importacao errada nunca seja definitiva.
    """
    origem = Path(origem)
    if not origem.is_file():
        raise FileNotFoundError(f"arquivo nao encontrado: {origem}")

    # Valida que e um SQLite legivel e com o schema do NuControle.
    teste = sqlite3.connect(f"file:{origem}?mode=ro", uri=True)
    try:
        tabelas = {
            linha[0] for linha in teste.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
        }
    finally:
        teste.close()

    faltando = {"config", "lancamento", "reserva"} - tabelas
    if faltando:
        raise ValueError(f"nao parece um banco do NuControle (faltam tabelas: {sorted(faltando)})")

    if CAMINHO_DB.exists():
        PASTA_BACKUPS.mkdir(parents=True, exist_ok=True)
        marca = datetime.now().strftime("%Y-%m-%d_%H%M%S")
        shutil.copy2(CAMINHO_DB, PASTA_BACKUPS / f"antes_da_importacao_{marca}.db")

    PASTA_DADOS.mkdir(parents=True, exist_ok=True)
    shutil.copy2(origem, CAMINHO_DB)
