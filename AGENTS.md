# AGENTS.md - Taobao Price Tracker

## Build & Run
- **Server**: `cd server && npm install && npm run dev` (tsx watch)
- **Client**: `cd client && npm install && npm run dev` (Vite at :5180)
- **Agent**: `cd server && npm run agent -- --ws ws://<host>:4000/ws/agent`
- **DB migrate**: `cd server && npx prisma migrate dev`
- **Tray app**: `cd tray/TaobaoAgentTray && dotnet build`

## Architecture
- **server/**: Node.js + Express + TypeScript backend, Prisma ORM, BullMQ jobs, Playwright scraper
- **client/**: React + Vite + TypeScript + Tailwind CSS frontend
- **tray/**: C# .NET system tray app for Windows agent
- **tools/**: Node runtime & WiX installer resources
- **Database**: PostgreSQL (Prisma schema in `server/prisma/schema.prisma`)
- **Queue**: Redis + BullMQ for job scheduling

## Code Style
- TypeScript strict mode, use Zod for validation
- Express controllers in `server/src/controllers/`, services in `server/src/services/`
- React components in `client/src/components/`, pages in `client/src/pages/`
- Use existing imports/patterns from neighboring files
- No tests configured yet - check package.json before adding test frameworks
