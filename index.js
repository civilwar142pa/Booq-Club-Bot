const { Client, GatewayIntentBits, ActivityType } = require("discord.js");
const express = require("express");
const { getSheetData } = require("./sheets");
const fs = require("fs");
const { DateTime } = require("luxon");
const fetch = require("node-fetch");

// Load storage
function loadStorage() {
  try {
    const data = fs.readFileSync("storage.json", "utf8");
    return JSON.parse(data);
  } catch (error) {
    return {
      readingPoint: null,
      meetingInfo: {
        date: null,
        time: null,
        eventId: null,
        isoDate: null,
      },
    };
  }
}

function saveStorage(storage) {
  fs.writeFileSync("storage.json", JSON.stringify(storage, null, 2));
}

let storage = loadStorage();
let currentPoint = storage.readingPoint;
let meetingInfo = storage.meetingInfo;

// UPTIMEROBOT HEARTBEAT MONITORING
class UptimeRobotMonitor {
  constructor() {
    this.heartbeatUrl = process.env.UPTIMEROBOT_HEARTBEAT_URL;
    this.isEnabled = !!this.heartbeatUrl;
    this.failCount = 0;
    this.maxFails = 3;
  }

  async sendHeartbeat() {
    if (!this.isEnabled) {
      return false;
    }

    try {
      const response = await fetch(this.heartbeatUrl);

      if (response.ok) {
        if (this.failCount > 0) {
          console.log(
            `✅ UptimeRobot heartbeat restored after ${this.failCount} failures`,
          );
          this.failCount = 0;
        } else {
          console.log("✅ UptimeRobot heartbeat sent");
        }
        return true;
      } else {
        this.failCount++;
        console.warn(
          `⚠️ UptimeRobot heartbeat failed (HTTP ${response.status}) - Attempt ${this.failCount}/${this.maxFails}`,
        );
        return false;
      }
    } catch (error) {
      this.failCount++;
      console.warn(
        `⚠️ UptimeRobot heartbeat error: ${error.message} - Attempt ${this.failCount}/${this.maxFails}`,
      );

      // Disable after too many failures to avoid spam
      if (this.failCount >= this.maxFails) {
        console.error(
          "🔴 UptimeRobot heartbeat disabled due to repeated failures",
        );
        this.isEnabled = false;
      }
      return false;
    }
  }

  startHeartbeats(interval = 60000) {
    // Default: 1 minute
    if (!this.isEnabled) {
      console.log(
        "ℹ️ UptimeRobot heartbeat not configured - set UPTIMEROBOT_HEARTBEAT_URL environment variable",
      );
      return;
    }

    console.log("🔔 Starting UptimeRobot heartbeat monitoring...");

    // Send initial heartbeat
    this.sendHeartbeat();

    // Set up regular heartbeats
    this.heartbeatInterval = setInterval(() => {
      this.sendHeartbeat();
    }, interval);
  }

  stopHeartbeats() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      console.log("🛑 UptimeRobot heartbeats stopped");
    }
  }
}

// Initialize UptimeRobot monitor
const uptimeMonitor = new UptimeRobotMonitor();

// SIMPLE EXPRESS SERVER FOR INTERNAL USE
const app = express();
const port = 3000;

app.get("/", (req, res) => {
  const uptime = process.uptime();
  const hours = Math.floor(uptime / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  const seconds = Math.floor(uptime % 60);

  res.json({
    status: "Book Club Bot is running!",
    uptime: `${hours}h ${minutes}m ${seconds}s`,
    guilds: client?.guilds?.cache?.size || 0,
    currentPoint: currentPoint,
    nextMeeting: meetingInfo.date,
    // Add a specific keyword for monitoring
    monitor: "BOOK_CLUB_BOT_ACTIVE",
  });
});

// Add a dedicated health endpoint with simple text response
app.get("/health", (req, res) => {
  const botStatus = client?.isReady() ? "connected" : "disconnected";

  // Simple text response that's easy to monitor
  res.send(`BOOK_CLUB_BOT_OK|${botStatus}|${Math.floor(process.uptime())}s`);
});

app.get("/monitor", (req, res) => {
  // Ultra-simple endpoint just for monitoring
  res.send("BOOK_CLUB_BOT_ACTIVE");
});


// Start the server
app.listen(process.env.PORT || port, '0.0.0.0', () => {
  console.log(`Server running on port ${process.env.PORT || port}`);
});

// ROBUST BOT WITH SELF-KEEP-ALIVE
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildScheduledEvents,
  ],
});

const PREFIX = "!";

// Set timezone to UK
const DEFAULT_TIMEZONE = "Europe/London";

// Enhanced bot initialization with auto-restart
async function initializeBot() {
  while (true) {
    try {
      console.log("🤖 Attempting to login to Discord...");
      await client.login(token);
      console.log("✅ Bot logged in successfully");
      break; // Exit loop on success
    } catch (error) {
      console.error("❌ Login failed:", error.message);
      console.log("🔄 Retrying in 30 seconds...");
      await new Promise((resolve) => setTimeout(resolve, 30000));
    }
  }
}

client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}!`);
  console.log(`📊 Bot is in ${client.guilds.cache.size} server(s)`);
  console.log(`📖 Loaded reading point: ${currentPoint}`);
  console.log(`📅 Loaded meeting info:`, meetingInfo);

  // START UPTIMEROBOT HEARTBEATS
  uptimeMonitor.startHeartbeats(60000); // Every 60 seconds

  // DISCORD-BASED KEEP ALIVE SYSTEM
  setInterval(
    () => {
      const uptime = process.uptime();
      const hours = Math.floor(uptime / 3600);
      const minutes = Math.floor((uptime % 3600) / 60);

      // Update presence regularly (this helps keep the connection alive)
      client.user.setPresence({
        activities: [
          {
            name: `Online ${hours}h ${minutes}m | !commands`,
            type: ActivityType.Watching,
          },
        ],
        status: "online",
      });

      // Log keep-alive heartbeat
      console.log(
        `💓 Keep-alive heartbeat - Uptime: ${hours}h ${minutes}m - ${new Date().toLocaleTimeString()}`,
      );
    },
    2 * 60 * 1000,
  ); // Every 2 minutes

  // Initial presence
  client.user.setPresence({
    activities: [{ name: "!commands", type: ActivityType.Watching }],
    status: "online",
  });
});

// INTERNAL SELF-PINGING (no external dependencies)
function internalKeepAlive() {
  // Simple internal HTTP request to our own server
  fetch(`http://localhost:${port}`)
    .then((response) => response.json())
    .then((data) => {
      console.log(
        `🔁 Internal keep-alive - ${data.uptime} - ${new Date().toLocaleTimeString()}`,
      );
    })
    .catch((error) => {
      console.log("⚠️ Internal ping failed (normal during startup)");
    });
}

// Internal self-ping every 3 minutes
setInterval(internalKeepAlive, 3 * 60 * 1000);

// Start internal pinging after 30 seconds
setTimeout(internalKeepAlive, 30000);

// Improved date parsing with UK timezone
function parseMeetingDateTime(dateStr, timeStr) {
  const combined = timeStr ? `${dateStr} ${timeStr}` : dateStr;

  // Try multiple common formats
  const formats = [
    "MMMM d h:mma", // "December 15 7:00pm"
    "MMMM d ha", // "December 15 7pm"
    "MMMM d", // "December 15" (default to 7pm)
    "MMM d h:mma", // "Dec 15 7:00pm"
    "MMM d ha", // "Dec 15 7pm"
    "MMMM d, yyyy h:mma", // "December 15, 2024 7:00pm"
    "MMMM d, yyyy ha", // "December 15, 2024 7pm"
    "yyyy-MM-dd h:mma", // "2024-12-15 7:00pm"
    "yyyy-MM-dd ha", // "2024-12-15 7pm"
    "d MMMM h:mma", // "15 December 7:00pm" (UK format)
    "d MMMM ha", // "15 December 7pm" (UK format)
  ];

  let parsedDate = DateTime.now().setZone(DEFAULT_TIMEZONE);

  // Try structured formats first with UK timezone
  for (const format of formats) {
    const attempt = DateTime.fromFormat(combined, format, {
      zone: DEFAULT_TIMEZONE,
    });
    if (attempt.isValid) {
      parsedDate = attempt;
      break;
    }
  }

  // If structured parsing failed, try natural language with UK timezone
  if (
    !parsedDate.isValid ||
    parsedDate.equals(DateTime.now().setZone(DEFAULT_TIMEZONE))
  ) {
    const naturalAttempt = DateTime.fromJSDate(new Date(combined), {
      zone: DEFAULT_TIMEZONE,
    });
    if (
      naturalAttempt.isValid &&
      naturalAttempt > DateTime.now().setZone(DEFAULT_TIMEZONE)
    ) {
      parsedDate = naturalAttempt;
    }
  }

  // If no time specified, default to 7:00 PM UK time
  if (!timeStr && parsedDate.isValid) {
    parsedDate = parsedDate.set({
      hour: 19,
      minute: 0,
      second: 0,
      millisecond: 0,
    });
  }

  return parsedDate;
}

// Format date for display with UK timezone
function formatMeetingDate(isoDate) {
  if (!isoDate) return null;

  const date = DateTime.fromISO(isoDate).setZone(DEFAULT_TIMEZONE);
  if (!date.isValid) return null;

  return date.toLocaleString(DateTime.DATETIME_FULL);
}

// Function to create Discord event
async function createBookClubEvent(
  guild,
  dateTime,
  description = "Book Club Meeting",
) {
  try {
    const startTime = dateTime.toJSDate();
    const endTime = dateTime.plus({ hours: 2 }).toJSDate(); // 2 hours later

    const event = await guild.scheduledEvents.create({
      name: "📚 Book Club Meeting",
      scheduledStartTime: startTime,
      scheduledEndTime: endTime,
      privacyLevel: 2, // GUILD_ONLY
      entityType: 3, // EXTERNAL
      description: `${description}\n\nSet by Book Club Bot (UK Time)`,
      entityMetadata: {
        location: "Voice Channel",
      },
    });

    return event;
  } catch (error) {
    console.error("Error creating event:", error);
    throw error;
  }
}

// COMPLETE MESSAGE HANDLER WITH ALL COMMANDS
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith(PREFIX)) return;

  const args = message.content.slice(PREFIX.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  switch (command) {
    case "commands":
      message.reply(
        `**Booq Club Commands:**\n\n` +
          `\`!reading\` - Show what we're currently reading\n` +
          `\`!random\` - Pick a random book from future options\n` +
          `\`!nextmeeting\` - Show next meeting date, time, and event link\n` +
          `\`!currentpoint\` - Show where we're reading up to\n` +
          `\`!setpoint <description>\` - Set reading point\n` +
          `\`!setmeeting <date> <time>\` - Set next meeting & create event (UK time)\n` +
          `\`!clearevent\` - Clear the current meeting and delete Discord event\n` +
          `\`!link\` - Get the link to the spreadsheet\n` +
          `\`!timehelp\` - Show date/time format help\n` +
          `\`!status\` - Check bot status and uptime\n` +
          `\`!commands\` - Show this list`,
      );
      break;

    case "status":
      const uptime = process.uptime();
      const hours = Math.floor(uptime / 3600);
      const minutes = Math.floor((uptime % 3600) / 60);
      const seconds = Math.floor(uptime % 60);
      const memoryUsage = (
        process.memoryUsage().heapUsed /
        1024 /
        1024
      ).toFixed(2);

      message.reply(
        `**Bot Status:**\n` +
          `✅ **Online**: ${hours}h ${minutes}m ${seconds}s\n` +
          `📊 **Servers**: ${client.guilds.cache.size}\n` +
          `💾 **Memory**: ${memoryUsage} MB\n` +
          `🕒 **Last Update**: ${new Date().toLocaleTimeString()}\n` +
          `📖 **Reading Point**: ${currentPoint || "Not set"}`,
      );
      break;

    case "reading":
      try {
        const data = await getSheetData();
        const books = data.slice(1);
        const current = books.find(
          (row) => row[2]?.toLowerCase() === "currently reading",
        );
        if (current) {
          message.reply(
            `**Currently Reading:**\n` +
              `**${current[0]}** by ${current[1]}\n` +
              `${current[3] ? `Link: ${current[3]}` : ""}`,
          );
        } else {
          message.reply("No book is currently being read!");
        }
      } catch (error) {
        console.error("Error fetching current book:", error);
        message.reply("Sorry, I could not fetch the current book.");
      }
      break;

    case "random":
      try {
        const data = await getSheetData();
        const books = data.slice(1);
        const futureOptions = books.filter(
          (row) => row[2]?.toLowerCase() === "future option",
        );
        if (futureOptions.length > 0) {
          const randomIndex = Math.floor(Math.random() * futureOptions.length);
          const picked = futureOptions[randomIndex];
          message.reply(
            `**Random Pick:**\n` +
              `**${picked[0]}** by ${picked[1]}\n` +
              `${picked[3] ? `Link: ${picked[3]}` : ""}`,
          );
        } else {
          message.reply("No future book options available!");
        }
      } catch (error) {
        console.error("Error picking random book:", error);
        message.reply("Sorry, I could not pick a random book.");
      }
      break;

    case "nextmeeting":
      if (meetingInfo.isoDate) {
        const formattedDate = formatMeetingDate(meetingInfo.isoDate);
        let response = `**Next Meeting:**\n${formattedDate}`;

        if (meetingInfo.eventId) {
          try {
            const guild = message.guild;
            const event = await guild.scheduledEvents.fetch(
              meetingInfo.eventId,
            );
            response += `\n📅 **Discord Event:** ${event.url}`;
          } catch (error) {
            response += `\n⚠️ *Event link unavailable*`;
          }
        }

        message.reply(response);
      } else if (meetingInfo.date) {
        // Fallback to old format if exists
        message.reply(
          `**Next Meeting:**\n${meetingInfo.date}${meetingInfo.time ? ` at ${meetingInfo.time}` : ""} (UK time)`,
        );
      } else {
        message.reply(
          "No meeting scheduled yet. Use `!setmeeting <date> <time>` to set one.",
        );
      }
      break;

        case "setmeeting":
      if (args.length === 0) {
        message.reply(
          "**Usage:** `!setmeeting <date> [time]`\n\n" +
            "**Examples (UK Time):**\n" +
            "`!setmeeting December 15 7pm`\n" +
            '`!setmeeting "15 December" "19:30"`\n' +
            "`!setmeeting next friday`\n" +
            "`!setmeeting 2024-12-15 19:00`\n\n" +
            "*If no time is specified, defaults to 7:00 PM UK time*",
        );
        return;
      }

      // Simple parsing - you might want to improve this based on common patterns
      let dateStr, timeStr;
      if (args.length >= 2) {
        // Check if last argument looks like a time
        const lastArg = args[args.length - 1].toLowerCase();
        if (
          lastArg.includes("pm") ||
          lastArg.includes("am") ||
          lastArg.match(/\d{1,2}:\d{2}/)
        ) {
          timeStr = args.pop();
        }
        dateStr = args.join(" ");
      } else {
        dateStr = args[0];
      }

      try {
        const parsedDate = parseMeetingDateTime(dateStr, timeStr);

        if (!parsedDate.isValid) {
          return message.reply(
            '❌ Could not understand that date/time. Try formats like "December 15 7pm" or "next friday"',
          );
        }

        if (parsedDate <= DateTime.now().setZone(DEFAULT_TIMEZONE)) {
          return message.reply("❌ Please set a meeting time in the future.");
        }

        // Store both human-readable and ISO format
        meetingInfo.date = parsedDate.toLocaleString(DateTime.DATE_FULL);
        meetingInfo.time = parsedDate.toLocaleString(DateTime.TIME_SIMPLE);
        meetingInfo.isoDate = parsedDate.toISO();

        // Try to create Discord event
        let eventResponse = "";
        try {
          if (message.guild) {
            const event = await createBookClubEvent(
              message.guild,
              parsedDate,
              `Book Club Discussion - ${parsedDate.toLocaleString(DateTime.DATETIME_FULL)}`,
            );

            meetingInfo.eventId = event.id;
            eventResponse = `\n📅 **Discord Event Created:** ${event.url}`;
          } else {
            eventResponse = `\n⚠️ *Could not create event (not in a server)*`;
          }
        } catch (error) {
          console.error("Failed to create event:", error);
          eventResponse = `\n⚠️ *Could not create Discord event (missing permissions)*`;
        }

        // Save to storage
        storage.meetingInfo = meetingInfo;
        saveStorage(storage);

        message.reply(
          `✅ **Meeting set!**\n` +
            `**When:** ${formatMeetingDate(meetingInfo.isoDate)}` +
            eventResponse,
        );
      } catch (error) {
        console.error("Error setting meeting:", error);
        message.reply("❌ Sorry, there was an error setting the meeting.");
      }
      break; // ← MAKE SURE THIS BREAK EXISTS HERE

    case "clearevent":
      try {
        let responseMessage = "";
        
        // Check if there's an event to delete
        if (meetingInfo.eventId) {
          try {
            const guild = message.guild;
            if (guild) {
              const event = await guild.scheduledEvents.fetch(meetingInfo.eventId);
              await event.delete();
              responseMessage += "✅ **Discord event deleted**\n";
            }
          } catch (error) {
            console.log("Event not found or already deleted:", error.message);
            responseMessage += "⚠️ *Discord event was not found (may have been deleted already)*\n";
          }
        }
        
        // Clear the stored meeting info
        const oldMeetingInfo = { ...meetingInfo };
        
        meetingInfo = {
          date: null,
          time: null,
          eventId: null,
          isoDate: null,
        };
        
        // Update storage
        storage.meetingInfo = meetingInfo;
        saveStorage(storage);
        
        responseMessage += "✅ **Meeting data cleared!**\n";
        
        if (oldMeetingInfo.date) {
          responseMessage += `*Cleared: ${oldMeetingInfo.date}${oldMeetingInfo.time ? ` at ${oldMeetingInfo.time}` : ''}*`;
        }
        
        message.reply(responseMessage);
        
      } catch (error) {
        console.error("Error clearing event:", error);
        message.reply("❌ Sorry, there was an error clearing the event data.");
      }
      break;

    case "clearevent":
      try {
        let responseMessage = "";
        
        // Check if there's an event to delete
        if (meetingInfo.eventId) {
          try {
            const guild = message.guild;
            if (guild) {
              const event = await guild.scheduledEvents.fetch(meetingInfo.eventId);
              await event.delete();
              responseMessage += "✅ **Discord event deleted**\n";
            }
          } catch (error) {
            console.log("Event not found or already deleted:", error.message);
            responseMessage += "⚠️ *Discord event was not found (may have been deleted already)*\n";
          }
        }
        
        // Clear the stored meeting info
        const oldMeetingInfo = { ...meetingInfo };
        
        meetingInfo = {
          date: null,
          time: null,
          eventId: null,
          isoDate: null,
        };
        
        // Update storage
        storage.meetingInfo = meetingInfo;
        saveStorage(storage);
        
        responseMessage += "✅ **Meeting data cleared!**\n";
        
        if (oldMeetingInfo.date) {
          responseMessage += `*Cleared: ${oldMeetingInfo.date}${oldMeetingInfo.time ? ` at ${oldMeetingInfo.time}` : ''}*`;
        }
        
        message.reply(responseMessage);
        
      } catch (error) {
        console.error("Error clearing event:", error);
        message.reply("❌ Sorry, there was an error clearing the event data.");
      }
      break;

    case "currentpoint":
      if (currentPoint) {
        message.reply(`**Reading up to:** ${currentPoint}`);
      } else {
        message.reply(
          "No reading point set yet. Use `!setpoint <description>` to set one.",
        );
      }
      break;

    case "setpoint":
      if (args.length === 0) {
        message.reply(
          "**Usage:** `!setpoint <description>`\n\n" +
            "**Examples:**\n" +
            "`!setpoint Through Chapter 8`\n" +
            "`!setpoint Until you hit Part 2`\n" +
            "`!setpoint Page 150`\n" +
            "`!setpoint The end of Section 3`\n" +
            "`!setpoint Stop before the epilogue`",
        );
        return;
      }

      const newPoint = args.join(" ");
      currentPoint = newPoint;
      storage.readingPoint = newPoint;
      saveStorage(storage);

      message.reply(
        `✅ **Reading point updated!**\n**Read until:** ${currentPoint}`,
      );
      break;

    case "link":
      message.reply(
        `**Booq Club Spreadsheet:**\nhttps://docs.google.com/spreadsheets/d/1TRraVAkBbpZHz0oLLe0TRkx9i8F4OwAUMkP4gm74nYs/edit`,
      );
      break;

    case "timehelp":
      message.reply(
        "**Date/Time Formats I Understand (UK Time):**\n\n" +
          "**Dates:**\n" +
          "• `December 15` or `15 December` (UK format)\n" +
          "• `Dec 15` or `15 Dec`\n" +
          "• `December 15, 2024`\n" +
          "• `2024-12-15`\n" +
          "• `next friday` or `this saturday`\n\n" +
          "**Times:**\n" +
          "• `7pm` or `7:30pm`\n" +
          "• `19:00` (24-hour format)\n\n" +
          "**Examples:**\n" +
          "• `!setmeeting december 15 7pm`\n" +
          '• `!setmeeting "15 december" "19:30"`\n' +
          "• `!setmeeting 2024-12-15 19:00`\n\n" +
          "*All times are UK time*",
      );
      break;
  }
});

// ENHANCED ERROR HANDLING
process.on("unhandledRejection", (error) => {
  console.error("🔴 Unhandled Promise Rejection:", error);
});

process.on("uncaughtException", (error) => {
  console.error("🔴 Uncaught Exception:", error);
  console.log("🔄 Restarting in 10 seconds...");
  uptimeMonitor.stopHeartbeats();
  setTimeout(() => process.exit(1), 10000);
});

client.on("disconnect", () => {
  console.log("🔌 Bot disconnected, attempting to reconnect...");
});

client.on("reconnecting", () => {
  console.log("🔄 Bot reconnecting...");
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("🛑 Shutting down gracefully...");
  uptimeMonitor.stopHeartbeats();
  client.destroy();
  process.exit(0);
});

const token = process.env.DISCORD_BOT_TOKEN;

if (!token) {
  console.error("❌ Error: DISCORD_BOT_TOKEN is not set!");
  process.exit(1);
}

// Start the bot
initializeBot();
