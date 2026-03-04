import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import type { Request, Response, NextFunction } from "express";
import { config } from "./config.js";
import type { JwtPayload, TokenRole } from "./types.js";

export const passwordMatches = async (plain: string, hash: string) => {
  return bcrypt.compare(plain, hash);
};

export const hashPassword = async (plain: string) => {
  return bcrypt.hash(plain, 12);
};

export const issueToken = (payload: JwtPayload, ttlMinutes: number) => {
  return jwt.sign(payload, config.JWT_SECRET, {
    expiresIn: `${ttlMinutes}m`,
    audience: config.JWT_AUDIENCE,
    issuer: config.JWT_ISSUER
  });
};

export const verifyToken = (token: string): JwtPayload => {
  return jwt.verify(token, config.JWT_SECRET, {
    audience: config.JWT_AUDIENCE,
    issuer: config.JWT_ISSUER
  }) as JwtPayload;
};

const extractToken = (req: Request): string | null => {
  const header = req.headers.authorization ?? "";
  if (!header.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim();
};

export const requireAuth = (roles: TokenRole[]) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const token = extractToken(req);
    if (!token) {
      return res.status(401).json({ error: "missing_token" });
    }
    try {
      const payload = verifyToken(token);
      if (!roles.includes(payload.role)) {
        return res.status(403).json({ error: "insufficient_role" });
      }
      (req as Request & { auth: JwtPayload }).auth = payload;
      return next();
    } catch (err) {
      return res.status(401).json({ error: "invalid_token" });
    }
  };
};

export const requireAnyAuth = () => requireAuth(["agent", "controller", "technician"]);

export const getAuthPayload = (req: Request): JwtPayload | undefined => {
  return (req as Request & { auth?: JwtPayload }).auth;
};
