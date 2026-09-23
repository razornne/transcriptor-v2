"""Синтетический eval-набор с известным эталоном для сравнения STT-систем.

Двухголосые диалоги на uk/ru/pl/cs/en (Microsoft neural TTS через edge-tts):
имена, числа, бренды, в uk/ru — английские термины посреди фразы. Каждый
диалог в двух вариантах: clean и noisy (телефонная полоса + розовый шум +
opus 16 kbps — ближе к реальному звонку). Числа цифрами и в озвучке, и в
эталоне — чтобы не штрафовать системы за формат записи чисел.

Запуск:  python tests/eval_make_tts.py            (нужны edge-tts и ffmpeg)
Выход:   eval_set/tts/{lang}_{clean,noisy}.ogg + .reference.txt (в .gitignore)
"""
import asyncio
import subprocess
import sys
from pathlib import Path

import edge_tts

OUT = Path(__file__).resolve().parent.parent / "eval_set" / "tts"

VOICES = {
    "uk": ("uk-UA-OstapNeural", "uk-UA-PolinaNeural"),
    "ru": ("ru-RU-DmitryNeural", "ru-RU-SvetlanaNeural"),
    "pl": ("pl-PL-MarekNeural", "pl-PL-ZofiaNeural"),
    "cs": ("cs-CZ-AntoninNeural", "cs-CZ-VlastaNeural"),
    "en": ("en-US-GuyNeural", "en-US-JennyNeural"),
}

SCRIPTS = {
    "uk": [
        "Привіт, Олено. Дякую, що знайшла час. Сьогодні хочу пройтися по roadmap на четвертий квартал.",
        "Привіт, Андрію. Так, звісно. У нас CTR по рекламі впав до 1,2%, треба щось міняти.",
        "Розумію. А що з pitch deck для інвесторів? Дедлайн у п'ятницю.",
        "Я вже зробила 12 слайдів, але потрібен фідбек від Каті щодо фінансової моделі.",
        "Окей, я напишу Каті сьогодні ввечері. Скільки нам треба на маркетинг?",
        "Десь 15 тисяч доларів на місяць, якщо запускаємо Польщу і Чехію.",
        "Добре, тоді давай зробимо окремий бюджет під Варшаву.",
        "Домовились. Я підготую табличку в Google Sheets до четверга.",
    ],
    "ru": [
        "Добрый день, Марина. Давайте начнём с отчёта по продажам за сентябрь.",
        "Добрый день, Сергей. Продажи выросли на 18%, но конверсия на сайте упала.",
        "А что с onboarding для новых клиентов? Мы же хотели его упростить.",
        "Да, я сделала новый flow, теперь регистрация занимает 3 минуты вместо 7.",
        "Отлично. Нужно показать это команде на демо в среду.",
        "Хорошо, я подготовлю презентацию и пришлю вам ссылку в Slack.",
        "И ещё, пожалуйста, проверь бюджет на контекстную рекламу.",
        "Проверю до пятницы и напишу, сколько мы потратили в Google Ads.",
    ],
    "pl": [
        "Dzień dobry, Kasiu. Chciałbym omówić plan wdrożenia nowej aplikacji.",
        "Dzień dobry, Tomku. Wersja beta jest gotowa w 80%, zostały testy.",
        "Ile osób jest w zespole testowym? Czy potrzebujemy wsparcia?",
        "Mamy pięciu testerów, ale przydałby się jeszcze jeden specjalista od iOS.",
        "Dobrze, porozmawiam z działem HR jeszcze dzisiaj.",
        "Świetnie. Premiera w Warszawie jest zaplanowana na 15 listopada.",
        "Czy budżet marketingowy został już zatwierdzony przez zarząd?",
        "Tak, mamy 200 tysięcy złotych na pierwszy kwartał.",
    ],
    "cs": [
        "Dobrý den, Jano. Díky, že sis našla čas. Dnes bych chtěl projít výsledky za třetí čtvrtletí.",
        "Dobrý den, Petře. Tržby vzrostly o 12%, ale náklady na akvizici zákazníka jsou pořád vysoké.",
        "Rozumím. Kolik teď stojí jeden zákazník?",
        "Zhruba 800 korun. Cílujeme na 500, takže musíme optimalizovat kampaně na Facebooku.",
        "Dobře. A co nové CRM? Minule jsme řešili přechod na HubSpot.",
        "Migrace dat je hotová asi z 80%. Zbytek dokončíme do konce října.",
        "Výborně. Pošleš mi prosím do pátku shrnutí a seznam úkolů?",
        "Určitě, pošlu to e-mailem ještě dnes večer.",
    ],
    "en": [
        "Hi Sarah, thanks for joining. Let's go through the Q3 numbers first.",
        "Sure, Mike. Revenue grew 14% but churn is still around 6% per month.",
        "That's too high. What's the main reason people cancel?",
        "Mostly onboarding. New users don't understand how to connect Slack and Notion.",
        "Okay, let's build an interactive tutorial before the October release.",
        "I can have a first draft by next Wednesday if design helps me.",
        "Great, I'll ask Anna from design to block some time for you.",
        "Perfect. I'll send a summary with action items after this call.",
    ],
}


def ffmpeg(*args: str) -> None:
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", *args], check=True)


async def make(lang: str) -> None:
    lines = SCRIPTS[lang]
    work = OUT / f"_{lang}"
    work.mkdir(parents=True, exist_ok=True)
    parts = []
    for i, text in enumerate(lines):
        mp3 = work / f"{i:02d}.mp3"
        if not mp3.exists():
            await edge_tts.Communicate(text, VOICES[lang][i % 2]).save(str(mp3))
        wav = work / f"{i:02d}.wav"  # concat-демуксеру нужен один кодек у всех частей
        ffmpeg("-i", str(mp3), "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", str(wav))
        parts.append(wav)
    silence = work / "silence.wav"
    ffmpeg("-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono", "-t", "0.6", "-c:a", "pcm_s16le", str(silence))
    (work / "list.txt").write_text(
        "".join(f"file '{p.name}'\nfile 'silence.wav'\n" for p in parts), encoding="utf-8")
    clean_wav = work / "clean.wav"
    ffmpeg("-f", "concat", "-safe", "0", "-i", str(work / "list.txt"), "-ar", "48000", "-ac", "1", str(clean_wav))

    ffmpeg("-i", str(clean_wav), "-c:a", "libopus", "-b:a", "64k", str(OUT / f"{lang}_clean.ogg"))
    ffmpeg("-i", str(clean_wav), "-f", "lavfi", "-i", "anoisesrc=color=pink:amplitude=0.03:r=48000",
           "-filter_complex",
           "[0:a]highpass=f=300,lowpass=f=3400[v];[1:a]lowpass=f=3400[n];"
           "[v][n]amix=inputs=2:duration=first:normalize=0",
           "-ac", "1", "-c:a", "libopus", "-b:a", "16k", str(OUT / f"{lang}_noisy.ogg"))

    ref = "\n".join(f"{'SPEAKER_A' if i % 2 == 0 else 'SPEAKER_B'}: {t}" for i, t in enumerate(lines))
    for variant in ("clean", "noisy"):
        (OUT / f"{lang}_{variant}.reference.txt").write_text(ref + "\n", encoding="utf-8")
    print(f"  {lang}: ok")


async def main(langs: list[str]) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for lang in langs:
        await make(lang)


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1:] or list(SCRIPTS)))
