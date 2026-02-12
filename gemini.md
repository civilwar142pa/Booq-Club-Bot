# Project: Booq Club Bot
A Discord bot for managing a book club, including reading goals, meetings, and star-rating polls.

## Tech Stack
- **Runtime**: Node.js
- **Discord Library**: Discord.js v14
- **Database**: MongoDB via Mongoose
- **Time/Date**: Luxon (Timezone: `Europe/London`)
- **Data Source**: Google Sheets (via `./sheets.js`)

## Key Architectures & Patterns
- **Logging**: Every command must use a `currentCount` (incremented `commandCount`) and `SESSION_ID` (hex string) for debugging logs.
- **Error Handling**: Use `try/catch` blocks inside message handlers. All database saves must be wrapped in a `try` block.
- **Polls**: Star ratings (1.0 to 5.0) use button components. Data is stored in the `Poll` collection and ends after 3 days via `setTimeout`.
- **Events**: Meetings are automatically created as Discord Voice Channel events in the UK timezone.

## Database Schemas
- **Settings**: Stores `readingPoint` and `meetingInfo` (isoDate, eventId).
- **Poll**: Stores `messageId`, `votes` (Map of userId to Number), and `endTime`.

## Development Rules
- **Formatting**: Use Markdown EmbedBuilder for responses. 
- **Time**: Always assume UK Time (Europe/London) for user input.
- **Reliability**: Maintain the Express server heartbeat (`/health`) and UptimeRobot monitoring integration.