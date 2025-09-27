"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getHealth = exports.healthRouter = void 0;
const express_1 = require("express");
const package_json_1 = require("../../package.json");
exports.healthRouter = (0, express_1.Router)();
const getHealth = (_req, res) => {
    res.json({ ok: true, version: package_json_1.version, time: new Date().toISOString() });
};
exports.getHealth = getHealth;
exports.healthRouter.get('/health', exports.getHealth);
