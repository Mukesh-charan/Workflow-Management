# CA Office Workflow Management System

A cloud-based office workflow and task management system built for Chartered Accountant firms.
Two independent deployments share the same architecture:

| App | Firm |
|-----|------|
| `smk-office-workflow/` | SMK & Associates (CA. S. Masilamani Karthikeyan) |
| `mcm-office-workflow/` | MCM & Associates |

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Vanilla HTML / CSS / JavaScript (single-page app) |
| Backend | Node.js — Vercel Serverless Functions (`/api/*.js`) |
| Database | MongoDB Atlas (`ca_office_workflow` database) |
| Auth | JWT (stored in `sessionStorage`) |
| Biometrics | Face Recognition via `face-api.js` (optional per user) |
| Deployment | Vercel |

---

## Project Structure

```
dad/
├── smk-office-workflow/        # SMK firm app
│   ├── api/                    # Serverless API handlers
│   │   ├── auth.js             # Login, JWT helpers, audit logging
│   │   ├── clients.js          # Client CRUD + GST fields
│   │   ├── tasks.js            # Task management + stats aggregation
│   │   ├── users.js            # Staff/article user management
│   │   ├── attendance.js       # Clock-in/out, OD marking
│   │   ├── audit.js            # Audit log viewer (partner only)
│   │   ├── init.js             # Database initialisation / first-run seed
│   │   └── db.js               # MongoDB connection helper
│   ├── app.js                  # Main frontend application logic
│   ├── biometrics.js           # Face recognition + attendance frontend
│   ├── index.html              # App shell
│   └── vercel.json             # Vercel routing config
│
├── mcm-office-workflow/        # MCM firm app (mirrors SMK structure)
│
├── seed_data.py                # Database seeder (see below)
└── README.md                   # This file
```

---

## Features

- **Task Management** — Inward tasks, assign to staff/articles, track status (Unassigned → Assigned → Pending Review → Filed)
- **Client Ledger** — Full client profiles with PAN, Aadhaar, ITR password, GST credentials
- **Engagement Types** — 30+ standard CA engagement types (GSTR 1/3B/4, ITR-1 to ITR-6, Statutory Audit, Tax Audit, ROC, TDS, etc.)
- **Attendance** — Daily clock-in/clock-out, OD marking, monthly summary
- **Analytics Dashboard** — Task status distribution, staff leaderboard, filed task counts
- **Audit Logs** — Full action trail (partner-only view)
- **Biometric Login** — Optional face-ID verification per staff member
- **Role-based Access** — `partner` (full admin), `staff`, `article`
- **Server-side Pagination** — All heavy lists (tasks, clients, logs) load page-by-page for fast performance

---

## Roles & Permissions

| Feature | Partner | Staff | Article |
|---------|---------|-------|---------|
| View all tasks | ✅ | Own tasks only | Own tasks only |
| Create / assign tasks | ✅ | ✅ | ✅ |
| File task directly | ✅ | ✅ | ✅ |
| Manage clients | ✅ | ✅ | ✅ |
| Manage users | ✅ | ❌ | ❌ |
| View audit logs | ✅ | ❌ | ❌ |
| View all attendance | ✅ | Own only | Own only |

---

## Environment Variables

Create a `.env` file inside each app folder (or set on Vercel dashboard):

```env
MONGODB_URI=mongodb+srv://<user>:<password>@<cluster>.mongodb.net/?retryWrites=true&w=majority
JWT_SECRET=your_jwt_secret_key
```

> **Note:** Both `smk-office-workflow` and `mcm-office-workflow` use the **same** database
> (`ca_office_workflow`) but different collections are shared — deploy each with its own
> environment if you want separate databases.

---

## Running Locally

```bash
# Install Vercel CLI globally (one-time)
npm install -g vercel

# Inside either app folder
cd smk-office-workflow
npm install
npx vercel dev
```

The app will be available at `http://localhost:3000`.

---

## Database Seeder

`seed_data.py` drops all existing data and repopulates the database with realistic
Indian sample data (60+ records per collection).

### Requirements

```bash
pip install pymongo
```

### Usage

```bash
python seed_data.py --uri "mongodb+srv://user:pass@cluster.mongodb.net/"
```

Or set the environment variable and run without arguments:

```bash
set MONGO_URI=mongodb+srv://user:pass@cluster.mongodb.net/
python seed_data.py
```

### What gets seeded

| Collection | Count | Details |
|------------|-------|---------|
| `users` | 15 | 1 partner + 8 staff + 6 articles |
| `clients` | 60 | Indian names, PAN, Aadhaar, GST for ~40% |
| `tasks` | 60 | All 4 statuses, linked to real clients & staff |
| `engagements` | 30 | Full CA engagement type list |
| `attendance` | 65 | Last 44 days, Present/Absent/Half Day/OD |
| `audit_logs` | 65 | All action types, last 90 days |

### Partner Login (after seeding)

| Field | Value |
|-------|-------|
| **Username** | `admin` |
| **Password** | `admin@123` |
| **Name** | CA. Suresh Kumar |

---

## API Endpoints

All endpoints are under `/api/` and require a JWT `Authorization: Bearer <token>` header
(except `/api/login`).

| Endpoint | Methods | Description |
|----------|---------|-------------|
| `/api/login` | POST | Authenticate user, returns JWT |
| `/api/tasks` | GET POST PUT PATCH DELETE | Task CRUD + `?mode=stats` for analytics |
| `/api/clients` | GET POST PUT DELETE | Client CRUD with server-side search & pagination |
| `/api/users` | GET POST PUT DELETE | User management (partner only for write) |
| `/api/attendance` | GET POST PUT | Attendance clock-in/out, OD, monthly summary |
| `/api/audit` | GET | Paginated audit log viewer (partner only) |
| `/api/init` | GET | First-run DB initialisation |

### Common Query Parameters

| Param | Endpoints | Description |
|-------|-----------|-------------|
| `page` | tasks, clients, audit | Page number (default: 1) |
| `limit` | tasks, clients, audit | Records per page |
| `search` | tasks, clients, audit | Server-side regex search |
| `status` | tasks | Filter by status (comma-separated) |
| `operator` | tasks | Filter by assigned user |
| `mode=stats` | tasks | Returns aggregated analytics instead of list |
| `date` | attendance | Filter by exact date (`YYYY-MM-DD`) |
| `month` | attendance | Filter by month (`YYYY-MM`) |

---

## Deployment (Vercel)

1. Push each app folder as a separate Vercel project.
2. Set `MONGODB_URI` and `JWT_SECRET` in the Vercel project settings.
3. The `vercel.json` inside each folder handles API routing automatically.

---

## Indian Data Formats Used

| Field | Format / Example |
|-------|-----------------|
| PAN | `ABCDE1234F` (5 letters + 4 digits + 1 letter) |
| Aadhaar | `812345678901` (12 digits, starts 2–9) |
| GST Number | `33ABCDE1234F1Z5` (state code + PAN + entity) |
| Mobile | `9876543210` (10 digits, starts 6–9) |
| PIN Code | `600034` (6 digits) |
| Email | `name.surname@gmail.com` / `@yahoo.in` |
