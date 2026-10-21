// Собирает HTML-письма Supabase Auth (docs/email/*.html) из одного шаблона.
//   node scripts/build_email_templates.js
// Готовые файлы вставляются в Supabase → Authentication → Emails → Templates
// (Magic link и Confirm signup; тема письма — в docs/email/README.md).
// Письма строятся таблицами и inline-стилями: так их понимают Gmail/Outlook/Apple Mail.
// Шрифты Bricolage/Instrument Serif в почте не загрузить, поэтому фоллбэки — системные.
const fs = require("fs");
const path = require("path");

const BLUE = "#2740E6";
const variants = {
  "magic-link": {
    preheader: "Your sign-in link for Skriptly. It works once and expires in an hour.",
    title: "Sign in to Skriptly",
    titleUa: "Вхід у Skriptly",
    body: "Click the button to sign in as {{ .Email }}. The link works once and expires in an hour.",
    bodyUa: "Натисніть кнопку, щоб увійти як {{ .Email }}. Посилання одноразове й діє годину.",
    button: "Sign in",
    note: "Didn't ask for this? Ignore this email, nothing happens until the link is opened.",
    noteUa: "Не ви це просили? Просто проігноруйте лист.",
  },
  "confirm-signup": {
    preheader: "Welcome to Skriptly. Confirm your email to start.",
    title: "Welcome to Skriptly",
    titleUa: "Ласкаво просимо до Skriptly",
    body: "Confirm {{ .Email }} to finish creating your account. Free plan: 60 minutes of calls and 1 hour of dictation every month.",
    bodyUa: "Підтвердіть {{ .Email }}, щоб завершити створення акаунта. Free: 60 хвилин дзвінків і 1 година диктовки щомісяця.",
    button: "Confirm and sign in",
    note: "Didn't sign up? Ignore this email and the account won't be created.",
    noteUa: "Не ви реєструвались? Проігноруйте лист, акаунт не буде створено.",
  },
};

const page = (v) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${v.title}</title>
<style>
  @media (prefers-color-scheme: dark) {
    .bg { background: #100F0C !important; }
    .card { background: #181613 !important; border-color: #2A2722 !important; }
    .ink { color: #F2EFE7 !important; }
    .mute { color: #A29B8B !important; }
    .btn a { background: #5B6CFF !important; color: #0E0D0A !important; }
    .rule { border-color: #2A2722 !important; }
  }
  @media (max-width: 520px) { .pad { padding: 28px 22px !important; } .h1 { font-size: 26px !important; } }
</style>
</head>
<body class="bg" style="margin:0;padding:0;background:#F6F4EE;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${v.preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="bg" style="background:#F6F4EE;">
<tr><td align="center" style="padding:40px 16px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;">
    <tr><td style="padding:0 4px 20px;">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td width="30" height="30" style="width:30px;height:30px;"><img src="https://skriptly.io/email-mark.png" width="30" height="30" alt="S" style="display:block;border:0;border-radius:9px;"></td>
        <td class="ink" style="padding-left:10px;font:600 19px/30px 'Bricolage Grotesque',Helvetica,Arial,sans-serif;color:#14120E;letter-spacing:-0.01em;">Skriptly</td>
      </tr></table>
    </td></tr>
    <tr><td class="card pad" style="background:#FCFBF8;border:1px solid #E4DFD2;border-radius:22px;padding:40px 40px 36px;">
      <div class="mute" style="font:600 11.5px/1 'SFMono-Regular',Menlo,Consolas,monospace;letter-spacing:0.1em;text-transform:uppercase;color:#6B6557;">Calls &amp; dictation</div>
      <h1 class="h1 ink" style="margin:16px 0 0;font:600 31px/1.12 'Bricolage Grotesque',Helvetica,Arial,sans-serif;letter-spacing:-0.02em;color:#14120E;">${v.title}</h1>
      <p class="mute" style="margin:14px 0 0;font:400 16px/1.6 Helvetica,Arial,sans-serif;color:#4F493D;">${v.body}</p>
      <table role="presentation" cellpadding="0" cellspacing="0" class="btn" style="margin-top:28px;"><tr><td>
        <a href="{{ .ConfirmationURL }}" style="display:inline-block;background:${BLUE};color:#F6F4EE;text-decoration:none;font:600 16px/1 Helvetica,Arial,sans-serif;padding:16px 28px;border-radius:13px;">${v.button}</a>
      </td></tr></table>
      <p class="mute" style="margin:26px 0 0;font:400 13px/1.55 Helvetica,Arial,sans-serif;color:#6B6557;">${v.note}</p>
      <hr class="rule" style="border:0;border-top:1px solid #E4DFD2;margin:26px 0 22px;">
      <div class="ink" style="font:600 15px/1.3 Helvetica,Arial,sans-serif;color:#14120E;">${v.titleUa}</div>
      <p class="mute" style="margin:6px 0 0;font:400 14px/1.55 Helvetica,Arial,sans-serif;color:#6B6557;">${v.bodyUa}<br>${v.noteUa}</p>
    </td></tr>
    <tr><td class="mute" style="padding:20px 8px 0;font:400 12px/1.6 Helvetica,Arial,sans-serif;color:#8A8372;text-align:center;">
      If the button doesn't work, paste this link into your browser:<br>
      <span style="word-break:break-all;">{{ .ConfirmationURL }}</span><br><br>
      Skriptly · skriptly.io
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>
`;

const out = path.join(__dirname, "..", "docs", "email");
fs.mkdirSync(out, { recursive: true });
for (const [name, v] of Object.entries(variants)) {
  fs.writeFileSync(path.join(out, name + ".html"), page(v));
  console.log("wrote", name + ".html");
}
