"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.meRouter = void 0;
const express_1 = require("express");
const auth_1 = require("../auth");
exports.meRouter = (0, express_1.Router)();
exports.meRouter.get('/', auth_1.authenticate, (req, res) => {
    const user = req.user;
    return res.json({
        user: {
            id: user.id,
            email: user.email,
            name: user.name,
            role: user.role,
            createdAt: user.createdAt
        }
    });
});
