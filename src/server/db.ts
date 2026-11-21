import pg, { type PoolClient, type QueryResult, type QueryResultRow } from 'pg';

const { Pool, types } = pg;

// Return PostgreSQL DATE (OID 1082) as raw YYYY-MM-DD string (avoid JS timezone shifts)
types.setTypeParser(1082, (val: string) => val);
// Return PostgreSQL NUMERIC (OID 1700) as number for clean JSON responses (exact math uses Decimal.js)
types.setTypeParser(1700, (val: string) => Number(val));

export const TRANSACTION_POOLER_URL =
  process.env.DATABASE_URL?.trim() ||
  'postgresql://postgres.aensjimluvjihdgxqiqf:kyfXmkT9QyGNOpON@aws-0-eu-west-1.pooler.supabase.com:6543/postgres';

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: TRANSACTION_POOLER_URL,
      ssl: { rejectUnauthorized: false },
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });

    pool.on('error', (err) => {
      console.error('Unexpected PostgreSQL pool error:', err.message);
    });
  }
  return pool;
}

/**
 * Execute an unnamed SQL query safely via Supabase Transaction Pooler (port 6543).
 * Unnamed queries avoid named prepared-statement conflicts under Supavisor transaction pooling.
 */
export async function dbQuery<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<QueryResult<T>> {
  return getPool().query<T>(text, params);
}

/**
 * Run a series of queries inside an explicit BEGIN...COMMIT transaction on a single pooled connection.
 * Optionally sets `app.current_user_id` locally for PostgreSQL RLS awareness.
 */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
  actorId?: string,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    if (actorId) {
      await client.query("SELECT set_config('app.current_user_id', $1, true)", [actorId]);
    }
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
