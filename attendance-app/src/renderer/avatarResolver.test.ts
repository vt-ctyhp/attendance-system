import { describe, expect, it } from 'vitest';
import {
  resolveHeroAvatarFilenames,
  resolveHeroAvatarPaths,
  type HeroAvatarStatus
} from './avatarResolver';

describe('avatarResolver', () => {
  const cases: Array<{ status: HeroAvatarStatus; expectedFilename: string }> = [
    { status: 'Working', expectedFilename: 'working.svg' },
    { status: 'OnBreak', expectedFilename: 'break.svg' },
    { status: 'OnLunch', expectedFilename: 'lunch.svg' },
    { status: 'Overtime', expectedFilename: 'overtime.svg' },
    { status: 'PresenceDue', expectedFilename: 'presence-due.svg' },
    { status: 'PresenceMissed', expectedFilename: 'presence-missed.svg' },
    { status: 'ClockedOut', expectedFilename: 'clocked-out.svg' }
  ];

  it('resolves primary filenames for each status and defaults fallback to working.svg', () => {
    for (const { status, expectedFilename } of cases) {
      const { primary, fallback } = resolveHeroAvatarFilenames(status);
      expect(primary).toBe(expectedFilename);
      expect(fallback).toBe('working.svg');
    }
  });

  it('produces asset paths under the default avatar directory', () => {
    for (const { status, expectedFilename } of cases) {
      const { primary, fallback } = resolveHeroAvatarPaths(status);
      expect(primary).toContain(expectedFilename);
      expect(primary).toMatch(/\.svg$/);
      expect(fallback).toContain('working.svg');
    }
  });
});
