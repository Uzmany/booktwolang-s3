# BookTwoLang

AI-powered document translator. Paste text or upload a `.txt` / `.docx`, pick a
target language, and Gemini translates it on the backend, chunked on paragraph
boundaries so even book-length manuscripts come out coherent.

- **Frontend:** Vanilla HTML/JS + Tailwind (CDN), single-page app
- **Backend:** FastAPI + Uvicorn on Python 3.11 (shared EC2 `i-0f9e1d882c3ada3a4`)
- **Database:** DynamoDB — `booktwolang_documents`, `booktwolang_UserProfiles`, `booktwolang_UserSessions`
- **AI:** Google Gemini (`gemini-3-flash-preview` / `gemini-3-pro-preview`)
- **DNS / TLS / CDN:** Route 53, ACM, CloudFront — apex / `www` / `api.` pattern
- **Region / Account:** us-east-1, account `912112639269`

## Layout

```
booktwolang-s3/
├── index.html               # Single-page client (auth + translator)
├── public/assets/js/app.js  # Client logic
├── push-and-publish         # One-shot deploy script
├── README.md
└── booktwolang-api/
    ├── requirements.txt
    └── app/
        ├── main.py          # FastAPI app + document/translation routes
        ├── users.py         # Signup / login / JWT
        └── translate.py     # Gemini chunked translation
```

## Local development

```bash
cd booktwolang-api
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
export GEMINI_API_KEY=...      # required
export JWT_SECRET=$(openssl rand -hex 32)
uvicorn app.main:app --reload --port 8001
```

Serve the frontend any way you like (e.g. `python3 -m http.server 5500` from
the repo root). The client auto-points at `http://localhost:8001` when the
host is `localhost`/`127.0.0.1`.

## Deploy

```bash
./push-and-publish "fix translation status"
```

The script:

1. Commits + pushes to GitHub.
2. `aws s3 sync` of the frontend to `s3://www.booktwolang.com/` (excludes the API code and the SSH key).
3. Invalidates the CloudFront distribution (set `CLOUDFRONT_ID` env var).
4. SSHes into the shared EC2 box (`54.242.99.16`), pulls, reinstalls deps, kills the old uvicorn on `:8001`, and starts a fresh one with `nohup`.

The shared EC2 box runs three uvicorn services side-by-side:

| Project       | Port | Backed by                |
|---------------|------|--------------------------|
| ketzek-api    | 80   | `ketzek-api` target group |
| 10xquery-api  | 8000 | `10xquery-api-tg`        |
| booktwolang-api | 8001 | `booktwolang-api-tg`   |

The ALB `ketzek-lb` routes by `Host` header.

## Secrets on EC2

Create `/home/ec2-user/.booktwolang.env` once:

```bash
GEMINI_API_KEY=AIza...
JWT_SECRET=...32-byte-hex...
```

`push-and-publish` sources this file before starting uvicorn.

## DynamoDB schema (single-table for `booktwolang_documents`)

| PK                 | SK              | Notes                                             |
|--------------------|-----------------|---------------------------------------------------|
| `DOC#{docId}`      | `META`          | title, ownerId, sourceLang, targetLang, status, progress, GSI1PK = `USER#{userId}` |
| `DOC#{docId}`      | `SRC#{idx:05d}` | one source chunk (~6k chars)                     |
| `DOC#{docId}`      | `TRN#{idx:05d}` | matching translated chunk                         |

GSI `UserDocuments` — `GSI1PK` (HASH) + `GSI1SK` (RANGE) — lists docs per user.
