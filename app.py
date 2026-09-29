"""
Abre o NuControle numa janela desktop.

    python app.py            abre a janela
    python app.py --debug    abre com o DevTools (F12) habilitado

Empacotado pelo PyInstaller (ver build.ps1), vira um NuControle.exe que nao
exige Python instalado.
"""

from __future__ import annotations

import sys
from pathlib import Path

import webview

from nucontrole import VERSAO
from nucontrole.ponte import Api


def raiz() -> Path:
    # Dentro do .exe do PyInstaller os arquivos ficam em sys._MEIPASS.
    return Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))


def pasta_frontend() -> Path:
    return raiz() / "frontend"


def main() -> None:
    debug = "--debug" in sys.argv
    webview.create_window(
        f"NuControle {VERSAO}",
        url=str(pasta_frontend() / "index.html"),
        js_api=Api(),
        width=1320,
        height=860,
        min_size=(980, 640),
        background_color="#0E0B14",
    )
    # icone da janela e da barra de tarefas (o do .exe vem do --icon no build.ps1)
    webview.start(debug=debug, private_mode=False, icon=str(raiz() / "assets" / "icone.ico"))


if __name__ == "__main__":
    main()
