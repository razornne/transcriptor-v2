// EN/UA контент для лендинга. Структура зеркалит дизайн-прототип.

export type Lang = "en" | "ua";
export type HeadlineKey = "every" | "your" | "stop";

export const HEADLINES: Record<Lang, Record<HeadlineKey, string[]>> = {
  en: {
    every: ["Every call,", "word for word."],
    your:  ["Your calls.", "Transcribed.", "Instantly."],
    stop:  ["Stop re-listening.", "Start reading."],
  },
  ua: {
    every: ["Кожен дзвінок,", "слово в слово."],
    your:  ["Ваші дзвінки.", "Розшифровані.", "Миттєво."],
    stop:  ["Досить переслуховувати.", "Час читати."],
  },
};

// Дефолтный headline (можно потом сделать выбор)
export const DEFAULT_HEADLINE: HeadlineKey = "every";

export type PricingPlan = {
  name: string;
  featured?: boolean;
  badge?: string;
  price: number;        // в долларах, целое
  per: string;          // "/month", "/user / month", "/forever"
  tagline: string;
  features: string[];
  cta: string;
  ctaKind: "primary" | "ghost";
  fine?: string;
};

export type Copy = {
  nav: { features: string; pricing: string; openApp: string };
  hero: {
    eyebrow: string;
    sub: string;
    ctaPrimary: string;
    ctaSecondary: string;
    meta: Array<[string, string]>;
  };
  social: { quote: string; cite: string; firstUsers: string };
  how: {
    eyebrow: string; title: string; sub: string;
    steps: Array<{ n: string; h: string; p: string }>;
  };
  features: {
    eyebrow: string; title: string; sub: string;
    items: Array<{ tag: string; h: string; p: string; accent?: boolean }>;
  };
  breakout: {
    eyebrow: string; title: string; sub: string;
    history: Array<{
      label: string;
      rows: Array<{ name: string; when: string; on?: boolean }>;
    }>;
  };
  pricing: {
    eyebrow: string;
    title: string;
    sub: string;
    plans: PricingPlan[];
  };
  final: { title: string[]; ctaPrimary: string; ctaSecondary: string; fine: string };
  foot: { links: string[]; copy: string };
  mock: {
    url: string;
    eyebrow: string;
    rec: string;
    langPill: string;
    lines: Array<{ spk: 1 | 2; name: string; time: string; text: string; live?: boolean }>;
    summary: string[];
    summaryLabel: string;
    chip: string;
  };
};

// Новые цены: Free $0 / Pro $15 / Max $29 / Team $14 per user
const PLANS_EN: PricingPlan[] = [
  {
    name: "Free",
    price: 0, per: "/forever",
    tagline: "For trying it out",
    features: ["60 minutes / month", "Ukrainian + English", "Speaker separation", "Markdown export"],
    cta: "Start free",
    ctaKind: "ghost",
  },
  {
    name: "Pro", featured: true, badge: "Most popular",
    price: 15, per: "/month",
    tagline: "For one professional",
    features: ["600 minutes / month", "Summary + action items", "Full-text search", "Keyboard shortcuts", "Priority processing"],
    cta: "Start 14-day trial",
    ctaKind: "primary",
    fine: "14-day full trial, no card required.",
  },
  {
    name: "Max",
    price: 29, per: "/month",
    tagline: "For power users",
    features: ["2 000 minutes / month", "Everything in Pro", "Higher concurrency", "Extended history", "Early access to new models"],
    cta: "Go Max",
    ctaKind: "ghost",
  },
  {
    name: "Team",
    price: 14, per: "/user / month",
    tagline: "For small teams",
    features: ["600 minutes / user", "Shared workspace", "Per-user search", "Billing in one invoice", "Priority support"],
    cta: "Start team trial",
    ctaKind: "ghost",
  },
];

const PLANS_UA: PricingPlan[] = [
  {
    name: "Free",
    price: 0, per: "/назавжди",
    tagline: "Спробувати",
    features: ["60 хвилин / місяць", "Українська + англійська", "Розділення спікерів", "Експорт у Markdown"],
    cta: "Спробувати безкоштовно",
    ctaKind: "ghost",
  },
  {
    name: "Pro", featured: true, badge: "Найпопулярніший",
    price: 15, per: "/місяць",
    tagline: "Для однієї людини",
    features: ["600 хвилин / місяць", "Підсумок + дії", "Повнотекстовий пошук", "Гарячі клавіші", "Пріоритетна обробка"],
    cta: "14 днів безкоштовно",
    ctaKind: "primary",
    fine: "Повні 14 днів. Без картки.",
  },
  {
    name: "Max",
    price: 29, per: "/місяць",
    tagline: "Для активних користувачів",
    features: ["2 000 хвилин / місяць", "Все з Pro", "Більше паралельних обробок", "Розширена історія", "Ранній доступ до нових моделей"],
    cta: "Обрати Max",
    ctaKind: "ghost",
  },
  {
    name: "Team",
    price: 14, per: "/користувач / міс.",
    tagline: "Для малих команд",
    features: ["600 хвилин на користувача", "Спільний робочий простір", "Пошук по користувачах", "Один рахунок", "Пріоритетна підтримка"],
    cta: "Спробувати для команди",
    ctaKind: "ghost",
  },
];

export const COPY: Record<Lang, Copy> = {
  en: {
    nav: { features: "Features", pricing: "Pricing", openApp: "Open app" },
    hero: {
      eyebrow: "Skriptly · v1.0 · GPU-hosted",
      sub: "Best-in-class Ukrainian and English. Speakers separated automatically. Audio processed and deleted — we never store it.",
      ctaPrimary: "Start free",
      ctaSecondary: "See how it works",
      meta: [
        ["Languages",  "UA · EN"],
        ["Retention",  "0 seconds"],
        ["Live",       "during the call"],
      ],
    },
    social: {
      quote: "We used to pay an intern to re-listen to every client call and write up notes. Now the transcript is in the channel before the call even ends.",
      cite:  "Olena K. · Brand Strategist, Kyiv agency",
      firstUsers: "First 12 users",
    },
    how: {
      eyebrow: "How it works",
      title: "Three steps. No download.",
      sub: "Open a tab. Allow the mic. Get the transcript while the call is still happening.",
      steps: [
        { n: "01", h: "Open Skriptly",      p: "Go to skriptly.io/app in any modern browser. No installer, no extension, no Electron." },
        { n: "02", h: "Start recording",    p: "Allow mic access, pick the call tab to share audio. Speakers are detected automatically." },
        { n: "03", h: "Get your transcript",p: "Text appears live. When the call ends you get a summary, action items, and a Markdown export." },
      ],
    },
    features: {
      eyebrow: "What's inside",
      title: "Everything a transcript should be.",
      sub: "Built for individual professionals who don't want to babysit a recording. Designed around Ukrainian — not bolted on after.",
      items: [
        { tag: "UA", h: "Ukrainian + English",   p: "Best-in-class accuracy on both. Whisper-large + a Ukrainian-tuned acoustic model.", accent: true },
        { tag: "SS", h: "Speaker separation",    p: "pyannote diarization. Knows who said what — even on a phone call with overlap." },
        { tag: "LV", h: "Live transcript",       p: "Text appears while the call is still going. No 20-minute wait for processing." },
        { tag: "SM", h: "Summary + action items",p: "Auto-generated at the end. Edit them, ship them — they're plain Markdown." },
        { tag: "FS", h: "Full-text search",      p: "Find anything across every past call. Filter by speaker, language, or date." },
        { tag: "0",  h: "Zero retention",        p: "Audio is processed and deleted in the same request. We never store it. Not for training. Not at all." },
      ],
    },
    breakout: {
      eyebrow: "Inside the app",
      title: "Looks like the product you actually want to use.",
      sub: "Same wide type. Same warm parchment. Keyboard shortcuts for everything.",
      history: [
        { label: "Today",     rows: [
          { name: "Strategy sync · Maya & Andriy", when: "14:32", on: true },
          { name: "User interview · A. Kovalenko",  when: "11:08" },
        ]},
        { label: "Yesterday", rows: [
          { name: "Sales call · Innova Corp", when: "Wed" },
          { name: "Q4 planning · internal",   when: "Wed" },
        ]},
        { label: "Last week", rows: [
          { name: "Brand workshop",              when: "May 12" },
          { name: "Hiring loop · designer #3",  when: "May 11" },
          { name: "Investor update call",        when: "May 10" },
        ]},
      ],
    },
    pricing: {
      eyebrow: "Pricing",
      title: "Honest pricing. No seats minimum.",
      sub: "Start on Free. Upgrade when you outgrow it. Cancel from the app in two clicks.",
      plans: PLANS_EN,
    },
    final: {
      title: ["Ready to stop", "re-listening?"],
      ctaPrimary: "Start free — no card needed",
      ctaSecondary: "Open the app",
      fine: "Free forever for 60 min / month · No credit card · Cancel any time",
    },
    foot: {
      links: ["Features", "Pricing", "App", "Privacy", "Terms"],
      copy: "© 2026 Skriptly · Built in Kyiv",
    },
    mock: {
      url: "skriptly.io/app/c/k3p2-1a",
      eyebrow: "Live transcript",
      rec: "14:32",
      langPill: "EN",
      lines: [
        { spk: 1, name: "Maya",    time: "00:01:24", text: "So the key insight from the user interviews was that nobody actually wants to re-listen to a recording." },
        { spk: 2, name: "Andriy",  time: "00:01:38", text: "Right — they want to skim. And search. The transcript is the product." },
        { spk: 1, name: "Maya",    time: "00:01:52", text: "Exactly. So we should lead with that on the landing", live: true },
      ],
      summary: [
        "Re-listening is a non-job; users skim and search.",
        "Transcript is the primary artifact, not a byproduct.",
        "Lead with the read-instead-of-listen framing on the landing page.",
      ],
      summaryLabel: "Auto-summary · 3 points",
      chip: "Summary ready in 8s",
    },
  },

  ua: {
    nav: { features: "Можливості", pricing: "Тарифи", openApp: "Відкрити застосунок" },
    hero: {
      eyebrow: "Skriptly · v1.0 · GPU-сервер",
      sub: "Найкраща точність українською та англійською. Спікери розділяються автоматично. Аудіо обробляється та видаляється — ми його не зберігаємо.",
      ctaPrimary: "Спробувати безкоштовно",
      ctaSecondary: "Як це працює",
      meta: [
        ["Мови",         "UA · EN"],
        ["Збереження",   "0 секунд"],
        ["Транскрипт",   "у прямому ефірі"],
      ],
    },
    social: {
      quote: "Раніше ми платили інтерну, щоб переслуховував кожен дзвінок із клієнтом і робив нотатки. Тепер транскрипт у каналі ще до кінця дзвінка.",
      cite:  "Олена К. · Бренд-стратег, агенція з Києва",
      firstUsers: "Перші 12 користувачів",
    },
    how: {
      eyebrow: "Як це працює",
      title: "Три кроки. Без встановлення.",
      sub: "Відкрий вкладку. Дозволь мікрофон. Отримай транскрипт ще під час дзвінка.",
      steps: [
        { n: "01", h: "Відкрий Skriptly",   p: "Заходь на skriptly.io/app у будь-якому сучасному браузері. Ні інсталятора, ні розширення." },
        { n: "02", h: "Почни запис",        p: "Дозволь мікрофон і обери вкладку дзвінка для аудіо. Спікери визначаються автоматично." },
        { n: "03", h: "Отримай транскрипт", p: "Текст з’являється наживо. Після дзвінка — підсумок, тудушки та експорт у Markdown." },
      ],
    },
    features: {
      eyebrow: "Що всередині",
      title: "Все, чим має бути транскрипт.",
      sub: "Для тих, хто не хоче няньчити запис. Розроблено навколо української, а не прикручено зверху.",
      items: [
        { tag: "UA", h: "Українська + англійська", p: "Найкраща точність на обох. Whisper-large + дотренована акустична модель.", accent: true },
        { tag: "SS", h: "Розділення спікерів",     p: "pyannote-діаризація. Знає, хто що сказав — навіть у телефонному дзвінку з накладаннями." },
        { tag: "LV", h: "Транскрипт наживо",       p: "Текст з’являється просто під час дзвінка. Не треба чекати 20 хвилин на обробку." },
        { tag: "SM", h: "Підсумок + дії",          p: "Генерується автоматично. Редагуй, надсилай — це звичайний Markdown." },
        { tag: "FS", h: "Повнотекстовий пошук",    p: "Знайди що завгодно у всіх минулих дзвінках. Фільтри за спікером, мовою, датою." },
        { tag: "0",  h: "Нульове збереження",      p: "Аудіо обробляється і видаляється в межах одного запиту. Не зберігаємо. Не для тренування. Зовсім." },
      ],
    },
    breakout: {
      eyebrow: "У застосунку",
      title: "Виглядає як продукт, яким хочеться користуватися.",
      sub: "Та сама широка типографіка. Те саме тепле тло. Гарячі клавіші на все.",
      history: [
        { label: "Сьогодні", rows: [
          { name: "Стратегія · Майя та Андрій", when: "14:32", on: true },
          { name: "Інтерв’ю · А. Коваленко", when: "11:08" },
        ]},
        { label: "Вчора", rows: [
          { name: "Клієнт · Innova Corp", when: "Ср" },
          { name: "Q4 планування",            when: "Ср" },
        ]},
        { label: "Минулого тижня", rows: [
          { name: "Бренд-воркшоп",                when: "12 трав." },
          { name: "Співбесіда · дизайнер #3", when: "11 трав." },
          { name: "Дзвінок інвесторам",          when: "10 трав." },
        ]},
      ],
    },
    pricing: {
      eyebrow: "Тарифи",
      title: "Чесні тарифи. Без мінімальних місць.",
      sub: "Почни з Free. Перейди далі, коли переростеш. Скасування — у два кліки із застосунку.",
      plans: PLANS_UA,
    },
    final: {
      title: ["Час припинити", "переслуховувати?"],
      ctaPrimary: "Спробувати — без картки",
      ctaSecondary: "Відкрити застосунок",
      fine: "Безкоштовно назавжди — 60 хв / міс · Без картки · Скасуй будь-коли",
    },
    foot: {
      links: ["Можливості", "Тарифи", "Застосунок", "Приватність", "Умови"],
      copy: "© 2026 Skriptly · Зроблено в Києві",
    },
    mock: {
      url: "skriptly.io/app/c/k3p2-1a",
      eyebrow: "Транскрипт наживо",
      rec: "14:32",
      langPill: "UA",
      lines: [
        { spk: 1, name: "Майя",   time: "00:01:24", text: "Головний інсайт з інтерв’ю — ніхто насправді не хоче переслуховувати запис." },
        { spk: 2, name: "Андрій", time: "00:01:38", text: "Так — люди хочуть просканувати очима. І шукати. Транскрипт — це і є продукт." },
        { spk: 1, name: "Майя",   time: "00:01:52", text: "Саме так. Це й має бути першим рядком на лендингу", live: true },
      ],
      summary: [
        "Переслуховування — не робота; люди скролять і шукають.",
        "Транскрипт — це основний артефакт, не побічний.",
        "На лендингу — фрейм «читай замість слухай».",
      ],
      summaryLabel: "Авто-підсумок · 3 пункти",
      chip: "Підсумок за 8 с",
    },
  },
};
