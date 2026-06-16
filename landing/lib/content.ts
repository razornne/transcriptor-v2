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
  monthly: number;      // долл/мес (при monthly billing)
  annual: number;       // долл/мес при annual billing (умножается на 12 при оплате)
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
    monthly: string;
    annual: string;
    save: string;
    plans: PricingPlan[];
  };
  final: { title: string[]; ctaPrimary: string; ctaSecondary: string; fine: string };
  foot: { links: string[]; copy: string };
  useCases: {
    eyebrow: string;
    title: string;
    sub: string;
    tabs: Array<{
      label: string;
      headline: string;
      points: string[];
      quote: string;
      author: string;
    }>;
  };
  faq: {
    eyebrow: string;
    title: string;
    items: Array<{ q: string; a: string }>;
  };
  mock: {
    url: string;
    eyebrow: string;
    rec: string;
    langPill: string;
    lines: Array<{ spk: 1 | 2; name: string; time: string; text: string; live?: boolean }>;
    summary: string[];
    summaryLabel: string;
  };
};

// Цены — monthly/annual.
// Free $0 · Pro $15→$12 annual · Max $29→$23 annual · Team $14→$11 annual / user
// Дисконт ~20% (плейсхолдер до уточнения от owner)
const PLANS_EN: PricingPlan[] = [
  {
    name: "Free",
    monthly: 0, annual: 0, per: "/forever",
    tagline: "For trying it out",
    features: ["60 minutes / month", "100+ languages", "Inline editing", "Markdown export"],
    cta: "Start free",
    ctaKind: "ghost",
  },
  {
    name: "Pro", featured: true, badge: "Most popular",
    monthly: 15, annual: 12, per: "/month",
    tagline: "For one professional",
    features: ["600 minutes / month", "Speaker separation", "Summary + action items", "Full-text search", "Unlimited history"],
    cta: "Get Pro",
    ctaKind: "primary",
  },
  {
    name: "Max",
    monthly: 29, annual: 23, per: "/month",
    tagline: "For power users",
    features: ["2 000 minutes / month", "Everything in Pro", "Best Quality (Whisper large-v3)", "Higher concurrency", "Early access to new models"],
    cta: "Go Max",
    ctaKind: "ghost",
  },
  {
    name: "Team",
    monthly: 14, annual: 11, per: "/user / month",
    tagline: "For small teams",
    features: ["600 minutes / user", "Shared workspace", "Per-user search", "Billing in one invoice", "Priority support"],
    cta: "Start team trial",
    ctaKind: "ghost",
  },
];

const PLANS_UA: PricingPlan[] = [
  {
    name: "Free",
    monthly: 0, annual: 0, per: "/назавжди",
    tagline: "Спробувати",
    features: ["60 хвилин / місяць", "100+ мов", "Редагування транскрипту", "Експорт у Markdown"],
    cta: "Спробувати безкоштовно",
    ctaKind: "ghost",
  },
  {
    name: "Pro", featured: true, badge: "Найпопулярніший",
    monthly: 15, annual: 12, per: "/місяць",
    tagline: "Для однієї людини",
    features: ["600 хвилин / місяць", "Розділення спікерів", "Підсумок + дії", "Повнотекстовий пошук", "Безлімітна історія"],
    cta: "Обрати Pro",
    ctaKind: "primary",
  },
  {
    name: "Max",
    monthly: 29, annual: 23, per: "/місяць",
    tagline: "Для активних користувачів",
    features: ["2 000 хвилин / місяць", "Все з Pro", "Найкраща якість (Whisper large-v3)", "Більше паралельних обробок", "Ранній доступ до нових моделей"],
    cta: "Обрати Max",
    ctaKind: "ghost",
  },
  {
    name: "Team",
    monthly: 14, annual: 11, per: "/користувач / міс.",
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
      sub: "Strong accuracy across 100+ languages. Speakers separated automatically. Audio processed and deleted — we never store it.",
      ctaPrimary: "Start free",
      ctaSecondary: "See how it works",
      meta: [
        ["Languages",  "100+ languages"],
        ["Retention",  "0 seconds"],
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
      sub: "Open a tab. Allow the mic. Get the transcript right after the call.",
      steps: [
        { n: "01", h: "Open Skriptly",      p: "Go to skriptly.io/app in any modern browser. No installer, no extension, no Electron." },
        { n: "02", h: "Start recording",    p: "Allow mic access, pick the call tab to share audio. Speakers are detected automatically." },
        { n: "03", h: "Get your transcript",p: "Stop the recording — your transcript, summary, and action items are ready in under a minute." },
      ],
    },
    features: {
      eyebrow: "What's inside",
      title: "Everything a transcript should be.",
      sub: "Built for individual professionals who don't want to babysit a recording. Multilingual from day one — 100+ languages, auto-detected.",
      items: [
        { tag: "ML", h: "100+ languages",        p: "Whisper large-v3 supports over a hundred languages. AI correction layer learns your domain terms.", accent: true },
        { tag: "SS", h: "Speaker separation",    p: "pyannote diarization. Knows who said what — even on a phone call with overlap." },
        { tag: "⚡", h: "Fast turnaround",       p: "Stop the recording, get your transcript in under a minute. No waiting room, no manual steps." },
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
      monthly: "Monthly",
      annual: "Annual",
      save: "Save ~20%",
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
    useCases: {
      eyebrow: "Who uses it",
      title: "One tool, every context.",
      sub: "Transcript + speaker attribution + AI synthesis — no matter what you record.",
      tabs: [
        {
          label: "Founders",
          headline: "Every investor call, customer interview, and team standup — searchable.",
          points: [
            "Capture investor questions verbatim — no paraphrasing from memory",
            "Find every mention of a specific pain point across customer calls",
            "Know who committed to what in the last all-hands",
          ],
          quote: "I used to miss half the call while taking notes. Now I'm fully present.",
          author: "CTO, B2B SaaS startup",
        },
        {
          label: "Researchers",
          headline: "Interviews transcribed. Participants named. Patterns findable.",
          points: [
            "Every session verbatim with per-speaker attribution",
            "Search across 40 interviews for a specific phrase",
            "Export clean Markdown for NVivo or direct quoting",
          ],
          quote: "I transcribed a month of fieldwork in one afternoon.",
          author: "UX Researcher, design agency",
        },
        {
          label: "Students",
          headline: "Lectures, seminars, and study groups — word for word.",
          points: [
            "Record lectures and get a searchable transcript instead of notes",
            "Each voice in a group discussion attributed automatically",
            "Zero data retention — recordings never leave your session",
          ],
          quote: "I stopped missing things while writing. The transcript gets everything.",
          author: "Graduate student, linguistics",
        },
        {
          label: "Journalists",
          headline: "Source interviews quoted accurately, attributed correctly.",
          points: [
            "Verbatim quotes ready to paste — no re-listening",
            "Speaker labels survive even noisy phone recordings",
            "Audio deleted after processing — no storage liability",
          ],
          quote: "I can cite a 90-minute interview in minutes, not hours.",
          author: "Investigative reporter, national paper",
        },
        {
          label: "Teams",
          headline: "Shared workspace. Every call, every voice, on record.",
          points: [
            "Shared transcript library across the whole team",
            "Full-text search across all team calls by speaker or topic",
            "Per-user billing, one invoice — no seat minimums",
          ],
          quote: "We stopped asking 'wait, what did we decide on that?'",
          author: "Head of Product, 12-person startup",
        },
      ],
    },
    faq: {
      eyebrow: "FAQ",
      title: "Common questions.",
      items: [
        {
          q: "Is my audio stored anywhere?",
          a: "No. Audio is processed in-memory on our GPU server and deleted within the same request. We have no recording storage — by design. We also don't use your audio for model training.",
        },
        {
          q: "Which languages are supported?",
          a: "Whisper large-v3-turbo supports 100+ languages. Polish, English, Ukrainian, and Russian are all at strong accuracy with an AI correction pass that learns your domain terminology. Language is auto-detected per recording.",
        },
        {
          q: "How accurate is the transcription?",
          a: "Very accurate for clear audio — comparable to professional transcription services. Accuracy depends on audio quality, accents, and speaker overlap. The AI correction layer further improves proper nouns, abbreviations, and domain terms specific to you.",
        },
        {
          q: "How do I cancel my subscription?",
          a: "From the app: Settings → Subscription → Cancel. Cancellation takes effect at the end of the current billing period. No questions asked, no cancellation fee.",
        },
      ],
    },
    mock: {
      url: "skriptly.io/app/c/k3p2-1a",
      eyebrow: "TRANSCRIPT",
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
    },
  },

  ua: {
    nav: { features: "Можливості", pricing: "Тарифи", openApp: "Відкрити застосунок" },
    hero: {
      eyebrow: "Skriptly · v1.0 · GPU-сервер",
      sub: "Висока точність у 100+ мовах. Спікери розділяються автоматично. Аудіо обробляється та видаляється — ми його не зберігаємо.",
      ctaPrimary: "Спробувати безкоштовно",
      ctaSecondary: "Як це працює",
      meta: [
        ["Мови",         "100+ мов"],
        ["Збереження",   "0 секунд"],
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
      sub: "Відкрий вкладку. Дозволь мікрофон. Отримай транскрипт одразу після дзвінка.",
      steps: [
        { n: "01", h: "Відкрий Skriptly",   p: "Заходь на skriptly.io/app у будь-якому сучасному браузері. Ні інсталятора, ні розширення." },
        { n: "02", h: "Почни запис",        p: "Дозволь мікрофон і обери вкладку дзвінка для аудіо. Спікери визначаються автоматично." },
        { n: "03", h: "Отримай транскрипт", p: "Зупини запис — транскрипт, підсумок і тудушки готові менш ніж за хвилину." },
      ],
    },
    features: {
      eyebrow: "Що всередині",
      title: "Все, чим має бути транскрипт.",
      sub: "Для тих, хто не хоче няньчити запис. Багатомовний від початку — 100+ мов, автовизначення.",
      items: [
        { tag: "ML", h: "100+ мов",                p: "Whisper large-v3 підтримує понад сотню мов. AI-корекція вчить твої доменні терміни.", accent: true },
        { tag: "SS", h: "Розділення спікерів",     p: "pyannote-діаризація. Знає, хто що сказав — навіть у телефонному дзвінку з накладаннями." },
        { tag: "⚡", h: "Швидкий результат",       p: "Зупини запис — транскрипт готовий менш ніж за хвилину. Без черги, без ручних кроків." },
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
      monthly: "Помісячно",
      annual: "Річно",
      save: "Економія ~20%",
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
    useCases: {
      eyebrow: "Хто користується",
      title: "Один інструмент — будь-який контекст.",
      sub: "Транскрипт + атрибуція спікерів + AI-синтез — незалежно від того, що ти записуєш.",
      tabs: [
        {
          label: "Засновники",
          headline: "Кожен дзвінок з інвестором, інтерв'ю з клієнтом та стендап — у пошуку.",
          points: [
            "Точні цитати інвесторів — без переказу по пам'яті",
            "Знайди кожне згадування конкретного болю в записах клієнтів",
            "Хто що пообіцяв на останньому all-hands — одразу видно",
          ],
          quote: "Я пропускав половину дзвінка, роблячи нотатки. Тепер я повністю присутній.",
          author: "CTO, B2B SaaS-стартап",
        },
        {
          label: "Дослідники",
          headline: "Інтерв'ю розшифровані. Учасники підписані. Паттерни знаходяться.",
          points: [
            "Кожна сесія дослівно з атрибуцією по спікерах",
            "Пошук по 40 інтерв'ю за конкретною фразою",
            "Чистий Markdown для NVivo або прямих цитат",
          ],
          quote: "Я розшифрував місяць польової роботи за один вечір.",
          author: "UX-дослідник, дизайн-агенція",
        },
        {
          label: "Студенти",
          headline: "Лекції, семінари та навчальні групи — слово в слово.",
          points: [
            "Запиши лекцію й отримай пошуковий транскрипт замість нотаток",
            "Голоси в груповій дискусії атрибутуються автоматично",
            "Нульове збереження — записи не виходять за межі сесії",
          ],
          quote: "Я перестав пропускати слова під час писання. Транскрипт фіксує все.",
          author: "Аспірант, лінгвістика",
        },
        {
          label: "Журналісти",
          headline: "Цитати з джерел — дослівні та правильно атрибутовані.",
          points: [
            "Готові цитати для вставки — без переслуховування",
            "Підписи спікерів збережуться навіть у шумних телефонних записах",
            "Аудіо видаляється після обробки — жодних ризиків зберігання",
          ],
          quote: "Я можу процитувати 90-хвилинне інтерв'ю за хвилини, не за години.",
          author: "Розслідувач, національне видання",
        },
        {
          label: "Команди",
          headline: "Спільний простір. Кожен дзвінок, кожен голос — зафіксований.",
          points: [
            "Спільна бібліотека транскриптів для всієї команди",
            "Повнотекстовий пошук по всіх командних дзвінках за спікером чи темою",
            "Білінг по користувачах, один рахунок — без мінімальних місць",
          ],
          quote: "Ми перестали питати «а що ми вирішили з тим питанням?»",
          author: "Head of Product, стартап 12 людей",
        },
      ],
    },
    faq: {
      eyebrow: "FAQ",
      title: "Часті запитання.",
      items: [
        {
          q: "Чи зберігається моє аудіо?",
          a: "Ні. Аудіо обробляється в пам'яті на GPU-сервері та видаляється в межах того самого запиту. Ми не маємо сховища записів — це принциповий вибір. Також не використовуємо твоє аудіо для навчання моделей.",
        },
        {
          q: "Які мови підтримуються?",
          a: "Whisper large-v3-turbo підтримує 100+ мов. Польська, англійська, українська та російська — з високою точністю, плюс AI-корекція, що вчить твою доменну лексику. Мова визначається автоматично для кожного запису.",
        },
        {
          q: "Наскільки точна транскрипція?",
          a: "Дуже точна для чіткого аудіо — порівняно з професійними сервісами. Точність залежить від якості звуку, акцентів і перекриттів спікерів. Шар AI-корекції додатково покращує власні назви, абревіатури та доменні терміни.",
        },
        {
          q: "Як скасувати підписку?",
          a: "З застосунку: Налаштування → Підписка → Скасувати. Набирає чинності наприкінці поточного розрахункового періоду. Без питань, без комісії за скасування.",
        },
      ],
    },
    mock: {
      url: "skriptly.io/app/c/k3p2-1a",
      eyebrow: "ТРАНСКРИПТ",
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
    },
  },
};
