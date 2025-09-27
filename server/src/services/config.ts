import { prisma } from '../prisma';

export const getConfigValue = async (key: string): Promise<string | null> => {
  const record = await prisma.config.findUnique({ where: { key } });
  return record?.value ?? null;
};

export const setConfigValue = async (key: string, value: string): Promise<void> => {
  await prisma.config.upsert({
    where: { key },
    update: { value },
    create: { key, value }
  });
};

export const deleteConfigValue = async (key: string): Promise<void> => {
  await prisma.config.delete({ where: { key } }).catch(() => undefined);
};
