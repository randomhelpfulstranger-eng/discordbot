import connection from '../database/connect.js';
import { writeWinLog } from './dbLog.js';

export default function registerForwardWinlogs(client) {
  client.on('messageCreate', async (message) => {
    if (message.author.id === client.user?.id) return;

    // Source channel/guild filter (keep as-is)
    if (
      // test
      // message.guild?.id !== '1263192728884346913' ||
      // message.channel.id !== '1363104979342065896'
      // prod
      message.guild?.id !== '1171502780108771439' ||
      message.channel.id !== '1411760098392539267'
    ) return;

    const content = message.content.replace(/```/g, '');
    const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
    if (!lines.length) return;

    console.log(`received message on channel starting with line: ${lines[0]}`);

    // 🔁 GET ONLY ROWS WITH A NON-EMPTY CLAN TAG (no wildcard/ALL)
    const [rows] = await connection.execute(
      `SELECT guild_id,
              NULLIF(TRIM(tanks_clan_tag), '') AS tanks_clan_tag,
              NULLIF(TRIM(tanks_winlog_channel_id), '') AS tanks_winlog_channel_id
         FROM clan_discord_details
        WHERE NULLIF(TRIM(tanks_winlog_channel_id), '') IS NOT NULL
          AND NULLIF(TRIM(tanks_clan_tag), '') IS NOT NULL`
    );

    // tag -> recipients (UPPER)
    const tagMap = new Map();
    const add = (k, val) => {
      const key = k.toUpperCase();
      if (!tagMap.has(key)) tagMap.set(key, []);
      tagMap.get(key).push(val);
    };
    for (const r of rows) {
      add(r.tanks_clan_tag, { guildId: r.guild_id, channelId: r.tanks_winlog_channel_id });
    }

    // Process each parsed line
    for (const line of lines) {
      const columns = line.split(/\s+/);
      if (columns.length < 7) continue;

      const clanTag = columns[2]?.trim();
      if (!clanTag) continue;
      const tagKey = clanTag.toUpperCase();

      // Always write to logs DB
      try {
        await writeWinLog({
          ts: new Date(),
          level: 'info',
          source: 'discord:winlogs-forwarder',
          host: message.guild?.id ?? 'unknown',
          message: line,
          raw: {
            messageId: message.id,
            guildId: message.guild?.id ?? null,
            channelId: message.channel.id,
            authorId: message.author.id,
            clanTag,
            firstLine: lines[0] ?? null,
          },
        });
      } catch (e) {
        console.error('writeWinLog failed:', e?.message || e);
      }

      // ✅ ONLY forward to matching clan tag (no wildcard recipients)
      const recipients = tagMap.get(tagKey) ?? [];
      if (!recipients.length) continue;

      const seen = new Set();
      for (const r of recipients) {
        const key = `${r.guildId}:${r.channelId}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const guild = client.guilds.cache.get(r.guildId);
        if (!guild) continue;

        const channel = guild.channels.cache.get(r.channelId);
        if (channel && channel.isTextBased()) {
          try {
            await channel.send(`\`\`\`\n${line}\n\`\`\``);
          } catch (err) {
            console.error(`winlog forward failed ${key}:`, err?.message || err);
          }
        }
      }
    }
  });
}

