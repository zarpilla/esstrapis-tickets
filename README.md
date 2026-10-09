# ESSTRAPIS tickets

A small website where ESSTRAPIS users report bugs, improvements and suggestions.

- The user writes in a textarea, in their own words, and can attach screenshots and documents.
- A z.ai GLM model turns the text into an issue in the same format as `projectes/issues`: a `NNN-slug.md` file with YAML frontmatter, Description, Acceptance criteria, Questions and a Log. The original text is kept under "Original report". If the AI call fails, the issue is still created from the raw text.
- On the ticket page, the user can add more information or answer the open questions, with new attachments if needed. The AI rewrites the generated sections (Description, Steps, Expected vs actual, Acceptance criteria, Notes) and replies in the user's language. It keeps hand-written notes, ticked criteria and any section added by hand. Messages and replies are kept under "Conversation".
- Tickets are private by default: only the author and admins see them. A ticket marked **Públic** can be read by every user, but only its author or an admin can change its status or visibility, or add follow-ups. Each change is logged in the file.
- Email notifications over SMTP: users whose username is an email address get an email when their ticket is created, changes status or visibility, or gets new information (with the AI reply). Admins with an email get them for every ticket. Whoever made the change isn't emailed, except for the receipt when they create a ticket. Notifications are off while `SMTP_HOST` is empty. The SMTP server is verified before the first email (and logged at start-up); if it is unreachable or rejects the login, emails are skipped and it is re-checked at most every 10 minutes.

There is no database: issues are Markdown files, users are a JSON file, and attachments sit on disk.

```
data/
  issues/001-add-excel-export-to-partners.md
  uploads/001/<random>.png
  users.json            # scrypt password hashes, mode 600
  tenants.json          # ESSTRAPIS instances and their SSO API keys, mode 600
```

## Run locally

Requires Node ≥ 20 (`nvm use` picks it up from `.nvmrc`).

```bash
npm install
cp .env.example .env        # set SESSION_SECRET (openssl rand -hex 32) and ZAI_API_KEY; NODE_ENV= (empty) for http://localhost
npm run user -- add jordi@example.org "Jordi Sabaté" admin
npm start                   # http://127.0.0.1:3000
npm test
```

## Users

There is no sign-up page. Manage users on the server:

```bash
npm run user -- add <email> "<Full name>" [user|admin]      # asks for the password (min 10 chars)
npm run user -- passwd <username>                           # also logs out their sessions
npm run user -- role <username> admin
npm run user -- disable <username>
npm run user -- list
```

## Login from ESSTRAPIS (SSO)

An ESSTRAPIS instance can send its logged-in users straight to the tickets site, with no password. Each instance is a **tenant** with its own secret API key:

```bash
npm run tenant -- add coop-a "Coop A"     # prints the API key: set it in that instance (e.g. TICKETS_SSO_KEY)
npm run tenant -- list | rotate <tenant> | disable <tenant> | enable <tenant>
npm run tenant -- token <tenant> <email> ["<Full name>"] [ttlSeconds]   # test login URL
```

The instance builds a link `https://tiquets.esstrapis.org/sso?tenant=<tenant>&token=<token>`. The token is `{ email, name, exp, nonce }` encrypted with AES-256-GCM, using a key derived from the API key and the tenant name. The API key itself never travels. On a valid token, the site creates the user if it doesn't exist (role `user`, linked to the tenant), logs them in, and redirects to the ticket list. Their tickets record `tenant:` in the frontmatter.

Rules: tokens live at most 10 minutes and work once. An existing user can only come in through the tenant that created them. Admins and users created with a password (no tenant) must log in with their password, so an instance can't take over those accounts.

Code for the ESSTRAPIS side (Node, no dependencies):

```js
const crypto = require('crypto')

function ticketsLoginUrl({ tenant, apiKey, email, name }) {
  const key = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(apiKey, 'utf8'), 'esstrapis-tickets-sso', tenant, 32))
  const payload = { email, name, exp: Math.floor(Date.now() / 1000) + 300, nonce: crypto.randomBytes(16).toString('base64url') }
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(tenant, 'utf8'))
  const enc = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()])
  const token = Buffer.concat([iv, enc, cipher.getAuthTag()]).toString('base64url')
  return `https://tiquets.esstrapis.org/sso?tenant=${encodeURIComponent(tenant)}&token=${token}`
}
```

Build the URL on the server, when the user clicks the link (e.g. an endpoint that responds with a redirect). Never put the API key in front-end code.

## Security

- Passwords are hashed with scrypt. Login takes the same time for unknown users and is rate limited per IP and username.
- The session is an HMAC-signed cookie (`HttpOnly`, `SameSite=Strict`, `Secure` in production). Changing a password or disabling a user invalidates their cookies.
- CSRF protection: every write needs the `X-Requested-With: tickets` header and a same-origin `Origin`.
- Strict CSP with no inline scripts. Issue Markdown is rendered on the server with raw HTML escaped and only `http(s)`/`mailto` links allowed.
- Uploads: extension allowlist (images, PDF, text, Office/LibreOffice; no HTML or SVG), size and count limits, and random file names on disk. Files are served only to the ticket's author or an admin, with `nosniff` and a sandboxing CSP. Non-image and non-PDF files are served as downloads.
- The text sent to the AI is treated as data, and the model output is validated field by field. Each user can make at most 30 AI requests (new tickets and follow-ups) per hour, to protect the API quota.

## Deploy on the VPS

```bash
sudo useradd --system --home /opt/esstrapis-tickets tickets
sudo git clone <repo> /opt/esstrapis-tickets && cd /opt/esstrapis-tickets
sudo npm ci --omit=dev
sudo cp .env.example .env && sudo nano .env      # NODE_ENV=production, TRUST_PROXY=1, secrets
sudo mkdir -p data && sudo chown -R tickets:tickets data && sudo chown root:tickets .env && sudo chmod 640 .env
sudo -u tickets npm run user -- add admin@example.org "Admin" admin
sudo cp deploy/esstrapis-tickets.service /etc/systemd/system/ && sudo systemctl enable --now esstrapis-tickets
sudo cp deploy/nginx.conf /etc/nginx/sites-available/tickets   # edit server_name, enable, then certbot --nginx
```

Back up `data/`. To bring tickets into the dev workflow, copy `data/issues/*.md` into `projectes/issues/`. Set `ISSUE_ID_START` so the web ids don't clash with the local ones.
