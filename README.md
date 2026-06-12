# Notes App

A full-stack note-taking web application built as part of a product management portfolio. Designed and directed by a non-technical PM using Claude Code as the development agent — demonstrating end-to-end product ownership from concept to deployed product.

**Live App:** [notes-app-tau-livid.vercel.app](https://notes-app-tau-livid.vercel.app)

---

## Product Overview

This app was built to demonstrate core PM competencies: defining a product vision, prioritizing features, iterating based on real usage, and shipping a polished end-to-end experience. Every feature decision was made intentionally — including what *not* to build.

The app targets users who want a flexible digital notebook that supports both typed and handwritten notes in one place, with cloud sync across sessions.

---

## Features

### Authentication & Access
- **Email/password account creation and login** via Supabase Auth
- **Guest mode** — users can try the full app without creating an account; notes are stored locally and not persisted (intentional design decision to reduce friction for first-time visitors)
- Secure session management with automatic logout

### Note Organization
- **Folders and notes** — organize notes into folders, with support for nested structure
- **Persistent sidebar** — always-visible navigation panel showing full folder and note tree
- **Collapsible sidebar** — auto-collapses when typing to maximize writing space; expands on click
- **Breadcrumb navigation** — always shows current location (e.g. Notes > Folder > Note Title)
- **Inline renaming** — double-click any folder or note title to rename it
- **Autosave** — notes save automatically 3 seconds after the user stops typing with a subtle status indicator; no manual save required

### Rich Text Editor (Quill.js)
- Font family selection (Arial, Times New Roman, Courier New, Georgia, Verdana, Helvetica)
- Font size selection from 8pt to 48pt in increments of 2
- Bold, italic, and underline formatting
- Text color picker
- Text alignment (left, center, right)
- Bullet lists with multi-level indentation (filled circle → hollow circle → square, matching Microsoft Word behavior)
- Numbered lists with multi-level indentation
- Tab key indents list items; Shift+Tab outdents
- Pressing Enter on a list line continues the list automatically
- Pressing Enter on an empty list line exits the list

### Handwriting & Drawing Canvas
- **Touch/stylus drawing mode** — toggle between typing and handwriting mode via toolbar
- Write directly on the page using a finger, stylus, or Apple Pencil
- Eraser tool with a visible circular cursor showing the erase radius
- Ink color picker (black, dark blue, red, green)
- Stroke thickness selector (thin, medium, thick)
- Right-edge scroll zone (60px) allows page scrolling while in drawing mode without accidentally drawing
- **AI handwriting conversion** — converts handwritten canvas strokes to formatted typed text using the Claude API (claude-sonnet-4-6); detects bullets, numbered lists, and indentation structure; triggers on demand, not live

### Notebook Cover & Animation
- Animated landing page designed to look like a hardcover notebook
- Opening animation using Framer Motion — cover swings open from the spine revealing the app underneath
- Warm brown leather aesthetic with bookmark ribbon detail

---

## Technical Stack

| Layer | Technology |
|---|---|
| Frontend | React (create-react-app) |
| Rich Text Editor | Quill.js via @uiw/react-quill-new (React 18 compatible) |
| Animation | Framer Motion |
| Styling | Tailwind CSS |
| Authentication | Supabase Auth |
| Database | Supabase (PostgreSQL) |
| AI / Handwriting OCR | Anthropic Claude API (claude-sonnet-4-6) |
| API Proxy | Vercel Serverless Functions |
| Hosting | Vercel |
| Version Control | GitHub |

---

## Architecture Notes

### API Proxy
Direct browser calls to the Anthropic API are blocked by CORS policy. To work around this, API calls are routed through a Vercel serverless function (`/api/anthropic.js`) which forwards requests server-side and returns the response to the client. This is the standard production pattern for protecting API keys in browser-based apps.

### Handwriting Conversion
The handwriting-to-text feature captures the drawing canvas as a base64 image using `canvas.toDataURL()`, sends it to Claude via the API with a structured prompt requesting formatted transcription, and inserts the returned text into the Quill editor at the appropriate position. A loading indicator displays during processing. This is implemented as a portfolio demo — in a production application this feature would require user-level API authentication and billing management on the backend.

### Database Schema
```
notes
  id            uuid (primary key)
  user_id       uuid (references auth.users)
  title         text
  content       text
  folder_id     uuid (references folders, nullable)
  updated_at    timestamptz

folders
  id            uuid (primary key)
  user_id       uuid (references auth.users)
  name          text
  created_at    timestamptz
```

Row Level Security (RLS) is enabled on both tables. Users can only read, insert, update, and delete their own records.

---

## Running Locally

**Prerequisites:** Node.js, npm, Git

```bash
# Clone the repository
git clone https://github.com/jessalewis50-cell/notes-app.git
cd notes-app

# Install dependencies
npm install

# Create a .env file with your credentials
REACT_APP_SUPABASE_URL=your_supabase_project_url
REACT_APP_SUPABASE_ANON_KEY=your_supabase_anon_key
REACT_APP_ANTHROPIC_API_KEY=your_anthropic_api_key

# Start the development server
npm start
```

The app will run at `http://localhost:3000`.

Note: The handwriting conversion feature requires a valid Anthropic API key with available credits. The rest of the app functions without it.

---

## Product Decisions & Tradeoffs

**Guest mode over forced signup** — Requiring account creation before letting users experience the app creates unnecessary friction, especially for portfolio visitors. Guest mode lets anyone explore all features immediately. The tradeoff (notes not persisting) is acceptable and clearly communicated in the UI.

**Autosave over manual save** — Users should never lose work because they forgot to click Save. Autosave with a 3-second debounce balances data safety with editor performance. The status indicator ("Saving..." / "Saved ✓") keeps users informed without being intrusive.

**On-demand handwriting conversion over live OCR** — Live conversion would be distracting and computationally expensive. Triggering conversion explicitly gives users control over when their handwriting is interpreted, allows them to finish a complete thought before processing, and avoids unnecessary API calls. The tradeoff is a brief delay, which is acceptable given the accuracy improvement.

**Quill.js over a custom editor** — Building a custom rich text editor from scratch introduces significant complexity and maintenance burden for marginal benefit. Quill is a mature, battle-tested library that handles cursor management, list behavior, and formatting natively. The integration work required for React 18 compatibility was a worthwhile tradeoff for the stability it provides.

---

## What a Production Version Would Include

- Backend authentication layer managing per-user API keys for the handwriting conversion feature
- Usage metering and billing for AI features
- Real-time collaboration (multiple users editing the same note)
- Note sharing and export (PDF, Markdown)
- Mobile app (React Native) using the same Supabase backend
- Search across all notes and folders
- Note versioning / history

---

## About

Built by Jess Lewis as part of a product management portfolio. Directed entirely in plain English using Claude Code as the AI development agent — demonstrating that strong product thinking, clear requirements, and iterative feedback loops are the core skills that ship great software.

[GitHub](https://github.com/jessalewis50-cell/notes-app) · [Live App](https://notes-app-tau-livid.vercel.app)