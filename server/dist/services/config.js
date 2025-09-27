"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.deleteConfigValue = exports.setConfigValue = exports.getConfigValue = void 0;
const prisma_1 = require("../prisma");
const getConfigValue = async (key) => {
    const record = await prisma_1.prisma.config.findUnique({ where: { key } });
    return record?.value ?? null;
};
exports.getConfigValue = getConfigValue;
const setConfigValue = async (key, value) => {
    await prisma_1.prisma.config.upsert({
        where: { key },
        update: { value },
        create: { key, value }
    });
};
exports.setConfigValue = setConfigValue;
const deleteConfigValue = async (key) => {
    await prisma_1.prisma.config.delete({ where: { key } }).catch(() => undefined);
};
exports.deleteConfigValue = deleteConfigValue;
