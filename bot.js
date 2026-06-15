/**
 * Gunyah's Gorilla Horror - Auto Update Bot
 * ==========================================
 * Monitors Meta Quest for game updates, downloads the APK,
 * extracts the il2cpp $config exports file, and posts it to Discord.
 *
 * Requirements:
 *   npm install discord.js axios adm-zip dotenv node-cron
 */

require("dotenv").config();
const { Client, GatewayIntentBits, AttachmentBuilder, EmbedBuilder } = require("discord.js");
const axios = require("axios");
const AdmZip = require("adm-zip");
const cron = require("node-cron");
const fs = require("fs");
const path = require("path");

// ─── Config ──────────────────────────────────────────────────────────────────

const APP_ID = "7190422614401072"; // Gunyah's Gorilla Horror
const META_API_URL = `https://www.meta.com/en-gb/experiences/animal-company/${APP_ID}/`;

// APKPure download URL pattern for Meta Quest apps (sidequest/apkpure mirror)
// We use APKPure's API to fetch the latest APK info
const APKPURE_API = "https://api.pureapk.com/m/v3/cms/app_version_list";
const PACKAGE_NAME = "woosterGames.animalCompany"; // adjust if different

// State file to persist last known version between restarts
const STATE_FILE = path.join(__dirname, "last_version.json");

// ─── Helpers ─────────────────────────────────────────────────────────────────

function loadLastVersion() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    }
  } catch (_) {}
  return { versionCode: null, versionName: null };
}

function saveLastVersion(data) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
}

/**
 * Fetch the latest version info for the app from Meta's public GraphQL API.
 * Meta exposes app version info via their store GraphQL endpoint.
 */
async function fetchLatestMetaVersion() {
  const query = `
    {
      node(id: "${APP_ID}") {
        ... on Application {
          displayName
          latestSupportedBinary {
            version
            versionCode
            changeLog
            releaseDate
          }
        }
      }
    }
  `;

  const res = await axios.post(
    "https://graph.oculus.com/graphql",
    new URLSearchParams({
      access_token: "OC|1317831034928749|",  // public Meta/Oculus access token
      doc: query,
    }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );

  const app = res.data?.data?.node;
  if (!app) throw new Error("Could not fetch app data from Meta API");

  const binary = app.latestSupportedBinary;
  return {
    name: app.displayName,
    versionName: binary?.version ?? "unknown",
    versionCode: binary?.versionCode ?? "unknown",
    changeLog: binary?.changeLog ?? "No changelog provided.",
    releaseDate: binary?.releaseDate ?? null,
  };
}

/**
 * Download the APK for the given package from APKPure.
 * Returns a Buffer of the APK bytes.
 */
async function downloadApkFromApkPure(packageName, versionCode) {
  console.log(`[APK] Fetching version list for ${packageName}...`);

  // Step 1: get version list
  const listRes = await axios.get(APKPURE_API, {
    params: { package_name: packageName, hl: "en" },
    headers: { "User-Agent": "APKPure/3.19.26 (Linux; Android 11)" },
  });

  const versions = listRes.data?.data?.list;
  if (!versions || versions.length === 0) {
    throw new Error("No APK versions found on APKPure for this package.");
  }

  // Step 2: find matching version or take the latest
  const match = versions.find((v) => String(v.versionCode) === String(versionCode)) ?? versions[0];
  const downloadUrl = match.apk_download_url ?? match.download_url;

  if (!downloadUrl) throw new Error("Could not find a download URL for the APK.");

  console.log(`[APK] Downloading ${match.versionName} (${match.versionCode}) from ${downloadUrl}`);

  const apkRes = await axios.get(downloadUrl, {
    responseType: "arraybuffer",
    headers: { "User-Agent": "APKPure/3.19.26 (Linux; Android 11)" },
    maxRedirects: 5,
    timeout: 120_000,
  });

  return Buffer.from(apkRes.data);
}

/**
 * Search all entries in the APK (ZIP) for il2cpp export data.
 * Returns an array of { entryName, content } for every matching file found.
 */
function findConfigEntriesInApk(apkBuffer) {
  const zip = new AdmZip(apkBuffer);
  const entries = zip.getEntries();
  const found = [];

  for (const entry of entries) {
    if (entry.header.size > 20_000_000) continue; // skip huge binaries
    try {
      const content = entry.getData().toString("utf8");
      if (
        content.includes("findExportByName") &&
        (content.includes("Il2Cpp.$config.exports") || content.includes("il2cpp_init"))
      ) {
        console.log(`[ZIP] Found il2cpp config at: ${entry.entryName}`);
        found.push({ entryName: entry.entryName, content });
      }
    } catch (_) {}
  }

  return found;
}

/**
 * Parse every key: () => Il2Cpp.module.findExportByName("VALUE") pair
 * from raw source text (handles any whitespace / line format).
 * Returns an array of { key, symbol } objects.
 */
function parseExports(source) {
  // Matches:  some_key: () => Il2Cpp.module.findExportByName("SYMBOL")
  const RE = /(\w+)\s*:\s*\(\s*\)\s*=>\s*Il2Cpp\.module\.findExportByName\(\s*["']([^"']+)["']\s*\)/g;
  const exports = [];
  let m;
  while ((m = RE.exec(source)) !== null) {
    exports.push({ key: m[1], symbol: m[2] });
  }
  return exports;
}

/**
 * Build a clean, fully-formatted Il2Cpp.$config.exports = { ... } block
 * from an array of { key, symbol } pairs.
 */
function formatExports(exportPairs, versionName) {
  const lines = exportPairs.map(
    ({ key, symbol }) =>
      `\t${key}: () => Il2Cpp.module.findExportByName("${symbol}"),`
  );

  return [
    `// Gunyah's Gorilla Horror — il2cpp export config`,
    `// Version: ${versionName}`,
    `// Generated: ${new Date().toUTCString()}`,
    `// Total exports: ${exportPairs.length}`,
    ``,
    `Il2Cpp.$config.exports = {`,
    ...lines,
    `};`,
    ``,
  ].join("\n");
}

/**
 * Main extraction entry point.
 * Finds all il2cpp config entries in the APK, merges their exports
 * (deduplicating by key), and returns a single formatted JS file.
 */
function extractConfigFromApk(apkBuffer, versionName = "unknown") {
  const entries = findConfigEntriesInApk(apkBuffer);

  if (entries.length === 0) {
    throw new Error("Could not find any il2cpp config data inside the APK.");
  }

  // Merge exports from all found entries, deduplicate by key (last write wins)
  const exportMap = new Map();
  for (const { entryName, content } of entries) {
    const pairs = parseExports(content);
    console.log(`[Extract] ${entryName} → ${pairs.length} exports parsed`);
    for (const pair of pairs) {
      exportMap.set(pair.key, pair.symbol);
    }
  }

  if (exportMap.size === 0) {
    throw new Error("Found config file(s) but could not parse any export entries.");
  }

  console.log(`[Extract] Total unique exports: ${exportMap.size}`);

  // Reconstruct as sorted array (keeps il2cpp_* functions in alphabetical order)
  const exportPairs = Array.from(exportMap.entries())
    .map(([key, symbol]) => ({ key, symbol }))
    .sort((a, b) => a.key.localeCompare(b.key));

  const formatted = formatExports(exportPairs, versionName);

  return {
    filename: `il2cpp_config_v${versionName}.js`,
    content: formatted,
    count: exportPairs.length,
  };
}

// ─── Discord Bot ─────────────────────────────────────────────────────────────

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

async function postUpdate(versionInfo, configFile) {
  const channel = await client.channels.fetch(process.env.DISCORD_CHANNEL_ID);
  if (!channel) throw new Error("Discord channel not found.");

  const embed = new EmbedBuilder()
    .setTitle("🦍 Gunyah's Gorilla Horror — New Update Detected!")
    .setColor(0x8b0000)
    .addFields(
      { name: "Version", value: versionInfo.versionName, inline: true },
      { name: "Version Code", value: String(versionInfo.versionCode), inline: true },
      {
        name: "Released",
        value: versionInfo.releaseDate
          ? new Date(versionInfo.releaseDate * 1000).toUTCString()
          : "Unknown",
        inline: false,
      },
      {
        name: "Exports Found",
        value: configFile.count ? `${configFile.count} exports` : "N/A",
        inline: true,
      },
      {
        name: "Changelog",
        value: versionInfo.changeLog?.slice(0, 1000) || "None provided.",
        inline: false,
      }
    )
    .setFooter({ text: `App ID: ${APP_ID}` })
    .setTimestamp();

  const attachment = new AttachmentBuilder(Buffer.from(configFile.content), {
    name: configFile.filename || "il2cpp_config.js",
  });

  await channel.send({ embeds: [embed], files: [attachment] });
  console.log(`[Discord] Posted update for version ${versionInfo.versionName}`);
}

// ─── Main Update Check Loop ───────────────────────────────────────────────────

async function checkForUpdate() {
  console.log(`[Check] ${new Date().toISOString()} — Checking for updates...`);

  let versionInfo;
  try {
    versionInfo = await fetchLatestMetaVersion();
  } catch (err) {
    console.error("[Check] Failed to fetch version from Meta:", err.message);
    return;
  }

  const last = loadLastVersion();

  if (String(versionInfo.versionCode) === String(last.versionCode)) {
    console.log(`[Check] No update. Current: ${versionInfo.versionName} (${versionInfo.versionCode})`);
    return;
  }

  console.log(
    `[Check] UPDATE FOUND! ${last.versionName ?? "unknown"} → ${versionInfo.versionName} (${versionInfo.versionCode})`
  );

  let configFile;
  try {
    const apkBuffer = await downloadApkFromApkPure(PACKAGE_NAME, versionInfo.versionCode);
    configFile = extractConfigFromApk(apkBuffer, versionInfo.versionName);
  } catch (err) {
    console.error("[APK] Failed to download/extract APK:", err.message);
    // Still notify Discord about the update even if APK extraction fails
    configFile = {
      filename: "il2cpp_config_unavailable.txt",
      content: `Could not extract config automatically.\nError: ${err.message}\n\nVersion: ${versionInfo.versionName} (${versionInfo.versionCode})`,
    };
  }

  try {
    await postUpdate(versionInfo, configFile);
  } catch (err) {
    console.error("[Discord] Failed to post update:", err.message);
    return;
  }

  // Save the new version ONLY after successfully posting
  saveLastVersion({ versionCode: versionInfo.versionCode, versionName: versionInfo.versionName });
}

// ─── Bot Ready ────────────────────────────────────────────────────────────────

client.once("ready", async () => {
  console.log(`[Bot] Logged in as ${client.user.tag}`);

  // Run once immediately on startup
  await checkForUpdate();

  // Then poll every 15 minutes
  cron.schedule("*/15 * * * *", checkForUpdate);
  console.log("[Bot] Polling every 15 minutes.");
});

// ─── Slash Command: /checkupdate ─────────────────────────────────────────────
// Register with: node register_commands.js

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "checkupdate") {
    await interaction.reply({ content: "🔍 Checking for updates now...", ephemeral: true });
    await checkForUpdate();
    await interaction.editReply({ content: "✅ Check complete! See the update channel if anything was found." });
  }
});

client.login(process.env.DISCORD_TOKEN);
