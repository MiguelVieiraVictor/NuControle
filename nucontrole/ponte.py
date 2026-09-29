"""
A ponte entre a janela (JavaScript) e o Python.

O pywebview expoe cada metodo publico desta classe como
`window.pywebview.api.<metodo>(...)`, que no JS devolve uma Promise. Nao ha
servidor HTTP nem porta: a chamada vai direto da WebView para o Python.

Toda chamada devolve o mesmo envelope:
    {"ok": true,  "dados": ...}
    {"ok": false, "erro": "mensagem para o usuario"}

Dois cuidados:
  - O pywebview chama cada metodo numa thread propria. Cada chamada abre sua
    conexao SQLite (entao nunca ha conexao compartilhada entre threads) e uma
    trava global faz as chamadas rodarem uma de cada vez.
  - Metodos e atributos com "_" nao sao expostos ao JS.
"""

from __future__ import annotations

import functools
import sqlite3
import threading
import traceback
from pathlib import Path

import webview

from . import backup, consultas, escrita
from .base import ErroValidacao
from .db import caminho_banco, conectar

_trava = threading.Lock()


def _endpoint(func):
    @functools.wraps(func)
    def envelope(self, *args):
        with _trava:
            conn = conectar()
            try:
                escrita.garantir_fixos(conn)
                return {"ok": True, "dados": func(self, conn, *args)}
            except ErroValidacao as e:
                return {"ok": False, "erro": str(e)}
            except sqlite3.IntegrityError as e:
                traceback.print_exc()
                return {"ok": False, "erro": f"O banco recusou a operação ({e})."}
            except Exception as e:  # noqa: BLE001 -- nada pode derrubar a janela
                traceback.print_exc()
                return {"ok": False, "erro": f"Erro inesperado: {type(e).__name__}: {e}"}
            finally:
                conn.close()

    return envelope


class Api:
    # --- leitura -----------------------------------------------------------

    @_endpoint
    def estado(self, conn):
        return {**consultas.estado(conn), "banco": str(caminho_banco())}

    # As telas de um mes geram os fixos ate ele antes de ler (ver garantir_fixos).

    @_endpoint
    def visao_geral(self, conn, ref=None):
        escrita.garantir_fixos(conn, ref)
        return consultas.visao_geral(conn, ref)

    @_endpoint
    def mes(self, conn, ref):
        escrita.garantir_fixos(conn, ref)
        return consultas.mes(conn, ref)

    @_endpoint
    def faturas(self, conn, incluir=None):
        escrita.garantir_fixos(conn, incluir)
        return consultas.faturas(conn, incluir)

    @_endpoint
    def fatura(self, conn, ref):
        escrita.garantir_fixos(conn, ref)
        return consultas.fatura(conn, ref)

    @_endpoint
    def reservas(self, conn):
        return consultas.reservas(conn)

    @_endpoint
    def compra(self, conn, compra_id):
        return consultas.compra(conn, int(compra_id))

    # --- compras -----------------------------------------------------------

    @_endpoint
    def salvar_compra(self, conn, dados, compra_id=None):
        return escrita.salvar_compra(conn, dados, int(compra_id) if compra_id else None)

    @_endpoint
    def excluir_compra(self, conn, compra_id):
        escrita.excluir_compra(conn, int(compra_id))

    @_endpoint
    def pular_mes_fixo(self, conn, lancamento_id):
        escrita.pular_mes_fixo(conn, int(lancamento_id))

    @_endpoint
    def encerrar_fixo(self, conn, compra_id, fim_ref):
        escrita.encerrar_fixo(conn, int(compra_id), fim_ref)

    # --- donos -------------------------------------------------------------

    @_endpoint
    def salvar_dono(self, conn, dados, dono_id=None):
        return escrita.salvar_dono(conn, dados, int(dono_id) if dono_id else None)

    @_endpoint
    def arquivar_dono(self, conn, dono_id, ativo):
        escrita.arquivar_dono(conn, int(dono_id), bool(ativo))

    @_endpoint
    def excluir_dono(self, conn, dono_id):
        escrita.excluir_dono(conn, int(dono_id))

    # --- categorias --------------------------------------------------------

    @_endpoint
    def salvar_categoria(self, conn, dados, categoria_id=None):
        return escrita.salvar_categoria(conn, dados, int(categoria_id) if categoria_id else None)

    @_endpoint
    def excluir_categoria(self, conn, categoria_id):
        escrita.excluir_categoria(conn, int(categoria_id))

    # --- caixinhas ---------------------------------------------------------

    @_endpoint
    def salvar_reserva(self, conn, dados, reserva_id=None):
        return escrita.salvar_reserva(conn, dados, int(reserva_id) if reserva_id else None)

    @_endpoint
    def excluir_reserva(self, conn, reserva_id):
        escrita.excluir_reserva(conn, int(reserva_id))

    @_endpoint
    def criar_mov_reserva(self, conn, dados):
        return escrita.criar_mov_reserva(conn, dados)

    @_endpoint
    def excluir_mov_reserva(self, conn, mov_id):
        escrita.excluir_mov_reserva(conn, int(mov_id))

    # --- fatura e ajustes --------------------------------------------------

    @_endpoint
    def pagar_fatura(self, conn, dados):
        return escrita.pagar_fatura(conn, dados)

    @_endpoint
    def excluir_pagamento(self, conn, pagamento_id):
        escrita.excluir_pagamento(conn, int(pagamento_id))

    @_endpoint
    def salvar_config(self, conn, dados):
        escrita.salvar_config(conn, dados)

    # --- backup ------------------------------------------------------------
    # A janela de arquivo abre FORA da trava: enquanto voce escolhe o local,
    # o resto do app nao fica esperando.

    def salvar_backup(self):
        destino = _dialogo(webview.FileDialog.SAVE, save_filename=backup.nome_sugerido())
        if not destino:
            return {"ok": True, "dados": None}  # cancelou
        return self._exportar(destino)

    def escolher_backup(self):
        """Abre o arquivo e so VALIDA; quem restaura e restaurar_backup, depois
        que o usuario confirma vendo o resumo."""
        origem = _dialogo(webview.FileDialog.OPEN)
        if not origem:
            return {"ok": True, "dados": None}
        return self._validar(origem)

    @_endpoint
    def restaurar_backup(self, conn, caminho):
        copia = backup.restaurar(conn, caminho)
        return {"copia_seguranca": str(copia)}

    @_endpoint
    def _exportar(self, conn, destino):
        return {"caminho": str(backup.exportar(conn, destino))}

    @_endpoint
    def _validar(self, conn, origem):
        return backup.validar(origem)


def _dialogo(tipo, save_filename: str = "") -> str | None:
    if not webview.windows:
        return None
    escolha = webview.windows[0].create_file_dialog(
        tipo,
        directory=str(Path.home() / "Documents"),
        save_filename=save_filename,
        file_types=("Backup do NuControle (*.db)", "Todos os arquivos (*.*)"),
    )
    if not escolha:
        return None
    return escolha if isinstance(escolha, str) else escolha[0]
