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
];
