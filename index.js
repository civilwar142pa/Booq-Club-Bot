const { Client, GatewayIntentBits, ActivityType, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder } = require("discord.js");
const express = require("express");
const { getSheetData } = require("./sheets");
const { DateTime } = require("luxon");
const fetch = require("node-fetch");
const mongoose = require("mongoose");
const SpotifyWebApi = require("spotify-web-api-node");

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

// Poll Schema for persistent voting
const PollSchema = new mongoose.Schema({
  messageId: String,
  channelId: String,
  title: String,
  expiresAt: Date,
  votes: { type: Map, of: Number, default: {} },
  isActive: { type: Boolean, default: true }
});

const Poll = mongoose.model("Poll", PollSchema);

// Spotify Token Schema
const SpotifyTokenSchema = new mongoose.Schema({
  _id: { type: String, default: "main_token" },
  data: Object // Stores access_token, refresh_token, expires_at, etc.
});
const SpotifyToken = mongoose.model("SpotifyToken", SpotifyTokenSchema);

const POLL_OPTIONS = [
  { label: "0", value: "0" },
  { label: "1⭐️", value: "1" },
  { label: "1.5⭐️💫", value: "1.5" },
  { label: "2⭐️⭐️", value: "2" },
  { label: "2.5⭐️⭐️💫", value: "2.5" },
  { label: "3⭐️⭐️⭐️", value: "3" },
  { label: "3.5⭐️⭐️⭐️💫", value: "3.5" },
  { label: "4⭐️⭐️⭐️⭐️", value: "4" },
  { label: "4.5⭐️⭐️⭐️⭐️💫", value: "4.5" },
  { label: "5⭐️⭐️⭐️⭐️⭐️", value: "5" }
];

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

// SPOTIFY SERVICE
class SpotifyService {
  constructor() {
    this.isEnabled = !!(process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET);
    if (!this.isEnabled) {
      console.warn("⚠️ Spotify credentials missing. Spotify commands will be disabled.");
      return;
    }

    this.api = new SpotifyWebApi({
      clientId: process.env.SPOTIFY_CLIENT_ID,
      clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
      redirectUri: process.env.SPOTIFY_REDIRECT_URI || "http://localhost:3000/callback"
    });
    this.playlistId = process.env.SPOTIFY_PLAYLIST_ID;
  }

  async init() {
    if (!this.isEnabled) return;
    try {
      const doc = await SpotifyToken.findById("main_token");
      if (doc && doc.data) {
        this.api.setAccessToken(doc.data.access_token);
        this.api.setRefreshToken(doc.data.refresh_token);
        console.log("🎵 Spotify tokens loaded from MongoDB");
        await this.refreshIfNeeded(doc.data);
      } else {
        console.log("⚠️ No Spotify tokens found in DB. Run !spotifyauth");
      }
    } catch (error) {
      console.error("❌ Spotify Init Error:", error);
    }
  }

  async refreshIfNeeded(tokenData) {
    const now = Math.floor(Date.now() / 1000);
    // Refresh if expired or expiring in next 5 minutes
    if (tokenData.expires_at && now > tokenData.expires_at - 300) {
      console.log("🔄 Refreshing Spotify Access Token...");
      try {
        const data = await this.api.refreshAccessToken();
        await this.saveTokens(data.body);
      } catch (error) {
        console.error("❌ Error refreshing Spotify token:", error);
      }
    }
  }

  async saveTokens(body) {
    const current = (await SpotifyToken.findById("main_token"))?.data || {};
    
    // Merge new data with old (to keep refresh_token if not returned)
    const newData = { ...current, ...body };
    
    // Calculate absolute expiration time
    if (body.expires_in) {
      newData.expires_at = Math.floor(Date.now() / 1000) + body.expires_in;
    }

    this.api.setAccessToken(newData.access_token);
    if (newData.refresh_token) this.api.setRefreshToken(newData.refresh_token);

    await SpotifyToken.findByIdAndUpdate("main_token", { data: newData }, { upsert: true });
    console.log("💾 Spotify tokens saved");
  }

  getAuthUrl() {
    const scopes = ['playlist-modify-public', 'playlist-modify-private'];
    return this.api.createAuthorizeURL(scopes, 'state');
  }

  async searchAndAdd(query) {
    await this.refreshIfNeeded((await SpotifyToken.findById("main_token"))?.data || {});
    
    const searchRes = await this.api.searchTracks(query, { limit: 1 });
    if (!searchRes.body.tracks.items.length) return null;

    const track = searchRes.body.tracks.items[0];
    
    // Check duplicates (simple check)
    const playlistTracks = await this.api.getPlaylistTracks(this.playlistId);
    const isDuplicate = playlistTracks.body.items.some(item => item.track.id === track.id);
    
    if (isDuplicate) {
      return { track, status: "duplicate" };
    }

    await this.api.addTracksToPlaylist(this.playlistId, [track.uri]);
    return { track, status: "added" };
  }

  async removeSong(query) {
    await this.refreshIfNeeded((await SpotifyToken.findById("main_token"))?.data || {});
    
    // 1. Search for the track to get URI
    const searchRes = await this.api.searchTracks(query, { limit: 1 });
    if (!searchRes.body.tracks.items.length) return { status: "not_found" };
    
    const trackTarget = searchRes.body.tracks.items[0];

    // 2. Scan playlist to see if it's there
    const playlistTracks = await this.api.getPlaylistTracks(this.playlistId);
    const match = playlistTracks.body.items.find(item => item.track.id === trackTarget.id);

    if (!match) return { status: "not_in_playlist", track: trackTarget };

    // 3. Remove
    await this.api.removeTracksFromPlaylist(this.playlistId, [{ uri: trackTarget.uri }]);
    return { status: "removed", track: trackTarget };
  }

  async getPlaylistLink() {
    try {
      const data = await this.api.getPlaylist(this.playlistId);
      return data.body.external_urls.spotify;
    } catch (e) {
      return null;
    }
  }
}

const spotifyService = new SpotifyService();

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

// Spotify Callback Endpoint
app.get("/callback", async (req, res) => {
  const error = req.query.error;
  const code = req.query.code;

  if (error) {
    return res.send(`Callback Error: ${error}`);
  }

  try {
    const data = await spotifyService.api.authorizationCodeGrant(code);
    await spotifyService.saveTokens(data.body);
    res.send('✅ Spotify authentication successful! You can close this window.');
  } catch (error) {
    console.error('Error getting Tokens:', error);
    res.send(`Error getting Tokens: ${error}`);
  }
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

      // 3. Initialize Spotify
      await spotifyService.init();
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

  // Recover active polls
  (async () => {
    try {
      const activePolls = await Poll.find({ isActive: true });
      if (activePolls.length > 0) {
        console.log(`📊 Found ${activePolls.length} active polls to recover.`);
        for (const poll of activePolls) {
          try {
            const channel = await client.channels.fetch(poll.channelId);
            if (channel) {
              const message = await channel.messages.fetch(poll.messageId);
              if (message) {
                monitorPoll(poll, message);
                console.log(`   Recovered poll: ${poll.title}`);
              }
            }
          } catch (err) {
            console.error(`   Failed to recover poll ${poll.title}:`, err.message);
          }
        }
      }
    } catch (error) {
      console.error("Error loading active polls:", error);
    }
  })();

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

// Poll Helper Functions
async function finishPoll(poll, message) {
  if (!poll.isActive) return null;

  let totalScore = 0;
  let totalVotes = 0;
  
  if (poll.votes && poll.votes.size > 0) {
    totalVotes = poll.votes.size;
    for (const score of poll.votes.values()) {
      totalScore += score;
    }
  }

  const average = totalVotes > 0 ? (totalScore / totalVotes).toFixed(2) : "N/A";

  const resultEmbed = new EmbedBuilder()
    .setColor(0x00FF00)
    .setTitle(`📊 Poll Results: ${poll.title}`)
    .setDescription(`**Average Score:** ${average}/5\n**Total Votes:** ${totalVotes}`)
    .setTimestamp();

  try {
    if (message) {
      const disabledSelect = new StringSelectMenuBuilder()
        .setCustomId('poll_select_ended')
        .setPlaceholder('Poll Ended')
        .setDisabled(true)
        .addOptions(POLL_OPTIONS); // Reuse options for visual consistency

      const disabledRow = new ActionRowBuilder().addComponents(disabledSelect);
      
      await message.edit({ components: [disabledRow] });
      await message.reply({ embeds: [resultEmbed] });
    }
  } catch (error) {
    console.error("Error finishing poll:", error);
  }

  poll.isActive = false;
  await poll.save();
  return resultEmbed;
}

function monitorPoll(poll, message) {
  const now = new Date();
  const remainingTime = poll.expiresAt - now;

  if (remainingTime <= 0) {
    finishPoll(poll, message);
    return;
  }

  const collector = message.createMessageComponentCollector({ time: remainingTime });

  collector.on('collect', async i => {
    const value = parseFloat(i.values[0]);
    
    // Update vote in DB
    if (!poll.votes) poll.votes = new Map();
    poll.votes.set(i.user.id, value);
    poll.markModified('votes');
    await poll.save();

    const label = POLL_OPTIONS.find(o => o.value === i.values[0])?.label || value;
    await i.reply({ content: `You voted: ${label}`, ephemeral: true });
  });

  collector.on('end', (collected, reason) => {
    if (reason === 'time') {
      finishPoll(poll, message);
    }
  });
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
          { name: '🎵 Spotify', value: '`!addsong <name>` - Add to playlist\n`!deletesong <name>` - Remove from playlist\n`!spotifylink` - Get playlist link' },
          { name: '⚙️ Utility', value: '`!poll` - Start a voting poll\n`!setpoint` - Set reading goal\n`!clearpoint` - Clear reading goal\n`!link` - Spreadsheet link\n`!timehelp` - Date format help\n`!status` - Bot health' }
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

    case "spotifyauth":
      if (!spotifyService.isEnabled) return message.reply("Spotify is not configured.");
      const authUrl = spotifyService.getAuthUrl();
      const authEmbed = new EmbedBuilder()
        .setColor(0x1DB954)
        .setTitle('🔐 Spotify Authentication')
        .setDescription(`Click here to authorize the bot`)
        .setFooter({ text: 'Only required once or if tokens expire completely' });
      message.reply({ embeds: [authEmbed] });
      break;

    case "spotifylink":
      const sLink = await spotifyService.getPlaylistLink();
      if (sLink) {
        message.reply(`🎵 **Spotify Playlist:**\n${sLink}`);
      } else {
        message.reply("Could not retrieve playlist link.");
      }
      break;

    case "addsong":
      if (!args.length) return message.reply("Usage: `!addsong <song name>`");
      const query = args.join(" ");
      message.channel.sendTyping();
      
      try {
        const result = await spotifyService.searchAndAdd(query);
        if (!result) {
          message.reply("❌ Could not find that song.");
        } else if (result.status === "duplicate") {
          message.reply(`⚠️ **${result.track.name}** by ${result.track.artists[0].name} is already in the playlist!`);
        } else {
          const addEmbed = new EmbedBuilder()
            .setColor(0x1DB954)
            .setTitle('✅ Song Added')
            .setDescription(`**${result.track.name}**\n*by ${result.track.artists[0].name}*`)
            .setThumbnail(result.track.album.images[0]?.url);
          message.reply({ embeds: [addEmbed] });
        }
      } catch (err) {
        console.error(err);
        message.reply("❌ Error adding song. The bot might need re-authentication (`!spotifyauth`).");
      }
      break;

    case "deletesong":
      if (!args.length) return message.reply("Usage: `!deletesong <song name>`");
      const delQuery = args.join(" ");
      message.channel.sendTyping();

      try {
        const result = await spotifyService.removeSong(delQuery);
        
        if (result.status === "not_found") {
          message.reply("❌ Could not find that song on Spotify to identify it.");
        } else if (result.status === "not_in_playlist") {
          message.reply(`⚠️ Found **${result.track.name}**, but it's not in the playlist.`);
        } else {
          const delEmbed = new EmbedBuilder()
            .setColor(0xE74C3C)
            .setTitle('🗑️ Song Removed')
            .setDescription(`**${result.track.name}**\n*by ${result.track.artists[0].name}*`);
          message.reply({ embeds: [delEmbed] });
        }
      } catch (err) {
        console.error(err);
        message.reply("❌ Error removing song.");
      }
      break;

    case "poll":
      console.log(`📊 [${currentCount}] Processing !poll`);
      if (args.length === 0) {
        const pollHelpEmbed = new EmbedBuilder()
          .setColor(0x0099FF)
          .setTitle('📊 How to use Poll')
          .setDescription('**Usage:** `!poll <title>`\nCreates a rating poll that lasts for 3 days.')
          .addFields({ name: 'Example', value: '`!poll Rate this week\'s book`' });
        message.reply({ embeds: [pollHelpEmbed] });
        return;
      }

      const pollTitle = args.join(" ");
      const pollDuration = 3 * 24 * 60 * 60 * 1000; // 3 days
      
      const pollEmbed = new EmbedBuilder()
        .setColor(0x0099FF)
        .setTitle(`📊 ${pollTitle}`)
        .setDescription(`Select your rating from the menu below!\n\n*Poll ends in 3 days.*`)
        .setFooter({ text: 'Booq Club Poll' })
        .setTimestamp();

      const selectMenu = new StringSelectMenuBuilder()
        .setCustomId('poll_select')
        .setPlaceholder('Select a rating...')
        .addOptions(POLL_OPTIONS);

      const row = new ActionRowBuilder()
        .addComponents(selectMenu);

      const pollMessage = await message.channel.send({ embeds: [pollEmbed], components: [row] });
      
      // Save to DB
      const newPoll = new Poll({
        messageId: pollMessage.id,
        channelId: message.channel.id,
        title: pollTitle,
        expiresAt: new Date(Date.now() + pollDuration),
        votes: {},
        isActive: true
      });
      
      await newPoll.save();

      // Start monitoring
      monitorPoll(newPoll, pollMessage);

      console.log(`✅ [${currentCount}] Poll started: ${pollTitle}`);
      break;

    case "endpoll":
      console.log(`🛑 [${currentCount}] Processing !endpoll`);
      try {
        const activePoll = await Poll.findOne({ 
          channelId: message.channel.id, 
          isActive: true 
        }).sort({ _id: -1 });

        if (!activePoll) {
          message.reply("No active poll found in this channel.");
          return;
        }

        let pollMessage = null;
        try {
          pollMessage = await message.channel.messages.fetch(activePoll.messageId);
        } catch (e) {
          console.log("Original poll message not found");
        }

        const result = await finishPoll(activePoll, pollMessage);
        
        if (!pollMessage && result) {
           message.reply({ content: "✅ Poll ended. (Original message not found)", embeds: [result] });
        } else {
           message.reply("✅ Poll ended.");
        }
      } catch (error) {
        console.error(`💥 [${currentCount}] Error ending poll:`, error);
        message.reply("❌ An error occurred while trying to end the poll.");
      }
      console.log(`🏁 [${currentCount}] !endpoll completed`);
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
