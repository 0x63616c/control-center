CREATE TABLE jar_invite_version (
  invite_version_id TEXT PRIMARY KEY,
  jar_id TEXT NOT NULL REFERENCES jars(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL
);

INSERT INTO jar_invite_version (invite_version_id,jar_id,created_at)
SELECT invite_version_id,id,created_at FROM jars;

CREATE INDEX jar_invite_version_jar
  ON jar_invite_version(jar_id,created_at,invite_version_id);

CREATE FUNCTION record_jar_invite_version() RETURNS trigger AS $$
BEGIN
  INSERT INTO jar_invite_version (invite_version_id,jar_id,created_at)
  VALUES (
    NEW.invite_version_id,
    NEW.id,
    (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT
  )
  ON CONFLICT (invite_version_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER record_jar_invite_version
AFTER INSERT OR UPDATE OF invite_version_id ON jars
FOR EACH ROW EXECUTE FUNCTION record_jar_invite_version();
