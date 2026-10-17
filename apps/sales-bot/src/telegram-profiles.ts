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
    if (error instanceof Error && /no such table:\s*telegram_profiles/i.test(error.message))
      return;
    throw error;
  }
}

export async function loadTelegramProfile(
  db: D1Database,
  telegramId: string,
): Promise<VerifiedTelegramUser> {
  try {
    const row = await db
      .prepare(
        "SELECT username,first_name,last_name FROM telegram_profiles WHERE telegram_id=?",
      )
      .bind(telegramId)
      .first<{ username: string | null; first_name: string | null; last_name: string | null }>();
    return {
      telegramId,
      username: row?.username || null,
      firstName: row?.first_name || null,
      lastName: row?.last_name || null,
    };
  } catch (error) {
    if (error instanceof Error && /no such table:\s*telegram_profiles/i.test(error.message))
      return { telegramId, username: null, firstName: null, lastName: null };
    throw error;
  }
}

export function profileDisplayName(profile: VerifiedTelegramUser): string {
  if (profile.username) return `@${profile.username}`;
  const name = [profile.firstName, profile.lastName].filter(Boolean).join(" ").trim();
  return name || profile.telegramId;
}
