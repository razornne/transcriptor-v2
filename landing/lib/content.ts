// EN/UA контент для лендинга. Структура зеркалит макет «Landing» (Design-артефакт
// «Skriptly app redesign»): герой с живым транскриптом, диктовка, три способа начать,
// возможности, приложение для компьютера с вейтлистом для Mac, тарифы, FAQ.

export type Lang = "en" | "ua";

export type PricingPlan = {
  name: string;
  featured?: boolean;
  badge?: string;
  monthly: number;      // цена/мес (при monthly billing), в валюте currency
  annual: number;       // цена/мес при annual billing (умножается на 12 при оплате)
  currency: "$" | "₴";  // $ перед числом, ₴ после
  per: string;          // "/month", "/user / month", "/forever"
  tagline: string;
  features: string[];
  cta: string;
  ctaKind: "primary" | "ghost";
  fine?: string;
};

// Фрагмент текста с пометкой «зачёркнуто» — для демо «что вы сказали».
export type Frag = { t: string; x?: boolean };

export type Copy = {
  nav: { features: string; desktop: string; pricing: string; faq: string; openApp: string; openAppShort: string };
  hero: {
    eyebrow: string; titleA: string; titleAccent: string; sub: string;
    ctaPrimary: string; ctaWin: string; ctaMacWait: string;
    note: string; noteMac: string;
  };
  mock: {
    title: string;
    speakers: Array<{ name: string; share: number; tone: 1 | 2 }>;
    suggest: { text: string; quote: string; accept: string };
    lines: Array<{ tone: 1 | 2; name: string; initial: string; time: string; text: string }>;
  };
  facts: string[];
  dictation: {
    eyebrow: string; titleA: string; titleAccent: string; titleB: string;
    subBefore: string; keys: string[]; subAfter: string; keysHint: string;
    sayLabel: string; getLabel: string; say: Frag[]; getBefore: string; getMark: string; getAfter: string;
  };
  ways: {
    eyebrow: string; title: string; sub: string;
    items: Array<{ kind: "call" | "dictate" | "file"; h: string; p: string }>;
  };
  features: {
    eyebrow: string; titleA: string; titleAccent: string;
    items: Array<{ h: string; p: string }>;
  };
  desktop: {
    eyebrow: string; titleA: string; titleAccent: string; sub: string;
    ctaWin: string; macSoon: string; infoDefault: string; infoVersion: string; perks: Array<{ h: string; p: string }>;
    wait: {
      title: string; sub: string; placeholder: string; button: string; sending: string;
      done: string; error: string; privacy: string;
    };
  };
  pricing: {
    eyebrow: string; title: string; sub: string;
    monthly: string; annual: string; save: string;
    plans: PricingPlan[];
  };
  faq: { eyebrow: string; title: string; items: Array<{ q: string; a: string }> };
  final: { titleA: string; titleAccent: string; ctaPrimary: string; ctaWin: string; fine: string };
  foot: { links: Array<{ label: string; href: string }>; copy: string };
};

// Тарифы v2 (2026-09-25), совпадают с Stripe (USD + UAH currency_options):
// Free · Pro $12 ($9 за год) / 249 ₴ (2 390 ₴ за год ≈ 199) ·
// Team $14 ($11) / 229 ₴ (2 190 ₴ за год ≈ 183) за место.
// UA-версия показывает гривны: Checkout сам берёт ₴ с покупателей из Украины.
const PLANS_EN: PricingPlan[] = [
  {
    name: "Free",
    monthly: 0, annual: 0, currency: "$", per: "/forever",
    tagline: "For trying it out",
    features: ["60 minutes of calls / month", "Speaker separation", "1 hour of dictation / month", "Last 5 recordings", "Markdown export"],
    cta: "Start free",
    ctaKind: "ghost",
  },
  {
    name: "Pro", featured: true, badge: "Most popular",
    monthly: 12, annual: 9, currency: "$", per: "/month",
    tagline: "For one professional",
    features: ["600 minutes of calls / month", "Summary + action items", "Unlimited dictation (desktop app)", "Full-text search", "Unlimited history"],
    cta: "Get Pro",
    ctaKind: "primary",
    fine: "Paying from Ukraine? 249 ₴ / month.",
  },
  {
    name: "Team",
    monthly: 14, annual: 11, currency: "$", per: "/user / month",
    tagline: "For small teams",
    features: ["Everything in Pro", "600 minutes per user in one team pool", "Shared workspace", "One invoice for the team"],
    cta: "Set up a team",
    ctaKind: "ghost",
    fine: "From 2 seats.",
  },
];

const PLANS_UA: PricingPlan[] = [
  {
    name: "Free",
    monthly: 0, annual: 0, currency: "₴", per: "/назавжди",
    tagline: "Спробувати",
    features: ["60 хвилин дзвінків / місяць", "Розділення спікерів", "1 година диктовки / місяць", "Останні 5 записів", "Експорт у Markdown"],
    cta: "Спробувати безкоштовно",
    ctaKind: "ghost",
  },
  {
    name: "Pro", featured: true, badge: "Найпопулярніший",
    monthly: 249, annual: 199, currency: "₴", per: "/місяць",
    tagline: "Для однієї людини",
    features: ["600 хвилин дзвінків / місяць", "Підсумок + дії", "Диктовка без ліміту (застосунок для комп’ютера)", "Повнотекстовий пошук", "Безлімітна історія"],
    cta: "Обрати Pro",
    ctaKind: "primary",
    fine: "Ціна в гривнях — для оплати з України.",
  },
  {
    name: "Team",
    monthly: 229, annual: 183, currency: "₴", per: "/користувач / міс.",
    tagline: "Для малих команд",
    features: ["Усе з Pro", "600 хвилин на користувача в спільному пулі", "Спільний робочий простір", "Один рахунок на команду"],
    cta: "Створити команду",
    ctaKind: "ghost",
    fine: "Від 2 місць.",
  },
];

export const COPY: Record<Lang, Copy> = {
  en: {
    nav: { features: "Features", desktop: "Desktop app", pricing: "Pricing", faq: "FAQ", openApp: "Open app", openAppShort: "Open" },
    hero: {
      eyebrow: "Calls & dictation",
      titleA: "Every call,",
      titleAccent: "word for word.",
      sub: "Record a call and get the transcript with every speaker named. Or hold a key, talk, and clean text lands in any app.",
      ctaPrimary: "Start free",
      ctaWin: "Download for Windows",
      ctaMacWait: "Join the Mac waitlist",
      note: "A Mac version is next. It also works in any browser, no install needed.",
      noteMac: "The Mac app is coming. Meanwhile it works in any browser, no install needed.",
    },
    mock: {
      title: "Product sync · 40:33",
      speakers: [
        { name: "Maya", share: 46, tone: 1 },
        { name: "Andriy", share: 40, tone: 2 },
      ],
      suggest: { text: "Speaker 2 → Andriy?", quote: "“Thanks, Andriy” at 0:38", accept: "Accept" },
      lines: [
        { tone: 1, name: "Maya", initial: "M", time: "1:24", text: "The key insight from the interviews: nobody actually wants to re-listen to a recording." },
        { tone: 2, name: "Andriy", initial: "A", time: "1:38", text: "Right. They want to skim and search. The transcript is the product." },
      ],
    },
    facts: ["60+ languages", "Speakers named", "Windows app · Mac soon", "USD or UAH", "Markdown / TXT export"],
    dictation: {
      eyebrow: "Dictation",
      titleA: "Say it", titleAccent: "messy", titleB: "Get it clean.",
      subBefore: "Hold ", keys: ["Ctrl", "Win"], subAfter: " in any app, talk, let go. Skriptly removes the “um”s, applies your self-corrections and types the result where your cursor is.",
      keysHint: "your keys, your choice",
      sayLabel: "What you say", getLabel: "What you get",
      say: [
        { t: "um, so basically,", x: true }, { t: " we need to send the" }, { t: ", uh, the", x: true },
        { t: " report by " }, { t: "Friday, no wait,", x: true }, { t: " Thursday" },
      ],
      getBefore: "We need to send the report by ", getMark: "Thursday", getAfter: ".",
    },
    ways: {
      eyebrow: "How it works",
      title: "Three ways in.",
      sub: "Use the app, the browser, or just your voice. The transcript always lands in the same place.",
      items: [
        { kind: "call", h: "Record a call", p: "Your microphone plus the sound from Zoom, Meet or Teams. In the desktop app there is nothing to share or set up." },
        { kind: "dictate", h: "Dictate anywhere", p: "Hold a key and talk. Email, chat, a doc: the text appears in whatever app has your cursor." },
        { kind: "file", h: "Drop a file", p: "A voice memo, a meeting video, an export. Any audio or video, hours long, in any browser." },
      ],
    },
    features: {
      eyebrow: "What's inside",
      titleA: "Everything a transcript", titleAccent: "should be.",
      items: [
        { h: "60+ languages", p: "Switch languages mid-call and it keeps up. Your own terms are learned and spelled right next time." },
        { h: "Speakers, with names", p: "Every voice separated. You are labelled automatically, and names said in the conversation are suggested for the rest." },
        { h: "Summary and action items", p: "Written right after the call, in the depth you choose. Send to Notion or export as Markdown." },
        { h: "Dictation that cleans up", p: "Filler words gone, self-corrections applied, in any app. Pauses your music while you talk." },
        { h: "Search every call", p: "Find who said what across your whole history. Projects keep clients and topics apart." },
        { h: "Private by default", p: "Transcripts are yours alone unless you share a workspace. Your audio never trains AI models." },
      ],
    },
    desktop: {
      eyebrow: "Desktop app",
      titleA: "Lives in your tray.", titleAccent: "Always one key away.",
      sub: "The whole Skriptly in its own window, plus what a browser can't do: dictate into any app and record both sides of a call with no tab sharing.",
      ctaWin: "Download for Windows",
      macSoon: "macOS · coming soon",
      infoDefault: "Windows 10 and 11 · free plan included",
      infoVersion: "Windows 10 and 11 · v{v} · {mb} MB",
      perks: [
        { h: "Hold to dictate", p: "Release to paste where your cursor is. Hands-free mode too." },
        { h: "Record a call", p: "Microphone and everything your computer plays. You are labelled for you." },
        { h: "One account everywhere", p: "History, summaries and settings are the same in the app and in the browser." },
      ],
      wait: {
        title: "Want it on your Mac?",
        sub: "Leave your email and we'll write once, when the Mac app is ready.",
        placeholder: "you@work.com", button: "Notify me", sending: "Sending…",
        done: "You're on the list. We'll email you when the Mac app is ready.",
        error: "Couldn't save that. Check the address and try again.",
        privacy: "Used only for this one email.",
      },
    },
    pricing: {
      eyebrow: "Pricing",
      title: "Honest pricing.",
      sub: "Start on Free. Upgrade when you outgrow it. Cancel from the app in two clicks.",
      monthly: "Monthly",
      annual: "Annual",
      save: "Save up to 25%",
      plans: PLANS_EN,
    },
    faq: {
      eyebrow: "FAQ",
      title: "Common questions",
      items: [
        {
          q: "Do I need the desktop app?",
          a: "No. Skriptly works in any browser: record a tab, or upload a file. The desktop app adds dictation into any app and call recording without sharing a tab, and it uses the same account and history.",
        },
        {
          q: "Why does Windows warn me when I install?",
          a: "The installer isn't code-signed yet, so Windows SmartScreen shows “Windows protected your PC”. Click More info, then Run anyway. We'll sign it before the public launch.",
        },
        {
          q: "When is the Mac version coming?",
          a: "It is in progress. Join the waitlist in the Desktop app section and we'll email you once when it is ready.",
        },
        {
          q: "Is my audio stored anywhere?",
          a: "We keep a copy of each recording for 90 days so we can investigate transcription errors, then it is deleted automatically. Only the founder can access it, and it is never used to train AI models or shared. Deleting your account deletes it immediately. Details are in the Privacy Policy.",
        },
        {
          q: "Which languages are supported?",
          a: "Transcription recognizes 60+ languages and detects the language automatically, even when people switch mid-call. Ukrainian, Russian, English, Polish and Czech can also be picked explicitly, and an AI correction pass learns your domain terms.",
        },
        {
          q: "How accurate is the transcription?",
          a: "Very accurate for clear audio, comparable to professional transcription services. Accuracy depends on audio quality, accents, and speaker overlap. The AI correction layer further improves proper nouns, abbreviations, and domain terms specific to you.",
        },
        {
          q: "How do I cancel my subscription?",
          a: "From the app: Settings → Plan and billing → Manage subscription. Cancellation takes effect at the end of the current billing period. No questions asked, no cancellation fee.",
        },
      ],
    },
    final: {
      titleA: "Ready to stop", titleAccent: "re-listening?",
      ctaPrimary: "Start free",
      ctaWin: "Download for Windows",
      fine: "Free forever for 60 min / month. No card needed.",
    },
    foot: {
      links: [
        { label: "Features", href: "#features" }, { label: "Desktop", href: "#desktop" }, { label: "Pricing", href: "#pricing" },
        { label: "Privacy", href: "/privacy" }, { label: "Terms", href: "/terms" },
      ],
      copy: "Skriptly · built in Kyiv",
    },
  },

  ua: {
    nav: { features: "Можливості", desktop: "Застосунок", pricing: "Тарифи", faq: "FAQ", openApp: "Відкрити застосунок", openAppShort: "Відкрити" },
    hero: {
      eyebrow: "Дзвінки й диктовка",
      titleA: "Кожен дзвінок,",
      titleAccent: "слово в слово.",
      sub: "Запиши дзвінок і отримай транскрипт з іменами всіх спікерів. Або затисни клавішу, говори, і чистий текст з’явиться в будь-якому застосунку.",
      ctaPrimary: "Спробувати безкоштовно",
      ctaWin: "Завантажити для Windows",
      ctaMacWait: "У список очікування Mac",
      note: "Версія для Mac уже в роботі. Працює й у будь-якому браузері, без встановлення.",
      noteMac: "Застосунок для Mac скоро. А поки все працює в будь-якому браузері, без встановлення.",
    },
    mock: {
      title: "Синк по продукту · 40:33",
      speakers: [
        { name: "Майя", share: 46, tone: 1 },
        { name: "Андрій", share: 40, tone: 2 },
      ],
      suggest: { text: "Спікер 2 → Андрій?", quote: "«Дякую, Андрію» на 0:38", accept: "Прийняти" },
      lines: [
        { tone: 1, name: "Майя", initial: "М", time: "1:24", text: "Головний інсайт з інтерв’ю: ніхто насправді не хоче переслуховувати запис." },
        { tone: 2, name: "Андрій", initial: "А", time: "1:38", text: "Так. Люди хочуть переглянути очима й пошукати. Транскрипт і є продукт." },
      ],
    },
    facts: ["60+ мов", "Спікери з іменами", "Windows · Mac скоро", "USD або UAH", "Експорт Markdown / TXT"],
    dictation: {
      eyebrow: "Диктовка",
      titleA: "Кажи", titleAccent: "як вийде", titleB: "Отримуй чисто.",
      subBefore: "Затисни ", keys: ["Ctrl", "Win"], subAfter: " у будь-якому застосунку, говори, відпусти. Skriptly прибере «ну», «е-е», врахує самовиправлення і надрукує результат там, де курсор.",
      keysHint: "клавіші — на твій вибір",
      sayLabel: "Що ти кажеш", getLabel: "Що отримуєш",
      say: [
        { t: "ну, значить, загалом,", x: true }, { t: " нам треба надіслати" }, { t: ", е-е, той", x: true },
        { t: " звіт до " }, { t: "п’ятниці, ні, стривай,", x: true }, { t: " четверга" },
      ],
      getBefore: "Нам треба надіслати звіт до ", getMark: "четверга", getAfter: ".",
    },
    ways: {
      eyebrow: "Як це працює",
      title: "Три способи почати.",
      sub: "Застосунок, браузер або просто голос. Транскрипт завжди потрапляє в одне місце.",
      items: [
        { kind: "call", h: "Записати дзвінок", p: "Твій мікрофон плюс звук із Zoom, Meet чи Teams. У застосунку для комп’ютера нічого не треба розшарювати чи налаштовувати." },
        { kind: "dictate", h: "Диктувати де завгодно", p: "Затисни клавішу й говори. Лист, чат, документ: текст з’явиться в тому застосунку, де курсор." },
        { kind: "file", h: "Завантажити файл", p: "Голосове, відео зустрічі, експорт. Будь-яке аудіо чи відео, хоч на години, у будь-якому браузері." },
      ],
    },
    features: {
      eyebrow: "Що всередині",
      titleA: "Усе, чим має бути", titleAccent: "транскрипт.",
      items: [
        { h: "60+ мов", p: "Перемикайся між мовами посеред дзвінка, система встигає. Твої терміни запам’ятовуються й наступного разу пишуться правильно." },
        { h: "Спікери з іменами", p: "Кожен голос окремо. Тебе позначено автоматично, а імена, які прозвучали в розмові, пропонуються для решти." },
        { h: "Підсумок і задачі", p: "Одразу після дзвінка, з потрібною глибиною. Надішли в Notion або експортуй у Markdown." },
        { h: "Диктовка, що чистить текст", p: "Без слів-паразитів, зі самовиправленнями, у будь-якому застосунку. Ставить музику на паузу, поки ти говориш." },
        { h: "Пошук по всіх дзвінках", p: "Знайди, хто що казав, у всій історії. Проєкти розділяють клієнтів і теми." },
        { h: "Приватно за замовчуванням", p: "Транскрипти бачиш лише ти, поки не поділишся робочим простором. Твоє аудіо ніколи не навчає AI-моделі." },
      ],
    },
    desktop: {
      eyebrow: "Застосунок для комп’ютера",
      titleA: "Живе в треї.", titleAccent: "Завжди за одну клавішу.",
      sub: "Увесь Skriptly у власному вікні, плюс те, що не вміє браузер: диктовка в будь-який застосунок і запис обох сторін дзвінка без розшарювання вкладки.",
      ctaWin: "Завантажити для Windows",
      macSoon: "macOS · скоро",
      infoDefault: "Windows 10 і 11 · безкоштовний тариф підходить",
      infoVersion: "Windows 10 і 11 · v{v} · {mb} МБ",
      perks: [
        { h: "Затисни й диктуй", p: "Відпусти, і текст вставиться там, де курсор. Є й режим без утримання." },
        { h: "Запис дзвінка", p: "Мікрофон і все, що грає комп’ютер. Тебе в розмові позначено автоматично." },
        { h: "Один акаунт скрізь", p: "Історія, підсумки й налаштування однакові в застосунку та в браузері." },
      ],
      wait: {
        title: "Хочеш на Mac?",
        sub: "Залиш пошту, і ми напишемо один раз, коли застосунок для Mac буде готовий.",
        placeholder: "you@work.com", button: "Повідомте мене", sending: "Надсилаю…",
        done: "Ти у списку. Напишемо, коли застосунок для Mac буде готовий.",
        error: "Не вдалося зберегти. Перевір адресу й спробуй ще раз.",
        privacy: "Адреса потрібна лише для цього одного листа.",
      },
    },
    pricing: {
      eyebrow: "Тарифи",
      title: "Чесні тарифи.",
      sub: "Почни з Free. Перейди далі, коли переростеш. Скасування — у два кліки із застосунку.",
      monthly: "Помісячно",
      annual: "Річно",
      save: "Економія до 25%",
      plans: PLANS_UA,
    },
    faq: {
      eyebrow: "FAQ",
      title: "Часті запитання",
      items: [
        {
          q: "Чи потрібен застосунок для комп’ютера?",
          a: "Ні. Skriptly працює в будь-якому браузері: запиши вкладку або завантаж файл. Застосунок додає диктовку в будь-яку програму та запис дзвінків без розшарювання вкладки; акаунт і історія спільні.",
        },
        {
          q: "Чому Windows попереджає під час встановлення?",
          a: "Інсталятор поки без цифрового підпису, тому SmartScreen показує «Windows захистив ваш ПК». Натисни «Докладніше», потім «Усе одно виконати». Ми підпишемо його до публічного запуску.",
        },
        {
          q: "Коли буде версія для Mac?",
          a: "Вона в роботі. Залиш пошту в розділі застосунку, і ми один раз напишемо, коли вона буде готова.",
        },
        {
          q: "Чи зберігається моє аудіо?",
          a: "Копію кожного запису ми зберігаємо 90 днів, щоб розбирати помилки транскрипції, після чого вона видаляється автоматично. Доступ має лише засновник, аудіо ніколи не використовується для навчання AI і нікому не передається. Видалення акаунта видаляє його одразу. Деталі — в Політиці конфіденційності.",
        },
        {
          q: "Які мови підтримуються?",
          a: "Транскрипція розпізнає 60+ мов і визначає мову автоматично, навіть якщо співрозмовники перемикаються посеред дзвінка. Українську, російську, англійську, польську та чеську можна вибрати явно, а AI-корекція вчить твою доменну лексику.",
        },
        {
          q: "Наскільки точна транскрипція?",
          a: "Дуже точна для чіткого аудіо, порівняно з професійними сервісами. Точність залежить від якості звуку, акцентів і перекриттів спікерів. Шар AI-корекції додатково покращує власні назви, абревіатури та доменні терміни.",
        },
        {
          q: "Як скасувати підписку?",
          a: "У застосунку: Налаштування → Тариф і оплата → Керувати підпискою. Набирає чинності наприкінці поточного розрахункового періоду. Без питань, без комісії за скасування.",
        },
      ],
    },
    final: {
      titleA: "Час припинити", titleAccent: "переслуховувати?",
      ctaPrimary: "Спробувати безкоштовно",
      ctaWin: "Завантажити для Windows",
      fine: "Безкоштовно назавжди: 60 хв / міс. Без картки.",
    },
    foot: {
      links: [
        { label: "Можливості", href: "#features" }, { label: "Застосунок", href: "#desktop" }, { label: "Тарифи", href: "#pricing" },
        { label: "Конфіденційність", href: "/privacy" }, { label: "Умови", href: "/terms" },
      ],
      copy: "Skriptly · зроблено в Києві",
    },
  },
};
