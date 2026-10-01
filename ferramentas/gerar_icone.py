"""
Gera o icone do NuControle: um "N" branco sobre roxo com uma moeda de "$".

    python ferramentas/gerar_icone.py

Saidas (versionadas no git, entao so precisa rodar de novo se mudar o desenho):
    frontend/img/icone.png      64 px, usado na barra lateral e como favicon
    frontend/img/icone-180.png  iPhone ("Adicionar a Tela de Inicio")
    frontend/img/icone-192.png  Android / manifest
    frontend/img/icone-512.png  Android / manifest (tela de abertura)

Precisa de Pillow (so para gerar; o app nao depende dele).

Cada tamanho e desenhado em 1024 px e reduzido, para as bordas ficarem suaves.
Abaixo de 32 px o "$" viraria borrao, entao a moeda aparece lisa.
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

RAIZ = Path(__file__).resolve().parent.parent
BASE = 1024

ROXO_A = (0x8A, 0x3F, 0xFC)   # mesmas cores do logo da barra lateral
ROXO_B = (0xB9, 0x83, 0xFF)
MOEDA = (0x2F, 0xBF, 0x71)    # o verde "bom" do tema
MOEDA_BORDA = (0x1B, 0x8F, 0x52)
BRANCO = (255, 255, 255)

FONTE = Path(r"C:\Windows\Fonts\seguibl.ttf")  # Segoe UI Black


def _degrade(tam: int) -> Image.Image:
    """Degrade diagonal (135 graus) de ROXO_A para ROXO_B."""
    img = Image.new("RGB", (tam, tam))
    px = img.load()
    for y in range(tam):
        for x in range(tam):
            t = (x + y) / (2 * (tam - 1))
            px[x, y] = tuple(round(a + (b - a) * t) for a, b in zip(ROXO_A, ROXO_B))
    return img


_FUNDO = None


def desenhar(com_cifrao: bool) -> Image.Image:
    global _FUNDO
    if _FUNDO is None:
        _FUNDO = _degrade(BASE)

    img = Image.new("RGBA", (BASE, BASE), (0, 0, 0, 0))
    mascara = Image.new("L", (BASE, BASE), 0)
    ImageDraw.Draw(mascara).rounded_rectangle((0, 0, BASE - 1, BASE - 1), radius=int(BASE * 0.22), fill=255)
    img.paste(_FUNDO, (0, 0), mascara)
    d = ImageDraw.Draw(img)

    # "N" geometrico: duas hastes e a diagonal, um pouco a esquerda para a moeda caber
    x0, x1 = BASE * 0.20, BASE * 0.70
    y0, y1 = BASE * 0.20, BASE * 0.80
    haste = BASE * 0.125
    d.rectangle((x0, y0, x0 + haste, y1), fill=BRANCO)
    d.rectangle((x1 - haste, y0, x1, y1), fill=BRANCO)
    d.polygon([(x0, y0), (x0 + haste * 1.05, y0), (x1, y1), (x1 - haste * 1.05, y1)], fill=BRANCO)

    # moeda no canto inferior direito, com um anel da cor do fundo separando do N
    cx, cy, r = BASE * 0.735, BASE * 0.735, BASE * 0.205
    anel = BASE * 0.035
    corte = Image.new("L", (BASE, BASE), 0)
    ImageDraw.Draw(corte).ellipse((cx - r - anel, cy - r - anel, cx + r + anel, cy + r + anel), fill=255)
    img.paste(_FUNDO, (0, 0), corte)  # o anel e o proprio fundo: recorta o N sem halo
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=MOEDA_BORDA)
    borda = BASE * 0.022
    d.ellipse((cx - r + borda, cy - r + borda, cx + r - borda, cy + r - borda), fill=MOEDA)

    if com_cifrao:
        fonte = ImageFont.truetype(str(FONTE), int(r * 1.45))
        d.text((cx, cy + r * 0.04), "$", font=fonte, fill=BRANCO, anchor="mm")
    return img


def main() -> None:
    grande = desenhar(com_cifrao=True)
    pasta = RAIZ / "frontend" / "img"
    pasta.mkdir(exist_ok=True)
    grande.resize((64, 64), Image.LANCZOS).save(pasta / "icone.png")
    for tam in (180, 192, 512):
        grande.resize((tam, tam), Image.LANCZOS).save(pasta / f"icone-{tam}.png")
    print("ok: 64, 180, 192, 512 px")


if __name__ == "__main__":
    main()
