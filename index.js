const { Client, GatewayIntentBits, ActivityType, EmbedBuilder } = require("discord.js");
const express = require("express");
const { getSheetData } = require("./sheets");
const { DateTime } = require("luxon");
const fetch = require("node-fetch");
const mongoose = require("mongoose");

// Generate a unique Session ID to identify this specific process
const SESSION_ID = Math.floor(Math.random() * 100000).toString(16).toUpperCase();

// Mongoose Schema for persistent storage
const SettingsSchema = new mongoose.Schema({
  _id: { type: String, default: "global_settings" }, // Single document for global settings
  readingPoint: String,
  meetingInfo: {
    date: String,
    time: String,
    eventId: String,
    isoDate: String,
  },
});

const Settings = mongoose.model("Settings", SettingsSchema);

// Initialize default state (will be overwritten by DB load)
let storage = {
  readingPoint: null,
  meetingInfo: {
    date: null,
    time: null,
    eventId: null,
    isoDate: null,
  },
};
let currentPoint = storage.readingPoint;
let meetingInfo = storage.meetingInfo;

async function saveStorage(newStorage) {
  try {
    // Save to MongoDB
    await Settings.findByIdAndUpdate("global_settings", newStorage, {
      upsert: true,
      new: true,
    });
    console.log("💾 Data saved to MongoDB");
  } catch (error) {
    console.error("❌ Error saving to MongoDB:", error);
  }
}

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
const server = app.listen(process.env.PORT || port, '0.0.0.0', () => {
  console.log(`Server running on port ${process.env.PORT || port}`);
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`❌ FATAL ERROR: Port ${process.env.PORT || port} is already in use.`);
    console.error('   This usually means another instance of the bot is already running.');
    console.error('   Please close the other instance before starting this one.');
    process.exit(1);
  }
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
  // 1. Connect to MongoDB
  if (process.env.MONGODB_URI) {
    try {
      console.log("🍃 Connecting to MongoDB...");
      await mongoose.connect(process.env.MONGODB_URI);
      console.log("✅ Connected to MongoDB");

      // 2. Load saved data
      const savedSettings = await Settings.findById("global_settings");
      if (savedSettings) {
        storage = savedSettings.toObject();
        currentPoint = storage.readingPoint;
        meetingInfo = storage.meetingInfo || meetingInfo;
        console.log("📥 Loaded data from database");
      }
    } catch (error) {
      console.error("❌ MongoDB Connection Error:", error);
    }
  } else {
    console.warn("⚠️ MONGODB_URI not set! Data will not persist on restart.");
  }

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
  console.log(`🆔 Session ID: ${SESSION_ID}`);
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
  description = "Booq Club Meeting",
  voiceChannelId = process.env.VOICE_CHANNEL_ID // Add this parameter
) {
  try {
    const startTime = dateTime.toJSDate();
    const endTime = dateTime.plus({ hours: 2 }).toJSDate(); // 2 hours later

    // Try to get the specified voice channel
    let voiceChannel = null;
    if (voiceChannelId) {
      try {
        voiceChannel = await guild.channels.fetch(voiceChannelId);
        if (voiceChannel.type !== 2) { // Type 2 is GUILD_VOICE
          console.warn(`Channel ${voiceChannelId} is not a voice channel, using default`);
          voiceChannel = null;
        }
      } catch (error) {
        console.warn(`Could not fetch voice channel ${voiceChannelId}:`, error.message);
      }
    }

    // If no valid voice channel ID provided, try to find one named "Book Club" or similar
    if (!voiceChannel) {
      voiceChannel = guild.channels.cache.find(
        channel => 
          channel.type === 2 && // GUILD_VOICE
          (channel.name.toLowerCase().includes('book') || 
           channel.name.toLowerCase().includes('club') ||
           channel.name.toLowerCase().includes('meeting'))
      );
      
      // If still not found, use first available voice channel
      if (!voiceChannel) {
        const voiceChannels = guild.channels.cache.filter(ch => ch.type === 2);
        if (voiceChannels.size > 0) {
          voiceChannel = voiceChannels.first();
        }
      }
    }

    if (!voiceChannel) {
      throw new Error("No voice channel available for event creation");
    }

    // Create VOICE channel event instead of EXTERNAL
    const event = await guild.scheduledEvents.create({
      name: "📚 Booq Club Meeting",
      scheduledStartTime: startTime,
      scheduledEndTime: endTime,
      privacyLevel: 2, // GUILD_ONLY
      entityType: 2, // VOICE (instead of 3 for EXTERNAL)
      description: `${description}\n\nSet by Booq Club Bot (UK Time)`,
      channel: voiceChannel.id, // Specify the voice channel
      entityMetadata: null, // Not needed for VOICE events
    });

    console.log(`✅ Event created in voice channel: ${voiceChannel.name} (${voiceChannel.id})`);
    return event;
  } catch (error) {
    console.error("Error creating event:", error);
    throw error;
  }
}

// COMPLETE MESSAGE HANDLER WITH ALL COMMANDS
let commandCount = 0;
client.on("messageCreate", async (message) => {
  commandCount++;
  const currentCount = commandCount;
  
  if (message.author.bot) {
    console.log(`🚫 [${currentCount}] Ignored bot message from: ${message.author.tag}`);
    return;
  }
  
  if (!message.content.startsWith(PREFIX)) {
    console.log(`🚫 [${currentCount}] Ignored non-command: ${message.content.substring(0, 30)}...`);
    return;
  }

  // Check for Category restriction
  const categoryId = process.env.DISCORD_CATEGORY_ID;
  if (categoryId && message.guild) {
    // Check if this category ID actually exists in this specific server
    const category = message.guild.channels.cache.get(categoryId);
    
    // If the category exists in this server, we enforce the restriction
    if (category) {
      if (message.channel.parentId !== categoryId) {
        console.log(`🚫 [${currentCount}] Ignored command from channel ${message.channel.id} (Category: ${message.channel.parentId}) - Restricted to Category ${categoryId}`);
        return;
      }
    } else {
      // If the category ID doesn't exist in this server, we ignore the restriction (Global fallback)
      console.log(`ℹ️ [${currentCount}] Category restriction ignored - Category ID ${categoryId} not found in this server`);
    }
  }

  // DETAILED DEBUG LOGGING
  console.log(`🔍 [${currentCount}] COMMAND START: "${message.content}"`);
  console.log(`   Author: ${message.author.tag} (${message.author.id})`);
  console.log(`   Channel: ${message.channel.id}`);
  console.log(`   Timestamp: ${Date.now()}`);
  
  const args = message.content.slice(PREFIX.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  console.log(`   Parsed command: ${command}, args: ${args.join(', ')}`);

  switch (command) {
    case "commands":
      console.log(`📋 [${currentCount}] Processing !commands`);
      const helpEmbed = new EmbedBuilder()
        .setColor(0x0099FF)
        .setTitle('🤖 Booq Club Commands')
        .addFields(
          { name: '📚 Reading', value: '`!reading` - Current book\n`!currentpoint` - Reading goal\n`!pastreads` - Past books list\n`!random` - Pick random future option' },
          { name: '📅 Meetings', value: '`!nextmeeting` - Meeting info\n`!setmeeting` - Schedule meeting\n`!clearevent` - Cancel meeting' },
          { name: '⚙️ Utility', value: '`!setpoint` - Set reading goal\n`!link` - Spreadsheet link\n`!timehelp` - Date format help\n`!status` - Bot health' }
        )
        .setFooter({ text: 'Booq Club Bot' });
      
      message.reply({ embeds: [helpEmbed] });
      console.log(`🏁 [${currentCount}] !commands completed`);
      break;

    case "status":
      console.log(`📊 [${currentCount}] Processing !status`);
      const uptime = process.uptime();
      const hours = Math.floor(uptime / 3600);
      const minutes = Math.floor((uptime % 3600) / 60);
      const seconds = Math.floor(uptime % 60);
      const memoryUsage = (
        process.memoryUsage().heapUsed /
        1024 /
        1024
      ).toFixed(2);

      const statusEmbed = new EmbedBuilder()
        .setColor(0x00FF00)
        .setTitle('📊 Bot Status')
        .addFields(
          { name: '🆔 Instance ID', value: `\`${SESSION_ID}\``, inline: true },
          { name: '✅ Online Time\n', value: `${hours}h ${minutes}m ${seconds}s`, inline: true },
          { name: '📊 Servers', value: `${client.guilds.cache.size}`, inline: true },
          { name: '💾 Memory', value: `${memoryUsage} MB`, inline: true }
        )
        .setTimestamp();

      message.reply({ embeds: [statusEmbed] });
      console.log(`🏁 [${currentCount}] !status completed`);
      break;

    case "reading":
      console.log(`📚 [${currentCount}] Processing !reading command`);
      try {
        const data = await getSheetData();
        const books = data.slice(1);
        const current = books.find(
          (row) => row[2]?.toLowerCase() === "currently reading",
        );
        if (current) {
          console.log(`✅ [${currentCount}] Sending reading response`);
          const readingEmbed = new EmbedBuilder()
            .setColor(0x0099FF)
            .setTitle('📖 Currently Reading')
            .setDescription(`**${current[0]}**\n*by ${current[1]}*`);
          
          if (current[3]) readingEmbed.addFields({ name: '🔗 Link', value: `[View Book](${current[3]})` });
          
          message.reply({ embeds: [readingEmbed] });
        } else {
          console.log(`❌ [${currentCount}] No current book found`);
          message.reply("No book is currently being read!");
        }
      } catch (error) {
        console.error(`💥 [${currentCount}] Error in reading:`, error);
        message.reply("Sorry, I could not fetch the current book.");
      }
      console.log(`🏁 [${currentCount}] !reading command completed`);
      break;

    case "random":
      console.log(`🎲 [${currentCount}] Processing !random command`);
      try {
        const data = await getSheetData();
        const books = data.slice(1);
        const topChoices = books.filter(
          (row) => row[2]?.toLowerCase() === "top choice",
        );
        if (topChoices.length > 0) {
          const randomIndex = Math.floor(Math.random() * topChoices.length);
          const picked = topChoices[randomIndex];
          console.log(`✅ [${currentCount}] Sending random book response`);
          const randomEmbed = new EmbedBuilder()
            .setColor(0x9B59B6) // Purple for random
            .setTitle('🎲 Random Pick')
            .setDescription(`**${picked[0]}**\n*by ${picked[1]}*`);

          if (picked[3]) randomEmbed.addFields({ name: '🔗 Link', value: `[View Book](${picked[3]})` });

          message.reply({ embeds: [randomEmbed] });
        } else {
          console.log(`❌ [${currentCount}] No top choices found`);
          message.reply("No top choice options available!");
        }
      } catch (error) {
        console.error(`💥 [${currentCount}] Error in random:`, error);
        message.reply("Sorry, I could not pick a random book.");
      }
      console.log(`🏁 [${currentCount}] !random command completed`);
      break;

    case "pastreads":
      console.log(`📚 [${currentCount}] Processing !pastreads command`);
      try {
        const data = await getSheetData();
        // Skip header row
        const books = data.slice(1);
        
        // Filter for books marked as 'finished' or 'read' (handles both keywords)
        const pastBooks = books.filter((row) => {
          const status = row[2]?.toLowerCase().trim();
          return status === "finished" || status === "read";
        });

        if (pastBooks.length > 0) {
          // Get the last 15 books to avoid hitting Discord's message length limit
          const recentReads = pastBooks.slice(-10); // Limit to 10 for a cleaner embed look
          
          const embed = new EmbedBuilder()
            .setColor(0x0099FF) // Blue color
            .setTitle('📚 Past Reads & Ratings')
            .setDescription("Here are the books we've finished recently:")
            .setFooter({ text: 'Booq Club Archive' })
            .setTimestamp();

          const list = recentReads.map((book, index) => {
            const title = book[0] || "Unknown Title";
            const author = book[1] || "Unknown Author";
            const link = book[3];
            // Rating is expected in the 5th column (index 4)
            const rating = book[4];
            
            let entry = `**${index + 1}. ${title}**\n*by ${author}*`;
            if (rating) entry += ` • ⭐ **${rating}/5**`;
            if (link) entry += ` •[ View Book](${link})`;
            
            return entry;
          }).join("\n\n");

          embed.addFields({ name: 'Recent Books', value: list });

          const spreadsheetLink = "https://docs.google.com/spreadsheets/d/1TRraVAkBbpZHz0oLLe0TRkx9i8F4OwAUMkP4gm74nYs/edit"; //spreadsheet link
          const folderLink = "https://drive.google.com/drive/u/0/folders/1YAyccVd4uYvrLheVSahAn8sXLwwov_Io"; // discussions folder link

          embed.addFields({ 
            name: '📂 Resources', 
            value: `📊 [Spreadsheet](${spreadsheetlink})\n📓 [Book Notes](${folderlink})` 
          });

          console.log(`✅ [${currentCount}] Sending past reads response`);
          message.reply({ embeds: [embed] });
        } else {
          console.log(`❌ [${currentCount}] No past reads found`);
          message.reply("No past reads found in the spreadsheet!");
        }
      } catch (error) {
        console.error(`💥 [${currentCount}] Error in pastreads:`, error);
        message.reply("Sorry, I could not fetch the past reads.");
      }
      console.log(`🏁 [${currentCount}] !pastreads command completed`);
      break;

    case "nextmeeting":
      console.log(`📅 [${currentCount}] Processing !nextmeeting`);
      if (meetingInfo.isoDate) {
        const formattedDate = formatMeetingDate(meetingInfo.isoDate);
        
        const meetingEmbed = new EmbedBuilder()
          .setColor(0xF1C40F) // Gold/Yellow
          .setTitle('📅 Next Meeting')
          .setDescription(`**${formattedDate}**`);
        
        if (meetingInfo.eventId) {
          try {
            const guild = message.guild;
            const event = await guild.scheduledEvents.fetch(
              meetingInfo.eventId,
            );
            meetingEmbed.addFields({ name: '🔗 Discord Event', value: event.url });
          } catch (error) {
            // Event link unavailable, just skip adding the field
          }
        }

        console.log(`✅ [${currentCount}] Sending meeting info`);
        message.reply({ embeds: [meetingEmbed] });
      } else if (meetingInfo.date) {
        console.log(`✅ [${currentCount}] Sending fallback meeting info`);
        const fallbackEmbed = new EmbedBuilder()
          .setColor(0xF1C40F)
          .setTitle('📅 Next Meeting')
          .setDescription(`${meetingInfo.date}${meetingInfo.time ? ` at ${meetingInfo.time}` : ""} (UK time)`);
        message.reply({ embeds: [fallbackEmbed] });
      } else {
        console.log(`❌ [${currentCount}] No meeting scheduled`);
        message.reply(
          "No meeting scheduled yet. Use `!setmeeting <date> <time>` to set one.",
        );
      }
      console.log(`🏁 [${currentCount}] !nextmeeting completed`);
      break;

    case "setmeeting":
      console.log(`📅 [${currentCount}] Processing !setmeeting`);
      if (args.length === 0) {
        console.log(`ℹ️ [${currentCount}] Showing setmeeting help`);
        const setMeetingHelpEmbed = new EmbedBuilder()
          .setColor(0x0099FF)
          .setTitle('📅 How to Set a Meeting')
          .setDescription('**Usage:** `!setmeeting <date> [time]`')
          .addFields(
              { name: 'Examples (UK Time)', value: '`!setmeeting December 15 7pm`\n`!setmeeting next friday`\n`!setmeeting 2024-12-15 19:00`' },
              { name: 'Note', value: 'If no time is specified, defaults to 7:00 PM UK time' }
          );
        return message.reply({ embeds: [setMeetingHelpEmbed] });
        return;
      }

      let dateStr, timeStr;
      if (args.length >= 2) {
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

      console.log(`   Date: ${dateStr}, Time: ${timeStr}`);

      try {
        const parsedDate = parseMeetingDateTime(dateStr, timeStr);

        if (!parsedDate.isValid) {
          console.log(`❌ [${currentCount}] Invalid date format`);
          return message.reply(
            '❌ Could not understand that date/time. Try formats like "December 15 7pm" or "next friday"',
          );
        }

        if (parsedDate <= DateTime.now().setZone(DEFAULT_TIMEZONE)) {
          console.log(`❌ [${currentCount}] Date in past`);
          return message.reply("❌ Please set a meeting time in the future.");
        }

        meetingInfo.date = parsedDate.toLocaleString(DateTime.DATE_FULL);
        meetingInfo.time = parsedDate.toLocaleString(DateTime.TIME_SIMPLE);
        meetingInfo.isoDate = parsedDate.toISO();

        let eventUrl = null;
        try {
          
            if (message.guild) {
              const event = await createBookClubEvent(
                message.guild,
                parsedDate,
                `Booq Club Discussion - ${parsedDate.toLocaleString(DateTime.DATETIME_FULL)}`,
                process.env.VOICE_CHANNEL_ID || null 
              );
            meetingInfo.eventId = event.id;
            eventUrl = event.url;
          }
        } catch (error) {
          console.error(`⚠️ [${currentCount}] Failed to create event:`, error);
        }

        storage.meetingInfo = meetingInfo;
        await saveStorage(storage);

        console.log(`✅ [${currentCount}] Meeting set successfully`);
        
        const successEmbed = new EmbedBuilder()
            .setColor(0x00FF00)
            .setTitle('✅ Meeting Set!')
            .addFields({ name: 'When', value: formatMeetingDate(meetingInfo.isoDate) });
        
        if (eventUrl) {
            successEmbed.addFields({ name: '📅 Discord Event', value: eventUrl });
        }

        message.reply({ embeds: [successEmbed] });
      } catch (error) {
        console.error(`💥 [${currentCount}] Error setting meeting:`, error);
        message.reply("❌ Sorry, there was an error setting the meeting.");
      }
      console.log(`🏁 [${currentCount}] !setmeeting completed`);
      break;

    case "clearevent":
      console.log(`🗑️ [${currentCount}] Processing !clearevent`);
      try {
        let responseMessage = "";
        
        if (meetingInfo.eventId) {
          try {
            const guild = message.guild;
            if (guild) {
              const event = await guild.scheduledEvents.fetch(meetingInfo.eventId);
              await event.delete();
              responseMessage += "✅ **Discord event deleted**\n";
              console.log(`✅ [${currentCount}] Discord event deleted`);
            }
          } catch (error) {
            console.log(`⚠️ [${currentCount}] Event not found:`, error.message);
            responseMessage += "⚠️ *Discord event was not found (may have been deleted already)*\n";
          }
        }
        
        const oldMeetingInfo = { ...meetingInfo };
        
        meetingInfo = {
          date: null,
          time: null,
          eventId: null,
          isoDate: null,
        };
        
        storage.meetingInfo = meetingInfo;
        await saveStorage(storage);
        
        responseMessage += "✅ **Meeting data cleared!**\n";
        
        if (oldMeetingInfo.date) {
          responseMessage += `*Cleared: ${oldMeetingInfo.date}${oldMeetingInfo.time ? ` at ${oldMeetingInfo.time}` : ''}*`;
        }
        
        console.log(`✅ [${currentCount}] Meeting data cleared`);
        
        const clearEmbed = new EmbedBuilder()
            .setColor(0xE74C3C) // Red/Orange
            .setTitle('🗑️ Meeting Cleared')
            .setDescription(responseMessage);
        
        message.reply({ embeds: [clearEmbed] });
        
      } catch (error) {
        console.error(`💥 [${currentCount}] Error clearing event:`, error);
        message.reply("❌ Sorry, there was an error clearing the event data.");
      }
      console.log(`🏁 [${currentCount}] !clearevent completed`);
      break;

    case "currentpoint":
      console.log(`📖 [${currentCount}] Processing !currentpoint`);
      if (currentPoint) {
        console.log(`✅ [${currentCount}] Sending current point`);
        const pointEmbed = new EmbedBuilder()
            .setColor(0x0099FF)
            .setTitle('📖 Current Reading Point')
            .setDescription(`**${currentPoint}**`);
        message.reply({ embeds: [pointEmbed] });
      } else {
        console.log(`❌ [${currentCount}] No reading point set`);
        message.reply(
          "No reading point set yet. Use `!setpoint <description>` to set one.",
        );
      }
      console.log(`🏁 [${currentCount}] !currentpoint completed`);
      break;

    case "setpoint":
      console.log(`📝 [${currentCount}] Processing !setpoint`);
      if (args.length === 0) {
        console.log(`ℹ️ [${currentCount}] Showing setpoint help`);
        const setPointHelpEmbed = new EmbedBuilder()
            .setColor(0x0099FF)
            .setTitle('📝 How to Set Reading Point')
            .setDescription('**Usage:** `!setpoint <description>`')
            .addFields({ name: 'Examples', value: '`!setpoint Through Chapter 8`\n`!setpoint Page 150`' });
        return message.reply({ embeds: [setPointHelpEmbed] });
        return;
      }

      const newPoint = args.join(" ");
      currentPoint = newPoint;
      storage.readingPoint = newPoint;
      await saveStorage(storage);

      console.log(`✅ [${currentCount}] Reading point updated: ${newPoint}`);
      const setPointEmbed = new EmbedBuilder()
            .setColor(0x00FF00)
            .setTitle('✅ Reading Point Updated')
            .setDescription(`**Read until:** ${currentPoint}`);
      message.reply({ embeds: [setPointEmbed] });
      console.log(`🏁 [${currentCount}] !setpoint completed`);
      break;

    case "link":
      console.log(`🔗 [${currentCount}] Processing !link`);
      const linkEmbed = new EmbedBuilder()
            .setColor(0x0099FF)
            .setTitle('🔗 Booq Club Spreadsheet')
            .setDescription('Click the link below to view the book list.')
            .addFields({ name: 'Link', value: 'https://docs.google.com/spreadsheets/d/1TRraVAkBbpZHz0oLLe0TRkx9i8F4OwAUMkP4gm74nYs/edit' });
      message.reply({ embeds: [linkEmbed] });
      console.log(`🏁 [${currentCount}] !link completed`);
      break;

    case "timehelp":
      console.log(`⏰ [${currentCount}] Processing !timehelp`);
      const timeHelpEmbed = new EmbedBuilder()
            .setColor(0x0099FF)
            .setTitle('⏰ Date & Time Formats')
            .setDescription('All times are in **UK Time**.')
            .addFields(
                { name: 'Dates', value: '• `December 15`\n• `15 Dec`\n• `2024-12-15`\n• `next friday`' },
                { name: 'Times', value: '• `7pm`\n• `19:00`' },
                { name: 'Examples', value: '• `!setmeeting december 15 7pm`\n• `!setmeeting "15 december" "19:30"`' }
            );
      message.reply({ embeds: [timeHelpEmbed] });
      console.log(`🏁 [${currentCount}] !timehelp completed`);
      break;

    default:
      console.log(`❓ [${currentCount}] Unknown command: ${command}`);
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
const gracefulShutdown = async (signal) => {
  console.log(`🛑 ${signal} received. Shutting down gracefully...`);
  
  uptimeMonitor.stopHeartbeats();
  await mongoose.disconnect();
  client.destroy();
  process.exit(0);
};

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

const token = process.env.DISCORD_BOT_TOKEN;

if (!token) {
  console.error("❌ Error: DISCORD_BOT_TOKEN is not set!");
  process.exit(1);
}

// Start the bot
initializeBot();
