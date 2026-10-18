# Письма входа (Supabase Auth)

Шаблоны собираются из одного источника: `node scripts/build_email_templates.js`
(правки дизайна — там, потом перегенерировать и вставить в Supabase заново).

## Настройка (один раз)

**1. Resend — отправка с нашего домена**
1. resend.com → Domains → Add domain `skriptly.io` (регион EU).
2. Resend покажет DNS-записи (SPF, DKIM, MX для поддомена `send.`). Добавить их в Porkbun → DNS. Дождаться «Verified».
3. API Keys → Create (Sending access) → скопировать ключ `re_...`.

**2. Supabase → Authentication → Emails → SMTP Settings** (project `bmonakhktbaliwgobrxv`)
- Enable custom SMTP
- Sender email `noreply@skriptly.io`, Sender name `Skriptly`
- Host `smtp.resend.com`, Port `465`, Username `resend`, Password = ключ `re_...`
- Authentication → Rate Limits → «Rate limit for sending emails» поднять (по умолчанию с кастомным SMTP — 30/час; хватит).

**3. Supabase → Authentication → Emails → Templates**
| Шаблон | Тема письма | Файл |
|---|---|---|
| Magic link | `Your Skriptly sign-in link` | `magic-link.html` |
| Confirm signup | `Welcome to Skriptly: confirm your email` | `confirm-signup.html` |

(Новый пользователь, зашедший по email, получает «Confirm signup», существующий — «Magic link».)

**4. Проверка:** выйти из приложения, войти по email на себя, письмо должно прийти от `Skriptly <noreply@skriptly.io>` и не попасть в спам.
