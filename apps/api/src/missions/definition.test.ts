import { describe, expect, it } from 'vitest';
import { createCreditService, MemoryCreditStore } from '../credits';
import { createSurfaceService, MemorySurfaceStore } from '../surfaces';

const admin = {
  id: 'admin-1',
  email: 'admin@example.com',
  role: 'admin' as const,
  verifiedAt: '2026-10-08T09:00:00.000Z',
};

describe('admin mission definition', () => {
  it('stores the verification kind used by the review service and defaults ordinary missions to evidence', async () => {
    const store = new MemorySurfaceStore();
    const surfaces = createSurfaceService({
      store,
      credits: createCreditService({ store: new MemoryCreditStore() }),
      now: () => new Date('2026-10-08T09:00:00.000Z'),
    });

    await expect(surfaces.upsertMission(admin, 'referral', {
      title: 'دعوت از دوست',
      description: 'فقط پس از تأیید رابطه دعوت.',
      rewardSeconds: 900,
      status: 'active',
      verificationKind: 'referral',
    })).resolves.toMatchObject({ verificationKind: 'referral' });

    await expect(surfaces.upsertMission(admin, 'proof', {
      title: 'مدرک دستی',
      description: 'مدرک برای بررسی مدیر.',
      rewardSeconds: 600,
      status: 'active',
    })).resolves.toMatchObject({ verificationKind: 'evidence' });

    expect(store.missions.map((mission) => mission.verificationKind)).toEqual(['referral', 'evidence']);
  });
});
