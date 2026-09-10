"""
Inicia o NuControle.

    python run.py

Sobe o servidor local e abre o navegador. Nada sai da sua maquina: o
servidor escuta apenas em 127.0.0.1 (localhost), inacessivel pela rede.

Quando o Tauri entrar (fase 2), este mesmo processo passa a ser iniciado
pelo Rust como "sidecar" e a janela do Tauri aponta para a mesma URL --
por isso o front-end nunca supoe estar num navegador.
"""

from __future__ import annotations

import os
import socket
import sys
import threading
import webbrowser

HOST = "127.0.0.1"
PORTA_PREFERIDA = 8757


def vigiar_quem_nos_iniciou() -> None:
    """Encerra este processo quando o app que nos iniciou morrer.

    A casca do Tauri nos inicia com o stdin ligado a um pipe que ela mantem
    aberto. Se o NuControle for encerrado -- inclusive a forca, pelo
    Gerenciador de Tarefas --, o sistema fecha esse pipe, o `read()` abaixo
    retorna EOF e a gente sai. Sem isso sobraria um `python.exe` orfao
    segurando a porta e o arquivo do banco.

    `os._exit` em vez de `sys.exit`: estamos numa thread, e `sys.exit` so
    encerraria a thread -- o uvicorn continuaria servindo.
    """
    try:
        sys.stdin.read()
    except Exception:
        pass
    os._exit(0)


def porta_livre(host: str, inicial: int, tentativas: int = 20) -> int:
    """Primeira porta livre a partir de `inicial`.

    Evita o erro chato de 'porta em uso' quando uma execucao anterior
    ficou pendurada.
    """
    for porta in range(inicial, inicial + tentativas):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind((host, porta))
                return porta
            except OSError:
                continue
    raise SystemExit(
        f"Nenhuma porta livre entre {inicial} e {inicial + tentativas - 1}."
    )


def main() -> None:
    try:
        import uvicorn
    except ModuleNotFoundError:
        sys.exit(
            "Dependencias faltando. Rode:\n\n"
            "    python -m pip install -r requirements.txt\n"
        )

    from backend import db

    # Cria pasta e schema antes de subir o servidor, para que um erro de
    # banco apareca aqui no terminal e nao como um 500 no navegador.
    conn = db.conectar()
    try:
        db.inicializar(conn)
    finally:
        conn.close()

    # O Tauri escolhe a porta antes de iniciar este processo e precisa que a
    # janela aponte para ela; nesse caso a porta vem imposta e nao procuramos
    # outra -- procurar daria uma URL diferente da que a janela vai abrir.
    porta_imposta = os.environ.get("NUCONTROLE_PORTA")
    if porta_imposta:
        try:
            porta = int(porta_imposta)
        except ValueError:
            sys.exit(f"NUCONTROLE_PORTA invalida: {porta_imposta!r}")
    else:
        porta = porta_livre(HOST, PORTA_PREFERIDA)

    url = f"http://{HOST}:{porta}"

    print("\n  NuControle")
    print(f"  {url}")
    print(f"  banco: {db.CAMINHO_DB}")
    print("\n  Ctrl+C para encerrar.\n")
    sys.stdout.flush()  # o Tauri le esta saida para saber que subiu

    # Somente quando o Tauri pede. Rodando no terminal, o stdin pode ja
    # estar fechado (`< NUL`, servico, IDE), o EOF viria na hora e o
    # servidor cairia antes de subir.
    if os.environ.get("NUCONTROLE_VIGIAR_STDIN") == "1":
        threading.Thread(target=vigiar_quem_nos_iniciou, daemon=True).start()

    if "--sem-navegador" not in sys.argv:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()

    uvicorn.run("backend.api:app", host=HOST, port=porta, log_level="warning")


if __name__ == "__main__":
    main()
