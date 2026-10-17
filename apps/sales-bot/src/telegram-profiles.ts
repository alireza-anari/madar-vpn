export interface VerifiedTelegramUser {
  telegramId: string;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
}

export async function upsertTelegramProfile(
  db: D1Database,
  profile: VerifiedTelegramUser,
  now: number,
): Promise<void> {
  try {
    await db
      .prepare(
        "INSERT INTO telegram_profiles(telegram_id,username,first_name,last_name,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(telegram_id) DO UPDATE SET username=excluded.username,first_name=excluded.first_name,last_name=excluded.last_name,updated_at=excluded.updated_at",
      )
      .bind(
        profile.telegramId,
        profile.username,
        profile.firstName,
        profile.lastName,
        now,
      )
      .run();
  } catch (error) {
    // Keep rolling deployments functional if Worker code reaches an old schema
    // before the additive profile migration has propagated.
    if (error instanceof Error && /no such table:\s*telegram_profiles/i.test(error.message))
      return;
    throw error;
  }
}

export function profileDisplayName(profile: VerifiedTelegramUser): string {
  if (profile.username) return `@${profile.username}`;
  const name = [profile.firstName, profile.lastName].filter(Boolean).join(" ").trim();
  return name || profile.telegramId;
}
