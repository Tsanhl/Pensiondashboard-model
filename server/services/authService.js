import { createHash, randomBytes, randomInt, scryptSync, timingSafeEqual } from "node:crypto";
import { isoNow } from "../utils/values.js";
import {
  appendAuditEvent,
  listKnownUsers,
  newId,
  readAuthUsers,
  readMfaChallenges,
  readPasswordResets,
  readSessions,
  writeAuthUsers,
  writeMfaChallenges,
  writePasswordResets,
  writeSessions
} from "../store/userDataStore.js";

const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 1000 * 60 * 60 * 8);
const MFA_TTL_MS = Number(process.env.MFA_TTL_MS || 1000 * 60 * 10);
const PASSWORD_RESET_TTL_MS = Number(process.env.PASSWORD_RESET_TTL_MS || 1000 * 60 * 30);
const LOCKOUT_MS = Number(process.env.AUTH_LOCKOUT_MS || 1000 * 60 * 15);
const MAX_FAILED_LOGINS = Number(process.env.AUTH_MAX_FAILED_LOGINS || 5);

function sha256(value = "") {
  return createHash("sha256").update(String(value)).digest("hex");
}

function token() {
  return randomBytes(32).toString("base64url");
}

function normaliseEmail(email = "") {
  return String(email || "").trim().toLowerCase();
}

function passwordPolicyError(password = "") {
  const value = String(password || "");
  if (value.length < 10) return "Password must be at least 10 characters";
  if (!/[a-z]/i.test(value) || !/[0-9]/.test(value)) return "Password must contain letters and numbers";
  return "";
}

function passwordHash(password = "") {
  const salt = randomBytes(16).toString("base64url");
  const hash = scryptSync(String(password), salt, 64).toString("base64url");
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password = "", encoded = "") {
  const [, salt, expected] = String(encoded || "").split("$");
  if (!salt || !expected) return false;
  const actual = scryptSync(String(password), salt, 64).toString("base64url");
  return safeEqual(actual, expected);
}

function authStore() {
  const raw = readAuthUsers();
  return {
    users: raw.users && typeof raw.users === "object" ? raw.users : {},
    emailToUserId: raw.emailToUserId && typeof raw.emailToUserId === "object" ? raw.emailToUserId : {}
  };
}

function writeAuthStore(store) {
  return writeAuthUsers({
    users: store.users || {},
    emailToUserId: store.emailToUserId || {}
  });
}

function expiresAt(ms) {
  return new Date(Date.now() + ms).toISOString();
}

function notExpired(value) {
  return !value || Date.parse(value) > Date.now();
}

function safeEqual(a = "", b = "") {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

export function createSession(userId, { email = "", userAgent = "", ip = "", mfaVerified = false } = {}) {
  const rawToken = token();
  const sessions = readSessions(userId).filter((session) => session.status === "active" && notExpired(session.expiresAt));
  const session = {
    id: newId("session"),
    tokenHash: sha256(rawToken),
    email: String(email || "").trim(),
    userAgent: String(userAgent || "").slice(0, 240),
    ip: String(ip || "").slice(0, 80),
    status: "active",
    mfaVerified,
    createdAt: isoNow(),
    updatedAt: isoNow(),
    expiresAt: expiresAt(SESSION_TTL_MS)
  };
  sessions.unshift(session);
  writeSessions(userId, sessions.slice(0, 25));
  appendAuditEvent(userId, { type: "session_created", sessionId: session.id, mfaVerified });
  return { session: publicSession(session), sessionToken: rawToken };
}

export function createAuthUser(userId, { email = "", password = "", displayName = "", require2fa = true } = {}) {
  const cleanEmail = normaliseEmail(email);
  if (!cleanEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cleanEmail)) {
    const error = new Error("A valid email address is required");
    error.status = 400;
    throw error;
  }
  const passwordError = passwordPolicyError(password);
  if (passwordError) {
    const error = new Error(passwordError);
    error.status = 400;
    throw error;
  }
  const store = authStore();
  const safeUserId = userId || cleanEmail.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
  const existingUserId = store.emailToUserId[cleanEmail];
  if (existingUserId || store.users[safeUserId]) {
    const error = new Error("Email is already registered");
    error.status = 409;
    throw error;
  }
  const recoveryCodes = Array.from({ length: 8 }, () => `${randomInt(1000, 10000)}-${randomInt(1000, 10000)}-${randomInt(1000, 10000)}`);
  const now = isoNow();
  const current = {};
  store.users[safeUserId] = {
    ...current,
    userId: safeUserId,
    email: cleanEmail,
    displayName: String(displayName || current.displayName || "").trim(),
    passwordHash: passwordHash(password),
    require2fa: require2fa !== false,
    failedLoginAttempts: 0,
    lockedUntil: null,
    recoveryCodes: recoveryCodes.map((code) => ({ codeHash: sha256(code), usedAt: null })),
    createdAt: current.createdAt || now,
    updatedAt: now
  };
  store.emailToUserId[cleanEmail] = safeUserId;
  writeAuthStore(store);
  appendAuditEvent(safeUserId, { type: current.createdAt ? "auth_user_updated" : "auth_user_created", email: cleanEmail });
  return {
    userId: safeUserId,
    email: cleanEmail,
    require2fa: store.users[safeUserId].require2fa,
    recoveryCodes
  };
}

export function getAuthUserByEmail(email = "") {
  const store = authStore();
  const userId = store.emailToUserId[normaliseEmail(email)];
  return userId ? store.users[userId] || null : null;
}

export function getAuthStatus(userId) {
  const user = authStore().users[userId];
  return {
    userId,
    registered: Boolean(user?.passwordHash),
    email: user?.email || "",
    require2fa: user?.require2fa !== false,
    locked: Boolean(user?.lockedUntil && notExpired(user.lockedUntil)),
    lockedUntil: user?.lockedUntil || null,
    failedLoginAttempts: user?.failedLoginAttempts || 0,
    activeSessions: listSessions(userId).length
  };
}

export function authenticateWithPassword({ email = "", password = "", userAgent = "", ip = "" } = {}) {
  const cleanEmail = normaliseEmail(email);
  const store = authStore();
  const userId = store.emailToUserId[cleanEmail];
  const user = userId ? store.users[userId] : null;
  const genericError = () => {
    const error = new Error("Email or password is incorrect");
    error.status = 401;
    return error;
  };

  if (!user?.passwordHash) throw genericError();
  if (user.lockedUntil && notExpired(user.lockedUntil)) {
    const error = new Error("Account is temporarily locked after too many failed attempts");
    error.status = 423;
    throw error;
  }
  if (!verifyPassword(password, user.passwordHash)) {
    user.failedLoginAttempts = Number(user.failedLoginAttempts || 0) + 1;
    if (user.failedLoginAttempts >= MAX_FAILED_LOGINS) user.lockedUntil = expiresAt(LOCKOUT_MS);
    user.updatedAt = isoNow();
    writeAuthStore(store);
    appendAuditEvent(user.userId, { type: "auth_login_failed", failedLoginAttempts: user.failedLoginAttempts, lockedUntil: user.lockedUntil || null });
    throw genericError();
  }

  user.failedLoginAttempts = 0;
  user.lockedUntil = null;
  user.updatedAt = isoNow();
  writeAuthStore(store);
  const auth = createSession(user.userId, { email: user.email, userAgent, ip, mfaVerified: user.require2fa === false });
  appendAuditEvent(user.userId, { type: "auth_login_success", sessionId: auth.session.id });
  return { userId: user.userId, ...auth, requires2fa: user.require2fa !== false };
}

export function startPasswordReset({ email = "" } = {}) {
  const cleanEmail = normaliseEmail(email);
  const user = getAuthUserByEmail(cleanEmail);
  if (!user) return { accepted: true };
  const rawToken = token();
  const resets = readPasswordResets(user.userId).filter((item) => item.status === "pending" && notExpired(item.expiresAt));
  const reset = {
    id: newId("pwd_reset"),
    tokenHash: sha256(rawToken),
    email: cleanEmail,
    status: "pending",
    attempts: 0,
    createdAt: isoNow(),
    updatedAt: isoNow(),
    expiresAt: expiresAt(PASSWORD_RESET_TTL_MS)
  };
  resets.unshift(reset);
  writePasswordResets(user.userId, resets.slice(0, 10));
  appendAuditEvent(user.userId, { type: "password_reset_requested", resetId: reset.id });
  return {
    accepted: true,
    resetId: reset.id,
    expiresAt: reset.expiresAt,
    demoResetToken: process.env.NODE_ENV === "production" ? undefined : rawToken
  };
}

export function completePasswordReset({ email = "", resetToken = "", password = "" } = {}) {
  const user = getAuthUserByEmail(email);
  if (!user) {
    const error = new Error("Password reset token is invalid or expired");
    error.status = 400;
    throw error;
  }
  const passwordError = passwordPolicyError(password);
  if (passwordError) {
    const error = new Error(passwordError);
    error.status = 400;
    throw error;
  }
  const resets = readPasswordResets(user.userId);
  const reset = resets.find((item) => item.status === "pending" && notExpired(item.expiresAt) && safeEqual(item.tokenHash, sha256(resetToken)));
  if (!reset) {
    const error = new Error("Password reset token is invalid or expired");
    error.status = 400;
    throw error;
  }
  reset.status = "used";
  reset.updatedAt = isoNow();
  writePasswordResets(user.userId, resets);

  const store = authStore();
  const record = store.users[user.userId];
  record.passwordHash = passwordHash(password);
  record.failedLoginAttempts = 0;
  record.lockedUntil = null;
  record.updatedAt = isoNow();
  writeAuthStore(store);
  appendAuditEvent(user.userId, { type: "password_reset_completed", resetId: reset.id });
  return { reset: true, userId: user.userId };
}

export function verifyRecoveryCode(userId, { code = "", sessionToken = "" } = {}) {
  const store = authStore();
  const user = store.users[userId];
  const entry = user?.recoveryCodes?.find((item) => !item.usedAt && safeEqual(item.codeHash, sha256(code)));
  if (!entry) {
    const error = new Error("Invalid recovery code");
    error.status = 400;
    throw error;
  }
  entry.usedAt = isoNow();
  user.updatedAt = isoNow();
  writeAuthStore(store);

  const hash = sha256(sessionToken || "");
  const sessions = readSessions(userId);
  const session = sessions.find((item) => item.status === "active" && notExpired(item.expiresAt) && safeEqual(item.tokenHash, hash));
  if (session) {
    session.mfaVerified = true;
    session.updatedAt = isoNow();
    writeSessions(userId, sessions);
  }
  appendAuditEvent(userId, { type: "mfa_recovery_code_used", sessionId: session?.id || null });
  return { verified: true, session: session ? publicSession(session) : null };
}

export function publicSession(session = {}) {
  const { tokenHash, ...safe } = session;
  return safe;
}

export function listSessions(userId) {
  return readSessions(userId).filter((session) => session.status === "active" && notExpired(session.expiresAt)).map(publicSession);
}

export function getSession(userId, rawToken = "") {
  const hash = sha256(rawToken || "");
  const session = readSessions(userId).find((item) => item.status === "active" && notExpired(item.expiresAt) && safeEqual(item.tokenHash, hash));
  return session ? publicSession(session) : null;
}

export function findSessionByToken(rawToken = "") {
  if (!rawToken) return null;
  for (const userId of listKnownUsers()) {
    const session = getSession(userId, rawToken);
    if (session) return { userId, session };
  }
  return null;
}

export function revokeSession(userId, rawToken = "") {
  const hash = sha256(rawToken || "");
  const sessions = readSessions(userId);
  let revoked = 0;
  for (const session of sessions) {
    if (session.status === "active" && safeEqual(session.tokenHash, hash)) {
      session.status = "revoked";
      session.updatedAt = isoNow();
      revoked += 1;
    }
  }
  writeSessions(userId, sessions);
  if (revoked) appendAuditEvent(userId, { type: "session_revoked", revoked });
  return { revoked };
}

export function revokeOtherSessions(userId, rawToken = "") {
  const keepHash = rawToken ? sha256(rawToken) : "";
  const sessions = readSessions(userId);
  let revoked = 0;
  for (const session of sessions) {
    if (session.status !== "active") continue;
    if (keepHash && safeEqual(session.tokenHash, keepHash)) continue;
    session.status = "revoked";
    session.updatedAt = isoNow();
    revoked += 1;
  }
  writeSessions(userId, sessions);
  appendAuditEvent(userId, { type: "security_sessions_revoked", revoked });
  return { revoked };
}

export function startMfaChallenge(userId, { channel = "app", purpose = "login" } = {}) {
  const code = String(randomInt(100000, 1000000));
  const challenge = {
    id: newId("mfa"),
    codeHash: sha256(code),
    channel,
    purpose,
    status: "pending",
    createdAt: isoNow(),
    updatedAt: isoNow(),
    expiresAt: expiresAt(MFA_TTL_MS),
    attempts: 0
  };
  const challenges = readMfaChallenges(userId).filter((item) => item.status === "pending" && notExpired(item.expiresAt));
  challenges.unshift(challenge);
  writeMfaChallenges(userId, challenges.slice(0, 10));
  appendAuditEvent(userId, { type: "mfa_challenge_created", challengeId: challenge.id, channel, purpose });
  return {
    challengeId: challenge.id,
    channel,
    expiresAt: challenge.expiresAt,
    demoCode: process.env.NODE_ENV === "production" ? undefined : code
  };
}

export function verifyMfaChallenge(userId, { challengeId = "", code = "", sessionToken = "" } = {}) {
  const challenges = readMfaChallenges(userId);
  const challenge = challenges.find((item) => item.id === challengeId);
  if (!challenge || challenge.status !== "pending" || !notExpired(challenge.expiresAt)) {
    const error = new Error("2FA challenge expired or not found");
    error.status = 400;
    throw error;
  }
  challenge.attempts += 1;
  if (!safeEqual(challenge.codeHash, sha256(code))) {
    challenge.updatedAt = isoNow();
    if (challenge.attempts >= 5) challenge.status = "locked";
    writeMfaChallenges(userId, challenges);
    const error = new Error("Invalid 2FA code");
    error.status = 400;
    throw error;
  }
  challenge.status = "verified";
  challenge.updatedAt = isoNow();
  writeMfaChallenges(userId, challenges);

  const hash = sha256(sessionToken || "");
  const sessions = readSessions(userId);
  const session = sessions.find((item) => item.status === "active" && notExpired(item.expiresAt) && safeEqual(item.tokenHash, hash));
  if (session) {
    session.mfaVerified = true;
    session.updatedAt = isoNow();
    writeSessions(userId, sessions);
  }
  appendAuditEvent(userId, { type: "mfa_challenge_verified", challengeId: challenge.id, sessionId: session?.id || null });
  return { verified: true, session: session ? publicSession(session) : null };
}
