/**
 * Run this ONCE to register the /checkupdate slash command with Discord.
 * Usage: node register_commands.js
 */

require("dotenv").config();
const { REST, Routes, SlashCommandBuilder } = require("discord.js");

const commands = [
  new SlashCommandBuilder()
    .setName("checkupdate")
    .setDescription("Manually trigger a check for Gunyah's Gorilla Horror updates")
    .toJSON(),
];

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log("Registering slash commands...");
    await rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID), { body: commands });
    console.log("✅ Slash commands registered successfully.");
  } catch (err) {
    console.error("Failed to register commands:", err);
  }
})();
