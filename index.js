const { Client, ActivityType, EmbedBuilder, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const express = require("express"); //
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

// Emojis and their corresponding star values for the poll
const pollOptions = [
  {label: "1 star", value: 1.0},
  {label: "1.5 stars", value: 1.5},
  {label: "2 stars", value: 2.0},
  {label: "2.5 stars", value: 2.5},
  {label: "3 stars", value: 3.0},
  {label: "3.5 stars", value: 3.5},
  {label: "4 stars", value: 4.0},
  {label: "4.5 stars", value: 4.5},
  {label: "5 stars", value: 5.0}
];

// Function to end a poll and calculate results
async function endPoll(pollData) {
  console.log(`Ending poll: ${pollData.title} (Message ID: ${pollData.messageId})`);
  try {
    const channel = await client.channels.fetch(pollData.channelId);
    if (!channel) {
      console.error(`Channel ${pollData.channelId} not found for poll ${pollData.messageId}`);
      await Poll.deleteOne({ messageId: pollData.messageId });
      return;
    }

    const message = await channel.messages.fetch(pollData.messageId);
    if (!message) {
      console.error(`Message ${pollData.messageId} not found in channel ${pollData.channelId}`);
      await Poll.deleteOne({ messageId: pollData.messageId });
      return;
    }

    const reactions = message.reactions.cache;
    let totalScore = 0;
    let totalVotes = 0;
    const results = {};
    
    // Initialize resultsCount
    pollOptions.forEach(option => {
      results[option.label] = 0;
    });

    // Tally votes from the stored 'votes' map
    for (const [userId, ratingValue] of pollData.votes.entries()) {
      totalScore += ratingValue;
      totalVotes++;
      const optionLabel = pollOptions.find(opt => opt.value === ratingValue)?.label;
      if (optionLabel) {
        results[optionLabel]++;
      }
    }
    let resultDescription = `**Poll: "${pollData.title}" has ended!**\n\n`;
    for (const option of pollOptions) {
      resultDescription += `${option.label}: ${results[option.label] || 0} votes\n`;
    }
    if (totalVotes > 0) {
      const averageRating = (totalScore / totalVotes).toFixed(2);
      resultDescription += `\n**Average Rating: ${averageRating} / 5.0**`;
    } else {
      resultDescription += "\nNo votes were cast.";
    }

    const resultEmbed = new EmbedBuilder()
      .setColor(0x3498DB) // Blue
      .setTitle('📊 Poll Results')
      .setDescription(resultDescription)
      .setTimestamp();

    await channel.send({ embeds: [resultEmbed] });
    await message.unpin().catch(console.error); // Unpin the poll message
    await Poll.deleteOne({ messageId: pollData.messageId }); // Remove from DB
    console.log(`Poll results sent for ${pollData.title}`);
  } catch (error) {
    console.error(`Error ending poll ${pollData.messageId}:`, error);
  }
}

// Function to load active polls from DB and set timers
async function loadActivePolls() {
  const activePolls = await Poll.find({});
  for (const poll of activePolls) {
    const now = DateTime.now().toJSDate();
    if (poll.endTime <= now) {
      await endPoll(poll);
    } else {
      const timeRemaining = poll.endTime.getTime() - now.getTime();
      setTimeout(() => endPoll(poll), timeRemaining);
      console.log(`Rescheduled poll "${poll.title}" to end in ${timeRemaining / (1000 * 60 * 60)} hours.`);
    }
  }
}

const PollSchema = new mongoose.Schema({
  messageId: { type: String, required: true },
  channelId: { type: String, required: true },
  guildId: { type: String, required: true },
  title: { type: String, required: true },
  endTime: { type: Date, required: true },
  votes: { type: Map, of: Number, default: {} }, // New: userId to rating value
  optionsData: [{ // New: structured options for buttons
    label: String,
    value: Number,
    customId: String
  }]
});
const Poll = mongoose.model("Poll", PollSchema);

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
  activePolls: [], // To store active poll data
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
      console.log(`🍃 Connecting to MongoDB using URI: ${process.env.MONGODB_URI.replace(/(\/\/.*?@.*?\/)(.*?(\?|$))/g, '$1<DB_NAME>$2')}`); // Mask sensitive parts for logging
      await mongoose.connect(process.env.MONGODB_URI);
      console.log("✅ Connected to MongoDB");

      // 2. Load saved data
      const savedSettings = await Settings.findById("global_settings");
      if (savedSettings) {
        storage = savedSettings.toObject();
        currentPoint = storage.readingPoint;
        meetingInfo = storage.meetingInfo || meetingInfo;
        console.log("📥 Loaded data from database");
      await loadActivePolls(); // Load and reschedule active polls
      }
    } catch (error) {
      console.error("❌ MongoDB Connection Error:", error);
    }
  } else {
    console.warn("⚠️ MONGODB_URI not set! Data will not persist on restart.");
  }

  let retryCount = 0;
  const maxLoginRetries = 10; // Maximum number of login attempts
  const baseRetryDelayMs = 5000; // 5 seconds base delay

  while (retryCount < maxLoginRetries) {
    try {
      console.log("🤖 Attempting to login to Discord...");
      const loginPromise = client.login(token);
      const timeoutPromise = new Promise((resolve, reject) =>
        setTimeout(() => reject(new Error("Discord login timed out after 60 seconds")), 60000)
      );
      await Promise.race([loginPromise, timeoutPromise]);
      console.log("✅ Bot logged in successfully");
      break; // Exit loop on success
    } catch (error) {
      retryCount++;
      let errorMessage = `❌ Discord login failed (Attempt ${retryCount}/${maxLoginRetries}): ${error.message}`;
      if (error.code) {
        errorMessage += ` (Discord.js Error Code: ${error.code})`;
      }
      console.error(errorMessage, error); // Log the full error object for more details

      if (retryCount < maxLoginRetries) {
        const delay = baseRetryDelayMs * Math.pow(2, retryCount - 1); // Exponential backoff
        console.log(`🔄 Retrying in ${delay / 1000} seconds...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      } else {
        console.error("🔴 Max Discord login retries reached. Exiting process.");
        process.exit(1); // Exit if max retries reached
      }
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
    // Year first
    "yyyy-MM-dd HH:mm", // "2023-12-15 7:00
    "MMM d h:mma", // "Dec 15 7:00pm"
    "MMM d ha", // "Dec 15 7pm"

    //UK Formats
    "d MMMM yyyy HH:mm",
    "d MMMM yyyy h:mma",
    "d MMMM yyyy ha",
    "d MMMM yyyy",
    "d MMM yyyy HH:mm",
    "d MMM yyyy h:mma",
    "d MMM yyyy ha",
    "d MMM yyyy",
    "d/M/yyyy HH:mm",
    "d/M/yyyy h:mma",
    "d/M/yyyy ha",
    "d/M/yyyy",

    //US Formats
    "MMMM d, yyyy HH:mm",
    "MMMM d, yyyy h:mma",
    "MMMM d, yyyy ha",
    "MMMM d, yyyy",
    "MMMM d yyyy HH:mm",
    "MMMM d yyyy h:mma",
    "MMMM d yyyy ha",
    "MMMM d yyyy",
    "MMM d, yyyy HH:mm",
    "MMM d, yyyy h:mma",
    "MMM d, yyyy ha",
    "MMM d, yyyy",
    "MMM d yyyy HH:mm",
    "MMM d yyyy h:mma",
    "MMM d yyyy ha",
    "MMM d yyyy",
    

    //No year Formats
    "MMMM d HH:mm",
    "MMMM d h:mma",
    "MMMM d ha",
    "MMMM d",
    "MMM d HH:mm",
    "MMM d h:mma",
    "MMM d ha",
    "MMM d",
    "d MMMM HH:mm",
    "d MMMM h:mma",
    "d MMMM ha",
    "d MMMM",
    "d MMM HH:mm",
    "d MMM h:mma",
    "d MMM ha",
    "d MMM",
    
  ];

  let parsedDate = null;

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
  if (!parsedDate) {
    const naturalAttempt = DateTime.fromJSDate(new Date(combined), {
      zone: DEFAULT_TIMEZONE,
    });
    if (naturalAttempt.isValid) {
      parsedDate = naturalAttempt;
    }
  }

  if (!parsedDate) {
    return DateTime.invalid("Could not parse date");
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

  // Smart year adjustment:
  // If the date is in the past AND the user didn't explicitly type a year (like "2025" or "2026"),
  // assume they meant the next occurrence of this date (next year).
  const now = DateTime.now().setZone(DEFAULT_TIMEZONE);
  const hasYear = /\b20\d{2}\b/.test(combined); // Checks for 2024, 2025, 2026, etc.

  if (parsedDate.isValid && parsedDate < now && !hasYear) {
    parsedDate = parsedDate.plus({ years: 1 });
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
  
  // Check if command is executed in a guild for guild-specific commands
  const guildOnlyCommands = ['setmeeting', 'clearevent', 'poll', 'random', 'pastreads', 'reading', 'nextmeeting'];
  if (guildOnlyCommands.includes(args[0]?.toLowerCase()) && !message.guild) {
    console.log(`🚫 [${currentCount}] Ignored guild-only command "${args[0]}" in DM`);
    return message.reply("This command can only be used in a server channel, not in a Direct Message.");
  }


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
          { name: '📅 Meetings & Polls', value: '`!nextmeeting` - Meeting info\n`!setmeeting` - Schedule meeting\n`!clearevent` - Cancel meeting\n`!poll <title>` - Create a rating poll\n`!endpoll` - Manually end active poll' },
          { name: '⚙️ Utility', value: '`!setpoint` - Set reading goal\n`!clearpoint` - Clear reading goal\n`!link` - Spreadsheet link\n`!timehelp` - Date format help\n`!status` - Bot health' }
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

      const dbStatus = mongoose.connection.readyState === 1 ? "✅ Connected" : "❌ Disconnected";

      const statusEmbed = new EmbedBuilder()
        .setColor(0x00FF00)
        .setTitle('📊 Bot Status')
        .addFields(
          { name: '🆔 Instance ID', value: `\`${SESSION_ID}\``, inline: true },
          { name: '✅ Online Time\n', value: `${hours}h ${minutes}m ${seconds}s`, inline: true },
          { name: '📊 Servers', value: `${client.guilds.cache.size}`, inline: true },
          { name: '💾 Memory', value: `${memoryUsage} MB`, inline: true },
          { name: '🍃 Database', value: dbStatus, inline: true }
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
            const title = String(book[0] || "Unknown Title").trim();
            const author = String(book[1] || "Unknown Author").trim();
            const link = book[3];
            // Rating is expected in the 5th column (index 4)
            const rating = book[4];
            
            let entry = `**${index + 1}. ${title}** • *by ${author}*`;
            if (rating) entry += ` • ⭐ **${rating}/5**`;
            if (link) entry += ` •[ View Book](${link})`;
            
            return entry;
          }).join("\n\n");

          embed.addFields({ name: 'Recent Books', value: list });

          const spreadsheetLink = "https://docs.google.com/spreadsheets/d/1TRraVAkBbpZHz0oLLe0TRkx9i8F4OwAUMkP4gm74nYs/edit"; //spreadsheet link
          const folderLink = "https://drive.google.com/drive/u/0/folders/1YAyccVd4uYvrLheVSahAn8sXLwwov_Io"; // discussions folder link

          embed.addFields({ 
            name: '📂 Resources', 
            value: `📊 [Spreadsheet](${spreadsheetLink})\n📓 [Book Notes](${folderLink})`
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

    case "clearpoint":
      console.log(`🗑️ [${currentCount}] Processing !clearpoint`);
      
      const previousPoint = currentPoint;
      currentPoint = null;
      storage.readingPoint = null;
      await saveStorage(storage);

      console.log(`✅ [${currentCount}] Reading point cleared`);
      const clearPointEmbed = new EmbedBuilder()
            .setColor(0xE74C3C)
            .setTitle('🗑️ Reading Point Cleared')
            .setDescription(previousPoint ? `**Cleared:** ${previousPoint}` : "Reading point has been removed.");
      message.reply({ embeds: [clearPointEmbed] });
      console.log(`🏁 [${currentCount}] !clearpoint completed`);
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

    case "poll":
      console.log(`📊 [${currentCount}] Processing !poll`);
      if (args.length === 0) {
        console.log(`ℹ️ [${currentCount}] Showing poll help`);
        const pollHelpEmbed = new EmbedBuilder()
          .setColor(0x0099FF)
          .setTitle('📊 How to Create a Rating Poll')
          .setDescription('**Usage:** `!poll <title>`')
          .addFields({ name: 'Example', value: '`!poll "How would you rate the last book?"`' })
        return message.reply({ embeds: [pollHelpEmbed] });
      }

      const pollTitle = args.join(" ");
      const pollEndTime = DateTime.now().plus({ days: 3 }).toJSDate();

      const components = [];
      const newOptionsData = []; // To store options with generated customIds

      const pollEmbed = new EmbedBuilder()
        .setColor(0x3498DB)
        .setTitle(`📊 Poll: ${pollTitle}`)
        .setDescription(`Rate from 1.0 to 5.0 stars using the buttons below!`)
        .addFields(
            { name: 'Duration', value: '3 days', inline: true },
            { name: 'Ends', value: `<t:${Math.floor(pollEndTime.getTime() / 1000)}:F>`, inline: true }
        )
        .setTimestamp();

      // buttons for each poll option
      for (let i = 0; i < pollOptions.length; i += 5) { // Max 5 buttons per row
        const row = new ActionRowBuilder();
        const buttonsInRow = pollOptions.slice(i, i + 5).map(option => {
          const customId = `poll_${Date.now()}_${option.value}`; // Unique ID for each button
          newOptionsData.push({ ...option, customId }); // Store customId
          return new ButtonBuilder()
            .setCustomId(customId)
            .setLabel(option.label)
            .setStyle(ButtonStyle.Primary); // Blue button
        });
        row.addComponents(buttonsInRow);
        components.push(row);
      }

        const pollMessage = await message.channel.send({ embeds: [pollEmbed], components: components });
        // Store poll data in MongoDB
        const newPoll = new Poll({
          messageId: pollMessage.id,
          channelId: pollMessage.channel.id,
          guildId: message.guild.id,
          title: pollTitle,
          endTime: pollEndTime,
          optionsData: newOptionsData, // Store the options with custom IDs
          votes: new Map(), // Initialize with empty votes
        });

        try {
        await newPoll.save();
        console.log(`✅ [${currentCount}] Poll created and saved to DB: ${pollTitle}`);

        // Schedule poll end
        const timeRemaining = pollEndTime.getTime() - Date.now();
        setTimeout(() => endPoll(newPoll), timeRemaining);

        await pollMessage.pin(); // Pin the poll message for visibility

        message.reply(`Poll "${pollTitle}" created and will end in 3 days!`);
      } catch (error) { // This catch handles the try started at the beginning of the case
        console.error(`💥 [${currentCount}] Error creating or saving poll:`, error);
        message.reply("❌ Sorry, there was an error creating the poll.");
      }
      console.log(`🏁 [${currentCount}] !poll completed`);
      break;

    case "endpoll":
      console.log(`🛑 [${currentCount}] Processing !endpoll`);
      try {
        const activePoll = await Poll.findOne({ channelId: message.channel.id });

        if (!activePoll) {
          console.log(`❌ [${currentCount}] No active poll found in this channel`);
          return message.reply("❌ No active poll found in this channel.");
        }

        await endPoll(activePoll); // Call the function to end the poll
        message.reply(`✅ Poll "${activePoll.title}" has been manually ended.`);
      } catch (error) {
        console.error(`💥 [${currentCount}] Error ending poll:`, error);
        message.reply("❌ Sorry, there was an error ending the poll.");
      }
      console.log(`🏁 [${currentCount}] !endpoll completed`);
      break;

    default:
      console.log(`❓ [${currentCount}] Unknown command: ${command}`);
      break;
  }
});

// INTERACTION HANDLER FOR POLL BUTTONS
client.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;

  // Check if the customId starts with 'poll_'
  if (interaction.customId.startsWith('poll_')) {
    const parts = interaction.customId.split('_');
    if (parts.length !== 3) {
      console.warn(`Invalid poll button customId format: ${interaction.customId}`);
      return interaction.reply({ content: 'There was an error processing your vote. Please try again.', ephemeral: true });
    }

    const pollMessageId = interaction.message.id;
    const ratingValue = parseFloat(parts[2]); // The rating value is the third part

    try {
      const poll = await Poll.findOne({ messageId: pollMessageId });

      if (!poll) {
        return interaction.reply({ content: 'This poll no longer exists or has ended.', ephemeral: true });
      }

      if (poll.endTime <= new Date()) {
        return interaction.reply({ content: 'This poll has already ended.', ephemeral: true });
      }

      // Check if user has already voted
      if (poll.votes.has(interaction.user.id)) {
        const existingVote = poll.votes.get(interaction.user.id);
        if (existingVote === ratingValue) {
          return interaction.reply({ content: `You have already voted ${ratingValue} stars for this poll.`, ephemeral: true });
        } else {
          // User is changing their vote
          poll.votes.set(interaction.user.id, ratingValue);
          await poll.save();
          return interaction.reply({ content: `Your vote has been changed to ${ratingValue} stars!`, ephemeral: true });
        }
      }

      // Record the vote
      poll.votes.set(interaction.user.id, ratingValue);
      await poll.save();

      await interaction.reply({ content: `You voted ${ratingValue} stars for "${poll.title}"!`, ephemeral: true });
      console.log(`User ${interaction.user.tag} voted ${ratingValue} for poll ${poll.title}`);

    } catch (error) {
      console.error(`Error processing poll vote for user ${interaction.user.tag}:`, error);
      await interaction.reply({ content: 'There was an error recording your vote. Please try again later.', ephemeral: true });
    }
  } // This closes the 'if (interaction.customId.startsWith('poll_'))' block
}); // This closes the 'client.on('interactionCreate', ...)' block

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
  
  // Force shutdown after 5 seconds if it hangs
  setTimeout(() => {
    console.error("🛑 Shutdown timed out, forcing exit...");
    process.exit(1);
  }, 5000);

  uptimeMonitor.stopHeartbeats();
  try {
    await mongoose.disconnect();
    await client.destroy();
  } catch (error) {
    console.error("Error during shutdown cleanup:", error);
  }
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
