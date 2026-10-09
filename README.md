# ESSTRAPIS tickets

A small website where ESSTRAPIS users report bugs, improvements and suggestions.

- The user writes in a textarea, in their own words, and can attach screenshots and documents.
- A z.ai GLM model turns the text into an issue in the same format as `projectes/issues`: a `NNN-slug.md` file with YAML frontmatter, Description, Acceptance criteria, Questions and a Log. The original text is kept under "Original report". If the AI call fails, the issue is still created from the raw text.
- On the ticket page, the user can add more information or answer the open questions, with new attachments if needed. The AI rewrites the generated sections (Description, Steps, Expected vs actual, Acceptance criteria, Notes) and replies in the user's language. It keeps hand-written notes, ticked criteria and any section added by hand. Messages and replies are kept under "Conversation".
- Users see their own tickets and can change their status. Admins see every ticket and can change any status. Each status change is logged in the file.

There is no database: issues are Markdown files, users are a JSON file, and attachments sit on disk.

```
data/
  issues/001-add-excel-export-to-partners.md
  uploads/001/<random>.png
  users.json            # scrypt password hashes, mode 600
```

## Run locally

Requires Node ≥ 18.

```bash
npm install
cp .env.example .env        # set SESSION_SECRET (openssl rand -hex 32) and ZAI_API_KEY; NODE_ENV= (empty) for http://localhost
npm run user -- add jordi "Jordi Sabaté" admin
npm start                   # http://127.0.0.1:3000
npm test
```

## Users

There is no sign-up page. Manage users on the server:

```bash
npm run user -- add <username> "<Full name>" [user|admin]   # asks for the password (min 10 chars)
npm run user -- passwd <username>                           # also logs out their sessions
npm run user -- role <username> admin
npm run user -- disable <username>
npm run user -- list
```

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
sudo -u tickets npm run user -- add admin "Admin" admin
sudo cp deploy/esstrapis-tickets.service /etc/systemd/system/ && sudo systemctl enable --now esstrapis-tickets
sudo cp deploy/nginx.conf /etc/nginx/sites-available/tickets   # edit server_name, enable, then certbot --nginx
```

Back up `data/`. To bring tickets into the dev workflow, copy `data/issues/*.md` into `projectes/issues/`. Set `ISSUE_ID_START` so the web ids don't clash with the local ones.
