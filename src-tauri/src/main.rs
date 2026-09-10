// Esconde o console do Windows na versao release (em debug ele fica, para
// dar para ler o traceback do Python).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Casca desktop do NuControle.
//!
//! Esta casca nao sabe nada de financas. Ela faz quatro coisas:
//!
//!   1. pede ao sistema uma porta livre;
//!   2. acha o Python do sistema e sobe `run.py` nessa porta;
//!   3. espera a porta comecar a aceitar conexao;
//!   4. abre a janela apontando para `http://127.0.0.1:<porta>`.
//!
//! Se qualquer passo falhar, em vez de abrir uma janela branca ela abre
//! `erro.html`, que explica o que fazer.

use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

const HOST: Ipv4Addr = Ipv4Addr::LOCALHOST;
const ESPERA_MAX: Duration = Duration::from_secs(45);

/// Guarda o processo do Python para poder mata-lo quando a janela fechar.
struct Servidor(Mutex<Option<Child>>);

/// Por que a inicializacao falhou. O valor vai como `?motivo=` para o
/// `erro.html`, que tem o texto de cada caso.
enum Falha {
    SemProjeto,
    SemPython,
    SemDependencias,
    SemServidor,
}

impl Falha {
    fn codigo(&self) -> &'static str {
        match self {
            Falha::SemProjeto => "sem-projeto",
            Falha::SemPython => "sem-python",
            Falha::SemDependencias => "sem-dependencias",
            Falha::SemServidor => "sem-servidor",
        }
    }
}

/// Aplica CREATE_NO_WINDOW para o Python nao piscar um console preto.
fn sem_console(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    let _ = cmd;
}

/// Pede ao SO uma porta livre e a devolve.
///
/// Existe uma janela minima entre soltar o listener e o Python ocupar a
/// porta. Num desktop de um usuario isso e irrelevante, e a alternativa
/// (passar o socket ja aberto para o Python) nao vale a complexidade.
fn porta_livre() -> u16 {
    TcpListener::bind((HOST, 0))
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(8757)
}

/// Acha a pasta que contem o `run.py`.
///
/// Tenta, em ordem: os recursos empacotados (varios layouts possiveis do
/// bundler), a pasta do executavel subindo alguns niveis (que e o caso do
/// `tauri dev`, onde o exe fica em `src-tauri/target/debug`) e o diretorio
/// de trabalho.
fn achar_projeto(app: &tauri::AppHandle) -> Option<PathBuf> {
    let mut candidatos: Vec<PathBuf> = Vec::new();

    if let Ok(recursos) = app.path().resource_dir() {
        candidatos.push(recursos.join("app"));
        candidatos.push(recursos.join("_up_"));
        candidatos.push(recursos);
    }

    if let Ok(exe) = std::env::current_exe() {
        let mut dir = exe.parent().map(Path::to_path_buf);
        for _ in 0..5 {
            match dir {
                Some(d) => {
                    candidatos.push(d.clone());
                    dir = d.parent().map(Path::to_path_buf);
                }
                None => break,
            }
        }
    }

    if let Ok(cwd) = std::env::current_dir() {
        candidatos.push(cwd);
    }

    candidatos.into_iter().find(|c| c.join("run.py").is_file())
}

/// Roda um Python candidato com `-c <codigo>` e diz se saiu com sucesso.
fn python_ok(exe: &Path, codigo: &str, raiz: &Path) -> bool {
    let mut cmd = Command::new(exe);
    cmd.arg("-c").arg(codigo).current_dir(raiz);
    sem_console(&mut cmd);
    matches!(cmd.status(), Ok(st) if st.success())
}

/// Acha o caminho do `python.exe` de verdade.
///
/// Dois cuidados aqui, ambos aprendidos na pratica:
///
/// * `python` no PATH pode ser o atalho da Microsoft Store, que abre a loja
///   em vez de executar codigo -- por isso testamos rodando codigo real.
///
/// * o lancador `py -3` e o jeito mais confiavel de ACHAR o Python no
///   Windows, mas ele e um intermediario: `py` abre um `python.exe` filho.
///   Se subissemos o servidor via `py`, matar o `py` deixaria o
///   `python.exe` orfao segurando a porta e o banco. Por isso perguntamos
///   ao Python onde ele mora (`sys.executable`) e depois executamos esse
///   binario diretamente, sem intermediario.
fn achar_python(raiz: &Path) -> Option<PathBuf> {
    let candidatos: [(&str, &[&str]); 3] =
        [("py", &["-3"]), ("python", &[]), ("python3", &[])];

    for (exe, args) in candidatos {
        let mut cmd = Command::new(exe);
        cmd.args(args)
            .arg("-c")
            .arg("import sys; sys.stdout.write(sys.executable)")
            .current_dir(raiz);
        sem_console(&mut cmd);

        if let Ok(saida) = cmd.output() {
            if saida.status.success() {
                let caminho = String::from_utf8_lossy(&saida.stdout).trim().to_string();
                if !caminho.is_empty() {
                    let real = PathBuf::from(caminho);
                    if real.is_file() {
                        return Some(real);
                    }
                }
            }
        }
    }
    None
}

/// Espera a porta comecar a aceitar conexao.
fn esperar_servidor(porta: u16, limite: Duration) -> bool {
    let alvo = SocketAddr::new(IpAddr::V4(HOST), porta);
    let inicio = Instant::now();
    while inicio.elapsed() < limite {
        if TcpStream::connect_timeout(&alvo, Duration::from_millis(250)).is_ok() {
            return true;
        }
        thread::sleep(Duration::from_millis(120));
    }
    false
}

/// Sobe o Python e devolve a URL da janela.
fn iniciar(app: &tauri::AppHandle) -> Result<String, Falha> {
    let raiz = achar_projeto(app).ok_or(Falha::SemProjeto)?;
    let python = achar_python(&raiz).ok_or(Falha::SemPython)?;

    if !python_ok(&python, "import fastapi, uvicorn", &raiz) {
        return Err(Falha::SemDependencias);
    }

    let porta = porta_livre();

    let mut cmd = Command::new(&python);
    cmd.arg("run.py")
        .arg("--sem-navegador")
        .current_dir(&raiz)
        .env("NUCONTROLE_PORTA", porta.to_string())
        // Sem buffer, para o traceback aparecer na hora em modo debug.
        .env("PYTHONUNBUFFERED", "1")
        // O Python vigia este pipe e se encerra quando ele fechar.
        .env("NUCONTROLE_VIGIAR_STDIN", "1")
        // A ponta de escrita deste pipe fica dentro do `Child`, que guardamos
        // no estado do app. Se o NuControle morrer por QUALQUER motivo --
        // inclusive a forca, pelo Gerenciador de Tarefas, quando o `kill()`
        // da saida nunca roda --, o SO fecha o pipe, o `sys.stdin.read()`
        // do Python retorna EOF e ele se encerra sozinho. E o mesmo efeito
        // de um Job Object, sem uma linha de `unsafe`.
        .stdin(Stdio::piped());
    sem_console(&mut cmd);

    let filho = cmd.spawn().map_err(|_| Falha::SemPython)?;

    if let Some(estado) = app.try_state::<Servidor>() {
        if let Ok(mut guarda) = estado.0.lock() {
            *guarda = Some(filho);
        }
    }

    if !esperar_servidor(porta, ESPERA_MAX) {
        return Err(Falha::SemServidor);
    }

    Ok(format!("http://127.0.0.1:{porta}"))
}

/// Cria a janela, seja no app ou na tela de erro.
fn abrir_janela(app: &tauri::AppHandle, destino: Result<String, Falha>) {
    let url = match &destino {
        Ok(endereco) => match endereco.parse() {
            Ok(u) => WebviewUrl::External(u),
            Err(_) => WebviewUrl::App("erro.html?motivo=sem-servidor".into()),
        },
        Err(falha) => {
            WebviewUrl::App(format!("erro.html?motivo={}", falha.codigo()).into())
        }
    };

    let resultado = WebviewWindowBuilder::new(app, "principal", url)
        .title("NuControle")
        .inner_size(1440.0, 900.0)
        .min_inner_size(940.0, 620.0)
        .center()
        .resizable(true)
        .build();

    if let Err(erro) = resultado {
        eprintln!("nao foi possivel criar a janela: {erro}");
        app.exit(1);
    }
}

/// Encerra o Python. Chamado quando o app sai.
fn parar_servidor(app: &tauri::AppHandle) {
    if let Some(estado) = app.try_state::<Servidor>() {
        if let Ok(mut guarda) = estado.0.lock() {
            if let Some(mut filho) = guarda.take() {
                let _ = filho.kill();
                let _ = filho.wait();
            }
        }
    }
}

fn main() {
    tauri::Builder::default()
        .manage(Servidor(Mutex::new(None)))
        .setup(|app| {
            let handle = app.handle().clone();
            let destino = iniciar(&handle);
            abrir_janela(&handle, destino);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("erro ao construir o aplicativo")
        .run(|handle, evento| {
            if matches!(evento, RunEvent::Exit) {
                parar_servidor(handle);
            }
        });
}
