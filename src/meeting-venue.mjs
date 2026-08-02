const DISCORD_HOSTS = new Set(["discord.com", "www.discord.com", "discordapp.com", "www.discordapp.com"]);

export const MEETING_VENUES = Object.freeze({
  undecided: "未定",
  discordVoice: "Discord VC",
  googleMeet: "Google Meet",
  external: "外部会議",
});

export function discordVoiceChannelUrl(guildId, channelId) {
  const guild = String(guildId ?? "").trim();
  const channel = String(channelId ?? "").trim();
  if (!/^\d{16,22}$/u.test(guild) || !/^\d{16,22}$/u.test(channel)) {
    throw new Error("Discord VCを特定できませんでした。先に使うVCへ参加してください");
  }
  return `https://discord.com/channels/${guild}/${channel}`;
}

export function meetingVenueFromUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return { type: "undecided", label: MEETING_VENUES.undecided };
  try {
    const parsed = new URL(raw);
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === "meet.google.com") {
      return { type: "google_meet", label: MEETING_VENUES.googleMeet };
    }
    if (DISCORD_HOSTS.has(hostname) && /^\/channels\/\d{16,22}\/\d{16,22}(?:\/)?$/u.test(parsed.pathname)) {
      return { type: "discord_voice", label: MEETING_VENUES.discordVoice };
    }
  } catch {
    // URLは保存前にprivacyモジュールで検証される。表示では安全側に外部会議扱いにする。
  }
  return { type: "external", label: MEETING_VENUES.external };
}

export function discordVoiceChannelFromUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (!DISCORD_HOSTS.has(parsed.hostname.toLowerCase())) return null;
    const match = parsed.pathname.match(/^\/channels\/(\d{16,22})\/(\d{16,22})(?:\/)?$/u);
    if (!match) return null;
    return { guildId: match[1], channelId: match[2] };
  } catch {
    return null;
  }
}

export function meetingUrlStatusText(value) {
  return String(value ?? "").trim()
    ? "登録済み（AIへは未送信）"
    : "未定（あとからボタン・自然文・/meeting url で追加できます）";
}
