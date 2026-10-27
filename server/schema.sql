-- VoiceDen accounts + persistent servers (MariaDB 10.6).
-- Idempotent: safe to re-run. Times are stored in UTC (the API sets time_zone).

CREATE TABLE IF NOT EXISTS users (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  username      VARCHAR(24)  NOT NULL,          -- login handle, [a-z0-9_.], lowercase
  display_name  VARCHAR(32)  NOT NULL,
  pass_hash     VARCHAR(255) NOT NULL,
  tint          TINYINT UNSIGNED NOT NULL DEFAULT 0,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen     DATETIME NULL,
  UNIQUE KEY uq_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- the cookie holds a random token; only its sha256 is stored
CREATE TABLE IF NOT EXISTS sessions (
  token_hash  BINARY(32) PRIMARY KEY,
  user_id     INT UNSIGNED NOT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at  DATETIME NOT NULL,
  ua          VARCHAR(200) NULL,
  KEY k_user (user_id),
  CONSTRAINT fk_sess_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- a "den" in the UI
CREATE TABLE IF NOT EXISTS servers (
  id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name         VARCHAR(48) NOT NULL,
  owner_id     INT UNSIGNED NOT NULL,
  invite_code  CHAR(10) NOT NULL,
  rev          INT UNSIGNED NOT NULL DEFAULT 1,   -- bumped on any structural change; clients refetch
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_invite (invite_code),
  CONSTRAINT fk_srv_owner FOREIGN KEY (owner_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS members (
  server_id  INT UNSIGNED NOT NULL,
  user_id    INT UNSIGNED NOT NULL,
  role       ENUM('owner','admin','member') NOT NULL DEFAULT 'member',
  joined_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (server_id, user_id),
  KEY k_user (user_id),
  CONSTRAINT fk_mem_srv  FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
  CONSTRAINT fk_mem_user FOREIGN KEY (user_id)   REFERENCES users(id)   ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS channels (
  id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  server_id    INT UNSIGNED NOT NULL,
  name         VARCHAR(48) NOT NULL,
  kind         ENUM('text','voice') NOT NULL,
  position     INT NOT NULL DEFAULT 0,
  last_msg_id  BIGINT UNSIGNED NOT NULL DEFAULT 0,  -- denormalised for unread dots
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY k_srv (server_id),
  CONSTRAINT fk_ch_srv FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- every insert/edit/delete takes the next rev, so one "rev > cursor" query
-- answers "what changed since I last looked" for all three
CREATE SEQUENCE IF NOT EXISTS msg_rev START WITH 1 INCREMENT BY 1 NOCACHE;

CREATE TABLE IF NOT EXISTS messages (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  channel_id  INT UNSIGNED NOT NULL,
  server_id   INT UNSIGNED NOT NULL,
  user_id     INT UNSIGNED NOT NULL,
  body        TEXT NOT NULL,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  edited_at   DATETIME(3) NULL,
  deleted     TINYINT(1) NOT NULL DEFAULT 0,
  rev         BIGINT UNSIGNED NOT NULL,
  KEY k_ch (channel_id, id),
  KEY k_rev (rev),
  KEY k_user_time (user_id, created_at),
  CONSTRAINT fk_msg_ch FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
  CONSTRAINT fk_msg_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS attachments (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  message_id  BIGINT UNSIGNED NOT NULL,
  name        VARCHAR(120) NOT NULL,
  mime        VARCHAR(100) NOT NULL,   -- sniffed server-side; non-media is application/octet-stream
  size        INT UNSIGNED NOT NULL,
  width       SMALLINT UNSIGNED NULL,
  height      SMALLINT UNSIGNED NULL,
  path        VARCHAR(80) NOT NULL,    -- relative to data/files, random, no extension
  KEY k_msg (message_id),
  CONSTRAINT fk_att_msg FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS channel_reads (
  user_id       INT UNSIGNED NOT NULL,
  channel_id    INT UNSIGNED NOT NULL,
  last_read_id  BIGINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, channel_id),
  CONSTRAINT fk_rd_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_rd_ch   FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- who is in which voice channel. seq is the join order: the later joiner of a
-- pair is the one that dials, so two peers never call each other at once.
CREATE SEQUENCE IF NOT EXISTS voice_seq START WITH 1 INCREMENT BY 1 NOCACHE;

CREATE TABLE IF NOT EXISTS voice_states (
  user_id     INT UNSIGNED PRIMARY KEY,           -- one voice connection per account
  seq         BIGINT UNSIGNED NOT NULL,
  channel_id  INT UNSIGNED NOT NULL,
  server_id   INT UNSIGNED NOT NULL,
  peer_id     VARCHAR(64) NOT NULL,
  muted       TINYINT(1) NOT NULL DEFAULT 0,
  deafened    TINYINT(1) NOT NULL DEFAULT 0,
  sharing     TINYINT(1) NOT NULL DEFAULT 0,
  updated_at  DATETIME NOT NULL,
  KEY k_srv (server_id),
  KEY k_ch (channel_id),
  CONSTRAINT fk_vs_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_vs_ch   FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS typing (
  channel_id  INT UNSIGNED NOT NULL,
  user_id     INT UNSIGNED NOT NULL,
  until_at    DATETIME(3) NOT NULL,
  PRIMARY KEY (channel_id, user_id),
  CONSTRAINT fk_ty_ch FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
  CONSTRAINT fk_ty_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- brute-force brakes for login / register
CREATE TABLE IF NOT EXISTS throttle (
  k   VARCHAR(80) NOT NULL,
  at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY k_key (k, at)
) ENGINE=InnoDB;
