// @vitest-environment node

import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('mobile shell layout guard', () => {
  it('clips accidental horizontal overflow, constrains the shell, and reserves mobile safe areas', () => {
    const globalCss = readFileSync(new URL('./global.css', import.meta.url), 'utf8');
    const neonCss = readFileSync(new URL('./neon.css', import.meta.url), 'utf8');
    const css = `${globalCss}\n${neonCss}`;

    expect(css).toMatch(/overflow-x:\s*clip/);
    expect(css).toMatch(/\.app-shell[\s\S]*max-width:\s*100%/);
    expect(css).not.toMatch(/min-width:\s*(?:[4-9]\d{2}|\d{4,})px/);
    expect(neonCss).toMatch(/safe-area-inset-top/);
    expect(neonCss).toMatch(/safe-area-inset-bottom/);
    expect(neonCss).toMatch(/safe-area-inset-left/);
    expect(neonCss).toMatch(/safe-area-inset-right/);
    expect(neonCss).toMatch(/\.bottom-nav[\s\S]*grid-template-columns:\s*repeat\(5,\s*minmax\(0,\s*1fr\)\)/);
  });

  it('keeps admin surface grids single-column on mobile and expands them only at desktop breakpoints', () => {
    const css = readFileSync(new URL('./surfaces.css', import.meta.url), 'utf8');

    expect(css).toMatch(/\.surface-grid--two,\s*\.surface-grid--three\s*{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    expect(css).toMatch(/@media\s*\(min-width:\s*44rem\)[\s\S]*?\.surface-grid--two[\s\S]*?grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
    expect(css).toMatch(/@media\s*\(min-width:\s*68rem\)[\s\S]*?\.surface-grid--three[\s\S]*?grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
  });

  it('contains long mixed-direction account and VPN values without forcing horizontal overflow', () => {
    const dashboardCss = readFileSync(new URL('./dashboard.css', import.meta.url), 'utf8');
    const surfacesCss = readFileSync(new URL('./surfaces.css', import.meta.url), 'utf8');
    const settingsCss = readFileSync(new URL('../pwa/settings.css', import.meta.url), 'utf8');
    const missionsCss = readFileSync(new URL('../app/missions.css', import.meta.url), 'utf8');
    const css = `${dashboardCss}\n${surfacesCss}\n${settingsCss}\n${missionsCss}`;

    expect(surfacesCss).toMatch(/\.text-input\s*{[\s\S]*?width:\s*100%[\s\S]*?min-width:\s*0/);
    expect(settingsCss).toMatch(/\.profile-card__email\s*{[\s\S]*?max-width:\s*100%[\s\S]*?overflow:\s*hidden[\s\S]*?direction:\s*ltr/);
    expect(dashboardCss).toMatch(/\.dashboard-hero__identity bdi\s*{[\s\S]*?max-width:\s*68%[\s\S]*?overflow:\s*hidden/);
    expect(css).not.toMatch(/width:\s*(?:[4-9]\d{2}|\d{4,})px/);
  });

  it('requires responsive premium cards instead of leaving the reference hierarchy unstyled', () => {
    const premiumCssUrl = new URL('./premium.css', import.meta.url);
    expect(existsSync(premiumCssUrl)).toBe(true);
    if (!existsSync(premiumCssUrl)) return;

    const premiumCss = readFileSync(premiumCssUrl, 'utf8');
    expect(premiumCss).toMatch(/\.premium-catalog\s*{[\s\S]*?width:\s*min\(100%,\s*var\(--content-mobile\)\)/);
    expect(premiumCss).toMatch(/\.premium-plan-card\s*{[\s\S]*?min-width:\s*0/);
    expect(premiumCss).toMatch(/\.premium-plan-card__purchase\s*{[\s\S]*?min-width:\s*0/);
    expect(premiumCss).toMatch(/overflow-wrap:\s*anywhere/);
  });
});

describe('accessibility motion and focus guards', () => {
  it('retains visible keyboard focus and suppresses decorative motion for reduced-motion users', () => {
    const globalCss = readFileSync(new URL('./global.css', import.meta.url), 'utf8');
    const neonCss = readFileSync(new URL('./neon.css', import.meta.url), 'utf8');
    const missionsCss = readFileSync(new URL('../app/missions.css', import.meta.url), 'utf8');

    expect(globalCss).toMatch(/:focus-visible\s*{[\s\S]*?box-shadow:\s*var\(--focus-ring\)/);
    expect(globalCss).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?animation-duration:\s*0\.001ms/);
    expect(neonCss).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.madar-logo__ring\s*{[\s\S]*?animation:\s*none/);
    expect(missionsCss).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.missions-hero__orbit\s*{[\s\S]*?transform:\s*none/);
  });
});
