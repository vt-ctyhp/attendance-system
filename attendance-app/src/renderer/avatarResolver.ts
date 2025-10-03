export type HeroAvatarStatus =
  | 'Working'
  | 'OnBreak'
  | 'OnLunch'
  | 'Overtime'
  | 'PresenceDue'
  | 'PresenceMissed'
  | 'ClockedOut';

const HERO_AVATAR_BASE_PATH = '../assets/avatars/default';

const HERO_AVATAR_FILENAMES: Record<HeroAvatarStatus, string> = {
  Working: 'working.svg',
  OnBreak: 'break.svg',
  OnLunch: 'lunch.svg',
  Overtime: 'overtime.svg',
  PresenceDue: 'presence-due.svg',
  PresenceMissed: 'presence-missed.svg',
  ClockedOut: 'clocked-out.svg'
};

const FALLBACK_STATUS: HeroAvatarStatus = 'Working';

export type AvatarAssetResolution = {
  primary: string;
  fallback: string;
};

export const resolveHeroAvatarFilenames = (status: HeroAvatarStatus): AvatarAssetResolution => {
  const fallback = HERO_AVATAR_FILENAMES[FALLBACK_STATUS];
  const primary = HERO_AVATAR_FILENAMES[status] ?? fallback;
  return { primary, fallback };
};

export const resolveHeroAvatarPaths = (status: HeroAvatarStatus): AvatarAssetResolution => {
  const { primary, fallback } = resolveHeroAvatarFilenames(status);
  return {
    primary: `${HERO_AVATAR_BASE_PATH}/${primary}`,
    fallback: `${HERO_AVATAR_BASE_PATH}/${fallback}`
  };
};

export const __internal = {
  HERO_AVATAR_FILENAMES,
  HERO_AVATAR_BASE_PATH,
  FALLBACK_STATUS
};
