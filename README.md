# ESSTRAPIS tickets

A small website where ESSTRAPIS users report bugs, improvements and suggestions.

- The user writes in a textarea, in their own words, and can attach screenshots and documents.
- A z.ai GLM model turns the text into an issue in the same format as `projectes/issues`: a `NNN-slug.md` file with YAML frontmatter, Description, Acceptance criteria, Questions and a Log. The original text is kept under "Original report". If the AI call fails, the issue is still created from the raw text.
- On the ticket page, the user can add more information or answer the open questions, with new attachments if needed. The AI rewrites the generated sections (Description, Steps, Expected vs actual, Acceptance criteria, Notes) and replies in the user's language. It keeps hand-written notes, ticked criteria and any section added by hand. Messages and replies are kept under "Conversation".
- Tickets are stored in English but shown in Catalan. The same model translates each ticket, and the translation is cached in `data/translations/NNN.json` under a hash of the English text. When the generated sections or the title change (also by a hand edit of the `.md`), the next view translates the ticket again. "Original report" and "Conversation" are already in the user's language and are kept as they are. The Log is translated in code, so a status change doesn't need the AI. If the translation fails, or takes longer than `ZAI_TRANSLATE_WAIT_MS`, the English text is shown. Admins can switch to the English original. Emails use the Catalan title.
- Tickets are private by default: only the author and admins see them. A ticket marked **Públic** can be read by every user, but only its author or an admin can change its status or visibility, or add follow-ups. Each change is logged in the file.
- Email notifications over SMTP: users whose username is an email address get an email when their ticket is created, changes status or visibility, or gets new information (with the AI reply). Admins with an email get them for every ticket. Whoever made the change isn't emailed, except for the receipt when they create a ticket. Notifications are off while `SMTP_HOST` is empty. The SMTP server is verified before the first email (and logged at start-up); if it is unreachable or rejects the login, emails are skipped and it is re-checked at most every 10 minutes.

There is no database: issues are Markdown files, users are a JSON file, and attachments sit on disk.

```
data/
  issues/001-add-excel-export-to-partners.md
  uploads/001/<random>.png
  translations/001.json # Catalan version shown in the UI (a cache: safe to delete)
  users.json            # scrypt password hashes, mode 600
  tenants.json          # ESSTRAPIS instances seen through SSO (and blocked ones), mode 600
```

## Run locally

Requires Node ≥ 20 (`nvm use` picks it up from `.nvmrc`).

```bash
npm install
cp .env.example .env        # set SESSION_SECRET (openssl rand -hex 32) and ZAI_API_KEY; NODE_ENV= (empty) for http://localhost
npm run user -- add admin@example.org "Admin" admin
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

ESSTRAPIS instances send their logged-in users straight to the tickets site, with no password. All instances and this site share one secret, `TICKETS_SSO_KEY` (32+ chars, e.g. `openssl rand -base64 48`). Set it in this site's `.env` and in every instance's environment. With it empty, SSO is off.

When a user clicks "Tiquets", the instance builds `https://tiquets.esstrapis.org/sso?token=<token>`. The token is `{ tenant, tenantName, email, name, exp, nonce }` encrypted with AES-256-GCM, using a key derived from the shared secret. The secret itself never travels. The tenant is the slug of the instance name in Configuració General ("Fusteria La Serra, SCCL" → `fusteria-la-serra-sccl`).

A token that decrypts is trusted:
- The tenant registers itself on its first login. Nothing has to be created by hand.
- The user is created if they don't exist (role `user`). Their `tenant` is updated on every login, so someone working in two instances can come in from either. Their tickets record `tenant:` in the frontmatter.
- Tokens live at most 10 minutes and work once.
- Admins and accounts created with a password can't be signed in through SSO; they log in with their password.

```bash
npm run tenant -- list                                   # instances seen, last login
npm run tenant -- disable "<instance name or tenant>"    # block an instance (enable to undo)
npm run tenant -- token "<instance name>" <email> ["<Full name>"] [ttlSeconds]   # test login URL
```

Anyone holding the shared secret can sign in as any SSO user of any instance, so keep it only on servers you run. To revoke it, change it here and in every instance.

The ESSTRAPIS side lives in `projectes-v5/src/services/tickets-sso.js` (`GET /api/me/tickets-login`).

## Docker

GitHub Actions (`.github/workflows/docker.yml`) runs the tests and builds the image on every push and pull request. Pushes to `main` publish `<DOCKERHUB_USERNAME>/esstrapis-tickets:latest` and `:sha-<commit>` to Docker Hub. Tags like `v1.2.3` also publish `:1.2.3` and `:1.2`. It uses the repository secrets `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN`. Pull requests only build, without pushing.

The image (Node 24, Alpine) runs as the `node` user, listens on port 3000, and keeps everything in the `/data` volume. Run it with `deploy/docker-compose.yml`:

```bash
cp .env.example deploy/.env && nano deploy/.env       # SESSION_SECRET, TICKETS_SSO_KEY, ZAI_API_KEY, SMTP_*, PUBLIC_URL
DOCKERHUB_USERNAME=<user> docker compose -f deploy/docker-compose.yml up -d
docker compose -f deploy/docker-compose.yml exec tickets npm run user -- add admin@example.org "Admin" admin
```

nginx (`deploy/nginx.conf`) stays in front, proxying to `127.0.0.1:3000`. Back up the `tickets-data` volume.

## Deploy on the VPS without Docker

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
