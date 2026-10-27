import pg from 'pg';

const { Pool } = pg;
let pool;

export function getPool() {
  if (!process.env.DATABASE_URL) {
    throw new Error('La base de données n’est pas configurée pour ce déploiement.');
  }
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 8,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000
    });
  }
  return pool;
}
