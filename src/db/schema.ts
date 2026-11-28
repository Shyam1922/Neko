// The schema, as an append-only list of migrations. Never edit a shipped entry: add a new one.
// Statements in one entry are separated by ";" at the end of a line.
//
// Ids are text (UUIDs in practice): the HTTP layer validates their shape, and a malformed id then simply
// matches no row instead of raising a cast error.
// Every row that belongs to a person carries user_id, and every store query filters on it.

export const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id          text PRIMARY KEY,
    created_at  timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE conversations (
    id          text PRIMARY KEY,
    user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title       text NOT NULL,
    started_at  timestamptz NOT NULL,
    last_at     timestamptz NOT NULL,
    claims      jsonb,                         -- extracted from the answers on demand, once
    rejected    jsonb NOT NULL DEFAULT '[]'    -- past conversations the user said were the wrong ones
  );
  CREATE INDEX conversations_user_last ON conversations (user_id, last_at DESC);

  CREATE TABLE messages (
    id              text PRIMARY KEY,
    seq             bigint GENERATED ALWAYS AS IDENTITY,  -- insertion order; timestamps can tie
    conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id         text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role            text NOT NULL CHECK (role IN ('user', 'assistant')),
    text            text NOT NULL,
    at              timestamptz NOT NULL,      -- set by the server, never by the client
    tz              text NOT NULL,             -- the user's timezone when they sent it
    searches        jsonb NOT NULL DEFAULT '[]',
    recall          jsonb,
    ms              integer
  );
  CREATE INDEX messages_conversation_seq ON messages (conversation_id, seq);
  CREATE INDEX messages_user ON messages (user_id);

  CREATE TABLE profile_facts (
    id              text PRIMARY KEY,
    seq             bigint GENERATED ALWAYS AS IDENTITY,
    user_id         text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key             text NOT NULL,
    value           text NOT NULL,
    quote           text NOT NULL,             -- the user's exact words that stated it
    -- Where it was said. Deleting that chat keeps the fact (it is still true about the user)
    -- but drops the link to a message that no longer exists.
    conversation_id text REFERENCES conversations(id) ON DELETE SET NULL,
    message_id      text REFERENCES messages(id) ON DELETE SET NULL,
    stated_at       timestamptz NOT NULL,
    updated_at      timestamptz NOT NULL,
    UNIQUE (user_id, key)                      -- one fact per key: a newer statement replaces the older one
  );
  `,
  // 2: the rate limits count recent user messages, per user and across everyone.
  `
  CREATE INDEX messages_user_turns ON messages (user_id, at) WHERE role = 'user';
  CREATE INDEX messages_turns ON messages (at) WHERE role = 'user';
  `,
  // 3: embeddings for finding conversations by meaning (pgvector). A table of its own, so the vectors can be
  // rebuilt with another model without touching messages. No approximate (HNSW) index: every search is
  // filtered to one user's few hundred messages, where an exact scan is both fast and exact.
  `
  CREATE EXTENSION IF NOT EXISTS vector;
  CREATE TABLE message_embeddings (
    message_id      text PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id         text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    model           text NOT NULL,
    embedding       vector(768) NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX message_embeddings_user ON message_embeddings (user_id);
  `,
  // 4: "Watch this" (scheduled re-checks of an answer's facts), optional email, and the memory switch.
  // A user's email is stored only once they confirm it from a link; until then it lives only on the token.
  `
  ALTER TABLE users ADD COLUMN memory_on boolean NOT NULL DEFAULT true;
  ALTER TABLE users ADD COLUMN email text;
  ALTER TABLE users ADD COLUMN email_notify boolean NOT NULL DEFAULT false;
  ALTER TABLE users ADD COLUMN unsubscribe_token text;
  CREATE UNIQUE INDEX users_email ON users (lower(email)) WHERE email IS NOT NULL;

  CREATE TABLE watches (
    id              text PRIMARY KEY,
    user_id         text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    conversation_id text REFERENCES conversations(id) ON DELETE SET NULL,
    message_id      text REFERENCES messages(id) ON DELETE SET NULL,
    title           text NOT NULL,
    claims          jsonb NOT NULL,            -- the baseline: Claim[], verified quotes from Neko's own answer
    status          text NOT NULL CHECK (status IN ('active', 'paused')),
    every_days      integer NOT NULL DEFAULT 7,
    created_at      timestamptz NOT NULL,
    next_check_at   timestamptz NOT NULL,
    last_checked_at timestamptz,
    last_outcome    text,                      -- changed | unchanged | couldnt_verify | error
    changed_at      timestamptz,               -- the last real Changed verdict
    unseen_change   boolean NOT NULL DEFAULT false,
    UNIQUE (user_id, message_id)
  );
  CREATE INDEX watches_due ON watches (next_check_at) WHERE status = 'active';
  CREATE INDEX watches_user ON watches (user_id);

  CREATE TABLE watch_checks (
    id         text PRIMARY KEY,
    watch_id   text NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
    user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    checked_at timestamptz NOT NULL,
    outcome    text NOT NULL,
    items      jsonb NOT NULL DEFAULT '[]',    -- DiffItem[]: verdicts computed by code
    searches   jsonb NOT NULL DEFAULT '[]',
    error      text
  );
  CREATE INDEX watch_checks_watch ON watch_checks (watch_id, checked_at DESC);
  CREATE INDEX watch_checks_at ON watch_checks (checked_at);

  CREATE TABLE email_tokens (
    token_hash text PRIMARY KEY,               -- sha256 of the token; the token itself is only ever in the email
    user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    email      text NOT NULL,
    created_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    used_at    timestamptz
  );
  CREATE INDEX email_tokens_user ON email_tokens (user_id);
  `,
];
