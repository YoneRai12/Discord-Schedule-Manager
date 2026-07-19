function uniqueInvitees(invitees, maxInvitees) {
  const result = [];
  const seen = new Set();
  for (const invitee of invitees || []) {
    const userId = String(invitee?.userId ?? "");
    if (!userId || seen.has(userId)) continue;
    seen.add(userId);
    result.push({ userId, displayName: String(invitee.displayName ?? "Discordユーザー") });
    if (result.length > maxInvitees) throw new Error(`個別DMは1会議につき${maxInvitees}人までです`);
  }
  return result;
}
/**
 * Resolves a meeting's participant snapshot without Discord or database access.
 * Existing meetings keep the returned copy even if a template later changes.
 */
export function resolveParticipantSnapshot({
  explicitInvitees = [],
  explicitParticipantsFound = false,
  referencedTemplate = null,
  defaultTemplate = null,
  disableInvites = false,
  maxInvitees = 50,
} = {}) {
  if (disableInvites) return { invitees: [], source: "disabled", templateName: null };

  if (referencedTemplate) {
    const invitees = uniqueInvitees([
      ...(referencedTemplate.members || []),
      ...explicitInvitees,
    ], maxInvitees);
    return { invitees, source: "named_template", templateName: referencedTemplate.name };
  }

  if (explicitParticipantsFound || explicitInvitees.length) {
    return { invitees: uniqueInvitees(explicitInvitees, maxInvitees), source: "explicit", templateName: null };
  }

  if (defaultTemplate) {
    return {
      invitees: uniqueInvitees(defaultTemplate.members || [], maxInvitees),
      source: "default_template",
      templateName: defaultTemplate.name,
    };
  }

  return { invitees: [], source: "none", templateName: null };
}
