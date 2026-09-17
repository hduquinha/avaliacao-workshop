// =====================================================================
// Avaliacao de satisfacao do Workshop VozUP
// ---------------------------------------------------------------------
// Grava as respostas em `inscricoes.avaliacoes_workshop`, uma tabela
// PROPRIA. Nao escreve em `inscricoes.inscricoes`: quem responde isto
// nao e um lead novo, e um participante que acabou de sair do workshop.
// Cadastrar avaliacao como inscricao inflaria a contagem de leads, criaria
// bloco/pasta fantasma no /vozup e mandaria gente para a Chegada de Leads
// (ver docs/cartilha-formularios-produtos.md, regras 1, 2 e 6, na raiz do
// monorepo). Quem quiser cruzar avaliacao com lead cruza pelo telefone.
//
// O navegador nao e fonte da verdade de nada: as tres perguntas tem lista
// fechada de respostas e ela e conferida aqui, no servidor.
// =====================================================================
const { Pool } = require('pg');

const SSL_QUERY_KEYS = ['sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'sslpassword'];
const SSL_DISABLE_VALUES = new Set(['0', 'false', 'disable', 'disabled', 'off', 'no']);
const SSL_STRICT_VALUES = new Set(['verify-ca', 'verify-full', 'strict']);
const DATABASE_CONNECTIVITY_ERROR_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
]);
const DEFAULT_ALLOWED_DEV_ORIGINS = new Set([
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
]);

const MAX_BODY_BYTES = 16 * 1024;

// As mesmas opcoes que aparecem no index.html. A duplicacao e proposital:
// a pagina e publica e o POST pode vir de qualquer lugar, entao a lista que
// vale e esta. Ao mudar uma pergunta na tela, mude aqui no mesmo commit.
const MOMENTOS = [
  'Storytelling',
  'Dinâmica: apresentar e “vender” o colega',
  'Dinâmica: “Quem sou eu?”',
  'Visualização de futuro',
  'O conjunto da experiência',
];
const INTERESSES = [
  'Quero entender os próximos passos',
  'Tenho interesse, mas preciso avaliar',
  'Gostei da experiência, mas não é prioridade agora',
  'Não tenho interesse em continuar neste momento',
];

let pool;
let schemaReadyPromise;

function getDatabaseUrl() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL nao configurada nas variaveis de ambiente.');
  }
  return databaseUrl;
}

// O `pg` recusa alguns parametros de SSL vindos na querystring; a conexao
// e limpa aqui e o modo volta pelo objeto `ssl` logo abaixo.
function sanitizeConnectionString(connectionString) {
  try {
    const url = new URL(connectionString);
    for (const key of SSL_QUERY_KEYS) url.searchParams.delete(key);
    return url.toString();
  } catch {
    return connectionString;
  }
}

function getSslModeFromDatabaseUrl() {
  try {
    return new URL(getDatabaseUrl()).searchParams.get('sslmode') || '';
  } catch {
    return '';
  }
}

function getSslConfig() {
  const sslMode = String(process.env.PG_SSL || process.env.PGSSLMODE || getSslModeFromDatabaseUrl())
    .trim()
    .toLowerCase();

  if (SSL_DISABLE_VALUES.has(sslMode)) return false;
  return { rejectUnauthorized: SSL_STRICT_VALUES.has(sslMode) };
}

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: sanitizeConnectionString(getDatabaseUrl()),
      ssl: getSslConfig(),
      max: 4,
      connectionTimeoutMillis: 8000,
    });

    pool.on('error', (err) => {
      console.error('Erro na conexao com Postgres:', err);
    });
  }

  return pool;
}

async function ensureSchema() {
  if (!schemaReadyPromise) {
    schemaReadyPromise = (async () => {
      const client = await getPool().connect();

      try {
        await client.query(`
          CREATE SCHEMA IF NOT EXISTS inscricoes;
          CREATE TABLE IF NOT EXISTS inscricoes.avaliacoes_workshop (
            id SERIAL PRIMARY KEY,
            payload JSONB NOT NULL,
            criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
        `);
      } finally {
        client.release();
      }
    })().catch((err) => {
      schemaReadyPromise = undefined;
      throw err;
    });
  }

  return schemaReadyPromise;
}

function appendVaryHeader(res, value) {
  const current = res.getHeader('Vary');
  const values = new Set(
    String(current || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  );

  values.add(value);
  res.setHeader('Vary', Array.from(values).join(', '));
}

function normalizeOrigin(origin) {
  try {
    return new URL(origin).origin;
  } catch {
    return '';
  }
}

function getConfiguredAllowedOrigins() {
  return new Set(
    String(process.env.ALLOWED_ORIGINS || '')
      .split(',')
      .map((origin) => normalizeOrigin(origin))
      .filter(Boolean)
  );
}

function getRequestHosts(req) {
  return [req.headers.host, req.headers['x-forwarded-host']]
    .flatMap((value) => String(value || '').split(','))
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

function getAllowedOrigin(req) {
  const origin = normalizeOrigin(req.headers.origin);
  if (!origin) return '';

  const configuredOrigins = getConfiguredAllowedOrigins();
  if (configuredOrigins.has(origin) || DEFAULT_ALLOWED_DEV_ORIGINS.has(origin)) {
    return origin;
  }

  const originHost = new URL(origin).host.toLowerCase();
  return new Set(getRequestHosts(req)).has(originHost) ? origin : '';
}

function setCommonHeaders(res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
}

function applyCors(req, res) {
  appendVaryHeader(res, 'Origin');
  appendVaryHeader(res, 'Access-Control-Request-Headers');

  const allowedOrigin = getAllowedOrigin(req);
  if (!allowedOrigin) return false;

  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');

  return true;
}

function normalizeBody(body) {
  if (!body) return {};

  if (Buffer.isBuffer(body)) return normalizeBody(body.toString('utf8'));

  if (typeof body === 'string') {
    try {
      return JSON.parse(body);
    } catch {
      return {};
    }
  }

  return typeof body === 'object' ? body : {};
}

function getPayloadSize(body) {
  if (!body) return 0;
  if (Buffer.isBuffer(body)) return body.length;
  if (typeof body === 'string') return Buffer.byteLength(body, 'utf8');

  try {
    return Buffer.byteLength(JSON.stringify(body), 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function safeString(value, maxLength = 160) {
  return String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function normalizePhoneDigits(phone) {
  const digits = String(phone || '').replace(/\D+/g, '');
  if (!digits) return '';
  return digits.length > 11 ? digits.slice(-11) : digits;
}

// Nota de 0 a 10. `0` e uma resposta valida e a mais informativa das ruins,
// entao a checagem nunca pode ser por "valor vazio/falsy".
function parseNota(value) {
  const nota = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isInteger(nota) && nota >= 0 && nota <= 10 ? nota : null;
}

/**
 * Monta o registro que vai para o banco ou diz o que esta faltando.
 * Devolve { erro } ou { registro }.
 */
function buildRecord(body) {
  const nome = safeString(body.nome, 140);
  if (nome.length < 2) return { erro: 'Informe seu nome.' };

  const telefoneDigits = normalizePhoneDigits(body.telefone);
  if (telefoneDigits.length < 10 || telefoneDigits.length > 11) {
    return { erro: 'Telefone invalido.' };
  }

  const nota = parseNota(body.nota_contribuicao);
  if (nota === null) return { erro: 'Escolha uma nota de 0 a 10.' };

  const momento = safeString(body.momento_marcante, 120);
  if (!MOMENTOS.includes(momento)) return { erro: 'Escolha um momento do workshop.' };

  const interesse = safeString(body.interesse_continuar, 120);
  if (!INTERESSES.includes(interesse)) return { erro: 'Escolha seu nivel de interesse.' };

  return {
    registro: {
      nome,
      telefone: safeString(body.telefone, 40),
      telefone_digits: telefoneDigits,
      nota_contribuicao: nota,
      momento_marcante: momento,
      interesse_continuar: interesse,
      // Qual workshop esta sendo avaliado. Vem da tela (WORKSHOP_CONFIG ou
      // ?data= na URL) e e so rotulo: nao entra em nenhuma regra de produto.
      workshop_rotulo: safeString(body.workshop_rotulo, 80) || 'Workshop VozUP',
      workshop_data: safeString(body.workshop_data, 20),
      origem: 'Avaliacao Workshop',
      unidade_negocio: 'Voz UP',
      clientId: safeString(body.clientId, 128),
      page: safeString(body.page, 300),
      respondido_em: new Date().toISOString(),
      data_preenchimento: new Date().toLocaleString('pt-BR', {
        timeZone: 'America/Sao_Paulo',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }),
    },
  };
}

// Uma pessoa, uma avaliacao por workshop: a media de nota nao pode ser
// torta porque alguem deu F5 ou respondeu duas vezes no mesmo celular.
// O clientId cobre o reenvio da mesma aba; o telefone cobre o resto.
async function findExisting(pg, registro) {
  const porCliente = registro.clientId
    ? await pg.query(
        `SELECT id FROM inscricoes.avaliacoes_workshop
          WHERE payload->>'clientId' = $1
          LIMIT 1`,
        [registro.clientId]
      )
    : { rowCount: 0, rows: [] };

  if (porCliente.rowCount) return porCliente.rows[0].id;

  const porTelefone = await pg.query(
    `SELECT id FROM inscricoes.avaliacoes_workshop
      WHERE payload->>'telefone_digits' = $1
        AND coalesce(payload->>'workshop_rotulo', '') = $2
      LIMIT 1`,
    [registro.telefone_digits, registro.workshop_rotulo]
  );

  return porTelefone.rowCount ? porTelefone.rows[0].id : 0;
}

function isDatabaseConfigurationError(err) {
  if (!err) return false;
  if (DATABASE_CONNECTIVITY_ERROR_CODES.has(err.code)) return true;
  return String(err.message || '').includes('DATABASE_URL');
}

async function handler(req, res) {
  setCommonHeaders(res);

  const hasOriginHeader = typeof req.headers.origin === 'string' && req.headers.origin.length > 0;
  const corsAllowed = applyCors(req, res);

  if (hasOriginHeader && !corsAllowed) {
    res.status(403).json({ ok: false, error: 'Origem nao permitida.' });
    return;
  }

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ ok: false, error: 'Method Not Allowed' });
    return;
  }

  if (getPayloadSize(req.body) > MAX_BODY_BYTES) {
    res.status(413).json({ ok: false, error: 'Payload muito grande.' });
    return;
  }

  const { erro, registro } = buildRecord(normalizeBody(req.body));
  if (erro) {
    res.status(422).json({ ok: false, error: erro });
    return;
  }

  try {
    await ensureSchema();
    const pg = getPool();

    const existenteId = await findExisting(pg, registro);
    if (existenteId) {
      res.status(200).json({ ok: true, deduped: true, avaliacaoId: existenteId });
      return;
    }

    const inserido = await pg.query(
      'INSERT INTO inscricoes.avaliacoes_workshop (payload) VALUES ($1) RETURNING id',
      [registro]
    );

    res.status(200).json({ ok: true, avaliacaoId: inserido.rows[0].id });
  } catch (err) {
    console.error('Erro ao salvar avaliacao do workshop:', err);

    if (isDatabaseConfigurationError(err)) {
      res.status(503).json({
        ok: false,
        error: 'Banco de dados indisponivel. Verifique a DATABASE_URL na Vercel.',
      });
      return;
    }

    res.status(500).json({ ok: false, error: 'Nao foi possivel salvar sua avaliacao.' });
  }
}

module.exports = handler;
module.exports.default = handler;
module.exports.MOMENTOS = MOMENTOS;
module.exports.INTERESSES = INTERESSES;
