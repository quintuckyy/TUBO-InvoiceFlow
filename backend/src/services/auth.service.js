import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { NotFoundError, UnauthorizedError } from '../lib/errors.js';

// Compared against when the email doesn't exist, so "unknown email" and "wrong password"
// take the same time and an attacker cannot discover which emails are registered.
const DUMMY_HASH = bcrypt.hashSync('timing-attack-protection', 12);

export async function login(email, password) {
  const { rows } = await pool.query(
    `SELECT u.id, u.email, u.full_name, u.password_hash, u.is_active, c.id AS company_id, c.name AS company_name
       FROM users u JOIN companies c ON c.id = u.company_id
      WHERE lower(u.email) = lower($1)`,
    [email],
  );
  const user = rows[0];
  const passwordOk = await bcrypt.compare(password, user?.password_hash ?? DUMMY_HASH);
  if (!user || !passwordOk || !user.is_active) throw new UnauthorizedError('Invalid email or password');

  const token = jwt.sign({ companyId: user.company_id }, config.jwt.secret, {
    subject: user.id,
    expiresIn: config.jwt.expiresIn,
    issuer: config.jwt.issuer,
    audience: config.jwt.audience,
    algorithm: 'HS256',
  });

  return { token, user: toUserDto(user) };
}

export async function getCurrentUser(userId) {
  const { rows } = await pool.query(
    `SELECT u.id, u.email, u.full_name, c.id AS company_id, c.name AS company_name
       FROM users u JOIN companies c ON c.id = u.company_id
      WHERE u.id = $1 AND u.is_active`,
    [userId],
  );
  if (!rows[0]) throw new NotFoundError('User not found');
  return toUserDto(rows[0]);
}

function toUserDto(row) {
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    company: { id: row.company_id, name: row.company_name },
  };
}
