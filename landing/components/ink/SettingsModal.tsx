"use client";
import { useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import type { Profile, WorkspaceInfo, VocabTerm } from "@/lib/ink/api";
import {
  saveVocabulary, StripeCustomerInvalidError,
  createWorkspace as apiCreateWorkspace,
  inviteMember as apiInviteMember,
  removeMember as apiRemoveMember,
  leaveWorkspace as apiLeaveWorkspace,
  createStripeCheckout, createStripePortal,
  notionOAuthStart, notionDisconnect as apiNotionDisconnect,
  deleteAccount as apiDeleteAccount,
} from "@/lib/ink/api";
import { sb } from "@/lib/ink/supabase";
import { saveSettings, type InkSettings } from "@/lib/ink/settings";
import { SUPPORTED_LANGUAGES } from "@/lib/ink/config";

type NavSection = "account" | "subscription" | "workspace" | "integrations" | "settings" | "invite" | "danger";
type Lang = "en" | "ua";

// ── i18n dictionary ────────────────────────────────────────────────────────
// Every visible string in this modal resolves through `t = DICT[uiLang]`. Mirror
// of the pattern used in InkSidebar.tsx so the whole app shares one convention.
const DICT = {
  en: {
    title: "Settings",
    nav: {
      account: "Account", subscription: "Subscription", workspace: "Workspace",
      integrations: "Integrations", settings: "Settings",
      invite: "Invite friends", danger: "Danger zone",
    },
    // Account
    account: "Account", planSuffix: "plan", usageMonth: "Usage this month",
    signOut: "Sign out",
    // Subscription
    yourPlan: "Your plan", currentPlan: "CURRENT PLAN",
    upgrade: "Upgrade →", redirecting: "Redirecting…",
    downgrade: "Downgrade", opening: "Opening…",
    billingErrFallback: "Could not open billing portal.",
    monthly: "Monthly", annual: "Yearly", annualSave: "save up to 25%",
    setUpTeam: "Set up team →", manageInWorkspace: "Billing is managed in Workspace",
    priceNote: "Prices in USD. Paying from Ukraine? Checkout shows hryvnias (Pro — 249 ₴ / mo).",
    dictation: "Dictation", unlimited: "unlimited", teamPool: "team pool",
    // Workspace — empty state
    wsEmptyTitle: "Create a workspace",
    wsEmptyBody: "Share transcripts with teammates and collaborate together.",
    wsNamePlaceholder: "Workspace name",
    wsCreateBtn: "Create workspace",
    wsUpgradeCreate: "Upgrade to Team & Create",
    wsCreating: "Creating…",
    wsRedirecting: "Redirecting…",
    wsUpgradeNote: "$14 / seat / mo ($11 billed yearly) · 600 min per seat in one team pool · shared history. Your workspace is created automatically right after checkout.",
    // Workspace — manage
    wsTitle: "Workspace",
    wsInviteByEmail: "Invite by email",
    wsInvitePlaceholder: "teammate@company.com",
    wsInvite: "Invite", wsInviteSent: "Sent ✓",
    wsMembers: "Members",
    wsNoMembers: "No members yet — invite your team above.",
    wsInvited: "invited", wsRemove: "Remove",
    wsLeave: "Leave workspace", wsLeaving: "Leaving…",
    wsLeaveConfirm: "Leave the workspace? You will lose access to shared recordings.",
    // Settings pane
    recDefaults: "Recording defaults",
    fieldLanguage: "Language", fieldSpeakers: "Speakers", auto: "Auto",
    appearance: "Appearance", theme: "Theme", light: "Light", dark: "Dark",
    interfaceLanguage: "Interface language",
    // Integrations
    integrationsTitle: "Integrations",
    notionTitle: "Notion",
    notionConnected: "Notion connected",
    notionWorkspaceFallback: "Connected workspace",
    notionConnectDesc: "Send transcripts, summaries and action items straight to a Notion page.",
    notionConnect: "Connect Notion Workspace",
    notionConnecting: "Connecting…",
    notionDisconnect: "Disconnect Notion",
    notionDisconnecting: "Disconnecting…",
    notionErrorFallback: "Notion request failed.",
    // Invite
    referTitle: "Refer a friend",
    referBody: "Share your referral link — you both get +60 min when they subscribe.",
    copy: "Copy", copied: "Copied!", loadingRef: "Loading referral link…",
    // Danger zone
    dangerTitle: "Danger zone",
    signOutSub: "You will need to sign in again to access your recordings.",
    delTitle: "Delete account",
    delDesc: "Permanent deletion of your account, recording history, and all associated data without recovery.",
    delBtn: "Delete account",
    delConfirm: "Confirm deletion?",
    delDeleting: "Deleting…",
    delAutoCancel: "Click again to confirm. Cancels automatically in 3s.",
  },
  ua: {
    title: "Налаштування",
    nav: {
      account: "Акаунт", subscription: "Підписка", workspace: "Воркспейс",
      integrations: "Інтеграції", settings: "Налаштування",
      invite: "Запросити друзів", danger: "Небезпечна зона",
    },
    // Account
    account: "Акаунт", planSuffix: "план", usageMonth: "Використання цього місяця",
    signOut: "Вийти",
    // Subscription
    yourPlan: "Ваш план", currentPlan: "ПОТОЧНИЙ ПЛАН",
    upgrade: "Оновити →", redirecting: "Перенаправлення…",
    downgrade: "Понизити", opening: "Відкриваємо…",
    billingErrFallback: "Не вдалося відкрити портал оплати.",
    monthly: "Щомісяця", annual: "Щороку", annualSave: "−20%",
    setUpTeam: "Створити команду →", manageInWorkspace: "Оплатою керує власник у «Воркспейсі»",
    priceNote: "Ціни в гривнях — для оплати з України. В інших країнах оплата в доларах (Pro — $12 / міс).",
    dictation: "Диктовка", unlimited: "без ліміту", teamPool: "пул команди",
    // Workspace — empty state
    wsEmptyTitle: "Створіть командний простір",
    wsEmptyBody: "Діліться транскриптами з колегами та працюйте разом.",
    wsNamePlaceholder: "Назва воркспейсу",
    wsCreateBtn: "Створити воркспейс",
    wsUpgradeCreate: "Оновити до Team і створити",
    wsCreating: "Створення…",
    wsRedirecting: "Перенаправлення…",
    wsUpgradeNote: "229 ₴ / місце / міс · 600 хв на місце в спільному пулі команди · спільна історія. Ваш воркспейс буде створено автоматично одразу після оплати.",
    // Workspace — manage
    wsTitle: "Воркспейс",
    wsInviteByEmail: "Запросити за email",
    wsInvitePlaceholder: "colega@company.com",
    wsInvite: "Запросити", wsInviteSent: "Надіслано ✓",
    wsMembers: "Учасники",
    wsNoMembers: "Ще немає учасників — запросіть команду вище.",
    wsInvited: "запрошено", wsRemove: "Прибрати",
    wsLeave: "Покинути воркспейс", wsLeaving: "Виходимо…",
    wsLeaveConfirm: "Покинути воркспейс? Ви втратите доступ до спільних записів.",
    // Settings pane
    recDefaults: "Налаштування запису",
    fieldLanguage: "Мова", fieldSpeakers: "Спікери", auto: "Авто",
    appearance: "Вигляд", theme: "Тема", light: "Світла", dark: "Темна",
    interfaceLanguage: "Мова інтерфейсу",
    // Integrations
    integrationsTitle: "Інтеграції",
    notionTitle: "Notion",
    notionConnected: "Notion підключено",
    notionWorkspaceFallback: "Підключений простір",
    notionConnectDesc: "Надсилайте транскрипти, підсумки та завдання прямо на сторінку Notion.",
    notionConnect: "Підключити Notion",
    notionConnecting: "Підключення…",
    notionDisconnect: "Відключити Notion",
    notionDisconnecting: "Відключення…",
    notionErrorFallback: "Помилка запиту до Notion.",
    // Invite
    referTitle: "Запросіть друга",
    referBody: "Поділіться реферальним посиланням — ви обидва отримаєте +60 хв, коли друг оформить підписку.",
    copy: "Копіювати", copied: "Скопійовано!", loadingRef: "Завантаження посилання…",
    // Danger zone
    dangerTitle: "Небезпечна зона",
    signOutSub: "Вам потрібно буде увійти знову, щоб отримати доступ до записів.",
    delTitle: "Видалити акаунт",
    delDesc: "Повне видалення вашого акаунту, історії записів та всіх пов'язаних даних без можливості відновлення.",
    delBtn: "Видалити акаунт",
    delConfirm: "Підтвердити видалення?",
    delDeleting: "Видалення…",
    delAutoCancel: "Натисніть ще раз для підтвердження. Скасується автоматично через 3 с.",
  },
} as const;

// Тарифы v2 (2026-09-25). Цены — как в Stripe: USD с UAH currency_options,
// Checkout сам показывает гривны покупателям из Украины. В гривнях за год:
// Pro 2 390 ₴ (≈ 199 ₴/міс), Team 2 190 ₴ за місце (≈ 183 ₴/міс).
type Billing = "monthly" | "annual";
type PlanId = "free" | "pro" | "team";
const PLAN_ORDER: PlanId[] = ["free", "pro", "team"];

function planCards(lang: Lang, billing: Billing) {
  const yearly = billing === "annual";
  if (lang === "ua") {
    return [
      { id: "free" as const, name: "Free", price: "0 ₴", period: "назавжди", minutes: "60 хв дзвінків / міс",
        features: ["Розділення за спікерами", "1 год диктовки / міс", "Останні 5 записів"] },
      { id: "pro" as const, name: "Pro", price: yearly ? "199 ₴" : "249 ₴",
        period: yearly ? "/ міс, 2 390 ₴ на рік" : "/ міс", minutes: "600 хв дзвінків / міс",
        features: ["Усе з Free", "AI-підсумок і задачі", "Диктовка без ліміту", "Уся історія"] },
      { id: "team" as const, name: "Team", price: yearly ? "183 ₴" : "229 ₴",
        period: yearly ? "/ місце / міс, щороку" : "/ місце / міс", minutes: "600 хв на місце, спільний пул",
        features: ["Усе з Pro", "Спільний воркспейс", "Один рахунок на команду"] },
    ];
  }
  return [
    { id: "free" as const, name: "Free", price: "$0", period: "forever", minutes: "60 min of calls / mo",
      features: ["Speaker labels", "1 h of dictation / mo", "Last 5 recordings"] },
    { id: "pro" as const, name: "Pro", price: yearly ? "$9" : "$12",
      period: yearly ? "/mo, billed yearly" : "/mo", minutes: "600 min of calls / mo",
      features: ["Everything in Free", "AI summary & action items", "Unlimited dictation", "Unlimited history"] },
    { id: "team" as const, name: "Team", price: yearly ? "$11" : "$14",
      period: yearly ? "/seat/mo, billed yearly" : "/seat/mo", minutes: "600 min per seat, shared pool",
      features: ["Everything in Pro", "Shared workspace", "One invoice for the team"] },
  ];
}

// Shared smooth theme helper — dispatches event so InkThemeToggle stays in sync
function applyThemeSmooth(next: "light" | "dark") {
  const doApply = () => {
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("skriptly-theme", next); } catch {}
    document.dispatchEvent(new CustomEvent("ink-theme-toggle"));
  };
  if ("startViewTransition" in document) {
    (document as Document & { startViewTransition(cb: () => void): void }).startViewTransition(doApply);
  } else {
    doApply();
  }
}

function Toggle({
  checked, onChange, disabled, id,
}: {
  checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; id: string;
}) {
  return (
    <label className="i-toggle" htmlFor={id}>
      <input id={id} type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="i-toggle-track" />
      <span className="i-toggle-thumb" />
    </label>
  );
}

function NavIcon({ id }: { id: NavSection }) {
  const p = {
    width: 14, height: 14, viewBox: "0 0 24 24",
    fill: "none", stroke: "currentColor", strokeWidth: 1.7,
    strokeLinecap: "round" as const, strokeLinejoin: "round" as const,
  };
  switch (id) {
    case "account":
      return <svg {...p}><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>;
    case "subscription":
      return <svg {...p}><rect x="1" y="4" width="22" height="16" rx="2"/><path d="M1 10h22"/></svg>;
    case "workspace":
      return <svg {...p}><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>;
    case "integrations":
      return <svg {...p}><path d="M10.59 13.41a2 2 0 0 0 2.83 0l3.59-3.59a2 2 0 0 0 0-2.83l-1-1a2 2 0 0 0-2.83 0l-.59.59"/><path d="M13.41 10.59a2 2 0 0 0-2.83 0l-3.59 3.59a2 2 0 0 0 0 2.83l1 1a2 2 0 0 0 2.83 0l.59-.59"/></svg>;
    case "settings":
      return <svg {...p}><path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/></svg>;
    case "invite":
      return <svg {...p}><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>;
    case "danger":
      return <svg {...p}><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>;
  }
}

const NAV_ORDER: NavSection[] = ["account", "subscription", "workspace", "integrations", "settings", "invite", "danger"];

export function SettingsModal({
  session, profile, settings, onSettingsChange, onClose, onSignOut,
  workspace, onWorkspaceChange,
  uiLang = "en", onUiLangChange,
  initialSection = "account",
}: {
  session: Session;
  profile: Profile | null;
  settings: InkSettings;
  onSettingsChange: (patch: Partial<InkSettings>) => void;
  onClose: () => void;
  onSignOut: () => void;
  workspace?: WorkspaceInfo | null;
  onWorkspaceChange?: (ws: WorkspaceInfo | null) => void;
  uiLang?: Lang;
  onUiLangChange?: (lang: Lang) => void;
  initialSection?: NavSection;
}) {
  const t = DICT[uiLang] ?? DICT.en;
  const [nav, setNav] = useState<NavSection>(initialSection);
  const plan = profile?.plan || "free";
  const [billing, setBilling] = useState<Billing>("monthly");

  // ── Fix 2: Stripe — separate upgrade vs. downgrade flows ──────────
  // Upgrade: createStripeCheckout → new subscription (Checkout Session)
  // Downgrade: createStripePortal → Stripe Customer Portal (cancel/switch)
  const [checkoutPlan, setCheckoutPlan] = useState<string | null>(null);
  const [loadingPortal, setLoadingPortal] = useState(false);
  const [billingError, setBillingError] = useState("");

  const startCheckout = async (targetPlan: "pro") => {
    if (checkoutPlan || loadingPortal) return;
    setCheckoutPlan(targetPlan); setBillingError("");
    try {
      const url = await createStripeCheckout(targetPlan, billing);
      window.location.href = url;
    } catch (e) {
      setBillingError(e instanceof Error ? e.message : "Checkout failed.");
      setCheckoutPlan(null);
    }
  };

  // All downgrade / plan-management actions → Stripe Customer Portal.
  // On failure we surface a toast and reset the loader so the UI never hangs.
  const openPortal = async () => {
    if (loadingPortal || checkoutPlan) return;
    setLoadingPortal(true); setBillingError("");
    try {
      const url = await createStripePortal();
      window.location.href = url;
    } catch (e) {
      // Stored customer was invalid (e.g. test cus_ under a live key). The backend
      // already wiped it; restart Checkout for the current paid plan so a fresh,
      // valid customer is created. Free users just see the message.
      if (e instanceof StripeCustomerInvalidError) {
        if (plan === "pro") {
          try {
            const url = await createStripeCheckout(plan, billing);
            window.location.href = url;
            return;
          } catch { /* fall through to toast */ }
        }
        setBillingError(e.message);
        setLoadingPortal(false);
        return;
      }
      setBillingError(e instanceof Error ? e.message : t.billingErrFallback);
      setLoadingPortal(false);
    }
  };

  // ── Notion integration (Integrations tab) ────────────────────────
  const [notionConnectedLocal, setNotionConnectedLocal] = useState<boolean>(!!profile?.notion_connected);
  const [notionBusy, setNotionBusy] = useState<"connect" | "disconnect" | null>(null);
  const [notionError, setNotionError] = useState("");
  useEffect(() => { setNotionConnectedLocal(!!profile?.notion_connected); }, [profile?.notion_connected]);

  const handleNotionConnect = async () => {
    if (notionBusy) return;
    setNotionBusy("connect"); setNotionError("");
    try {
      const url = await notionOAuthStart();
      window.location.href = url;   // full-page OAuth redirect
    } catch (e) {
      setNotionError(e instanceof Error ? e.message : t.notionErrorFallback);
      setNotionBusy(null);
    }
  };

  const handleNotionDisconnect = async () => {
    if (notionBusy) return;
    setNotionBusy("disconnect"); setNotionError("");
    try {
      await apiNotionDisconnect();
      setNotionConnectedLocal(false);   // optimistic — profile refreshes on next load
    } catch (e) {
      setNotionError(e instanceof Error ? e.message : t.notionErrorFallback);
    } finally {
      setNotionBusy(null);
    }
  };

  // Strict workspace validity: must have a real id
  const hasValidWorkspace = !!(workspace?.id);

  // Vocabulary
  const VOCAB_TOP = 10;
  const [vocab, setVocab] = useState<VocabTerm[]>(() =>
    [...(profile?.vocabulary || [])].sort((a, b) => b.freq - a.freq)
  );
  const [vocabInput, setVocabInput] = useState("");
  const [showAllVocab, setShowAllVocab] = useState(false);

  const vocabSave = async (next: VocabTerm[]) => {
    setVocab(next);
    try { await saveVocabulary(next); } catch { /* best-effort */ }
  };
  const vocabDelete = (term: string) => vocabSave(vocab.filter((v) => v.term !== term));
  const vocabAdd = () => {
    const t = vocabInput.trim();
    if (!t || vocab.some((v) => v.term.toLowerCase() === t.toLowerCase())) return;
    setVocabInput("");
    vocabSave([{ term: t, freq: 10 }, ...vocab]);
  };

  // Theme — syncs with Cmd+D global hotkey via custom event
  const [theme, setTheme] = useState<"light" | "dark">("light");
  useEffect(() => {
    setTheme((document.documentElement.getAttribute("data-theme") || "light") as "light" | "dark");
    const sync = () => {
      setTheme((document.documentElement.getAttribute("data-theme") || "light") as "light" | "dark");
    };
    document.addEventListener("ink-theme-toggle", sync);
    return () => document.removeEventListener("ink-theme-toggle", sync);
  }, []);

  const toggleTheme = (next: "light" | "dark") => {
    applyThemeSmooth(next);
    setTheme(next);
  };

  // Workspace state
  const [wsName, setWsName] = useState("");
  const [wsCreating, setWsCreating] = useState(false);   // API create (already Team)
  const [wsUpgrading, setWsUpgrading] = useState(false); // redirecting to Team checkout
  const [wsError, setWsError] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState("");
  const [inviteOk, setInviteOk] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);

  // ── Fix 1: workspace create — engineered upsell, never a dead end ─
  // Team plan → create immediately via API.
  // No Team plan → Stripe Checkout for Team with the typed name carried as
  //   `pending_workspace_name`; the webhook creates the workspace post-payment.
  const handleCreateWs = async () => {
    const name = wsName.trim();
    if (!name) return;
    if (plan !== "team") {
      if (wsUpgrading || wsCreating) return;
      setWsUpgrading(true); setWsError("");
      try {
        const url = await createStripeCheckout("team", "monthly", name);
        window.location.href = url;
      } catch (e) {
        setWsError(e instanceof Error ? e.message : "Checkout failed.");
        setWsUpgrading(false);
      }
      return;
    }
    setWsCreating(true); setWsError("");
    try {
      const created = await apiCreateWorkspace(name);
      onWorkspaceChange?.(created);
      setWsName("");
    } catch (e) {
      setWsError(e instanceof Error ? e.message : "failed");
    } finally { setWsCreating(false); }
  };

  const handleInvite = async () => {
    if (!inviteEmail.trim()) return;
    setInviting(true); setInviteError(""); setInviteOk(false);
    try {
      await apiInviteMember(inviteEmail.trim());
      setInviteEmail(""); setInviteOk(true);
      setTimeout(() => setInviteOk(false), 3000);
    } catch (e) {
      setInviteError(e instanceof Error ? e.message : "failed");
    } finally { setInviting(false); }
  };

  const handleRemoveMember = async (memberId: string) => {
    setRemoving(memberId);
    try {
      await apiRemoveMember(memberId);
      if (workspace) {
        onWorkspaceChange?.({
          ...workspace,
          members: (workspace.members ?? []).filter((m) => m.id !== memberId),
        });
      }
    } catch { /* best-effort */ } finally { setRemoving(null); }
  };

  const handleLeave = async () => {
    if (!window.confirm(t.wsLeaveConfirm)) return;
    setLeaving(true);
    try {
      await apiLeaveWorkspace();
      onWorkspaceChange?.(null);
      onClose();
    } catch { /* best-effort */ } finally { setLeaving(false); }
  };

  // ── Fix 4: Delete account — two-click confirmation with 3s timeout ─
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const deleteTimerRef = useRef<number>(0);

  const handleDeleteAccount = async () => {
    if (deleting) return;
    if (!deleteConfirm) {
      window.clearTimeout(deleteTimerRef.current);
      setDeleteConfirm(true);
      deleteTimerRef.current = window.setTimeout(() => setDeleteConfirm(false), 3000);
      return;
    }
    // Second click within 3s — confirmed
    window.clearTimeout(deleteTimerRef.current);
    setDeleting(true);
    try {
      await apiDeleteAccount();
      await sb.auth.signOut();
      window.location.href = "/";
    } catch {
      setDeleting(false);
      setDeleteConfirm(false);
    }
  };
  useEffect(() => () => window.clearTimeout(deleteTimerRef.current), []);

  // Referral copy
  const [refCopied, setRefCopied] = useState(false);
  const refUrl = profile?.referral_code ? `https://skriptly.io?ref=${profile.referral_code}` : null;
  const copyRef = () => {
    if (!refUrl) return;
    navigator.clipboard.writeText(refUrl)
      .then(() => { setRefCopied(true); setTimeout(() => setRefCopied(false), 2500); })
      .catch(() => {});
  };

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [onClose]);

  const backdropRef = useRef<HTMLDivElement>(null);
  const email = session.user?.email || "";
  const used = profile?.minutes_used || 0;
  const limit = profile?.minutes_limit || 60;
  const ratio = limit > 0 ? Math.min(1, used / limit) : 0;
  const filledDots = Math.round(ratio * 16);

  // Helper: is the given plan an upgrade from current?
  const planIdx = (id: string) => PLAN_ORDER.indexOf(id as PlanId);
  const dictUsed = profile?.dictation_used_s || 0;
  const dictLimit = profile?.dictation_limit_s || 3600;
  const hours = (sec: number) => Math.round(sec / 360) / 10;
  const isUpgrade = (targetId: string) => planIdx(targetId) > planIdx(plan);

  const planLabel = plan.charAt(0).toUpperCase() + plan.slice(1);

  return (
    <div
      ref={backdropRef}
      className="i-modal-back"
      onClick={(e) => { if (e.target === backdropRef.current) onClose(); }}
    >
      <div className="i-modal i-modal-wide" role="dialog" aria-modal="true" aria-label={t.title}>

        {/* ── Header ── */}
        <div className="i-modal-header">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"/>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/>
          </svg>
          <span className="i-modal-title">{t.title}</span>
          <button type="button" className="i-modal-close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        {/* ── Two-column body ── */}
        <div className="i-modal-2col">

          {/* Left nav */}
          <nav className="i-modal-nav" aria-label="Settings navigation">
            {NAV_ORDER.map((id) => (
              <button
                key={id}
                type="button"
                className={`i-modal-nav-item${nav === id ? " on" : ""}${id === "danger" ? " danger" : ""}`}
                onClick={() => setNav(id)}
              >
                <NavIcon id={id} />
                {t.nav[id]}
              </button>
            ))}
          </nav>

          {/* Right content */}
          <div className="i-modal-content">

            {/* ── Account ── */}
            {nav === "account" && (
              <div className="i-modal-pane">
                <p className="i-msect-title">{t.account}</p>
                <div className="i-msect-card">
                  <div className="i-mrow">
                    <div>
                      <div className="i-account-email">{email}</div>
                      <div className="i-account-plan">
                        {planLabel} {t.planSuffix}
                      </div>
                    </div>
                  </div>
                  <div className="i-mrow" style={{ flexDirection: "column", alignItems: "flex-start", gap: 6 }}>
                    <span className="i-mrow-label">{t.usageMonth}</span>
                    <div className="i-usage-meter">
                      {Array.from({ length: 16 }, (_, k) => (
                        <span key={k} className={`i-um-dot${k < filledDots ? " fill" : ""}`} />
                      ))}
                      <span className="i-um-label">
                        {Math.round(used / 60 * 10) / 10} / {Math.round(limit / 60)}h
                        {profile?.minutes_pooled ? ` · ${t.teamPool}` : ""}
                      </span>
                    </div>
                    <span className="i-mrow-sub">
                      {t.dictation}: {profile?.dictation_unlimited
                        ? `${hours(dictUsed)}h · ${t.unlimited}`
                        : `${hours(dictUsed)} / ${hours(dictLimit)}h`}
                    </span>
                  </div>
                </div>
                <button type="button" className="i-signout" onClick={() => { onSignOut(); onClose(); }}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
                  </svg>
                  {t.signOut}
                </button>
              </div>
            )}

            {/* ── Subscription ── */}
            {nav === "subscription" && (
              <div className="i-modal-pane">
                <p className="i-msect-title">{t.yourPlan}</p>

                {billingError && (
                  <div className="i-billing-error" role="alert">{billingError}</div>
                )}

                <div className="i-seg-toggle" role="group" aria-label="Billing period" style={{ maxWidth: 260 }}>
                  {(["monthly", "annual"] as const).map((b) => (
                    <button key={b} type="button" className={billing === b ? "on" : ""} onClick={() => setBilling(b)}>
                      {b === "monthly" ? t.monthly : t.annual}
                    </button>
                  ))}
                </div>
                {billing === "annual" && <p className="i-mrow-sub" style={{ marginTop: 6 }}>{t.annualSave}</p>}

                <div className="i-plan-cards">
                  {planCards(uiLang, billing).map((p) => (
                    <div
                      key={p.id}
                      className={["i-plan-card", p.id === plan ? "current" : ""].filter(Boolean).join(" ")}
                    >
                      <div className="i-plan-name">{p.name}</div>
                      <div>
                        <span className="i-plan-price">{p.price}</span>
                        <span className="i-plan-price-period"> {p.period}</span>
                      </div>
                      <span className="i-plan-mins">{p.minutes}</span>
                      <div className="i-plan-feats">
                        {p.features.map((f) => (
                          <div key={f} className="i-plan-feat">{f}</div>
                        ))}
                      </div>
                      {p.id === plan
                        ? <span className="i-plan-current-badge">{t.currentPlan}</span>
                        : plan === "team"
                          /* Team: оплата — подписка воркспейса, управляет владелец */
                          ? <span className="i-mrow-sub">{t.manageInWorkspace}</span>
                        : p.id === "team"
                          /* Team покупается из вкладки Workspace — нужно имя воркспейса */
                          ? (
                            <button type="button" className="i-plan-cta" onClick={() => setNav("workspace")}>
                              {t.setUpTeam}
                            </button>
                          )
                        : isUpgrade(p.id)
                          ? (
                            <button
                              type="button"
                              className="i-plan-cta"
                              disabled={!!checkoutPlan || loadingPortal}
                              onClick={() => void startCheckout("pro")}
                            >
                              {checkoutPlan === p.id ? t.redirecting : t.upgrade}
                            </button>
                          )
                          : (
                            /* Fix 2: Downgrade routes explicitly to Stripe Customer Portal */
                            <button
                              type="button"
                              className="i-plan-cta i-plan-cta-down"
                              disabled={loadingPortal || !!checkoutPlan}
                              onClick={() => void openPortal()}
                            >
                              {loadingPortal ? t.opening : t.downgrade}
                            </button>
                          )
                      }
                    </div>
                  ))}
                </div>
                <p className="i-mrow-sub" style={{ marginTop: 10 }}>{t.priceNote}</p>
              </div>
            )}

            {/* ── Workspace ── */}
            {nav === "workspace" && (
              <div className="i-modal-pane">
                {!hasValidWorkspace ? (
                  /* Beautiful empty state — create workspace (engineered upsell) */
                  <div className="i-ws-empty">
                    <div className="i-ws-empty-icon">
                      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
                        <circle cx="9" cy="7" r="4"/>
                        <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>
                      </svg>
                    </div>
                    <h2 className="i-ws-empty-title">{t.wsEmptyTitle}</h2>
                    <p className="i-ws-empty-body">{t.wsEmptyBody}</p>
                    <div className="i-ws-create">
                      <input
                        className="i-field"
                        value={wsName}
                        onChange={(e) => setWsName(e.target.value)}
                        placeholder={t.wsNamePlaceholder}
                        onKeyDown={(e) => { if (e.key === "Enter") void handleCreateWs(); }}
                      />
                      {wsError && <p className="i-error">{wsError}</p>}
                      {/* Fix 1: button is enabled whenever the name is non-empty; the
                          label & action morph based on plan (create vs upgrade-and-create). */}
                      <button
                        type="button"
                        className="i-ws-invite-btn"
                        disabled={wsCreating || wsUpgrading || !wsName.trim()}
                        onClick={() => void handleCreateWs()}
                      >
                        {wsUpgrading
                          ? t.wsRedirecting
                          : wsCreating
                            ? t.wsCreating
                            : (plan === "team" ? t.wsCreateBtn : t.wsUpgradeCreate)}
                      </button>
                      {plan !== "team" && (
                        <p className="i-ws-plan-note">{t.wsUpgradeNote}</p>
                      )}
                    </div>
                  </div>
                ) : (
                  /* Workspace exists — manage it */
                  <>
                    <p className="i-msect-title">{t.wsTitle}</p>
                    <div className="i-msect-card">
                      <div className="i-mrow">
                        <div>
                          <div className="i-account-email">{workspace!.name}</div>
                          <div className="i-account-plan">
                            {workspace!.role} · {workspace!.plan} {t.planSuffix}
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Invite form — owners only */}
                    {workspace!.role === "owner" && (
                      <>
                        <p className="i-msect-title" style={{ marginTop: 14 }}>{t.wsInviteByEmail}</p>
                        <div className="i-ws-invite">
                          <input
                            className="i-field"
                            value={inviteEmail}
                            onChange={(e) => setInviteEmail(e.target.value)}
                            placeholder={t.wsInvitePlaceholder}
                            onKeyDown={(e) => { if (e.key === "Enter") void handleInvite(); }}
                          />
                          <button
                            type="button"
                            className="i-ws-invite-btn"
                            disabled={inviting || !inviteEmail.trim()}
                            onClick={() => void handleInvite()}
                          >
                            {inviting ? "…" : inviteOk ? t.wsInviteSent : t.wsInvite}
                          </button>
                        </div>
                        {inviteError && <p className="i-error">{inviteError}</p>}
                      </>
                    )}

                    {/* Members list */}
                    <p className="i-msect-title" style={{ marginTop: 14 }}>{t.wsMembers}</p>
                    <div className="i-ws-members">
                      {(workspace!.members ?? []).length === 0 && (
                        <p style={{ fontSize: 12.5, color: "var(--i-graphite)", padding: "10px 0" }}>
                          {t.wsNoMembers}
                        </p>
                      )}
                      {(workspace!.members ?? []).map((m) => (
                        <div key={m.id} className="i-ws-member">
                          <div className="i-ws-member-email">{m.email}</div>
                          {m.status === "invited" && (
                            <span className="i-ws-member-status">{t.wsInvited}</span>
                          )}
                          <span className={`i-ws-member-role${m.role === "owner" ? " owner" : ""}`}>
                            {m.role}
                          </span>
                          {workspace!.role === "owner" && m.role !== "owner" && (
                            <button
                              type="button"
                              className="i-ws-remove"
                              disabled={removing === m.id}
                              onClick={() => void handleRemoveMember(m.id)}
                              aria-label={`${t.wsRemove} ${m.email}`}
                            >
                              {removing === m.id ? "…" : t.wsRemove}
                            </button>
                          )}
                        </div>
                      ))}
                    </div>

                    {/* Leave button — members only */}
                    {workspace!.role === "member" && (
                      <button
                        type="button"
                        className="i-signout"
                        style={{
                          marginTop: 16,
                          color: "var(--i-danger)",
                          borderColor: "color-mix(in srgb, var(--i-danger) 35%, var(--i-hairline))",
                        }}
                        disabled={leaving}
                        onClick={() => void handleLeave()}
                      >
                        {leaving ? t.wsLeaving : t.wsLeave}
                      </button>
                    )}
                  </>
                )}
              </div>
            )}

            {/* ── Integrations ── */}
            {nav === "integrations" && (
              <div className="i-modal-pane">
                <p className="i-msect-title">{t.integrationsTitle}</p>
                <div className="i-notion-card">
                  <div className="i-integration-main">
                    <div className="i-integration-head">
                      <span className={`i-integration-dot${notionConnectedLocal ? " on" : ""}`} aria-hidden="true" />
                      <span className="i-integration-name">
                        {notionConnectedLocal ? t.notionConnected : t.notionTitle}
                      </span>
                    </div>
                    {notionConnectedLocal ? (
                      <div className="i-integration-ws">
                        {profile?.notion_workspace_name || t.notionWorkspaceFallback}
                      </div>
                    ) : (
                      <div className="i-integration-desc">{t.notionConnectDesc}</div>
                    )}
                  </div>
                  {notionConnectedLocal ? (
                    <button
                      type="button"
                      className="i-integration-btn danger"
                      disabled={notionBusy !== null}
                      onClick={() => void handleNotionDisconnect()}
                    >
                      {notionBusy === "disconnect" ? t.notionDisconnecting : t.notionDisconnect}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="i-integration-btn"
                      disabled={notionBusy !== null}
                      onClick={() => void handleNotionConnect()}
                    >
                      {notionBusy === "connect" ? t.notionConnecting : t.notionConnect}
                    </button>
                  )}
                </div>
                {notionError && <p className="i-error">{notionError}</p>}
              </div>
            )}

            {/* ── Settings ── */}
            {nav === "settings" && (
              <div className="i-modal-pane">
                <p className="i-msect-title">{t.recDefaults}</p>
                <div className="i-msect-card">
                  <div className="i-mrow">
                    <label className="i-mrow-label" htmlFor="s-lang">{t.fieldLanguage}</label>
                    <select
                      id="s-lang"
                      className="i-mini"
                      value={settings.language}
                      onChange={(e) => {
                        const next = saveSettings({ language: e.target.value });
                        onSettingsChange(next);
                      }}
                    >
                      {SUPPORTED_LANGUAGES.map((l) => (
                        <option key={l.value} value={l.value}>{l.label}</option>
                      ))}
                    </select>
                  </div>
                  <div className="i-mrow">
                    <label className="i-mrow-label" htmlFor="s-spk">{t.fieldSpeakers}</label>
                    <select
                      id="s-spk"
                      className="i-mini"
                      value={settings.speakers}
                      onChange={(e) => {
                        const next = saveSettings({ speakers: e.target.value });
                        onSettingsChange(next);
                      }}
                    >
                      <option value="">{t.auto}</option>
                      {[1, 2, 3, 4, 5, 6].map((n) => (
                        <option key={n} value={String(n)}>{n}</option>
                      ))}
                    </select>
                  </div>
                </div>

                <p className="i-msect-title" style={{ marginTop: 14 }}>
                  {uiLang === "ua" ? "Словник термінів" : "Vocabulary"}
                </p>
                <div className="i-msect-card" style={{ padding: 0 }}>
                  {vocab.length === 0 && (
                    <p className="i-vocab-empty">
                      {uiLang === "ua"
                        ? "Терміни з'являться після перших транскрипцій — Gemini навчиться вашій лексиці."
                        : "Terms appear after your first transcriptions — Gemini learns your vocabulary automatically."}
                    </p>
                  )}
                  {vocab.length > 0 && (
                    <div className="i-vocab-chips">
                      {(showAllVocab ? vocab : vocab.slice(0, VOCAB_TOP)).map((v) => (
                        <span key={v.term} className="i-vocab-chip">
                          {v.term}
                          <button
                            type="button" className="i-vocab-del"
                            onClick={() => vocabDelete(v.term)}
                            aria-label={`Remove ${v.term}`}
                          >×</button>
                        </span>
                      ))}
                    </div>
                  )}
                  {vocab.length > VOCAB_TOP && (
                    <button type="button" className="i-vocab-more" onClick={() => setShowAllVocab((v) => !v)}>
                      {showAllVocab
                        ? (uiLang === "ua" ? "Сховати" : "Show less")
                        : (uiLang === "ua" ? `Показати всі (${vocab.length})` : `Show all (${vocab.length})`)}
                    </button>
                  )}
                  <div className="i-vocab-add-row">
                    <input
                      className="i-field"
                      placeholder={uiLang === "ua" ? "Додати термін…" : "Add a term…"}
                      value={vocabInput}
                      onChange={(e) => setVocabInput(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") vocabAdd(); }}
                      maxLength={60}
                    />
                    <button type="button" className="i-cook" onClick={vocabAdd}>+</button>
                  </div>
                </div>

                <p className="i-msect-title" style={{ marginTop: 14 }}>{t.appearance}</p>
                <div className="i-msect-card">
                  <div className="i-mrow" style={{ gap: 6 }}>
                    <span className="i-mrow-label">{t.theme}</span>
                    <div className="i-theme-seg">
                      <button
                        type="button"
                        className={`i-theme-btn${theme === "light" ? " on" : ""}`}
                        onClick={() => toggleTheme("light")}
                      >{t.light}</button>
                      <button
                        type="button"
                        className={`i-theme-btn${theme === "dark" ? " on" : ""}`}
                        onClick={() => toggleTheme("dark")}
                      >{t.dark}</button>
                    </div>
                  </div>
                  {onUiLangChange && (
                    <div className="i-mrow">
                      <label className="i-mrow-label" htmlFor="s-uilang">{t.interfaceLanguage}</label>
                      <select
                        id="s-uilang"
                        className="i-mini"
                        value={uiLang}
                        onChange={(e) => onUiLangChange(e.target.value as Lang)}
                      >
                        <option value="en">English</option>
                        <option value="ua">Українська</option>
                      </select>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ── Invite friends ── */}
            {nav === "invite" && (
              <div className="i-modal-pane">
                <p className="i-msect-title">{t.referTitle}</p>
                <p style={{ fontSize: 13, color: "var(--i-graphite)", margin: "0 0 12px" }}>
                  {t.referBody}
                </p>
                {refUrl ? (
                  <div className="i-ref-box">
                    <span className="i-ref-url">{refUrl}</span>
                    <button type="button" className="i-ref-copy" onClick={copyRef}>
                      {refCopied ? t.copied : t.copy}
                    </button>
                  </div>
                ) : (
                  <p style={{ fontSize: 12.5, color: "var(--i-graphite)" }}>{t.loadingRef}</p>
                )}
              </div>
            )}

            {/* ── Danger zone ── */}
            {nav === "danger" && (
              <div className="i-modal-pane">
                <p className="i-msect-title">{t.dangerTitle}</p>

                {/* Sign out */}
                <div className="i-msect-card">
                  <div className="i-mrow">
                    <div>
                      <div className="i-mrow-label">{t.signOut}</div>
                      <div className="i-mrow-sub">{t.signOutSub}</div>
                    </div>
                    <button
                      type="button"
                      className="i-pill"
                      style={{
                        color: "var(--i-danger)",
                        borderColor: "color-mix(in srgb, var(--i-danger) 35%, var(--i-hairline))",
                      }}
                      onClick={() => { onSignOut(); onClose(); }}
                    >
                      {t.signOut}
                    </button>
                  </div>
                </div>

                {/* Fix 3: Delete account — fully localized, GDPR self-serve, 2-click confirm */}
                <div className="i-msect-card" style={{ marginTop: 10 }}>
                  <div className="i-mrow" style={{ flexDirection: "column", alignItems: "flex-start", gap: 8 }}>
                    <div>
                      <div className="i-mrow-label" style={{ color: "var(--i-danger)" }}>{t.delTitle}</div>
                      <div className="i-mrow-sub" style={{ maxWidth: 340 }}>
                        {t.delDesc}
                      </div>
                    </div>
                    <button
                      type="button"
                      className={`i-danger-del-btn${deleteConfirm ? " confirming" : ""}`}
                      disabled={deleting}
                      onClick={() => void handleDeleteAccount()}
                    >
                      {deleting
                        ? t.delDeleting
                        : deleteConfirm
                          ? t.delConfirm
                          : t.delBtn}
                    </button>
                    {deleteConfirm && !deleting && (
                      <p style={{ fontSize: 11.5, color: "var(--i-graphite)", margin: 0 }}>
                        {t.delAutoCancel}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            )}

          </div>
        </div>
      </div>
    </div>
  );
}
